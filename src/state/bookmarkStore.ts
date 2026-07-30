import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";

/**
 * Lines someone marked to come back to — the editor's bookmarks.
 *
 * Deliberately not the anchors panel and not a breakpoint. An anchor is a comment the *file*
 * carries, so it belongs to everyone who clones the repo and lives in the source; a breakpoint
 * belongs to a debug run. A bookmark is neither: it is one person's note-to-self about where they
 * were working, which is why it is stored beside the app's settings rather than in the file, and
 * why nothing about it travels.
 *
 * Kept per project. A list spanning every repo would need the panel to explain which "src/App.tsx"
 * a row means, and a bookmark from a repo nobody has open is not navigable anyway.
 */

export interface Bookmark {
  id: string;
  /** Repo-relative, the currency the editor opens files in. */
  path: string;
  /** 1-based, as Monaco counts. */
  line: number;
  /**
   * The line's text as it read when it was marked, trimmed.
   *
   * A snapshot on purpose. Re-reading the file to label a row would mean opening every bookmarked
   * file to draw the panel, and the label's job is to remind someone what they marked, not to
   * mirror the current contents — which the line will show the moment they click it.
   */
  label: string;
}

/** What the panel needs, and only that: the marks for one repo. */
interface BookmarkState {
  /** The repo `bookmarks` belongs to, so a stale list is never shown against another project. */
  repoPath: string | null;
  bookmarks: Bookmark[];
  load: (repoPath: string) => Promise<void>;
  /** Adds the line, or removes it when it is already marked — one action for both directions. */
  toggle: (path: string, line: number, label: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  isMarked: (path: string, line: number) => boolean;
  /** The lines marked in one file, for the editor's gutter. */
  linesIn: (path: string) => number[];
}

/** One key per repo: the editor is scoped to a project, so this is read once when it opens one. */
function key(repoPath: string): string {
  return `editor_bookmarks:${repoPath}`;
}

function newId(): string {
  return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ordered the way the panel reads them: by file, then down the file. */
function sorted(bookmarks: Bookmark[]): Bookmark[] {
  return [...bookmarks].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function parse(stored: string | null): Bookmark[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    // Filtered rather than trusted: this is a hand-editable settings value, and one malformed row
    // should cost that row, not the panel.
    return sorted(
      parsed.filter(
        (row): row is Bookmark =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as Bookmark).id === "string" &&
          typeof (row as Bookmark).path === "string" &&
          typeof (row as Bookmark).line === "number",
      ),
    );
  } catch {
    return [];
  }
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  repoPath: null,
  bookmarks: [],

  load: async (repoPath) => {
    if (get().repoPath === repoPath) return;
    // Cleared first: between here and the read below the panel would otherwise draw the previous
    // project's marks against this one's file tree.
    set({ repoPath, bookmarks: [] });
    const stored = await getSetting(key(repoPath)).catch(() => null);
    // A project switched again while this was in flight owns the store now.
    if (get().repoPath !== repoPath) return;
    set({ bookmarks: parse(stored) });
  },

  toggle: (path, line, label) => {
    const { repoPath, bookmarks } = get();
    if (repoPath === null) return;
    const existing = bookmarks.find((mark) => mark.path === path && mark.line === line);
    const next = existing
      ? bookmarks.filter((mark) => mark.id !== existing.id)
      : sorted([...bookmarks, { id: newId(), path, line, label: label.trim().slice(0, 200) }]);
    set({ bookmarks: next });
    void setSetting(key(repoPath), JSON.stringify(next)).catch(() => {});
  },

  remove: (id) => {
    const { repoPath, bookmarks } = get();
    if (repoPath === null) return;
    const next = bookmarks.filter((mark) => mark.id !== id);
    set({ bookmarks: next });
    void setSetting(key(repoPath), JSON.stringify(next)).catch(() => {});
  },

  clear: () => {
    const { repoPath } = get();
    if (repoPath === null) return;
    set({ bookmarks: [] });
    void setSetting(key(repoPath), "[]").catch(() => {});
  },

  isMarked: (path, line) =>
    get().bookmarks.some((mark) => mark.path === path && mark.line === line),

  linesIn: (path) =>
    get()
      .bookmarks.filter((mark) => mark.path === path)
      .map((mark) => mark.line),
}));
