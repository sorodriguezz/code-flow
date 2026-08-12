import { create } from "zustand";

/**
 * What the status bar says about the line the caret is on — one entry, written only by the editor
 * group that has focus.
 *
 * **Why a store of its own, and why it holds exactly one thing.** The caret moves at key-repeat rate,
 * so whatever holds this is written many times a second. Threading it through `uiStore` — or through
 * any store `EditorView` or `EditorPane` already subscribe to — would re-render every live Monaco
 * pane *and* the whole file tree on each caret move; the comment in `EditorView.syncOpenTabs` is a
 * bug report about exactly that cost, arrived at from the other direction. A separate store means the
 * only component whose selector output can change is the status bar's blame leaf, and zustand
 * re-renders nothing else.
 *
 * The shape is `rowHoverStore`'s, for the same reason: holding **one** entry bounds the failure mode
 * by construction. A pane that unmounts without clearing can leave at most one stale line of text,
 * and the next focused pane's write replaces it — there is no state in which two panes' answers are
 * both live. And because `text` is a plain string, moving the caret *within* a blame hunk produces an
 * identical value and React bails out of the render entirely; only crossing into another hunk costs
 * anything, which is why a per-caret-move write is affordable at all.
 *
 * `groupId` is not read by any consumer — it exists only so `clear` can be guarded (see below).
 */
interface CursorBlameState {
  /**
   * `null` when no pane owns the slot at all.
   *
   * An entry with an **empty `text`** is a distinct and load-bearing state: "this group owns the slot
   * and has nothing to say" — blame off, a selection, multiple carets, a binary file, a blame still in
   * flight. The focused pane claims the slot that way instead of calling `clear`, because `clear` is
   * guarded and would be a no-op while the *previously* focused pane still held it: the bar would keep
   * showing another pane's answer for as long as the new pane took to blame. Consumers render nothing
   * for an empty string.
   */
  entry: { groupId: string; text: string } | null;
  set: (groupId: string, text: string) => void;
  /** Guarded: only clears if this group is the one currently showing. */
  clear: (groupId: string) => void;
}

export const useCursorBlameStore = create<CursorBlameState>((set, get) => ({
  entry: null,

  set: (groupId, text) => {
    const current = get().entry;
    // Same-value writes are dropped here rather than left to zustand: the caret moving within one
    // hunk is the common case, and a `set` with an equal-but-new object would notify every
    // subscriber to re-run its selector for a string that did not change.
    if (current && current.groupId === groupId && current.text === text) return;
    set({ entry: { groupId, text } });
  },

  // Guarded exactly as `rowHoverStore.leave` is, and for the same event ordering: a background pane
  // unmounting (or losing focus) after the newly focused pane has already written must not blank the
  // text the focused pane just put there. React commits the new pane's effects before the old one's
  // cleanup in some orders, so "last writer wins" would flicker the bar empty.
  clear: (groupId) => {
    if (get().entry?.groupId === groupId) set({ entry: null });
  },
}));
