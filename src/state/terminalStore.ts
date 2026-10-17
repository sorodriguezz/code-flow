import { create } from "zustand";
import { closeTerminal, getSetting, openTerminal, setSetting, writeTerminal } from "../lib/tauri/commands";
import { onTerminalExit, onTerminalOutput } from "../lib/tauri/events";
import { isMainWindow } from "../lib/windowIdentity";
import { translate } from "./languageStore";
import {
  addToGroup,
  detach,
  joinGroup,
  moveInList,
  newGroup,
  normalizeSizes,
  removeFromGroups,
  replaceId,
  type TerminalGroup,
} from "./terminalLayout";
import { parseSavedDock, replayText, snapshotProject, type SavedDock, type SavedProject } from "./terminalRestore";

export interface TerminalTab {
  id: string;
  /** The profile's name (`zsh`, `Git Bash`, …) until the user renames it — so a dock holding
   * several shells says which is which, the way VS Code's terminal tabs do. Deliberately *not*
   * persisted anywhere: a title describes a live shell, so it's meaningless once that shell is
   * gone. It therefore lives exactly as long as this store does — until the tab is closed or the
   * app exits. */
  title: string;
  /** Where the shell was started. The dock never draws it; it exists so that anything wanting to
   * *reuse* a terminal can tell which one is already standing in the right directory. Not
   * persisted, for the same reason the title isn't — it describes a live shell. */
  cwd: string;
  /** Set only on shells the app opened in order to run something specific — see `runCommand`.
   * Its absence is what protects the terminal the user is typing in: a reuse lookup can only ever
   * match a shell this store opened on purpose, never one somebody is halfway through a command
   * in. */
  reuseKey?: string;
  /** The profile the shell was started with, as the backend resolved it — what a restart and a
   *  restore open again. */
  profileId?: string;
  /** The folder the shell is in *now*, from the shell integration's `OSC 7` — absent for a shell
   *  without it. What the row shows, what "new terminal here" opens in, what a restore returns to. */
  liveCwd?: string;
  /** A colour token (`red`, `amber`…) and an icon name the user gave the tab. */
  color?: string;
  icon?: string;
  /** Output to print before the shell's own — a restored tab's old session. Read once, at mount. */
  replay?: string;
}

export interface ProjectTerminals {
  /** In the order the list draws them — the user can drag them into another. */
  tabs: TerminalTab[];
  /** Each entry is a split — terminals shown together. A terminal belongs to exactly one group.
   * Only the group containing `focusedId` is ever shown in the dock, so switching to any terminal
   * in a split reveals the whole split, VS Code–style, instead of collapsing it down to just that
   * one pane. See `terminalLayout`. */
  groups: TerminalGroup[];
  focusedId: string | null;
  nextNumber: number;
}

function emptyProject(): ProjectTerminals {
  return { tabs: [], groups: [], focusedId: null, nextNumber: 1 };
}

/** The group currently shown in the dock: whichever one contains `focusedId`, falling back to
 * the most recently created group if that id is stale (e.g. right after its terminal closed). */
export function activeGroupOf(proj: ProjectTerminals | undefined): TerminalGroup | null {
  if (!proj) return null;
  const found = proj.focusedId ? proj.groups.find((g) => g.ids.includes(proj.focusedId!)) : undefined;
  return found ?? proj.groups[proj.groups.length - 1] ?? null;
}

/** The ids of the group on screen — see `activeGroupOf`. */
export function activeGroup(proj: ProjectTerminals | undefined): string[] {
  return activeGroupOf(proj)?.ids ?? [];
}

const DOCK_VIEW_KEY = "terminal_dock_view";

/**
 * Which of its two panels the bottom dock shows in the main window: the terminals, or the services.
 *
 * They were one panel, services above and shells below, and the user had them split (2026-09-30)
 * to take load off it — each has its own button at the foot of the projects panel now. One dock
 * still holds both, showing one at a time, so going from a shell to the services and back never
 * unmounts the shells (see `ServicesDock`). A satellite has no services, so it only ever shows
 * `"terminal"` and never reads or writes the remembered value.
 */
export type DockView = "terminal" | "containers" | "services";

