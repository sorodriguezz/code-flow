import type { ThinkingActivity } from "../../lib/thinking/activity";
import type { CodiPhase, CodiTurn } from "../../lib/tauri/codiCommands";

/**
 * What Codi's face (`ThinkingOrb size="hero"`) draws for what Codi is doing. Pure, so the window
 * and its tests read the same rule.
 *
 * - **off** (the microphone closed): the quiet look — the window also dims it.
 * - **idle / hearing**: listening, drawing the microphone's level in (`lib/thinking/listen`).
 * - **thinking** → think · **acting** → work · **speaking** → speak (moving with the voice).
 * - **waiting** (a confirmation): thinking, held in the `ask` pose for as long as it waits.
 *
 * On top: the `wake` cue for a moment after its name was heard, and a finish — green when the
 * turn's actions all ran, red when it failed — that wins over everything for its moment.
 */

/** How long a wake cue and a finish are drawn. */
export const WAKE_MS = 1200;
export const FLASH_MS = 1400;

export type CodiFlash = "done" | "failed";

/** What a turn ended in, for the face: failed (an error, or any action that did not run), done
 *  (one action or more, all run), or nothing to show (an answer with no action). */
export function turnOutcome(turn: Pick<CodiTurn, "error" | "actions">): CodiFlash | null {
  if (turn.error || turn.actions.some((acted) => !acted.ok)) return "failed";
  return turn.actions.length > 0 ? "done" : null;
}

export function codiActivity({
  phase,
  phaseSince,
  wakeAt = null,
  flash = null,
}: {
  phase: CodiPhase;
  /** `performance.now()` when the phase began — the `ask` cue's `at`, so it is not replayed. */
  phaseSince: number;
  /** A wake still being drawn (the caller drops it after `WAKE_MS`). */
  wakeAt?: number | null;
  flash?: CodiFlash | null;
}): ThinkingActivity {
  if (flash === "failed") return { failed: true };
  if (flash === "done") return { done: true };
  if (phase === "off") return { quiet: true };
  // The utterance is transcribed before it is known to be addressed, so by the time the wake
  // arrives Codi may already be thinking about it: the cue plays over whatever phase it is in.
  const wake = wakeAt !== null ? { kind: "wake" as const, at: wakeAt } : undefined;
  const withWake = (activity: ThinkingActivity): ThinkingActivity => (wake ? { ...activity, cue: wake } : activity);
  switch (phase) {
    case "idle":
    case "hearing":
      return withWake({ phase: "listen" });
    case "thinking":
      return withWake({ phase: "think" });
    case "acting":
      return withWake({ phase: "work" });
    case "speaking":
      return withWake({ phase: "speak" });
    case "waiting":
      // A yes said aloud is addressed too: its wake plays over the waiting pose, then the pose holds.
      return { phase: "think", cue: wake ?? { kind: "ask", at: phaseSince } };
  }
}
