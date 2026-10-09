import { ended, type ThinkingActivity } from "./activity";
import { aiHue, type Palette, type Rgb } from "./palette";
import { prefersReducedMotion } from "./ticker";

/**
 * What the marks with a finish animation share: the clock that plays it once, the easings and the
 * bursts of bits they throw.
 *
 * A finish is the few hundred milliseconds between a turn landing and the avatar taking the mark's
 * place (`AssistantAvatar` waits `finishMs` for it — see `lib/thinkingDesigns`). It plays when the
 * mark is told `done`, from the start, every time a new `done` arrives; under reduced motion the
 * mark shows its end pose straight away.
 *
 * A run that fails ends too, and plays the same clock — but in red (`palette().danger`) and with
 * none of the celebration: no jump, no confetti, no smile. The whole mark also shudders, which is
 * CSS on `.cf-orb[data-state="failed"]` and so the same for every design.
 */

export const TAU = Math.PI * 2;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeIn = (x: number) => Math.pow(clamp01(x), 3);
export const easeOutBack = (x: number) => {
  const k = clamp01(x);
  const c1 = 1.70158;
  return 1 + (c1 + 1) * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
};

/** The assistant's hues as a loop: any number lands on the violet → indigo → cyan ramp. */
export function aiCycle(p: Palette, at: number): Rgb {
  return aiHue(p, ((at % 1) + 1) % 1);
}

/** What a finish turns its mark: green for a run that landed, red for one that failed. */
export function endColor(p: Palette, failed: boolean): Rgb {
  return failed ? p.danger : p.success;
}

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${clamp01(alpha)})`;
}

/** Seconds since the run finished, or -1 while it runs. */
export interface FinishClock {
  readonly act: ThinkingActivity | undefined;
  readonly fin: number;
  /** The run ended in an error: the finish plays red, without the celebration. */
  readonly failed: boolean;
  set(activity: ThinkingActivity | undefined): void;
  step(dt: number): void;
  /** For a still frame: jump to the end pose when motion is reduced, so it shows where it lands. */
  settle(): void;
}

export function finishClock(): FinishClock {
  let act: ThinkingActivity | undefined;
  let fin = -1;
  return {
    get act() {
      return act;
    },
    get fin() {
      return fin;
    },
    get failed() {
      return !!act?.failed;
    },
    set(activity) {
      // A new `done` (or `failed`) object restarts the finish; `ThinkingOrb` only sends one when the
      // state actually changed, so a re-render never replays it.
      if (ended(activity) && activity !== act) fin = 0;
      if (!ended(activity)) fin = -1;
      act = activity;
    },
    step(dt) {
      if (fin >= 0) fin += dt;
    },
    settle() {
      if (ended(act) && prefersReducedMotion()) fin = 9;
    },
  };
}

export interface BurstBit {
  angle: number;
  speed: number;
  spin: number;
  hue: number;
  /** 0, 1 or 2 — what a burst draws for it (a green bit, a sparkle, a ribbon…). */
  kind: number;
}

/** A burst of bits fanned round the centre — seeded, so a finish looks the same every time. */
export function makeBurst(count: number, seed: number): BurstBit[] {
  let a = seed;
  const rnd = () => {
    a = (a * 9301 + 49297) % 233280;
    return a / 233280;
  };
  return Array.from({ length: count }, (_, i) => ({
    angle: (i / count) * TAU + rnd() * 0.5,
    speed: 0.75 + rnd() * 0.6,
    spin: rnd() * 6 - 3,
    hue: rnd(),
    kind: i % 3,
  }));
}
