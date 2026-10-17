import { describe, expect, it } from "vitest";
import { rebasePlanProblem } from "./rebasePlan";

describe("rebasePlanProblem", () => {
  it("refuses what git would", () => {
    expect(rebasePlanProblem([{ action: "drop", oid: "a" }])).toBe("rebase.problemAllDropped");
    expect(rebasePlanProblem([{ action: "drop", oid: "a" }, { action: "fixup", oid: "b" }])).toBe("rebase.problemSquashFirst");
    expect(rebasePlanProblem([{ action: "reword", oid: "a", message: " " }])).toBe("rebase.problemEmptyMessage");
    expect(rebasePlanProblem([{ action: "pick", oid: "a" }, { action: "squash", oid: "b" }])).toBeNull();
  });
});
