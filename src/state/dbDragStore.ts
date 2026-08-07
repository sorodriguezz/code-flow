import { create } from "zustand";

/**
 * Dragging a connection inside the explorer.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the same constraint `tabDragStore`, `treeDragStore`
 * and `remoteDragStore` document: Tauri's native drag handler on the webview swallows `dragstart`,
 * so a `draggable` attribute produces nothing at all here. Everything below is the hand-rolled
 * equivalent, and `pointerDrag` carries the two browser defaults that then have to be suppressed.
 *
 * A store per draggable thing rather than one generic one, which is the convention the three above
 * already set: what is being dragged is half the state, and a shared store would either be typed
 * `unknown` or grow a discriminant that every reader has to narrow.
 *
 * A drop does two things at once, and that is the point of building it: within a group it reorders,
 * and across groups it *moves* — which is what finally gives "Move to group" a way to be reached
 * that isn't a submenu naming groups by hand.
 */
export interface DbDrag {
  connectionId: string;
  /** The group it started in, so a drop can tell "reorder" from "move". */
  fromGroup: string;
}

interface DbDragState {
  drag: DbDrag | null;
  /** Connection currently under the pointer — the row the drop would land before. */
  overConnectionId: string | null;
  /** Group under the pointer. Set from a group header *and* from every row in it, so dropping on
   *  the last row of a group still targets that group rather than nothing. */
  overGroup: string | null;
  /** Where the press began, so a click can be told from a drag. `null` once the drag is live. */
  origin: { x: number; y: number; connectionId: string; fromGroup: string } | null;

  /** A press that might become a drag. Nothing is dragging yet. */
  press: (connectionId: string, fromGroup: string, x: number, y: number) => void;
  /** Promotes the press to a real drag, once the pointer has travelled far enough. */
  begin: () => void;
  hover: (connectionId: string | null, group: string | null) => void;
  end: () => void;
}

export const useDbDragStore = create<DbDragState>((set, get) => ({
  drag: null,
  overConnectionId: null,
  overGroup: null,
  origin: null,

  press: (connectionId, fromGroup, x, y) => set({ origin: { x, y, connectionId, fromGroup } }),

  begin: () => {
    const origin = get().origin;
    if (!origin || get().drag) return;
    set({ drag: { connectionId: origin.connectionId, fromGroup: origin.fromGroup } });
  },

  hover: (overConnectionId, overGroup) => {
    if (!get().drag) return;
    // Guarded rather than written unconditionally: this fires on every row the pointer sweeps
    // across, and a `set` per row would re-render the whole tree several times per frame.
    if (get().overConnectionId === overConnectionId && get().overGroup === overGroup) return;
    set({ overConnectionId, overGroup });
  },

  end: () => set({ drag: null, overConnectionId: null, overGroup: null, origin: null }),
}));
