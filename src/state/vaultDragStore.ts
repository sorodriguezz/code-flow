import { create } from "zustand";

/**
 * Dragging an entry into a keyring folder.
 *
 * **Pointer events, never HTML5 drag-and-drop** — the same reason every other drag store in this
 * app gives (`tabDragStore` states it first, `notesDragStore` and `diagramsDragStore` restate it):
 * Tauri installs a native drag handler on the webview which swallows `dragstart`/`dragover`/`drop`
 * before the page can react, so a `draggable` attribute here would do nothing at all.
 *
 * **Its own store rather than sharing `notesDragStore`**, for the reason `treeDragStore` gives: two
 * gestures that look alike must never see each other's targets, and one shared "something is being
 * dragged" flag is how a note ends up filed as a password.
 *
 * **Filing only — there is no reordering here**, and that is a deliberate difference from the notes
 * and diagrams stores, which both carry an `{ mode: "order", anchorId, after }` plan. Two reasons.
 * The keyring's entry list is *flat under whichever folder is selected* and re-sorts itself on every
 * keystroke of the search box (see `VaultExplorer`'s doc comment: a keyring is searched, not
 * browsed), so a hand-made order would be invisible the moment anyone typed. And `sort_order` has no
 * writer on the backend and `VaultSort` has no `"manual"` mode, so an arrangement written today
 * could not be shown. If reordering is ever wanted, both of those come first.
 */

export interface VaultDrag {
  kind: "item" | "folder";
  id: string;
  /** Where it came from, so a drop back onto the same folder can be recognised as a no-op. */
  fromFolderId: string | null;
}

/**
 * Where a drop would land.
 *
 * `null` is a real third state and not "no folder": it means the pointer is over something that
 * *refuses* the drop — a folder inside the subtree being dragged, or the row the drag started on.
 * `{ folderId: null }` is the root, which is a genuine target ("take this out of every folder").
 */
export interface VaultDropPlan {
  folderId: string | null;
}

/** Compared by value, so an unchanged hover doesn't notify every subscriber. */
function planKey(plan: VaultDropPlan | null): string {
  return plan ? `into:${plan.folderId ?? ""}` : "none";
}

interface VaultDragState {
  /** A live drag. `null` until the pointer has travelled past the threshold. */
  drag: VaultDrag | null;
  /** What was pressed, held until the pointer travels far enough to call it a drag. Separate from
   *  `drag` so a plain click never puts the tree into its dragging state. */
  pressed: VaultDrag | null;
  /** The already-resolved destination. The store never sees a pointer position — the component
   *  measures the geometry and hands down a decision. */
  over: VaultDropPlan | null;
  /** A press that may yet become a drag, with where it started. */
  origin: { x: number; y: number } | null;

  press: (drag: VaultDrag, x: number, y: number) => void;
  begin: () => void;
  hover: (plan: VaultDropPlan | null) => void;
  end: () => void;
}

export const useVaultDragStore = create<VaultDragState>((set, get) => ({
  drag: null,
  pressed: null,
  over: null,
  origin: null,

  press: (drag, x, y) => set({ drag: null, pressed: drag, over: null, origin: { x, y } }),

  begin: () => {
    const { origin, drag, pressed } = get();
    if (!origin || drag || !pressed) return;
    // `origin` is nulled here, exactly as `notesDragStore.begin` does — leaving it armed would make
    // the `!origin` early return stop firing and let a second `begin` through mid-drag.
    set({ drag: pressed, origin: null });
  },

  hover: (plan) => {
    // Two guards, both about re-render cost rather than correctness. Rows call this from
    // `pointerenter`, and zustand notifies every subscriber on any `set` — including one that
    // changed nothing.
    if (!get().drag) return;
    if (planKey(get().over) === planKey(plan)) return;
    set({ over: plan });
  },

  end: () => set({ drag: null, pressed: null, over: null, origin: null }),
}));
