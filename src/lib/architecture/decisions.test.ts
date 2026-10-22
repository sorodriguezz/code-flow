import { describe, expect, it } from "vitest";
import { chosenOption, nextId, weightedTotal } from "./decisions";
import type { Decision } from "./types";

const decision = (recommended?: number): Decision => ({
  id: "ADR-001",
  title: "Queue",
  criteria: [{ id: "c1", name: "Cost", weight: 3 }, { id: "c2", name: "Speed", weight: 1 }],
  options: [
    { name: "A", scores: { c1: 5, c2: 1 }, ...(recommended === 0 ? { recommended: true } : {}) },
    { name: "B", scores: { c1: 2, c2: 5 }, ...(recommended === 1 ? { recommended: true } : {}) },
  ],
});

describe("decisions", () => {
  it("weighs every score by its criterion", () => {
    const d = decision();
    expect(weightedTotal(d, d.options![0])).toBeCloseTo(16 / 20);
    expect(weightedTotal(d, d.options![1])).toBeCloseTo(11 / 20);
  });

  it("lands on the best total unless one was chosen by hand", () => {
    expect(chosenOption(decision())).toMatchObject({ index: 0, byHand: false });
    expect(chosenOption(decision(1))).toMatchObject({ index: 1, byHand: true });
    expect(chosenOption({ id: "x", title: "x" })).toBeNull();
  });

  it("numbers past the highest id, never one in use", () => {
    expect(nextId("ADR-", [], 3)).toBe("ADR-001");
    expect(nextId("ADR-", ["ADR-001", "ADR-007"], 3)).toBe("ADR-008");
    expect(nextId("R", ["R1", "R3", "other"])).toBe("R4");
  });
});
