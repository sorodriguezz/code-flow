import { GitPullRequest, Loader2, MessageSquare, ShieldCheck, XCircle, type LucideIcon } from "lucide-react";
import type { Job } from "../state/jobsStore";
import type { ChatConversationSummary } from "../types/domain";

/** One row in the unified "Activity" list — a background job (PR review / pre-commit
 * analysis) or a past chat conversation, shown side by side sorted by recency instead of in
 * two separate sections. A job row can stand for several runs collapsed together (`runCount`),
 * see [`mergeActivityEntries`]. */
export type ActivityEntry =
  | { type: "job"; job: Job; runCount: number }
  | { type: "chat"; conv: ChatConversationSummary };

/** Reviewing the *same* PR again is the common case (fix findings → re-review), and each run is a
 * separate job — which used to stack up as N identical "#3 Tests" rows that looked like a bug
 * ("¿por qué está cinco veces?"). Collapse every `pr-review` run of one PR into a single row
 * standing for its latest run, tagged with how many runs there were; pre-commit analyses and
 * chats stay individual (each is a distinct point-in-time result the user may want to reopen). */
export function mergeActivityEntries(jobs: Job[], conversations: ChatConversationSummary[]): ActivityEntry[] {
  const prRuns = new Map<number, Job[]>();
  const standalone: Job[] = [];
  for (const job of jobs) {
    const prId = job.kind === "pr-review" && typeof job.meta.prId === "number" ? job.meta.prId : null;
    if (prId === null) {
      standalone.push(job);
      continue;
    }
    const runs = prRuns.get(prId);
    if (runs) runs.push(job);
    else prRuns.set(prId, [job]);
  }

  const jobEntries: ActivityEntry[] = standalone.map((job) => ({ type: "job", job, runCount: 1 }));
  for (const runs of prRuns.values()) {
    const latest = runs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    jobEntries.push({ type: "job", job: latest, runCount: runs.length });
  }

  const entries: ActivityEntry[] = [
    ...jobEntries,
    ...conversations.map((conv): ActivityEntry => ({ type: "chat", conv })),
  ];
  return entries.sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
}

/** How many runs a job row stands for (1 unless it's a collapsed PR-review group). */
export function entryRunCount(entry: ActivityEntry): number {
  return entry.type === "job" ? entry.runCount : 1;
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
    const match = entries.find((e) => e.type === "job" && e.job.kind === "pr-review" && e.job.meta.prId === state.selectedPrId);
    return match ? entryKey(match) : null;
  }
  if (state.analyzeOpen) {
    // A pinned run highlights that exact entry; with none pinned (fresh open) the newest
    // analysis is the one shown, so highlight that.
    const match = state.analyzeJobId
      ? entries.find((e) => e.type === "job" && e.job.id === state.analyzeJobId)
      : entries.find((e) => e.type === "job" && e.job.kind === "analyze-changes");
    return match ? entryKey(match) : null;
  }
  if (state.activeSessionId) {
    const match = entries.find((e) => e.type === "chat" && e.conv.session_id === state.activeSessionId);
    return match ? entryKey(match) : null;
  }
  return null;
}
