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
 * **A drop means one of two things depending on where in a row it lands**, which is why the target
 * is a `NotesDropPlan` rather than a book id. Across the middle of a row it *files* — into that
 * book, the only thing this tree used to do. Along the top or bottom edge it *orders* — before or
 * after that row among its siblings, which is the gesture the whole hand-made ordering rests on.
 * Storing the resolved plan rather than the raw pointer position is deliberate: the rules about
 * what may be dropped where are then applied once, at hover time, and the highlight the user is
 * looking at is by construction the write that a release performs.
 */

export interface NotesDrag {
  kind: "note" | "book";
  id: string;
  /** The book it started in, so a drop back onto the same one can do nothing rather than write. */
  fromBookId: string | null;
}

/**
 * What releasing here would do.
 *
 * `null` — no plan — is a real and distinct state: the pointer is over something that refuses the
 * drop (a book over its own subtree, a row over itself), and releasing must write nothing. It is
 * not the same as `{ mode: "into", bookId: null }`, which is the root and a genuine target.
 */
export type NotesDropPlan =
  /** File it into `bookId`, appended. `null` is the root. */
  | { mode: "into"; bookId: string | null }
  /** Place it next to `anchorId` among the children of `bookId`. */
  | { mode: "order"; anchorId: string; after: boolean; bookId: string | null };

interface NotesDragState {
  drag: NotesDrag | null;
  over: NotesDropPlan | null;
  /** Where the press began, so a click can be told from a drag. `null` once the drag is live. */
  origin: { x: number; y: number; drag: NotesDrag } | null;

  press: (drag: NotesDrag, x: number, y: number) => void;
  begin: () => void;
  hover: (plan: NotesDropPlan | null) => void;
  end: () => void;
}

/** Two plans compared as one string, so a pointer that moves within a zone doesn't re-render. */
function planKey(plan: NotesDropPlan | null): string {
  if (!plan) return "";
  return plan.mode === "into"
    ? `into:${plan.bookId ?? ""}`
    : `order:${plan.anchorId}:${plan.after}`;
}

export const useNotesDragStore = create<NotesDragState>((set, get) => ({
  drag: null,
  over: null,
  origin: null,

  press: (drag, x, y) => set({ origin: { x, y, drag } }),

  begin: () => {
    const origin = get().origin;
    if (!origin || get().drag) return;
    set({ drag: origin.drag, origin: null });
  },

  hover: (plan) => {
    // Nothing is being dragged: there is no target to track, and writing one would re-render the
    // whole tree on an ordinary mouse-over. The rows call this from `pointermove`, so without the
    // guard it fires several times a frame for a pointer that is only passing through.
    if (!get().drag) return;
    // And guarded on value, for the same reason `remoteDragStore.hover` is: a `set` with an
    // unchanged target still notifies every subscriber, and crossing one row is an event per pixel.
    if (planKey(get().over) === planKey(plan)) return;
    set({ over: plan });
  },

  end: () => set({ drag: null, over: null, origin: null }),
}));

/**
 * How much of a book row's height each ordering edge takes.
 *
 * A book row is three zones — order above, file into, order below — and this is the outer two.
 * Under a third each, so the "into" band stays the widest single target: filing is still the
 * commoner intent, and it is the one a slightly-off drop should fall back to.
 */
const EDGE_ZONE = 0.3;

/**
 * Which zone of a row a pointer at `offsetY` is in.
 *
 * A note has no inside to file into, so it is two zones and the midpoint decides — every point in
 * a note row is an ordering target. A book is three, because a book is both a place in a list and
 * a container, and a drag has to be able to mean either.
 */
export function edgeAt(
  kind: "note" | "book",
  offsetY: number,
  height: number,
): "into" | "before" | "after" {
  const ratio = height > 0 ? offsetY / height : 0.5;
  if (kind === "note") return ratio < 0.5 ? "before" : "after";
  if (ratio < EDGE_ZONE) return "before";
  if (ratio > 1 - EDGE_ZONE) return "after";
  return "into";
}
