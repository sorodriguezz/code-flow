import { useEffect, useMemo, useRef } from "react";

/**
 * Turns a "call me with the latest value" callback into one that fires at most once per painted
 * frame, with the newest value it was given.
 *
 * Written for `onScroll`, which is where it matters. A scroll event fires far more often than the
 * screen updates — a trackpad fling on a 120 Hz panel produces several per frame, and a wheel can
 * produce dozens — and a handler that calls `setState` on each one asks React for a full render
 * per event. Every render but the last is discarded before anything is painted, so the work is
 * pure waste: the browser was always going to draw one frame with one scroll position.
 *
 * The visible result is identical, because a frame is exactly the granularity the screen has.
 * Nothing is dropped either: the value from the last event before the frame is the one delivered,
 * which is the same value the unthrottled version would have ended on.
 *
 * The returned function is stable for the life of the component, so it can be passed straight to a
 * JSX prop without making the element re-render, and a pending frame is cancelled on unmount.
 */
export function useFrameThrottle<T>(fn: (value: T) => void): (value: T) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const frame = useRef<number | null>(null);
  const latest = useRef<T | null>(null);

  const throttled = useMemo(
    () => (value: T) => {
      latest.current = value;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        fnRef.current(latest.current as T);
      });
    },
    [],
  );

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return throttled;
}
