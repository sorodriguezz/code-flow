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
 * **Remembers its repository.** The paths are repo-relative, so they are always read together with
 * `repoPath`: pasted in that repository they are a copy or a move inside it; pasted in another one
 * they are absolute paths copied in from outside (`copy_external_path`) — and a cut there is a copy
 * followed by sending the original to the trash. Switching projects does not clear it.
 *
 * **Shared by every window.** Each webview has its own copy of this store; `lib/explorerClipboardSync`
 * keeps them in step over the window bus, so a Copy in a floating window pastes in the main one.
 * `at` orders the changes — the newest wins — and `adopt` is how a change from another window
 * lands without being sent straight back.
 *
 * **Next to the system clipboard, not on it.** `systemStamp` is the system clipboard's change
 * counter when the Copy was made. A paste finding it moved on, and files on the system clipboard,
 * pastes those instead: they were copied (in Finder/Explorer) after this.
 */

export type ExplorerClipboardMode = "copy" | "cut";

/** What travels between windows: the whole clipboard, as plain data. */
export interface ExplorerClipboardSnapshot {
  repoPath: string | null;
  mode: ExplorerClipboardMode;
  paths: string[];
  systemStamp: number | null;
  at: number;
}

interface ExplorerClipboardState extends ExplorerClipboardSnapshot {
  /** The repository the paths belong to, `null` while nothing has been copied. */
  repoPath: string | null;
  mode: ExplorerClipboardMode;
  /** Repo-relative, with no path inside another (see `distinctParents`). Empty = nothing to paste. */
  paths: string[];
  /** The system clipboard's change counter when this was copied; `null` while unknown. */
  systemStamp: number | null;
  /** When this last changed, increasing — what decides between two windows' versions. 0 = never. */
  at: number;
  set: (repoPath: string, mode: ExplorerClipboardMode, paths: string[]) => void;
  /** Records the system counter read for the copy made at `at` — ignored once something newer is. */
  stampSystem: (at: number, stamp: number | null) => void;
  /** Takes another window's clipboard, unless this one changed more recently. */
  adopt: (snapshot: ExplorerClipboardSnapshot) => void;
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

/** A timestamp later than every one this window has handed out, so two changes in the same
 *  millisecond still order. */
let lastAt = 0;
function nextAt(): number {
  lastAt = Math.max(Date.now(), lastAt + 1);
  return lastAt;
}

export const useExplorerClipboardStore = create<ExplorerClipboardState>((set, get) => ({
  repoPath: null,
  mode: "copy",
  paths: [],
  systemStamp: null,
  at: 0,

  set: (repoPath, mode, paths) => set({ repoPath, mode, paths, systemStamp: null, at: nextAt() }),

  stampSystem: (at, stamp) => {
    if (get().at !== at || get().systemStamp === stamp) return;
    set({ systemStamp: stamp });
  },

  adopt: (snapshot) => {
    if (snapshot.at < get().at) return;
    lastAt = Math.max(lastAt, snapshot.at);
    set({
      repoPath: snapshot.repoPath,
      mode: snapshot.mode,
      paths: [...snapshot.paths],
      systemStamp: snapshot.systemStamp,
      at: snapshot.at,
    });
  },

  clear: () => set({ repoPath: null, mode: "copy", paths: [], systemStamp: null, at: nextAt() }),

  moved: (repoPath, from, to) => {
    const state = get();
    if (state.repoPath !== repoPath || !state.paths.some((path) => isAtOrUnder(path, from))) return;
    set({ paths: state.paths.map((path) => remapPath(path, from, to)), at: nextAt() });
  },

  removed: (repoPath, gone) => {
    const state = get();
    if (state.repoPath !== repoPath) return;
    const kept = state.paths.filter((path) => !isAtOrUnder(path, gone));
    if (kept.length === state.paths.length) return;
    if (kept.length === 0) get().clear();
    else set({ paths: kept, at: nextAt() });
  },
}));

/** The clipboard as it would cross to another window. */
export function explorerClipboardSnapshot(): ExplorerClipboardSnapshot {
  const { repoPath, mode, paths, systemStamp, at } = useExplorerClipboardStore.getState();
  return { repoPath, mode, paths, systemStamp, at };
}
