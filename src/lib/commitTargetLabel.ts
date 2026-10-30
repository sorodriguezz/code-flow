import type { CommitTarget } from "../state/repoStore";

/** «branch · repo» for the line under the Commit button; `detachedLabel` stands in for a detached HEAD. */
export function commitTargetLabel(target: CommitTarget, repoName: string, detachedLabel: string): string {
  const where = target.detached || !target.branch ? detachedLabel : target.branch;
  return `${where} · ${repoName}`;
}
