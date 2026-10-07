/**
 * What a run is doing, in the few words the thinking mark and the run card can act on.
 *
 * Derived, never invented: `phase` comes from the run's own log (`lib/runSteps`) — the tool the
 * engine last called, or the reasoning it is streaming — so "Leyendo" is said only while a `Read`
 * is the newest thing the CLI printed. The marks may light up differently per phase; none of them
 * may claim a phase the run is not in.
 */
export type RunPhase =
  | "start"
  | "think"
  | "plan"
  | "read"
  | "search"
  | "tool"
  | "edit"
  | "run"
  | "delegate"
  | "write"
  | "work";

export interface ThinkingActivity {
  phase?: RunPhase;
  /** The run has printed nothing for a long while (`AiRunLog`'s quiet threshold). */
  quiet?: boolean;
  /** The run just finished — the mark resolves before it gives way to the avatar. */
  done?: boolean;
  /** Stop was pressed and the process is being killed. */
  stopping?: boolean;
}

/** The one-word state a mark is drawn in; `run` covers every phase of a live run. */
export type ThinkingState = "run" | "quiet" | "done" | "stopping";

export function thinkingState(activity: ThinkingActivity | undefined): ThinkingState {
  if (!activity) return "run";
  if (activity.done) return "done";
  if (activity.stopping) return "stopping";
  if (activity.quiet) return "quiet";
  return "run";
}
