import { create } from "zustand";
import { setDragCursor } from "../lib/pointerDrag";

/**
 * Dragging a field out of a node's input panel and into one of its parameters.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the constraint `dbObjectDragStore` and the stores it
 * names document: Tauri installs a native drag handler on the webview that swallows the HTML5
 * events, so the `draggable` fields this replaced could be picked up and never dropped anywhere.
 *
 * What travels is the field's **path**, not finished text — the opposite of `dbObjectDragStore`, and
 * for the same reason turned around: there the source knew the dialect, here the target does. The
 * same field is `{{ $json.a.b }}` in a text box, `$json.a.b` inside braces or in the Code node,
 * `item["a"]["b"]` in Python and `s.b` inside a template's `{% for s in $json.a %}`, and only the
 * field it lands on knows which (`exprAssist.dropText`).
 */
export interface FlowFieldDrag {
  /** Where the field is in an item: `["orders", 0, "amount"]`. */
  path: (string | number)[];
  /** Its own name, for the chip that follows the pointer. */
  label: string;
}

interface FlowFieldDragState {
  drag: FlowFieldDrag | null;
  /** Where the press began, so a click can be told from a drag. Cleared once the drag is live. */
  origin: { x: number; y: number; drag: FlowFieldDrag } | null;

  /** A press that might become a drag. Nothing is dragging yet. */
  press: (drag: FlowFieldDrag, x: number, y: number) => void;
  /** Promotes the press to a real drag, once the pointer has travelled far enough. */
  begin: () => void;
  end: () => void;
}

export const useFlowFieldDragStore = create<FlowFieldDragState>((set, get) => ({
  drag: null,
  origin: null,

  /**
   * The release is armed here, at the press, and on `window` — see `dbObjectDragStore.press`: it has
   * to cover the press that never becomes a drag and the drag let go over nothing. A field's own
   * drop listener runs first, in the capture phase.
   */
  press: (drag, x, y) => {
    set({ origin: { x, y, drag } });
    window.addEventListener("pointerup", () => get().end(), { once: true });
  },

  begin: () => {
    const origin = get().origin;
    if (!origin || get().drag) return;
    set({ drag: origin.drag });
    setDragCursor(true);
  },

  end: () => {
    if (get().drag) setDragCursor(false);
    set({ drag: null, origin: null });
  },
}));

/**
 * Hit-tests a release against a field's box — the drop itself is heard on `window`, in the capture
 * phase, because Monaco owns the DOM under a code field and a handler above it is not guaranteed
 * to see a release inside it (`SqlConsolePanel` documents the same).
 */
export function releasedOver(element: Element | null, event: PointerEvent): boolean {
  const box = element?.getBoundingClientRect();
  if (!box) return false;
  return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
}
