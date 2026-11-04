import { describe, expect, it } from "vitest";
import { layoutRun, parallelism } from "./runGraph";
import type { TeamItem } from "../../types/team";

let clock = 0;
function item(id: string, kind: TeamItem["kind"], extra: Partial<TeamItem> = {}): TeamItem {
  clock++;
  return {
    id,
    run_id: "r",
    key: id,
    member_id: "m",
    member_name: extra.member_name ?? "Dev",
    project_id: "",
    kind,
    title: id,
    instruction: "",
    depends_on: [],
    status: "pending",
    approved: false,
    task_id: "",
    worktree_path: "",
    branch: "",
    commit_sha: "",
    merged: false,
    output_text: "",
    attempts: 0,
    last_error: "",
    feedback: "",
    round: 0,
    lap: 0,
    ref_item: "",
    run_in: "headless",
    terminal_session: "",
    created_at: `2026-01-01T00:00:${String(clock).padStart(2, "0")}`,
    updated_at: "",
    started_at: "",
    finished_at: "",
    parent: "",
    model: "",
    ...extra,
  };
}

describe("run graph", () => {
  it("puts work after the plan, dependents after what they wait on, and the final round last", () => {
    const plan = item("plan", "plan");
    const a = item("a", "work", { member_name: "Back" });
    const b = item("b", "work", { member_name: "Front" });
    const c = item("c", "work", { depends_on: ["a", "b"] });
    const review = item("rev", "review", { ref_item: "c" });
    const final = item("final", "final", { round: 1 });
    const g = layoutRun([plan, a, b, c, review, final]);
    const col = (id: string) => g.pos.get(id)!.col;
    expect(col("plan")).toBe(0);
    expect(col("a")).toBe(1);
    expect(col("b")).toBe(1);
    expect(col("c")).toBe(2);
    expect(col("rev")).toBe(3);
    expect(col("final")).toBe(4);
    expect(g.edges).toContainEqual({ from: "plan", to: "a", kind: "plan" });
    expect(g.edges).toContainEqual({ from: "c", to: "rev", kind: "ref" });
    // The final reads the work nobody else waited on — the review — not every item.
    expect(g.edges.filter((e) => e.to === "final").map((e) => e.from)).toEqual(["rev"]);
    expect(g.pos.get("a")!.row).not.toBe(g.pos.get("b")!.row);
    expect(g.cols).toBe(5);
  });

  it("hangs a sub-lead's items off its delegate", () => {
    const plan = item("plan", "plan");
    const del = item("del", "delegate", { status: "delegated" });
    const sub = item("sub", "work", { parent: "del", round: 0 });
    const g = layoutRun([plan, del, sub]);
    expect(g.edges).toContainEqual({ from: "del", to: "sub", kind: "delegate" });
    expect(g.pos.get("sub")!.col).toBe(2);
  });

  it("draws the advice the first plan waits for before that plan", () => {
    const advise = item("adv", "advise", { status: "done" });
    const plan = item("plan2", "plan");
    const work = item("w", "work");
    const g = layoutRun([advise, plan, work]);
    expect(g.pos.get("adv")!.col).toBe(0);
    expect(g.pos.get("plan2")!.col).toBe(1);
    expect(g.pos.get("w")!.col).toBe(2);
    expect(g.edges).toContainEqual({ from: "adv", to: "plan2", kind: "plan" });
    expect(g.edges.some((e) => e.from === "plan2" && e.to === "adv")).toBe(false);
  });

  it("counts what runs at once now and at the peak", () => {
    const items = [
      item("a", "work", { status: "done", started_at: "1", finished_at: "5" }),
      item("b", "work", { status: "done", started_at: "2", finished_at: "6" }),
      item("c", "work", { status: "running", started_at: "3" }),
      item("p", "plan", { status: "running", started_at: "0" }),
    ];
    expect(parallelism(items)).toEqual({ now: 1, peak: 3 });
  });
});
