import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  flowsJoinShared,
  flowsShare,
  flowsShareLeave,
  flowsShareResolve,
  flowsShareRotate,
  flowsShares,
  flowsShareSync,
  flowsShareTick,
  type FlowSharedEvent,
  type FlowShareRow,
} from "../lib/tauri/flowsCommands";
import {
  supabaseAnonKey,
  supabaseCheck,
  supabaseHasKey,
  supabaseSetAnonKey,
  supabaseShareToken,
} from "../lib/tauri/apiCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { decodeInvite, encodeInvite } from "../lib/api/invite";
import { listConnections, projectHost, sameProject } from "../lib/api/projects";
import { FLOWS_PROJECTS_SETTING, keyNeededBy, parseProjects } from "../lib/collabKeys";
import { watchSettings } from "../lib/settingsSync";
import type { SupabaseProject } from "../types/api";
import type { UsableConnection } from "../components/api/CollaborationPanel";
import { isMainWindow } from "../lib/windowIdentity";
import { translate } from "./languageStore";
import { pushErrorToast, pushSuccessToast } from "./toastStore";

/**
 * Flows shared through the user's own Supabase project (`flows::share`). **Flujos keeps its own
 * projects** (setting `flows_collab_projects`, set up in its Collaboration pane) apart from the API
 * client's — one list per app, because one list in the API client's settings for both was where
 * nobody looked for it. Only the stored key is common: the credential store files one per project,
 * so the same project connected in both panes uses one key (`lib/collabKeys.ts`). The invitation
 * codes are the same `codeflow:` codes (tagged `kind: "flow"`), and the sync runs in Rust.
 *
 * **The poller lives in the main window only**, like every other background loop, and asks for
 * a full round only when something moved (`flows_share_tick`): every few seconds while the app is
 * in front, once a minute behind other windows. A round that brings a teammate's version announces
 * it (`flows:shared`), and the Flows store reloads what is on screen.
 */

const VISIBLE_EVERY_MS = 5_000;
const HIDDEN_EVERY_MS = 60_000;

/** The panes of Flujos' Collaboration window. */
export type FlowCollabTab = "project" | "shares" | "join";

interface FlowShareState {
  shares: Record<string, FlowShareRow>;
  /** Shares whose last round failed, and why — read from the row, kept here for re-renders. */
  loaded: boolean;
  refresh: () => Promise<void>;

  /** The projects set up here for flows, with their last verdicts. */
  saved: SupabaseProject[];
  /** Hosts with a stored key — asked when the Collaboration window or the share dialog opens, not
   *  on the poller's heartbeat (each answer is a keychain read). */
  keys: string[];
  /** The Collaboration window and its pane; `null` while it is closed. */
  collab: FlowCollabTab | null;
  openCollab: (tab?: FlowCollabTab) => void;
  closeCollab: () => void;
  loadProjects: () => Promise<void>;
  refreshKeys: () => Promise<void>;
  /** Writes one project's row, creating it the first time. */
  saveProject: (url: string, patch: Partial<Omit<SupabaseProject, "url">>) => Promise<void>;
  /** Asks the project whether it answers and has the schema, and records the verdict. */
  verify: (url: string, silent: boolean) => Promise<boolean>;
  /** Files the key under its project (when one was typed) and checks it. */
  connect: (url: string, anonKey: string) => Promise<boolean>;
  /** Drops the row — and the key, unless the API client still uses it. */
  forgetProject: (url: string) => Promise<void>;
  share: (flowId: string, url: string) => Promise<boolean>;
  /** The code to hand out, rebuilt from the project, its public key and the token. */
  inviteCode: (flowId: string) => Promise<string | null>;
  join: (code: string, workspaceId: string, folderId: string | null) => Promise<string | null>;
  syncNow: (flowId: string) => Promise<void>;
  resolve: (flowId: string, keepMine: boolean) => Promise<void>;
  rotate: (flowId: string) => Promise<string | null>;
  leave: (flowId: string) => Promise<void>;
}

