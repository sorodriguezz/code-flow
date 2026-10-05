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
import { apiLoadSettings, supabaseAnonKey, supabaseSetAnonKey, supabaseShareToken } from "../lib/tauri/apiCommands";
import { decodeInvite, encodeInvite } from "../lib/api/invite";
import type { SupabaseProject } from "../types/api";
import { isMainWindow } from "../lib/windowIdentity";
import { translate } from "./languageStore";
import { pushErrorToast, pushSuccessToast } from "./toastStore";

/**
 * Flows shared through the user's own Supabase project (`flows::share`) — the projects are the
 * ones set up for the API client's collections, the invitation codes are the same `codeflow:`
 * codes (tagged `kind: "flow"`), and the sync runs in Rust.
 *
 * **The poller lives in the main window only**, like every other background loop, and asks for
 * a full round only when something moved (`flows_share_tick`): every few seconds while the app is
 * in front, once a minute behind other windows. A round that brings a teammate's version announces
 * it (`flows:shared`), and the Flows store reloads what is on screen.
 */

const VISIBLE_EVERY_MS = 5_000;
const HIDDEN_EVERY_MS = 60_000;

interface FlowShareState {
  shares: Record<string, FlowShareRow>;
  /** Shares whose last round failed, and why — read from the row, kept here for re-renders. */
  loaded: boolean;
  refresh: () => Promise<void>;
  /** The projects a flow can be shared on: the API client's, those whose connection test passed. */
  projects: () => Promise<SupabaseProject[]>;
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

  refresh: async () => {
    try {
      const rows = await flowsShares();
      set({ shares: Object.fromEntries(rows.map((row) => [row.flowId, row])), loaded: true });
    } catch {
      // A failed read keeps what is shown; the next tick tries again.
    }
  },

  projects: async () => {
    const raw = await apiLoadSettings().catch(() => null);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { supabaseProjects?: SupabaseProject[] };
      return (parsed.supabaseProjects ?? []).filter((project) => project.ready && project.url.trim() !== "");
    } catch {
      return [];
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
