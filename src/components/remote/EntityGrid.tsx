import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { ColumnResizer, MIN_COLUMN_WIDTH, measureText, useRowSweep } from "../common/gridBits";
import { useT } from "../../state/languageStore";

/**
 * The grid for one page of Azure Table entities.
 *
 * Its own component rather than the database workspace's `ResultGrid` for one reason that isn't
 * about effort: **a Table has no schema, so "this property is absent" is a fact about the row, not
 * about the column.** The DB grid's data shape is `(string | null)[][]` — a rectangle, one cell per
 * column per row — which can say NULL but cannot say *missing*, and on this service those are the
 * same word for a different thing. Azure does not store nulls: setting a property to null deletes
 * it, so a column exists exactly as long as some entity still carries it. Everything below follows
 * from that.
 *
 * What it shares with the DB grid is the mechanics, and those are shared as code — `ColumnResizer`
 * and `useRowSweep` in `common/gridBits`, so a seam drags the same way and a selection sweeps the
 * same way in both workspaces.
 *
 * **Rows are windowed, not virtualized.** A fixed row height and a slice around the scroll position
 * handles the 500-per-page the service returns and the several thousand a few "load more"s
 * accumulate, in forty lines rather than a dependency.
 */

export const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 30;
/** Rows rendered above and below the viewport, so a fast scroll doesn't flash empty space. */
const OVERSCAN = 12;
/** Wide enough for five digits and the select-all box over them. */
const GUTTER_WIDTH = 52;
export const DEFAULT_COLUMN_WIDTH = 160;
/** Longer than this and a cell is shown cut, with the whole value on the title. A 40KB JSON blob in
 *  a 26px row is unreadable and laying it out costs more than reading it. */
const CELL_PREVIEW_LIMIT = 300;

/** The font the cells are drawn in, as a canvas font string — see `autoFitWidths`. */
const CELL_FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const HEADER_FONT = "600 11px ui-sans-serif, system-ui, sans-serif";

/**
 * One cell's text, or `null` when the entity has no such property.
 *
 * The distinction is the point: `null` is drawn as a dim italic `null` the way Storage Explorer
 * draws it, an empty string is drawn as nothing, and a sort puts the two in different places.
 * Objects and arrays are stringified — a Table property can hold a JSON blob, and a grid row is not
 * where it gets expanded.
 */
export function cellText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Long values are shown as one line: a newline inside a 26px row would be invisible anyway, and
 *  seeing `\n` is how you know it's there. */
export function preview(value: string): string {
  const flat = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return flat.length > CELL_PREVIEW_LIMIT ? `${flat.slice(0, CELL_PREVIEW_LIMIT)}…` : flat;
}

/**
 * How wide each column has to be for its widest value to fit — which is what the user asked for by
 * "que las columnas se ajusten al ancho del largo de caracteres de la respuesta".
 *
 * Measured rather than counted, and capped rather than honest: one entity carrying a 4KB payload
 * would otherwise set a column 30 screens wide and push every other column out of the window, so a
 * runaway column stops at `MAX` and keeps its expander. Sampled rather than exhaustive for the same
 * reason a page limit exists — measuring 20,000 strings to place a header is work nobody asked for,
 * and the widest of the first few hundred is the widest in practice.
 */
const AUTO_FIT_MAX = 460;
const AUTO_FIT_SAMPLE = 400;
/** The cell's own padding plus the border, so the text isn't flush against the seam. */
const AUTO_FIT_PADDING = 22;

export function autoFitWidth(column: string, rows: Record<string, unknown>[]): number {
  // The header has a sort arrow beside it whenever it is the sort key, so it is measured with room
  // for one — a column auto-fitted to its name alone starts truncating the moment you sort by it.
  let widest = measureText(column, HEADER_FONT) + 14;
  const sample = rows.length > AUTO_FIT_SAMPLE ? rows.slice(0, AUTO_FIT_SAMPLE) : rows;
  for (const row of sample) {
    const text = cellText(row, column);
    // `null` is drawn too, and in a narrower font than the value it stands in for.
    const width = text === null ? 26 : measureText(preview(text), CELL_FONT);
    if (width > widest) widest = width;
    if (widest >= AUTO_FIT_MAX) return AUTO_FIT_MAX;
  }
  return Math.min(AUTO_FIT_MAX, Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest) + AUTO_FIT_PADDING));
}

