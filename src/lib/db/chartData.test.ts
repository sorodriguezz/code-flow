import { describe, expect, it } from "vitest";
import { buildChart, defaultCategoryColumn, niceTicks, numericColumns } from "./chartData";

const columns = [
  { name: "city", type_name: "text" },
  { name: "sales", type_name: "text" },
  { name: "units", type_name: "int4" },
];
const rows = [
  ["Lima", "10.5", "1"],
  ["Quito", "4", null],
  ["Lima", "2", "3"],
];

describe("chartData", () => {
  it("finds numeric columns by their values", () => {
    expect(numericColumns(columns, rows)).toEqual([1, 2]);
    expect(defaultCategoryColumn(columns, rows)).toBe(0);
  });

  it("sums rows that share a category, in first-seen order", () => {
    expect(buildChart(rows, 0, [1, 2], columns)).toEqual({
      categories: ["Lima", "Quito"],
      series: [
        { name: "sales", values: [12.5, 4] },
        { name: "units", values: [4, 0] },
      ],
      clipped: false,
    });
  });

  it("picks round ticks", () => {
    expect(niceTicks(0, 93)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-5, 5)[0]).toBeLessThanOrEqual(-5);
  });
});
