import { create } from "zustand";
import { type DebugAdapter } from "../lib/debugAdapters";
import {
  debugContinue,
  debugEvaluate,
  debugIsRunning,
  debugPause,
  debugProperties,
  debugPython,
  debugScopes,
  debugSession,
  debugSetBreakpoints,
  debugSetExceptionFilters,
  debugStart,
  debugStartAdapter,
  debugStep,
  debugStop,
  getSetting,
  setSetting,
  type BreakpointSpec,
  type DebugVariable,
  type ExceptionFilter,
  type StackFrame,
} from "../lib/tauri/commands";
import { onDebugOutput, onDebugPaused, onDebugResumed, onDebugTerminated } from "../lib/tauri/events";
import { useWorkspaceStore } from "./workspaceStore";

/** Paths cross three boundaries here (editor, store, V8) and each has its own opinion about
 * separators. Everything is compared and stored slash-normalized; the backend accepts both. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export interface ConsoleLine {
  kind: string;
  text: string;
}

/** One breakpoint in one file. */
export interface Breakpoint {
  /** 1-based. Moves with the code as the file is edited — see `useBreakpointGutter`. */
  line: number;
  /** Off, it stays in the gutter (hollow) and in the list, and is sent to no debugger. */
  enabled: boolean;
  /** Stop only when this expression is truthy. */
  condition?: string;
  /** A logpoint: print this instead of stopping; `{expression}` is interpolated. */
  logMessage?: string;
}

/** What a watch expression evaluated to at the current stop. */
export interface WatchResult {
  value: string;
  error: boolean;
  objectId: string | null;
}

/** Node's exception filters — fixed, unlike an adapter's, which it lists when a session starts. The
 *  labels are the backend's; the panel translates these two by id. */
export const NODE_EXCEPTION_FILTERS: ExceptionFilter[] = [
  { filter: "uncaught", label: "Uncaught exceptions", default: false },
  { filter: "all", label: "All exceptions", default: false },
];

type Status = "idle" | "running" | "paused";

interface DebugState {
  /** The workspace whose breakpoints and watches are loaded. */
  workspaceId: string | null;
  /** Breakpoints per absolute file path. They belong to the file, not to a run: kept per
   * workspace in settings, and across sessions. */
  breakpoints: Record<string, Breakpoint[]>;
  /** Watch expressions, evaluated again at every stop in the selected frame. Per workspace. */
  watches: string[];
  watchValues: Record<string, WatchResult>;
  /** The exception filters switched on, per debugger (`node`, or an adapter's id). A debugger with
   * no entry was never chosen for: an adapter's own defaults apply. */
  exceptionFilters: Record<string, string[]>;
  /** What each adapter offered the last time it started — Node's are known without asking. */
  offeredFilters: Record<string, ExceptionFilter[]>;
  /** The debugger of the session running (or last run): `node`, or an adapter's id. */
  sessionDebugger: string | null;
  status: Status;
  frames: StackFrame[];
  /** Index into `frames` — the stack entry whose variables and console scope are shown. */
  selectedFrame: number;
  /** The selected frame's scopes (`Local`, `Closure`, `Global`…), each expandable like an object. */
  scopes: DebugVariable[];
  /** Expanded rows — scopes and objects — keyed by their object id. */
  expanded: Record<string, DebugVariable[]>;
  /** Why the program is stopped (`breakpoint`, `exception`…), and the exception's message. */
  pauseReason: string | null;
  pauseDescription: string | null;
  console: ConsoleLine[];
  /** Last launch error, shown in the panel instead of a toast that a running app would bury. */
  error: string | null;
  init: () => void;
  loadWorkspace: (workspaceId: string | null) => Promise<void>;
  toggleBreakpoint: (file: string, line: number) => void;
  /** Adds the breakpoint, or changes it: enabled, condition, log message. */
  setBreakpoint: (file: string, line: number, patch: Partial<Omit<Breakpoint, "line">>) => void;
  removeBreakpoint: (file: string, line: number) => void;
  removeAllBreakpoints: () => void;
  /** Lines moved by an edit — see `useBreakpointGutter`. `moves` maps every breakpoint the pane drew
   * to where its decoration is now. Not sent to a live session: the program running is the one on
   * disk, whose lines have not moved. */
  moveBreakpoints: (file: string, moves: Array<[from: number, to: number]>) => void;
  breakpointsFor: (file: string) => Breakpoint[];
  addWatch: (expression: string) => void;
  removeWatch: (expression: string) => void;
  refreshWatches: () => Promise<void>;
  /** The filters a debugger offers, and which of them are on. */
  exceptionOptionsFor: (debuggerId: string) => ExceptionFilter[];
  enabledFiltersFor: (debuggerId: string) => string[];
  setExceptionFilter: (debuggerId: string, filter: string, on: boolean) => void;
  start: (cwd: string, program: string, adapter: DebugAdapter, command?: string) => Promise<void>;
  stop: () => Promise<void>;
  resume: () => Promise<void>;
  pause: () => Promise<void>;
  step: (kind: "over" | "into" | "out") => Promise<void>;
  selectFrame: (index: number) => Promise<void>;
  expand: (objectId: string) => Promise<void>;
  evaluate: (expression: string) => Promise<void>;
  clearConsole: () => void;
}

