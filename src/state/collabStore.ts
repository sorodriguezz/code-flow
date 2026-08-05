import { create } from "zustand";
import {
  apiResolveConflict,
  apiSharedCollections,
  apiSyncConflicts,
  supabaseHasKey,
  supabaseJoin,
  supabaseLeave,
  supabaseRotate,
  supabaseShare,
  supabaseShareToken,
  type SharedCollectionRow,
  type SyncConflict,
} from "../lib/tauri/apiCommands";
import { listConnections, projectHost } from "../lib/api/projects";
import { useApiStore } from "./apiStore";
import { useWorkspaceStore } from "./workspaceStore";
import { pushErrorToast } from "./toastStore";

/**
 * Everything the UI needs to know about collaboration, in one place.
 *
 * Kept out of `apiStore` deliberately. That store is the workbench — the tree, the tabs, the
 * drafts — and every component in the API client subscribes to some slice of it. A share's status
 * changes every few seconds while the watermark probe runs; folding that into the workbench store
 * would put a re-render behind a heartbeat.
 *
 * `shares` spans **every** workspace, because the collaboration panel is a list of workspaces and
 * their shared collections. `conflicts` is scoped to the active one, because that is the only
 * workspace whose tabs are on screen to be marked.
 */

/** How a share is going, for the dot next to it. */
export type ShareHealth = "syncing" | "conflict" | "error" | "paused" | "ok";

interface CollabState {
  /**
   * The project hosts an anon key is stored for. Plural, and asked per connection: the credential
   * store files a key per project, so "is this set up?" has a different answer for each row of the
   * connections list, and a single boolean answered it for whichever one happened to be first.
   */
  keys: string[];
  shares: SharedCollectionRow[];
  conflicts: SyncConflict[];
  /** Collection ids with a sync round in flight right now. */
  busy: string[];
  loaded: boolean;

  refresh: () => Promise<void>;
  refreshConflicts: () => Promise<void>;
  setBusy: (collectionId: string, busy: boolean) => void;

  /** The share row for one collection, or `null` when it isn't shared. */
  shareFor: (collectionId: string) => SharedCollectionRow | null;
  health: (collectionId: string) => ShareHealth;

  startSharing: (
    collectionId: string,
    name: string,
    projectUrl: string,
  ) => Promise<string | null>;
  join: (url: string, token: string, workspaceId: string) => Promise<string | null>;
  rotate: (collectionId: string) => Promise<string | null>;
  leave: (collectionId: string) => Promise<void>;
  /** The invitation token, read back from the OS credential store. */
  tokenFor: (collectionId: string) => Promise<string | null>;
  resolve: (conflict: SyncConflict, keep: "mine" | "theirs") => Promise<void>;
}

export const useCollabStore = create<CollabState>((set, get) => ({
  keys: [],
  shares: [],
  conflicts: [],
  busy: [],
  loaded: false,

  refresh: async () => {
    try {
      const shares = await apiSharedCollections();
      // Asked of every connection, not only the ones in settings: a project that is only known
      // because shares point at it still needs a key to be reachable, and a row that cannot say
      // whether it has one is a row that cannot explain why its collections stopped syncing.
      const connections = listConnections(
        useApiStore.getState().settings.supabaseProjects,
        shares,
      );
      const answered = await Promise.all(
        connections.map(async (connection) => {
          const has = await supabaseHasKey(connection.url).catch(() => false);
          return has ? projectHost(connection.url) : null;
        }),
      );
      set({ shares, keys: answered.filter((host): host is string => host !== null), loaded: true });
      await get().refreshConflicts();
    } catch (e) {
      pushErrorToast(String(e));
    }
  },

  refreshConflicts: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (workspaceId === null) {
      set({ conflicts: [] });
      return;
    }
    try {
      set({ conflicts: await apiSyncConflicts(workspaceId) });
    } catch {
      // A conflict list that can't be read is not worth a toast on a heartbeat; the next round
      // tries again and the tabs simply stay unmarked until it succeeds.
    }
  },

  setBusy: (collectionId, busy) =>
    set((s) => ({
      busy: busy
        ? s.busy.includes(collectionId)
          ? s.busy
          : [...s.busy, collectionId]
        : s.busy.filter((id) => id !== collectionId),
    })),

  shareFor: (collectionId) => get().shares.find((s) => s.collection_id === collectionId) ?? null,

  health: (collectionId) => {
    if (get().busy.includes(collectionId)) return "syncing";
    const share = get().shareFor(collectionId);
    if (!share) return "ok";
    if (share.conflicts > 0) return "conflict";
    if (share.last_error !== "") return "error";
    // Reported after the real failures and before "fine", because it is not a failure — but a
    // share that is shared and not syncing has to say so. Claiming "synced 4 minutes ago" while
    // background sync is off is how an edit sits on one machine all afternoon with the UI
    // insisting everything is in order.
    if (!useApiStore.getState().settings.syncAuto) return "paused";
    return "ok";
  },

  startSharing: async (collectionId, name, projectUrl) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (workspaceId === null || projectUrl.trim() === "") return null;
    try {
      const shared = await supabaseShare(projectUrl, collectionId, workspaceId, name);
      await get().refresh();
      return shared.share_token;
    } catch (e) {
      pushErrorToast(String(e));
      return null;
    }
  },

  join: async (url, token, workspaceId) => {
    try {
      const shared = await supabaseJoin(url, token, workspaceId);
      await get().refresh();
      return shared.id;
    } catch (e) {
      pushErrorToast(String(e));
      return null;
    }
  },

  rotate: async (collectionId) => {
    const url = get().shareFor(collectionId)?.project_url;
    if (!url) return null;
    try {
      return await supabaseRotate(url, collectionId);
    } catch (e) {
      pushErrorToast(String(e));
      return null;
    }
  },

  leave: async (collectionId) => {
    try {
      await supabaseLeave(collectionId);
      await get().refresh();
    } catch (e) {
      pushErrorToast(String(e));
    }
  },

  tokenFor: (collectionId) => supabaseShareToken(collectionId).catch(() => null),

  resolve: async (conflict, keep) => {
    try {
      await apiResolveConflict(conflict.collection_id, conflict.kind, conflict.id, keep);
      // Both outcomes change rows the tree is showing: "theirs" writes the incoming record, "mine"
      // re-stamps the local one so the next push carries it.
      await useApiStore.getState().reloadTree();
      await get().refresh();
    } catch (e) {
      pushErrorToast(String(e));
    }
  },
}));
