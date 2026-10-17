import { create } from "zustand";

/**
 * VS Code's «Select for Compare» / «Compare with Selected», for any two files of the repository —
 * from a tab's menu or the explorer's. The first pick waits here; the second opens the pair in
 * `CompareFilesModal`, which `EditorView` draws.
 */
interface CompareState {
  /** The file picked first, repo-relative. */
  selected: string | null;
  /** The two files on screen: `left` is the one picked first. With `buffer`, the right side is that
   *  unsaved text of `right` rather than the file — «Comparar con lo guardado». */
  pair: { left: string; right: string; buffer?: string; label?: string } | null;
  select: (path: string) => void;
  compareWith: (path: string) => void;
  compare: (left: string, right: string) => void;
  /** The file on disk against what its tab holds now. */
  compareWithSaved: (path: string, buffer: string, label?: string) => void;
  close: () => void;
}

export const useCompareStore = create<CompareState>((set, get) => ({
  selected: null,
  pair: null,
  select: (path) => set({ selected: path }),
  compareWith: (path) => {
    const left = get().selected;
    if (left && left !== path) set({ pair: { left, right: path } });
  },
  compare: (left, right) => set({ pair: { left, right } }),
  compareWithSaved: (path, buffer, label) => set({ pair: { left: path, right: path, buffer, label } }),
  close: () => set({ pair: null }),
}));
