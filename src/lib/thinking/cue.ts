import { ended, type ThinkingActivity } from "./activity";
import { easeOut, rgba } from "./finish";
import type { Rgb } from "./palette";
import { prefersReducedMotion } from "./ticker";

/**
 * What the canvas marks share for Codi's cues (`ThinkingActivity.cue`): the clock that plays a wake
 * once and holds an ask, and the shapes both are drawn with — so every design starts, peaks and
 * settles on the same beats, each in its own way.
 *
 * A wake is the wake word heard: half a second of startle — a hop or a pop, a flash of light, the
 * eyes snapping to whoever called — and then the mark is back in its phase. An ask holds for as long
 * as the cue is set: the characters tilt their heads and look at the viewer with a questioning
 * double blink every few seconds; the abstract designs breathe slowly inside a soft halo.
 *
 * Only while the mark runs: an ending, a stop or a quiet spell drops the cue, so a finish always wins.
 */

/** How long a wake's startle lasts, in seconds. */
export const WAKE_S = 0.5;
/** How often the waiting pose's questioning beat comes round, in seconds. */
const ASK_BEAT_S = 2.6;

export interface CueClock {
  /** Seconds into a wake's startle, or -1 when none is playing. */
  readonly wake: number;
  /** How far into the ask's waiting pose, 0–1 — eased in when the cue is set, out when it clears. */
  readonly ask: number;
  set(activity: ThinkingActivity | undefined): void;
  step(dt: number): void;
  /** For a still frame: the waiting pose held where it is going, and — under reduced motion — no
   *  startle, which has no frames to play in. Not otherwise: `register()` paints a still at mount,
   *  and a mark opened by the wake word must still play it. */
  settle(): void;
}

export function cueClock(): CueClock {
  let wake = -1;
  let ask = 0;
  let asking = false;
  /** The `at` of the last wake taken, so the same cue handed over again does not replay it. */
  let last = Number.NaN;
  return {
    get wake() {
      return wake;
    },
    get ask() {
      return ask;
    },
    set(activity) {
      const running = !ended(activity) && !activity?.quiet && !activity?.stopping;
      const cue = running ? activity?.cue : undefined;
      asking = cue?.kind === "ask";
      if (cue?.kind === "wake" && cue.at !== last) {
        last = cue.at;
        // Started this long ago: a mark mounted well after the wake word does not startle at it.
        const since = (performance.now() - cue.at) / 1000;
        wake = since < WAKE_S ? Math.max(0, since) : -1;
      }
      if (!running) wake = -1;
    },
    step(dt) {
      if (wake >= 0) {
        wake += dt;
        if (wake >= WAKE_S) wake = -1;
      }
      ask += ((asking ? 1 : 0) - ask) * Math.min(1, dt * 4);
    },
    settle() {
      ask = asking ? 1 : 0;
      if (prefersReducedMotion()) wake = -1;
    },
  };
}

/** The startle's strength, 0–1: up at once, then easing back to nothing by the wake's end. */
export function startle(wake: number): number {
  if (wake < 0) return 0;
  const k = wake / WAKE_S;
  return k < 0.2 ? easeOut(k / 0.2) : Math.pow(1 - (k - 0.2) / 0.8, 2);
}

/** A hop, 0–1: up and down once over the wake's first two thirds — for lifting a character. Lifts
 *  past ~0.06 of the square clip ears and antennae at the top. */
export function hop(wake: number): number {
  if (wake < 0) return 0;
  const k = wake / (WAKE_S * 0.65);
  return k < 1 ? Math.sin(k * Math.PI) : 0;
}

/** The questioning beat while asking, 0–1: nothing most of the time, then a half-second "hm?" every
 *  `ASK_BEAT_S` — the head tilts a little further and the eyes blink twice on it. */
export function askBeat(time: number): number {
  const k = time % ASK_BEAT_S;
  return k < 0.5 ? Math.sin((k / 0.5) * Math.PI) : 0;
}

/** How open the eyes are while asking: open, with a quick double blink on each beat. */
export function askBlink(time: number): number {
  const k = time % ASK_BEAT_S;
  const shut = (at: number) => Math.min(1, Math.abs(k - at) / 0.06);
  return Math.min(shut(0.1), shut(0.3));
}

/** The abstract designs' slow breath while asking, 0–1, about once every three seconds. */
export function askBreath(time: number): number {
  return 0.5 - 0.5 * Math.cos(time * 2.1);
}

/** The ask's soft halo: a glow of `color` round (x, y), fading out from `r` to `r · 1.35`, drawn
 *  behind the design. */
export function softHalo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: Rgb, alpha: number) {
  if (alpha <= 0.01) return;
  const grad = ctx.createRadialGradient(x, y, r * 0.55, x, y, r * 1.35);
  grad.addColorStop(0, rgba(color, 0));
  grad.addColorStop(0.45, rgba(color, alpha));
  grad.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.35, 0, Math.PI * 2);
  ctx.fill();
}
