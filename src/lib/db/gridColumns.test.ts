import { describe, expect, it } from "vitest";
import { arrangeColumns, EMPTY_LAYOUT, findCells, moveColumn, summarize, toggleHidden, togglePinned } from "./gridColumns";

const names = ["id", "name", "email", "age"];

describe("arrangeColumns", () => {
  it("puts pinned first, honours the order, drops hidden ones", () => {
    const layout = { hidden: ["email"], pinned: ["name"], order: ["age", "id"] };
    expect(arrangeColumns(names, layout)).toEqual({ pinned: [1], rest: [3, 0] });
  });

  it("ignores names the result does not have", () => {
    expect(arrangeColumns(names, { hidden: ["x"], pinned: ["y"], order: ["z"] })).toEqual({ pinned: [], rest: [0, 1, 2, 3] });
  });

  it("moves a column among the visible ones", () => {
    const moved = moveColumn(names, EMPTY_LAYOUT, "email", -1);
    expect(arrangeColumns(names, moved).rest).toEqual([0, 2, 1, 3]);
    expect(moveColumn(names, EMPTY_LAYOUT, "id", -1)).toBe(EMPTY_LAYOUT);
  });

  it("unpins a column that is hidden", () => {
    const pinned = togglePinned(EMPTY_LAYOUT, "id");
    expect(toggleHidden(pinned, "id")).toEqual({ hidden: ["id"], pinned: [], order: [] });
  });
});

describe("summarize", () => {
  it("adds up numbers and counts NULLs apart", () => {
    expect(summarize(["1", "2.5", null, "0.1", "0.2"])).toEqual({
      count: 5,
      nulls: 1,
      distinct: 4,
      sum: 3.8,
      avg: 0.95,
      min: "0.1",
      max: "2.5",
    });
  });

  it("gives text the alphabetical extremes and no sum", () => {
    expect(summarize(["b", "a", "10"])).toMatchObject({ sum: null, avg: null, min: "10", max: "b" });
  });
});

describe("findCells", () => {
  it("finds case-insensitively in reading order, NULL included", () => {
    const rows = [
      ["Ana", null],
      ["juan", "ANA"],
    ];
    expect(findCells(2, [0, 1], (r, c) => rows[r][c], "an")).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
    ]);
    expect(findCells(2, [0, 1], (r, c) => rows[r][c], "null")).toEqual([{ row: 0, column: 1 }]);
  });
});
