import { create } from "zustand";

/**
 * The in-flight tab drag, shared by every editor group so the strip you're dragging *from* and the
 * one you're hovering *over* agree about what's happening.
 *
 * Why a hand-rolled gesture instead of HTML5 drag-and-drop: the webview never sees those events.
 * Tauri installs a native drag-and-drop handler on the webview (`dragDropEnabled`, on by default)
 * which swallows `dragstart`/`dragover`/`drop` before the page can react — which is why the tab
 * strip's `draggable` attribute has never actually done anything here. Pointer events are ordinary
 * input, so they arrive regardless, and hit-testing with `elementFromPoint` gives us the same
 * cross-pane targeting the DOM API would have.
 */

export interface TabDrag {
  /** The group the tab is being dragged out of. */
  groupId: string;
  path: string;
}

export interface TabDropTarget {
  groupId: string;
  /** Insertion point in the target group's tab order: 0 before the first tab, `length` after the
   * last. */
  index: number;
  /**
   * Which part of the target pane the pointer is over.
   *
   * The strip aims at a slot; the middle of the body means "put it in this group"; and the four
   * edges mean *split there* — the file goes beside or under the pane you aimed at, which is the
   * gesture every editor with split panes has. See `edgeOf` in `EditorTabs`.
   */
  zone: "strip" | "body" | "left" | "right" | "top" | "bottom";
}

interface TabDragState {
  drag: TabDrag | null;
  over: TabDropTarget | null;
  /** Where the pointer was when the drag began, so the floating label starts under the cursor
   * rather than at the origin for one frame. Deliberately *not* updated on every move: that
   * would re-render every strip on every pixel, and the label is positioned imperatively. */
  origin: { x: number; y: number } | null;
  start: (drag: TabDrag, x: number, y: number) => void;
  hover: (over: TabDropTarget | null) => void;
  end: () => void;
}

export const useTabDragStore = create<TabDragState>((set, get) => ({
  drag: null,
  over: null,
  origin: null,

  start: (drag, x, y) => set({ drag, over: null, origin: { x, y } }),

  hover: (over) => {
    const current = get().over;
    // Pointer moves fire continuously; only a change of slot is worth a render.
    if (current?.groupId === over?.groupId && current?.index === over?.index && current?.zone === over?.zone) return;
    set({ over });
  },

  end: () => set({ drag: null, over: null, origin: null }),
}));
