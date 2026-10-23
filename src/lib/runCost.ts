import { compactTokens, formatCost } from "./usageFormat";
import type { RunCost } from "./parseAnalysis";
import type { Translate } from "../state/languageStore";

/** How long a run took, in the unit that reads naturally: `48 s`, `3 min 10 s`. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/**
 * The one line a review's cost reads as — passes, tokens in and out, the price when an engine said
 * one, and how long it took. Tokens in count the cached ones too: they were read, only cheaper.
 */
export function runCostLine(cost: RunCost, t: Translate): string {
  const parts = [
    t("pr.costPasses", { n: cost.passes }),
    t("pr.costTokens", {
      input: compactTokens(cost.input_tokens + cost.cache_read_tokens + cost.cache_write_tokens),
      output: compactTokens(cost.output_tokens),
    }),
  ];
  if (cost.cost_usd !== null) parts.push(`≈ ${formatCost(cost.cost_usd)}`);
  if (cost.duration_ms > 0) parts.push(duration(cost.duration_ms));
  if (cost.unreported > 0) parts.push(t("pr.costUnreported", { n: cost.unreported }));
  return parts.join(" · ");
}