const MAX_CONSOLE_LINES = 500;

const breakpointsKey = (workspaceId: string) => `debug_breakpoints:${workspaceId}`;
const watchesKey = (workspaceId: string) => `debug_watches:${workspaceId}`;
const FILTERS_KEY = "debug_exception_filters";

let subscribed = false;
/** Numbers every stop, resume and frame change, so a slow answer for an earlier one is dropped. */
let pauseSeq = 0;
/** The files a session was last sent breakpoints for. A file whose last one was removed has to be
 * sent again with an empty list — an adapter keeps a file's breakpoints until told otherwise. */
let sentFiles = new Set<string>();
/** Numbers every start and stop, so a start that is still launching when Stop is pressed neither
 * carries on nor reports the failure Stop itself caused. */
let startToken = 0;

/** Settings written a beat after the last change, one timer per key — a drag through the list, or
 * an edit moving five breakpoints, is one write. The key is fixed when the write is scheduled, so a
 * workspace switched meanwhile cannot receive another workspace's list. */
const writes = new Map<string, ReturnType<typeof setTimeout>>();
function persist(key: string, value: unknown) {
  const pending = writes.get(key);
  if (pending) clearTimeout(pending);
  writes.set(
    key,
    setTimeout(() => {
      writes.delete(key);
      void setSetting(key, JSON.stringify(value)).catch(() => {});
    }, 250),
  );
}

/** A stored breakpoint list, filtered rather than trusted: a hand-edited settings value should cost
 * its bad rows, not the gutter. Bare numbers — the shape before conditions existed — still read. */
export function parseBreakpoints(stored: string | null): Record<string, Breakpoint[]> {
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Breakpoint[]> = {};
    for (const [file, rows] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      const list: Breakpoint[] = [];
      for (const row of rows) {
        const candidate: Record<string, unknown> | null =
          typeof row === "number" ? { line: row } : row && typeof row === "object" ? (row as Record<string, unknown>) : null;
        if (!candidate || typeof candidate.line !== "number" || !Number.isInteger(candidate.line) || candidate.line < 1) continue;
        if (list.some((bp) => bp.line === candidate.line)) continue;
        list.push({
          line: candidate.line,
          enabled: candidate.enabled !== false,
          ...(typeof candidate.condition === "string" && candidate.condition ? { condition: candidate.condition } : {}),
          ...(typeof candidate.logMessage === "string" && candidate.logMessage ? { logMessage: candidate.logMessage } : {}),
        });
      }
      if (list.length > 0) out[normalizePath(file)] = list.sort((a, b) => a.line - b.line);
    }
    return out;
  } catch {
    return {};
  }
}

