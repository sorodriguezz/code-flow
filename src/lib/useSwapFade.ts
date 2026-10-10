import { useLayoutEffect, useRef, type RefObject } from "react";
import { EASE_OUT, motionLevel } from "./motion";

/** `cf-panel-in`'s fade, in the Web Animations API's terms — the two must read as one motion. At
 *  the full level it rises as well, as `cf-panel-in` does there. */
const FADE: KeyframeAnimationOptions = { duration: 180, easing: EASE_OUT };
const RISE: KeyframeAnimationOptions = { duration: 320, easing: EASE_OUT };

/**
 * Fades a panel's contents in when what it shows changes — for a panel that stays mounted while its
 * contents are swapped (a settings section, the dock's Terminal/Services/Containers, the sidebar
 * folding to its rail), where `cf-panel-in` has no arrival to play on.
 *
 * The Web Animations API rather than a remount under a `key`: a remount would throw away state the
 * panel keeps across the swap, and the class trick the views use needs a `display: none` in between.
 * One opacity animation handed to the compositor — no state, no re-render, nothing per frame on the
 * main thread. A layout effect, so the new contents are never painted once at full strength first.
 *
 * Not on the first render: the panel arriving is its own fade (or none), and the contents fading
 * again inside it would only make the arrival slower.
 */
export function useSwapFade(ref: RefObject<HTMLElement | null>, key: unknown): void {
  // The key last shown, rather than a "first run" flag: StrictMode runs a mount's effects twice, and
  // the second run would read as a swap.
  const shown = useRef(key);
  useLayoutEffect(() => {
    if (Object.is(shown.current, key)) return;
    shown.current = key;
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const level = motionLevel();
    if (level === "off") return;
    if (level === "full") el.animate([{ opacity: 0, translate: "0 10px" }, { opacity: 1, translate: "0 0" }], RISE);
    else el.animate([{ opacity: 0 }, { opacity: 1 }], FADE);
  }, [ref, key]);
}
