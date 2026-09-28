import type { PipelineGate, PipelineJob } from "../../types/domain";

/**
 * Which cards on the drawing a run's gates are holding.
 *
 * Two sets because the hosts point at two different things: GitHub and GitLab name the **jobs**
 * that wait, Azure names the **stage** — an approval is evaluated before a stage expands its jobs,
 * so there is often no job to point at yet, only the placeholder the backend draws for the stage.
 */
export interface GateHolds {
  jobs: ReadonlySet<string>;
  stages: ReadonlySet<string>;
}

const NOTHING: GateHolds = { jobs: new Set(), stages: new Set() };

export function gateHolds(gates: PipelineGate[] | undefined): GateHolds {
  if (!gates || gates.length === 0) return NOTHING;
  const jobs = new Set<string>();
  const stages = new Set<string>();
  for (const gate of gates) {
    for (const id of gate.job_ids) jobs.add(id);
    if (gate.stage_id) stages.add(gate.stage_id);
  }
  return { jobs, stages };
}

/**
 * Whether a job card is held at a gate.
 *
 * A job named by a gate, or the stand-in for a held stage — an Azure stage with no jobs yet is drawn
 * as a placeholder "job" that shares the stage's id. The real jobs *inside* a held stage are not
 * marked one by one: the stage card carries the mark, and a row of amber jobs would read as each of
 * them waiting on something of its own.
 */
export function isHeld(job: Pick<PipelineJob, "id">, holds: GateHolds): boolean {
  return holds.jobs.has(job.id) || holds.stages.has(job.id);
}

/** The gates a person can answer from here, first — then the ones that only say why a run waits. */
export function orderGates(gates: PipelineGate[]): PipelineGate[] {
  const rank = (gate: PipelineGate) => (gate.kind === "approval" ? 0 : gate.kind === "manual" ? 1 : 2);
  return [...gates].sort((a, b) => rank(a) - rank(b));
}
