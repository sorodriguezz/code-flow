import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Checkbox } from "./Checkbox";
import { ColumnResizer, MIN_COLUMN_WIDTH, measureText, useRowSweep } from "./gridBits";
import { useT } from "../../state/languageStore";

/**
 * The windowed grid every remote listing is drawn with: fixed row height, a sticky header, a pinned
 * row-number gutter, resizable columns and a pointer sweep.
 *
 * It was the Azure Table entity grid first, and it is here because `gridBits` already records what
 * happens when this file gets copied instead of shared — "the seam had already been written twice
 * with the second copy silently missing the pieces the first had grown". A blob listing, a file
 * share and a queue are three more copies of the same eighty lines, and the copy that would go
 * missing this time is the windowing: `ObjectBrowser` renders every loaded row today, which is fine
 * at 200 and is not fine at the several thousand a few "load more"s accumulate.
 *
 * **The grid knows nothing about what a row is.** It is handed `GridColumn`s that can turn a row
 * into text and, if they want, into a richer body — so "this Azure Table entity has no such
 * property, draw a dim italic `null`" stays in the Table panel, where that is a true statement,
 * and "this share row has no size because a share has no size, draw nothing" stays in the file
 * browser. A grid that knew either of those would have to know both, and then it would be asserting
 * one service's theology over another's data.
 *
 * What it is *not*: `db/ResultGrid` is typed on `DbColumn`/`DbKind` and staged cell edits, and the
 * part the two genuinely share — the seam and the sweep — is already shared, as `gridBits`.
 *
 * **Rows are windowed, not virtualized.** A fixed row height and a slice around the scroll position
 * handles the 500-per-page a service returns and the several thousand a few "load more"s
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
/** The same size in the page's own face, for a column that isn't `mono`. Measuring a proportional
 *  column against the monospace stack fits it to a width its text never uses — every glyph in the
 *  mono face is as wide as the widest one, so an `Inserted` column of dates comes out a third too
 *  wide and pushes the columns after it off the window. */
const CELL_SANS_FONT = "12px ui-sans-serif, system-ui, sans-serif";
const HEADER_FONT = "600 11px ui-sans-serif, system-ui, sans-serif";

/** Long values are shown as one line: a newline inside a 26px row would be invisible anyway, and
 *  seeing `\n` is how you know it's there. */
export function preview(value: string): string {
  const flat = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return flat.length > CELL_PREVIEW_LIMIT ? `${flat.slice(0, CELL_PREVIEW_LIMIT)}…` : flat;
}

/**
 * One column, as the grid needs it: an identity, a label, and a way to get from a row to text.
 *
 * The split between `text` and `cell` is the whole design. `text` is the value — one definition of
 * it, read by the hover, by the CSV export, by the sort the caller runs and by the auto-fit
 * measurement below. `cell` only decides how that value is *drawn*, and a column whose `cell` draws
 * something `text` doesn't mention is a column that measures and exports one thing while showing
 * another.
 */
export interface GridColumn<T> {
  /** Stable identity. The widths map, the sort key, the order and the hidden set are all keyed on
   *  this — never on the label, which is a translation and moves with the language. */
  key: string;
  label: string;
  /** The cell's text, and the *only* definition of it: the title, the CSV export and the auto-fit
   *  measurement all read this, so a column whose `cell` draws something else is a column whose
   *  width is wrong. `null` means this row has no such value. */
  text: (row: T) => string | null;
  /** A richer body inside the same truncating span — a glyph and a name, a tinted lease. */
  cell?: (row: T) => React.ReactNode;
  /** Extra classes on that span, per row: the dim italic an absent value is drawn in. Returning
   *  nothing takes the ordinary text colour, so the two are an either/or rather than two colour
   *  utilities racing for the same property. */
  cellClass?: (row: T) => string;
  /** Overrides the hover, for the column whose full value is not the useful one — a blob's path
   *  under its name, "this entity has no X" where there is no value to show. */
  title?: (row: T) => string;
  align?: "left" | "right";
  mono?: boolean;
  /** Off for a column with no total order worth offering. Default on. */
  sortable?: boolean;
}

/**
 * How wide each column has to be for its widest value to fit — which is what the user asked for by
 * "que las columnas se ajusten al ancho del largo de caracteres de la respuesta".
 *
 * Measured rather than counted, and capped rather than honest: one row carrying a 4KB payload
 * would otherwise set a column 30 screens wide and push every other column out of the window, so a
 * runaway column stops at `MAX` and keeps its expander. Sampled rather than exhaustive for the same
 * reason a page limit exists — measuring 20,000 strings to place a header is work nobody asked for,
 * and the widest of the first few hundred is the widest in practice.
 */