interface TerminalState {
  /** Hidden by default — only opens when the user asks for it (or a new terminal is created).
   *  Never restored at launch: it used to be (`terminal_panel_open`), and a dock last left on the
   *  services then greeted every start with the services console the user had not asked for
   *  (2026-10-09). Which panel it shows *is* remembered — see `dockView`. */
  panelOpen: boolean;
  /** What the dock shows while it is open. Remembered in the main window, so it reopens on the panel
   *  it was closed on. */
  dockView: DockView;
  byProject: Record<string, ProjectTerminals>;
  init: () => Promise<void>;
  /** The terminal's own toggle — ⌘J, the palette, a satellite. With the services on screen it shows
   *  the terminals rather than closing the dock: that key is about the terminal. */
  togglePanel: () => void;
  /** Each panel's button: shows `view`, or hides the dock when `view` is what it already shows. */
  toggleDock: (view: DockView) => void;
  /** Shows `view`, opening the dock if it is closed and never closing it — for whatever means
   *  "take me there": the running-services badge, a shell just opened. */
  showDock: (view: DockView) => void;
  /** Hides the dock, whichever panel it shows — its own chevron. */
  hidePanel: () => void;
  /** The dock taking the work column's height, the view above it down to its floor — for a manager
   *  page (Contenedores' tables) that wants the room. Not remembered: it is a moment's need. */
  dockMaximized: boolean;
  toggleDockMaximized: () => void;
  /** With `split: true`, adds the new terminal to whichever group is currently active instead
   * of starting a new one — otherwise every new terminal gets its own group. `profileId` picks
   * the shell; omitted, the backend resolves the configured default. */
  openNew: (
    projectId: string,
    cwd: string,
    opts?: {
      split?: boolean;
      /** Which way a new split runs: beside (`row`, the default) or below (`column`). Only read when
       *  the split it joins has a single pane — a split keeps the direction it was made with. */
      splitDir?: "row" | "column";
      profileId?: string;
      reuseKey?: string;
      title?: string;
      color?: string;
      icon?: string;
      replay?: string;
      /** Runs the shell as one AI account — see `lib/aiAccounts.ts`. */
      account?: { provider: string; accountId: string };
    },
  ) => Promise<string>;
  /**
   * Runs one line in the dock, reusing the terminal this same action opened for it last time.
   *
   * The unit of reuse is the caller's `reuseKey`, not the directory: two things run from the same
   * folder are still two things, and typing `build` into the shell where `dev` is still running
   * would send it to the dev server's stdin instead of to a prompt.
   */
  runCommand: (
    projectId: string,
    opts: { cwd: string; command: string; reuseKey: string; title: string },
  ) => Promise<void>;
  close: (projectId: string, id: string) => Promise<void>;
  /** Shows the group `id` belongs to — never changes group membership by itself. */
  focus: (projectId: string, id: string) => void;
  /** Retitles a tab. A blank/whitespace-only title is ignored rather than blanking the tab,
   * so cancelling out of the inline editor with an empty field is harmless. */
  rename: (projectId: string, id: string, title: string) => void;
  /** A fresh shell where this one stood: same place in the list and the split, same name, look,
   *  profile and folder. For a shell that exited or hung. */
  restart: (projectId: string, id: string) => Promise<void>;
  /** The tab moved to `index` in the list. */
  reorder: (projectId: string, id: string, index: number) => void;
  /** The tab taken out of its split, into one of its own. */
  detachTab: (projectId: string, id: string) => void;
  /** The tab moved into the split on screen. */
  joinActive: (projectId: string, id: string) => void;
  setGroupSizes: (projectId: string, groupId: string, sizes: number[]) => void;
  toggleBroadcast: (projectId: string, groupId: string) => void;
  /** A colour token and an icon name for the tab; `undefined` clears either. */
  setLook: (projectId: string, id: string, look: { color?: string; icon?: string }) => void;
  /** The folder a shell reports it is in (`OSC 7`). Looked up across every project — the pane only
   *  knows its session id. */
  setLiveCwd: (id: string, cwd: string) => void;
  /**
   * Types `text` into the terminal on screen for this repository and runs it — the editor's «Run
   * selection in terminal». Opens a shell in `cwd` when the repository has none. Never into a
   * terminal an action opened for itself (`reuseKey`): that one may be running a dev server.
   */
  sendText: (projectId: string, cwd: string, text: string) => Promise<void>;
  /**
   * Brings back the terminals this repository had when the app last closed, if any, and answers
   * whether it did. Main window only — see `terminalRestore`.
   */
  restore: (projectId: string, fallbackCwd: string) => Promise<boolean>;
}

