import { useLayoutEffect, useState } from "react";

/**
 * Whether something gated on `open` should still be mounted: `true` while it is open, and for
 * `exitMs()` more once it closes, so it can play its way out instead of vanishing.
 *
 * The caller renders while this is `true` and tells the two phases apart by `open` itself — mounted
 * with `open` false *is* the exit. Reopening during an exit simply keeps it mounted: the pending
 * unmount is cancelled and nothing remounts, so whatever state the thing held carries through.
 *
 * `exitMs` is read at the moment of closing rather than passed as a number, so it can follow the
 * motion level in force right then (`motionLevel()`); at `0` — motion off — it unmounts before the
 * next paint, exactly as an ungated `open &&` would have.
 */
export function useExitPresence(open: boolean, exitMs: () => number): boolean {
  const [shown, setShown] = useState(open);
  // Adjusted during render, not in an effect: a render where `open` is true but `shown` is not yet
  // would otherwise leave the opening frame unmounted.
  if (open && !shown) setShown(true);

  useLayoutEffect(() => {
    if (open || !shown) return;
    const ms = exitMs();
    if (ms <= 0) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(false), ms);
    return () => window.clearTimeout(timer);
    // `exitMs` is read once per close; a new function identity each render must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shown]);

  return open || shown;
}
