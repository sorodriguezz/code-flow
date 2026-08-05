import { create } from "zustand";
import {
  remoteCloseForward,
  remoteCloseFiles,
  remoteCloseHostForwards,
  remoteCloseScreen,
  remoteCreateHost,
  remoteCreateSnippet,
  remoteDeleteHost,
  remoteDeleteSnippet,
  remoteDuplicateHost,
  remoteListForwards,
  remoteLoadTree,
  remoteOpenDraftSession,
  remoteOpenForward,
  remoteOpenScreen,
  remoteOpenSession,
  remotePing,
  remoteRenameGroup,
  remoteReorderHosts,
  remoteUpdateHost,
  remoteUpdateSnippet,
} from "../lib/tauri/remoteCommands";
import { closeTerminal, writeTerminal } from "../lib/tauri/commands";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import { looksSecret } from "../lib/remote/typedLines";
import {
  defaultHostSpec,
  parseHostSpec,
  type ActiveForward,
  type ForwardSpec,
  type RemoteHostRow,
  type RemoteHostSpec,
  type RemoteSnippet,
  type ScreenLaunch,
} from "../types/remote";

/**
 * The Remote workspace's state.
 *
 * Scoped per workspace, like `dbStore` and `apiStore` — a host belongs to the environment a
 * workspace's repositories deploy to, not to any one repository, so switching repository must not
 * change what is on screen.
 *
 * Three things are worth knowing before reading it:
 *
 * 1. **A session tab holds a terminal id, not a connection.** Opening one asks the backend to put
 *    `ssh` in a pty and hands back the same kind of id a local shell has, so the pane that renders
 *    it is the existing xterm component and closing a tab is `closeTerminal`. There is no connected
 *    / disconnected state to model: a session exists while its process does.
 *
 * 2. **`forwards` is polled, not derived.** It is the backend's list of live `ssh -N` children, and
 *    the interesting change — one dying because the network dropped — produces no event. A forward
 *    in a host's `spec` is a saved *intention*; a forward in this array is a listening port.
 *
 * 3. **Auto forwards never appear in `forwards`.** They ride on the session's own `ssh` (see
 *    `remotes::session`), so they live and die with the terminal. That is the point of marking one
 *    auto, and it is why the forwards panel shows them as "with the session" rather than as rows
 *    that could be closed on their own.
 */

const collapsedKey = (workspaceId: string) => `remote_collapsed_groups:${workspaceId}`;
const historyKey = (workspaceId: string) => `remote_history:${workspaceId}`;

/** Beyond this the oldest entries go. A history is a list to scan for the thing you ran an hour
 *  ago, not an archive — and it lives in one settings row, which is not where an unbounded log
 *  belongs. */
const HISTORY_LIMIT = 200;

/** Not workspace-scoped: how you like to *read* a list is a habit, not a property of one estate. */
const HOST_VIEW_KEY = "remote_host_view";

/** How often the live-forward list is re-read while the Remote view is on screen. Slow enough to be
 *  free, fast enough that a tunnel dropping is noticed before the user tries to use it. */
export const FORWARD_POLL_MS = 4000;

/** The name a group with no name is shown under. Not stored — `group_name` stays `""` — so a host
 *  dragged out of a real group doesn't acquire a literal group called "Ungrouped". */
export const UNGROUPED = "";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** A live shell. `sessionId` is a terminal-registry id. */
export interface RemoteSessionTab {
  id: string;
  kind: "session";
  hostId: string;
  name: string;
  sessionId: string;
  /** Set when the pty reported the process ended, so the tab can say so instead of looking live. */
  exited: boolean;
}

/** A host's port forwards: the saved list, and which of them are up. */
export interface RemoteForwardsTab {
  id: string;
  kind: "forwards";
  hostId: string;
  name: string;
}

/** A launched screen. The viewer is an external window; what this tab owns is the SSH tunnel
 *  underneath it, which is why closing the tab closes that tunnel. */
export interface RemoteScreenTab {
  id: string;
  kind: "screen";
  hostId: string;
  name: string;
  launch: ScreenLaunch | null;
  opening: boolean;
  error: string | null;
}

