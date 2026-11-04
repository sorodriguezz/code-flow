/**
 * Where a backlog card stands, derived from the work started from it. Pure, so the board and the
 * store agree and the tests can pin it.
 *
 * Only `backlog` and `ready` are the user's to set by hand. Once something runs, the column follows
 * the work — forward only: a card the user dragged to «done» stays there even if a linked task is
 * reopened, because the user said so.
 */
import type { AgentChain, AgentTask } from "../../types/domain";
import type { BacklogItem, BacklogStatus } from "../../types/crew";
import type { TeamRun } from "../../types/team";

export interface WorkIndex {
  tasks: Map<string, AgentTask>;
  chains: Map<string, AgentChain>;
  runs: Map<string, TeamRun>;
  /** Task ids with a turn in flight right now. */
  sending: Set<string>;
}

export type WorkState = "none" | "live" | "needs-you" | "review" | "done" | "failed";

const ORDER: BacklogStatus[] = ["backlog", "ready", "doing", "review", "done"];

/** What the linked work says, in one word. */
export function workState(item: BacklogItem, index: WorkIndex): WorkState {
  if (item.links.length === 0) return "none";
  let live = false;
  let needsYou = false;
  let review = false;
  let failed = false;
  let allDone = true;
  for (const link of item.links) {
    if (link.kind === "team_run") {
      const run = index.runs.get(link.ref_id);
      if (!run) continue;
      if (run.status === "running") live = true;
      if (run.status === "gated" || run.status === "paused") needsYou = true;
      if (run.status === "failed" || run.status === "aborted") failed = true;
      if (run.status !== "done") allDone = false;
      else if (run.policy.integrate === "branch") review = true;
    } else if (link.kind === "chain") {
      const chain = index.chains.get(link.ref_id);
      if (!chain) continue;
      if (chain.status === "running" || chain.status === "queued") live = true;
      if (chain.status === "gated" || chain.status === "paused") needsYou = true;
      if (chain.status === "failed" || chain.status === "aborted") failed = true;
      if (chain.status !== "done") allDone = false;
      else review = true;
    } else {
      // A task, or one racer of a race: the link names the task.
      const task = index.tasks.get(link.ref_id);
      if (!task) continue;
      if (task.status === "running" || index.sending.has(task.id)) live = true;
      if (task.status === "error") failed = true;
      if (task.status !== "done") allDone = false;
      if (task.status === "idle") review = true;
    }
  }
  if (live) return "live";
  if (needsYou) return "needs-you";
  if (failed) return "failed";
  if (allDone && !review) return "done";
  return "review";
}

/** The column a card belongs in: the stored one, moved forward when the work has moved further. */
export function deriveStatus(item: BacklogItem, index: WorkIndex): BacklogStatus {
  const state = workState(item, index);
  const fromWork: BacklogStatus | null =
    state === "live" || state === "needs-you" || state === "failed" ? "doing" : state === "review" ? "review" : state === "done" ? "done" : null;
  if (!fromWork) return item.status;
  return ORDER.indexOf(fromWork) > ORDER.indexOf(item.status) ? fromWork : item.status;
}

/** The rank between two neighbours in a column; past the last one, one more than it. */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

/** The goal a card starts its work with: title, body, the acceptance criteria and the ticket. */
export function composeGoal(item: BacklogItem): string {
  const parts = [item.title.trim()];
  if (item.body.trim()) parts.push(item.body.trim());
  if (item.criteria.length) parts.push(["Criterios de aceptación:", ...item.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`)].join("\n"));
  if (item.ticket) parts.push(`Ticket: ${item.ticket.key}${item.ticket.url ? ` (${item.ticket.url})` : ""}`);
  return parts.join("\n\n");
}
