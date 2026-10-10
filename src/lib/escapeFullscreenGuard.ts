import { isMac } from "./platform";

/**
 * Keeps Escape from taking the window out of macOS fullscreen.
 *
 * WKWebView hands every key the page leaves unclaimed back to AppKit, and an unclaimed Escape in a
 * fullscreen window is AppKit's "leave fullscreen". So closing Settings with Escape — or any of the
 * ninety-odd panels and fields that answer Escape without calling `preventDefault` — also shrank the
 * window back out of its Space (user report, 2026-10-10). Measured in a bare WKWebView: an Escape
 * nobody prevents exits fullscreen, the same Escape prevented at the end of its dispatch does not.
 *
 * Escape is the app's key, never the window's: the green button, ⌃⌘F and the menu bar remain the
 * ways out of fullscreen, as in every editor.
 *
 * ## Why the claim is the *last* listener, not the first
 *
 * Handlers read `defaultPrevented` to decide whether Escape is still theirs — Settings stands down
 * when a dialog over it already answered (see `SettingsView`). Preventing it up front would make
 * every one of them stand down. So the capture-phase listener only books a bubble-phase listener on
 * `window` for this one event: added during the dispatch, it lands after every listener `window`
 * already had, and the platform's default is cancelled once the app has had its say.
 *
 * A handler that stops propagation never lets the event reach that listener, so stopping an Escape
 * claims it on the spot — whoever stops it has answered it.
 */
export function startEscapeFullscreenGuard() {
  if (!isMac()) return;

  let pending: ((event: KeyboardEvent) => void) | null = null;

  window.addEventListener(
    "keydown",
    (event) => {
      // Mid-composition, Escape cancels the IME's candidate window — that default stays.
      if (event.key !== "Escape" || event.isComposing) return;

      // Left over from an Escape whose propagation was stopped before it reached `window`. Still
      // registered, it would now sit *before* listeners added since and pre-empt them.
      if (pending) window.removeEventListener("keydown", pending);
      const claim = (later: KeyboardEvent) => {
        pending = null;
        if (later === event) event.preventDefault();
      };
      pending = claim;
      window.addEventListener("keydown", claim, { once: true });

      for (const method of ["stopPropagation", "stopImmediatePropagation"] as const) {
        const stop = event[method].bind(event);
        event[method] = () => {
          event.preventDefault();
          stop();
        };
      }
    },
    true,
  );
}
