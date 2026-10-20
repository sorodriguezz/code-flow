import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { listWorktrees } from "../lib/tauri/gitCommands";
import { watchSettings } from "../lib/settingsSync";
import { DEFAULT_LANE, LANES, type LaneId, type RailGrouping, type RepoRef, type WorktreeListing } from "../lib/agents/worktreeRows";
import { pathKey } from "../lib/agents/terminalTask";
import type { AgentTask } from "../types/domain";

/**
 * The «Worktrees» layout of the agent console — see `lib/agents/worktreeRows` for what it shows.
 *
 * Everything here is view state over data that lives elsewhere: the tasks are `agentsStore`'s, the
 * shells are `benchStore`'s, the diffs are `taskReviewStore`'s. What this adds is only what the
 * layout itself has to remember:
 *
 * - which layout the console is in, and whether the right side shows one worktree or the grid;
 * - the open row when it has no task (a task row's selection *is* `agentsStore.selectedId`, so the
 *   two layouts never disagree about which task is open);
 * - per task, whether its agent is talked to as a chat or run as its own CLI in a terminal, and
 *   which bench terminal that CLI lives in;
 * - how many turns of each task the user has seen, for the unread mark;
 * - where each working copy is filed on the rail — its status, whether it is pinned, the name it was
 *   given when it was made — by folder (`pathKey`), and how the rail is grouped and folded.
 *
 * One settings row for all of it, written on change: it is a few short maps, and splitting it
 * would mean five reads at startup for one view.
 */

export type ConsoleLayout = "tasks" | "worktrees";
export type WorktreeDisplay = "one" | "grid";
export type AgentMode = "chat" | "cli";

const SETTING = "agents_worktree_view";

interface Persisted {
  layout: ConsoleLayout;
  display: WorktreeDisplay;
  agentMode: Record<string, AgentMode>;
  /** Bench terminal id by row key (`task:<id>` or `path:<path>`). */
  cliTerminal: Record<string, string>;
  seenTurns: Record<string, number>;
  /** The working copy's file tree on the right, as Orca keeps it. */
  filesOpen: boolean;
  /** Status by folder (`pathKey`). Absent is `DEFAULT_LANE`. */
  lanes: Record<string, LaneId>;
  /** Pinned folders, in the order they were pinned. */
  pinned: string[];
  /** The name a working copy was given when «Nuevo espacio» made it, by folder. */
  names: Record<string, string>;
  grouping: RailGrouping;
  /** Folded section ids (`pinned`, `lane:<id>`, `project:<id>`). */
  folded: string[];
  /** The one repository the rail shows, or `""` for all. */
  repoFilter: string;
  /** Every working copy on the rail, not only the ones with a task — see `isListed`. */
  showAll: boolean;
}

const DEFAULTS: Persisted = {
  // The new layout is the default: it is what the console is for when several agents run at once,
  // and the task list is one click away in the same switch.
  layout: "worktrees",
  display: "one",
  agentMode: {},
  cliTerminal: {},
  seenTurns: {},
  filesOpen: true,
  lanes: {},
  pinned: [],
  names: {},
  grouping: "status",
  folded: [],
  repoFilter: "",
  showAll: false,
};

function strings(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

function parse(raw: string | null): Persisted {
  if (!raw) return DEFAULTS;
  try {
    const value = JSON.parse(raw) as Partial<Persisted>;
    const record = <T>(input: unknown, keep: (v: unknown) => v is T): Record<string, T> => {
      if (!input || typeof input !== "object") return {};
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => keep(v))) as Record<string, T>;
    };
    return {
      layout: value.layout === "tasks" ? "tasks" : "worktrees",
      display: value.display === "grid" ? "grid" : "one",
      agentMode: record(value.agentMode, (v): v is AgentMode => v === "chat" || v === "cli"),
      cliTerminal: record(value.cliTerminal, (v): v is string => typeof v === "string" && v !== ""),
      seenTurns: record(value.seenTurns, (v): v is number => typeof v === "number" && Number.isFinite(v)),
      filesOpen: value.filesOpen !== false,
      lanes: record(value.lanes, (v): v is LaneId => (LANES as readonly unknown[]).includes(v)),
      pinned: strings(value.pinned),
      names: record(value.names, (v): v is string => typeof v === "string" && v.trim() !== ""),
      grouping: value.grouping === "project" ? "project" : "status",
      folded: strings(value.folded),
      repoFilter: typeof value.repoFilter === "string" ? value.repoFilter : "",
      showAll: value.showAll === true,
    };
  } catch {
    // A row written by a newer build, or corrupt: the view starts fresh rather than not at all.
    return DEFAULTS;
  }
}

interface WorktreeViewState extends Persisted {
  loaded: boolean;
  /** The open row when it has no task, by key. `null` when a task (or nothing) is open. */
  selectedKey: string | null;
  /** The race the grid shows, or `null` for every row with an agent in it. */
  gridRace: string | null;
  /** `list_worktrees` per repository, by project id. Absent until read. */
  listings: Record<string, WorktreeListing[]>;
  /** A tab the open working copy should bring up — an agent's terminal or its chat — asked for by a
   *  click on a card's line. Taken (and cleared) by the workspace once it has shown it. */
  focusRequest: { rowKey: string; target: { kind: "terminal"; sessionId: string } | { kind: "task"; taskId: string } } | null;