function parseStrings(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  } catch {
    return [];
  }
}

function parseFilters(stored: string | null): Record<string, string[]> {
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) out[id] = list.filter((item): item is string => typeof item === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** What a session is sent: the enabled breakpoints of every file, and an empty list for each file it
 * was sent before that has none left. */
export function specsFor(breakpoints: Record<string, Breakpoint[]>, previouslySent: Set<string>): Record<string, BreakpointSpec[]> {
  const out: Record<string, BreakpointSpec[]> = {};
  for (const [file, list] of Object.entries(breakpoints)) {
    out[file] = list
      .filter((bp) => bp.enabled)
      .map((bp) => ({
        line: bp.line,
        ...(bp.condition ? { condition: bp.condition } : {}),
        ...(bp.logMessage ? { logMessage: bp.logMessage } : {}),
      }));
  }
  for (const file of previouslySent) if (!(file in out)) out[file] = [];
  return out;
}

/** The lists with `file`'s replaced; a file left empty is dropped. */
function withFile(all: Record<string, Breakpoint[]>, file: string, list: Breakpoint[]): Record<string, Breakpoint[]> {
  const next = { ...all };
  if (list.length > 0) next[file] = [...list].sort((a, b) => a.line - b.line);
  else delete next[file];
  return next;
}

/** A clean result for a pause, before anything about it has been fetched. */
function freshStop() {
  return { expanded: {}, scopes: [] as DebugVariable[], watchValues: {} as Record<string, WatchResult> };
}

export const useDebugStore = create<DebugState>((set, get) => {
  /** Sends the current breakpoints to a live session. With none running this is a no-op, and the
   * set is sent again at launch. */
  const push = () => {
    const specs = specsFor(get().breakpoints, sentFiles);
    // A file just sent its empty list is cleared on the other side, and needs no more sending.
    sentFiles = new Set(Object.keys(get().breakpoints));
    void debugSetBreakpoints(specs).catch(() => {});
  };

  /** Records a changed breakpoint map: kept, written to the workspace's settings, and — unless an
   * edit moved it — sent to the session. */
  const commit = (breakpoints: Record<string, Breakpoint[]>, send: boolean) => {
    set({ breakpoints });
    const workspaceId = get().workspaceId;
    if (workspaceId) persist(breakpointsKey(workspaceId), breakpoints);
    if (send) push();
  };

  const commitWatches = (watches: string[]) => {
    set({ watches });
    const workspaceId = get().workspaceId;
    if (workspaceId) persist(watchesKey(workspaceId), watches);
  };

  return {
    workspaceId: null,
    breakpoints: {},
    watches: [],
    watchValues: {},
    exceptionFilters: {},
    offeredFilters: { node: NODE_EXCEPTION_FILTERS },
    sessionDebugger: null,
    status: "idle",
    frames: [],
    selectedFrame: 0,
    scopes: [],
    expanded: {},
    pauseReason: null,
    pauseDescription: null,
    console: [],
    error: null,

    init: () => {
      if (subscribed) return;
      subscribed = true;
      void onDebugPaused((event) => {
        pauseSeq += 1;
        set({
          status: "paused",
          frames: event.frames,
          selectedFrame: 0,
          pauseReason: event.reason,
          pauseDescription: event.description ?? null,
          ...freshStop(),
        });
        // The top frame's locals are what anyone looks at first, so they're fetched without asking.
        void get().selectFrame(0);
      });
      void onDebugResumed(() => {
        pauseSeq += 1;
        set({ status: "running", frames: [], pauseReason: null, pauseDescription: null, ...freshStop() });
      });
      void onDebugOutput((event) => {
        set((s) => {
          const next = [...s.console, { kind: event.kind, text: event.text }];
          return { console: next.length > MAX_CONSOLE_LINES ? next.slice(-MAX_CONSOLE_LINES) : next };
        });
      });
      void onDebugTerminated(() => {
        pauseSeq += 1;
        set({ status: "idle", frames: [], selectedFrame: 0, pauseReason: null, pauseDescription: null, ...freshStop() });
      });
      void getSetting(FILTERS_KEY)
        .then((stored) => set({ exceptionFilters: { ...parseFilters(stored), ...get().exceptionFilters } }))
        .catch(() => {});

      // A session can be running that this panel never started: the webview reloaded under it, and
      // everything the panel knew went with it while the program lived on. Without this the panel
      // said "idle", with no Stop button, beside a process still paused at a breakpoint.
      void (async () => {
        const running = await debugIsRunning().catch(() => false);
        if (!running || get().status !== "idle") return;
        const info = await debugSession().catch(() => null);
        if (!info || get().status !== "idle") return;
        const debuggerId = info.backend === "node" ? "node" : "adapter";
        set((s) => ({
          sessionDebugger: debuggerId,
          offeredFilters: { ...s.offeredFilters, [debuggerId]: info.exceptionFilters },
          status: info.paused ? "paused" : "running",
          frames: info.paused?.frames ?? [],
          selectedFrame: 0,
          pauseReason: info.paused?.reason ?? null,
          pauseDescription: info.paused?.description ?? null,
          ...freshStop(),
        }));
        if (info.paused) void get().selectFrame(0);
      })();
    },

    loadWorkspace: async (workspaceId) => {
      if (get().workspaceId === workspaceId) return;
      set({ workspaceId, breakpoints: {}, watches: [], watchValues: {} });
      if (!workspaceId) return;
      const [storedBreakpoints, storedWatches] = await Promise.all([
        getSetting(breakpointsKey(workspaceId)).catch(() => null),
        getSetting(watchesKey(workspaceId)).catch(() => null),
      ]);
      // Switched again while this was reading: the newer load owns the state.
      if (get().workspaceId !== workspaceId) return;
      const loaded = parseBreakpoints(storedBreakpoints);
      // Anything set in the moment before the read came back is kept alongside what was stored.
      const merged = { ...loaded };
      for (const [file, list] of Object.entries(get().breakpoints)) {
        const byLine = new Map((merged[file] ?? []).map((bp) => [bp.line, bp]));
        for (const bp of list) byLine.set(bp.line, bp);
        merged[file] = [...byLine.values()].sort((a, b) => a.line - b.line);
      }
      const watches = [...new Set([...parseStrings(storedWatches), ...get().watches])];
      set({ breakpoints: merged, watches });
    },

    toggleBreakpoint: (file, line) => {
      const key = normalizePath(file);
      const list = get().breakpoints[key] ?? [];
      const next = list.some((bp) => bp.line === line)
        ? list.filter((bp) => bp.line !== line)
        : [...list, { line, enabled: true }];
      commit(withFile(get().breakpoints, key, next), true);
    },

    setBreakpoint: (file, line, patch) => {
      const key = normalizePath(file);
      const list = get().breakpoints[key] ?? [];
      const existing = list.find((bp) => bp.line === line) ?? { line, enabled: true };
      const updated: Breakpoint = { ...existing, ...patch, line };
      // An empty condition or message is none at all — which is what clearing the field means.
      if (!updated.condition?.trim()) delete updated.condition;
      if (!updated.logMessage?.trim()) delete updated.logMessage;
      commit(withFile(get().breakpoints, key, [...list.filter((bp) => bp.line !== line), updated]), true);
    },

    removeBreakpoint: (file, line) => {
      const key = normalizePath(file);
      const list = get().breakpoints[key] ?? [];
      commit(withFile(get().breakpoints, key, list.filter((bp) => bp.line !== line)), true);
    },

    removeAllBreakpoints: () => commit({}, true),

    moveBreakpoints: (file, moves) => {
      const key = normalizePath(file);
      const list = get().breakpoints[key];
      if (!list || moves.length === 0) return;
      // Two panes showing one file both see the same edit and both report it. The second report is
      // against lines that have already moved, and applying it again would move them twice — so a
      // report whose starting lines are not all still where it says is one that already happened.
      if (!moves.every(([from]) => list.some((bp) => bp.line === from))) return;
      const target = new Map(moves);
      const moved: Breakpoint[] = [];
      for (const bp of list) {
        const line = target.get(bp.line) ?? bp.line;
        // Two collapsing onto one line — the lines between them deleted — leave one.
        if (!moved.some((other) => other.line === line)) moved.push({ ...bp, line });
      }
      commit(withFile(get().breakpoints, key, moved), false);
    },

    breakpointsFor: (file) => get().breakpoints[normalizePath(file)] ?? [],

    addWatch: (expression) => {
      const trimmed = expression.trim();
      if (!trimmed || get().watches.includes(trimmed)) return;
      commitWatches([...get().watches, trimmed]);
      void get().refreshWatches();
    },

    removeWatch: (expression) => {
      commitWatches(get().watches.filter((watch) => watch !== expression));
      set((s) => {
        const watchValues = { ...s.watchValues };
        delete watchValues[expression];
        return { watchValues };
      });
    },

    refreshWatches: async () => {
      const { frames, selectedFrame, status, watches } = get();
      const frame = frames[selectedFrame];
      if (status !== "paused" || !frame || watches.length === 0) return;
      const seq = pauseSeq;
      const results = await Promise.all(
        watches.map(async (expression): Promise<[string, WatchResult]> => {
          try {
            const result = await debugEvaluate(frame.id, expression, "watch");
            return [expression, { value: result.value, error: false, objectId: result.object_id }];
          } catch (e) {
            return [expression, { value: String(e), error: true, objectId: null }];
          }
        }),
      );
      if (seq !== pauseSeq) return;
      set({ watchValues: Object.fromEntries(results) });
    },

    exceptionOptionsFor: (debuggerId) => get().offeredFilters[debuggerId] ?? [],

    enabledFiltersFor: (debuggerId) =>
      get().exceptionFilters[debuggerId] ??
      get()
        .exceptionOptionsFor(debuggerId)
        .filter((option) => option.default)
        .map((option) => option.filter),

    setExceptionFilter: (debuggerId, filter, on) => {
      const current = get().enabledFiltersFor(debuggerId);
      const next = on ? [...new Set([...current, filter])] : current.filter((f) => f !== filter);
      const exceptionFilters = { ...get().exceptionFilters, [debuggerId]: next };
      set({ exceptionFilters });
      persist(FILTERS_KEY, exceptionFilters);
      if (get().status !== "idle" && get().sessionDebugger === debuggerId) {
        void debugSetExceptionFilters(next).catch((e) => set({ error: String(e) }));
      }
    },

    start: async (cwd, program, adapter, command) => {
      get().init();
      const token = ++startToken;
      pauseSeq += 1;
      set({ error: null, console: [], status: "running", frames: [], pauseReason: null, pauseDescription: null, ...freshStop() });
      const breakpoints = specsFor(get().breakpoints, new Set());
      sentFiles = new Set(Object.keys(breakpoints));
      try {
        if (adapter.command === null) {
          // Node needs no adapter: the runtime is the debugger.
          set({ sessionDebugger: "node" });
          await debugStart(cwd, program, [], breakpoints, get().enabledFiltersFor("node"));
        } else {
          let binary = (command ?? adapter.command ?? "").trim();
          let launch: Record<string, unknown> = { ...adapter.launch, program, cwd };
          // The preset's own interpreter, untouched: picked for this project — its venv first.
          if (adapter.resolve === "python" && (binary === "" || binary === adapter.command)) {
            const python = await debugPython(cwd);
            if (token !== startToken) return;
            binary = python.adapter;
            launch = { ...launch, python: [python.interpreter] };
          }
          if (!binary) throw new Error(`${adapter.label}: ${adapter.install}`);
          set({ sessionDebugger: adapter.id });
          const chosen = get().exceptionFilters[adapter.id] ?? null;
          const offered = await debugStartAdapter(cwd, binary, adapter.args, launch, breakpoints, chosen);
          set((s) => ({ offeredFilters: { ...s.offeredFilters, [adapter.id]: offered } }));
        }
      } catch (e) {
        // Stopped while it was still starting: the failure is the stop's own doing.
        if (token !== startToken) return;
        // A missing adapter is the most common failure, and the message says what to install.
        const detail = String(e);
        const hint =
          adapter.install && /failed to launch|No module named/i.test(detail) ? `${detail}\n${adapter.install}` : detail;
        set({ status: "idle", error: hint });
      }
    },

    stop: async () => {
      startToken += 1;
      await debugStop().catch(() => {});
      pauseSeq += 1;
      set({ status: "idle", frames: [], pauseReason: null, pauseDescription: null, ...freshStop() });
    },

    resume: async () => {
      await debugContinue().catch((e) => set({ error: String(e) }));
    },

    pause: async () => {
      await debugPause().catch((e) => set({ error: String(e) }));
    },

    step: async (kind) => {
      await debugStep(kind).catch((e) => set({ error: String(e) }));
    },

    selectFrame: async (index) => {
      const frame = get().frames[index];
      pauseSeq += 1;
      const seq = pauseSeq;
      set({ selectedFrame: index, scopes: [], expanded: {}, watchValues: {} });
      if (!frame) return;
      // Every scope of *this* frame — any frame, not only the top one. A backend that cannot list
      // them still knows the frame's local scope.
      const scopes = await debugScopes(frame.id).catch((): DebugVariable[] =>
        frame.scope_id ? [{ name: "Local", value: "", object_id: frame.scope_id }] : [],
      );
      if (seq !== pauseSeq) return;
      set({ scopes });
      // The innermost scope opens by itself; the global one never does — it is the whole runtime.
      const first = scopes.find((scope) => scope.object_id && !/^global/i.test(scope.name));
      if (first?.object_id) {
        const children = await debugProperties(first.object_id).catch(() => []);
        if (seq !== pauseSeq) return;
        set((s) => ({ expanded: { ...s.expanded, [first.object_id as string]: children } }));
      }
      await get().refreshWatches();
    },

    expand: async (objectId) => {
      if (get().expanded[objectId]) {
        set((s) => {
          const expanded = { ...s.expanded };
          delete expanded[objectId];
          return { expanded };
        });
        return;
      }
      const seq = pauseSeq;
      const children = await debugProperties(objectId).catch(() => []);
      if (seq !== pauseSeq) return;
      set((s) => ({ expanded: { ...s.expanded, [objectId]: children } }));
    },

    evaluate: async (expression) => {
      const { frames, selectedFrame } = get();
      const frame = frames[selectedFrame];
      if (!frame) return;
      set((s) => ({ console: [...s.console, { kind: "input", text: expression }] }));
      try {
        const result = await debugEvaluate(frame.id, expression, "repl");
        set((s) => ({ console: [...s.console, { kind: "result", text: result.value }] }));
      } catch (e) {
        set((s) => ({ console: [...s.console, { kind: "error", text: String(e) }] }));
      }
      // The console can change what a watch sees (`x = 3`), so they are asked again.
      await get().refreshWatches();
    },

    clearConsole: () => set({ console: [] }),
  };
});

// Breakpoints and watches follow the workspace on screen: each keeps its own, so switching
// workspace shows that workspace's, and nothing set in one is filed under another.
void useDebugStore.getState().loadWorkspace(useWorkspaceStore.getState().activeWorkspaceId);
useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
  void useDebugStore.getState().loadWorkspace(state.activeWorkspaceId);
});
