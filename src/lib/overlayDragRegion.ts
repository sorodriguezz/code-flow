import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "./platform";
import { toggleMaximize } from "./windowControls";

/**
 * Keeps the title bar draggable while a modal's backdrop is covering it.
 *
 * Every dialog in the app dims the window behind it with a `fixed inset-0` backdrop, and that
 * backdrop covers the title bar too — deliberately, because a bar left bright above a dimmed app
 * reads as still being live. But Tauri decides what drags from the element the press *landed on*,
 * and with a backdrop in the way that element is never the bar: the window goes rigid the moment
 * any dialog opens, which for a modal you have to read before answering is exactly when you might
 * want to move the window to see what is behind it.
 *
 * So the press is resolved a second time, against what the backdrop is covering. Only the backdrop
 * is stepped through — the dialog itself, and every other element on screen, still gets the press
 * it would have got. What is underneath decides by Tauri's own rules (`isDragRegion` below is its
 * `drag.js` walk, kept identical on purpose), so the bar's buttons, the `deep` region and the AI
 * menu's `data-tauri-drag-region="false"` opt-out all mean here what they mean everywhere else.
 *
 * The one behaviour this trades away is closing a dialog by clicking the backdrop *in the title bar
 * strip*, which now drags instead. That is the same bargain every native window makes: the top of
 * the window belongs to the window.
 *
 * The buttons at the other end of the bar are the same bargain seen from the other side: minimize,
 * maximize and close are the window's, not the app's, and a covered one is handed its press back
 * rather than losing it to the backdrop.
 */

/** Tags that swallow a press instead of dragging with it — Tauri's list, verbatim. */
const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);

/**
 * The window's own buttons, marked in the title bar so a backdrop over them can tell them apart
 * from the app's controls — which stay blocked, because a dialog is up precisely so the app is not
 * used until it is answered.
 *
 * macOS has none of these elements: its traffic lights are real AppKit buttons painted above the
 * webview, and nothing in the DOM can cover them. This is Windows and Linux, where the bar and its
 * buttons are ours.
 */
const WINDOW_CONTROL = "[data-window-control]";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
]);

function isClickable(el: HTMLElement): boolean {
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") ||
    (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
    INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "")
  );
}

/**
 * What a press on `path[0]` means, by Tauri's rules. Three-valued rather than the boolean Tauri
 * returns, because the difference matters here: "blocked" is a decision the app made and this
 * module must not second-guess, while "none" means nothing along the path had an opinion — which
 * is the only case where it is safe to go looking underneath.
 */
function resolve(path: HTMLElement[]): "drag" | "blocked" | "none" {
  for (const el of path) {
    const attr = el.getAttribute("data-tauri-drag-region");
    if (isClickable(el) && attr === null) return "blocked";
    if (attr === null) continue;
    if (attr === "false") return "blocked";
    if (attr === "deep") return "drag";
    // A bare attribute drags on direct hits only.
    if (attr === "" || attr === "true") return el === path[0] ? "drag" : "blocked";
  }
  return "none";
}

function pathOf(el: HTMLElement): HTMLElement[] {
  const path: HTMLElement[] = [];
  for (let node: HTMLElement | null = el; node; node = node.parentElement) path.push(node);
  return path;
}

/**
 * A backdrop: pinned to the viewport and covering all of it. The rect test is what separates one
 * from a dialog — a dialog sits *inside* a backdrop and covers only its own box — and the `fixed`
 * test keeps the app's own full-window layout containers out of it, since those scroll and size
 * with the document rather than the window.
 */
function isBackdrop(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const covers =
    r.top <= 1 &&
    r.left <= 1 &&
    r.right >= window.innerWidth - 1 &&
    r.bottom >= window.innerHeight - 1;
  return covers && getComputedStyle(el).position === "fixed";
}

/** What a press under a backdrop turns out to belong to, or `null` for "the app's, leave it". */
type CoveredPress = { kind: "drag" } | { kind: "control"; control: HTMLElement };

/**
 * Whether this press belongs to the window rather than to whatever is covering it — a drag of the
 * title bar, or one of the window's own buttons — in a way Tauri's own handler couldn't see.
 *
 * Everything the pointer is over is asked in turn, nearest first, and the first element with an
 * opinion settles it. Only a backdrop is stepped past — anything else that has no opinion ends the
 * walk, so a dialog laid over the title bar keeps its press instead of quietly dragging the window.
 * Stepping past a backdrop is not the same as ignoring it: a backdrop that resolves to "blocked" —
 * the one the AI menu hangs inside the bar's `data-tauri-drag-region="false"` wrapper — still says
 * no on behalf of everything it covers.
 */
