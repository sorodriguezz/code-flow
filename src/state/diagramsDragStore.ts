import { create } from "zustand";

/**
 * Dragging a diagram or a folder inside the explorer tree.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the constraint `treeDragStore`, `tabDragStore`,
 * `remoteDragStore` and `notesDragStore` all document: Tauri's native drag handler on the webview
 * swallows `dragstart`, so a `draggable` attribute produces nothing here at all. Everything below
 * is the hand-rolled equivalent, and `pointerDrag` carries the two browser defaults that then have
 * to be suppressed.
 *
 * A separate store from `notesDragStore` rather than a shared one, for the reason that file gives
 * about `remoteDragStore`: the gestures look alike and must never see each other's targets. One
 * "something is being dragged" flag is how a note ends up dropped into a diagram folder.
 *
 * **A drop means one of two things depending on where in a row it lands**, which is why the target
 * is a `DiagramsDropPlan` rather than a folder id. Across the middle of a row it *files* — into
 * that folder. Along the top or bottom edge it *orders* — before or after that row among its
 * siblings. Storing the resolved plan rather than the raw pointer position is deliberate: the
 * rules about what may be dropped where are applied once, at hover time, so the highlight the user
 * is looking at is by construction the write that a release performs.
 */

export interface DiagramsDrag {
  kind: "diagram" | "folder";
  id: string;
  /** The folder it started in, so a drop back onto the same one can do nothing rather than write. */
  fromFolderId: string | null;
}

/**
 * What releasing here would do.
 *
 * `null` — no plan — is a real and distinct state: the pointer is over something that refuses the
 * drop (a folder over its own subtree, a row over itself), and releasing must write nothing. It is
 * not the same as `{ mode: "into", folderId: null }`, which is the root and a genuine target — and
 * in this tree the root is a place diagrams actually live, not just a fallback.
 */
export type DiagramsDropPlan =
  /** File it into `folderId`, appended. `null` is the root. */
  | { mode: "into"; folderId: string | null }
  /** Place it next to `anchorId` among the children of `folderId`. */
  | { mode: "order"; anchorId: string; after: boolean; folderId: string | null };

interface DiagramsDragState {
  drag: DiagramsDrag | null;
  over: DiagramsDropPlan | null;
  /** Where the press began, so a click can be told from a drag. `null` once the drag is live. */
  origin: { x: number; y: number; drag: DiagramsDrag } | null;

  press: (drag: DiagramsDrag, x: number, y: number) => void;
  begin: () => void;
  hover: (plan: DiagramsDropPlan | null) => void;
  end: () => void;
}

/** Two plans compared as one string, so a pointer that moves within a zone doesn't re-render. */
function planKey(plan: DiagramsDropPlan | null): string {
  if (!plan) return "";
  return plan.mode === "into"
    ? `into:${plan.folderId ?? ""}`
    : `order:${plan.anchorId}:${plan.after}`;
}

export const useDiagramsDragStore = create<DiagramsDragState>((set, get) => ({
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
    // And guarded on value: a `set` with an unchanged target still notifies every subscriber, and
    // crossing one row is an event per pixel.
    if (planKey(get().over) === planKey(plan)) return;
    set({ over: plan });
  },

  end: () => set({ drag: null, over: null, origin: null }),
}));

/**
 * How much of a folder row's height each ordering edge takes.
 *
 * A folder row is three zones — order above, file into, order below — and this is the outer two.
 * Under a third each, so the "into" band stays the widest single target: filing is the commoner
 * intent, and it is the one a slightly-off drop should fall back to.
 */
const EDGE_ZONE = 0.3;

/**
 * Which zone of a row a pointer at `offsetY` is in.
 *
 * A diagram has no inside to file into, so it is two zones and the midpoint decides — every point
 * in a diagram row is an ordering target. A folder is three, because a folder is both a place in a
 * list and a container, and a drag has to be able to mean either.
 */
export function edgeAt(
  kind: "diagram" | "folder",
  offsetY: number,
  height: number,
): "into" | "before" | "after" {
  const ratio = height > 0 ? offsetY / height : 0.5;
  if (kind === "diagram") return ratio < 0.5 ? "before" : "after";
  if (ratio < EDGE_ZONE) return "before";
  if (ratio > 1 - EDGE_ZONE) return "after";
  return "into";
}
