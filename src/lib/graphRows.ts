import type { CommitInfo, StashInfo } from "../types/domain";

/**
 * The rows the graph draws that are not commits of the history: the uncommitted work on top of
 * HEAD, and the stashes, each hung off the commit it was made on.
 *
 * Both go in as `CommitInfo`s so the layout and the windowing treat them as rows like any other;
 * what they really are is kept beside them in `pseudo`, which the table asks before drawing a row
 * or offering it a menu.
 */

/** The working-tree row's id: never a commit's, so selecting it can never select one. */
export const WORKING_ROW_ID = "cf:working-tree";

export type PseudoRow = { kind: "working"; count: number } | { kind: "stash"; stash: StashInfo };

/** A stash as the commit it is (git stores one), parented on the commit it was made on alone — its
 *  other parents (the index, the untracked files) are git's bookkeeping, not history. */
export function stashCommit(stash: StashInfo): CommitInfo {
  return {
    id: stash.oid,
    short_id: stash.oid.slice(0, 7),
    summary: stash.message,
    author_name: "",
    author_email: "",
    timestamp: stash.timestamp ?? 0,
    parent_ids: stash.base_id ? [stash.base_id] : [],
    refs: [],
  };
}

export function withPseudoRows(
  commits: CommitInfo[],
  { headId, workingCount, stashes }: { headId: string | null; workingCount: number; stashes: StashInfo[] },
): { commits: CommitInfo[]; pseudo: Map<string, PseudoRow>; side: Set<string> } {
  const pseudo = new Map<string, PseudoRow>();
  const side = new Set<string>();
  const before = new Map<string, CommitInfo[]>();
  const hang = (onto: string, row: CommitInfo) => before.set(onto, [...(before.get(onto) ?? []), row]);
  const ids = new Set(commits.map((c) => c.id));

  if (headId && workingCount > 0 && ids.has(headId)) {
    pseudo.set(WORKING_ROW_ID, { kind: "working", count: workingCount });
    hang(headId, {
      id: WORKING_ROW_ID,
      short_id: "",
      summary: "",
      author_name: "",
      author_email: "",
      timestamp: 0,
      parent_ids: [headId],
      refs: [],
    });
  }
  // Newest first, as `git stash list` has them.
  for (const stash of [...stashes].sort((a, b) => a.index - b.index)) {
    if (!stash.base_id || !ids.has(stash.base_id) || ids.has(stash.oid)) continue;
    pseudo.set(stash.oid, { kind: "stash", stash });
    side.add(stash.oid);
    hang(stash.base_id, stashCommit(stash));
  }
  if (before.size === 0) return { commits, pseudo, side };
  const out: CommitInfo[] = [];
  for (const commit of commits) {
    const extra = before.get(commit.id);
    if (extra) out.push(...extra);
    out.push(commit);
  }
  return { commits: out, pseudo, side };
}
