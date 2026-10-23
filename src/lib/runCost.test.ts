import { describe, expect, it } from "vitest";
import { runCostLine } from "./runCost";
import { summaryMemoryOf } from "./parseAnalysis";

const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;

describe("a review's cost", () => {
  it("reads as passes, tokens, the price when there is one, and the time", () => {
    const line = runCostLine(
      { passes: 4, input_tokens: 40_000, output_tokens: 2_500, cache_read_tokens: 12_000, cache_write_tokens: 0, cost_usd: 0.061, unreported: 1, duration_ms: 190_000 },
      t as never,
    );
    expect(line).toBe('pr.costPasses{"n":4} · pr.costTokens{"input":"52k","output":"2.5k"} · ≈ $0.061 · 3 min 10 s · pr.costUnreported{"n":1}');
  });

  it("never prints a price nobody reported", () => {
    const line = runCostLine({ passes: 1, input_tokens: 900, output_tokens: 80, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, unreported: 0, duration_ms: 0 }, t as never);
    expect(line).not.toContain("$");
  });

  it("is read from a saved run, and absent from one that predates it", () => {
    const run = (meta: object) => ({ findings: "[]", meta: JSON.stringify(meta), iter: 1, level: "completo" });
    expect(summaryMemoryOf(run({ cost: { passes: 3, input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, unreported: 0, duration_ms: 5 } })).cost?.passes).toBe(3);
    expect(summaryMemoryOf(run({})).cost).toBeUndefined();
    expect(summaryMemoryOf(run({ cost: "nonsense" })).cost).toBeUndefined();
  });
});
