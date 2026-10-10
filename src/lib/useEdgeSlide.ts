import { useLayoutEffect, useRef, useState } from "react";
import { motionLevel } from "./motion";

/**
 * A panel at a window edge — the projects sidebar, the AI panel — opening and closing as a slide
 * instead of appearing at its width (user, 2026-10-10: "no se ve fluido al abrirse").
 *
 * The panel's real width is what moves, so the view beside it is laid out again on every frame —
 * which is the only way what the view centres or pins to its far side travels with the edge. A
 * first version slid the panel over the view with `transform` and laid the view out once, when it
 * landed: compositor-only, but the editor's changes strip and its centred hint jumped at the end
 * ("se cortan", same day). The panel's own contents keep their width throughout and are uncovered
 * by the moving edge, never reflowed. The one consumer that must not pay for the per-frame layout is
 * a terminal — each new width is a pty resize and a redraw in the shell — so it waits for the edge
 * to land (`edgeMoving`, below).
 *
 * The phase says what to render:
 * - `open` / `closed`: settled.
 * - `sliding`: the panel is rendered and its width is moving, in either direction. A panel toggled
 *   mid-slide turns round where it is (`Animation.reverse`).
 *
 * `build` makes the slide's animations once the `sliding` render is in the DOM (it can measure), and
 * gets back what to undo once the panel has settled. At the `off` motion level there is no slide.
 */
export type EdgePhase = "open" | "closed" | "sliding";

export interface EdgeSlide {
  animations: Animation[];
  /** Runs once the panel has settled and its real layout is on screen — inline styles to drop. */
  settle?: () => void;
}

/** One slide's timing at the motion level in force. `fill: "both"` holds the last frame until the
 *  commit that puts the settled layout under it. */
export function slideTiming(): KeyframeAnimationOptions {
  return motionLevel() === "full"
    ? { duration: 440, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" }
    : { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "both" };
}

/**
 * Edges that move by their real width — the full motion level's way (see `AiEdge`, `Sidebar`): the
 * view beside them is laid out again on every frame, which is what lets what is centred in it or
 * pinned to its far side travel with the edge instead of jumping once it lands (user report,
 * 2026-10-10: the editor's changes strip and its centred hint "se cortan"). The cost is the
 * reflow, and the one consumer that must not pay it per frame is a terminal: every new width is a
 * pty resize and a redraw in the shell. So a terminal asks `edgeMoving()` before it fits, and fits
 * once when the edge has landed.
 */
let moving = 0;
const waiting = new Set<() => void>();

export function edgeMoving(): boolean {
  return moving > 0;
}

/** Runs `task` once every edge resizing now has landed. */
export function whenEdgeSettles(task: () => void): void {
  waiting.add(task);
}

/** Marks an edge as resizing; the function returned marks it landed (once, however often called). */
export function beginEdgeResize(): () => void {
  moving += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    moving -= 1;
    if (moving > 0) return;
    const tasks = [...waiting];
    waiting.clear();
    for (const task of tasks) task();
  };
}

export function useEdgeSlide(open: boolean, build: (opening: boolean) => EdgeSlide | null): EdgePhase {
  const [phase, setPhase] = useState<EdgePhase>(open ? "open" : "closed");
  const buildRef = useRef(build);
  const running = useRef<{ slide: EdgeSlide; opening: boolean } | null>(null);
  const spent = useRef<EdgeSlide | null>(null);

  useLayoutEffect(() => {
    buildRef.current = build;
  });

  useLayoutEffect(() => {
    if (phase === "sliding") {
      const run = running.current;
      if (run) {
        // Already moving and asked the other way: turn round from where it is.
        if (run.opening !== open) {
          run.opening = open;
          for (const animation of run.slide.animations) animation.reverse();
        }
        return;
      }
      const slide = buildRef.current(open);
      if (!slide || slide.animations.length === 0) {
        slide?.settle?.();
        setPhase(open ? "open" : "closed");
        return;
      }
      const mine = { slide, opening: open };
      running.current = mine;
      void Promise.all(slide.animations.map((animation) => animation.finished)).then(
        () => {
          if (running.current !== mine) return;
          running.current = null;
          spent.current = slide;
          setPhase(mine.opening ? "open" : "closed");
        },
        // Cancelled — unmounted mid-slide. Nothing left to settle into.
        () => {},
      );
      return;
    }

    // Settled. The slide that got here is holding its last frame; this commit has put the real
    // layout under it, so it can go now without a frame of either.
    const done = spent.current;
    if (done) {
      spent.current = null;
      for (const animation of done.animations) animation.cancel();
      done.settle?.();
    }
    // Asked to move — or asked again while the last slide was landing.
    if ((phase === "open") !== open) setPhase(motionLevel() === "off" ? (open ? "open" : "closed") : "sliding");
  }, [open, phase]);

  useLayoutEffect(
    () => () => {
      for (const slide of [running.current?.slide, spent.current]) {
        if (!slide) continue;
        for (const animation of slide.animations) animation.cancel();
        slide.settle?.();
      }
    },
    [],
  );

  return phase;
}
