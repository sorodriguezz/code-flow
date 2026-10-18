import { useEffect, useState } from "react";

/**
 * `Date.now()`, refreshed every `everyMs` while `active` — and only while the window is showing.
 *
 * For the clocks of things in progress (a flow run's elapsed time, its timeline). A plain interval
 * kept re-rendering the view behind them with the window minimised or another app in front, and a
 * run parked on an approval kept it up for days. Hidden, nothing ticks; shown again, the clock
 * jumps straight to the right time, so nothing on screen is ever stale.
 */
export function useLiveNow(active: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!active || !visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, visible, everyMs]);

  return now;
}
