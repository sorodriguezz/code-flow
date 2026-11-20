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

/** The Y "column" that counts rows instead of summing a column — the useful default when the
 * numbers a result has are ids. */
export const COUNT_ROWS = -1;

/** Names that hold ids rather than quantities: summing them draws a number that means nothing
 * (`RES_RowId` summed to 163 573 — user report, 2026-11-19). */
export function isIdLike(name: string): boolean {
  return /(^|_)(row)?id$|_dr$|^id_|rowid/i.test(name);
}

/**
 * The natural X: a text column that actually groups — at least one value, more than one distinct
 * value, and few enough to draw. A column of only NULLs used to win here because it is "not numeric"
 * (no number in it at all), and the chart came out as one bar labelled NULL. Falls back to any text
 * column with a value, then to the first column.
 */
export function defaultCategoryColumn(columns: DbColumn[], rows: (string | null)[][]): number {
  const numeric = new Set(numericColumns(columns, rows));
  let anyText = -1;
  let best = -1;
  let bestDistinct = Infinity;
  columns.forEach((_, index) => {
    if (numeric.has(index)) return;
    const distinct = new Set<string>();
    for (const row of rows) {
      const value = row[index];
      if (value !== null && value !== undefined && value !== "") distinct.add(value);
      if (distinct.size > MAX_CATEGORIES) break;
    }
    if (distinct.size === 0) return;
    if (anyText < 0) anyText = index;
    // Fewer groups read better, but a column where every row differs is a label, not a group.
    const groups = distinct.size > 1 && (distinct.size < rows.length || rows.length <= 12) && distinct.size <= MAX_CATEGORIES;
    if (groups && distinct.size < bestDistinct) {
      best = index;
      bestDistinct = distinct.size;
    }
  });
  if (best >= 0) return best;
  if (anyText >= 0) return anyText;
  return 0;
}

/** The default Y: the first numeric column that is a quantity rather than an id, else a row count. */
export function defaultValueColumns(columns: DbColumn[], rows: (string | null)[][], x: number): number[] {
  const quantity = numericColumns(columns, rows).find((index) => index !== x && !isIdLike(columns[index].name));
  return [quantity ?? COUNT_ROWS];
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
      if (column === COUNT_ROWS) {
        bucket![at] += 1;
        return;
      }
      const value = Number(row[column]);
      if (row[column] !== null && Number.isFinite(value)) bucket![at] += value;
    });
  }
  const categories = order.slice(0, MAX_CATEGORIES);
  return {
    categories,
    series: ys.map((column, at) => ({
      name: column === COUNT_ROWS ? "count" : (columns[column]?.name ?? ""),
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
