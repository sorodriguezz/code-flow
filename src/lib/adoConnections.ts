import { getAdoPat, getSetting, setSetting } from "./tauri/commands";
import { useVcsConnectionsStore } from "../state/vcsConnectionsStore";
import type { AdoConnection } from "../types/domain";

// The list of connected Azure DevOps organizations, persisted as a single app-setting JSON
// blob — the PATs themselves stay in the OS keychain, keyed per org (`ado-pat:{org}`). Mirrors
// the GitHub connections model so both hosts support several accounts at once.
const KEY = "ado_connections";
// Where a single org lived before multi-org support — read once for back-compat migration.
const LEGACY_ORG_KEY = "ado_default_org";

// The legacy probe below reads the OS keychain, and this loader has many callers — the Azure
// settings screen, the stories workspace, and the sidebar's pull requests section, which runs it
// once per repository whose PR list you actually open. On macOS each keychain read can pop a
// password prompt, so the probe is memoized: the legacy state can't change during a session
// without the user saving connections, and saving writes `ado_connections`, which makes the
// legacy path unreachable from then on anyway.
let legacyProbe: Promise<AdoConnection[]> | null = null;

export async function loadAdoConnections(): Promise<AdoConnection[]> {
  const raw = await getSetting(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((c): c is AdoConnection => c && typeof c.org === "string");
    } catch {
      /* fall through to legacy */
    }
  }
  // Back-compat: before multi-org support, a single org lived in `ado_default_org`. Surface it
  // as a one-item list (only if its PAT is still saved) so an existing connection isn't lost
  // after upgrading. Once the user adds/removes anything, `ado_connections` becomes authoritative.
  legacyProbe ??= (async () => {
    const legacyOrg = await getSetting(LEGACY_ORG_KEY);
    if (legacyOrg) {
      const pat = await getAdoPat(legacyOrg).catch(() => null);
      if (pat) return [{ org: legacyOrg }];
    }
    return [];
  })();
  return legacyProbe;
}

/**
 * The same list, without the keychain probe.
 *
 * `loadAdoConnections` reads the keychain on its legacy path, which is fine where it has always
 * run — inside a section the user unfolded. It is not fine at startup: `vcsConnectionsStore`
 * refreshes in the boot batch, and on macOS with an ad-hoc signature that turns into a password
 * dialog every single launch for anyone who upgraded from the pre-multi-org version.
 *
 * Settings-only also makes the frontend agree with the backend, which is what actually decides:
 * `ado_connected_orgs` reads the same two settings and never checks that the PAT is still there.
 */
export async function loadAdoConnectionsFromSettings(): Promise<AdoConnection[]> {
  const raw = await getSetting(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((c): c is AdoConnection => c && typeof c.org === "string");
    } catch {
      /* fall through to legacy */
    }
  }
  const legacyOrg = await getSetting(LEGACY_ORG_KEY);
  return legacyOrg ? [{ org: legacyOrg }] : [];
}

export async function saveAdoConnections(connections: AdoConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
  // The Pipelines tab is drawn from this list, so a save that nobody hears about is a tab that
  // does not appear until the next launch. Notified here rather than at the six call sites
  // (three settings forms, add and remove in each) because this is the one place they share.
  await useVcsConnectionsStore.getState().refresh();
}

// Accepts a bare org name or a pasted `https://dev.azure.com/<org>` /
// `https://<org>.visualstudio.com` URL and reduces it to the bare name — the Azure DevOps REST
// client builds request paths straight from this value and rejects URLs.
export function normalizeAdoOrg(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  const devAzureMatch = trimmed.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
  if (devAzureMatch) return devAzureMatch[1];
  const visualStudioMatch = trimmed.match(/^https?:\/\/([^./]+)\.visualstudio\.com/i);
  if (visualStudioMatch) return visualStudioMatch[1];
  return trimmed;
}
