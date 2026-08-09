import { create } from "zustand";
import { setDragCursor } from "../lib/pointerDrag";

/**
 * Dragging a table, view or collection out of the explorer and into a console.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the constraint `tabDragStore`, `treeDragStore`,
 * `remoteDragStore` and `dbDragStore` all document: Tauri installs a native drag handler on the
 * webview that swallows `dragstart` before the page sees it, so `draggable` does nothing here.
 *
 * A store of its own rather than a second mode on `dbDragStore`, following the convention those
 * four set. It is also the honest shape: that one drags a *connection* to reorder the estate, this
 * one drags an *object* to write a query, and the only thing they have in common is the gesture.
 *
 * What travels is the finished text, not the node. Rendering it at the source is what lets the
 * console stay ignorant of dialects: quoting differs per engine (`[x]` on SQL Server) and Mongo has
 * no SQL at all, and a console that had to work that out on drop would be the second place in the
 * app that knows those rules — `sqlTemplates` being the first.
 */
export interface DbObjectDrag {
  /** Whose dialect `text` was rendered in. A console for another connection must refuse it. */
  connectionId: string;
  /** Exactly what gets inserted, already qualified and quoted. */
  text: string;
  /** The plain name, for the drop hint. */
  label: string;
}

interface DbObjectDragState {
  drag: DbObjectDrag | null;
  /** Where the press began, so a click can be told from a drag. Cleared once the drag is live. */
  origin: { x: number; y: number; drag: DbObjectDrag } | null;

  /** A press that might become a drag. Nothing is dragging yet. */
  press: (drag: DbObjectDrag, x: number, y: number) => void;
  /** Promotes the press to a real drag, once the pointer has travelled far enough. */
  begin: () => void;
  end: () => void;
}

export const useDbObjectDragStore = create<DbObjectDragState>((set, get) => ({
  drag: null,
  origin: null,

  /**
   * The release is armed here, at the press, and not at `begin`.
   *
   * It has to cover the press that never becomes a drag, which is most of them — every click that
   * opens a table is one. Armed at `begin`, a plain click would leave `origin` set with the button
   * long since released, and the next pointer move to cross that row far enough from the stale
   * origin would start a drag nobody initiated.
   *
   * On `window` rather than on the drop targets, because the release that must be handled reliably
   * is the one that lands on *nothing* — the results grid, the sidebar, outside the window. A
   * console's own `onPointerUp` still runs first and does the insert: React listens on its root
   * container, which is inside `window`, so a bubbling `pointerup` reaches it before this does.
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
    setDragCursor(false);
    set({ drag: null, origin: null });
  },
}));