/** What a mounted `TerminalPane` hands the router: where to put this session's bytes, and what
 * to do when its shell ends. `seq` is the chunk's number in its session, when the backend sent one. */
export interface TerminalSink {
  write: (data: string, seq?: number) => void;
  exit: () => void;
}

/**
 * `terminal:output` / `terminal:exit`, routed once for the whole app.
 *
 * Every terminal ever opened stays mounted (see the note in `ServicesDock`), and each pane used
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
  chunks: Array<{ data: string; seq?: number }>;
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
    outputSinceSave = true;
    if (sink) {
      sink.write(e.data, e.seq);
      return;
    }
    const held = holdForLater(e.id);
    if (!held) return;
    held.chunks.push({ data: e.data, seq: e.seq });
    held.bytes += e.data.length;
    while (held.bytes > PENDING_LIMIT_BYTES && held.chunks.length > 1) {
      held.bytes -= held.chunks.shift()!.data.length;
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
    for (const chunk of held.chunks) sink.write(chunk.data, chunk.seq);
    if (held.exited) sink.exit();
  }
  return () => {
    // Identity-checked, so a pane that remounts before the old one's cleanup runs (React 19's
    // double-invoked effects in dev, a `sessionId` swap) cannot unregister the live sink.
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}

/**
 * Tells the router that this session's history is kept somewhere else, so it must not hold the
 * session's output for a first pane.
 *
 * A service's output is recorded by the supervisor from the first byte (see `service_log`), and its
 * console replays that record when it mounts. Holding the same bytes here as well would be half a
 * megabyte per service nobody has looked at yet — and would hand the pane every early chunk twice.
 */
export function disownTerminalBacklog(id: string): void {
  introduced.add(id);
  pending.delete(id);
}

/** Drops the router's bookkeeping for a session that is gone for good, so closing a tab does not
 * leave its last chunks parked in the map forever. */
function forgetTerminal(id: string): void {
  pending.delete(id);
  introduced.delete(id);
  readers.delete(id);
}

/**
 * Readers of what each dock pane holds, as plain text — registered by the pane, read by the restore
 * snapshot. A pane that is gone has none, and its tab saves without output.
 */
const readers = new Map<string, () => string>();

export function registerTextReader(id: string, read: () => string): () => void {
  readers.set(id, read);
  return () => {
    if (readers.get(id) === read) readers.delete(id);
  };
}

/** What `id`'s pane holds, as plain text — `null` when no pane is mounted for it. */
export function readTerminalText(id: string): string | null {
  return readers.get(id)?.() ?? null;
}

const RESTORE_KEY = "terminal_dock_restore";
/** How often the dock's state is written while anything changed — at most this much is lost to a
 *  crash. A tab opened, closed, renamed or moved is written on the next tick too. */
const SAVE_EVERY_MS = 15_000;
let outputSinceSave = false;
let layoutSinceSave = false;
/** What was on disk at start, kept so the repositories not opened this session keep their entry. */
let savedAtStart: SavedDock | null = null;
let saveLoopStarted = false;

function startSaveLoop(): void {
  if (saveLoopStarted || !isMainWindow()) return;
  saveLoopStarted = true;
  window.setInterval(() => {
    if (!outputSinceSave && !layoutSinceSave) return;
    outputSinceSave = false;
    layoutSinceSave = false;
    void saveDock();
  }, SAVE_EVERY_MS);
}

