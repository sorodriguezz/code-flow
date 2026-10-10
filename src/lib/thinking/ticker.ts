import type { ThinkingActivity } from "./activity";
import { motionOff } from "../motion";

/**
 * Something that draws a thinking mark onto its own canvas.
 *
 * `tick` advances it by `dt` seconds and paints; `still` paints one resting frame — what a reader
 * who asked for reduced motion sees, and what a mark shows before its first tick.
 */
export interface Painter {
  tick(dt: number): void;
  still(): void;
  setActivity(activity: ThinkingActivity | undefined): void;
  destroy?(): void;
}

/** The px size each `ThinkingOrb` size paints at — the CSS square it fills (`.cf-orb-*`). */
export const ORB_PX = { sm: 14, md: 22, card: 32, lg: 44 } as const;
export type OrbSize = keyof typeof ORB_PX;

/**
 * Sizes a canvas for crisp drawing at `px` CSS pixels and hands back a context in CSS pixels.
 * Capped at 2× — a 14px mark has nothing to gain from a 3× buffer but its cost.
 */
export function prepareCanvas(canvas: HTMLCanvasElement, px: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(px * dpr);
  canvas.height = Math.round(px * dpr);
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

interface Entry {
  painter: Painter;
  el: Element;
  visible: boolean;
}

/**
 * One animation loop for every canvas mark in the window.
 *
 * A task list can show a dozen running rows; a dozen `requestAnimationFrame` loops would each wake
 * the page every frame. This is one loop, and it only paints marks that are on screen: an
 * IntersectionObserver keeps each entry's `visible`, which also covers the kept-alive bodies the
 * app hides with `display: none` (they never intersect). With nothing visible, or the window in
 * the background, the loop stops altogether and restarts when something comes back.
 */
const entries = new Set<Entry>();
let frame = 0;
let last = 0;
let observer: IntersectionObserver | null = null;
let listening = false;

/** The app's motion level at `off` — which the system's reduce-motion setting forces. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && motionOff();
}

export function register(el: Element, painter: Painter): () => void {
  const entry: Entry = { painter, el, visible: true };
  entries.add(entry);
  painter.still();
  if (typeof IntersectionObserver !== "undefined") {
    observer ??= new IntersectionObserver((records) => {
      for (const record of records) {
        for (const e of entries) if (e.el === record.target) e.visible = record.isIntersecting;
      }
      start();
    });
    observer.observe(el);
  }
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", start);
  }
  start();
  return () => {
    entries.delete(entry);
    observer?.unobserve(el);
  };
}

function start() {
  if (frame || prefersReducedMotion() || document.hidden) return;
  if (![...entries].some((e) => e.visible)) return;
  last = 0;
  frame = requestAnimationFrame(loop);
}

function loop(now: number) {
  frame = 0;
  // Clamped: a tab that slept for a minute resumes where it was, not a minute further on.
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  let any = false;
  for (const entry of entries) {
    if (!entry.visible) continue;
    any = true;
    entry.painter.tick(dt);
  }
  if (any && !document.hidden) frame = requestAnimationFrame(loop);
}
