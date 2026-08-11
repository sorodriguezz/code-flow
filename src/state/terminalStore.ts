import { create } from "zustand";
import { closeTerminal, getSetting, openTerminal, setSetting } from "../lib/tauri/commands";
import { onTerminalExit, onTerminalOutput } from "../lib/tauri/events";

export interface TerminalTab {
  id: string;
  /** The profile's name (`zsh`, `Git Bash`, …) until the user renames it — so a dock holding
   * several shells says which is which, the way VS Code's terminal tabs do. Deliberately *not*
   * persisted anywhere: a title describes a live shell, so it's meaningless once that shell is
   * gone. It therefore lives exactly as long as this store does — until the tab is closed or the
   * app exits. */
  title: string;
}

interface ProjectTerminals {
  tabs: TerminalTab[];
  /** Each entry is a "split group" — terminal ids shown side by side together. A terminal
   * belongs to exactly one group. Only the group containing `focusedId` is ever shown in the
   * dock, so switching to any terminal in a split reveals the whole split, VS Code–style,
   * instead of collapsing it down to just that one pane. */
  groups: string[][];
  focusedId: string | null;
  nextNumber: number;
}

function emptyProject(): ProjectTerminals {
  return { tabs: [], groups: [], focusedId: null, nextNumber: 1 };
}

/** The group currently shown in the dock: whichever one contains `focusedId`, falling back to
 * the most recently created group if that id is stale (e.g. right after its terminal closed). */
export function activeGroup(proj: ProjectTerminals | undefined): string[] {
  if (!proj) return [];
  const found = proj.focusedId ? proj.groups.find((g) => g.includes(proj.focusedId!)) : undefined;
  return found ?? proj.groups[proj.groups.length - 1] ?? [];
}

const PANEL_OPEN_KEY = "terminal_panel_open";

interface TerminalState {
  /** Hidden by default — only opens when the user asks for it (or a new terminal is created). */
  panelOpen: boolean;
  byProject: Record<string, ProjectTerminals>;
  init: () => Promise<void>;
  togglePanel: () => void;
  /** With `split: true`, adds the new terminal to whichever group is currently active instead
   * of starting a new one — otherwise every new terminal gets its own group. `profileId` picks
   * the shell; omitted, the backend resolves the configured default. */
  openNew: (projectId: string, cwd: string, opts?: { split?: boolean; profileId?: string }) => Promise<void>;
  close: (projectId: string, id: string) => Promise<void>;
  /** Shows the group `id` belongs to — never changes group membership by itself. */
  focus: (projectId: string, id: string) => void;
  /** Retitles a tab. A blank/whitespace-only title is ignored rather than blanking the tab,
   * so cancelling out of the inline editor with an empty field is harmless. */
  rename: (projectId: string, id: string, title: string) => void;
}

/** What a mounted `TerminalPane` hands the router: where to put this session's bytes, and what
 * to do when its shell ends. */
export interface TerminalSink {
  write: (data: string) => void;
  exit: () => void;
}

/**
 * `terminal:output` / `terminal:exit`, routed once for the whole app.
 *
 * Every terminal ever opened stays mounted (see the note in `TerminalDock`), and each pane used
 * to hold its own `terminal:output` subscription that compared `e.id` against its own session id
 * and threw away everything else. A dozen shells open across a few projects therefore meant a
 * dozen closure calls and a dozen string compares for *every* pty chunk, most of them on behalf
 * of panes the user cannot even see. This does the lookup once, in a `Map`.
 *
 * Order is preserved for free: Tauri delivers to this one listener in order, and the sink is
 * called synchronously from inside it — no queue, no batching, no reordering.
 */
const sinks = new Map<string, TerminalSink>();

/**
 * Output that arrived before this session's *first* pane existed.
 *
 * Only ever the first: once a pane has registered, a session that goes back to having none is
 * treated exactly as it always was — the chunks are dropped. That is deliberate, not laziness.
 * The agent bench replays a transcript **the backend records for itself** whenever a pane mounts,
 * so holding output across an unmount would hand that pane the same bytes twice, once from the
 * transcript and once from here. The gap worth closing is the one at the very start, where no
 * transcript covers it either.
 */
interface PendingOutput {
  chunks: string[];
  bytes: number;
  exited: boolean;
}
const pending = new Map<string, PendingOutput>();
/** Sessions that have had a pane at some point, and so are past the window `pending` covers. */
const introduced = new Set<string>();

/**
 * Safety valve, not a scrollback. It only bounds the one case `pending` exists for: a session
 * that is spawned and then, for whatever reason, never gets a pane. Half a megabyte is several
 * times what xterm's 1000-line scrollback can hold, so anything evicted here had already scrolled
 * out of reach of the pane that would eventually receive it.
 */
const PENDING_LIMIT_BYTES = 512 * 1024;

/** The buffer for a session still waiting on its first pane, or `null` once it has had one. */
function holdForLater(id: string): PendingOutput | null {
  if (introduced.has(id)) return null;
  let held = pending.get(id);
  if (!held) {
    held = { chunks: [], bytes: 0, exited: false };
    pending.set(id, held);
  }
  return held;
}

