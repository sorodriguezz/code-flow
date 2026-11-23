import { describe, expect, it } from "vitest";
import { compactTokens, fillMonths, percent, usd } from "./reviewMetrics";

const month = (key: string, runs: number) => ({
  month: key,
  runs,
  gate_passed: runs,
  gate_failed: 0,
  new_findings: { Blocker: 0, Crítico: 0, Mayor: 0, Menor: 0, Info: 0 },
});

describe("fillMonths", () => {
  it("is empty with no runs", () => {
    expect(fillMonths([])).toEqual([]);
  });

  it("fills the quiet months between, across a year boundary", () => {
    const out = fillMonths([month("2026-11", 2), month("2027-02", 1)]);
    expect(out.map((m) => m.month)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(out[1].runs).toBe(0);
    expect(out[3].runs).toBe(1);
  });
});

describe("formatting", () => {
  it("says nothing it cannot divide", () => {
    expect(percent(1, 4)).toBe("25%");
    expect(percent(0, 0)).toBe("—");
  });

  it("prices and tokens", () => {
    expect(usd(null)).toBeNull();
    expect(usd(1.234)).toBe("US$1.23");
    expect(usd(0.004)).toBe("US$0.004");
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(12_345)).toBe("12k");
    expect(compactTokens(4_100_000)).toBe("4.1M");
  });
});
