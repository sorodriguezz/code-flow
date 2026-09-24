import { create } from "zustand";
import { isRepoBusy } from "./tauri/commands";
import { CANCELLED_MARKER, useAiRunStore } from "../state/aiRunStore";
import { translate } from "../state/languageStore";

/**
 * Waiting for a repository instead of failing because it is busy.
 *
 * The backend runs one engine per working copy (`ai_locks.rs`): a chat turn, a change analysis and a
 * "resolve with AI" fix all take the same lease, and a second one is refused on the spot with
 * `REPO_BUSY::`. That refusal is free — nothing was recorded, nothing touched — but the panel used
 * to hand it straight to the user: the question vanished from the transcript with a toast, the
 * analysis landed as an error. A second chat in the same repository simply could not be had, while
 * the chat store's own comment promised it could.
 *
 * So a refusal now means *wait*: the request stays where it was asked, marked as queued behind
 * whatever holds the repository, and is tried again the moment a run ends (or every few seconds,
 * for holders this window cannot see — another window, a phone, a story run). Stopping a queued run
 * is an ordinary stop: it throws the same cancellation the backend would have.
 */

/** How often to try again when nothing observable has finished. Cheap: a refusal is decided before
 *  the engine is spawned. */
const RETRY_EVERY_MS = 4000;
/** Past this the request gives up with the original busy error — a lease held this long is a run
 *  somebody should look at, not one to wait on silently. */
const GIVE_UP_AFTER_MS = 20 * 60 * 1000;

export interface QueuedRun {
  projectId: string;
  since: number;
  /** What holds the repository, as far as this window can tell; `null` when it cannot. */
  holder: string | null;
}

interface RepoQueueState {
  /** Runs waiting for their repository, by run id. */
  queued: Record<string, QueuedRun>;
}

export const useRepoQueueStore = create<RepoQueueState>(() => ({ queued: {} }));

function markQueued(runId: string, entry: QueuedRun | null): void {
  useRepoQueueStore.setState((s) => {
    if (!entry) {
      if (!(runId in s.queued)) return s;
      const { [runId]: _gone, ...rest } = s.queued;
      return { queued: rest };
    }
    return { queued: { ...s.queued, [runId]: entry } };
  });
}

/**
 * What is holding `projectId`'s repository, named the way the status bar names runs. Looks for a
 * live run that targets the project and is not `ownRunId`; `null` when none is visible from here.
 */
export function repoHolder(projectId: string, ownRunId?: string): string | null {
  const runs = useAiRunStore.getState();
  for (const runId of Object.keys(runs.active)) {
    if (runId === ownRunId || !runs.active[runId]) continue;
    if (useRepoQueueStore.getState().queued[runId]) continue;
    const about = runs.aboutByRun[runId];
    if (about?.target?.projectId !== projectId) continue;
    const kind = translate(about.kindKey);
    return about.detail ? `${kind} · «${about.detail.length > 40 ? `${about.detail.slice(0, 39)}…` : about.detail}»` : kind;
  }
  return null;
}

/** What a stop throws while the run is still waiting: an ordinary cancellation (so every caller's
 *  existing "stopped is not a failure" handling applies) that also says it never ran. */
const QUEUED_TAG = "queued-before-start:";

function queuedCancellation(runId: string): Error {
  return new Error(`${CANCELLED_MARKER}${QUEUED_TAG}${runId}`);
}

/** Whether `error` is a stop that landed while the run was still waiting for its repository —
 *  nothing ran, so there is nothing to file and the request can be handed back as it was. */
export function isQueuedCancellation(error: unknown): boolean {
  return String(error).includes(`${CANCELLED_MARKER}${QUEUED_TAG}`);
}

/** Resolves when a run ends anywhere, when `delay` passes, or when `runId` is being stopped. */
function nextChance(runId: string, delay: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, delay);
    const unsubscribe = useAiRunStore.subscribe((state, previous) => {
      if (state.cancelling[runId]) return finish();
      // A run leaving `active` is the lease most likely to have just been released.
      for (const id of Object.keys(previous.active)) {
        if (previous.active[id] && !state.active[id]) return finish();
      }
    });
  });
}

/**
 * Runs `attempt`, and while the backend answers that the repository is busy, waits and tries again.
 *
 * `runId` is the id the attempt runs under: it is what the queued mark is filed by (so the UI can
 * say "queued" on the right turn or job) and what a stop is detected on.
 */
export async function whenRepoFree<T>(projectId: string, runId: string, attempt: () => Promise<T>): Promise<T> {
  const started = Date.now();
  // A retry that gets the lease is a run like any other from its first sign of life on: the engine
  // announcing itself, or its first line of output. A refused attempt produces neither — the lease
  // is taken before anything is spawned — so either one is proof the wait is over.
  const stopWatching = useAiRunStore.subscribe((state) => {
    if (!useRepoQueueStore.getState().queued[runId]) return;
    if (state.engineByRun[runId] || (state.linesByRun[runId]?.length ?? 0) > 0) markQueued(runId, null);
  });
  try {
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (!isRepoBusy(error)) throw error;
        if (useAiRunStore.getState().cancelling[runId]) throw queuedCancellation(runId);
        if (Date.now() - started > GIVE_UP_AFTER_MS) throw error;
        markQueued(runId, {
          projectId,
          since: useRepoQueueStore.getState().queued[runId]?.since ?? Date.now(),
          holder: repoHolder(projectId, runId),
        });
        await nextChance(runId, RETRY_EVERY_MS);
        if (useAiRunStore.getState().cancelling[runId]) throw queuedCancellation(runId);
      }
    }
  } finally {
    stopWatching();
    markQueued(runId, null);
  }
}

/** Whether `runId` is waiting for its repository right now. */
export function useIsQueued(runId: string | null | undefined): QueuedRun | null {
  return useRepoQueueStore((s) => (runId ? (s.queued[runId] ?? null) : null));
}