let routerStarted = false;

/**
 * Attaches the app's single pair of terminal listeners. Idempotent, and deliberately never torn
 * down: it has to already be listening *before* the first session exists, because the per-pane
 * listeners it replaces were attached after an `await listen(...)` — anything the shell printed
 * between `open_terminal` returning and that promise resolving was simply lost. Buffering here
 * closes that window instead of reopening it.
 */
export function startTerminalRouter(): void {
  if (routerStarted) return;
  routerStarted = true;
  void onTerminalOutput((e) => {
    const sink = sinks.get(e.id);
    if (sink) {
      sink.write(e.data);
      return;
    }
    const held = holdForLater(e.id);
    if (!held) return;
    held.chunks.push(e.data);
    held.bytes += e.data.length;
    while (held.bytes > PENDING_LIMIT_BYTES && held.chunks.length > 1) {
      held.bytes -= held.chunks.shift()!.length;
    }
  });
  void onTerminalExit((e) => {
    const sink = sinks.get(e.id);
    if (sink) sink.exit();
    else {
      const held = holdForLater(e.id);
      if (held) held.exited = true;
    }
  });
}

/**
 * Points this session's output at a pane. Returns the unregister function.
 *
 * On a session's *first* pane, whatever the shell printed before the pane existed is flushed
 * synchronously and in order before this returns, so it starts where the shell actually is
 * rather than a prompt short. See `pending` for why it is only the first.
 */
export function registerTerminalSink(id: string, sink: TerminalSink): () => void {
  startTerminalRouter();
  sinks.set(id, sink);
  const held = pending.get(id);
  introduced.add(id);
  if (held) {
    pending.delete(id);
    for (const chunk of held.chunks) sink.write(chunk);
    if (held.exited) sink.exit();
  }
  return () => {
    // Identity-checked, so a pane that remounts before the old one's cleanup runs (React 19's
    // double-invoked effects in dev, a `sessionId` swap) cannot unregister the live sink.
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}

/** Drops the router's bookkeeping for a session that is gone for good, so closing a tab does not
 * leave its last chunks parked in the map forever. */
function forgetTerminal(id: string): void {
  pending.delete(id);
  introduced.delete(id);
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  panelOpen: false,
  byProject: {},

  init: async () => {
    // At app start, so the router is live well before any pane asks for one.
    startTerminalRouter();
    const raw = await getSetting(PANEL_OPEN_KEY).catch(() => null);
    set({ panelOpen: raw === "1" });
  },

  togglePanel: () => {
    const next = !get().panelOpen;
    set({ panelOpen: next });
    void setSetting(PANEL_OPEN_KEY, next ? "1" : "0");
  },

  openNew: async (projectId, cwd, opts) => {
    // Before the await, not after: the shell can print its first prompt while `open_terminal` is
    // still returning, and that chunk has to land in the router's buffer rather than on the floor.
    startTerminalRouter();
    const { id, profile_name } = await openTerminal(cwd, opts?.profileId);
    set((s) => {
      const proj = s.byProject[projectId] ?? emptyProject();
      // The shell's own name is the useful label; `Terminal N` remains the fallback for a
      // profile that somehow reports none, so a tab is never nameless.
      const title = profile_name.trim() || `Terminal ${proj.nextNumber}`;
      const tabs = [...proj.tabs, { id, title }];
      const current = activeGroup(proj);
      const groups =
        opts?.split && current.length > 0
          ? proj.groups.map((g) => (g === current ? [...g, id] : g))
          : [...proj.groups, [id]];
      return {
        panelOpen: true,
        byProject: { ...s.byProject, [projectId]: { tabs, groups, focusedId: id, nextNumber: proj.nextNumber + 1 } },
      };
    });
    void setSetting(PANEL_OPEN_KEY, "1");
  },

  close: async (projectId, id) => {
    await closeTerminal(id).catch(() => {});
    forgetTerminal(id);
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const closedGroup = proj.groups.find((g) => g.includes(id));
      const tabs = proj.tabs.filter((tab) => tab.id !== id);
      const groups = proj.groups.map((g) => g.filter((gid) => gid !== id)).filter((g) => g.length > 0);

      let focusedId = proj.focusedId;
      if (focusedId === id) {
        // Prefer staying in the same split if other panes remain in it, otherwise fall back
        // to whatever group is now last.
        const remainingSiblings = closedGroup?.filter((gid) => gid !== id) ?? [];
        focusedId = remainingSiblings[0] ?? groups[groups.length - 1]?.[0] ?? null;
      }

      return { byProject: { ...s.byProject, [projectId]: { ...proj, tabs, groups, focusedId } } };
    });
  },

  focus: (projectId, id) => {
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...proj, focusedId: id } } };
    });
  },

  rename: (projectId, id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const tabs = proj.tabs.map((tab) => (tab.id === id ? { ...tab, title: trimmed } : tab));
      return { byProject: { ...s.byProject, [projectId]: { ...proj, tabs } } };
    });
  },
}));
