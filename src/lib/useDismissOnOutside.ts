import { useEffect, type RefObject } from "react";

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
 */
export function useDismissOnOutside(
  open: boolean,
  onDismiss: () => void,
  refs: RefObject<HTMLElement | null>[],
): void {
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onDismiss();
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // The ref objects are stable for the life of the component; spreading them into the dependency
    // list would re-subscribe on every render for an array literal that is new each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDismiss]);
}
