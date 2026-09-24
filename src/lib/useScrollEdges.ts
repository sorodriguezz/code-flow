import { useEffect, useState, type RefObject } from "react";

export interface ScrollEdges {
  /** Something is scrolled out of view before — above, or to the left. */
  start: boolean;
  /** Something is still out of view after — below, or to the right. */
  end: boolean;
}

export type ScrollAxis = "x" | "y";

const NONE: ScrollEdges = { start: false, end: false };

/**
 * Whether a scroller has more to show before or after what is in view — above and below, or left
 * and right with `axis: "x"` — for the cue that says so.
 *
 * Written for the settings rail, which folds to a column of icons with no scrollbar at all (a 10px
 * gutter would be a fifth of it): on a short screen the list simply ended at the window's edge, and
 * nothing said there were sections under it (user report). The API request's section tabs use it
 * sideways, where a hidden scrollbar left the last tab cut mid-word.
 *
 * Re-measured on scroll and whenever the scroller or its content changes size — a fold, a search
 * narrowing the list, a window resize — at most once a frame, and it only re-renders when an answer
 * actually flips. It watches the scroller's direct children, so wrap a list whose rows come and go
 * in one element: that is the child whose size says how much there is to scroll.
 */
export function useScrollEdges(
  ref: RefObject<HTMLElement | null>,
  active = true,
  axis: ScrollAxis = "y",
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NONE);

  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // A pixel of slack either way: fractional layout leaves the offset a hair off the end.
      const offset = axis === "y" ? el.scrollTop : el.scrollLeft;
      const view = axis === "y" ? el.clientHeight : el.clientWidth;
      const total = axis === "y" ? el.scrollHeight : el.scrollWidth;
      const start = offset > 1;
      const end = offset + view < total - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [ref, active, axis]);

  return edges;
}

/**
 * The fade that goes with it: the list melts into the edge it continues past, instead of stopping
 * against it like a list that ends there. For `mask-image`, so it works on any background.
 */
export function scrollEdgeMask({ start, end }: ScrollEdges, size = 28, axis: ScrollAxis = "y"): string | undefined {
  const to = axis === "y" ? "to bottom" : "to right";
  if (start && end) return `linear-gradient(${to}, transparent, #000 ${size}px, #000 calc(100% - ${size}px), transparent)`;
  if (end) return `linear-gradient(${to}, #000 calc(100% - ${size}px), transparent)`;
  if (start) return `linear-gradient(${to}, transparent, #000 ${size}px)`;
  return undefined;
}
