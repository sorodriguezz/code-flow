import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { loadAdoConnectionsFromSettings, normalizeAdoOrg } from "../lib/adoConnections";
import { loadBitbucketConnections } from "../lib/bitbucketConnections";
import { loadGithubConnections } from "../lib/githubConnections";
import { loadGitlabConnections } from "../lib/gitlabConnections";
import { loadJiraConnections, normalizeJiraSite } from "../lib/jiraConnections";
import { loadLinearConnections } from "../lib/linearConnections";
import { loadMondayConnections } from "../lib/mondayConnections";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { HOSTING_PROVIDERS, type HostingProvider } from "../lib/vcsProviders";
import { isMainWindow } from "../lib/windowIdentity";
import {
  applyCredentialCheck, expiryOf, expiryWarningDays, statusOf,
  type CredentialCheck, type CredentialHealth,
} from "../lib/integrationCredentialStatus";
import { notify } from "./notificationStore";
import { usePreferencesStore } from "./preferencesStore";

const HEALTH_KEY = "integration_credential_health";
const ROSTER_SETTINGS = new Set([
  "ado_connections", "ado_default_org", "bitbucket_connections", "github_connections",
  "gitlab_connections", "jira_connections", "linear_connections", "monday_connections",
]);
const MINUTE_MS = 60_000;
const POLL_MS = 15 * MINUTE_MS;
const RETRY_MS = 5 * MINUTE_MS;

export interface IntegrationCredential {
  provider: HostingProvider;
  account: string;
  revision?: string;
}

export function integrationCredentialKey({ provider, account }: IntegrationCredential) {
  const identifier = provider === "azure" ? normalizeAdoOrg(account) : account;
  return `${provider}:${identifier.toLowerCase()}`;
}

export const useIntegrationCredentialStore = create<{
  entries: Record<string, CredentialHealth>;
  checking: Record<string, boolean>;
  now: number;
}>(() => ({ entries: {}, checking: {}, now: Date.now() }));

let roster = new Map<string, IntegrationCredential>();
let rosterChanged = true;
let syncing: Promise<void> | undefined;
let loaded = false;
let started = false;
const nextCheckAt = new Map<string, number>();
const inFlight = new Map<string, { revision: string; work: Promise<void> }>();
let pendingWrite: Promise<void> = Promise.resolve();

function revisionOf(credential: IntegrationCredential) {
  return credential.revision ?? "";
}

async function readRoster(): Promise<IntegrationCredential[]> {
  const [azure, bitbucket, github, gitlab, jira, linear, monday] = await Promise.all([
    loadAdoConnectionsFromSettings(), loadBitbucketConnections(), loadGithubConnections(),
    loadGitlabConnections(), loadJiraConnections(), loadLinearConnections(), loadMondayConnections(),
  ]);
  return [
    ...azure.map((c) => ({ provider: "azure" as const, account: c.org, revision: c.credentialRevision })),
    ...bitbucket.map((c) => ({ provider: "bitbucket" as const, account: c.workspace, revision: c.credentialRevision })),
    ...github.map((c) => ({ provider: "github" as const, account: c.host, revision: c.credentialRevision })),
    ...gitlab.map((c) => ({ provider: "gitlab" as const, account: c.host, revision: c.credentialRevision })),
    ...jira.map((c) => ({ provider: "jira" as const, account: normalizeJiraSite(c.site), revision: c.credentialRevision })),
    ...linear.map((c) => ({ provider: "linear" as const, account: c.key, revision: c.credentialRevision })),
    ...monday.map((c) => ({ provider: "monday" as const, account: c.slug, revision: c.credentialRevision })),
  ].filter((c) => c.account.trim() !== "");
}

function storedEntries(raw: string | null): Record<string, CredentialHealth> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Regenerate the monitoring cache if it can't be read.
  }
  return {};
}

function persist() {
  const data = JSON.stringify(useIntegrationCredentialStore.getState().entries);
  pendingWrite = pendingWrite.catch(() => {}).then(() => setSetting(HEALTH_KEY, data));
  return pendingWrite;
}

function syncRoster(): Promise<void> {
  syncing ??= (async () => {
    if (!loaded) {
      const entries = storedEntries(await getSetting(HEALTH_KEY));
      useIntegrationCredentialStore.setState({ entries });
      loaded = true;
    }

    while (rosterChanged) {
      rosterChanged = false;
      let credentials: IntegrationCredential[];
      try {
        credentials = await readRoster();
      } catch (error) {
        rosterChanged = true;
        throw error;
      }
      roster = new Map(credentials.map((credential) => [integrationCredentialKey(credential), credential]));
      const previous = useIntegrationCredentialStore.getState().entries;
      const entries = { ...previous };
      let changed = false;
      for (const [key, credential] of roster) {
        const revision = revisionOf(credential);
        if (entries[key]?.revision === revision) continue;
        entries[key] = { revision };
        nextCheckAt.delete(key);
        changed = true;
      }
      for (const key of Object.keys(entries)) {
        if (roster.has(key)) continue;
        delete entries[key];
        nextCheckAt.delete(key);
        changed = true;
      }
      if (changed) {
        useIntegrationCredentialStore.setState({ entries });
        void persist().catch(() => {});
      }
    }
  })().finally(() => { syncing = undefined; });
  return syncing;
}

