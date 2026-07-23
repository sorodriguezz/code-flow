import { GitPullRequest, Loader2, MessageSquare, ShieldCheck, XCircle, type LucideIcon } from "lucide-react";
import type { Job } from "../state/jobsStore";
import type { ChatConversationSummary } from "../types/domain";

/** One row in the unified "Activity" list — a background job (PR review / pre-commit
 * analysis) or a past chat conversation, shown side by side sorted by recency instead of in
 * two separate sections. */
export type ActivityEntry = { type: "job"; job: Job } | { type: "chat"; conv: ChatConversationSummary };

export function mergeActivityEntries(jobs: Job[], conversations: ChatConversationSummary[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [
    ...jobs.map((job): ActivityEntry => ({ type: "job", job })),
    ...conversations.map((conv): ActivityEntry => ({ type: "chat", conv })),
  ];
  return entries.sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
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
  state: { selectedPrId: number | null; analyzeOpen: boolean; activeSessionId: string | null },
): string | null {
  if (state.selectedPrId !== null) {
    const match = entries.find((e) => e.type === "job" && e.job.kind === "pr-review" && e.job.meta.prId === state.selectedPrId);
    return match ? entryKey(match) : null;
  }
  if (state.analyzeOpen) {
    const match = entries.find((e) => e.type === "job" && e.job.kind === "analyze-changes");
    return match ? entryKey(match) : null;
  }
  if (state.activeSessionId) {
    const match = entries.find((e) => e.type === "chat" && e.conv.session_id === state.activeSessionId);
    return match ? entryKey(match) : null;
  }
  return null;
}
