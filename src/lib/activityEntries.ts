import {
  Ban,
  GitPullRequest,
  Loader2,
  MessageSquare,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { Job } from "../state/jobsStore";
import type { ChatSession } from "../state/chatStore";
import type { ChatConversationSummary } from "../types/domain";

/** One row in the unified "Activity" list — one *activity*: a chat conversation, or a background
 * job that may collapse several runs of the same thing (`runs`, newest first; `job` is the
 * representative latest run). See [`mergeActivityEntries`]. Because a row owns *all* its runs,
 * deleting it can remove the whole thing + history in one go, not one run at a time.
 *
 * A chat row carries its `live` session when it has one — the in-memory conversation, which is
 * the only thing that knows a turn is currently in flight. The backend writes a conversation's
 * row when a turn *lands*, so without this a chat mid-answer had nothing in Activity at all. */
export type ActivityEntry =
  | { type: "job"; job: Job; runs: Job[] }
  | { type: "chat"; conv: ChatConversationSummary; live: ChatSession | null };

/** Turns a conversation that exists only in memory into a row Activity can render, so a chat is
 * listed from its first question rather than from its first answer. */
function summaryOfLive(session: ChatSession): ChatConversationSummary {
  return {
    session_id: session.conversationId,
    project_id: session.projectId,
    title: session.title,
    created_at: new Date(session.createdAt).toISOString(),
    updated_at: new Date(session.updatedAt).toISOString(),
    turn_count: session.messages.filter((m) => m.role === "user").length,
  };
}

/** Collapses everything that happened to the *same thing* into one row: a PR's reviews **and** the
 * decisions taken on it (approve / request changes / close) become one "#3 Tests" row, and every
 * `analyze-changes` run of the project becomes one "pre-commit" row — instead of N rows that read
 * as a bug. The row carries all of them (newest first) so the trash wipes the whole history at
 * once; the representative `job` is the newest, which is why a closed PR's row reads "#3 Tests ·
 * Closed". Chats are one activity each already.
 *
 * `liveChats` are the conversations still in memory this session. One that also has a persisted
 * row is attached to it (same activity, seen from two sides — the row supplies the title the user
 * may have renamed, the session supplies whether it is running); one with no row yet gets a
 * synthesized summary so it is listed from the moment its first question is asked. */
export function mergeActivityEntries(
  jobs: Job[],
  conversations: ChatConversationSummary[],
  liveChats: ChatSession[] = [],
): ActivityEntry[] {
  const prRuns = new Map<string | number, Job[]>();
  const analyzeRuns: Job[] = [];
  const standalone: Job[] = [];
  for (const job of jobs) {
    const belongsToPr = job.kind === "pr-review" || job.kind === "pr-action";
    if (belongsToPr && typeof job.meta.prId === "number") {
      // Keyed by URL when there is one: a workspace's Activity holds reviews of *several*
      // repositories reached by link, and a PR number only identifies a PR within one repo — so
      // grouping on the number alone would fold two unrelated "#42"s into a single row.
      const key = jobPrUrl(job) ?? job.meta.prId;
      const runs = prRuns.get(key);
      if (runs) runs.push(job);
      else prRuns.set(key, [job]);
    } else if (job.kind === "analyze-changes") {
      analyzeRuns.push(job);
    } else {
      standalone.push(job);
    }
  }

  const byNewest = (runs: Job[]) => [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const jobEntries: ActivityEntry[] = standalone.map((job) => ({ type: "job", job, runs: [job] }));
  for (const runs of prRuns.values()) {
    const sorted = byNewest(runs);
    jobEntries.push({ type: "job", job: sorted[0], runs: sorted });
  }
  if (analyzeRuns.length > 0) {
    const sorted = byNewest(analyzeRuns);
    jobEntries.push({ type: "job", job: sorted[0], runs: sorted });
  }

  const liveById = new Map(liveChats.map((s) => [s.conversationId, s]));
  const chatEntries: ActivityEntry[] = conversations.map((conv): ActivityEntry => {
    const live = liveById.get(conv.session_id) ?? null;
    liveById.delete(conv.session_id);
    return { type: "chat", conv, live };
  });
  // Whatever is left has no row on disk yet: a conversation whose first turn is still running, or
  // one the user stopped. An empty one (opened but never asked anything) isn't an activity.
  for (const session of liveById.values()) {
    if (session.messages.length === 0) continue;
    chatEntries.push({ type: "chat", conv: summaryOfLive(session), live: session });
  }

  const entries: ActivityEntry[] = [...jobEntries, ...chatEntries];
  return entries.sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
}

/** The link a job's pull request was reached by, or `null` for a PR that came from a project's own
 * list. This is what marks a row as workspace-global: the repository isn't on this machine, so the
 * URL is the only handle on it — and the only identity that doesn't collide across repos. */
export function jobPrUrl(job: Job): string | null {
  return typeof job.meta.prUrl === "string" ? job.meta.prUrl : null;
}

/** Whether this row belongs to the workspace rather than to a repository — a PR reviewed from a
 * link alone. Drawn with a globe, since it sits in the same list as the reviews of repositories
 * the user does have and belongs to none of them. */
export function entryIsGlobal(entry: ActivityEntry): boolean {
  return entry.type === "job" && jobPrUrl(entry.job) !== null;
}

/** How many *runs* a job row stands for (1 for a chat or a single-run job).
 *
 * A recorded decision isn't a run, so it doesn't count towards the ×N badge — a PR with two
 * reviews and an approval is "×2", not "×3", which would be claiming a review that never
 * happened. Deletion still covers everything in the row; it counts `runs` itself. */
export function entryRunCount(entry: ActivityEntry): number {
  return entry.type === "job" ? entry.runs.filter((job) => job.kind !== "pr-action").length : 1;
}

export function entryTimestamp(entry: ActivityEntry): number {
  if (entry.type === "job") return entry.job.createdAt;
  // The live session is ahead of the persisted row while a turn is in flight — the row is only
  // rewritten once the answer lands, and a chat you just asked something belongs at the top now.
  return entry.live ? entry.live.updatedAt : new Date(entry.conv.updated_at).getTime();
}

/** Whether this activity is working right now — a job mid-run or a chat mid-answer. What the
 * "running" badge counts, and what makes leaving the row safe to do. */
export function entryIsRunning(entry: ActivityEntry): boolean {
  return entry.type === "job" ? entry.job.status === "running" : (entry.live?.sending ?? false);
}

export function entryKey(entry: ActivityEntry): string {
  return entry.type === "job" ? `job-${entry.job.id}` : `chat-${entry.conv.session_id}`;
}

export function entryTitle(entry: ActivityEntry): string {
  return entry.type === "job" ? entry.job.label : entry.conv.title;
}

/** Icon reflects *what kind* of activity this is (chat / PR review / pre-commit analysis) —
 * a job's status (running/error/done) is layered on top via color, and via swapping to a
 * spinner while running, rather than replacing the kind icon entirely. Without the kind
 * icon, every finished PR review and pre-commit analysis rendered as the same plain
 * checkmark, indistinguishable from each other in the list. */
export function entryVisual(entry: ActivityEntry): { icon: LucideIcon; color: string; spinning: boolean } {
  if (entry.type === "chat") {
    // A chat mid-answer gets the same spinner a running job does — it's the one signal that says
    // "this is still going, you can leave it and come back".
    return entry.live?.sending
      ? { icon: Loader2, color: "var(--cf-accent)", spinning: true }
      : { icon: MessageSquare, color: "var(--cf-text-muted)", spinning: false };
  }
  const { job } = entry;
  if (job.status === "running") return { icon: Loader2, color: "var(--cf-accent)", spinning: true };
  const color = job.status === "error" ? "var(--cf-danger)" : "var(--cf-success)";
  if (job.status === "error") return { icon: XCircle, color, spinning: false };
  // A recorded decision is drawn as the decision itself — the row already spells it out in words,
  // and the icon is what makes it scannable next to the reviews of the same PR.
  if (job.kind === "pr-action") {
    const action = job.meta.action;
    if (action === "approve") return { icon: ThumbsUp, color: "var(--cf-success)", spinning: false };
    if (action === "request_changes") return { icon: ThumbsDown, color: "var(--cf-warning)", spinning: false };
    return { icon: Ban, color: "var(--cf-danger)", spinning: false };
  }
  return { icon: job.kind === "pr-review" ? GitPullRequest : ShieldCheck, color, spinning: false };
}

/** Which entry the AI panel is actually showing right now, so the Activity list can
 * highlight it — the panel only ever displays one of chat / a selected PR / the pre-commit
 * analysis at a time, and each of those maps to a specific entry (or none, if e.g. the
 * selected PR hasn't been reviewed yet and so has no job entry). */
export function findActiveEntryKey(
  entries: ActivityEntry[],
  state: {
    selectedPrId: number | null;
    /** Set when the PR on screen was reached by link — matched instead of the number, which
     * repeats across the repositories a workspace's Activity now spans. */
    linkPrUrl: string | null;
    analyzeOpen: boolean;
    analyzeJobId: string | null;
    activeSessionId: string | null;
  },
): string | null {
  if (state.linkPrUrl !== null) {
    const match = entries.find((e) => e.type === "job" && e.runs.some((run) => jobPrUrl(run) === state.linkPrUrl));
    return match ? entryKey(match) : null;
  }
  if (state.selectedPrId !== null) {
    // Matched against every entry in the row, not just its newest: a PR whose latest event is a
    // decision rather than a review still has to highlight when that PR is open.
    const match = entries.find(
      (e) =>
        e.type === "job" &&
        e.runs.some(
          (run) =>
            (run.kind === "pr-review" || run.kind === "pr-action") &&
            run.meta.prId === state.selectedPrId &&
            // A link review of some other repo's "#42" is not this PR.
            jobPrUrl(run) === null,
        ),
    );
    return match ? entryKey(match) : null;
  }
  if (state.analyzeOpen) {
    // A pinned run highlights its group (match against *any* run, since analyses are now collapsed
    // into one row); with none pinned (fresh open) the newest analysis is shown, so highlight that.
    const match = state.analyzeJobId
      ? entries.find((e) => e.type === "job" && e.runs.some((r) => r.id === state.analyzeJobId))
      : entries.find((e) => e.type === "job" && e.job.kind === "analyze-changes");
    return match ? entryKey(match) : null;
  }
  if (state.activeSessionId) {
    const match = entries.find((e) => e.type === "chat" && e.conv.session_id === state.activeSessionId);
    return match ? entryKey(match) : null;
  }
  return null;
}
