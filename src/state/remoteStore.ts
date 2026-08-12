import { create } from "zustand";
import {
  remoteCheckCloud,
  remoteCloseForward,
  remoteCloseFiles,
  remoteCloseScreen,
  remoteCreateGroup,
  remoteDisconnectHost,
  remoteHostHolds,
  remoteCreateHost,
  remoteCreateSnippet,
  remoteDeleteGroup,
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
  serviceOfKind,
  type ActiveForward,
  type AzureService,
  type ForwardSpec,
  type RemoteGroupRow,
  type RemoteHostRow,
  type RemoteHostSpec,
  type HostHold,
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
 *    / disconnected state to model *for a shell*: a session exists while its process does. That is
 *    not true of everything else a host holds — see point 4.
 *
 * 2. **`forwards` is polled, not derived.** It is the backend's list of live `ssh -N` children, and
 *    the interesting change — one dying because the network dropped — produces no event. A forward
 *    in a host's `spec` is a saved *intention*; a forward in this array is a listening port.
 *
 * 3. **Auto forwards never appear in `forwards`.** They ride on the session's own `ssh` (see
 *    `remotes::session`), so they live and die with the terminal. That is the point of marking one
 *    auto, and it is why the forwards panel shows them as "with the session" rather than as rows
 *    that could be closed on their own.
 *
 * 4. **A shell is not the only thing a host holds.** A file session is an `ssh -s … sftp` child kept
 *    alive per host until something closes it (`remotes::sftp`), an FTP row holds a logged-in control
 *    socket, and a screen's tunnel and its loopback bridge route outlive the viewer window. None of
 *    those is a tab and none of them produces an event, so `holds` is polled beside `forwards` and is
 *    what "this host has something to disconnect" means. A cloud account is the one kind that never
 *    appears in it: it holds nothing between requests, on purpose.
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

/**
 * Which page of the host editor to land on.
 *
 * It lives here rather than in the panel's own state because the caller is what knows: creating a
 * VNC host from the "New connection" menu should open on Screen, not on Connection with the one
 * field that matters two clicks away.
 */
export type RemoteDetailsTab = "connection" | "forwards" | "screen" | "advanced";

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

/**
 * A whole Azure Storage account: blob containers, file shares, queues and tables in one tab.
 *
 * **One tab per account, not per service**, which is the point of the kind — an account is one name
 * and one key, and having to open four tabs to see what is in it was the reason four separate host
 * rows felt wrong. `service` is which of the four pages is showing; it moves with the rail and with
 * whatever menu entry opened the tab, and it is on the tab rather than in the panel so that
 * right-clicking a host and picking "Queues" lands on Queues in a tab that was already open.
 */
export interface RemoteAzureTab {
  id: string;
  kind: "azure";
  hostId: string;
  name: string;
  service: AzureService;
}

/** The connection log. Belongs to no host, like the global forwards tab. */
export interface RemoteLogTab {
  id: string;
  kind: "log";
  hostId: string;
  name: string;
}

/** What one reachability check found. `checking` is its own state rather than an absent entry: the
 *  button has to say "connecting" while it waits, and an absent entry means "never asked". */
