import { create } from "zustand";
import { isAtOrUnder, remapPath } from "../lib/explorerClipboard";

/**
 * The explorer's own clipboard: the files and folders a Copy or Cut picked up, waiting for a Paste.
 *
 * **Paths, never contents, and never the system clipboard.** Copying a folder copies nothing until
 * the paste — the paste is a copy on disk from one path to another, done by the backend — which is
 * also what VS Code's explorer does. The system clipboard keeps whatever text was last copied, so
 * copying a file here never costs the user the snippet they were about to paste into it.
 *
 * A store rather than state in `FileTree`, because the tree does not outlive a trip to the search
 * or bookmarks panel: it is unmounted whenever another side panel takes the column, and a clipboard
 * that emptied itself every time you went to look something up would lose the one thing it holds.
 *
 * **Tied to one repository.** The paths are repo-relative, so they mean nothing — or, worse, a
 * different file with the same name — in another project; Paste is offered only in the repository
 * they came from. Switching projects does not clear it, so coming back still pastes.
 */

export type ExplorerClipboardMode = "copy" | "cut";

interface ExplorerClipboardState {
  /** The repository the paths belong to, `null` while nothing has been copied. */
  repoPath: string | null;
  mode: ExplorerClipboardMode;
  /** Repo-relative, with no path inside another (see `distinctParents`). Empty = nothing to paste. */
  paths: string[];
  set: (repoPath: string, mode: ExplorerClipboardMode, paths: string[]) => void;
  clear: () => void;
  /**
   * Something moved — a rename, a drag, a paste of a cut. Whatever the clipboard holds at or under
   * `from` follows it, so a Copy followed by a rename still pastes the file rather than failing on
   * the name it used to have.
   */
  moved: (repoPath: string, from: string, to: string) => void;
  /** Something is gone from disk. It leaves the clipboard, along with anything that was under it. */
  removed: (repoPath: string, path: string) => void;
}

export const useExplorerClipboardStore = create<ExplorerClipboardState>((set, get) => ({
  repoPath: null,
  mode: "copy",
  paths: [],

  set: (repoPath, mode, paths) => set({ repoPath, mode, paths }),

  clear: () => set({ repoPath: null, mode: "copy", paths: [] }),

  moved: (repoPath, from, to) => {
    const state = get();
    if (state.repoPath !== repoPath || !state.paths.some((path) => isAtOrUnder(path, from))) return;
    set({ paths: state.paths.map((path) => remapPath(path, from, to)) });
  },

  removed: (repoPath, gone) => {
    const state = get();
    if (state.repoPath !== repoPath) return;
    const kept = state.paths.filter((path) => !isAtOrUnder(path, gone));
    if (kept.length === state.paths.length) return;
    if (kept.length === 0) get().clear();
    else set({ paths: kept });
  },
}));
