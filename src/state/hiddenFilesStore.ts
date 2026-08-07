import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";

/**
 * Files and folders the user has taken out of the editor's explorer.
 *
 * **Nothing is deleted, moved, or hidden from anything else.** This is a view filter on one tree:
 * the file stays on disk, git still reports it, search still finds it, and a tab already showing it
 * keeps showing it. `node_modules`, `dist`, a lockfile — the entries that are never the reason you
 * opened the explorer but sit at the top of it anyway — simply stop being drawn.
 *
 * Deliberately not `.gitignore` and not a global glob. An ignore rule is a statement about the
 * repository that everyone who clones it inherits; a glob is a rule about every project at once.
 * This is one person's opinion about one checkout, which is why it is stored beside the app's
 * settings, keyed per repository, and why none of it travels.
 */

/** One hidden entry. The kind is stored rather than looked up: once something is hidden it is gone
 *  from the listing, so there is nothing left to ask whether it was a folder — and the panel still
 *  has to draw it with the right icon. */
export interface HiddenEntry {
  /** Repo-relative, the currency the tree works in. */
  path: string;
  isDir: boolean;
}

interface HiddenFilesState {
  /** The repo `entries` belongs to, so one project's list is never applied to another's tree. */
  repoPath: string | null;
  entries: HiddenEntry[];
  load: (repoPath: string) => Promise<void>;
  hide: (entry: HiddenEntry) => void;
  show: (path: string) => void;
  showAll: () => void;
}

/** One key per repo, matching how the editor is scoped. */
function key(repoPath: string): string {
  return `editor_hidden:${repoPath}`;
}

/** Folders first, then alphabetically — the order the explorer itself lists things in, so the
 *  panel reads as the same tree with rows taken out rather than as an unrelated list. */
function sorted(entries: HiddenEntry[]): HiddenEntry[] {
  return [...entries].sort(
    (a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path),
  );
}

function parse(stored: string | null): HiddenEntry[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    // Filtered rather than trusted: this is a hand-editable settings value, and one malformed row
    // should cost that row, not the whole list — which here would mean the explorer suddenly
    // showing everything again with no explanation.
    return sorted(
      parsed.filter(
        (row): row is HiddenEntry =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as HiddenEntry).path === "string" &&
          (row as HiddenEntry).path !== "" &&
          typeof (row as HiddenEntry).isDir === "boolean",
      ),
    );
  } catch {
    return [];
  }
}

export const useHiddenFilesStore = create<HiddenFilesState>((set, get) => ({
  repoPath: null,
  entries: [],

  load: async (repoPath) => {
    if (get().repoPath === repoPath) return;
    // Cleared first: between here and the read below the tree would otherwise hide this project's
    // rows using the previous project's list.
    set({ repoPath, entries: [] });
    const stored = await getSetting(key(repoPath)).catch(() => null);
    // A project switched again while this was in flight owns the store now.
    if (get().repoPath !== repoPath) return;
    set({ entries: parse(stored) });
  },

  hide: (entry) => {
    const { repoPath, entries } = get();
    if (repoPath === null || !entry.path) return;
    if (entries.some((row) => row.path === entry.path)) return;
    const next = sorted([...entries, entry]);
    set({ entries: next });
    void setSetting(key(repoPath), JSON.stringify(next)).catch(() => {});
  },

  show: (path) => {
    const { repoPath, entries } = get();
    if (repoPath === null) return;
    const next = entries.filter((row) => row.path !== path);
    set({ entries: next });
    void setSetting(key(repoPath), JSON.stringify(next)).catch(() => {});
  },

  showAll: () => {
    const { repoPath } = get();
    if (repoPath === null) return;
    set({ entries: [] });
    void setSetting(key(repoPath), "[]").catch(() => {});
  },
}));
