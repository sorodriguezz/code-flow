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
import type { ChatConversationSummary } from "../types/domain";

/** One row in the unified "Activity" list — one *activity*: a chat conversation, or a background
 * job that may collapse several runs of the same thing (`runs`, newest first; `job` is the
 * representative latest run). See [`mergeActivityEntries`]. Because a row owns *all* its runs,
 * deleting it can remove the whole thing + history in one go, not one run at a time. */
export type ActivityEntry =
  | { type: "job"; job: Job; runs: Job[] }
  | { type: "chat"; conv: ChatConversationSummary };

/** Collapses everything that happened to the *same thing* into one row: a PR's reviews **and** the
 * decisions taken on it (approve / request changes / close) become one "#3 Tests" row, and every
 * `analyze-changes` run of the project becomes one "pre-commit" row — instead of N rows that read
 * as a bug. The row carries all of them (newest first) so the trash wipes the whole history at
 * once; the representative `job` is the newest, which is why a closed PR's row reads "#3 Tests ·
 * Closed". Chats are one activity each already. */
export function mergeActivityEntries(jobs: Job[], conversations: ChatConversationSummary[]): ActivityEntry[] {
  const prRuns = new Map<number, Job[]>();
  const analyzeRuns: Job[] = [];
  const standalone: Job[] = [];
  for (const job of jobs) {
    const belongsToPr = job.kind === "pr-review" || job.kind === "pr-action";
    if (belongsToPr && typeof job.meta.prId === "number") {
      const runs = prRuns.get(job.meta.prId);
      if (runs) runs.push(job);
      else prRuns.set(job.meta.prId, [job]);
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

  const entries: ActivityEntry[] = [
    ...jobEntries,
    ...conversations.map((conv): ActivityEntry => ({ type: "chat", conv })),
  ];
  return entries.sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
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
  return entry.type === "job" ? entry.job.createdAt : new Date(entry.conv.updated_at).getTime();
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
    return { icon: MessageSquare, color: "var(--cf-text-muted)", spinning: false };
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
  state: { selectedPrId: number | null; analyzeOpen: boolean; analyzeJobId: string | null; activeSessionId: string | null },
): string | null {
  if (state.selectedPrId !== null) {
    // Matched against every entry in the row, not just its newest: a PR whose latest event is a
    // decision rather than a review still has to highlight when that PR is open.
    const match = entries.find(
      (e) =>
        e.type === "job" &&
        e.runs.some(
          (run) => (run.kind === "pr-review" || run.kind === "pr-action") && run.meta.prId === state.selectedPrId,
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
