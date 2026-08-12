import { create } from "zustand";

import { getFileBlame } from "../lib/tauri/commands";
import type { FileBlame } from "../types/domain";

/**
 * Committed blames of files the editor has annotated, keyed by repository + path + the commit they
 * were computed against.
 *
 * **Why the cache is here and not in Rust.** A `git2::Blame` borrows the `Repository` it came from
 * and is not `Send`, which is the same fact `commands/git_ops.rs`'s header comment is built around —
 * so a `.manage()`d cache on the backend could not hold the blame itself, only the already-
 * serialized `Vec<BlameHunkInfo>`, which is exactly what this Map holds for free after one IPC hop.
 * There is also no git-result cache in the backend to copy: the managed state there is registries
 * and a DB handle, and the only statics in `git/` are a settings mirror and a test mutex. And
 * invalidation needs to know which tabs are open and whether the buffer is dirty — facts that only
 * exist on this side.
 *
 * **The key has three parts and each one is doing a job.** `repoPath` so two projects cannot answer
 * for each other; `filePath` because a blame is per file; and `headOid` because that is the entire
 * invalidation story. A commit, amend, checkout, reset, merge or rebase — ours or made in a terminal
 * — moves HEAD, `get_status` reports the new `head_oid` (the watcher does not filter `.git/HEAD` or
 * `.git/refs/heads/*`, so an external one arrives too), the key changes, the next read misses and
 * the stale entry ages out. No event to subscribe to, no timer, and no extra backend call, since
 * `status.head_oid` is already computed and already in the repo store.
 *
 * Two things deliberately do *not* invalidate an entry: staging, because `blame_buffer` compares
 * against the commit and never the index; and fetching, because no ref a blame walks moves on fetch.
 * One accepted hole, inherited from the watcher rather than introduced here: a tracked file inside an
 * ignored directory (`dist`, `node_modules`, …) produces no filesystem event, so after an external
 * commit its `head_oid` can lag until some other refresh, and the annotation is stale until then.
 * Every other git view in the app has exactly the same hole.
 *
 * **Dirty buffers are not cached at all.** A blame of unsaved content is a function of the buffer,
 * which changes on every keystroke; caching it would mean an entry per keystroke, all but one of them
 * already wrong. Those go straight through `load`'s `contents` path with no read and no write.
 */
const cache = new Map<string, FileBlame>();

/**
 * Eight, where the diff cache next door keeps four. One entry is a few hundred hunk objects for a
 * normal file and ~400 KB for a pathological one (a 5,000-line file at ~2,000 hunks), so the worst
 * case across all eight slots is a few megabytes — where the diff cache holds whole files line by
 * line and a generated lockfile alone is tens of megabytes. What the extra slots buy is the common
 * case this feature actually lives in: two panes plus flipping between the handful of tabs you are
 * working in, all of which should be instant rather than re-crossing IPC for a blame nothing has
 * invalidated.
 */
const CACHE_LIMIT = 8;

/**
 * Blames already in flight, so the two panes of a split showing one file blame it once.
 *
 * Without this, opening a file in two groups fires two identical revwalks — the expensive half of a
 * blame — and both write the same entry. Keyed identically to `cache`, and cleared in a `finally` so
 * a failed blame is retried rather than remembered as pending forever.
 */
const inflight = new Map<string, Promise<FileBlame>>();

/**
 * The escape `\0`, not a raw NUL byte. Two files in this feature's neighbourhood already contain
 * literal NULs, which makes `file` classify them as binary data and makes the toolchain's `grep -I`
 * skip them entirely — a real cost when they are the files you need to search.
 */
const keyFor = (repoPath: string, filePath: string, headOid: string) =>
  `${repoPath}\0${filePath}\0${headOid}`;

interface BlameState {
  /**
   * The file's committed blame, from the cache when possible.
   *
   * Passing `contents` means "blame this unsaved buffer instead", which bypasses the cache in both
   * directions — see the note above. `headOid` is only a cache key here; the backend always blames
   * against the HEAD it reads for itself and reports it back on `FileBlame.head_oid`, so a stale
   * `headOid` from the caller can cost a redundant fetch but can never mislabel the result.
   */
  load: (repoPath: string, filePath: string, headOid: string, contents?: string) => Promise<FileBlame>;
  /** Drops everything. Called when the project changes: not needed for correctness, since every key
   *  carries its repository, but it stops a closed project's files holding the eight slots. */
  clear: () => void;
}

/**
 * Imperative access only — nothing subscribes.
 *
 * The store exists for the lifetime and the `clear()` seam, not for reactivity: the cache is a `Map`
 * mutated in place, so a component that subscribed to it would either re-render on every insert (a
 * blame lands, every editor pane re-renders) or not at all. Callers read through
 * `useBlameStore.getState().load(...)` and render from what it resolves to.
 */
export const useBlameStore = create<BlameState>(() => ({
  load: async (repoPath, filePath, headOid, contents) => {
    if (contents !== undefined) return getFileBlame(repoPath, filePath, contents);

    const key = keyFor(repoPath, filePath, headOid);
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = inflight.get(key);
    if (pending) return pending;

    const request = getFileBlame(repoPath, filePath)
      .then((blame) => {
        cache.set(key, blame);
        // Map iteration is insertion-ordered, so the first key is the oldest — the same eviction as
        // the editor's full-diff cache.
        if (cache.size > CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        return blame;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, request);
    return request;
  },

  clear: () => {
    cache.clear();
    // In-flight requests are left to settle: their `finally` still fires and their `.set` writes an
    // entry keyed on the repository that is going away, which the next `clear` or the eight-slot
    // limit removes. Aborting them would need a cancellation token for no gain — the answer is
    // already paid for and simply unwanted.
    inflight.clear();
  },
}));
