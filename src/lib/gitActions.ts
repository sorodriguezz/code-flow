import { useRepoStore } from "../state/repoStore";
import { usePreferencesStore } from "../state/preferencesStore";
import { useFetchTimerStore } from "../state/fetchTimerStore";
import type { BranchInfo } from "../types/domain";

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

/** Fetch now, and restart the auto-fetch countdown — an explicit fetch makes the pending
 * automatic one redundant. */
export function fetchNow(): void {
  void useRepoStore.getState().fetch();
  const { autoFetchSeconds } = usePreferencesStore.getState();
  if (autoFetchSeconds) useFetchTimerStore.getState().setRemaining(autoFetchSeconds);
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
