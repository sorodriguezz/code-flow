import { create } from "zustand";

/**
 * Dragging a conversation into a folder in the chat sidebar.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the constraint `treeDragStore`, `notesDragStore`
 * and `tabDragStore` all document: Tauri's native drag handler on the webview swallows
 * `dragstart`, so a `draggable` attribute produces nothing here at all. `lib/pointerDrag` carries
 * the two browser defaults that then have to be suppressed by hand.
 *
 * Its own store rather than a shared one, for the reason `notesDragStore` gives: the gestures look
 * alike and must never see each other's targets. One "something is being dragged" flag is how a
 * note ends up dropped into a chat folder.
 *
 * # Why this is so much smaller than `notesDragStore`
 *
 * That tree drags two kinds of thing and a drop can mean two things — file it, or order it next to
 * a sibling — so its target is a three-zone plan measured against each row. This sidebar has
 * neither. A conversation is the only draggable thing, and the order inside a folder is not the
 * user's to set: it is pinned-first then by recency, decided by the query. So a drop means exactly
 * one thing, everywhere, and the target is a folder id.
 *
 * Which leaves `null` doing real work rather than standing in for "nothing". It is the **ungrouped
 * list** — a genuine destination, and the only way to take a conversation back out of a folder by
 * dragging. "Nothing is under the pointer" is `over === null` *together with* `overUngrouped ===
 * false`, which is why the two are separate fields instead of one nullable id.
 */

export interface ChatDrag {
  conversationId: string;
  /** The folder it started in, so a drop back onto the same one can do nothing rather than write. */
  fromGroupId: string | null;
  /** Shown in the drag ghost, so what is being moved is legible once the row is out from under the
   *  pointer. */
  title: string;
}

interface ChatDragState {
  drag: ChatDrag | null;
  /** The folder the pointer is over, or `null` for none. See the note above on why "over the
   *  ungrouped list" is a separate flag rather than this being nullable. */
  over: string | null;
  /** Whether the pointer is over the ungrouped area — a real destination, not the absence of one. */
  overUngrouped: boolean;
  /** Where the press began, so a click can be told from a drag. `null` once the drag is live. */
  origin: { x: number; y: number; drag: ChatDrag } | null;
  /** Follows the pointer so the ghost can, in viewport coordinates. */
  pointer: { x: number; y: number } | null;

  press: (drag: ChatDrag, x: number, y: number) => void;
  begin: () => void;
  /** `groupId` files into a folder, `"ungrouped"` takes it out of one, `null` is no target. */
  hover: (target: string | "ungrouped" | null) => void;
  move: (x: number, y: number) => void;
  end: () => void;
}

export const useChatDragStore = create<ChatDragState>((set, get) => ({
  drag: null,
  over: null,
  overUngrouped: false,
  origin: null,
  pointer: null,

  press: (drag, x, y) => set({ origin: { x, y, drag } }),

  begin: () => {
    const origin = get().origin;
    if (!origin || get().drag) return;
    set({ drag: origin.drag, origin: null, pointer: { x: origin.x, y: origin.y } });
  },

  hover: (target) => {
    // Nothing is being dragged: there is no target to track, and writing one would re-render the
    // sidebar on an ordinary mouse-over. Rows call this from `pointermove`, so without the guard it
    // fires several times a frame for a pointer that is only passing through.
    if (!get().drag) return;
    const over = target === "ungrouped" || target === null ? null : target;
    const overUngrouped = target === "ungrouped";
    // Guarded on value, for the reason `notesDragStore.hover` is: a `set` with an unchanged target
    // still notifies every subscriber, and crossing one row is an event per pixel.
    if (get().over === over && get().overUngrouped === overUngrouped) return;
    set({ over, overUngrouped });
  },

  move: (x, y) => {
    if (!get().drag) return;
    set({ pointer: { x, y } });
  },

  end: () => set({ drag: null, over: null, overUngrouped: false, origin: null, pointer: null }),
}));

/**
 * What releasing right now would write, or `undefined` for "nothing".
 *
 * Lives here rather than inside the sidebar because it is the one place in this gesture with a
 * decision in it — everything else is bookkeeping — and because a rule the component keeps to
 * itself is a rule the tests can only assert a copy of.
 *
 * Returns the destination, where `null` is the ungrouped list and is a genuine answer. So the three
 * outcomes are: a folder id (file it there), `null` (take it out of its folder), and `undefined`
 * (write nothing). Collapsing the last two would make "released over nothing" indistinguishable
 * from "released over the loose list", and the first of those must never move anything.
 */
export function dropTarget(
  drag: ChatDrag,
  over: string | null,
  overUngrouped: boolean,
): string | null | undefined {
  if (overUngrouped) {
    // Already loose: releasing over the loose list is a no-op, not a write. Worth returning
    // `undefined` rather than letting the write be harmlessly idempotent, because it would still
    // re-read the conversation list and every folder's count.
    return drag.fromGroupId === null ? undefined : null;
  }
  if (over === null || over === drag.fromGroupId) return undefined;
  return over;
}
