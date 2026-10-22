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
  | "work"
  /** Reading aloud (`speechStore`): the mark moves with the voice's loudness (`lib/thinking/voice`). */
  | "speak"
  /** Codi, the voice assistant, hearing the user: the mark moves with the microphone's level
   *  (`lib/thinking/listen`) — drawing the sound in, where speaking pushes it out. */
  | "listen";

/**
 * A moment Codi's window plays on top of what the mark is doing. `wake` is "you called me" — the
 * wake word was heard: a short startle, the eyes snapping to whoever said it, then back to the
 * phase. `ask` is a question waiting on the user (a confirmation): a held, waiting pose for as long
 * as the cue stays set. `at` is `performance.now()` when it started, so a new object — a new `at` —
 * plays a wake again, and a mark mounted long after one does not replay it.
 */
export interface ThinkingCue {
  kind: "wake" | "ask";
  at: number;
}

export interface ThinkingActivity {
  phase?: RunPhase;
  /** The run has printed nothing for a long while (`AiRunLog`'s quiet threshold). */
  quiet?: boolean;
  /** The run just finished — the mark resolves before it gives way to the avatar. */
  done?: boolean;
  /** The run just ended in an error: the mark turns red and slumps instead of celebrating. Wins
   *  over `done` — a failed run that also says done is still a failure. */
  failed?: boolean;
  /** Stop was pressed and the process is being killed. */
  stopping?: boolean;
  /** Played only while the mark runs: an ending, a stop or a quiet spell is its own look, and a
   *  finish always wins over a cue. */
  cue?: ThinkingCue;
}

/** The one-word state a mark is drawn in; `run` covers every phase of a live run. */
export type ThinkingState = "run" | "quiet" | "done" | "failed" | "stopping";

export function thinkingState(activity: ThinkingActivity | undefined): ThinkingState {
  if (!activity) return "run";
  if (activity.failed) return "failed";
  if (activity.done) return "done";
  if (activity.stopping) return "stopping";
  if (activity.quiet) return "quiet";
  return "run";
}

/** Whether the run is over, either way — what a finish plays on. */
export function ended(activity: ThinkingActivity | undefined): boolean {
  return !!(activity?.done || activity?.failed);
}

/**
 * The phases in the kinds the CSS marks can draw differently — they cannot afford one look per
 * phase, but thinking, reading, working and writing do look different on all of them, and so does
 * listening: every design has a listening look of its own, never another phase's.
 */
export type PhaseGroup = "think" | "read" | "work" | "write" | "listen";

export function phaseGroup(phase: RunPhase | undefined): PhaseGroup {
  switch (phase) {
    case "read":
    case "search":
      return "read";
    case "tool":
    case "edit":
    case "run":
    case "delegate":
    case "work":
      return "work";
    // Speaking is drawn as writing by the CSS marks — the closest of their looks — and pulses with
    // the voice on top (`.cf-orb--speaking`).
    case "write":
    case "speak":
      return "write";
    // Listening is a look of its own on every CSS mark (`index.css`), not one borrowed from a phase.
    case "listen":
      return "listen";
    default:
      return "think";
  }
}
