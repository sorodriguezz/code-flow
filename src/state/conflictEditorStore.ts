import { create } from "zustand";

/**
 * Which conflicted file the three-way editor is open on.
 *
 * Opened from two places — a row of the conflicts banner and a conflicted row of the Changes list —
 * and drawn once, by the banner (which is on screen whenever there is a conflict to open). `ai` asks
 * the editor to start the AI proposal as it opens: the banner's "AI" button always did that, and
 * keeps doing it, only now the proposal lands in the editor's result pane for review.
 */
interface ConflictEditorState {
  path: string | null;
  ai: boolean;
  open: (path: string, ai?: boolean) => void;
  close: () => void;
}

export const useConflictEditorStore = create<ConflictEditorState>((set) => ({
  path: null,
  ai: false,
  open: (path, ai = false) => set({ path, ai }),
  close: () => set({ path: null, ai: false }),
}));
