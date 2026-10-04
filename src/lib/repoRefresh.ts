import { isOwnOrigin, onRepoFsChanged, onStateInvalidate } from "./tauri/events";
import { useRepoStore } from "../state/repoStore";

/**
 * How a detached repository window keeps its `repoStore` in step with the disk.
 *
 * The main window has always done this from `App.tsx` — the watcher, the two debounced refreshes,
 * `state:invalidate` for what no watcher sees. A repository window had none of it: it pointed its
 * `repoStore` at the repository and never heard another thing, so Changes, the graph and the editor
 * there went stale the moment anything outside the window touched a file — an agent, a terminal,
 * a phone. `App.tsx` is the shell and must not be in a satellite's bundle, so the same policy lives
 * here for `SatelliteApp`, with the same numbers (see the notes on `FS_NEAR_WAIT_MS` there).
 */

const NEAR_WAIT_MS = 600;
const NEAR_MAX_WAIT_MS = 2000;
const FAR_WAIT_MS = 3000;
const FAR_MAX_WAIT_MS = 10000;

export type Debounced = { (): void; cancel: () => void };

/**
 * Trailing-edge debounce with a ceiling: runs `fn` once a burst has been quiet for `waitMs`, and at
 * the latest `maxWaitMs` after the burst began — a checkout that writes for ten seconds still
 * refreshes along the way. Never leading-edge: a trailing call reads the final state.
 */
export function trailingDebounce(fn: () => void, waitMs: number, maxWaitMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let burstStartedAt = 0;
  const reset = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    burstStartedAt = 0;
  };
  return Object.assign(
    () => {
      const now = Date.now();
      if (burstStartedAt === 0) burstStartedAt = now;
      if (timer !== undefined) clearTimeout(timer);
      const remaining = burstStartedAt + maxWaitMs - now;
      timer = setTimeout(
        () => {
          reset();
          fn();
        },
        Math.max(0, Math.min(waitMs, remaining)),
      );
    },
    { cancel: reset },
  );
}

/**
 * Refreshes this window's repository views when the repository at `repoPath()` changes on disk, when
 * another client says it changed (`state:invalidate` with the `repo` domain), and when the window is
 * focused again. Silent, like the main window's: this is the list keeping up, not the window busy.
 * Returns the teardown.
 */
export function followRepoChanges(
  repoPath: () => string | null,
  /** `statusOnly`: the working tree and nothing else — a floating editor draws its change marks
   *  from it, and has no graph, branches or stashes to keep up. */
  options: { statusOnly?: boolean } = {},
): () => void {
  const near = trailingDebounce(
    () => {
      void useRepoStore.getState().refreshStatus({ silent: true });
      void useRepoStore.getState().refreshMergeState();
    },
    NEAR_WAIT_MS,
    NEAR_MAX_WAIT_MS,
  );
  const far = trailingDebounce(
    () => {
      const repo = useRepoStore.getState();
      void repo.refreshCommits({ silent: true });
      void repo.refreshUnpushedCommits();
      void repo.refreshBranches();
      void repo.refreshStashes();
      void repo.refreshRemotes();
    },
    FAR_WAIT_MS,
    FAR_MAX_WAIT_MS,
  );
  const both = () => {
    near();
    if (!options.statusOnly) far();
  };

  const stopFs = onRepoFsChanged((event) => {
    if (event.repo_path === repoPath()) both();
  }).catch(() => () => {});
  const stopInvalidate = onStateInvalidate((event) => {
    if (event.domain === "repo" && !isOwnOrigin(event.origin)) both();
  }).catch(() => () => {});
  // The watcher goes quiet while nobody is looking (see `watched` in `watcher.rs`), so coming back
  // to the window re-reads the working tree once.
  const onFocus = () => void useRepoStore.getState().refreshStatus({ silent: true });
  window.addEventListener("focus", onFocus);

  return () => {
    near.cancel();
    far.cancel();
    void stopFs.then((off) => off());
    void stopInvalidate.then((off) => off());
    window.removeEventListener("focus", onFocus);
  };
}
