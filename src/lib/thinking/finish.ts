import type { ThinkingActivity } from "./activity";
import { aiHue, type Palette, type Rgb } from "./palette";
import { prefersReducedMotion } from "./ticker";

/**
 * What the marks with a finish animation share: the clock that plays it once, the easings, the
 * tick some of them draw, and the bursts of bits they throw.
 *
 * A finish is the few hundred milliseconds between a turn landing and the avatar taking the mark's
 * place (`AssistantAvatar` waits `finishMs` for it — see `lib/thinkingDesigns`). It plays when the
 * mark is told `done`, from the start, every time a new `done` arrives; under reduced motion the
 * mark shows its end pose straight away.
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

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${clamp01(alpha)})`;
}

/** Seconds since the run finished, or -1 while it runs. */
export interface FinishClock {
  readonly act: ThinkingActivity | undefined;
  readonly fin: number;
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
    set(activity) {
      // A new `done` object restarts the finish; `ThinkingOrb` only sends one when the state
      // actually changed, so a re-render never replays it.
      if (activity?.done && activity !== act) fin = 0;
      if (!activity?.done) fin = -1;
      act = activity;
    },
    step(dt) {
      if (fin >= 0) fin += dt;
    },
    settle() {
      if (act?.done && prefersReducedMotion()) fin = 9;
    },
  };
}

/** A tick drawn as a stroke, `progress` 0–1 along its two arms. */
export function drawCheck(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  progress: number,
  color: string,
  width: number,
) {
  if (progress <= 0) return;
  const pts = [
    [-0.42, 0.02],
    [-0.12, 0.32],
    [0.45, -0.3],
  ] as const;
  const l1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const l2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
  const len = (l1 + l2) * clamp01(progress);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx + pts[0][0] * size, cy + pts[0][1] * size);
  if (len <= l1) {
    const k = len / l1;
    ctx.lineTo(cx + (pts[0][0] + (pts[1][0] - pts[0][0]) * k) * size, cy + (pts[0][1] + (pts[1][1] - pts[0][1]) * k) * size);
  } else {
    const k = (len - l1) / l2;
    ctx.lineTo(cx + pts[1][0] * size, cy + pts[1][1] * size);
    ctx.lineTo(cx + (pts[1][0] + (pts[2][0] - pts[1][0]) * k) * size, cy + (pts[1][1] + (pts[2][1] - pts[1][1]) * k) * size);
  }
  ctx.stroke();
  ctx.restore();
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
