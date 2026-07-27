import { create } from "zustand";

/**
 * Which single row — explorer entry or editor tab — the pointer is over, tracked in JavaScript
 * instead of with CSS `:hover`.
 *
 * The engine's hover chain is not usable here. WebKit doesn't re-evaluate it while a hand-rolled
 * drag is under way, so rows the pointer sweeps across keep their hover flag; nothing clears them
 * afterwards, and they all light up at once. Suppressing the *style* during the drag only moved
 * the moment they appeared to the drop.
 *
 * This holds **one** key, so the failure mode is bounded by construction: a missed `pointerleave`
 * can leave at most one stale row, and the next `pointerenter` anywhere replaces it. There is no
 * state in which two rows are lit.
 */
interface RowHoverState {
  /** Namespaced so a tab and a tree row can never collide: `tree:<path>`, `tab:<group>:<path>`. */
  key: string | null;
  enter: (key: string) => void;
  leave: (key: string) => void;
}

export const useRowHoverStore = create<RowHoverState>((set, get) => ({
  key: null,

  enter: (key) => {
    if (get().key !== key) set({ key });
  },

  // Guarded so a `leave` that arrives *after* the next row's `enter` — the usual event order
  // when moving fast — doesn't blank the row that just took over.
  leave: (key) => {
    if (get().key === key) set({ key: null });
  },
}));
