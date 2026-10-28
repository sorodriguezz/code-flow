import { describe, expect, it } from "vitest";
import { busyReasons } from "./busyReasons";

describe("busyReasons", () => {
  it("is empty when nothing is in flight", () => {
    expect(busyReasons({ aiRuns: 0, chainsMoving: 0, agentTasks: 0 })).toEqual([]);
  });

  it("names every kind of work that is in the way", () => {
    expect(busyReasons({ aiRuns: 2, chainsMoving: 1, agentTasks: 3 })).toEqual(["aiRun", "chain", "agentTask"]);
    expect(busyReasons({ aiRuns: 0, chainsMoving: 1, agentTasks: 0 })).toEqual(["chain"]);
  });
});
