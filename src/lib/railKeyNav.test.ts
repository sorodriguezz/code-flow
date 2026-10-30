import { describe, expect, it } from "vitest";
import { stepRailIndex } from "./railKeyNav";

describe("stepRailIndex", () => {
  it("steps and stops at the ends", () => {
    expect(stepRailIndex(0, 5, "ArrowDown")).toBe(1);
    expect(stepRailIndex(4, 5, "ArrowDown")).toBe(4);
    expect(stepRailIndex(0, 5, "ArrowUp")).toBe(0);
    expect(stepRailIndex(3, 5, "ArrowUp")).toBe(2);
  });
  it("jumps with Home and End", () => {
    expect(stepRailIndex(2, 5, "Home")).toBe(0);
    expect(stepRailIndex(2, 5, "End")).toBe(4);
  });
  it("ignores other keys and an empty list; clamps a stale index", () => {
    expect(stepRailIndex(2, 5, "Tab")).toBeNull();
    expect(stepRailIndex(2, 5, "Enter")).toBeNull();
    expect(stepRailIndex(0, 0, "ArrowDown")).toBeNull();
    expect(stepRailIndex(9, 3, "ArrowUp")).toBe(1);
  });
});
