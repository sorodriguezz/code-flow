import type { DbColumn } from "../../types/database";

/**
 * A result turned into what a chart draws: categories along X, one series per numeric column.
 *
 * Every value arrives as text, so "numeric" is decided from the values rather than the type name —
 * a `SELECT count(*)` on some engines comes back typed as text, and a `numeric` column of NULLs
 * draws nothing anyway. Rows that share an X value are summed, which is what a chart of an
 * ungrouped result almost always means (and a grouped one has nothing to sum).
 */
export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  categories: string[];
  series: ChartSeries[];
  /** More categories than `MAX_CATEGORIES`; the rest were left off. */
  clipped: boolean;
}

export const MAX_CATEGORIES = 200;

/** Columns whose non-NULL values all read as numbers (and there is at least one). */
export function numericColumns(columns: DbColumn[], rows: (string | null)[][]): number[] {
  return columns
    .map((_, index) => index)
    .filter((index) => {
      let seen = 0;
      for (const row of rows) {
        const value = row[index];
        if (value === null || value === undefined || value === "") continue;
        if (!Number.isFinite(Number(value))) return false;
        seen += 1;
      }
      return seen > 0;
    });
}

/** The first column that is not numeric — the natural X — or the first column. */
export function defaultCategoryColumn(columns: DbColumn[], rows: (string | null)[][]): number {
  const numeric = new Set(numericColumns(columns, rows));
  const text = columns.findIndex((_, index) => !numeric.has(index));
  return text >= 0 ? text : 0;
}

export function buildChart(rows: (string | null)[][], x: number, ys: number[], columns: DbColumn[]): ChartData {
  const order: string[] = [];
  const sums = new Map<string, number[]>();
  for (const row of rows) {
    const key = row[x] ?? "NULL";
    let bucket = sums.get(key);
    if (!bucket) {
      bucket = ys.map(() => 0);
      sums.set(key, bucket);
      order.push(key);
    }
    ys.forEach((column, at) => {
      const value = Number(row[column]);
      if (row[column] !== null && Number.isFinite(value)) bucket![at] += value;
    });
  }
  const categories = order.slice(0, MAX_CATEGORIES);
  return {
    categories,
    series: ys.map((column, at) => ({
      name: columns[column]?.name ?? "",
      values: categories.map((key) => sums.get(key)![at]),
    })),
    clipped: order.length > MAX_CATEGORIES,
  };
}

/** Round numbers for an axis from 0 (or the minimum, when negative) to the maximum. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const low = Math.min(0, min);
  const high = max <= low ? low + 1 : max;
  const raw = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => m >= raw) ?? raw;
  const start = Math.floor(low / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= high + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}