/** Every forward in the workspace. Belongs to no host, which is exactly its point. */
export interface RemoteAllForwardsTab {
  id: string;
  kind: "all-forwards";
  /** Empty: this tab is about the local machine, not about any one host. Kept so every tab has the
   *  same shape and nothing has to branch on whether `hostId` exists. */
  hostId: string;
  name: string;
}

/** A host's files, both sides. One per host: it is a view of that machine, and two would disagree
 *  the moment one of them uploaded something. */
export interface RemoteSftpTab {
  id: string;
  kind: "sftp";
  hostId: string;
  name: string;
}

/** The connection log. Belongs to no host, like the global forwards tab. */
export interface RemoteLogTab {
  id: string;
  kind: "log";
  hostId: string;
  name: string;
}

/** One command, and which machine it was typed at. */
export interface RemoteHistoryEntry {
  id: string;
  hostId: string;
  hostName: string;
  body: string;
}

export type RemoteTab =
  | RemoteSessionTab
  | RemoteForwardsTab
  | RemoteScreenTab
  | RemoteAllForwardsTab
  | RemoteSftpTab
  | RemoteLogTab;

interface RemoteState {
  workspaceId: string | null;
  loading: boolean;
  hosts: RemoteHostRow[];
  snippets: RemoteSnippet[];
  forwards: ActiveForward[];
  /** Group names the user has collapsed. Persisted: a collapsed group is a decision about how much
   *  room a set of hosts deserves, and re-making it every launch is the reason `layoutStore` keeps
   *  its own flags rather than leaving them to session state. */
  collapsedGroups: string[];
  /** Filter over the tree. Session state — a search is a thing you are doing, not a preference. */
  query: string;
  /**
   * Tags a host must carry to show, ANDed together.
   *
   * AND rather than OR because tags cross the group axis: picking `postgres` and `prod` is asking
   * for the production database boxes, not for everything that is either. OR is what the search
   * box already does across every field.
   */
  tagFilter: string[];
  /**
   * How the main area lists hosts when no session is open.
   *
   * Persisted, unlike the search: this is a decision about how you like to read your estate, not
   * something you are doing right now.
   */
  hostView: "grid" | "list";
  tabs: RemoteTab[];
  activeTabId: string | null;
  /**
   * Commands typed in this workspace's sessions, newest first.
   *
   * Reconstructed from keystrokes (see `typedLines`), so it is "what you typed" and not "what the
   * shell ran" — the UI says as much. It exists for one move: you got a command right, and you want
   * it as a snippet without retyping it.
   */
  history: RemoteHistoryEntry[];
  /**
   * Round-trip time to the selected host, in milliseconds — `null` for "no direct route", which is
   * the correct answer for anything behind a jump host.
   *
   * Only the selected host is measured. Probing the whole estate on every tick would open a TCP
   * connection per host per poll, which against a firewall that logs them is indistinguishable from
   * a port scan.
   */
  latency: number | null;
  /** Host whose row is in inline-rename mode, or `null`. */
  renamingHostId: string | null;
  /**
   * Host whose settings the right-hand panel is showing, or `null` for closed.
   *
   * In the store rather than in `RemoteView`'s state because four different places open it — a tree
   * row, a gallery card, the connect bar after saving a pasted line, and an action on a host with
   * no address — and threading one setter through all four was prop drilling with no benefit.
   */
  detailsHostId: string | null;
  /**
   * The host the tree is focused on, or `null`.
   *
   * Selection is not "the host of the active tab", and conflating them was the mistake worth
   * avoiding: a host with no session open is still the one you are working on — you came to it to
   * add a forward or check its address — and a tree that can only highlight hosts that already
   * have a terminal leaves the common case with nothing highlighted at all.
   */
  selectedHostId: string | null;

