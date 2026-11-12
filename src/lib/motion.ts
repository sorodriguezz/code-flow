import { useMotionStore, type MotionLevel } from "../state/motionStore";

/**
 * The motion level in force, for animations driven from script — the Web Animations API calls in
 * `useSwapFade` and `useEdgeSlide`. Read off the root, where `motionStore` stamps it (already `off`
 * when the system asks for reduced motion), so CSS and script can never disagree about it.
 */
export function motionLevel(): MotionLevel {
  const stamped = typeof document === "undefined" ? undefined : document.documentElement.dataset.motion;
  return stamped === "off" || stamped === "full" ? stamped : "medium";
}

/** The arrival curve `cf-panel-in` uses — fast out, long settle. */
export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Whether nothing should move — the `off` level, which the system's reduce-motion setting forces. */
export function motionOff(): boolean {
  return motionLevel() === "off";
}

/** The motion level in force, for a component that has to re-render when it changes. */
export function useMotionLevel(): MotionLevel {
  return useMotionStore((s) => s.effective);
}

/** How a programmatic scroll should travel: smoothly, unless nothing is to move. */
export function scrollBehavior(): ScrollBehavior {
  return motionOff() ? "auto" : "smooth";
}

/**
 * How long a modal takes to leave — what `useExitPresence` keeps it mounted for. Keep in step with
 * `cf-modal-out` / `cf-scrim-out` in `index.css` (0.14s, and 0.22s at the full level). A beat
 * shorter than the arrival: what is leaving is no longer what the user is looking at.
 */
export function modalExitMs(): number {
  const level = motionLevel();
  return level === "off" ? 0 : level === "full" ? 220 : 140;
}
