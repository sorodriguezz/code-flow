import type { Gaze } from "./face";

/**
 * The pointer, for marks that follow it (`ThinkingOrb follow` — the assistant's button on the rail;
 * the user: "que siga el mouse con los ojos"): the eyes of the designs that have them, and since
 * then the turn, lean or light of the ones that do not (`toward`, `lean`), and how close it is
 * (`nearness`), which every design perks up for.
 *
 * One window listener however many marks follow, and at most one notification a frame: pointer
 * events arrive faster than anything is painted, and each follower measures its own rect on the
 * notification. `null` is "not over this window" — the pointer left it — and the eyes go back to
 * looking around by themselves.
 */

type Listener = (at: { x: number; y: number } | null) => void;

const listeners = new Set<Listener>();
let at: { x: number; y: number } | null = null;
let frame = 0;

function flush() {
  frame = 0;
  for (const listener of listeners) listener(at);
}

function schedule() {
  frame ||= requestAnimationFrame(flush);
}

function onMove(event: PointerEvent) {
  at = { x: event.clientX, y: event.clientY };
  schedule();
}

/** `mouseout` with nowhere to go is the pointer leaving the window — `pointerleave` does not fire on
 *  the document in every engine. */
function onOut(event: MouseEvent) {
  if (event.relatedTarget) return;
  at = null;
  schedule();
}

/** Told where the pointer is, in client pixels, each frame it moves. Returns its own unsubscribe. */
export function watchPointer(listener: Listener): () => void {
  if (listeners.size === 0) {
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("mouseout", onOut);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("mouseout", onOut);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    at = null;
  };
}

/** How far away the pointer has to be for the eyes to look all the way round to it. Nearer, they turn
 *  part of the way — a pointer resting on the button gets looked at, not past. */
const REACH_PX = 140;

/** The direction from the centre of `rect` to the point, as a mark's eyes take it: (x, y) in -1..1. */
export function gazeAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Gaze {
  const dx = x - (rect.left + rect.width / 2);
  const dy = y - (rect.top + rect.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return [0, 0];
  const reach = Math.min(1, distance / REACH_PX);
  return [(dx / distance) * reach, (dy / distance) * reach];
}

/**
 * A gaze followed smoothly, for the designs without eyes — they turn, lean or light up toward the
 * pointer, and a shape that snapped to it would twitch. `x`, `y` ease toward the gaze; `on` fades
 * in while there is a pointer to follow and out when there is none (it left the window, or the run
 * stopped being one to look up from), so a design comes back to rest instead of jumping there.
 */
export interface Toward {
  x: number;
  y: number;
  on: number;
}

export function toward(): Toward {
  return { x: 0, y: 0, on: 0 };
}

/** One tick of `t` toward `gaze` — `null` lets it go back to rest. */
export function easeToward(t: Toward, gaze: Gaze, dt: number, rate = 5): void {
  const k = Math.min(1, dt * rate);
  t.x += ((gaze ? gaze[0] : 0) - t.x) * k;
  t.y += ((gaze ? gaze[1] : 0) - t.y) * k;
  t.on += ((gaze ? 1 : 0) - t.on) * k;
}

/** How hard it is leaning: 0 at rest or with the pointer on top of it, 1 turned all the way. */
export function leanOf(t: Toward): number {
  return t.on * Math.min(1, Math.hypot(t.x, t.y));
}

/**
 * A point of a flat drawing turned toward the pointer, as if the drawing were a disc tilting in 3D
 * to face it: the side toward the pointer comes nearer — further out and larger — the far side
 * recedes, and the whole drifts a little toward it. `x`, `y` are offsets from the drawing's centre
 * and `reach` its radius, in the same units; the third value is how much nearer the point came, for
 * whatever is drawn there to grow with it.
 */
export function lean(t: Toward, x: number, y: number, reach: number): [number, number, number] {
  const m = leanOf(t);
  if (m < 1e-3) return [x, y, 1];
  const length = Math.hypot(t.x, t.y);
  const dx = t.x / length;
  const dy = t.y / length;
  const along = x * dx + y * dy;
  const across = y * dx - x * dy;
  const nearer = 1 + 0.15 * m * (along / reach);
  const moved = along * (1 - 0.1 * m) + reach * 0.08 * m;
  return [(moved * dx - across * dy) * nearer, (moved * dy + across * dx) * nearer, nearer];
}

/** How much a point faces the pointer, 0–1: 1 at the drawing's edge on the pointer's side, 0 at
 *  its centre and everywhere on the far half. Times `leanOf`, so it is 0 at rest. */
export function facing(t: Toward, x: number, y: number, reach: number): number {
  const m = leanOf(t);
  if (m < 1e-3) return 0;
  const length = Math.hypot(t.x, t.y);
  return Math.max(0, Math.min(1, (x * t.x + y * t.y) / length / reach)) * m;
}

/** From how far away the pointer starts to count as coming close, in px from the mark's edge. */
const NEAR_PX = 120;

/**
 * How close the pointer is to `rect`, 0–1: 1 over it, falling to 0 at `NEAR_PX` from its edge —
 * eased, so the mark perks up as the pointer arrives rather than at an even rate all the way in.
 */
export function nearness(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): number {
  const dx = Math.max(rect.left - x, 0, x - (rect.left + rect.width));
  const dy = Math.max(rect.top - y, 0, y - (rect.top + rect.height));
  const k = Math.max(0, 1 - Math.hypot(dx, dy) / NEAR_PX);
  return k * k * (3 - 2 * k);
}
