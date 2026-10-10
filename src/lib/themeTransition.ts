import { flushSync } from "react-dom";
import { EASE_OUT, motionLevel, motionOff } from "./motion";

/**
 * A change of colour across the whole window — light/dark, and the accent — as a curtain rather
 * than a cut.
 *
 * Either one is a single synchronous write — `data-theme` plus a handful of CSS variables — so the
 * whole window changes colour between one frame and the next. That is correct and instant and
 * reads like a glitch. The View Transitions API lets the browser photograph the window before and
 * after, and animate between the two: here the new colours are wiped across the old ones from the
 * left edge, so the change has a direction and somewhere to have come from.
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

interface ViewTransitionLike {
  /** Settles when every animation on the pseudo-elements is over — and *rejects* when the
   *  transition is skipped, which is a finish as far as anything waiting on it is concerned. */
  finished?: Promise<unknown>;
}

type TransitionCapableDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike;
};

/** The app's motion level, which the system's reduce-motion setting forces to `off`. */
function prefersReducedMotion(): boolean {
  return motionOff();
}

/** The wipe on screen right now, or `null` between them. See [`afterThemeTransition`]. */
let playing: Promise<void> | null = null;

/**
 * Whether something on screen is drawn with a live backdrop blur — Settings' acrylic scrim, or a
 * see-through window's frosted panes.
 *
 * A View Transition plays photographs of the window, and the photographs WebKit takes have no
 * backdrop in them: under the wipe the acrylic behind Settings was simply gone, and came back when
 * the wipe ended (user report, 2026-10-10: "el acrílico … se sale y vuelve"). With one of these on
 * screen there is no wipe — see `recolor`.
 */
function acrylicOnScreen(): boolean {
  return document.documentElement.hasAttribute("data-glass") || document.querySelector(".cf-settings-scrim") !== null;
}

/** How long the colours take to cross over in place. Matches `.cf-recolor` in `index.css`. */
const RECOLOR_MS = 320;
let recolorTimer = 0;

/**
 * The full motion level's change of colour when a wipe cannot be used: the colours cross over in the
 * live document — every element's, for a third of a second — so whatever blurs keeps blurring.
 * Heavier than the wipe, which only moves a photograph; that is what the full level is for. At the
 * medium level the change is instant instead.
 */
function recolor(apply: () => void): void {
  const root = document.documentElement;
  root.classList.add("cf-recolor");
  let finish = () => {};
  const crossing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  playing = crossing;
  apply();
  window.clearTimeout(recolorTimer);
  recolorTimer = window.setTimeout(() => {
    root.classList.remove("cf-recolor");
    if (playing === crossing) playing = null;
    finish();
  }, RECOLOR_MS + 80);
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

  if (prefersReducedMotion()) {
    apply();
    return;
  }
  if (typeof doc.startViewTransition !== "function" || acrylicOnScreen()) {
    if (motionLevel() === "full") recolor(apply);
    else apply();
    return;
  }

  // Published *before* the transition is started rather than from the object it returns, because
  // `apply` is where the React commit happens: an effect in that commit calling
  // `afterThemeTransition` has to be able to see that a wipe is in progress, and nothing in the API
  // promises the callback runs later than this function does.
  let finish = () => {};
  const wipe = new Promise<void>((resolve) => {
    finish = resolve;
  });
  playing = wipe;
  const settle = () => {
    if (playing === wipe) playing = null;
    finish();
  };

  let transition: ViewTransitionLike;
  try {
    transition = doc.startViewTransition(() => {
      flushSync(apply);
    });
  } catch {
    // The callback cannot have run — this throws before it is reached — so the theme still has to
    // be applied. Same instant swap as a webview without the API, which is this module's contract.
    settle();
    apply();
    return;
  }

  // `finished` rejects on a skipped transition (a second theme change landing on top of this one is
  // the ordinary way that happens), so both settlements clear it. A wipe that never resolved would
  // leave everything waiting on it parked forever.
  if (transition.finished) void Promise.resolve(transition.finished).then(settle, settle);
  else settle();
}

/**
 * Defers `task` until the wipe currently on screen is over — or runs it straight away when there
 * isn't one. Returns a cancel function, so an effect can drop the work when it re-runs first.
 *
 * For the work a theme change triggers that is *too expensive to do underneath the animation*, as
 * opposed to the ordinary recolouring that has to happen inside it. The diagrams canvas is the
 * case: draw.io takes its theme from a URL parameter it reads once, so a light/dark flip reboots
 * the whole embedded editor — tens of megabytes of JavaScript — and doing that inside the
 * transition put a blank iframe in the "after" photograph and a cold editor boot on the main
 * thread for the whole half-second the wipe was trying to play. Held back, the wipe runs over the
 * canvas as it was and the reboot starts on a window that has stopped moving.
 *
 * The deferred work must be genuinely invisible under the curtain: this is for things that would
 * otherwise *replace* a region wholesale, not for colours, which have to be in the photograph.
 */
export function afterThemeTransition(task: () => void): () => void {
  let cancelled = false;

  // Re-checked after each wipe rather than chained to the one playing when this was called. A
  // second theme change lands on top of the first and *skips* it, which settles the first wipe
  // early — so waiting on that one alone would drop the work into the middle of the second
  // animation, which is the situation this whole function exists to avoid.
  const wait = () => {
    const wipe = playing;
    if (!wipe) {
      task();
      return;
    }
    void wipe.then(() => {
      if (!cancelled) wait();
    });
  };
  wait();

  return () => {
    cancelled = true;
  };
}

/**
 * A change of language at the full motion level — the words fade over instead of being swapped
 * between two frames (user, 2026-10-10: "cambia de repente"). Instant at the other levels.
 *
 * A cross-fade of the whole window where one can be photographed; where something acrylic is on
 * screen (Settings, which is where the language is chosen), the open dialog — or the window's
 * sheets — dims, takes the new words, and comes back: each fades its *own* opacity, which leaves
 * the blur behind it live. See `acrylicOnScreen`.
 */
export function withLanguageTransition(apply: () => void): void {
  if (motionLevel() !== "full") {
    apply();
    return;
  }
  const doc = document as TransitionCapableDocument;
  if (!acrylicOnScreen() && typeof doc.startViewTransition === "function") {
    const root = document.documentElement;
    // `index.css` swaps the theme's wipe for a cross-fade while this is set.
    root.dataset.vt = "crossfade";
    const clear = () => {
      if (root.dataset.vt === "crossfade") delete root.dataset.vt;
    };
    try {
      const transition = doc.startViewTransition(() => {
        flushSync(apply);
      });
      if (transition.finished) void Promise.resolve(transition.finished).then(clear, clear);
      else clear();
    } catch {
      clear();
      apply();
    }
    return;
  }
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'));
  const targets = dialogs.length > 0 ? dialogs : Array.from(document.querySelectorAll<HTMLElement>(".cf-sheet, #cf-sidebar"));
  const dim = targets.map((el) => el.animate([{ opacity: 1 }, { opacity: 0.15 }], { duration: 120, easing: "ease-in", fill: "forwards" }));
  void Promise.all(dim.map((animation) => animation.finished)).then(
    () => {
      flushSync(apply);
      targets.forEach((el, i) => {
        // The way back starts before the dimmed frame is let go, so no frame shows either extreme.
        el.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 240, easing: EASE_OUT });
        dim[i].cancel();
      });
    },
    () => apply(),
  );
}
