import { rgba } from "./finish";
import type { Rgb } from "./palette";

/**
 * What the character marks share — the cat, the ghost, the crab: how they blink, how a
 * closed, happy or knocked-out eye is drawn, the heart they throw when they finish and the "z" they
 * sleep under. One drawing of each, so the characters read as one family and a fix lands in all.
 *
 * Every function takes CSS-pixel coordinates; `u` in the painters converts from the 0–1 square.
 */

export const WHITE: Rgb = [255, 255, 255];
/** The dark of pupils and mouths: near-black with the assistant's violet in it. */
export const INK: Rgb = [18, 12, 36];

/** How open the eyes are: a quick blink every `period` seconds, 1 the rest of the time. */
export function blink(time: number, period = 3.4): number {
  const k = time % period;
  const at = period - 0.15;
  return k > at ? Math.abs((k - at - 0.075) / 0.075) : 1;
}

/** One stroked eye shape, `r` its half-width: `happy` is ^, `closed` is ‿ (asleep), `x` is X. */
export function strokeEye(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  kind: "happy" | "closed" | "x",
  color: string,
  width: number,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (kind === "happy") {
    ctx.moveTo(x - r, y + r * 0.35);
    ctx.quadraticCurveTo(x, y - r * 1.05, x + r, y + r * 0.35);
  } else if (kind === "closed") {
    ctx.moveTo(x - r, y);
    ctx.quadraticCurveTo(x, y + r * 0.75, x + r, y);
  } else {
    const k = r * 0.75;
    ctx.moveTo(x - k, y - k);
    ctx.lineTo(x + k, y + k);
    ctx.moveTo(x + k, y - k);
    ctx.lineTo(x - k, y + k);
  }
  ctx.stroke();
  ctx.restore();
}

/** How loud a syllable is, 0–1, for the voice at `level` (`voiceLevel`): 0 under a murmur — so a
 *  mouth shuts between words, and the preview's stand-in voice, which never drops below 0.3, still
 *  closes it — and 1 on the loud ones. Lip-sync, and every cue that moves with the voice, for the
 *  characters that read it themselves. */
export function lipSync(level: number): number {
  return Math.max(0, Math.min(1, (level - 0.28) / 0.6));
}

/** A filled heart centred near (x, y), `r` about its half-width. */
export function fillHeart(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.9);
  ctx.bezierCurveTo(x - r * 1.6, y - r * 0.2, x - r * 0.6, y - r * 1.3, x, y - r * 0.45);
  ctx.bezierCurveTo(x + r * 0.6, y - r * 1.3, x + r * 1.6, y - r * 0.2, x, y + r * 0.9);
  ctx.fill();
}

/** The sleeper's "z", drifting up out of the top-right corner of a `px` square and fading. */
export function sleepZ(ctx: CanvasRenderingContext2D, px: number, time: number, color: Rgb, alpha: number) {
  const k = (time % 1.8) / 1.8;
  const w = px * 0.11 * (1 - k * 0.3);
  const x = px * 0.8;
  const y = px * (0.22 - k * 0.14);
  ctx.save();
  ctx.strokeStyle = rgba(color, (1 - k) * alpha);
  ctx.lineWidth = Math.max(0.8, px * 0.03);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x, y + w);
  ctx.lineTo(x + w, y + w);
  ctx.stroke();
  ctx.restore();
}

/** Where a character's eyes go while it thinks — (x, y) in -1..1, held a beat each. */
export const LOOK_AROUND: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.9, -0.6],
  [0.9, -0.6],
  [0, 0],
  [-1, 0.1],
  [-0.8, -0.5],
  [0, 0.4],
  [0.5, -1],
];

/** The eyes' target for a phase: around while thinking, along lines while reading, down at the
 *  page while writing, and on a darting point while working. */
export function lookFor(phase: string | undefined, time: number): readonly [number, number] {
  switch (phase) {
    case "read":
    case "search": {
      const along = (time * 0.7) % 1;
      const line = Math.floor(time * 0.7) % 3;
      return [along * 2 - 1, -0.5 + line * 0.5];
    }
    case "edit":
    case "run":
    case "tool":
      return [Math.sin(time * 3.1) * 0.9, Math.sin(time * 4.3) * 0.6];
    case "write":
      return [0, 0.5];
    case "start":
      return [0, 0];
    default:
      return LOOK_AROUND[Math.floor(time / 0.8) % LOOK_AROUND.length];
  }
}