/** Every column fitted at once — what a fresh page does before the user has dragged anything. */
export function autoFitWidths(
  columns: string[],
  rows: Record<string, unknown>[],
): Record<string, number> {
  // A null prototype, because the keys are entity property names and a table is free to have one
  // called `__proto__`. On an ordinary object literal `widths["__proto__"] = 160` sets the prototype
  // and creates no own property, so the caller's "which columns still need a width" check would
  // answer "this one" forever — an effect that re-runs itself until React gives up.
  const widths: Record<string, number> = Object.create(null);
  for (const column of columns) widths[column] = autoFitWidth(column, rows);
  return widths;
}

export interface EntityGridProps {
  /**
   * Changes when the grid is showing a *different result* — another table, or a re-run of the
   * query — and does not change when the same result grows.
   *
   * The scroll position is reset on this and on nothing else. It cannot be derived here: the column
   * list grows when a continuation page carries a property no earlier entity had, which on a
   * schemaless table is the ordinary case, so keying the reset on the columns threw the user back to
   * row 1 every time they pressed "load more".
   */
  resetKey: string;
  columns: string[];
  rows: Record<string, unknown>[];
  widths: Record<string, number>;
  onWidth: (column: string, width: number) => void;
  /** Double-click on a seam. The caller owns the measurement so it can fit against every row it has
   *  loaded, not only the ones this grid happens to be rendering. */
  onAutoFit: (column: string) => void;
  /**
   * The sort key, or `null` for the order the service returned.
   *
   * One key, not a list: a Table's natural order is `PartitionKey` then `RowKey` and the reason to
   * sort here is to find something, not to build a report. `onSort` is told which column was
   * clicked and cycles it — ascending, descending, back to the service's order — which is the third
   * state the user asked for and the only way back to what the query actually returned.
   */
  sort: { column: string; descending: boolean } | null;
  onSort: (column: string) => void;
  selected: Set<number>;
  onSelectRow: (row: number, modifiers: { range: boolean; toggle: boolean }) => void;
  onSelectRange: (from: number, to: number, additive: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  /** Double-clicking a row — the way every grid in this app opens the thing under the pointer. */
  onOpenRow?: (row: number) => void;
  onRowContextMenu?: (row: number, event: React.MouseEvent) => void;
}

export function EntityGrid({
  resetKey,
  columns,
  rows,
  widths,
  onWidth,
  onAutoFit,
  sort,
  onSort,
  selected,
  onSelectRow,
  onSelectRange,
  onSelectAll,
  onOpenRow,
  onRowContextMenu,
}: EntityGridProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const sweep = useRowSweep({
    scrollRef,
    headerHeight: HEADER_HEIGHT,
    rowHeight: ROW_HEIGHT,
    rowCount: rows.length,
    onSelectRange,
  });

  // The viewport's height decides how many rows to render, and it isn't known until layout.
  //
  // `|| 400` is not belt-and-braces, it is the hidden-tab case: a tab that isn't the active one is
  // `display: none`, so this grid mounts with a `clientHeight` of 0 and would window itself down to
  // the overscan — a dozen rows — until something told it otherwise. Falling back to a plausible
  // height keeps a screenful rendered, and the observer corrects it the moment the tab is shown.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewportHeight(element.clientHeight || 400);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  // A new result invalidates the scroll position: row 4000 of the previous query is nowhere in this
  // one, and leaving the viewport there shows a blank grid over real data. "Load more" appends to
  // the same result and must not move the viewport at all — see `resetKey`.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [resetKey]);

  const widthOf = (column: string) => widths[column] ?? DEFAULT_COLUMN_WIDTH;
  const allSelected = rows.length > 0 && selected.size >= rows.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visible = useMemo(
    () => Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index),
    [first, last],
  );

