import { describe, expect, it } from "vitest";
import { attentionRows } from "./attentionRows";
import type { GatedChain, ParkedChain } from "../types/domain";

const gate = (over: Partial<GatedChain> = {}): GatedChain => ({ chain_id: "g1", workspace_id: "w", project_id: "p", title: "Ship it", goal: "", kind: "chain", step_id: "s1", ...over });
const parked = (over: Partial<ParkedChain> = {}): ParkedChain => ({ chain_id: "k1", workspace_id: "w", project_id: "p", title: "Build", goal: "", reason: "chain.pausedQuota", resume_at: 0, ...over });

describe("attentionRows", () => {
  it("lists gates before parked plans", () => {
    expect(attentionRows([gate()], [parked()]).map((r) => r.key)).toEqual(["gate:g1", "parked:k1"]);
  });

  it("an ordinary plan's gate can be approved from here, naming the step it saw", () => {
    const [row] = attentionRows([gate()], []);
    expect(row.actions).toEqual(["approve", "open"]);
    expect(row.stepId).toBe("s1");
  });

  it("a story's or a hybrid run's gate is a decision answered where it is shown", () => {
    expect(attentionRows([gate({ kind: "story" })], [])[0].actions).toEqual(["open"]);
    expect(attentionRows([gate({ kind: "hybrid" })], [])[0].actions).toEqual(["open"]);
  });

  it("a gate from an older backend with no kind is treated as an ordinary plan's", () => {
    expect(attentionRows([gate({ kind: undefined })], [])[0].actions).toContain("approve");
  });

  it("a reviewer's stop offers the three answers, any other pause only resume", () => {
    const stop = attentionRows([], [parked({ reason: "chain.noProgress" })])[0];
    expect(stop.actions).toEqual(["resume", "extraLap", "open"]);
    expect(stop.reasonKey).toBe("attention.reviewStop");
    const quota = attentionRows([], [parked()])[0];
    expect(quota.actions).toEqual(["resume", "open"]);
    expect(quota.reasonKey).toBe("attention.pausedQuota");
  });

  it("falls back to the goal when a plan has no title", () => {
    expect(attentionRows([gate({ title: "", goal: "the goal" })], [])[0].title).toBe("the goal");
  });

  it("is empty when nothing waits", () => {
    expect(attentionRows([], [])).toEqual([]);
  });
});
