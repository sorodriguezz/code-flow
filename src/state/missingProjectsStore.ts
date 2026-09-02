import { create } from "zustand";
import { initRepository, projectPathHealth } from "../lib/tauri/commands";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Which registered repositories cannot be opened, and why.
 *
 * `projects.local_path` is written once and never revisited, so what the row claims about the disk
 * can go stale in two different ways:
 *
 * * **The folder is gone** — moved, renamed or deleted from outside CodeFlow. The row still looked
 *   openable and, when opened, pointed the git engine at nothing: seven refreshes failing at once
 *   with no reading of the actual problem.
 * * **The folder is there and is no longer a repository** — its `.git` was deleted by hand, lost
 *   to a "copy the files, not the history" move, or never restored after an archive was unpacked
 *   over it. This one read *worse* than the first, because everything about the row claimed to
 *   work: it opened, it was selectable, and every git call under it failed with "could not find
 *   repository" for a folder the user could see in their file manager.
 *
 * They are kept apart rather than merged into one "broken" flag because the offer differs. A
 * folder that is gone can only be taken off the list — there is nothing on disk to act on. A
 * folder that stopped being a repository is still full of the user's files, so the honest first
 * offer is to make it a repository again ([`initRepo`]), with removal as the second.
 *
 * **Keyed on the path, not the project id.** Two workspaces can track the same checkout, and the
 * same folder breaking is one answer, not two — which also means a re-check costs one `stat`
 * per distinct path rather than one per row on screen.
 *
 * **Nothing here is persisted, and that is the point.** Both verdicts are facts about the disk
 * right now: a repository on an external drive is gone while the drive is unplugged and back the
 * moment it is mounted, and a verdict cached across launches would keep striking it out.
 */
interface MissingProjectsState {
  /** The `local_path`s that are not on disk. Empty until the first check lands, so the app never
   *  opens with rows struck out on a guess. */
  missing: ReadonlySet<string>;
  /** The `local_path`s whose folder is there but is not a git repository any more. Disjoint from
   *  [`missing`] — the backend puts a path in at most one list. */
  notARepo: ReadonlySet<string>;
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
  /**
   * Makes a folder a git repository again, and re-checks straight afterwards.
   *
   * The re-check is what takes the row out of `notARepo`, and it is awaited rather than fired off:
   * the caller is a button whose spinner has to stop only once the row it belongs to has actually
   * changed, and a `refresh` left in flight would flip the row a beat after the button said it was
   * done. Rejections are the caller's to show — this store has no toast of its own, and the
   * backend's message ("… is already a git repository") is the useful one.
   */
  initRepo: (path: string) => Promise<void>;
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
 * where nothing is ever broken, is every focus for the life of the session.
 */
function same(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((path) => a.has(path));
}

/** A stable empty verdict, for the same reason `same` exists: two of these are handed out per
 *  check, and rebuilding an empty `Set` would be a fresh reference every time. */
const NONE: ReadonlySet<string> = new Set<string>();

/** Guards against two checks overlapping — focus can fire while the list is still loading, and the
 *  later answer is not necessarily the one that lands last. */
let inFlight = 0;

export const useMissingProjectsStore = create<MissingProjectsState>((set, get) => ({
  missing: NONE,
  notARepo: NONE,

  check: async (paths) => {
    if (paths.length === 0) {
      if (get().missing.size > 0 || get().notARepo.size > 0) set({ missing: NONE, notARepo: NONE });
      return;
    }
    const ticket = ++inFlight;
    let health: { missing: string[]; not_a_repo: string[] };
    try {
      health = await projectPathHealth(paths);
    } catch {
      // The command itself did not answer, which says nothing about the folders. Keeping the last
      // verdict is the honest response: inventing "all healthy" would un-strike rows that really
      // are broken, and inventing "all broken" would lock the whole sidebar on an IPC hiccup.
      return;
    }
    // A newer check started while this one was out; its answer is the current one.
    if (ticket !== inFlight) return;
    // Compared separately and written together, so a change in either verdict costs one `set` and
    // a change in neither costs none.
    const missingMoved = !same(get().missing, health.missing);
    const repoMoved = !same(get().notARepo, health.not_a_repo);
    if (!missingMoved && !repoMoved) return;
    set({
      missing: missingMoved ? new Set(health.missing) : get().missing,
      notARepo: repoMoved ? new Set(health.not_a_repo) : get().notARepo,
    });
  },

  refresh: () => get().check(knownPaths()),

  initRepo: async (path) => {
    await initRepository(path);
    await get().refresh();
  },

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

/** Whether this repository's folder is there but has stopped being a repository. Same shape and
 *  same reasoning as [`useProjectMissing`]; the two are never both true for one path. */
export function useProjectNotARepo(localPath: string): boolean {
  return useMissingProjectsStore((s) => s.notARepo.has(localPath));
}