  setWorkspace: (workspaceId: string) => Promise<void>;
  refresh: () => Promise<void>;
  setQuery: (query: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setHostView: (view: "grid" | "list") => void;
  toggleGroup: (group: string) => void;
  setRenamingHost: (id: string | null) => void;
  openDetails: (id: string) => void;
  closeDetails: () => void;
  selectHost: (id: string | null) => void;

  createHost: (name: string, groupName: string) => Promise<RemoteHostRow | null>;
  saveHost: (row: RemoteHostRow, spec: RemoteHostSpec) => Promise<boolean>;
  renameHost: (id: string, name: string) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;
  duplicateHost: (id: string) => Promise<RemoteHostRow | null>;
  reorderHosts: (ids: string[]) => Promise<void>;
  renameGroup: (from: string, to: string) => Promise<void>;
  setHostGroup: (id: string, group: string) => Promise<void>;
  /**
   * What a drop does: put `hostId` immediately before `beforeHostId` (or last in `group` when that
   * is null), moving it between groups if the group changed.
   *
   * One action rather than two calls from the UI, because the two writes have to agree: a host that
   * changed group and then got reordered against the *old* group's list would land somewhere
   * nobody dropped it.
   */
  dropHost: (hostId: string, group: string, beforeHostId: string | null) => Promise<void>;

  openSession: (hostId: string) => Promise<void>;
  /** Opens a session against a spec that was never saved — the connect bar's one-off. */
  connectDraft: (spec: RemoteHostSpec, name: string) => Promise<void>;
  /** Turns a parsed line into a host row, so the next connection is one click. */
  saveDraftAsHost: (spec: RemoteHostSpec, name: string) => Promise<RemoteHostRow | null>;
  markExited: (sessionId: string) => void;
  openForwards: (hostId: string) => void;
  openAllForwards: () => void;
  openLog: () => void;
  openSftp: (hostId: string) => void;
  openScreen: (hostId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;

  pollForwards: () => Promise<void>;
  startForward: (hostId: string, forward: ForwardSpec) => Promise<void>;
  stopForward: (id: string) => Promise<void>;

  createSnippet: (name: string, body: string) => Promise<void>;
  saveSnippet: (snippet: RemoteSnippet) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
  /** Sends a snippet into the focused session. A no-op with a trailing newline appended, which is
   *  what makes it *run* rather than land in the prompt for the user to press Enter on. */
  runSnippet: (body: string) => Promise<void>;

  /** Records a typed line against its session's host. Silently drops anything that looks like a
   *  credential — see `looksSecret`. */
  recordCommand: (sessionId: string, line: string) => void;
  clearHistory: () => void;
}

/**
 * Guards against the callers that can race a first load (the view mounting, StrictMode mounting it
 * twice, the workspace switch), the same latch `dbStore` and `apiStore` use.
 */
let pendingLoad: { workspaceId: string; promise: Promise<void> } | null = null;

export function ensureRemoteStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useRemoteStore.getState().setWorkspace(workspaceId);
}

/** The host a tab belongs to, or `null` if it has been deleted underneath the tab. */
export function hostOf(hosts: RemoteHostRow[], hostId: string): RemoteHostRow | null {
  return hosts.find((host) => host.id === hostId) ?? null;
}

/** Hosts by group, in the order the tree draws them: ungrouped first, then groups alphabetically.
 *
 * Ungrouped first rather than last because it is where a newly created host lands, and a user who
 * has just pressed "New host" should not have to scroll past their whole estate to find it. */
export function groupHosts(hosts: RemoteHostRow[]): [string, RemoteHostRow[]][] {
  const groups = new Map<string, RemoteHostRow[]>();
  for (const host of hosts) {
    const key = host.group_name.trim();
    const bucket = groups.get(key);
    if (bucket) bucket.push(host);
    else groups.set(key, [host]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED) return -1;
    if (b === UNGROUPED) return 1;
    return a.localeCompare(b);
  });
}

/** Whether a host matches the tree filter. Matches the name, the group and the address, because
 *  all three are things people remember a machine by — and an IP is often the only one. */