const AUTO_FIT_MAX = 460;
const AUTO_FIT_SAMPLE = 400;
/** The cell's own padding plus the border, so the text isn't flush against the seam. */
const AUTO_FIT_PADDING = 22;

export function autoFitWidth<T>(column: GridColumn<T>, rows: T[]): number {
  // The header has a sort arrow beside it whenever it is the sort key, so it is measured with room
  // for one — a column auto-fitted to its name alone starts truncating the moment you sort by it.
  let widest = measureText(column.label, HEADER_FONT) + 14;
  const font = column.mono ? CELL_FONT : CELL_SANS_FONT;
  const sample = rows.length > AUTO_FIT_SAMPLE ? rows.slice(0, AUTO_FIT_SAMPLE) : rows;
  for (const row of sample) {
    const text = column.text(row);
    // An absent value is drawn too — as a `null`, a blank or whatever the column decided — and in a
    // narrower font than the value it stands in for.
    const width = text === null ? 26 : measureText(preview(text), font);
    if (width > widest) widest = width;
    if (widest >= AUTO_FIT_MAX) return AUTO_FIT_MAX;
  }
  return Math.min(AUTO_FIT_MAX, Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest) + AUTO_FIT_PADDING));
}

/** Every column fitted at once — what a fresh page does before the user has dragged anything. */
export function autoFitWidths<T>(columns: GridColumn<T>[], rows: T[]): Record<string, number> {
  // A null prototype, because a column key can be an entity property name and a table is free to
  // have one called `__proto__`. On an ordinary object literal `widths["__proto__"] = 160` sets the
  // prototype and creates no own property, so the caller's "which columns still need a width" check
  // would answer "this one" forever — an effect that re-runs itself until React gives up.
  const widths: Record<string, number> = Object.create(null);
  for (const column of columns) widths[column.key] = autoFitWidth(column, rows);
  return widths;
}

