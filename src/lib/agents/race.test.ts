import { describe, expect, it } from "vitest";
import { groupRaces, raceIdOf, raceRunning, raceStamp, raceStatus, racersOf, tally } from "./race";
import type { AgentTask } from "../../types/domain";

function task(id: string, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    workspace_id: "w1",
    project_id: "p1",
    agent_id: "a1",
    agent_name: "Bot",
    provider: "claude",
    model: "sonnet",
    prompt: "",
    goal: "Arregla el login",
    title: "Arregla el login",
    agent_project_id: "",
    batch_id: "race-1",
    pinned: false,
    conversation_id: `agent-${id}`,
    status: "idle",
    turns: 1,
    last_error: "",
    created_at: "2026-10-19T10:00:00Z",
    updated_at: "2026-10-19T10:00:00Z",
    ...patch,
  } as AgentTask;
}

describe("raceIdOf", () => {
  it("is empty for a task started on its own", () => {
    expect(raceIdOf({ batch_id: "" })).toBe("");
    expect(raceIdOf({})).toBe("");
  });

  it("ignores the whitespace a hand-edited row could carry", () => {
    expect(raceIdOf({ batch_id: "  race-1 " })).toBe("race-1");
  });
});

describe("racersOf", () => {
  it("takes only the tasks of that race", () => {
    const tasks = [task("a"), task("b", { batch_id: "race-2" }), task("c", { batch_id: "" })];
    expect(racersOf(tasks, "race-1").map((entry) => entry.id)).toEqual(["a"]);
  });

  it("draws them in the order they were started", () => {
    const tasks = [
      task("third", { created_at: "2026-10-19T10:00:03Z" }),
      task("first", { created_at: "2026-10-19T10:00:01Z" }),
      task("second", { created_at: "2026-10-19T10:00:02Z" }),
    ];
    expect(racersOf(tasks, "race-1").map((entry) => entry.id)).toEqual(["first", "second", "third"]);
  });

  /** Two creates can land in the same millisecond; the columns must still not swap between renders. */
  it("is stable for tasks created at the same instant", () => {
    const tasks = [task("b"), task("a")];
    expect(racersOf(tasks, "race-1").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(racersOf([...tasks].reverse(), "race-1").map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("is empty for no race at all, rather than grouping every loose task together", () => {
    expect(racersOf([task("a", { batch_id: "" }), task("b", { batch_id: "" })], "")).toEqual([]);
  });
});

describe("tally", () => {
  it("adds up the files and the lines", () => {
    expect(
      tally([
        { added: 12, removed: 3 },
        { added: 1, removed: 0 },
      ]),
    ).toEqual({ files: 2, added: 13, removed: 3 });
  });

  it("is all zeros for a worktree nothing has touched", () => {
    expect(tally([])).toEqual({ files: 0, added: 0, removed: 0 });
  });
});

describe("raceRunning", () => {
  it("is true while any racer is working", () => {
    expect(raceRunning([task("a"), task("b")], new Set(["b"]))).toBe(true);
  });

  /** A row left saying `running` by an app that was killed mid-turn counts too: the panel would
   *  otherwise invite a comparison with a column nobody is sure about. */
  it("counts a row that still says running", () => {
    expect(raceRunning([task("a", { status: "running" })], new Set())).toBe(true);
  });

  it("is false once every racer has stopped", () => {
    expect(raceRunning([task("a"), task("b", { status: "done" })], new Set())).toBe(false);
  });
});

describe("groupRaces", () => {
  it("groups the tasks of each race and says which race each one is in", () => {
    const tasks = [task("a"), task("b"), task("c", { batch_id: "race-2" }), task("d", { batch_id: "race-2" })];
    const { races, memberOf } = groupRaces(tasks);
    expect(races.map((race) => race.batchId).sort()).toEqual(["race-1", "race-2"]);
    expect(memberOf.get("a")).toBe("race-1");
    expect(memberOf.get("d")).toBe("race-2");
  });

  /** A parent row with one child is the same task drawn twice, an indent apart. */
  it("leaves a lone survivor loose instead of giving it a parent row", () => {
    const { races, memberOf } = groupRaces([task("a"), task("b", { batch_id: "race-2" })]);
    expect(races).toEqual([]);
    expect(memberOf.size).toBe(0);
  });

  it("never groups the tasks that were started on their own", () => {
    const { races } = groupRaces([task("a", { batch_id: "" }), task("b", { batch_id: "" })]);
    expect(races).toEqual([]);
  });

  it("leaves out the tasks that already belong to something else", () => {
    const { races, memberOf } = groupRaces([task("a"), task("b"), task("c")], new Set(["b", "c"]));
    expect(races).toEqual([]);
    expect(memberOf.size).toBe(0);
  });

  it("orders each race's tasks as its columns are ordered", () => {
    const tasks = [task("z", { created_at: "2026-10-19T10:00:09Z" }), task("a", { created_at: "2026-10-19T10:00:01Z" })];
    expect(groupRaces(tasks).races[0].tasks.map((entry) => entry.id)).toEqual(["a", "z"]);
  });
});

describe("raceStamp", () => {
  it("is the most recent of its tasks, so the list orders it by its own activity", () => {
    const race = {
      batchId: "race-1",
      tasks: [task("a", { updated_at: "2026-10-19T10:00:00Z" }), task("b", { updated_at: "2026-10-19T12:00:00Z" })],
    };
    expect(raceStamp(race)).toBe("2026-10-19T12:00:00Z");
  });
});

describe("raceStatus", () => {
  it("is running while any racer is working, whatever the others finished as", () => {
    expect(raceStatus([task("a", { status: "done" }), task("b")], new Set(["b"]))).toBe("running");
  });

  it("reports an error over a racer still waiting on its user", () => {
    expect(raceStatus([task("a", { status: "error" }), task("b", { status: "idle" })], new Set())).toBe("error");
  });

  it("waits on the user while any racer does", () => {
    expect(raceStatus([task("a", { status: "done" }), task("b", { status: "idle" })], new Set())).toBe("idle");
  });

  it("is done only once every racer is", () => {
    expect(raceStatus([task("a", { status: "done" }), task("b", { status: "done" })], new Set())).toBe("done");
  });

  it("is cancelled when nothing is left running, failed or waiting", () => {
    expect(raceStatus([task("a", { status: "cancelled" }), task("b", { status: "done" })], new Set())).toBe("cancelled");
  });
});
