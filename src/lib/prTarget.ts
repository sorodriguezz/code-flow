import * as api from "./tauri/commands";
import type { PrAction, PostFindingItem } from "./tauri/commands";
import type {
  JobHistoryEntry,
  PrDecision,
  PrCommentThread,
  PullRequestSummary,
  ThreadCloseOutcome,
  WorkspaceActivityEntry,
} from "../types/domain";

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

/** Prefix marking an Activity bucket that belongs to a workspace rather than to a project — what
 * tells the stores to read and write `workspace_activity` instead of `job_history`. */
const WORKSPACE_BUCKET = "workspace:";

/** The Activity bucket of a workspace: where everything reviewed from a link is filed. */
export function workspaceActivityKey(workspaceId: string): string {
  return `${WORKSPACE_BUCKET}${workspaceId}`;
}

/** Whether a bucket key names a workspace (see [`workspaceActivityKey`]) rather than a project. */
export function isWorkspaceBucket(key: string): boolean {
  return key.startsWith(WORKSPACE_BUCKET);
}

/** The workspace a bucket key names, or `null` if it names a project. */
export function workspaceIdFromBucket(key: string): string | null {
  return isWorkspaceBucket(key) ? key.slice(WORKSPACE_BUCKET.length) : null;
}

/**
 * The key this target's jobs, chat history and resolutions are filed under.
 *
 * A project uses its own id, so nothing about existing history changes. A link session is filed
 * under its **workspace**: the PR belongs to a repository this machine doesn't have, so there is
 * no project to attach it to, but there is a workspace — and that's the scope at which the review
 * stays useful. It shows in Activity whichever repository of that workspace is open, and stops
 * showing on switching to another one.
 *
 * A workspace bucket therefore holds reviews of *several* repositories, and a PR number only
 * identifies a PR within one repo — which is why anything addressing a single pull request inside
 * a bucket goes through [`targetPrKey`] rather than the bucket plus a number.
 */
export function targetKey(target: PrTarget): string {
  return target.kind === "project" ? target.projectId : workspaceActivityKey(target.workspaceId);
}

/** Identifies one pull request across every bucket: a link PR by its URL (unique by
 * construction), a project's PR by project + number. */
export function targetPrKey(target: PrTarget, prId: number): string {
  return target.kind === "project" ? `${target.projectId}:${prId}` : `pr-link:${target.url}`;
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

/** Closes one of the PR's comment threads on the host, optionally replying on it first. Needs no
 * working copy either way — it's a host call, so a link session answers and closes a conversation
 * exactly like a project does. */
export function resolveCommentThread(
  target: PrTarget,
  prId: number,
  threadId: number,
  reply: { body: string | null; wontFix: boolean },
): Promise<ThreadCloseOutcome> {
  return target.kind === "project"
    ? api.resolvePrCommentThread(target.projectId, prId, threadId, reply.body, reply.wontFix)
    : api.prLinkResolveCommentThread(target.url, threadId, reply.body, reply.wontFix);
}

export function reviewDecision(target: PrTarget, prId: number): Promise<PrDecision> {
  return target.kind === "project" ? api.prReviewDecision(target.projectId, prId) : api.prLinkDecision(target.url);
}

/**
 * Records the decision on the host and returns the PR as it reports it afterwards, plus the
 * persisted Activity row it was filed under — both targets settle the same way. The row lands in
 * `job_history` for a project and in `workspace_activity` for a link session, which is the only
 * difference and one the caller doesn't have to care about: [`targetKey`] already points both at
 * the right bucket.
 */
export async function actOnPr(
  target: PrTarget,
  prId: number,
  action: PrAction,
): Promise<{ pr: PullRequestSummary; activity: JobHistoryEntry | WorkspaceActivityEntry }> {
  if (target.kind === "link") return api.actOnPrLink(target.url, target.workspaceId, action);
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
  force = false,
): Promise<string> {
  return target.kind === "project"
    ? api.reviewPullRequest(target.projectId, prId, jobId, level, force)
    // A review with no clone builds no plan, so nothing there can decide to stop and ask.
    : api.reviewPrFromLink(target.url, jobId, level, target.workspaceId);
}
