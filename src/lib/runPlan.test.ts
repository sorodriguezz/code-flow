import { describe, expect, it } from "vitest";
import { latestPlan, planFromTodos, planLine, planProgress } from "./runPlan";

const todos = [
  { content: "Read the code", status: "completed", activeForm: "Reading the code" },
  { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
  { content: "Add a test", status: "pending", activeForm: "Adding a test" },
];

describe("runPlan", () => {
  it("reads TodoWrite's list into items with a status each", () => {
    expect(planFromTodos(todos)?.map((i) => i.status)).toEqual(["done", "active", "pending"]);
    expect(planFromTodos(todos)?.[1].text).toBe("Fix the bug");
  });

  it("is null for anything that is not a list worth showing", () => {
    expect(planFromTodos(undefined)).toBeNull();
    expect(planFromTodos([])).toBeNull();
    expect(planFromTodos([{ status: "pending" }, 5, null])).toBeNull();
  });

  it("bounds the list and each line", () => {
    const many = Array.from({ length: 80 }, (_, n) => ({ content: "x".repeat(500) + n, status: "pending" }));
    const plan = planFromTodos(many)!;
    expect(plan).toHaveLength(40);
    expect(plan[0].text.length).toBeLessThanOrEqual(140);
  });

  it("the newest plan in the log wins, whatever came before it", () => {
    const first = planLine(planFromTodos(todos)!);
    const second = planLine(planFromTodos([{ content: "Only one", status: "completed" }])!);
    expect(latestPlan([{ text: first }, { text: "⏵ Read: a.ts" }, { text: second }])).toEqual([{ text: "Only one", status: "done" }]);
  });

  it("a plan line cut mid-write falls back to the one before it", () => {
    const good = planLine(planFromTodos(todos)!);
    expect(latestPlan([{ text: good }, { text: '≡ [{"text":"cut' }])).toHaveLength(3);
    expect(latestPlan([{ text: "nothing here" }])).toBeNull();
    expect(latestPlan(undefined)).toBeNull();
  });

  it("counts what is done", () => {
    expect(planProgress(planFromTodos(todos)!)).toEqual({ done: 1, total: 3 });
  });
});
