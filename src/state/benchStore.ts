import { create } from "zustand";
import {
  addBenchTab,
  addWorkspaceTerminal,
  clearWorkspaceTerminals,
  listWorkspaceTerminals,
  removeBenchTab,
  removeWorkspaceTerminal,
  renameBenchTab,
  renameWorkspaceTerminal,
  resumeWorkspaceTerminal,
  setBenchLayout,
} from "../lib/tauri/commands";
import {
  paneIds,
  parseLayout,
  reconcile,
  removePane,
  serializeLayout,
  setRatio,
  splitPane,
  type PaneNode,
} from "../lib/bench/layout";
import type { BenchTab, BenchTerminal } from "../types/domain";

/**
 * The agent console's terminal bench: tabs, and a tiled arrangement of shells inside each.
 *
 * **What it is.** A workspace-scoped set of shells the user opens by hand, to drive whatever CLI
 * they like from inside the app. Not the repository dock: that one belongs to a working copy, its
 * cwd is the repo, and clicking a different repository takes it away. These belong to the workspace
 * the way the agent roster does.
 *
 * **Tabs and panes both**, which is what a terminal emulator settles on and for the reason they all
 * settle on it: tiling alone does not scale — six shells tiled are six unreadable slivers — and tabs
 * alone cannot show you the build and the server it is restarting at the same time. Tabs hold the
 * set at no cost in screen; panes give the two or three you are watching room to be watched.
 *
 * **Closing is not stopping, and that is the whole design.** The panel's × puts the bench away and
 * touches nothing else: the shells keep running, keep printing, and keep being recorded. The list on
 * the left keeps a row per terminal so backgrounded work is visible from the outside rather than
 * being something you have to remember. Killing is separate and confirmed.
 *
 * **Two lifetimes, deliberately kept apart.** The rows live in SQLite and survive everything; the
 * ptys live in the backend process and die with it. `session_id` is where they meet, and it is
 * `null` far more often than it looks — after a restart, for every terminal on the bench. Opening a
 * pane with no session replays its stored output and starts a fresh shell underneath, so a restarted
 * bench reads as the same one continued rather than as a set of empty new panes.
 *
 * Which is why nothing here caches across workspaces, and why `show` re-reads rather than trusting
 * its own copy: the live half changes while nobody is looking.
 */
