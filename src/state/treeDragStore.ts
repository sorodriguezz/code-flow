import { create } from "zustand";

/**
 * The in-flight explorer drag — a file or folder being moved to another folder.
 *
 * Separate from the tab drag on purpose: the two gestures look alike but must never see each
 * other's targets, and one shared "something is being dragged" flag would let a tab land in the
 * file tree. Both are pointer-driven for the same reason (see `tabDragStore`): Tauri's native
 * drag-and-drop handler swallows the HTML5 events before the page ever sees them.
 */

export interface TreeDrag {
  /** Repo-relative path being moved. */
  path: string;
  isDir: boolean;
}

interface TreeDragState {
  drag: TreeDrag | null;
  /** Destination folder, `""` for the repo root. `null` when the pointer is over nothing the
   * drag can legally land on — which is also what suppresses the drop on release. */
  overDir: string | null;
  origin: { x: number; y: number } | null;
  start: (drag: TreeDrag, x: number, y: number) => void;
  hover: (dir: string | null) => void;
  end: () => void;
}

export const useTreeDragStore = create<TreeDragState>((set, get) => ({
  drag: null,
  overDir: null,
  origin: null,

  start: (drag, x, y) => set({ drag, overDir: null, origin: { x, y } }),

  hover: (dir) => {
    if (get().overDir === dir) return;
    set({ overDir: dir });
  },

  end: () => set({ drag: null, overDir: null, origin: null }),
}));

/** Whether `path` can be moved into `destDir`. Rejects the two moves that are either pointless or
 * destructive: back into the folder it already lives in, and a folder into its own subtree. */
export function canDropInto(drag: TreeDrag, destDir: string): boolean {
  const currentParent = drag.path.includes("/") ? drag.path.slice(0, drag.path.lastIndexOf("/")) : "";
  if (destDir === currentParent) return false;
  if (!drag.isDir) return true;
  return destDir !== drag.path && !destDir.startsWith(`${drag.path}/`);
}
