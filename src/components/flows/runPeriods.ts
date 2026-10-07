import type { FlowRunPeriod } from "../../lib/tauri/flowsCommands";

/** The executions chart's plot height, in pixels. */
export const PLOT_PX = 64;

/** The surface gap between a bar's two segments, and the least either shows when it has runs. */
const GAP_PX = 2;
const MIN_PX = 2;

/**
 * A period's bar, in pixels: success at the bottom, errors on top, scaled to `tallest` (the busiest
 * period's success + error). Errors never vanish under rounding — one failed run in a thousand still
 * shows — and the bar never grows past the plot: what the minimum and the gap add comes off the
 * larger segment.
 */
export function columnBars(period: Pick<FlowRunPeriod, "success" | "error">, tallest: number, plot = PLOT_PX): { ok: number; bad: number } {
  if (tallest <= 0 || period.success + period.error === 0) return { ok: 0, bad: 0 };
  const scale = (count: number) => (count ? Math.max(MIN_PX, Math.round((plot * count) / tallest)) : 0);
  let ok = scale(period.success);
  let bad = scale(period.error);
  const over = ok + bad + (ok && bad ? GAP_PX : 0) - plot;
  if (over > 0) {
    if (ok >= bad) ok -= over;
    else bad -= over;
  }
  return { ok, bad };
}

/**
 * "Without error" as the per-flow metrics count it: successes out of successes and errors. Rounding
 * never hides the difference — four failures in three thousand runs are not 100 %, nor one success
 * in three thousand 0 %.
 */
export function successRate(period: Pick<FlowRunPeriod, "success" | "error">): number | null {
  const done = period.success + period.error;
  if (!done) return null;
  const rate = Math.round((period.success / done) * 100);
  if (period.error > 0 && rate === 100) return 99;
  if (period.success > 0 && rate === 0) return 1;
  return rate;
}

export const periodRuns = (period: Pick<FlowRunPeriod, "success" | "error" | "canceled">) => period.success + period.error + period.canceled;