  return (
    // `isolate` keeps the grid's own layers — the sticky header, the pinned gutter — inside the
    // grid. They are ordered against each other, not against the rest of the app.
    <div className="isolate flex h-full min-h-0 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // Re-measured here too: a scroll is proof the grid has a box, and it costs one read of a
          // value the browser has already laid out.
          setViewportHeight(e.currentTarget.clientHeight || 400);
        }}
        // The sweep's move/up land here rather than on the row that was pressed: capture is held by
        // this element, because it is the one that survives the windowing.
        onPointerMove={sweep.move}
        onPointerUp={sweep.end}
        onPointerCancel={sweep.end}
      >
        <div style={{ minWidth: "100%", width: "max-content" }}>
          <div
            className="sticky top-0 z-10 flex border-b border-[var(--cf-border)] bg-[var(--cf-surface)]"
            style={{ height: HEADER_HEIGHT }}
          >
            {/* The corner over the row numbers: all or none. From a *partial* selection it clears
                instead of completing — someone who has picked three rows and reaches for this box is
                undoing that pick, and it keeps the control reversible. */}
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-center border-r border-[var(--cf-border)] bg-[var(--cf-surface)]"
              style={{ width: GUTTER_WIDTH }}
            >
              {rows.length > 0 && (
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && selected.size > 0}
                  onChange={(on) => onSelectAll(!allSelected && selected.size > 0 ? false : on)}
                />
              )}
            </div>
            {columns.map((column) => (
              <div
                key={column}
                style={{ width: widthOf(column) }}
                className="relative flex shrink-0 items-stretch border-r border-[var(--cf-border)]"
              >
                {/* The button *is* the cell — full width, full height, and it owns the padding. A
                    content-sized label in a padded box makes the header you see and the header you
                    can click two different rectangles. */}
                <button
                  type="button"
                  onClick={() => onSort(column)}
                  title={t("remote.tableSortHint", { column })}
                  className="flex h-full w-full min-w-0 items-center gap-1 px-2 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--cf-text)]">
                    {column}
                  </span>
                  {sort?.column === column && (
                    <span className="shrink-0 text-[var(--cf-accent)]">
                      {sort.descending ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                    </span>
                  )}
                </button>
                <ColumnResizer
                  width={widthOf(column)}
                  onChange={(width) => onWidth(column, width)}
                  onAutoFit={() => onAutoFit(column)}
                  title={t("remote.tableAutoFitHint")}
                />
              </div>
            ))}
          </div>

          <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
            {visible.map((index) => {
              const row = rows[index];
              if (!row) return null;
              const isSelected = selected.has(index);
              return (
                <div
                  key={index}
                  onContextMenu={(e) => {
                    if (!onRowContextMenu) return;
                    e.preventDefault();
                    onRowContextMenu(index, e);
                  }}
                  onDoubleClick={() => onOpenRow?.(index)}
                  style={{
                    position: "absolute",
                    top: index * ROW_HEIGHT,
                    height: ROW_HEIGHT,
                    display: "flex",
                    minWidth: "100%",
                  }}
                  className={`border-b border-[var(--cf-border)] ${
                    isSelected
                      ? "bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)]"
                      : "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                  }`}
                >
                  {/* The row number, pinned: the anchor for "the third row" in any conversation
                      about a result, and the handle you click to build a selection. */}
                  <div
                    className={`sticky left-0 z-[5] flex shrink-0 items-stretch justify-end border-r border-[var(--cf-border)] text-[10px] tabular-nums ${
                      isSelected
                        ? "bg-[color-mix(in_oklab,var(--cf-accent)_22%,var(--cf-surface))] font-semibold text-[var(--cf-text)]"
                        : "bg-[var(--cf-surface)] text-[var(--cf-text-muted)]"
                    }`}
                    style={{ width: GUTTER_WIDTH }}
                  >
                    <button
                      type="button"
                      // Click, ⇧-click for a run and ⌘/Ctrl-click to pick rows apart — the same
                      // grammar as every file list — *and* press-and-drag to sweep a range out. The
                      // sweep can't work off the rows themselves, because this grid only renders the
                      // ones near the viewport and a drag would fall through the gaps.
                      onPointerDown={(e) => {
                        onSelectRow(index, { range: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
                        if (!e.shiftKey) sweep.start(e, index, e.metaKey || e.ctrlKey);
                      }}
                      title={t("remote.tableSelectRowHint")}
                      className="flex h-full flex-1 cursor-pointer select-none items-center justify-end px-1.5"
                    >
                      {index + 1}
                    </button>
                  </div>
                  {columns.map((column) => {
                    const text = cellText(row, column);
                    return (
                      <div
                        key={column}
                        style={{ width: widthOf(column) }}
                        title={text ?? t("remote.tableNullTitle", { column })}
                        className="flex shrink-0 items-center overflow-hidden border-r border-[var(--cf-border)] px-2"
                      >
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-[12px] ${
                            text === null
                              ? "italic text-[var(--cf-text-muted)]"
                              : "text-[var(--cf-text)]"
                          }`}
                        >
                          {text === null ? "null" : preview(text)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
