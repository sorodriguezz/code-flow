import { useRepoStore } from "../state/repoStore";
import { usePreferencesStore } from "../state/preferencesStore";
import { useFetchTimerStore } from "../state/fetchTimerStore";
import type { BranchInfo, CommitInfo } from "../types/domain";

/**
 * Remote actions and the rules for when they're available, in one place so the status bar's
 * disabled states and the keyboard shortcuts can never drift apart: a shortcut must be a no-op
 * exactly when its button is greyed out.
 */

export function headBranch(): BranchInfo | null {
  return useRepoStore.getState().branches.find((b) => b.is_head) ?? null;
}

/** Nothing to pull unless the branch tracks a remote and is actually behind it. */
export function canPull(branch: BranchInfo | null | undefined): boolean {
  return !!branch?.upstream && branch.behind > 0;
}

/** A branch with no upstream yet is published rather than pushed — always available, unless the
 * branch is locked, which is exactly a refusal to publish it. */
export function canPublish(branch: BranchInfo | null | undefined): boolean {
  return !!branch && !branch.upstream && !branch.is_locked;
}

/** Nothing to push unless there are local commits the remote doesn't have — and nothing to push
 * from a locked branch either. The Rust side refuses too; this is so the button and the shortcut
 * are greyed out together instead of both failing with a toast. */
export function canPush(branch: BranchInfo | null | undefined): boolean {
  return !!branch?.upstream && branch.ahead > 0 && !branch.is_locked;
}

/**
 * Puts the auto-fetch countdown back to full.
 *
 * Called by anything that has just fetched, whoever asked for it: the timer exists to say "the
 * remote was last asked N seconds ago", and letting it run down to zero after a fetch that already
 * happened would spend a second one answering a question nobody still has. A no-op when auto-fetch
 * is switched off, which is when there is no countdown to restart.
 */
export function restartAutoFetchCountdown(): void {
  const { autoFetchSeconds } = usePreferencesStore.getState();
  if (autoFetchSeconds) useFetchTimerStore.getState().setRemaining(autoFetchSeconds);
}

/** Fetch now, and restart the auto-fetch countdown — an explicit fetch makes the pending
 * automatic one redundant. */
export function fetchNow(): void {
  void useRepoStore.getState().fetch();
  restartAutoFetchCountdown();
}

export function pullNow(): void {
  if (!canPull(headBranch())) return;
  void useRepoStore.getState().pull();
}

export function pushNow(): void {
  const branch = headBranch();
  if (canPublish(branch)) {
    void useRepoStore.getState().push(true);
    return;
  }
  if (!canPush(branch)) return;
  void useRepoStore.getState().push(false);
}

/**
 * Whether a commit answers the graph's filter box.
 *
 * Message, author name, author email and hash, folded for accents and case — the four things
 * somebody actually remembers about a commit they are looking for. The hash matches on *prefix*
 * only, because a 40-character hex string contains almost every short hex string by accident and
 * matching anywhere would make `ab` select half the history.
 *
 * A multi-word query is treated as "all of these", not as a phrase: "sofia fix login" should find
 * the login fix Sofía made, and it does not appear in that order in anything.
 */
export function matchesCommit(commit: CommitInfo, query: string): boolean {
  const wanted = fold(query).split(/\s+/).filter(Boolean);
  if (wanted.length === 0) return true;
  const haystack = fold(`${commit.summary} ${commit.author_name} ${commit.author_email}`);
  const id = commit.id.toLowerCase();
  return wanted.every((term) => haystack.includes(term) || id.startsWith(term));
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