  load: () => Promise<void>;
  setLayout: (layout: ConsoleLayout) => void;
  setDisplay: (display: WorktreeDisplay, race?: string | null) => void;
  selectKey: (key: string | null) => void;
  setAgentMode: (taskId: string, mode: AgentMode) => void;
  toggleFiles: () => void;
  setCliTerminal: (rowKey: string, terminalId: string | null) => void;
  /** Files a working copy under a status — the default one is stored as nothing. */
  setLane: (path: string, lane: LaneId) => void;
  togglePin: (path: string) => void;
  setName: (path: string, name: string) => void;
  setGrouping: (grouping: RailGrouping) => void;
  toggleFold: (sectionId: string) => void;
  setRepoFilter: (projectId: string) => void;
  toggleShowAll: () => void;
  requestFocus: (request: WorktreeViewState["focusRequest"]) => void;
  /** Reads every repository's worktrees. Each one on its own: a repository whose folder is gone
   *  fails alone and keeps whatever it last listed. */
  refreshListings: (repos: readonly RepoRef[]) => Promise<void>;
  /**
   * Records what has been seen: every task not yet recorded at its current count (so the marks
   * start from now, not from the first turn ever run), and the open task at its count.
   */
  observe: (tasks: readonly AgentTask[], openTaskId: string | null) => void;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function persist(state: Persisted): void {
  if (writeTimer) clearTimeout(writeTimer);
  // Debounced: `observe` runs on every task-list change, and a turn moves the list several times.
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const { layout, display, agentMode, cliTerminal, seenTurns, filesOpen, lanes, pinned, names, grouping, folded, repoFilter, showAll } =
      state;
    void setSetting(
      SETTING,
      JSON.stringify({ layout, display, agentMode, cliTerminal, seenTurns, filesOpen, lanes, pinned, names, grouping, folded, repoFilter, showAll }),
    ).catch(() => undefined);
  }, 400);
}

export const useWorktreeViewStore = create<WorktreeViewState>((set, get) => {
  const update = (patch: Partial<Persisted>) => {
    set(patch);
    persist(get());
  };

  return {
    ...DEFAULTS,
    loaded: false,
    selectedKey: null,
    gridRace: null,
    listings: {},
    focusRequest: null,

    load: async () => {
      const raw = await getSetting(SETTING).catch(() => null);
      set({ ...parse(raw), loaded: true });
    },

    setLayout: (layout) => update({ layout }),

    setDisplay: (display, race = null) => {
      set({ gridRace: display === "grid" ? race : null });
      update({ display });
    },

    selectKey: (selectedKey) => set({ selectedKey }),

    setAgentMode: (taskId, mode) => update({ agentMode: { ...get().agentMode, [taskId]: mode } }),

    toggleFiles: () => update({ filesOpen: !get().filesOpen }),

    setCliTerminal: (rowKey, terminalId) => {
      const { [rowKey]: _old, ...rest } = get().cliTerminal;
      update({ cliTerminal: terminalId ? { ...rest, [rowKey]: terminalId } : rest });
    },

    setLane: (path, lane) => {
      const key = pathKey(path);
      if (key === "") return;
      const { [key]: _old, ...rest } = get().lanes;
      update({ lanes: lane === DEFAULT_LANE ? rest : { ...rest, [key]: lane } });
    },

    togglePin: (path) => {
      const key = pathKey(path);
      if (key === "") return;
      const pinned = get().pinned;
      update({ pinned: pinned.includes(key) ? pinned.filter((entry) => entry !== key) : [...pinned, key] });
    },

    setName: (path, name) => {
      const key = pathKey(path);
      if (key === "") return;
      const { [key]: _old, ...rest } = get().names;
      update({ names: name.trim() ? { ...rest, [key]: name.trim() } : rest });
    },

    setGrouping: (grouping) => update({ grouping }),

    toggleFold: (sectionId) => {
      const folded = get().folded;
      update({ folded: folded.includes(sectionId) ? folded.filter((id) => id !== sectionId) : [...folded, sectionId] });
    },

    setRepoFilter: (repoFilter) => update({ repoFilter }),

    toggleShowAll: () => update({ showAll: !get().showAll }),

    requestFocus: (focusRequest) => set({ focusRequest }),

    refreshListings: async (repos) => {
      await Promise.all(
        repos.map(async (repo) => {
          if (!repo.local_path) return;
          const listed = await listWorktrees(repo.local_path).catch(() => null);
          if (listed) set((s) => ({ listings: { ...s.listings, [repo.id]: listed } }));
        }),
      );
    },

    observe: (tasks, openTaskId) => {
      const seen = get().seenTurns;
      let next: Record<string, number> | null = null;
      for (const task of tasks) {
        const recorded = seen[task.id];
        const wanted = recorded === undefined || task.id === openTaskId ? task.turns : recorded;
        if (wanted !== recorded) {
          next ??= { ...seen };
          next[task.id] = wanted;
        }
      }
      if (next) update({ seenTurns: next });
    },
  };
});

// Another window changed the row (a satellite, the phone): read it again.
// Skipped while a write of our own is pending: the read would land between the change and its
// write, and put the old value back on screen for the length of the debounce.
watchSettings([SETTING], () => {
  if (writeTimer || !useWorktreeViewStore.getState().loaded) return;
  void useWorktreeViewStore.getState().load();
});
