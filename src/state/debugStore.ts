import { create } from "zustand";
import { type DebugAdapter } from "../lib/debugAdapters";
import {
  debugContinue,
  debugEvaluate,
  debugPause,
  debugProperties,
  debugSetBreakpoints,
  debugStart,
  debugStartAdapter,
  debugStep,
  debugStop,
  type DebugVariable,
  type StackFrame,
} from "../lib/tauri/commands";
import { onDebugOutput, onDebugPaused, onDebugResumed, onDebugTerminated } from "../lib/tauri/events";

/** Paths cross three boundaries here (editor, store, V8) and each has its own opinion about
 * separators. Everything is compared and stored slash-normalized; the backend accepts both. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export interface ConsoleLine {
  kind: string;
  text: string;
}

type Status = "idle" | "running" | "paused";

interface DebugState {
  /** Breakpoints per absolute file path, as 1-based line numbers. Survive a session ending —
   * they belong to the file, not to the run. */
  breakpoints: Record<string, number[]>;
  status: Status;
  frames: StackFrame[];
  /** Index into `frames` — the stack entry whose variables and console scope are shown. */
  selectedFrame: number;
  variables: DebugVariable[];
  /** Expanded object rows, keyed by their CDP object id. */
  expanded: Record<string, DebugVariable[]>;
  console: ConsoleLine[];
  /** Last launch error, shown in the panel instead of a toast that a running app would bury. */
  error: string | null;
  init: () => void;
  toggleBreakpoint: (file: string, line: number) => void;
  breakpointsFor: (file: string) => number[];
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

let subscribed = false;

export const useDebugStore = create<DebugState>((set, get) => ({
  breakpoints: {},
  status: "idle",
  frames: [],
  selectedFrame: 0,
  variables: [],
  expanded: {},
  console: [],
  error: null,

  init: () => {
    if (subscribed) return;
    subscribed = true;
    void onDebugPaused((event) => {
      set({ status: "paused", frames: event.frames, selectedFrame: 0, expanded: {}, variables: [] });
      // The top frame's locals are what anyone looks at first, so they're fetched without asking.
      void get().selectFrame(0);
    });
    void onDebugResumed(() => set({ status: "running", frames: [], variables: [], expanded: {} }));
    void onDebugOutput((event) => {
      set((s) => {
        const next = [...s.console, { kind: event.kind, text: event.text }];
        return { console: next.length > MAX_CONSOLE_LINES ? next.slice(-MAX_CONSOLE_LINES) : next };
      });
    });
    void onDebugTerminated(() =>
      set({ status: "idle", frames: [], variables: [], expanded: {}, selectedFrame: 0 }),
    );
  },

  toggleBreakpoint: (file, line) => {
    const key = normalizePath(file);
    set((s) => {
      const lines = s.breakpoints[key] ?? [];
      const next = lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line].sort((a, b) => a - b);
      const breakpoints = { ...s.breakpoints };
      if (next.length > 0) breakpoints[key] = next;
      else delete breakpoints[key];
      return { breakpoints };
    });
    // A live session takes the change immediately; with none running this is a no-op and the
    // set is sent again at launch.
    void debugSetBreakpoints(get().breakpoints).catch(() => {});
  },

  breakpointsFor: (file) => get().breakpoints[normalizePath(file)] ?? [],

  start: async (cwd, program, adapter, command) => {
    get().init();
    set({ error: null, console: [], status: "running" });
    try {
      const binary = (command ?? adapter.command ?? "").trim();
      if (adapter.command === null) {
        // Node needs no adapter: the runtime is the debugger.
        await debugStart(cwd, program, [], get().breakpoints);
      } else {
        if (!binary) throw new Error(`${adapter.label}: ${adapter.install}`);
        await debugStartAdapter(
          cwd,
          binary,
          adapter.args,
          { ...adapter.launch, program, cwd },
          get().breakpoints,
        );
      }
    } catch (e) {
      // A missing adapter is the most common failure, and the message says what to install.
      const detail = String(e);
      const hint = adapter.install && detail.toLowerCase().includes("failed to launch")
        ? `${detail}
${adapter.install}`
        : detail;
      set({ status: "idle", error: hint });
    }
  },

  stop: async () => {
    await debugStop().catch(() => {});
    set({ status: "idle", frames: [], variables: [], expanded: {} });
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
    set({ selectedFrame: index, variables: [], expanded: {} });
    if (!frame?.scope_id) return;
    const variables = await debugProperties(frame.scope_id).catch(() => []);
    // Guard against a resume (or another frame click) landing while this was in flight.
    if (get().selectedFrame === index) set({ variables });
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
    const children = await debugProperties(objectId).catch(() => []);
    set((s) => ({ expanded: { ...s.expanded, [objectId]: children } }));
  },

  evaluate: async (expression) => {
    const { frames, selectedFrame } = get();
    const frame = frames[selectedFrame];
    if (!frame) return;
    set((s) => ({ console: [...s.console, { kind: "input", text: expression }] }));
    try {
      const result = await debugEvaluate(frame.id, expression);
      set((s) => ({ console: [...s.console, { kind: "result", text: result.value }] }));
    } catch (e) {
      set((s) => ({ console: [...s.console, { kind: "error", text: String(e) }] }));
    }
  },

  clearConsole: () => set({ console: [] }),
}));
