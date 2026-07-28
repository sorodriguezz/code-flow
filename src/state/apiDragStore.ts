import { create } from "zustand";
import type { ApiFolder } from "../types/api";

/**
 * The in-flight API-tree drag — a request or a folder on its way somewhere else.
 *
 * Hand-rolled on pointer events like every other drag in the app, for the same reason
 * (`state/tabDragStore.ts`): Tauri's native drag-and-drop handler on the webview swallows the
 * HTML5 events before the page ever sees them.
 *
 * What separates this from `treeDragStore` is that the API tree is **ordered**. A drop there names
 * a destination folder and nothing else; here it has to name a *slot*, or reordering two requests
 * inside one folder would have no way to be expressed.
 */

export interface ApiDrag {
  kind: "folder" | "request";
  id: string;
  collectionId: string;
  /** Shown in the floating ghost. */
  name: string;
}

export interface DropTarget {
  collectionId: string;
  /** `null` = directly under the collection. */
  parentId: string | null;
  /**
   * Insertion point among the destination's children **of the dragged node's own kind**, counted
   * with the dragged node already taken out: folders and requests carry independent `sort_order`
   * sequences, and `moveNode` renumbers the destination list without the node before inserting it.
   */
  index: number;
}

/** A `DropTarget` plus which of the two gestures produced it. The distinction carries the whole
 * interaction — "into this folder" and "between these two rows" have to read differently. */
export interface ApiDropZone extends DropTarget {
  mode: "into" | "between";
}

interface ApiDragState {
  drag: ApiDrag | null;
  over: ApiDropZone | null;
  /** Pointer position at press, so the ghost is under the cursor on its first frame. Deliberately
   * not updated per move: that would re-render the tree on every pixel, and the ghost is
   * positioned imperatively. */
  origin: { x: number; y: number } | null;
  start: (drag: ApiDrag, x: number, y: number) => void;
  hover: (over: ApiDropZone | null) => void;
  end: () => void;
}

export const useApiDragStore = create<ApiDragState>((set, get) => ({
  drag: null,
  over: null,
  origin: null,

  start: (drag, x, y) => set({ drag, over: null, origin: { x, y } }),

  hover: (over) => {
    const current = get().over;
    // Pointer moves fire continuously; only a change of slot is worth a render.
    if (
      current?.collectionId === over?.collectionId &&
      current?.parentId === over?.parentId &&
      current?.index === over?.index &&
      current?.mode === over?.mode
    ) {
      return;
    }
    set({ over });
  },

  end: () => set({ drag: null, over: null, origin: null }),
}));

/**
 * Whether `drag` may land on `target`.
 *
 * The one illegal move is a folder into its own subtree — `api_move_node` rejects it outright, so
 * letting the gesture through would buy nothing but an error toast. Crossing collections *is*
 * allowed: the backend carries the whole subtree over with it.
 */
export function canDrop(drag: ApiDrag, target: DropTarget, folders: ApiFolder[]): boolean {
  if (drag.kind !== "folder" || target.parentId === null) return true;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  // `seen` guards the walk against an already-cyclic `parent_id` chain, the way the SQL side does.
  const seen = new Set<string>();
  let current = byId.get(target.parentId);
  while (current && !seen.has(current.id)) {
    if (current.id === drag.id) return false;
    seen.add(current.id);
    current = current.parent_id === null ? undefined : byId.get(current.parent_id);
  }
  return true;
}
