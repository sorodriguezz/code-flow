import type { ReviewMetrics } from "./tauri/commands";

type Month = ReviewMetrics["months"][number];

/** The severities in the order every chart lists them (mirrors `review_metrics::SEVERITIES`). */
export const METRIC_SEVERITIES = ["Blocker", "Crítico", "Mayor", "Menor", "Info"] as const;

/**
 * The months between the first and the last with runs, the empty ones included.
 *
 * The backend only reports months that had runs; a chart drawn from that alone would put March
 * right beside June and make a quiet quarter invisible — which is itself one of the things the
 * chart is for.
 */
export function fillMonths(months: Month[]): Month[] {
  if (months.length === 0) return [];
  const byKey = new Map(months.map((m) => [m.month, m]));
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const [startYear, startMonth] = sorted[0].month.split("-").map(Number);
  const [endYear, endMonth] = sorted[sorted.length - 1].month.split("-").map(Number);
  if (![startYear, startMonth, endYear, endMonth].every(Number.isFinite)) return sorted;
  const out: Month[] = [];
  let year = startYear;
  let month = startMonth;
  // Bounded, so a malformed key can never spin this forever.
  for (let guard = 0; guard < 600 && (year < endYear || (year === endYear && month <= endMonth)); guard++) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    out.push(
      byKey.get(key) ?? {
        month: key,
        runs: 0,
        gate_passed: 0,
        gate_failed: 0,
        new_findings: Object.fromEntries(METRIC_SEVERITIES.map((s) => [s, 0])),
      },
    );
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/** A share as a whole percentage, or "—" when there is nothing to divide. */
export function percent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Dollars at the precision a review's price deserves: cents, or a tenth of a cent below one. */
export function usd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value > 0 && value < 0.01 ? `US$${value.toFixed(3)}` : `US$${value.toFixed(2)}`;
}

/** Tokens as people read them: 12.3k, 4.1M. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