export interface CloudStatus {
  checking: boolean;
  ok: boolean;
  /** How many containers or buckets were at the root. Meaningful only when `ok`. */
  count: number;
  /** The service's own sentence when it failed. Empty when it worked. */
  error: string;
  /** Epoch milliseconds of the answer — "worked at 14:02", not "works". */
  at: number;
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
  | RemoteAzureTab
  | RemoteLogTab;

interface RemoteState {
  workspaceId: string | null;
  loading: boolean;
  hosts: RemoteHostRow[];
  /** Folder rows. Not the membership — that is still each host's `group_name`. These exist so a
   *  group the user made and hasn't filled yet survives a reload; see `RemoteGroupRow`. */
  groups: RemoteGroupRow[];
  snippets: RemoteSnippet[];
  forwards: ActiveForward[];
  /**
   * What the backend says each host is holding open, by host id. Absent means holding nothing.
   *
   * **Polled, like `forwards`, and for the same reason** — an `ssh` that died pushes nothing. Kept as
   * a map rather than the array the command returns because every host row reads its own entry, and a
   * `find` per row per tick is the shape that gets slower as the estate grows.
   */
  holds: Record<string, HostHold>;
  /**
   * Host ids whose disconnect is in flight.
   *
   * A *third* state rather than a shade of the other two, for the reason `dbStore.connecting` gives: a
   * release closes a pooled SFTP channel, kills two or three `ssh` children and waits on a socket that
   * may be mid-transfer, all of which are slower than the click. Without it the row held its old dot
   * for the whole round trip and then flipped, so the only reading available was that the click had
   * not registered.
   */
  disconnecting: string[];
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
  /**
   * What the last reachability check said about each cloud account, by host id.
   *
   * **Cloud rows have no session, so nothing else could ever say "connected".** A shell is live
   * while its process is; a forward is live while its port listens. A storage account is signed
   * HTTPS with nothing held open between requests — so the only honest statement is "this
   * credential worked at this moment", which is what this records. It lights the dot on the row and
   * it is what the editor reports under its Connect button.
   *
   * Session state, not persisted: a key that worked yesterday says nothing about a key that may
   * have been rotated since, and a green dot restored from disk would be a claim nobody checked.
   */
  cloudStatus: Record<string, CloudStatus>;
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
  /** Which page of that panel to show, or `null` to leave it on Connection. Cleared by every
   *  `openDetails` that doesn't ask for one, so a tab requested once doesn't stick to the next
   *  host. */
  detailsTab: RemoteDetailsTab | null;
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
  openDetails: (id: string, tab?: RemoteDetailsTab) => void;
  closeDetails: () => void;
  selectHost: (id: string | null) => void;

