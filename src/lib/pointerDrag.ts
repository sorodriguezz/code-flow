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
