import { create } from "zustand";
import { missingProjectPaths } from "../lib/tauri/commands";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Which registered repositories are no longer at the path they were added from.
 *
 * `projects.local_path` is written once and never revisited, so a folder that was moved, renamed
 * or deleted from outside CodeFlow left a row that still looked openable and, when opened, pointed
 * the git engine at nothing — seven refreshes failing at once with no reading of the actual
 * problem. The sidebar and Settings ask this store instead, and a repository whose folder is gone
 * stops being something you can open and becomes something you can only remove.
 *
 * **Keyed on the path, not the project id.** Two workspaces can track the same checkout, and the
 * same folder disappearing is one answer, not two — which also means a re-check costs one `stat`
 * per distinct path rather than one per row on screen.
 *
 * **Nothing here is persisted, and that is the point.** A missing folder is a fact about the disk
 * right now: a repository on an external drive is gone while the drive is unplugged and back the
 * moment it is mounted, and a verdict cached across launches would keep striking it out.
 */
interface MissingProjectsState {
  /** The `local_path`s that are not on disk. Empty until the first check lands, so the app never
   *  opens with rows struck out on a guess. */
  missing: ReadonlySet<string>;
  /** Re-reads exactly these paths. */
  check: (paths: string[]) => Promise<void>;
  /** Re-reads whatever the loaded workspaces currently hold — what focus and the project list
   *  changing both want. */
  refresh: () => Promise<void>;
  /**
   * Starts keeping the answer current and returns the stop, the shape `powerStore.watch` uses.
   *
   * Three triggers, no timer. The project list changing covers adding, removing and switching
   * workspace; returning to the window covers the case this exists for, which is the user deleting
   * a folder in Finder and coming back. There is no fourth: a poll would be statting the disk
   * every few seconds to catch a change the user makes by hand, once, and then looks at the app
   * to see the result of.
   */
  watch: () => () => void;
}

/** Every path the loaded workspaces track, deduplicated. */
function knownPaths(): string[] {
  const paths = new Set<string>();
  for (const projects of Object.values(useWorkspaceStore.getState().projectsByWorkspace)) {
    for (const project of projects) paths.add(project.local_path);
  }
  return [...paths];
}

/**
 * Whether two answers say the same thing.
 *
 * The check runs on every focus, and writing a fresh `Set` each time would re-render every project
 * row in the sidebar and in Settings for an answer that has not moved — which for the normal case,
 * where nothing is ever missing, is every focus for the life of the session.
 */
function same(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((path) => a.has(path));
}

/** Guards against two checks overlapping — focus can fire while the list is still loading, and the
 *  later answer is not necessarily the one that lands last. */
let inFlight = 0;

export const useMissingProjectsStore = create<MissingProjectsState>((set, get) => ({
  missing: new Set<string>(),

  check: async (paths) => {
    if (paths.length === 0) {
      if (get().missing.size > 0) set({ missing: new Set<string>() });
      return;
    }
    const ticket = ++inFlight;
    let gone: string[];
    try {
      gone = await missingProjectPaths(paths);
    } catch {
      // The command itself did not answer, which says nothing about the folders. Keeping the last
      // verdict is the honest response: inventing "all present" would un-strike rows that really
      // are gone, and inventing "all missing" would lock the whole sidebar on an IPC hiccup.
      return;
    }
    // A newer check started while this one was out; its answer is the current one.
    if (ticket !== inFlight) return;
    if (!same(get().missing, gone)) set({ missing: new Set(gone) });
  },

  refresh: () => get().check(knownPaths()),

  watch: () => {
    void get().refresh();

    const onWake = () => {
      if (document.visibilityState === "visible") void useMissingProjectsStore.getState().refresh();
    };
    // Focus as well as visibility: on Windows a window can be behind another and still count as
    // visible, so alt-tabbing back fires only one of the two. Coming back to the app is the one
    // moment the answer is most likely to have gone stale.
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    // Adding a repository, removing one, or opening a workspace whose list had never been read —
    // all of them arrive here as a new `projectsByWorkspace`, and all of them want the same
    // re-check. Settings is the reason the whole map is watched rather than the active workspace:
    // it lists every workspace's repositories at once and loads the ones nobody has switched into.
    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      if (state.projectsByWorkspace !== previous.projectsByWorkspace) {
        void useMissingProjectsStore.getState().refresh();
      }
    });

    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      unsubscribe();
    };
  },
}));

/**
 * Whether this repository's folder is gone — the selector every row uses.
 *
 * A hook rather than a `get()` so the row re-renders when the verdict changes, and returning a
 * boolean rather than the `Set` so it only re-renders when *its own* verdict changes.
 */
export function useProjectMissing(localPath: string): boolean {
  return useMissingProjectsStore((s) => s.missing.has(localPath));
}
