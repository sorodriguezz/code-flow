import type { GatedChain, ParkedChain } from "../types/domain";

/** What a person can do about a row, without opening the main window. */
export type AttentionAction = "approve" | "resume" | "extraLap" | "open";

export interface AttentionRow {
  key: string;
  chainId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  /** The reason it waits, as a translation key the window renders. */
  reasonKey: string;
  /** The step an approval names, so it cannot clear a gate that has since moved. */
  stepId: string;
  /** In order of how likely they are what the person wants; `open` is always last. */
  actions: AttentionAction[];
  /** When it resumes by itself (epoch seconds), `0` when it waits for the person. */
  resumeAt: number;
}

/** The reasons a reviewer stops the loop for the person to decide. */
const REVIEW_STOPS = new Set(["chain.lapsExhausted", "chain.noProgress", "chain.stalled"]);

/**
 * The plans waiting on a person, gates first (they block a step the person can open with one click),
 * then the ones parked on something else. Only an **ordinary** plan's gate can be approved from here: a
 * story's is a decision about several repositories and a hybrid run's is its plan, both answered where
 * they are shown, so they only offer `open`.
 */
export function attentionRows(gates: readonly GatedChain[], parked: readonly ParkedChain[]): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const gate of gates) {
    const plain = (gate.kind ?? "chain") === "chain";
    rows.push({
      key: `gate:${gate.chain_id}`,
      chainId: gate.chain_id,
      workspaceId: gate.workspace_id,
      projectId: gate.project_id,
      title: gate.title || gate.goal,
      reasonKey: "attention.gate",
      stepId: gate.step_id ?? "",
      actions: plain ? ["approve", "open"] : ["open"],
      resumeAt: 0,
    });
  }
  for (const chain of parked) {
    const stop = REVIEW_STOPS.has(chain.reason);
    rows.push({
      key: `parked:${chain.chain_id}`,
      chainId: chain.chain_id,
      workspaceId: chain.workspace_id,
      projectId: chain.project_id,
      title: chain.title || chain.goal,
      reasonKey: stop ? "attention.reviewStop" : `attention.${chain.reason.replace("chain.", "")}`,
      stepId: "",
      // A reviewer's stop has the person's three answers; the others need something fixed first, and
      // then "resume".
      actions: stop ? ["resume", "extraLap", "open"] : ["resume", "open"],
      resumeAt: chain.resume_at,
    });
  }
  return rows;
}
