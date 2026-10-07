import { describe, expect, it } from "vitest";
import { columnBars, PLOT_PX, successRate } from "./runPeriods";

describe("the executions chart", () => {
  it("scales each bar to the busiest period", () => {
    expect(columnBars({ success: 1440, error: 0 }, 1440)).toEqual({ ok: PLOT_PX, bad: 0 });
    expect(columnBars({ success: 720, error: 0 }, 1440)).toEqual({ ok: 32, bad: 0 });
    expect(columnBars({ success: 0, error: 0 }, 1440)).toEqual({ ok: 0, bad: 0 });
  });

  it("keeps a single failure visible", () => {
    expect(columnBars({ success: 1180, error: 1 }, 1440)).toEqual({ ok: 52, bad: 2 });
  });

  it("never draws past the plot, gap included", () => {
    const { ok, bad } = columnBars({ success: 1180, error: 24 }, 1204);
    expect(ok + bad + 2).toBe(PLOT_PX);
    expect(bad).toBe(2);
  });

  it("counts the rate on finished runs only", () => {
    expect(successRate({ success: 98, error: 2 })).toBe(98);
    expect(successRate({ success: 0, error: 0 })).toBeNull();
  });

  it("never rounds a failure away", () => {
    expect(successRate({ success: 2959, error: 4 })).toBe(99);
    expect(successRate({ success: 2963, error: 0 })).toBe(100);
    expect(successRate({ success: 1, error: 3000 })).toBe(1);
  });
});
