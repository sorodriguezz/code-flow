/** Shared bits of the pointer-driven drags (editor tabs, explorer rows).
 *
 * Both are hand-rolled rather than HTML5 drag-and-drop because Tauri's native drag handler on the
 * webview swallows those events — see `state/tabDragStore.ts`. The cost of doing it by hand is
 * that the browser's *own* defaults are still in play, and two of them bite:
 *
 * - **Text selection.** Press-and-move is the selection gesture unless something says otherwise,
 *   which is why dragging a tab used to highlight the whole file underneath it.
 * - **Stale `:hover`.** WebKit doesn't re-evaluate the hover chain while a drag is under way, so
 *   every row the pointer sweeps over stays flagged as hovered. Suppressing the hover *style*
 *   isn't enough on its own: the flags are still set, and they all light up the instant the
 *   suppression is lifted.
 */

/** How far the pointer must travel before a press counts as a drag rather than a click. */
export const DRAG_THRESHOLD = 4;

/**
 * Marks the page as "a drag is happening": no text selection, grabbing cursor throughout.
 *
 * Row highlighting is *not* handled here — it's driven from `state/rowHoverStore.ts`, which holds
 * a single hovered key rather than leaning on the engine's hover chain. That's what keeps a drag
 * from leaving a trail of lit rows behind it.
 */
export function setDragCursor(active: boolean) {
  document.body.classList.toggle("cf-dragging", active);
  if (active) window.getSelection()?.removeAllRanges();
}

/**
 * The `mousedown` a tab strip needs so middle-click can mean "close this tab".
 *
 * Every strip in the app closes a tab on `auxclick` with `button === 1`, and on macOS that is the
 * whole story. On Windows and Linux it is not: pressing the middle button over a scrollable
 * element is the *autoscroll* gesture, and every one of these strips is `overflow-x-auto` — so the
 * press put the four-way pan cursor on screen and left the page in scroll mode, on top of (or
 * instead of) closing anything. Chromium only offers one way out, and it is this one: cancel the
 * default on `mousedown`, before autoscroll arms itself. `auxclick` still fires afterwards —
 * `preventDefault` here suppresses the browser's *action*, not the events that follow.
 *
 * Button 2 is deliberately left alone: its default is the `contextmenu` event, which several of
 * these strips raise a menu from, and cancelling the press cancels the menu with it.
 *
 * Button 0 is the caller's business. The two strips with a drag gesture already cancel it to stop
 * press-and-sweep text selection; the two without leave it, because cancelling a left press also
 * cancels the focus it would have moved.
 */
export function preventMiddleClickAutoscroll(e: { button: number; preventDefault: () => void }) {
  if (e.button === 1) e.preventDefault();
}