export function hostMatches(host: RemoteHostRow, query: string, tagFilter: string[] = []): boolean {
  const spec = parseHostSpec(host);
  // Every selected tag, not any — see `tagFilter`.
  if (tagFilter.length > 0 && !tagFilter.every((tag) => spec.tags.includes(tag))) return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [host.name, host.group_name, spec.host, spec.user, spec.notes, ...spec.tags]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/** Every tag in use, in alphabetical order — what the filter row offers. */
export function allTags(hosts: RemoteHostRow[]): string[] {
  const tags = new Set<string>();
  for (const host of hosts) for (const tag of parseHostSpec(host).tags) tags.add(tag.trim());
  tags.delete("");
  return [...tags].sort();
}

let tabSeq = 0;
const nextTabId = () => `remote-tab-${++tabSeq}`;
let historySeq = 0;

export const useRemoteStore = create<RemoteState>((set, get) => ({
  workspaceId: null,
  loading: false,
  hosts: [],
  snippets: [],
  forwards: [],
  collapsedGroups: [],
  query: "",
  tagFilter: [],
  hostView: "grid",
  history: [],
  latency: null,
  tabs: [],
  activeTabId: null,
  renamingHostId: null,
  selectedHostId: null,
  detailsHostId: null,

  setWorkspace: async (workspaceId) => {
    if (pendingLoad?.workspaceId === workspaceId) return pendingLoad.promise;
    if (get().workspaceId === workspaceId && !get().loading) return;

    // Every session belongs to the workspace being left. Killing them is the honest move: they are
    // processes, not documents, and leaving them running behind a workspace switch means `ssh`
    // children nothing on screen names.
    for (const tab of get().tabs) {
      if (tab.kind === "session") void closeTerminal(tab.sessionId).catch(() => {});
      if (tab.kind === "screen") void remoteCloseScreen(tab.hostId).catch(() => {});
      if (tab.kind === "sftp") void remoteCloseFiles(tab.hostId).catch(() => {});
    }

    // Cleared rather than left to be overwritten: for the length of the load the view would
    // otherwise still show the workspace the user just left.
    set({
      workspaceId,
      loading: true,
      hosts: [],
      snippets: [],
      forwards: [],
      tabs: [],
      activeTabId: null,
      query: "",
      tagFilter: [],
      renamingHostId: null,
      selectedHostId: null,
      detailsHostId: null,
      history: [],
    });

    const promise = (async () => {
      try {
        const [tree, collapsed, hostView, history] = await Promise.all([
          remoteLoadTree(workspaceId),
          loadCollapsed(workspaceId),
          loadSetting(HOST_VIEW_KEY),
          loadSetting(historyKey(workspaceId)),
        ]);
        set({
          hosts: tree.hosts,
          snippets: tree.snippets,
          collapsedGroups: collapsed,
          hostView: hostView === "list" ? "list" : "grid",
          history: parseHistory(history),
        });
        await get().pollForwards();
      } catch (error) {
        pushErrorToast(`${translate("remote.loadFailed")}: ${String(error)}`);
      } finally {
        set({ loading: false });
        pendingLoad = null;
      }
    })();

    pendingLoad = { workspaceId, promise };
    return promise;
  },

  refresh: async () => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    try {
      const tree = await remoteLoadTree(workspaceId);
      set({ hosts: tree.hosts, snippets: tree.snippets });
    } catch (error) {
      pushErrorToast(`${translate("remote.loadFailed")}: ${String(error)}`);
    }
  },

  setQuery: (query) => set({ query }),

  toggleTag: (tag) =>
    set((s) => ({
      tagFilter: s.tagFilter.includes(tag)
        ? s.tagFilter.filter((entry) => entry !== tag)
        : [...s.tagFilter, tag],
    })),

  clearTags: () => set({ tagFilter: [] }),

  setHostView: (hostView) => {
    set({ hostView });
    void saveSetting(HOST_VIEW_KEY, hostView);
  },

  toggleGroup: (group) => {
    const workspaceId = get().workspaceId;
    const collapsed = get().collapsedGroups.includes(group)
      ? get().collapsedGroups.filter((name) => name !== group)
      : [...get().collapsedGroups, group];
    set({ collapsedGroups: collapsed });
    if (workspaceId) void saveCollapsed(workspaceId, collapsed);
  },

  setRenamingHost: (renamingHostId) => set({ renamingHostId }),

  // Opening the panel also focuses the host: the panel and the highlighted row must never name two
  // different machines.
  openDetails: (id) => set({ detailsHostId: id, selectedHostId: id }),

  closeDetails: () => set({ detailsHostId: null }),

  // The old number goes the moment the host does — a stale latency under a new name is worse
  // than none, because it looks measured.
  selectHost: (selectedHostId) => set({ selectedHostId, latency: null }),

  createHost: async (name, groupName) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    try {
      const spec = JSON.stringify(defaultHostSpec());
      const row = await remoteCreateHost(workspaceId, name, groupName, spec, "");
      set((s) => ({ hosts: [...s.hosts, row] }));
      return row;
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      return null;
    }
  },

  saveHost: async (row, spec) => {
    const updated: RemoteHostRow = { ...row, spec: JSON.stringify(spec) };
    try {
      await remoteUpdateHost(updated);
      set((s) => ({ hosts: s.hosts.map((host) => (host.id === row.id ? updated : host)) }));
      return true;
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      return false;
    }
  },

  renameHost: async (id, name) => {
    const row = get().hosts.find((host) => host.id === id);
    if (!row || !name.trim() || name === row.name) {
      set({ renamingHostId: null });
      return;
    }
    const updated = { ...row, name: name.trim() };
    // Optimistic: the row is renamed before the write goes out, because a name that snaps back for
    // a moment reads as a rejected edit.
    set((s) => ({
      hosts: s.hosts.map((host) => (host.id === id ? updated : host)),
      tabs: s.tabs.map((tab) => (tab.hostId === id ? { ...tab, name: updated.name } : tab)),
      renamingHostId: null,
    }));
    try {
      await remoteUpdateHost(updated);
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  deleteHost: async (id) => {
    // Its tabs go first: a session tab pointing at a host that no longer exists has nothing to
    // render a title from, and its `ssh` would outlive everything naming it.
    for (const tab of get().tabs.filter((tab) => tab.hostId === id)) {
      await get().closeTab(tab.id);
    }
    try {
      await remoteDeleteHost(id);
      set((s) => ({
        hosts: s.hosts.filter((host) => host.id !== id),
        detailsHostId: s.detailsHostId === id ? null : s.detailsHostId,
      }));
      await get().pollForwards();
    } catch (error) {
      pushErrorToast(`${translate("remote.deleteFailed")}: ${String(error)}`);
    }
  },

  duplicateHost: async (id) => {
    try {
      const row = await remoteDuplicateHost(id);
      set((s) => ({ hosts: [...s.hosts, row] }));
      return row;
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      return null;
    }
  },

  reorderHosts: async (ids) => {
    // Optimistic, for the reason `workspaceStore.reorderProject` gives: a row that snaps back for a
    // moment reads as a failed drag.
    const byId = new Map(get().hosts.map((host) => [host.id, host]));
    const reordered = ids.map((id) => byId.get(id)).filter((host): host is RemoteHostRow => !!host);
    set({ hosts: reordered });
    try {
      await remoteReorderHosts(ids);
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  renameGroup: async (from, to) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId || from === to) return;
    set((s) => ({
      hosts: s.hosts.map((host) => (host.group_name === from ? { ...host, group_name: to } : host)),
      collapsedGroups: s.collapsedGroups.map((name) => (name === from ? to : name)),
    }));
    try {
      await remoteRenameGroup(workspaceId, from, to);
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  setHostGroup: async (id, group) => {
    const row = get().hosts.find((host) => host.id === id);
    if (!row) return;
    const updated = { ...row, group_name: group };
    set((s) => ({ hosts: s.hosts.map((host) => (host.id === id ? updated : host)) }));
    try {
      await remoteUpdateHost(updated);
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  dropHost: async (hostId, group, beforeHostId) => {
    const hosts = get().hosts;
    const moving = hosts.find((host) => host.id === hostId);
    if (!moving || hostId === beforeHostId) return;

    const changedGroup = moving.group_name !== group;
    // Optimistic and in one `set`, so the row never blinks through an intermediate list — the
    // reason `reorderProject` does the same.
    const without = hosts.filter((host) => host.id !== hostId);
    const moved = { ...moving, group_name: group };
    const at = beforeHostId ? without.findIndex((host) => host.id === beforeHostId) : -1;
    const next = at >= 0
      ? [...without.slice(0, at), moved, ...without.slice(at)]
      : [...without, moved];
    set({ hosts: next });

    try {
      // The group first: `reorder_hosts` writes positions, and doing it the other way round would
      // leave a window where the row is in the right place under the wrong heading.
      if (changedGroup) await remoteUpdateHost(moved);
      await remoteReorderHosts(next.map((host) => host.id));
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  openSession: async (hostId) => {
    const host = hostOf(get().hosts, hostId);
    if (!host) return;
    try {
      const sessionId = await remoteOpenSession(hostId);
      const tab: RemoteSessionTab = {
        id: nextTabId(),
        kind: "session",
        hostId,
        name: host.name,
        sessionId,
        exited: false,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selectedHostId: hostId }));
      // Auto forwards came up with this session, on its own `ssh`. They are not in the live list,
      // but the ones already running for this host might have changed, and a stale count in the
      // status bar is the sort of thing nobody re-checks.
      void get().pollForwards();
    } catch (error) {
      pushErrorToast(`${translate("remote.sessionFailed", { name: host.name })}: ${String(error)}`);
    }
  },

  connectDraft: async (spec, name) => {
    // A draft session has no host row, so `hostId` is empty — which every consumer already
    // tolerates, because `hostOf` returns null for an unknown id and the tab renders from its own
    // `name`. The alternative, inventing a phantom row, would put an unsaved machine in the tree.
    const sessionId = await remoteOpenDraftSession(spec);
    const tab: RemoteSessionTab = {
      id: nextTabId(),
      kind: "session",
      hostId: "",
      name,
      sessionId,
      exited: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  },

  saveDraftAsHost: async (spec, name) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    try {
      const row = await remoteCreateHost(workspaceId, name, "", JSON.stringify(spec), "");
      set((s) => ({ hosts: [...s.hosts, row], selectedHostId: row.id }));
      return row;
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      return null;
    }
  },

  markExited: (sessionId) =>
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.kind === "session" && tab.sessionId === sessionId ? { ...tab, exited: true } : tab,
      ),
    })),

  openForwards: (hostId) => {
    const host = hostOf(get().hosts, hostId);
    if (!host) return;
    // One forwards tab per host: it is a view of that host's list, so a second one would be the
    // same list twice and the two would disagree the moment one of them opened something.
    const existing = get().tabs.find((tab) => tab.kind === "forwards" && tab.hostId === hostId);
    if (existing) {
      set({ activeTabId: existing.id, selectedHostId: hostId });
      return;
    }
    const tab: RemoteForwardsTab = { id: nextTabId(), kind: "forwards", hostId, name: host.name };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selectedHostId: hostId }));
  },

  openAllForwards: () => {
    const existing = get().tabs.find((tab) => tab.kind === "all-forwards");
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: RemoteAllForwardsTab = {
      id: nextTabId(),
      kind: "all-forwards",
      hostId: "",
      name: translate("remote.allForwards"),
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    void get().pollForwards();
  },

  openLog: () => {
    const existing = get().tabs.find((tab) => tab.kind === "log");
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: RemoteLogTab = {
      id: nextTabId(),
      kind: "log",
      hostId: "",
      name: translate("remote.log"),
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  },

  openSftp: (hostId) => {
    const host = hostOf(get().hosts, hostId);
    if (!host) return;
    const existing = get().tabs.find((tab) => tab.kind === "sftp" && tab.hostId === hostId);
    if (existing) {
      set({ activeTabId: existing.id, selectedHostId: hostId });
      return;
    }
    const tab: RemoteSftpTab = { id: nextTabId(), kind: "sftp", hostId, name: host.name };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selectedHostId: hostId }));
  },

  openScreen: async (hostId) => {
    const host = hostOf(get().hosts, hostId);
    if (!host) return;
    const existing = get().tabs.find((tab) => tab.kind === "screen" && tab.hostId === hostId);
    const tabId = existing?.id ?? nextTabId();
    if (!existing) {
      const tab: RemoteScreenTab = {
        id: tabId,
        kind: "screen",
        hostId,
        name: host.name,
        launch: null,
        opening: true,
        error: null,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selectedHostId: hostId }));
    } else {
      set((s) => ({
        activeTabId: tabId,
        selectedHostId: hostId,
        tabs: s.tabs.map((tab) =>
          tab.id === tabId && tab.kind === "screen"
            ? { ...tab, opening: true, error: null }
            : tab,
        ),
      }));
    }

    try {
      const launch = await remoteOpenScreen(hostId);
      set((s) => ({
        tabs: s.tabs.map((tab) =>
          tab.id === tabId && tab.kind === "screen"
            ? { ...tab, launch, opening: false, error: null }
            : tab,
        ),
      }));
      void get().pollForwards();
    } catch (error) {
      set((s) => ({
        tabs: s.tabs.map((tab) =>
          tab.id === tabId && tab.kind === "screen"
            ? { ...tab, opening: false, error: String(error) }
            : tab,
        ),
      }));
    }
  },

  closeTab: async (tabId) => {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    if (!tab) return;
    if (tab.kind === "session") await closeTerminal(tab.sessionId).catch(() => {});
    // The tunnel, not the viewer: that window is the user's, and closing it out from under them
    // would be a surprise rather than a cleanup.
    if (tab.kind === "screen") await remoteCloseScreen(tab.hostId).catch(() => {});
    if (tab.kind === "sftp") await remoteCloseFiles(tab.hostId).catch(() => {});
    set((s) => {
      const tabs = s.tabs.filter((entry) => entry.id !== tabId);
      const activeTabId =
        s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    });
    if (tab.kind === "screen") void get().pollForwards();
  },

  setActiveTab: (activeTabId) =>
    set((s) => ({
      activeTabId,
      selectedHostId: s.tabs.find((tab) => tab.id === activeTabId)?.hostId || s.selectedHostId,
    })),

  // -------------------------------------------------------------------------
  // Forwards
  // -------------------------------------------------------------------------

  pollForwards: async () => {
    // The latency probe rides the same tick rather than getting a timer of its own: they answer
    // one question between them — "is this working right now" — and two intervals would mean the
    // status bar's two halves disagreed about when "now" was.
    const selected = get().selectedHostId;
    if (selected) {
      void remotePing(selected)
        .then((latency) => {
          // Guarded: the answer can arrive after the user has moved on, and writing it then would
          // label one host with another's number.
          if (get().selectedHostId === selected) set({ latency });
        })
        .catch(() => {});
    } else if (get().latency !== null) {
      set({ latency: null });
    }

    try {
      set({ forwards: await remoteListForwards() });
    } catch {
      // A failed poll is not worth a toast: the next one is four seconds away, and the list it
      // would be reporting on is advisory.
    }
  },

  startForward: async (hostId, forward) => {
    try {
      const active = await remoteOpenForward(hostId, forward);
      set((s) => ({ forwards: [...s.forwards.filter((f) => f.id !== active.id), active] }));
      // Only worth announcing when the port isn't the one that was asked for — which is exactly
      // when the user needs to be told, because they cannot have guessed it.
      if (forward.listen_port === 0) {
        useToastStore
          .getState()
          .pushToast(
            translate("remote.forwardOpenedOn", { port: String(active.listen_port) }),
            "success",
          );
      }
    } catch (error) {
      pushErrorToast(`${translate("remote.forwardFailed")}: ${String(error)}`);
    }
  },

  stopForward: async (id) => {
    try {
      await remoteCloseForward(id);
    } finally {
      set((s) => ({ forwards: s.forwards.filter((forward) => forward.id !== id) }));
    }
  },

  // -------------------------------------------------------------------------
  // Snippets
  // -------------------------------------------------------------------------

  createSnippet: async (name, body) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    try {
      const snippet = await remoteCreateSnippet(workspaceId, name, body);
      set((s) => ({ snippets: [...s.snippets, snippet] }));
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
    }
  },

  saveSnippet: async (snippet) => {
    set((s) => ({ snippets: s.snippets.map((entry) => (entry.id === snippet.id ? snippet : entry)) }));
    try {
      await remoteUpdateSnippet(snippet);
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  deleteSnippet: async (id) => {
    try {
      await remoteDeleteSnippet(id);
      set((s) => ({ snippets: s.snippets.filter((snippet) => snippet.id !== id) }));
    } catch (error) {
      pushErrorToast(`${translate("remote.deleteFailed")}: ${String(error)}`);
    }
  },

  recordCommand: (sessionId, line) => {
    if (looksSecret(line)) return;
    const { tabs, hosts, workspaceId } = get();
    const tab = tabs.find((entry) => entry.kind === "session" && entry.sessionId === sessionId);
    if (!tab) return;
    const hostName = hosts.find((host) => host.id === tab.hostId)?.name ?? tab.name;

    set((s) => {
      // Deduped against the most recent entry only, not the whole list: running the same command
      // twenty minutes apart is worth two entries, running it twice in a row is not.
      if (s.history[0]?.body === line && s.history[0]?.hostId === tab.hostId) return s;
      const entry: RemoteHistoryEntry = {
        // Timestamp plus a counter: two commands submitted in the same millisecond are rare but
        // possible (a pasted block), and a duplicate key would make React reuse the wrong row.
        id: `h-${Date.now()}-${historySeq++}`,
        hostId: tab.hostId,
        hostName,
        body: line,
      };
      const history = [entry, ...s.history].slice(0, HISTORY_LIMIT);
      if (workspaceId) queueHistorySave(workspaceId, history);
      return { ...s, history };
    });
  },

  clearHistory: () => {
    const workspaceId = get().workspaceId;
    set({ history: [] });
    if (workspaceId) queueHistorySave(workspaceId, []);
  },

  runSnippet: async (body) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((entry) => entry.id === activeTabId);
    if (!tab || tab.kind !== "session" || tab.exited) {
      pushErrorToast(translate("remote.snippetNeedsSession"));
      return;
    }
    // `\r`, not `\n`: a pty is a terminal, and what a terminal receives when Enter is pressed is a
    // carriage return. Sending `\n` types a literal newline into the line editor on some shells
    // instead of submitting the line.
    await writeTerminal(tab.sessionId, `${body.replace(/\r?\n/g, "\r")}\r`);
  },
}));

