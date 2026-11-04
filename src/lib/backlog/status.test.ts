import { describe, expect, it } from "vitest";
import { composeGoal, deriveStatus, rankBetween, workState, type WorkIndex } from "./status";
import { emptyBacklogItem, type BacklogItem } from "../../types/crew";
import type { AgentTask } from "../../types/domain";
import type { TeamRun } from "../../types/team";

const index = (over: Partial<WorkIndex> = {}): WorkIndex => ({ tasks: new Map(), chains: new Map(), runs: new Map(), sending: new Set(), ...over });

function card(over: Partial<BacklogItem> = {}): BacklogItem {
  return { ...emptyBacklogItem("ws"), id: "c1", title: "Login OTP", ...over };
}

const link = (kind: "task" | "team_run", ref_id: string) => ({ id: ref_id, item_id: "c1", kind, ref_id, created_at: "" });

describe("backlog status", () => {
  it("stays where the user put it while nothing was started", () => {
    expect(workState(card(), index())).toBe("none");
    expect(deriveStatus(card({ status: "ready" }), index())).toBe("ready");
  });

  it("moves to doing while a linked task sends, and to review when it waits on you", () => {
    const task = { id: "t1", status: "running" } as AgentTask;
    const c = card({ status: "ready", links: [link("task", "t1")] });
    expect(deriveStatus(c, index({ tasks: new Map([["t1", task]]) }))).toBe("doing");
    const idle = { ...task, status: "idle" } as AgentTask;
    expect(deriveStatus(c, index({ tasks: new Map([["t1", idle]]) }))).toBe("review");
  });

  it("only moves forward: a card dragged to done stays done", () => {
    const task = { id: "t1", status: "running" } as AgentTask;
    const c = card({ status: "done", links: [link("task", "t1")] });
    expect(deriveStatus(c, index({ tasks: new Map([["t1", task]]) }))).toBe("done");
  });

  it("a gated team run needs you and a landed one is done", () => {
    const run = { id: "r1", status: "gated", policy: { integrate: "merge" } } as TeamRun;
    const c = card({ status: "ready", links: [link("team_run", "r1")] });
    expect(workState(c, index({ runs: new Map([["r1", run]]) }))).toBe("needs-you");
    const landed = { ...run, status: "done" } as TeamRun;
    expect(deriveStatus(c, index({ runs: new Map([["r1", landed]]) }))).toBe("done");
    const branch = { ...landed, policy: { integrate: "branch" } } as TeamRun;
    expect(deriveStatus(c, index({ runs: new Map([["r1", branch]]) }))).toBe("review");
  });

  it("ranks between neighbours", () => {
    expect(rankBetween(null, null)).toBe(1);
    expect(rankBetween(2, null)).toBe(3);
    expect(rankBetween(null, 2)).toBe(1);
    expect(rankBetween(1, 2)).toBe(1.5);
  });

  it("composes the goal from the card", () => {
    const goal = composeGoal(card({ body: "Con SMS", criteria: [{ id: "a", text: "Expira en 5 min", done: true }], ticket: { provider: "azure", uid: "u", key: "AB#1", url: "", title: "" } }));
    expect(goal).toContain("Login OTP");
    expect(goal).toContain("- [x] Expira en 5 min");
    expect(goal).toContain("Ticket: AB#1");
  });
});
