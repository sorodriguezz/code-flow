import { INK } from "./face";
import { rgba, TAU } from "./finish";
import { mix, type Rgb } from "./palette";

/** One lighting model for curved surfaces. The highlight moves a little as the subject turns. */
export function material(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  [light, body, rim]: readonly [Rgb, Rgb, Rgb], alpha: number, turn = 0,
): CanvasGradient {
  const fill = ctx.createRadialGradient(x + r * (turn * 0.18 - 0.35), y - r * 0.39, r * 0.025, x, y, r);
  fill.addColorStop(0, rgba(light, alpha));
  fill.addColorStop(0.48, rgba(body, alpha));
  fill.addColorStop(0.86, rgba(rim, alpha));
  fill.addColorStop(1, rgba(mix(rim, INK, 0.27), alpha));
  return fill;
}

/** The face follows a curved surface. The far side recedes instead of sliding as a flat sticker. */
export function faceAt(x: number, y: number, radius: number, turn: number, pitch: number) {
  const angle = Math.asin((x - 0.5) / radius) + turn;
  const front = Math.max(0, Math.cos(angle));
  return { x: 0.5 + Math.sin(angle) * radius, y: y + pitch + 0.04 * (1 - front), width: 0.5 + front * 0.5 };
}

/** Soft, flattened shadow beneath a character or suspended object. */
export function contactShadow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: Rgb, alpha: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.2);
  const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  fill.addColorStop(0, rgba(mix(INK, color, 0.35), alpha));
  fill.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}
