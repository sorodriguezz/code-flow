import { useEffect, type RefObject } from "react";
import { pressBelongsToWindow } from "./overlayDragRegion";

/** Why the popover is being closed — the one thing a caller may want to tell apart. */
export type DismissReason = "press" | "escape";

/**
 * Closes an open popover when the click lands anywhere else, or on Escape.
 *
 * `mousedown` rather than `click`: a menu that waits for the full click stays open through the
 * press, and if the press landed on something that moves — a resize handle, a drag — the click
 * never arrives and the menu is left hanging over the thing being dragged.
 *
 * Escape is bound to the document rather than to the trigger, because the rows of these menus call
 * `preventDefault` on mousedown to keep focus where it is — and on the WebKit that Tauri renders
 * in, clicking a button doesn't focus it anyway. On the trigger it would only work for a menu that
 * had been opened from the keyboard.
 *
 * Every ref passed is treated as "inside": pass the trigger as well as the panel, or clicking the
 * trigger to close would be an outside click that closes it and a toggle that opens it again.
 *
 * ---
 *
 * **The press is heard in the capture phase, and as `pointerdown` as well as `mousedown`.** Both
 * halves are there for canvases, which are the one kind of surface in this app that a press can
 * land on without the rest of the app ever hearing about it:
 *
 * - **Capture**, because a canvas stops the press on its way up. `DbmlCanvas` calls
 *   `stopPropagation` on its `pointerdown` so a press on a table does not also reach the
 *   background handler that clears the selection — and React delegates its listeners at the root
 *   container, so stopping there stops the native event before `document` ever sees it. A capture
 *   listener runs on the way *down*, before any of that.
 * - **`pointerdown` as well**, because a canvas also cancels the press. That same handler calls
 *   `preventDefault` to keep a drag from running the browser's text selection across the labels,
 *   and a cancelled `pointerdown` suppresses the compatibility `mousedown` altogether — which is
 *   also why that canvas has to move focus by hand. There is no `mousedown` left to listen for.
 *
 * `mousedown` is still listened for, and not only for symmetry: a press inside the draw.io iframe
 * reaches this window as a synthesised `mousedown` and nothing else. See `forwardFramePresses`.
 *
 * Listening in capture does give up one thing the bubble phase got for free, so it is asked for
 * explicitly: `startOverlayDragRegion` swallows a press on the window's own drag region on its way
 * up, which is what kept a menu from closing when the user grabbed the title bar. `pressBelongsToWindow`
 * is the same question, asked here.
 */
export function useDismissOnOutside(
  open: boolean,
  onDismiss: (reason: DismissReason) => void,
  refs: RefObject<HTMLElement | null>[],
): void {
  useEffect(() => {
    if (!open) return;

    const onPress = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      // Grabbing the title bar is moving the window, not clicking somewhere in the app.
      if (pressBelongsToWindow(e)) return;
      onDismiss("press");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onDismiss("escape");
    };

    // Both, and the double call on an ordinary mouse press is deliberate: telling a real
    // `mousedown` apart from the iframe's synthesised one would be guesswork, and closing something
    // already closed costs nothing. Every caller's `onDismiss` is idempotent for this reason.
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("mousedown", onPress, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("mousedown", onPress, true);
      document.removeEventListener("keydown", onKey);
    };
    // The ref objects are stable for the life of the component; spreading them into the dependency
    // list would re-subscribe on every render for an array literal that is new each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDismiss]);
}
