import * as api from "./tauri/commands";
import type { PrAction, PostFindingItem } from "./tauri/commands";
import type { ChatAgentOverride } from "./tauri/commands";
import type { JobHistoryEntry, PrDecision, PrCommentThread, PullRequestSummary } from "../types/domain";

/**
 * Where a pull request under review lives.
 *
 * The PR panel used to assume a project: a row in the database, a clone on disk, a git remote.
 * That assumption is what forced a link-only review into a modal of its own, with none of the
 * things a review needs — decisions, comment threads, an Activity trail.
 *
 * Splitting the *target* out from the panel removes the assumption. Every operation a review
 * performs on its PR is either a host call (comments, decisions, publishing) — which only ever
 * needed coordinates and a token — or a local one (the diff, applying a fix), and only the second
 * kind needs a clone. So both targets answer the same questions, and one panel serves both.
 */
export type PrTarget =
  | { kind: "project"; projectId: string }
  /** A PR reached by link with nothing checked out: the diff comes from the host's API. */
  | { kind: "link"; url: string; workspaceId: string };

/**
 * The key this target's jobs, chat history and resolutions are filed under.
 *
 * A project uses its own id, so nothing about existing history changes. A link session gets a key
 * derived from the URL: the per-project stores are plain string maps, so it simply occupies its
 * own bucket. Those buckets are memory-only by design — `job_history` rows belong to a project
 * and this PR has none — which is why a link review's Activity lives as long as the session does.
 */
export function targetKey(target: PrTarget): string {
  return target.kind === "project" ? target.projectId : `pr-link:${target.url}`;
}

/** A link session can't reach the working copy, so anything that edits files is off the table. */
export function targetProjectId(target: PrTarget): string | undefined {
  return target.kind === "project" ? target.projectId : undefined;
}

export function listCommentThreads(target: PrTarget, prId: number): Promise<PrCommentThread[]> {
  return target.kind === "project"
    ? api.listPrCommentThreads(target.projectId, prId)
    : api.prLinkCommentThreads(target.url);
}

export function reviewDecision(target: PrTarget, prId: number): Promise<PrDecision> {
  return target.kind === "project" ? api.prReviewDecision(target.projectId, prId) : api.prLinkDecision(target.url);
}

/**
 * Records the decision on the host and returns the PR as it reports it afterwards — both targets
 * settle the same way. `activity` is the persisted Activity row a project-backed decision is
 * filed under; a link session has no project to file one against, so it comes back `null` and the
 * caller keeps the entry in memory instead.
 */
export async function actOnPr(
  target: PrTarget,
  prId: number,
  action: PrAction,
): Promise<{ pr: PullRequestSummary; activity: JobHistoryEntry | null }> {
  if (target.kind === "link") return { pr: await api.actOnPrLink(target.url, action), activity: null };
  return api.actOnPullRequest(target.projectId, prId, action);
}

/** Re-reads the PR itself, so a header settles onto the host's answer rather than a guess. */
export async function refreshPr(target: PrTarget, prId: number): Promise<PullRequestSummary | null> {
  if (target.kind === "link") return api.prLinkPullRequest(target.url);
  const prs = await api.listPullRequests(target.projectId);
  return prs.find((pr) => pr.id === prId) ?? null;
}

export function postFindings(
  target: PrTarget,
  prId: number,
  runId: string,
  items: PostFindingItem[],
  postSummary: boolean,
  summary: string | null,
): Promise<void> {
  return target.kind === "project"
    ? api.postPrReviewComment(target.projectId, prId, runId, items, postSummary, summary)
    : api.postPrLinkReviewComment(target.url, items, postSummary, summary);
}

/**
 * Runs the review. The project-backed one diffs the local clone and remembers the run; the
 * link-backed one reads the diff from the host's API and doesn't — a weaker review, on purpose,
 * and the panel says so.
 */
export function review(
  target: PrTarget,
  prId: number,
  jobId: string,
  level: string,
  agent: ChatAgentOverride | null,
): Promise<string> {
  return target.kind === "project"
    ? api.reviewPullRequest(target.projectId, prId, jobId, level, agent)
    : api.reviewPrFromLink(target.url, jobId, level, target.workspaceId);
}
