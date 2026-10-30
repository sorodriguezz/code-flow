import { compactTokens, formatCost } from "./usageFormat";
import type { TurnUsage } from "../types/domain";

import type { Translate } from "../state/languageStore";

/** Last path segment, either separator. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).pop() || trimmed;
}

/**
 * The quiet usage line: tokens in (cache included, as the review cost line counts them), tokens out,
 * and the price only when the CLI said one. `null`/absent usage is «not reported», never zero.
 */
export function usageLine(usage: TurnUsage | null | undefined, t: Translate): string | null {
  if (!usage) return null;
  const parts = [
    t("pr.costTokens", {
      input: compactTokens(usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens),
      output: compactTokens(usage.output_tokens),
    }),
  ];
  if (usage.cost_usd !== null) parts.push(`≈ ${formatCost(usage.cost_usd)}`);
  return parts.join(" · ");
}

/** What to say under an answer: its usage line and the unprotected-folders warning. */
export function turnNotes(
  message: { usage?: TurnUsage | null; unprotectedDirs?: string[] },
  t: Translate,
): { usage: string | null; unprotected: string | null } {
  const dirs = [...new Set((message.unprotectedDirs ?? []).map(folderName))];
  return {
    usage: usageLine(message.usage, t),
    unprotected: dirs.length > 0 ? t("assistant.wsChatUnprotected", { folders: dirs.join(", ") }) : null,
  };
}

/** A stored `TurnUsage` JSON string, or `undefined` for absent, malformed or wrongly-shaped data. */
export function parseTurnUsage(raw: string | null | undefined): TurnUsage | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return undefined;
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) {
      if (typeof v[key] !== "number") return undefined;
    }
    if (v.cost_usd !== null && typeof v.cost_usd !== "number") return undefined;
    return v as unknown as TurnUsage;
  } catch {
    return undefined;
  }
}
