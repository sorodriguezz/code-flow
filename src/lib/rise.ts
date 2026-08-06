import type { CSSProperties } from "react";

/**
 * The way a list arrives, everywhere in the app.
 *
 * One row fading up 5px is barely an animation; a list doing it in sequence is the thing that says
 * "this is a list, and it just loaded" — which is exactly what a panel that swaps its whole
 * contents when you click a repository, a batch or a connection needs to say. The proposal cards in
 * specs → Review had it first; this module is that effect hoisted so every other list can be the
 * same one rather than a re-implementation that drifts by 20ms.
 *
 * The keyframes and the `prefers-reduced-motion` opt-out live in `index.css` under `.cf-rise`, and
 * the class goes on the row itself — it moves the element it is set on, not a wrapper. This side
 * only decides *when* each row goes.
 */

/** How far apart two neighbouring rows start, in milliseconds. */
const STEP = 45;

/**
 * How many rows are allowed to wait before the rest give up and arrive together.
 *
 * Without the cap the fortieth row of a list would start two seconds after the first, which is not
 * a stagger any more — it is a list that loads slowly. Eight steps is ~360ms end to end, about the
 * length of the animation itself.
 */
const CAP = 8;

/**
 * The delay for the row at `at`, as the inline style the `cf-rise` class reads.
 *
 * Returned as a style rather than a class because Tailwind can't emit an arbitrary delay per index,
 * and as a custom property rather than `animationDelay` so a call site is still free to set its own
 * transitions without fighting the shorthand.
 */
export function riseDelay(at: number): CSSProperties {
  return { "--cf-rise-delay": `${Math.min(at, CAP) * STEP}ms` } as CSSProperties;
}
