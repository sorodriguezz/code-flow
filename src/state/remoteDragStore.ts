import { create } from "zustand";

/**
 * Dragging a host inside the tree.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the same constraint `tabDragStore` and
 * `treeDragStore` document: Tauri's native drag handler on the webview swallows `dragstart`, so a
 * `draggable` attribute produces nothing at all here. Everything below is the hand-rolled
 * equivalent, and `pointerDrag` carries the two browser defaults that then have to be suppressed.
 *
 * A drop does two things at once, and that is the point of building it: within a group it reorders,
 * and across groups it *moves* — which is what finally gives `setHostGroup` a way to be reached
 * that isn't retyping the group's name in the panel.
 */
export interface RemoteDrag {
  hostId: string;
  /** The group it started in, so a drop can tell "reorder" from "move". */
  fromGroup: string;
}

interface RemoteDragState {
  drag: RemoteDrag | null;
  /** Host currently under the pointer — the row the drop would land before. */
  overHostId: string | null;
  /** Group under the pointer. Set from a group header *and* from every row in it, so dropping on
   *  the last row of a group still targets that group rather than nothing. */
  overGroup: string | null;
  /** Where the press began, so a click can be told from a drag. `null` once the drag is live. */
  origin: { x: number; y: number; hostId: string; fromGroup: string } | null;

  /** A press that might become a drag. Nothing is dragging yet. */
  press: (hostId: string, fromGroup: string, x: number, y: number) => void;
  /** Promotes the press to a real drag, once the pointer has travelled far enough. */
  begin: () => void;
  hover: (hostId: string | null, group: string | null) => void;
  end: () => void;
}

export const useRemoteDragStore = create<RemoteDragState>((set, get) => ({
  drag: null,
  overHostId: null,
  overGroup: null,
  origin: null,

  press: (hostId, fromGroup, x, y) => set({ origin: { x, y, hostId, fromGroup } }),

  begin: () => {
    const origin = get().origin;
    if (!origin || get().drag) return;
    set({ drag: { hostId: origin.hostId, fromGroup: origin.fromGroup } });
  },

  hover: (overHostId, overGroup) => {
    if (!get().drag) return;
    // Guarded rather than written unconditionally: this fires on every row the pointer sweeps
    // across, and a `set` per row would re-render the whole tree several times per frame.
    if (get().overHostId === overHostId && get().overGroup === overGroup) return;
    set({ overHostId, overGroup });
  },

  end: () => set({ drag: null, overHostId: null, overGroup: null, origin: null }),
}));
