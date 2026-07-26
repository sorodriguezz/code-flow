import { create } from "zustand";
import { cancelAiRun } from "../lib/tauri/commands";
import { onAiOutput, type AiOutputEvent } from "../lib/tauri/events";
import { formatAgentLogLine } from "../lib/agentLog";

/** Only the tail is kept: a long agent run emits thousands of lines and nobody scrolls back
 * through them live — the full transcript is whatever the CLI itself writes to its own logs. */
const MAX_LINES = 400;

export interface AiRunLine {
  stream: "stdout" | "stderr";
  text: string;
}

interface AiRunState {
  /** Live output per run id. Entries survive the run ending so a finished job can still show
   * what it printed; they're cleared when the same id starts again, or explicitly. */
  linesByRun: Record<string, AiRunLine[]>;
  /** Runs the UI believes are in flight — set on start, cleared on finish. */
  active: Record<string, boolean>;
  /** Ids the user asked to stop, so the UI can show "stopping…" until the process actually dies
   * and can tell an intentional stop apart from a crash when the error arrives. */
  cancelling: Record<string, boolean>;
  /** Subscribes to the backend's output events. Idempotent — safe to call from an effect. */
  init: () => void;
  start: (runId: string) => void;
  finish: (runId: string) => void;
  cancel: (runId: string) => Promise<void>;
  clear: (runId: string) => void;
  linesFor: (runId: string) => AiRunLine[];
}

const EMPTY_LINES: AiRunLine[] = [];
let unlisten: (() => void) | null = null;

export const useAiRunStore = create<AiRunState>((set, get) => ({
  linesByRun: {},
  active: {},
  cancelling: {},

  init: () => {
    if (unlisten) return;
    // Assigned before the listener resolves so a second call in the same tick (React StrictMode
    // mounting effects twice) can't register a duplicate subscription.
    unlisten = () => {};
    void onAiOutput((event: AiOutputEvent) => {
      // Structured agent events become readable lines here rather than in the component, so the
      // stored log is what the user actually saw — and the noise never takes up a slot.
      const text = formatAgentLogLine(event.line);
      if (text === null) return;
      set((s) => {
        const previous = s.linesByRun[event.run_id] ?? EMPTY_LINES;
        const next = [...previous, { stream: event.stream, text }];
        return {
          linesByRun: {
            ...s.linesByRun,
            [event.run_id]: next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next,
          },
        };
      });
    }).then((off) => {
      unlisten = off;
    });
  },

  start: (runId) => {
    // Subscribing here (rather than leaving it to whatever renders the log) guarantees the
    // listener is attached before the process can print its first line.
    get().init();
    set((s) => ({
      linesByRun: { ...s.linesByRun, [runId]: [] },
      active: { ...s.active, [runId]: true },
      cancelling: { ...s.cancelling, [runId]: false },
    }));
  },

  finish: (runId) =>
    set((s) => ({
      active: { ...s.active, [runId]: false },
      cancelling: { ...s.cancelling, [runId]: false },
    })),

  cancel: async (runId) => {
    set((s) => ({ cancelling: { ...s.cancelling, [runId]: true } }));
    // The backend answering `false` just means the run finished on its own in the meantime; the
    // caller's promise is about to resolve with a real reply, so nothing to report here.
    await cancelAiRun(runId).catch(() => false);
  },

  clear: (runId) =>
    set((s) => {
      const { [runId]: _dropped, ...rest } = s.linesByRun;
      return { linesByRun: rest };
    }),

  linesFor: (runId) => get().linesByRun[runId] ?? EMPTY_LINES,
}));

/** Mints an id for a run. Prefixed so a stray id is recognizable in logs. */
export function newRunId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** True when an error came from the user pressing stop rather than from a genuine failure. The
 * marker is produced by the backend (`ai_runs::CANCELLED_MARKER`). */
export const CANCELLED_MARKER = "RUN_CANCELLED::";

export function isCancellation(error: unknown): boolean {
  return String(error).includes(CANCELLED_MARKER);
}