export interface DataGridProps<T> {
  /**
   * Changes when the grid is showing a *different result* — another table, another folder, or a
   * re-run of the query — and does not change when the same result grows.
   *
   * The scroll position is reset on this and on nothing else. It cannot be derived here: the column
   * list grows when a continuation page carries a property no earlier row had, which on a
   * schemaless table is the ordinary case, so keying the reset on the columns threw the user back to
   * row 1 every time they pressed "load more".
   */
  resetKey: string;
  columns: GridColumn<T>[];
  rows: T[];
  widths: Record<string, number>;
  onWidth: (key: string, width: number) => void;
  /** Double-click on a seam. The caller owns the measurement so it can fit against every row it has
   *  loaded, not only the ones this grid happens to be rendering. */
  onAutoFit: (key: string) => void;
  /**
   * The sort key, or `null` for the order the service returned.
   *
   * One key, not a list: the reason to sort here is to find something, not to build a report.
   * `onSort` is told which column was clicked and cycles it — ascending, descending, back to the
   * service's order — which is the third state the user asked for and the only way back to what the
   * request actually returned.
   */
  sort: { column: string; descending: boolean } | null;
  onSort: (key: string) => void;
  selected: Set<number>;
  onSelectRow: (row: number, modifiers: { range: boolean; toggle: boolean }) => void;
  onSelectRange: (from: number, to: number, additive: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  /** Double-clicking a row — the way every grid in this app opens the thing under the pointer. */
  onOpenRow?: (row: number) => void;
  onRowContextMenu?: (row: number, event: React.MouseEvent) => void;
  /**
   * A click anywhere on the row selects it, not only on the number.
   *
   * The file browser's grammar, and it has to stay: `ObjectBrowser` has always selected on a click
   * on the name, and a grid where the row you clicked is not the row you picked is a grid people
   * delete the wrong thing from. Off by default — the entity grid keeps selection on the gutter,
   * where a click in a cell is a click at a value.
   */
  selectOnRowClick?: boolean;
  /**
   * Pointer plumbing the row's *body* needs beyond selection, plus a per-row class.
   *
   * One escape hatch rather than five props, and it exists for exactly one caller: the object
   * browser's drag-a-row-onto-a-folder, which is a gesture on the row and not on the gutter — the
   * gutter belongs to the sweep and must never start a move.
   */
  rowBody?: (
    index: number,
    row: T,
  ) => {
    className?: string;
    onPointerDown?: (e: React.PointerEvent) => void;
    onPointerMove?: (e: React.PointerEvent) => void;
    onPointerUp?: (e: React.PointerEvent) => void;
    onPointerCancel?: (e: React.PointerEvent) => void;
    onPointerEnter?: (e: React.PointerEvent) => void;
  };
}

export function DataGrid<T>({
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
  selectOnRowClick,
  rowBody,
}: DataGridProps<T>) {
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

  const widthOf = (column: GridColumn<T>) => widths[column.key] ?? DEFAULT_COLUMN_WIDTH;
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
            {columns.map((column) => {
              const label = (
                <span
                  className={`min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--cf-text)] ${
                    column.align === "right" ? "text-right" : ""
                  }`}
                >
                  {column.label}
                </span>
              );
              const arrow =
                sort?.column === column.key ? (
                  <span className="shrink-0 text-[var(--cf-accent)]">
                    {sort.descending ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                  </span>
                ) : null;
              return (
                <div
                  key={column.key}
                  style={{ width: widthOf(column) }}
                  className="relative flex shrink-0 items-stretch border-r border-[var(--cf-border)]"
                >
                  {/* The button *is* the cell — full width, full height, and it owns the padding. A
                      content-sized label in a padded box makes the header you see and the header you
                      can click two different rectangles. A column with no order worth offering is
                      the same box without the button, rather than a button that does nothing: a
                      control that answers a click with nothing is worse than no control. */}
                  {column.sortable === false ? (
                    <div className="flex h-full w-full min-w-0 items-center gap-1 px-2">{label}</div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSort(column.key)}
                      title={t("remote.gridSortHint", { column: column.label })}
                      className="flex h-full w-full min-w-0 items-center gap-1 px-2 text-left"
                    >
                      {label}
                      {arrow}
                    </button>
                  )}
                  <ColumnResizer
                    width={widthOf(column)}
                    onChange={(width) => onWidth(column.key, width)}
                    onAutoFit={() => onAutoFit(column.key)}
                    title={t("remote.gridAutoFitHint")}
                  />
                </div>
              );
            })}
          </div>

          <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
            {visible.map((index) => {
              const row = rows[index];
              if (!row) return null;
              const isSelected = selected.has(index);
              const { className: bodyClass, ...bodyHandlers } = rowBody?.(index, row) ?? {};
              return (
                <div
                  key={index}
                  onContextMenu={(e) => {
                    if (!onRowContextMenu) return;
                    e.preventDefault();
                    onRowContextMenu(index, e);
                  }}
                  onDoubleClick={() => onOpenRow?.(index)}
                  onClick={
                    selectOnRowClick
                      ? (e) => {
                          // Not when the click came out of the gutter. The row number selects on
                          // *pointer-down* — it has to, because that press is also the start of a
                          // sweep — and letting its click run the modifier logic a second time makes
                          // a ⌘-click toggle twice, which is a ⌘-click that does nothing at all. The
                          // row number is the only button inside a row, so this test is enough.
                          if ((e.target as HTMLElement).closest("button")) return;
                          onSelectRow(index, {
                            range: e.shiftKey,
                            toggle: e.metaKey || e.ctrlKey,
                          });
                        }
                      : undefined
                  }
                  {...bodyHandlers}
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
                  } ${bodyClass ?? ""}`}
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
                      // The one keyboard route into a row, and it is here because the row itself is
                      // no longer focusable: a windowed row is a `div` that unmounts when it scrolls
                      // out, and a `tabIndex` on it is a tab stop that comes and goes with the
                      // scroll position. This button is a real one, so Enter on it is Enter on the
                      // row it belongs to.
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || !onOpenRow) return;
                        e.preventDefault();
                        onOpenRow(index);
                      }}
                      title={t("remote.gridSelectRowHint")}
                      className="flex h-full flex-1 cursor-pointer select-none items-center justify-end px-1.5"
                    >
                      {index + 1}
                    </button>
                  </div>
                  {columns.map((column) => {
                    const text = column.text(row);
                    const right = column.align === "right";
                    const extra = column.cellClass?.(row);
                    return (
                      <div
                        key={column.key}
                        style={{ width: widthOf(column) }}
                        title={column.title?.(row) ?? text ?? ""}
                        className={`flex shrink-0 items-center overflow-hidden border-r border-[var(--cf-border)] px-2 ${
                          right ? "justify-end tabular-nums" : ""
                        }`}
                      >
                        {/* The span is the truncating box and it fills the cell, so a right-aligned
                            column needs the alignment on the text as well as on the box — the
                            `justify-end` above only moves a span that isn't already `flex-1`. */}
                        <span
                          className={`min-w-0 flex-1 truncate text-[12px] ${
                            column.mono ? "font-mono " : ""
                          }${right ? "text-right " : ""}${extra || "text-[var(--cf-text)]"}`}
                        >
                          {column.cell?.(row) ?? (text === null ? "" : preview(text))}
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
