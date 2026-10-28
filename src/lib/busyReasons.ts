/** What keeps the app from restarting right now. */
export type BusyReason = "aiRun" | "chain" | "agentTask";

/**
 * What is in the way of a restart, from counts of what is in flight. Pure, so the rule is testable:
 * a restart to apply an update must never cut an engine off mid-turn or leave a plan's step half-run.
 */
export function busyReasons(counts: { aiRuns: number; chainsMoving: number; agentTasks: number }): BusyReason[] {
  const out: BusyReason[] = [];
  if (counts.aiRuns > 0) out.push("aiRun");
  if (counts.chainsMoving > 0) out.push("chain");
  if (counts.agentTasks > 0) out.push("agentTask");
  return out;
}