function coveredWindowPress(event: MouseEvent): CoveredPress | null {
  // Tauri stops its own events dead, so anything still arriving here it declined to handle. The
  // walk below re-derives that decision rather than assuming it: "declined" covers both "nothing
  // claimed this" and "something said no", and only the first may be looked past.
  if (event.defaultPrevented || event.button !== 0) return null;

  // The element the event was delivered to goes first, and settles all but one case — which is
  // what keeps this off the hot path: an ordinary press anywhere in the app is answered by a walk
  // up its own ancestors, and never pays for a hit test.
  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;
  const claim = resolve(pathOf(target));
  if (claim !== "none") return claim === "drag" ? { kind: "drag" } : null;
  if (!isBackdrop(target)) return null;

  for (const el of document.elementsFromPoint(event.clientX, event.clientY)) {
    if (el === target) continue;
    // Ahead of `resolve`, which would only ever call a button "blocked": these three are the one
    // kind of control a backdrop is not entitled to block. Asked on every element rather than on
    // HTML ones only, because the pointer usually lands on the button's `<svg>` icon.
    const control = el.closest<HTMLElement>(WINDOW_CONTROL);
    if (control) return { kind: "control", control };
    if (!(el instanceof HTMLElement)) continue;
    const decision = resolve(pathOf(el));
    if (decision !== "none") return decision === "drag" ? { kind: "drag" } : null;
    if (!isBackdrop(el)) return null;
  }
  return null;
}

/**
 * Whether a press is the window's rather than the app's.
 *
 * For the overlays that deliberately swallow every press — the guided tour, which only holds
 * together if the app stays on the step it was put on. They ask this *before* calling
 * `preventDefault`, because the handler below reads an already-defaulted press as one the app
 * declined and stops there: without the check, an overlay that pauses the app also freezes the
 * window it is drawn in.
 */
export function pressBelongsToWindow(event: MouseEvent): boolean {
  return coveredWindowPress(event) !== null;
}

export function startOverlayDragRegion() {
  // The cursor as it was when a macOS double-click began, so a press that turns into a drag doesn't
  // also zoom the window on release. Tauri splits macOS out the same way and for the same reason.
  let zoomAnchor: { x: number; y: number } | null = null;

  document.addEventListener("mousedown", (event) => {
    if (event.detail !== 1 && event.detail !== 2) return;
    const press = coveredWindowPress(event);
    if (!press) return;

    if (press.kind === "control") {
      // The press can't reach the button — the backdrop is over it — so it is replayed as a click
      // instead. Swallowed here too, so the backdrop doesn't also count it as a click of its own
      // and dismiss whatever it belongs to. Only the first of a double-click is forwarded: two
      // minimizes are one more than anybody meant.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.detail === 1) press.control.click();
      return;
    }

    if (isMac() && event.detail === 2) {
      zoomAnchor = { x: event.clientX, y: event.clientY };
      return;
    }

    // `preventDefault` keeps the press from starting a text selection, and the stop keeps the app's
    // other document-level mousedown listeners — the dismiss-on-outside ones — from treating a
    // window drag as a click somewhere else. The dialog itself survives because the platform's move
    // loop takes the pointer from here: the webview sees no mouseup, so no click, so no backdrop
    // dismiss. Both lines are Tauri's, including the second as its fix for double-clicks landing on
    // the edge of a drag region.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.detail === 2) {
      // The app's own maximize, not Tauri's `internal_toggle_maximize`: on an undecorated Windows
      // window that one grows and never properly restores. See `windowControls`.
      void toggleMaximize().catch((e: unknown) => console.error("toggleMaximize", e));
      return;
    }
    void getCurrentWindow()
      .startDragging()
      .catch((e: unknown) => console.error("startDragging", e));
  });

  document.addEventListener("mouseup", (event) => {
    const anchor = zoomAnchor;
    zoomAnchor = null;
    if (!anchor || event.detail !== 2) return;
    // Moved between press and release: that was a drag, and macOS cancels the zoom.
    if (event.clientX !== anchor.x || event.clientY !== anchor.y) return;
    if (coveredWindowPress(event)?.kind !== "drag") return;
    void toggleMaximize().catch((e: unknown) => console.error("toggleMaximize", e));
  });
}