export const useFlowShareStore = create<FlowShareState>((set, get) => ({
  shares: {},
  loaded: false,
  saved: [],
  keys: [],
  collab: null,

  openCollab: (tab = "project") => set({ collab: tab }),
  closeCollab: () => set({ collab: null }),

  loadProjects: async () => {
    const raw = await getSetting(FLOWS_PROJECTS_SETTING).catch(() => null);
    set({ saved: parseProjects(raw) });
  },

  refreshKeys: async () => {
    const answered = await Promise.all(
      flowConnections(get()).map(async (connection) =>
        (await supabaseHasKey(connection.url).catch(() => false)) ? projectHost(connection.url) : null,
      ),
    );
    set({ keys: answered.filter((host): host is string => host !== null) });
  },

  saveProject: async (url, patch) => {
    // Read fresh, not from `get()` alone: another window may have written the list since.
    await get().loadProjects();
    const list = get().saved;
    const index = list.findIndex((project) => sameProject(project.url, url));
    const next =
      index === -1
        ? [...list, { url: url.trim(), ready: false, checkedAt: "", ...patch }]
        : list.map((project, at) => (at === index ? { ...project, ...patch } : project));
    set({ saved: next });
    await setSetting(FLOWS_PROJECTS_SETTING, JSON.stringify(next));
  },

  verify: async (url, silent) => {
    if (url.trim() === "") return false;
    try {
      const check = await supabaseCheck(url);
      const ready = check.reachable && check.schema_installed;
      await get().saveProject(url, {
        ready,
        checkedAt: new Date().toISOString(),
        schemaOutdated: ready && check.schema_outdated,
      });
      if (!silent && ready) pushSuccessToast(translate("api.collab.checkPassed"));
      return ready;
    } catch (error) {
      await get().saveProject(url, { ready: false, checkedAt: new Date().toISOString() });
      if (!silent) pushErrorToast(String(error));
      return false;
    }
  },

  connect: async (url, anonKey) => {
    if (anonKey.trim() !== "") {
      await supabaseSetAnonKey(url, anonKey).catch((error: unknown) => pushErrorToast(String(error)));
    }
    await get().saveProject(url, {});
    const ready = await get().verify(url, false);
    await get().refreshKeys();
    return ready;
  },

  forgetProject: async (url) => {
    if (!(await keyNeededBy("api", url))) {
      await supabaseSetAnonKey(url, "").catch((error: unknown) => pushErrorToast(String(error)));
    }
    await get().loadProjects();
    const next = get().saved.filter((project) => !sameProject(project.url, url));
    set({ saved: next });
    await setSetting(FLOWS_PROJECTS_SETTING, JSON.stringify(next));
    await get().refreshKeys();
  },

  refresh: async () => {
    try {
      const rows = await flowsShares();
      set({ shares: Object.fromEntries(rows.map((row) => [row.flowId, row])), loaded: true });
    } catch {
      // A failed read keeps what is shown; the next tick tries again.
    }
  },

  share: async (flowId, url) => {
    try {
      await flowsShare(url, flowId);
      await get().refresh();
      return true;
    } catch (error) {
      pushErrorToast(describeShareError(String(error)));
      return false;
    }
  },

  inviteCode: async (flowId) => {
    const row = get().shares[flowId];
    if (!row) return null;
    const [key, token] = await Promise.all([supabaseAnonKey(row.projectUrl), supabaseShareToken(flowId)]);
    if (!key || !token) return null;
    return encodeInvite({ url: row.projectUrl, key, token, name: row.name, kind: "flow" });
  },

  join: async (code, workspaceId, folderId) => {
    try {
      const invite = decodeInvite(code);
      if (invite.kind !== "flow") throw new Error(translate("flows.share.notAFlow"));
      // Filed under the project the code names before anything is asked of it — the same order
      // the collections' join keeps, for the same reason (`useImportCollaborative`).
      await supabaseSetAnonKey(invite.url, invite.key);
      const meta = await flowsJoinShared(invite.url, invite.token, workspaceId, folderId);
      await get().refresh();
      pushSuccessToast(translate("flows.share.joined", { name: meta.name }));
      return meta.id;
    } catch (error) {
      pushErrorToast(describeShareError(String(error)));
      return null;
    }
  },

  syncNow: async (flowId) => {
    try {
      await flowsShareSync(flowId);
    } catch (error) {
      pushErrorToast(describeShareError(String(error)));
    }
    await get().refresh();
  },

  resolve: async (flowId, keepMine) => {
    try {
      await flowsShareResolve(flowId, keepMine);
    } catch (error) {
      pushErrorToast(describeShareError(String(error)));
    }
    await get().refresh();
  },

  rotate: async (flowId) => {
    try {
      await flowsShareRotate(flowId);
      return await get().inviteCode(flowId);
    } catch (error) {
      pushErrorToast(describeShareError(String(error)));
      return null;
    }
  },

  leave: async (flowId) => {
    try {
      await flowsShareLeave(flowId);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },
}));

/**
 * Every project Flujos hosts on: the ones set up here plus the ones its own hosted shares still
 * point at (`listConnections`, the API client's rule — a project with flows on it is never
 * invisible). A guest's projects are the host's and are not listed.
 */
export function flowConnections(state: Pick<FlowShareState, "saved" | "shares" | "keys">): UsableConnection[] {
  const shares = Object.values(state.shares).map((row) => ({ role: row.role, project_url: row.projectUrl }));
  return listConnections(state.saved, shares).map((connection) => ({
    ...connection,
    hasKey: state.keys.includes(projectHost(connection.url)),
  }));
}

/** The ones a new share can be created on: answered, with the schema, and with a key here. */
export function usableConnections(state: Pick<FlowShareState, "saved" | "shares" | "keys">): UsableConnection[] {
  return flowConnections(state).filter((connection) => connection.ready && connection.hasKey);
}

// Another window connecting or removing a project is seen here too.
watchSettings([FLOWS_PROJECTS_SETTING], () => useFlowShareStore.getState().loadProjects());

/** A project still on the setup script from before flows could be shared says so in Postgres'
 *  words; this says what to do about it. */
export function describeShareError(error: string): string {
  if (error.includes("cf_items_kind_check")) return translate("flows.share.oldScript");
  return error;
}

let polling = false;
let listening = false;

/** Starts the main window's poller once; every window listens for the rounds it reports. */
export function startFlowSharing(onShared: (event: FlowSharedEvent) => void): void {
  if (listening) return;
  listening = true;
  void listen<FlowSharedEvent>("flows:shared", (event) => {
    onShared(event.payload);
    void useFlowShareStore.getState().refresh();
  });
  if (polling || !isMainWindow()) return;
  polling = true;
  const loop = async () => {
    const store = useFlowShareStore.getState();
    await store.refresh();
    const before = useFlowShareStore.getState().shares;
    for (const row of Object.values(before)) {
      if (row.conflict) continue;
      await flowsShareTick(row.flowId).catch(() => {});
    }
    // What a tick recorded (an error, a new base) shows on the next read.
    const any = Object.keys(before).length > 0;
    if (any) await useFlowShareStore.getState().refresh();
    // Nothing shared: a slow look, just to notice a share made in another window.
    setTimeout(() => void loop(), any && document.visibilityState === "visible" ? VISIBLE_EVERY_MS : HIDDEN_EVERY_MS);
  };
  void loop();
}