function update(key: string, revision: string, change: (previous: CredentialHealth) => CredentialHealth): boolean {
  const { entries } = useIntegrationCredentialStore.getState();
  const previous = entries[key];
  if (!previous || previous.revision !== revision) return false;
  const next = change(previous);
  if (next === previous) return false;
  useIntegrationCredentialStore.setState({ entries: { ...entries, [key]: next }, now: Date.now() });
  return true;
}

export async function saveIntegrationExpiration(credential: IntegrationCredential, expiresAt?: number) {
  rosterChanged = true;
  await syncRoster();
  const key = integrationCredentialKey(credential);
  const revision = revisionOf(credential);
  if (useIntegrationCredentialStore.getState().entries[key]?.revision !== revision) {
    throw new Error("The integration credential changed");
  }
  update(key, revision, (health) => {
    if (health.manualExpiry === expiresAt) return health;
    const next = { ...health, manualExpiry: expiresAt };
    if (expiryOf(next) !== expiryOf(health)) delete next.warnedDays;
    return next;
  });
  await persist();
  publishNotices();
}

function markChecking(key: string, value: boolean) {
  useIntegrationCredentialStore.setState((state) => {
    const checking = { ...state.checking };
    if (value) checking[key] = true;
    else delete checking[key];
    return { checking };
  });
}

function probe(credential: IntegrationCredential): Promise<void> {
  const key = integrationCredentialKey(credential);
  const revision = revisionOf(credential);
  const existing = inFlight.get(key);
  if (existing?.revision === revision) return existing.work;
  if (existing) {
    return existing.work.catch(() => {}).then(() => {
      const current = roster.get(key);
      if (current && revisionOf(current) === revision) return probe(current);
    });
  }

  markChecking(key, true);
  const work = (async () => {
    const check = await invoke<CredentialCheck>("integration_check_credential", {
      provider: credential.provider, account: credential.account,
    }).catch((): CredentialCheck => ({ status: "unavailable", expiresAt: null, account: null }));
    await syncRoster();
    if (useIntegrationCredentialStore.getState().entries[key]?.revision !== revision) return;
    nextCheckAt.set(key, Date.now() + (check.status === "unavailable" ? RETRY_MS : POLL_MS));
    if (update(key, revision, (health) => applyCredentialCheck(health, check))) {
      void persist().catch(() => {});
    }
  })().finally(() => {
    inFlight.delete(key);
    markChecking(key, false);
  });
  inFlight.set(key, { revision, work });
  return work;
}

export async function recheckIntegrationCredential(credential: IntegrationCredential) {
  rosterChanged = true;
  await syncRoster();
  const current = roster.get(integrationCredentialKey(credential));
  if (current) await probe(current);
  publishNotices();
}

function publishNotices() {
  if (!started || usePreferencesStore.getState().mutedNotificationSources.includes("integrations")) return;
  const now = Date.now();
  let changed = false;

  for (const [key, credential] of roster) {
    if (inFlight.has(key) || !nextCheckAt.has(key)) continue;
    const health = useIntegrationCredentialStore.getState().entries[key];
    const provider = HOSTING_PROVIDERS.find((entry) => entry.id === credential.provider);
    if (!health || !provider) continue;
    const revision = revisionOf(credential);
    const params = { provider: provider.label, account: credential.account };
    const target = { integration: credential.provider };
    const days = expiryWarningDays(health, now);
    if (days !== undefined) {
      notify({
        source: "integrations", workspaceId: null, target, status: "info",
        titleKey: days === 1 ? "integrations.credential.warningOneDay" : "integrations.credential.warningDays",
        params: { ...params, days },
      });
      changed = update(key, revision, (entry) => ({ ...entry, warnedDays: days })) || changed;
      continue;
    }
    const status = statusOf(health, now);
    if (!health.lossReported && (status === "rejected" || status === "missing")) {
      notify({
        source: "integrations", workspaceId: null, target, status: "error",
        titleKey: status === "missing" ? "integrations.credential.warningMissing" : "integrations.credential.warningRejected",
        params,
      });
      changed = update(key, revision, (entry) => ({ ...entry, lossReported: true })) || changed;
    }
  }
  if (changed) void persist().catch(() => {});
}

async function monitor() {
  await syncRoster();
  const now = Date.now();
  useIntegrationCredentialStore.setState({ now });
  const due = [...roster.values()].filter((credential) => (nextCheckAt.get(integrationCredentialKey(credential)) ?? 0) <= now);
  // Bound concurrent requests without letting an unreachable provider hold every other probe.
  async function worker() {
    for (let next = due.shift(); next; next = due.shift()) {
      const key = integrationCredentialKey(next);
      const current = roster.get(key);
      if (!current || revisionOf(current) !== revisionOf(next) || (nextCheckAt.get(key) ?? 0) > Date.now()) continue;
      await probe(next).catch(() => {});
      publishNotices();
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, due.length) }, worker));
  publishNotices();
}

export function startIntegrationCredentialMonitor() {
  if (started || !isMainWindow() || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  started = true;
  let running = false;
  let rerun = false;
  const tick = () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void monitor().catch(() => {}).finally(() => {
      running = false;
      if (rerun) {
        rerun = false;
        tick();
      }
    });
  };
  void listen<{ key: string }>("settings:changed", ({ payload }) => {
    if (!ROSTER_SETTINGS.has(payload.key)) return;
    rosterChanged = true;
    tick();
  }).catch(() => {});
  const reload = () => {
    rosterChanged = true;
    tick();
  };
  window.addEventListener("focus", reload);
  window.setInterval(reload, MINUTE_MS);
  tick();
}
