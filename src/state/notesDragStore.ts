import { create } from "zustand";

/**
 * Dragging a note or a book inside the explorer tree.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the constraint `treeDragStore`, `tabDragStore` and
 * `remoteDragStore` all document: Tauri's native drag handler on the webview swallows `dragstart`,
 * so a `draggable` attribute produces nothing here at all. Everything below is the hand-rolled
 * equivalent, and `pointerDrag` carries the two browser defaults that then have to be suppressed.
 *
 * A separate store from `remoteDragStore` rather than a shared one, for the reason `treeDragStore`
 * gives: the gestures look alike and must never see each other's targets. One "something is being
 * dragged" flag is how a host ends up dropped into a notes book.
 *
 * What a drop means here is simpler than in the Remote tree, because notes have no hand-arranged
 * order to preserve within a book — they are sorted by whatever the user picked. So a drop is
 * always a *move into*, never a reorder, and the only target is a book (or the root).
 */

export interface NotesDrag {
  kind: "note" | "book";
  id: string;
  /** The book it started in, so a drop back onto the same one can do nothing rather than write. */
  fromBookId: string | null;
}

interface NotesDragState {
  drag: NotesDrag | null;
  /**
   * The book under the pointer, or `null` for the root.
   *
   * `undefined` — the field absent — is the third state and the important one: it means the
   * pointer is over nothing droppable, which is what suppresses the drop on release. `null` is a
   * real target (the root); the two must not be collapsed.
   */
  overBookId: string | null | undefined;
  /** Where the press began, so a click can be told from a drag. `null` once the drag is live. */
  origin: { x: number; y: number; drag: NotesDrag } | null;

  press: (drag: NotesDrag, x: number, y: number) => void;
  begin: () => void;
  hover: (bookId: string | null | undefined) => void;
  end: () => void;
}

export const useNotesDragStore = create<NotesDragState>((set, get) => ({
  drag: null,
  overBookId: undefined,
  origin: null,

  press: (drag, x, y) => set({ origin: { x, y, drag } }),

  begin: () => {
    const origin = get().origin;
    if (!origin || get().drag) return;
    set({ drag: origin.drag, origin: null });
  },

  hover: (bookId) => {
    // Guarded because this fires from `onPointerEnter` on every row the pointer sweeps, and a
    // `set` with an unchanged value still re-renders every subscriber.
    if (get().overBookId === bookId) return;
    set({ overBookId: bookId });
  },

  end: () => set({ drag: null, overBookId: undefined, origin: null }),
}));