interface BenchState {
  /** The panel is on screen. Closing it leaves every shell running. */
  open: boolean;
  workspaceId: string | null;
  tabs: BenchTab[];
  terminals: BenchTerminal[];
  activeTabId: string | null;
  /** The pane the toolbar's split and close act on, per tab. */
  focusedPane: Record<string, string>;
  /**
   * The tab whose name is being edited in place, if any.
   *
   * In the store rather than inside the tab component because two surfaces start it and neither can
   * reach the other: the tab's own right-click menu is portalled to `document.body`, and the list in
   * the left panel is a different component entirely. Both set this; the panel's tab strip is the
   * one that renders the input.
   */
  renamingTabId: string | null;
  /** Reconciled pane trees, per tab — never the raw stored string. See `lib/bench/layout`. */
  layouts: Record<string, PaneNode | null>;
  loading: boolean;
  /** Opens the panel and reloads. `focus` lands on a named terminal — what the tree's rows pass. */
  show: (workspaceId: string, focus?: string) => Promise<void>;
  /** Puts the panel away. The shells are untouched. */
  hide: () => void;
  /** Re-reads without touching `open` — what the list on the left is drawn from, and what `show`
   *  delegates to. `focus` names a terminal to land on, dragging its tab into view with it. */
  refresh: (workspaceId: string, focus?: string) => Promise<void>;
  /** A new tab with one shell in it. */
  addTab: (workspaceId: string, cwd: string, profileId?: string) => Promise<void>;
  /** Splits the focused pane of `tabId` and starts a shell in the half that opens. */
  split: (workspaceId: string, tabId: string, cwd: string, dir: "row" | "col", profileId?: string) => Promise<void>;
  /** Closes one pane: its shell is killed and its row forgotten. Closes the tab with the last one. */
  closePane: (tabId: string, terminalId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  selectTab: (tabId: string) => void;
  focusPane: (tabId: string, terminalId: string) => void;
  /** Commits a dragged divider. `path` addresses the split inside the tab's tree. */
  resize: (tabId: string, path: string, ratio: number) => void;
  renameTab: (tabId: string, title: string) => Promise<void>;
  /** Opens the inline editor on a tab. From the left panel this is paired with `show`, because
   *  editing a label on a screen the tab is not on is editing something nobody can see. */
  startRenameTab: (tabId: string | null) => void;
  renameTerminal: (id: string, title: string) => Promise<void>;
  /** Starts a shell for a pane that has none. */
  resume: (id: string) => Promise<void>;
  /** Empties the bench. Irreversible; the caller is expected to have confirmed. */
  clear: (workspaceId: string) => Promise<void>;
}

/**
 * What a tab is called: the user's name if they gave it one, otherwise its first shell.
 *
 * Shared by the tab strip and the list on the left rather than written twice, because the two are
 * showing the same tab and a tab that answers to two names is a tab you cannot follow between them.
 *
 * **The name and nothing else.** It used to carry a `+N` for the other shells in the tab, and that
 * was one fact told twice in the same row: the list beside it already draws the count as a badge,
 * and in the strip the panes it would be counting are on screen underneath. A name that grows a
 * suffix every time you split is also a name that stops being recognisable — which is the one job
 * it has.
 *
 * `fallback` covers the moment a tab exists with nothing in it yet, which the store closes almost
 * immediately but can still be rendered during.
 */
export function benchTabLabel(tab: BenchTab, terminals: BenchTerminal[], fallback: string): string {
  if (tab.title.trim()) return tab.title;
  return terminals.find((terminal) => terminal.tab_id === tab.id)?.title ?? fallback;
}

/** The shells filed under one tab. */
export const terminalsOfTab = (terminals: BenchTerminal[], tabId: string): BenchTerminal[] =>
  terminals.filter((terminal) => terminal.tab_id === tabId);

/** Rebuilds every tab's tree from what was stored and what actually exists. Both halves of the
 *  reconciliation matter — see `lib/bench/layout`. */
function layoutsFor(tabs: BenchTab[], terminals: BenchTerminal[]): Record<string, PaneNode | null> {
  const out: Record<string, PaneNode | null> = {};
  for (const tab of tabs) {
    const mine = terminals.filter((terminal) => terminal.tab_id === tab.id).map((terminal) => terminal.id);
    out[tab.id] = reconcile(parseLayout(tab.layout), mine);
  }
  return out;
}

/** Keeps a selection on something that exists: the requested one, else the current if it survived,
 *  else the first. */
function settle(ids: string[], wanted: string | null, current: string | null): string | null {
  if (wanted && ids.includes(wanted)) return wanted;
  if (current && ids.includes(current)) return current;
  return ids[0] ?? null;
}

/** Writes a tab's tree back. Fire-and-forget: the arrangement is already on screen, and a failed
 *  write costs the *next* launch its layout, not this one its panes. */
function persist(tabId: string, node: PaneNode | null): void {
  void setBenchLayout(tabId, serializeLayout(node)).catch(() => {});
}

export const useBenchStore = create<BenchState>((set, get) => ({
  open: false,
  workspaceId: null,
  tabs: [],
  terminals: [],
  activeTabId: null,
  focusedPane: {},
  renamingTabId: null,
  layouts: {},
  loading: false,

  show: async (workspaceId, focus) => {
    // `open` before the load, not after: the panel has an empty state of its own and a spinner in
    // it reads as "opening", where a click that does nothing for half a second reads as one that
    // missed.
    //
    // `loading` is what the panel holds its *first* set of panes back on, which is not cosmetic —
    // see `TerminalBench`. Every later read leaves them where they are.
    set({ open: true, loading: true });
    await get().refresh(workspaceId, focus);
    set({ loading: false });
  },

  hide: () => set({ open: false }),

  refresh: async (workspaceId, focus?: string) => {
    // Whether this read is a *move* or a re-read of where we already are, decided before anything
    // is committed.
    const crossing = get().workspaceId !== workspaceId;
    // The workspace is committed *now*, ahead of its own data, rather than arriving with it. Two
    // switches in quick succession leave two of these reads in flight, and publishing the id
    // together with the rows means whichever one lands last wins both: the bench then looks
    // perfectly consistent — one workspace's id over its own tabs — while being the workspace the
    // user left. Committing first turns that into a check the loser fails.
    //
    // A move takes the outgoing bench with it in the same breath, rather than leaving it on screen
    // under the incoming workspace's id until the read lands — the shells keep running, this only
    // stops them being *listed* as this workspace's. Doing it here rather than in the failure branch
    // below is what keeps a failed read from being destructive: two reads of the same workspace can
    // be in flight at once (the view's own on `workspaceId`, and `show`'s), and a failure branch
    // that emptied the bench would throw away rows its sibling had just published successfully.
    set(
      crossing
        ? {
            workspaceId,
            tabs: [],
            terminals: [],
            layouts: {},
            activeTabId: null,
            focusedPane: {},
            // The inline editor was open on a tab that is not in this workspace. Left set, it would
            // reopen on whichever tab of the incoming bench happened to take that id back.
            renamingTabId: null,
          }
        : { workspaceId },
    );
    const bench = await listWorkspaceTerminals(workspaceId).catch(() => null);
    if (get().workspaceId !== workspaceId) return;
    if (!bench) {
      // Nothing to publish, and nothing of anybody else's left in place to take down: what is on
      // screen is either this workspace's own last good read or the empty bench cleared above.
      set({ loading: false });
      return;
    }
    const { tabs, terminals } = bench;
    const layouts = layoutsFor(tabs, terminals);
    // A named terminal drags its tab into view with it — the click that named it came from a list
    // that says nothing about tabs, so landing on the right tab is this function's job.
    const wantedTab = focus ? (terminals.find((terminal) => terminal.id === focus)?.tab_id ?? null) : null;
    set((s) => {
      // Re-checked inside the updater and not only above it: `layoutsFor` and the `settle` calls
      // run between the two, and a switch that happens in that gap would still be overwritten here.
      if (s.workspaceId !== workspaceId) return s;
      const activeTabId = settle(
        tabs.map((tab) => tab.id),
        wantedTab,
        s.activeTabId,
      );
      const focusedPane = { ...s.focusedPane };
      for (const tab of tabs) {
        focusedPane[tab.id] = settle(paneIds(layouts[tab.id]), tab.id === wantedTab ? (focus ?? null) : null, focusedPane[tab.id] ?? null) ?? "";
      }
      return { workspaceId, tabs, terminals, layouts, activeTabId, focusedPane };
    });
  },

  addTab: async (workspaceId, cwd, profileId) => {
    const tab = await addBenchTab(workspaceId);
    const created = await addWorkspaceTerminal(workspaceId, tab.id, cwd, profileId);
    const node = { kind: "leaf" as const, id: created.id };
    persist(tab.id, node);
    set((s) => {
      // Two round trips have happened since the click, and a workspace switch inside them is
      // ordinary. Publishing anyway did two wrong things at once: it appended this workspace's tab
      // to the bench of the workspace now on screen, and — worse — it wrote *this* workspace's id
      // back over it. `refresh` now refuses to publish a read whose workspace has moved on, so that
      // stale id had no way of being corrected: the incoming workspace's own load failed the check
      // and its bench stayed empty for good. The shell itself is running either way; it is listed
      // the next time this workspace is opened, which is where it belongs.
      if (s.workspaceId !== workspaceId) return s;
      return {
        tabs: [...s.tabs, tab],
        terminals: [...s.terminals, created],
        layouts: { ...s.layouts, [tab.id]: node },
        activeTabId: tab.id,
        focusedPane: { ...s.focusedPane, [tab.id]: created.id },
      };
    });
  },

  split: async (workspaceId, tabId, cwd, dir, profileId) => {
    const target = get().focusedPane[tabId];
    const current = get().layouts[tabId];
    if (!target || !current) return;
    const created = await addWorkspaceTerminal(workspaceId, tabId, cwd, profileId);
    const node = splitPane(current, target, created.id, dir);
    persist(tabId, node);
    set((s) => {
      // The same guard `addTab` carries, for the same round trip. A pane split into a tab that
      // belongs to the workspace the user has just left would be drawn into whichever tab of the
      // incoming bench happened to inherit that id.
      if (s.workspaceId !== workspaceId) return s;
      return {
        terminals: [...s.terminals, created],
        layouts: { ...s.layouts, [tabId]: node },
        // Focus follows the new pane. You split in order to use the thing you just made.
        focusedPane: { ...s.focusedPane, [tabId]: created.id },
      };
    });
  },

  closePane: async (tabId, terminalId) => {
    const current = get().layouts[tabId];
    const next = current ? removePane(current, terminalId) : null;
    // The last pane takes its tab with it. A tab with no panes is not a state anything can draw,
    // and leaving one behind would be an empty tab the user has to close a second time.
    if (!next) {
      await get().closeTab(tabId);
      return;
    }
    await removeWorkspaceTerminal(terminalId);
    persist(tabId, next);
    set((s) => ({
      terminals: s.terminals.filter((terminal) => terminal.id !== terminalId),
      layouts: { ...s.layouts, [tabId]: next },
      focusedPane: { ...s.focusedPane, [tabId]: settle(paneIds(next), null, null) ?? "" },
    }));
  },

  closeTab: async (tabId) => {
    await removeBenchTab(tabId);
    set((s) => {
      const tabs = s.tabs.filter((tab) => tab.id !== tabId);
      const { [tabId]: _dropped, ...layouts } = s.layouts;
      const { [tabId]: _alsoDropped, ...focusedPane } = s.focusedPane;
      return {
        tabs,
        layouts,
        focusedPane,
        terminals: s.terminals.filter((terminal) => terminal.tab_id !== tabId),
        activeTabId: settle(tabs.map((tab) => tab.id), null, s.activeTabId === tabId ? null : s.activeTabId),
        // Emptying the bench closes it: there is nothing left on the panel to do.
        open: tabs.length > 0 && s.open,
      };
    });
  },

  selectTab: (tabId) => set({ activeTabId: tabId }),

  focusPane: (tabId, terminalId) =>
    set((s) => ({ focusedPane: { ...s.focusedPane, [tabId]: terminalId } })),

  resize: (tabId, path, ratio) => {
    const current = get().layouts[tabId];
    if (!current) return;
    const node = setRatio(current, path, ratio);
    persist(tabId, node);
    set((s) => ({ layouts: { ...s.layouts, [tabId]: node } }));
  },

  renameTab: async (tabId, title) => {
    set({ renamingTabId: null });
    const trimmed = title.trim();
    // A blank is "leave it alone", which is also what cancelling sends — so there is one way out of
    // the editor rather than two, and neither can blank a tab's name.
    if (!trimmed) return;
    await renameBenchTab(tabId, trimmed);
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: trimmed } : tab)) }));
  },

  startRenameTab: (tabId) => set({ renamingTabId: tabId }),

  renameTerminal: async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await renameWorkspaceTerminal(id, trimmed);
    set((s) => ({
      terminals: s.terminals.map((terminal) => (terminal.id === id ? { ...terminal, title: trimmed } : terminal)),
    }));
  },

  resume: async (id) => {
    const sessionId = await resumeWorkspaceTerminal(id);
    set((s) => ({
      terminals: s.terminals.map((terminal) =>
        terminal.id === id ? { ...terminal, session_id: sessionId } : terminal,
      ),
    }));
  },

  clear: async (workspaceId) => {
    await clearWorkspaceTerminals(workspaceId);
    set({ tabs: [], terminals: [], layouts: {}, focusedPane: {}, activeTabId: null, open: false });
  },
}));