  /** `spec` is what a host is created *as* — the "New connection" menu passes an SSH, an FTP or a
   *  VNC-shaped one. Omitted, it is `defaultHostSpec()`. */
  createHost: (
    name: string,
    groupName: string,
    spec?: RemoteHostSpec,
  ) => Promise<RemoteHostRow | null>;
  saveHost: (row: RemoteHostRow, spec: RemoteHostSpec) => Promise<boolean>;
  renameHost: (id: string, name: string) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;
  duplicateHost: (id: string) => Promise<RemoteHostRow | null>;
  reorderHosts: (ids: string[]) => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  renameGroup: (from: string, to: string) => Promise<void>;
  /** Deletes the folder. Its hosts move to ungrouped — never deleted with it. */
  deleteGroup: (name: string) => Promise<void>;
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
  /**
   * Opens an Azure Storage account, on one of its four services.
   *
   * One tab per account. Called again with a different service, it moves the tab that is already
   * open rather than adding a second — the services are pages of one account, and two tabs showing
   * one account would be two things to keep in step.
   */
  openAzure: (hostId: string, service?: AzureService) => void;
  /**
   * Asks a cloud account whether it answers, and records what it said.
   *
   * Returns whether it worked, so the editor's Connect button can hold off opening a panel that
   * would only show the same failure in smaller type.
   */
  checkCloud: (hostId: string) => Promise<boolean>;
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

/**
 * Bumped by every deliberate release, so a poll that left before it cannot put back what it saw.
 *
 * `pollForwards` replaces `forwards` and `holds` wholesale with what the backend said a round trip
 * ago, and it is the only writer that does. Without this, a tick that overlapped the click is how a
 * host the user just disconnected comes back looking connected for four seconds — and a host drawn as
 * holding nothing is a host whose Disconnect entry is not in the menu, so the drift would hide the one
 * command that would fix it.
 */
let holdsEpoch = 0;

export function ensureRemoteStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useRemoteStore.getState().setWorkspace(workspaceId);
}

/** A copy of `map` without `hostId`. Written out because three call sites need it and a mutation in
 *  place would be a store write nothing re-rendered against. */
function withoutHost<T>(map: Record<string, T>, hostId: string): Record<string, T> {
  if (!(hostId in map)) return map;
  const next = { ...map };
  delete next[hostId];
  return next;
}

/** The host a tab belongs to, or `null` if it has been deleted underneath the tab. */
export function hostOf(hosts: RemoteHostRow[], hostId: string): RemoteHostRow | null {
  return hosts.find((host) => host.id === hostId) ?? null;
}

/** Hosts by group, in the order the tree draws them: ungrouped first, then groups alphabetically.
 *
 * Ungrouped first rather than last because it is where a newly created host lands, and a user who
 * has just pressed "New host" should not have to scroll past their whole estate to find it. */
export function groupHosts(
  hosts: RemoteHostRow[],
  folders: RemoteGroupRow[] = [],
): [string, RemoteHostRow[]][] {
  const groups = new Map<string, RemoteHostRow[]>();
  // The folder rows go in first, so a group the user created and hasn't filled still gets a
  // heading — the whole reason those rows exist. A group named by a host but with no row of its
  // own (an import, a drag onto a new name) is added by the loop below and reads identically.
  for (const folder of folders) groups.set(folder.name.trim(), []);
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
  // The account name too, because a cloud row has no `host` — searching an estate for
  // "sadesaintersystemsiris" would otherwise match nothing at all.
  return [
    host.name,
    host.group_name,
    spec.host,
    spec.user,
    spec.azure.account,
    spec.s3.profile,
    spec.notes,
    ...spec.tags,
  ]
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
  groups: [],
  snippets: [],
  forwards: [],
  holds: {},
  disconnecting: [],
  collapsedGroups: [],
  query: "",
  tagFilter: [],
  hostView: "grid",
  history: [],
  latency: null,
  tabs: [],
  activeTabId: null,
  cloudStatus: {},
  renamingHostId: null,
  selectedHostId: null,
  detailsHostId: null,
  detailsTab: null,

  setWorkspace: async (workspaceId) => {
    if (pendingLoad?.workspaceId === workspaceId) return pendingLoad.promise;
    if (get().workspaceId === workspaceId && !get().loading) return;

    // Every session belongs to the workspace being left. Killing them is the honest move: they are
    // processes, not documents, and leaving them running behind a workspace switch means `ssh`
    // children nothing on screen names.
    for (const tab of get().tabs) {
      if (tab.kind === "session") void closeTerminal(tab.sessionId).catch(() => {});
    }
    // And whatever the outgoing workspace's hosts are holding without a tab to show it — a file
    // session, a forward, a screen's bridge route. Per host rather than a single release-everything:
    // the backend's registries carry no workspace id, so releasing all of them would kill forwards the
    // *incoming* workspace's hosts may own. The tab loop above used to be the whole teardown, which
    // left three leaks behind every switch: forwards were never closed, an `azure` tab's file session
    // was skipped, and a host holding a file session with no tab open was never touched at all.
    for (const hostId of Object.keys(get().holds)) {
      void remoteDisconnectHost(hostId).catch(() => {});
    }

    // Cleared rather than left to be overwritten: for the length of the load the view would
    // otherwise still show the workspace the user just left.
    set({
      workspaceId,
      loading: true,
      hosts: [],
      groups: [],
      snippets: [],
      forwards: [],
      holds: {},
      disconnecting: [],
      tabs: [],
      activeTabId: null,
      query: "",
      tagFilter: [],
      // Another workspace's accounts are other accounts; carrying their green dots across would be
      // claiming something was checked that never was.
      cloudStatus: {},
      renamingHostId: null,
      selectedHostId: null,
      detailsHostId: null,
      detailsTab: null,
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
          groups: tree.groups,
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
      set({ hosts: tree.hosts, groups: tree.groups, snippets: tree.snippets });
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
  openDetails: (id, tab) => set({ detailsHostId: id, selectedHostId: id, detailsTab: tab ?? null }),

  closeDetails: () => set({ detailsHostId: null, detailsTab: null }),

  // The old number goes the moment the host does — a stale latency under a new name is worse
  // than none, because it looks measured.
  selectHost: (selectedHostId) => set({ selectedHostId, latency: null }),

  createHost: async (name, groupName, hostSpec) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    try {
      const spec = JSON.stringify(hostSpec ?? defaultHostSpec());
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
    // Everything it holds goes first, not just its tabs: a session tab pointing at a host that no
    // longer exists has nothing to render a title from and its `ssh` would outlive everything naming
    // it — and a file session or a bridge token keyed by an id no row names is worse still, because
    // no command left in the app can reach it.
    await disconnectHost(id);
    try {
      await remoteDeleteHost(id);
      set((s) => ({
        hosts: s.hosts.filter((host) => host.id !== id),
        detailsHostId: s.detailsHostId === id ? null : s.detailsHostId,
        holds: withoutHost(s.holds, id),
        cloudStatus: withoutHost(s.cloudStatus, id),
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

  createGroup: async (name) => {
    const workspaceId = get().workspaceId;
    const trimmed = name.trim();
    // The ungrouped bucket is the absence of a group, not a group called "". Creating it would put
    // a folder in the tree that every host without one already falls into.
    if (!workspaceId || !trimmed) return;
    try {
      const row = await remoteCreateGroup(workspaceId, trimmed);
      // Written from the reply rather than optimistically: the backend deduplicates by name, so
      // "New group" on a name that already exists must add nothing rather than a second row.
      set((s) => ({
        groups: s.groups.some((group) => group.name === row.name) ? s.groups : [...s.groups, row],
      }));
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  renameGroup: async (from, to) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId || from === to || !to.trim()) return;
    const target = to.trim();
    set((s) => ({
      hosts: s.hosts.map((host) =>
        host.group_name === from ? { ...host, group_name: target } : host,
      ),
      // Renaming onto an existing name merges, so the folder rows have to collapse the same way —
      // otherwise the tree would briefly show the target twice.
      groups: s.groups
        .map((group) => (group.name === from ? { ...group, name: target } : group))
        .filter(
          (group, index, all) => all.findIndex((other) => other.name === group.name) === index,
        ),
      collapsedGroups: [
        ...new Set(s.collapsedGroups.map((name) => (name === from ? target : name))),
      ],
    }));
    try {
      await remoteRenameGroup(workspaceId, from, target);
    } catch (error) {
      pushErrorToast(`${translate("remote.saveFailed")}: ${String(error)}`);
      void get().refresh();
    }
  },

  deleteGroup: async (name) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId || name === UNGROUPED) return;
    set((s) => ({
      // The hosts stay; they lose the folder, not their existence.
      hosts: s.hosts.map((host) =>
        host.group_name === name ? { ...host, group_name: UNGROUPED } : host,
      ),
      groups: s.groups.filter((group) => group.name !== name),
      collapsedGroups: s.collapsedGroups.filter((entry) => entry !== name),
    }));
    try {
      await remoteDeleteGroup(workspaceId, name);
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

  checkCloud: async (hostId) => {
    set((s) => ({
      cloudStatus: {
        ...s.cloudStatus,
        [hostId]: { checking: true, ok: false, count: 0, error: "", at: Date.now() },
      },
    }));
    try {
      const count = await remoteCheckCloud(hostId);
      set((s) => ({
        cloudStatus: {
          ...s.cloudStatus,
          [hostId]: { checking: false, ok: true, count, error: "", at: Date.now() },
        },
      }));
      return true;
    } catch (error) {
      // Kept on the row rather than thrown as a toast: a rejected key is a fact about *this
      // account* that the user is about to go and fix, and a toast is gone by the time they look
      // back at the field. The log has it too — see `remote_check_cloud`.
      set((s) => ({
        cloudStatus: {
          ...s.cloudStatus,
          [hostId]: { checking: false, ok: false, count: 0, error: String(error), at: Date.now() },
        },
      }));
      return false;
    }
  },

  openAzure: (hostId, service) => {
    const host = hostOf(get().hosts, hostId);
    if (!host) return;
    // A legacy single-service row opens where it used to — an `azure_queue` host lands on Queues —
    // and an account row with nothing asked for opens on Blob, which is what an account usually is.
    const wanted = service ?? serviceOfKind(parseHostSpec(host).kind);
    const existing = get().tabs.find((tab) => tab.kind === "azure" && tab.hostId === hostId);
    if (existing) {
      set((s) => ({
        activeTabId: existing.id,
        selectedHostId: hostId,
        tabs: s.tabs.map((tab) =>
          tab.id === existing.id && tab.kind === "azure" ? { ...tab, service: wanted } : tab,
        ),
      }));
      return;
    }
    const tab: RemoteAzureTab = {
      id: nextTabId(),
      kind: "azure",
      hostId,
      name: host.name,
      service: wanted,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selectedHostId: hostId }));
    // Only on the first open, and only when nobody has asked yet: the editor's Connect button runs
    // its own check before calling this, and the panel is about to make the same listing request.
    if (!get().cloudStatus[hostId]) void get().checkCloud(hostId);
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
    if (tab.kind === "sftp" || tab.kind === "azure")
      await remoteCloseFiles(tab.hostId).catch(() => {});
    set((s) => {
      const tabs = s.tabs.filter((entry) => entry.id !== tabId);
      const activeTabId =
        s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
      // Closing the last tab a host owns retracts its cloud claim, so the row's dot goes hollow.
      //
      // A cloud account has no session to end — the dot is lit by `cloudStatus`, which records that
      // the credential answered at some moment — and leaving that claim behind meant closing the
      // account's tab left a row still drawn as connected, with nothing anywhere that could turn it
      // off. The X is the gesture people reach for, so it is the one that has to mean it.
      const cloudStatus = tabs.some((entry) => entry.hostId === tab.hostId)
        ? s.cloudStatus
        : withoutHost(s.cloudStatus, tab.hostId);
      return { tabs, activeTabId, cloudStatus };
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

    const epoch = holdsEpoch;
    try {
      // Two calls on one tick rather than one command returning both: the forwards list is read by
      // two panels and needs `listen_port`, the holds map is read by every row and needs none of
      // that, and both are a lock and some arithmetic in the backend. Fusing them would make the
      // panels' data shape depend on what the dots want.
      const [forwards, holds] = await Promise.all([remoteListForwards(), remoteHostHolds()]);
      // Dropped rather than merged: what arrived describes the registries as they were *before* the
      // user's own release, and merging it is how a host they just disconnected reappears connected.
      if (epoch !== holdsEpoch) return;
      set({ forwards, holds: Object.fromEntries(holds.map((hold) => [hold.host_id, hold])) });
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

/**
 * Lets go of everything one host is holding — what "Disconnect" on a host row does.
 *
 * Its tabs, then the backend's side of it in one call: forwards, the screen's tunnel and bridge
 * route, and the file session. It used to close only forwards and files, which is why a host with a
 * screen open kept a loopback route to the far machine alive after being "disconnected".
 *
 * Exported rather than a store action because the menu calls it from outside React.
 */
export async function disconnectHost(hostId: string): Promise<void> {
  const store = useRemoteStore.getState();
  // Read before any await, so two clicks landing in the same frame cannot both get past it. The menu
  // entry is disabled too — this is the guard for the gesture that reached the store anyway.
  if (store.disconnecting.includes(hostId)) return;
  useRemoteStore.setState((s) => ({
    disconnecting: s.disconnecting.includes(hostId) ? s.disconnecting : [...s.disconnecting, hostId],
  }));
  try {
    // Tabs first, and every one of them including a session whose pty already exited: `exited` says
    // the far side hung up, not that this machine let go — the registry entry and its pty master are
    // held until `closeTerminal`.
    for (const tab of store.tabs.filter((tab) => tab.hostId === hostId)) {
      await store.closeTab(tab.id);
    }
    holdsEpoch += 1;
    await remoteDisconnectHost(hostId).catch(() => {});
    // Dropped here rather than waited for on the next tick: the row's dot and its menu entry both read
    // `holds`, and four seconds of a host still drawn as connected after the click is the drift this
    // whole thing exists to remove. `cloudStatus` goes with it — a green dot meaning "this credential
    // answered at 14:02" must not survive a deliberate disconnect.
    useRemoteStore.setState((s) => ({
      holds: withoutHost(s.holds, hostId),
      cloudStatus: withoutHost(s.cloudStatus, hostId),
    }));
    await store.pollForwards();
  } finally {
    // Cleared in `finally`, so a release that threw stops looking busy rather than spinning until the
    // next click.
    useRemoteStore.setState((s) => ({
      disconnecting: s.disconnecting.filter((id) => id !== hostId),
    }));
  }
}

/**
 * What a host's dot draws, and whether its menu may offer a disconnect — in one place.
 *
 * Three copies of this rule lived in the tree row and both gallery layouts, and they had already
 * drifted from the context menu's own idea of "live": a host with a file browser open was drawn idle
 * by all three and offered a disconnect by none.
 *
 * Three selectors returning primitives, never one returning an object — a selector that builds a
 * fresh object re-renders on every write, and the tick that writes `holds` comes every four seconds.
 */
export function useHostLiveness(hostId: string): { session: boolean; active: boolean; busy: boolean } {
  // A shell that is running, or — for an account, which has no process — a credential that answered.
  const session = useRemoteStore(
    (s) =>
      s.tabs.some((tab) => tab.kind === "session" && tab.hostId === hostId && !tab.exited) ||
      (s.cloudStatus[hostId]?.ok ?? false),
  );
  // Something of this host's is held without a shell being live: a tunnel, a file session, a screen —
  // or a session whose pty exited, which still holds its registry entry and its pty master.
  const active = useRemoteStore((s) => {
    const hold = s.holds[hostId];
    return (
      (hold?.forwards ?? 0) > 0 ||
      (hold?.files ?? false) ||
      (hold?.screen ?? false) ||
      // Any tab of this host's, which for a file browser is true before the first listing has opened
      // a session behind it — the panel is on screen, so the row should say so.
      s.tabs.some((tab) => tab.hostId === hostId)
    );
  });
  const busy = useRemoteStore((s) => s.disconnecting.includes(hostId));
  return { session, active, busy };
}

/**
 * Whether a host has anything at all that `disconnectHost` would release. The menu's test, and the
 * one the old `live` got wrong by only ever looking at session tabs and forwards.
 *
 * **A tab of any kind counts, and so does a cloud account's claim.** Those are the two cases that made
 * the menu contradict the row: a storage account holds no session, so it had no entry — but its dot is
 * lit by `cloudStatus`, and a lit dot nothing can turn off is worse than a verb that is loose about
 * what it closes. For an account, Disconnect closes its panel and retracts the claim; there was never
 * a socket to drop, which is why the file-session release it also calls is a no-op there.
 */
export function hostIsHolding(
  hostId: string,
  tabs: RemoteTab[],
  holds: Record<string, HostHold>,
  cloudStatus: Record<string, CloudStatus> = {},
): boolean {
  const hold = holds[hostId];
  return (
    tabs.some((tab) => tab.hostId === hostId) ||
    (cloudStatus[hostId]?.ok ?? false) ||
    (hold?.files ?? false) ||
    (hold?.forwards ?? 0) > 0 ||
    (hold?.screen ?? false)
  );
}
