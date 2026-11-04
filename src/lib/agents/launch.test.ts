import { describe, expect, it } from "vitest";
import { LaunchError, launch, planLaunch, type LaunchDeps, type LaunchInput } from "./launch";
import type { WorkspaceAgent } from "../../types/domain";
import { emptyTeam } from "../../types/team";

const base: LaunchInput = { goal: "Login OTP", mode: "solo", assignee: { kind: "agent", id: "a1" }, repos: ["p1", "p2"] };
const batch = () => "B";

describe("planLaunch", () => {
  it("solo makes one task per repository", () => {
    const plan = planLaunch(base, null, batch);
    expect(plan).toEqual([
      { kind: "task", projectId: "p1", agentId: "a1", worktree: true },
      { kind: "task", projectId: "p2", agentId: "a1", worktree: true },
    ]);
  });

  it("a race puts every racer in a worktree of the first repository, under one batch", () => {
    const plan = planLaunch({ ...base, mode: "race", racers: ["a2", "a1"] }, null, batch);
    expect(plan).toHaveLength(2);
    expect(plan.every((s) => s.kind === "task" && s.projectId === "p1" && s.worktree && s.batch === "B")).toBe(true);
  });

  it("refuses a race of one and a team mode for an agent", () => {
    expect(() => planLaunch({ ...base, mode: "race" }, null, batch)).toThrow(LaunchError);
    expect(() => planLaunch({ ...base, mode: "team" }, null, batch)).toThrow(LaunchError);
  });

  it("a team run takes every repository with the target branch", () => {
    const plan = planLaunch({ ...base, mode: "team", assignee: { kind: "team", id: "t1" }, branch: "main", preset: "autonomous" }, null, batch);
    expect(plan).toEqual([{ kind: "team", teamId: "t1", repos: [{ projectId: "p1", targetBranch: "main" }, { projectId: "p2", targetBranch: "main" }], preset: "autonomous" }]);
  });

  it("falls back to the first repository and needs a goal", () => {
    expect(planLaunch({ ...base, repos: [] }, "p9", batch)).toEqual([{ kind: "task", projectId: "p9", agentId: "a1", worktree: true }]);
    expect(() => planLaunch({ ...base, goal: " " }, "p9", batch)).toThrow("crew.launch.needGoal");
    expect(() => planLaunch({ ...base, repos: [] }, null, batch)).toThrow("crew.launch.needRepo");
  });

  it("a flow is one chain with the steps in order", () => {
    const plan = planLaunch({ ...base, mode: "flow", flowSteps: [{ agentId: "a2", instruction: "analiza" }, { agentId: "a1", instruction: "implementa", gate: true }] }, null, batch);
    expect(plan).toHaveLength(1);
    const chain = plan[0];
    expect(chain.kind).toBe("chain");
    if (chain.kind === "chain") expect(chain.steps.map((s) => [s.agent_id, s.gate])).toEqual([["a2", false], ["a1", true]]);
  });
});

describe("launch", () => {
  it("creates every task before sending any, and links them", async () => {
    const order: string[] = [];
    const deps: LaunchDeps = {
      workspaceId: "ws",
      roster: [{ id: "a1" } as WorkspaceAgent],
      teams: [emptyTeam("ws")],
      createTask: async ({ projectId }) => {
        order.push(`create:${projectId}`);
        return { id: `t-${projectId}` };
      },
      sendTask: (id) => {
        order.push(`send:${id}`);
        return true;
      },
      createChain: async () => ({ chain: { id: "c" } }),
      createHybrid: async () => ({ chain: { id: "h" } }),
      startTeam: async () => "r",
    };
    const result = await launch(base, planLaunch(base, null, batch), deps);
    expect(order).toEqual(["create:p1", "create:p2", "send:t-p1", "send:t-p2"]);
    expect(result.links).toEqual([{ kind: "task", refId: "t-p1" }, { kind: "task", refId: "t-p2" }]);
    expect(result.open).toEqual({ kind: "task", id: "t-p1" });
  });
});
