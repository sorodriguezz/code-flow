import { describe, expect, it } from "vitest";
import { gridToCsv, gridToMarkdown, tableGrid } from "./tableCopy";

describe("tableCopy", () => {
  const grid = [
    ["name", "note"],
    ["a|b", "has, comma"],
  ];

  it("writes a Markdown table with the pipe escaped", () => {
    expect(gridToMarkdown(grid)).toBe("| name | note |\n| --- | --- |\n| a\\|b | has, comma |");
  });

  it("quotes what CSV needs quoted", () => {
    expect(gridToCsv(grid)).toContain('"has, comma"');
  });

  it("reads a rendered table", () => {
    const cell = (textContent: string) => ({ textContent });
    const table = { rows: [{ cells: [cell("x"), cell("y")] }, { cells: [cell(" 1 "), cell("2")] }] };
    expect(tableGrid(table)).toEqual([["x", "y"], ["1", "2"]]);
  });

  it("is empty for an empty table", () => {
    expect(gridToMarkdown([])).toBe("");
    expect(gridToCsv([])).toBe("");
  });
});
