/**
 * What shaped a saved review run beyond its level — the repository calibration it was held to and
 * the deterministic rules that ran — as its meta froze them (`ReviewMeta::calibration` / `rules` in
 * `review_memory.rs`). Read defensively: a run saved before these were kept has neither.
 */

export interface RunCalibration {
  minConfidence: number;
  categories: string[];
  heldBack: number;
}

export type RuleStatus = "facts" | "not_applicable" | "not_evaluated";

export interface RunRule {
  id: string;
  status: RuleStatus;
  reason: string | null;
}

export interface RunShaping {
  calibration: RunCalibration | null;
  rules: RunRule[];
}

const STATUSES: RuleStatus[] = ["facts", "not_applicable", "not_evaluated"];

export function runShaping(meta: Record<string, unknown> | null | undefined): RunShaping {
  const out: RunShaping = { calibration: null, rules: [] };
  const cal = meta?.calibration;
  if (cal && typeof cal === "object") {
    const c = cal as Record<string, unknown>;
    const categories = Array.isArray(c.categories)
      ? c.categories
          .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>).categoria : null))
          .filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (categories.length > 0 && typeof c.minConfidence === "number") {
      out.calibration = { minConfidence: c.minConfidence, categories, heldBack: typeof c.heldBack === "number" ? c.heldBack : 0 };
    }
  }
  if (Array.isArray(meta?.rules)) {
    for (const raw of meta.rules as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== "string" || !STATUSES.includes(r.status as RuleStatus)) continue;
      out.rules.push({ id: r.id, status: r.status as RuleStatus, reason: typeof r.reason === "string" ? r.reason : null });
    }
  }
  return out;
}