async function saveDock(): Promise<void> {
  if (!savedAtStart) return;
  const projects: Record<string, SavedProject> = { ...savedAtStart.projects };
  for (const [projectId, proj] of Object.entries(useTerminalStore.getState().byProject)) {
    // Tabs a caller opened to run something (`reuseKey`) are that caller's, not the user's shells.
    const tabs = proj.tabs.filter((tab) => !tab.reuseKey);
    if (tabs.length === 0) {
      delete projects[projectId];
      continue;
    }
    const kept = new Set(tabs.map((tab) => tab.id));
    const groups = proj.groups
      .map((group) => ({ ...group, ids: group.ids.filter((id) => kept.has(id)) }))
      .map((group) => ({ ...group, sizes: normalizeSizes(group.sizes.length === group.ids.length ? group.sizes : [], group.ids.length) }));
    projects[projectId] = snapshotProject(tabs, groups, proj.focusedId, readTerminalText);
  }
  savedAtStart = { v: 1, projects };
  await setSetting(RESTORE_KEY, JSON.stringify(savedAtStart)).catch(() => {});
}

function markLayoutChanged(): void {
  layoutSinceSave = true;
}

/** Every project's terminals with one changed — `fn` given the project's (or an empty one). */
function patchProject(
  state: { byProject: Record<string, ProjectTerminals> },
  projectId: string,
  fn: (proj: ProjectTerminals) => ProjectTerminals,
): { byProject: Record<string, ProjectTerminals> } {
  markLayoutChanged();
  return { byProject: { ...state.byProject, [projectId]: fn(state.byProject[projectId] ?? emptyProject()) } };
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  panelOpen: false,
  dockView: "terminal",
  dockMaximized: false,
  toggleDockMaximized: () => set((s) => ({ dockMaximized: !s.dockMaximized })),
  byProject: {},

  init: async () => {
    // At app start, so the router is live well before any pane asks for one.
    startTerminalRouter();
    // The main window's alone: a satellite's dock is terminals only, and a remembered "services"
    // there would turn its ⌘J into "switch to terminals" instead of "close". Only the view comes
    // back — the dock itself starts hidden (see `panelOpen`).
    const view = isMainWindow() ? await getSetting(DOCK_VIEW_KEY).catch(() => null) : null;
    set({ dockView: view === "services" || view === "containers" ? view : "terminal" });
    if (isMainWindow()) {
      savedAtStart = parseSavedDock(await getSetting(RESTORE_KEY).catch(() => null));
      startSaveLoop();
    }
  },

  togglePanel: () => get().toggleDock("terminal"),

  toggleDock: (view) => {
    const { panelOpen, dockView } = get();
    if (panelOpen && dockView === view) get().hidePanel();
    else get().showDock(view);
  },

  showDock: (view) => {
    set({ panelOpen: true, dockView: view });
    if (isMainWindow()) void setSetting(DOCK_VIEW_KEY, view);
  },

  hidePanel: () => {
    set({ panelOpen: false, dockMaximized: false });
  },

  openNew: async (projectId, cwd, opts) => {
    // Before the await, not after: the shell can print its first prompt while `open_terminal` is
    // still returning, and that chunk has to land in the router's buffer rather than on the floor.
    startTerminalRouter();
    const { id, profile_id, profile_name } = await openTerminal(cwd, opts?.profileId, opts?.account);
    set((s) =>
      patchProject(s, projectId, (proj) => {
        // A caller that opened this shell *for* something says what it is for; otherwise the shell's
        // own name is the useful label, with `Terminal N` remaining the fallback for a profile that
        // somehow reports none, so a tab is never nameless.
        const title = opts?.title?.trim() || profile_name.trim() || `Terminal ${proj.nextNumber}`;
        const tab: TerminalTab = {
          id,
          title,
          cwd,
          reuseKey: opts?.reuseKey,
          profileId: profile_id,
          ...(opts?.color ? { color: opts.color } : {}),
          ...(opts?.icon ? { icon: opts.icon } : {}),
          ...(opts?.replay ? { replay: opts.replay } : {}),
        };
        const current = activeGroupOf(proj);
        const groups =
          opts?.split && current
            ? proj.groups.map((g) => (g.id === current.id ? addToGroup(g, id, opts.splitDir) : g))
            : [...proj.groups, newGroup([id])];
        return { tabs: [...proj.tabs, tab], groups, focusedId: id, nextNumber: proj.nextNumber + 1 };
      }),
    );
    // The terminals, whichever panel was up: a shell was just asked for, from the `+`, the
    // explorer's "Open in Integrated Terminal" or a script — and a dock left on the services would
    // put it out of sight the moment it opened.
    get().showDock("terminal");
    // Returned so a caller that has something to type can address the shell it just asked for,
    // rather than going back to the store and guessing which of the tabs is the new one.
    return id;
  },

  runCommand: async (projectId, { cwd, command, reuseKey, title }) => {
    // `\r`, not `\n`: a pty is a terminal, and what a terminal receives when Enter is pressed is a
    // carriage return — the same point `remoteStore.runSnippet` makes. `\n` types a literal
    // newline into the line editor on some shells instead of submitting the line.
    const line = `${command}\r`;
    const existing = get().byProject[projectId]?.tabs.find((tab) => tab.reuseKey === reuseKey);
    if (existing) {
      get().focus(projectId, existing.id);
      // `focus` only decides which group the dock *would* draw; it does not open the dock. Without
      // this, running a script while the panel is collapsed — or while it shows the services —
      // appears to do nothing at all.
      get().showDock("terminal");
      try {
        await writeTerminal(existing.id, line);
        return;
      } catch {
        // A rejected write is the signal that this shell is gone, not a failure worth showing.
        // `terminal.rs` removes a session from its registry the moment the child dies — precisely
        // so the next write answers "no such terminal session" instead of writing into a master fd
        // with nothing on the other end — so this is what a user typing `exit` looks like from
        // here. The dead tab is closed before opening its replacement: leaving it would put two
        // tabs in the dock carrying the same `reuseKey`, and the next run would find the corpse
        // again.
        await get().close(projectId, existing.id);
      }
    }
    const id = await get().openNew(projectId, cwd, { reuseKey, title });
    // Written immediately, with no wait for a prompt. `open_terminal` returns with the child
    // already spawned, so these bytes sit in the tty's input buffer exactly like anything typed
    // while a slow `.zshrc` is still running — the shell reads them once it starts reading.
    await writeTerminal(id, line);
  },

  close: async (projectId, id) => {
    await closeTerminal(id).catch(() => {});
    forgetTerminal(id);
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const closedGroup = proj.groups.find((g) => g.ids.includes(id));
      const tabs = proj.tabs.filter((tab) => tab.id !== id);
      const groups = removeFromGroups(proj.groups, id);

      let focusedId = proj.focusedId;
      if (focusedId === id) {
        // Prefer staying in the same split if other panes remain in it, otherwise fall back
        // to whatever group is now last.
        const remainingSiblings = closedGroup?.ids.filter((gid) => gid !== id) ?? [];
        focusedId = remainingSiblings[0] ?? groups[groups.length - 1]?.ids[0] ?? null;
      }

      return patchProject(s, projectId, () => ({ ...proj, tabs, groups, focusedId }));
    });
  },

  focus: (projectId, id) => {
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      return patchProject(s, projectId, () => ({ ...proj, focusedId: id }));
    });
  },

  rename: (projectId, id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const tabs = proj.tabs.map((tab) => (tab.id === id ? { ...tab, title: trimmed } : tab));
      return patchProject(s, projectId, () => ({ ...proj, tabs }));
    });
  },

  restart: async (projectId, id) => {
    const old = get().byProject[projectId]?.tabs.find((tab) => tab.id === id);
    if (!old) return;
    const where = old.liveCwd || old.cwd;
    const opened = await openTerminal(where, old.profileId).catch(() => openTerminal(old.cwd));
    await closeTerminal(id).catch(() => {});
    forgetTerminal(id);
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      // The replay was the *old* session's history; the new shell starts clean.
      const tabs = proj.tabs.map((tab) =>
        tab.id === id
          ? { ...tab, id: opened.id, profileId: opened.profile_id, cwd: where, liveCwd: undefined, replay: undefined }
          : tab,
      );
      const focusedId = proj.focusedId === id ? opened.id : proj.focusedId;
      return patchProject(s, projectId, () => ({ ...proj, tabs, groups: replaceId(proj.groups, id, opened.id), focusedId }));
    });
  },

  reorder: (projectId, id, index) =>
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      return patchProject(s, projectId, () => ({ ...proj, tabs: moveInList(proj.tabs, id, index) }));
    }),

  detachTab: (projectId, id) =>
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      return patchProject(s, projectId, () => ({ ...proj, groups: detach(proj.groups, id), focusedId: id }));
    }),

  joinActive: (projectId, id) =>
    set((s) => {
      const proj = s.byProject[projectId];
      const target = activeGroupOf(proj);
      if (!proj || !target || target.ids.includes(id)) return s;
      return patchProject(s, projectId, () => ({ ...proj, groups: joinGroup(proj.groups, id, target.id), focusedId: id }));
    }),

  setGroupSizes: (projectId, groupId, sizes) =>
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const groups = proj.groups.map((g) => (g.id === groupId ? { ...g, sizes: normalizeSizes(sizes, g.ids.length) } : g));
      return patchProject(s, projectId, () => ({ ...proj, groups }));
    }),

  toggleBroadcast: (projectId, groupId) =>
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const groups = proj.groups.map((g) => (g.id === groupId ? { ...g, broadcast: !g.broadcast && g.ids.length > 1 } : g));
      return patchProject(s, projectId, () => ({ ...proj, groups }));
    }),

  setLook: (projectId, id, look) =>
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const tabs = proj.tabs.map((tab) => (tab.id === id ? { ...tab, color: look.color, icon: look.icon } : tab));
      return patchProject(s, projectId, () => ({ ...proj, tabs }));
    }),

  setLiveCwd: (id, cwd) => {
    const entry = Object.entries(get().byProject).find(([, proj]) => proj.tabs.some((tab) => tab.id === id));
    if (!entry) return;
    const [projectId, proj] = entry;
    if (proj.tabs.find((tab) => tab.id === id)?.liveCwd === cwd) return;
    set((s) =>
      patchProject(s, projectId, (current) => ({
        ...current,
        tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, liveCwd: cwd } : tab)),
      })),
    );
  },

  sendText: async (projectId, cwd, text) => {
    const proj = get().byProject[projectId];
    const mine = (id: string | null | undefined) => proj?.tabs.find((tab) => tab.id === id && !tab.reuseKey);
    const target = mine(proj?.focusedId) ?? proj?.tabs.find((tab) => !tab.reuseKey);
    const id = target?.id ?? (await get().openNew(projectId, cwd));
    if (target) get().focus(projectId, target.id);
    get().showDock("terminal");
    // A line at a time, each ended with the carriage return Enter sends; blank lines dropped so a
    // trailing newline in the selection does not submit an empty command.
    const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
    if (lines.length > 0) await writeTerminal(id, `${lines.join("\r")}\r`);
  },

  restore: async (projectId, fallbackCwd) => {
    const saved = savedAtStart?.projects[projectId];
    if (!saved || saved.tabs.length === 0 || (get().byProject[projectId]?.tabs.length ?? 0) > 0) return false;
    const label = translate("terminal.restored");
    const ids: (string | null)[] = [];
    for (const tab of saved.tabs) {
      const opts = { title: tab.title, color: tab.color, icon: tab.icon, replay: replayText(tab.text, label) };
      // A folder that is gone, or a profile since removed, still gets the tab back — in the
      // repository, with the default shell — rather than losing it.
      const id = await get()
        .openNew(projectId, tab.cwd || fallbackCwd, { ...opts, profileId: tab.profileId })
        .catch(() => get().openNew(projectId, fallbackCwd, opts))
        .catch(() => null);
      ids.push(id);
    }
    set((s) =>
      patchProject(s, projectId, (proj) => {
        const groups: TerminalGroup[] = saved.groups
          .map((group) => {
            const members = group.tabs.map((at) => ids[at]).filter((id): id is string => !!id);
            return { ...newGroup(members, group.dir), sizes: normalizeSizes(group.sizes, members.length), broadcast: group.broadcast && members.length > 1 };
          })
          .filter((group) => group.ids.length > 0);
        // Anything the saved groups did not mention (an older row) stands on its own.
        const placed = new Set(groups.flatMap((group) => group.ids));
        for (const id of ids) if (id && !placed.has(id)) groups.push(newGroup([id]));
        return { ...proj, groups, focusedId: ids[saved.focused] ?? proj.focusedId };
      }),
    );
    return ids.some(Boolean);
  },
}));
