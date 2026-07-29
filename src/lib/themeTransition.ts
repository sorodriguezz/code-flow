import { flushSync } from "react-dom";

/**
 * The light/dark switch, as a curtain rather than a cut.
 *
 * Swapping the theme is a single synchronous write — `data-theme` plus a handful of CSS variables —
 * so the whole window changes colour between one frame and the next. That is correct and instant
 * and reads like a glitch. The View Transitions API lets the browser photograph the window before
 * and after, and animate between the two: here the new theme is wiped down over the old one from
 * the top edge, so the change has a direction and somewhere to have come from.
 *
 * The animation itself is CSS (`::view-transition-*(root)` and the `cf-theme-wipe` keyframes in
 * `index.css`). This module only decides *when* a transition is worth starting; keeping the two
 * apart is what lets the wipe be re-timed or replaced without touching a store.
 *
 * Two ways out, both of which fall back to the instant swap that was there before:
 *
 *  - **No View Transitions API.** Tauri's webview is the platform's own: WebKit on macOS, WebView2
 *    on Windows, WebKitGTK on Linux. The first two have had this for a while; some Linux builds
 *    have not, and a missing API must degrade to a working theme switch, not to no theme switch.
 *  - **`prefers-reduced-motion: reduce`.** A full-window wipe is exactly the kind of large-area
 *    motion that setting exists to suppress.
 */

type TransitionCapableDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Runs `apply` — the writes that actually change the theme — inside a view transition when the
 * platform has one.
 *
 * `apply` must do *all* of its painting synchronously. The browser captures the "after" photograph
 * as soon as the callback has settled, so anything deferred to a later frame is missing from it and
 * lands with a second, un-animated flash once the wipe is over. That is also why the React update
 * goes through `flushSync`: batched by default, it would commit after the photograph was taken, and
 * every component that reads the theme (Monaco, the terminal, the response viewer) would repaint a
 * beat late.
 */
export function withThemeTransition(apply: () => void): void {
  const doc = document as TransitionCapableDocument;

  if (typeof doc.startViewTransition !== "function" || prefersReducedMotion()) {
    apply();
    return;
  }

  doc.startViewTransition(() => {
    flushSync(apply);
  });
}