/**
 * The history write, debounced.
 *
 * It lands in one settings row, and a command is recorded on every Enter — writing through each
 * time would mean a database round trip per keystroke-that-happened-to-be-Return. Two seconds is
 * far below the interval at which anyone closes the app deliberately.
 */
let historySaveTimer: number | null = null;
function queueHistorySave(workspaceId: string, history: RemoteHistoryEntry[]): void {
  if (historySaveTimer !== null) window.clearTimeout(historySaveTimer);
  historySaveTimer = window.setTimeout(() => {
    historySaveTimer = null;
    void saveSetting(historyKey(workspaceId), JSON.stringify(history));
  }, 2000);
}

/** Never throws: a corrupt blob costs the history, not the workspace. */
function parseHistory(raw: string | null): RemoteHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RemoteHistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

async function loadSetting(key: string): Promise<string | null> {
  const { getSetting } = await import("../lib/tauri/commands");
  return getSetting(key).catch(() => null);
}

async function saveSetting(key: string, value: string): Promise<void> {
  const { setSetting } = await import("../lib/tauri/commands");
  await setSetting(key, value).catch(() => {});
}

async function loadCollapsed(workspaceId: string): Promise<string[]> {
  const { getSetting } = await import("../lib/tauri/commands");
  try {
    const raw = await getSetting(collapsedKey(workspaceId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

async function saveCollapsed(workspaceId: string, groups: string[]): Promise<void> {
  const { setSetting } = await import("../lib/tauri/commands");
  await setSetting(collapsedKey(workspaceId), JSON.stringify(groups)).catch(() => {});
}

/** Closes every forward a host owns — what "Disconnect" on a host row does, alongside closing its
 *  session tabs. Exported rather than a store action because the confirm dialog calls it from
 *  outside React. */
export async function disconnectHost(hostId: string): Promise<void> {
  const store = useRemoteStore.getState();
  for (const tab of store.tabs.filter((tab) => tab.hostId === hostId)) {
    await store.closeTab(tab.id);
  }
  await remoteCloseHostForwards(hostId).catch(() => {});
  await remoteCloseFiles(hostId).catch(() => {});
  await store.pollForwards();
}
