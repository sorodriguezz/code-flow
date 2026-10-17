/**
 * How a result grid arranges its columns beyond their widths: which are hidden, which are pinned
 * to the left, and the order the user moved them into. By column *name*, so a layout survives a
 * re-run that returns the same columns — and a name the next result lacks is simply ignored.
 */
export interface ColumnLayout {
  hidden: string[];
  pinned: string[];
  /** Names in the order the user put them; columns not listed keep their natural place after. */
  order: string[];
}

export const EMPTY_LAYOUT: ColumnLayout = { hidden: [], pinned: [], order: [] };

/**
 * The columns to draw, as indexes into the result's own columns: pinned first (in pinning order),
 * then the rest in the user's order, hidden ones left out. The cell values stay where they are —
 * this only says which index goes where.
 */
export function arrangeColumns(names: string[], layout: ColumnLayout): { pinned: number[]; rest: number[] } {
  const indexOf = new Map<string, number>();
  names.forEach((name, index) => {
    if (!indexOf.has(name)) indexOf.set(name, index);
  });
  const hidden = new Set(layout.hidden);
  const ordered: number[] = [];
  const placed = new Set<number>();
  for (const name of layout.order) {
    const index = indexOf.get(name);
    if (index !== undefined && !placed.has(index)) {
      ordered.push(index);
      placed.add(index);
    }
  }
  names.forEach((_, index) => {
    if (!placed.has(index)) ordered.push(index);
  });
  const visible = ordered.filter((index) => !hidden.has(names[index]));
  const pinnedSet = new Set(layout.pinned);
  const pinned = layout.pinned
    .map((name) => indexOf.get(name))
    .filter((index): index is number => index !== undefined && !hidden.has(names[index]));
  return { pinned, rest: visible.filter((index) => !pinnedSet.has(names[index])) };
}

/** `name` moved one place left (`-1`) or right (`1`) among the visible, unpinned columns. */
export function moveColumn(names: string[], layout: ColumnLayout, name: string, direction: -1 | 1): ColumnLayout {
  const { rest } = arrangeColumns(names, layout);
  const order = rest.map((index) => names[index]);
  const at = order.indexOf(name);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= order.length) return layout;
  [order[at], order[to]] = [order[to], order[at]];
  // Hidden and pinned columns keep the place they had in the full order, at the end.
  const rest2 = names.filter((column) => !order.includes(column));
  return { ...layout, order: [...order, ...rest2] };
}

export function toggleHidden(layout: ColumnLayout, name: string): ColumnLayout {
  return layout.hidden.includes(name)
    ? { ...layout, hidden: layout.hidden.filter((entry) => entry !== name) }
    : { ...layout, hidden: [...layout.hidden, name], pinned: layout.pinned.filter((entry) => entry !== name) };
}

export function togglePinned(layout: ColumnLayout, name: string): ColumnLayout {
  return layout.pinned.includes(name)
    ? { ...layout, pinned: layout.pinned.filter((entry) => entry !== name) }
    : { ...layout, pinned: [...layout.pinned, name] };
}

/** What the footer says about a column: over the selected rows, or all of them. */
export interface ColumnSummary {
  count: number;
  nulls: number;
  distinct: number;
  /** Set only when every non-NULL value is a number. */
  sum: number | null;
  avg: number | null;
  min: string | null;
  max: string | null;
}

export function summarize(values: (string | null)[]): ColumnSummary {
  let nulls = 0;
  let numeric = true;
  let sum = 0;
  let minNum = Infinity;
  let maxNum = -Infinity;
  let minText: string | null = null;
  let maxText: string | null = null;
  const distinct = new Set<string>();
  for (const value of values) {
    if (value === null) {
      nulls += 1;
      continue;
    }
    distinct.add(value);
    if (minText === null || value < minText) minText = value;
    if (maxText === null || value > maxText) maxText = value;
    const number = value.trim() === "" ? NaN : Number(value);
    if (numeric && Number.isFinite(number)) {
      sum += number;
      minNum = Math.min(minNum, number);
      maxNum = Math.max(maxNum, number);
    } else {
      numeric = false;
    }
  }
  const filled = values.length - nulls;
  const isNumber = numeric && filled > 0;
  return {
    count: values.length,
    nulls,
    distinct: distinct.size,
    sum: isNumber ? round(sum) : null,
    avg: isNumber ? round(sum / filled) : null,
    min: isNumber ? String(minNum) : minText,
    max: isNumber ? String(maxNum) : maxText,
  };
}

/** Rid of the float noise a sum of decimals picks up (`0.1 + 0.2`). */
function round(value: number): number {
  return Number(value.toPrecision(15));
}

/** Every cell holding `needle` (case-insensitive), in reading order, capped so a one-letter search
 *  over a big page stays cheap. */
export function findCells(
  rowCount: number,
  columns: number[],
  valueAt: (row: number, column: number) => string | null,
  needle: string,
  cap = 5000,
): { row: number; column: number }[] {
  const query = needle.toLowerCase();
  if (!query) return [];
  const out: { row: number; column: number }[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (const column of columns) {
      const value = valueAt(row, column);
      if ((value ?? "NULL").toLowerCase().includes(query)) {
        out.push({ row, column });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}
