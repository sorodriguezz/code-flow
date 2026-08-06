import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Maximize2 } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { useDbModalStore } from "../../state/dbModalStore";
import { useT } from "../../state/languageStore";
import { fieldFacts, recordModel } from "../../lib/db/engineModel";
import type { DbColumn, DbForeignKey, DbKind } from "../../types/database";

/** `schema.table.column`, for the tooltips that say where an arrow leads. */
export function referenceLabel(key: DbForeignKey): string {
  const table = key.ref_schema ? `${key.ref_schema}.${key.ref_table}` : key.ref_table;
  return `${table}.${key.ref_column}`;
}

/**
 * The result grid — read-only or editable, one implementation.
 *
 * Three things it is deliberate about:
 *
 * 1. **NULL is not empty.** A NULL cell renders as a dim italic `NULL`, an empty string renders as
 *    nothing at all, and they are never drawn the same. Everything downstream (the generated
 *    `UPDATE`, the CSV export, the copied cell) keeps the distinction, so the grid has to be where
 *    the user can see it.
 *
 * 2. **It windows rows rather than virtualizing them.** A fixed row height and a slice around the
 *    scroll position is ~40 lines and handles the tens of thousands of rows a page limit allows. A
 *    virtualization library would handle millions, which this grid never shows — the page limit
 *    exists precisely so it doesn't have to.
 *
 * 3. **Editing is staged.** `onEdit` records a pending value; nothing here writes to a database.
 *    Changed cells are tinted, deleted rows struck through, and new rows marked — so "what am I
 *    about to save" is answerable by looking.
 */

export const ROW_HEIGHT = 26;
/** Two lines with room between them: the name, and the type under it. At the old 28px the type was
 * absolutely positioned into whatever space the name left, which was none — they touched. */
const HEADER_HEIGHT = 40;
/** Rows rendered above and below the viewport, so a fast scroll doesn't flash empty space. */
const OVERSCAN = 12;
/** Wide enough for five digits and, when the panel asks for one, a select-all box over them. */
const GUTTER_WIDTH = 52;
export const MIN_COLUMN_WIDTH = 64;
const DEFAULT_COLUMN_WIDTH = 160;
/** Beyond this a cell is shown truncated with an expander — a 40KB JSON document in a 26px row is
 * unreadable, and laying it out costs more than reading it. */
export const CELL_PREVIEW_LIMIT = 300;

export interface GridEdit {
  row: number;
  column: string;
  value: string | null;
}

export interface ResultGridProps {
  /**
   * Whose rules these fields are read by. Required rather than optional: a grid that guesses is a
   * grid that draws `PK` on a MongoDB document, which is the thing `lib/db/engineModel` exists to
   * stop. Both layouts take it, so the two never disagree about what a field is.
   */
  engine: DbKind;
  columns: DbColumn[];
  rows: (string | null)[][];
  /** The value to show for a cell, when a staged edit should win over `rows`. */
  displayValue?: (row: number, column: string) => string | null;
  /** Set to make the grid editable. Called with the new value; `null` means NULL. */
  onEdit?: (edit: GridEdit) => void;
  /** Cells whose value differs from the server's, as `rowIndex:column` keys. */
  changed?: Set<string>;
  /** Rows staged for deletion. */
  deletedRows?: Set<number>;
  /** Rows appended locally, rendered after the server's, with their own indexing. */
  insertedRows?: (string | null)[][];
  onEditInserted?: (edit: GridEdit) => void;
  onRemoveInserted?: (row: number) => void;
  /** Right-clicking a row calls this; the caller decides what the menu holds. */
  onRowContextMenu?: (row: number, event: React.MouseEvent) => void;
  /**
   * Selected rows, by index into `rows`.
   *
   * The selection lives with the caller rather than here: what it is *for* — export these, delete
   * these, read these one field per line — belongs to the panel around the grid, and a selection the
   * grid owned privately would have to be mirrored out of it anyway.
   */
  selectedRows?: Set<number>;
  /**
   * A click on a row's number. Set this to make the gutter selectable.
   *
   * The modifiers are reported rather than resolved, because the anchor a shift-click extends from
   * is part of the selection the caller owns. `range` is shift, `toggle` is ⌘/Ctrl — the two
   * conventions every list on both platforms already uses.
   */
  onSelectRow?: (row: number, modifiers: { range: boolean; toggle: boolean }) => void;
  /**
   * A run of rows swept out by dragging down the gutter, reported continuously while the pointer
   * moves. `additive` means the drag began with ⌘/Ctrl held, so it adds to what was already there.
   *
   * Separate from `onSelectRow` because a drag is not a series of clicks: it has one anchor and one
   * moving end, and re-deriving that from per-row events would make dragging back up the gutter
   * *extend* the selection instead of shrinking it.
   */
  onSelectRange?: (from: number, to: number, additive: boolean) => void;
  /** The gutter's header box: every row, or none. */
  onSelectAllRows?: (selected: boolean) => void;
  /**
   * Clicking a column header sorts by it, when set.
   *
   * `additive` is ⇧ (or ⌘/Ctrl): add this column to the sort instead of replacing it. The caller
   * decides what a click *means* — the grid only reports which column and whether the modifier was
   * down, because the cycle through ascending, descending and unsorted belongs to whoever holds
   * the sort.
   */
  onSort?: (column: string, additive: boolean) => void;
  /** The sort keys in order, so a column can show both its direction and its place in the sort. */
  sort?: { column: string; descending: boolean }[];
  /** Marks primary-key columns, which the header shows and the editor relies on. */
  primaryKeys?: Set<string>;
  /** Columns that point at another table, keyed by column name. */
  foreignKeys?: Map<string, DbForeignKey>;
  /**
   * Follow a foreign key. `value` is the cell's, or `null` for "the whole referenced table" — which
   * is what the header's arrow means.
   *
   * Both are their own affordance rather than a plain click, because a plain click on a header
   * already sorts and a plain click on a cell already selects it for editing. Taking either over
   * would trade a thing the user does constantly for one they do occasionally. Cmd/Ctrl-clicking a
   * cell follows it too, for when it *is* the thing being done constantly.
   */
  onFollowForeignKey?: (key: DbForeignKey, value: string | null) => void;
}

export function ResultGrid({
  engine,
  columns,
  rows,
  displayValue,
  onEdit,
  changed,
  deletedRows,
  insertedRows = [],
  onEditInserted,
  onRemoveInserted,
  onRowContextMenu,
  selectedRows,
  onSelectRow,
  onSelectRange,
  onSelectAllRows,
  onSort,
  sort,
  primaryKeys,
  foreignKeys,
  onFollowForeignKey,
}: ResultGridProps) {
  const t = useT();
  const model = recordModel(engine);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<{ row: number; column: string; inserted: boolean } | null>(
    null,
  );
  const openModal = useDbModalStore((s) => s.openDbModal);
  const sweep = useRowSweep({
    scrollRef,
    headerHeight: HEADER_HEIGHT,
    rowCount: rows.length,
    onSelectRange,
  });

  // The viewport's height decides how many rows to render, and it isn't known until layout.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A new result invalidates the scroll position: row 8000 of the previous page is nowhere in this
  // one, and leaving the viewport there shows a blank grid over real data.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
    setEditing(null);
  }, [columns, rows]);

  const widthOf = (column: string) => widths[column] ?? DEFAULT_COLUMN_WIDTH;
  const totalRows = rows.length + insertedRows.length;
  // Server rows only: an inserted row exists nowhere yet, so "select everything" can't include one.
  const allSelected = rows.length > 0 && (selectedRows?.size ?? 0) >= rows.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visible = useMemo(
    () => Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index),
    [first, last],
  );

  if (columns.length === 0) {
    return (
      <p className="flex h-full items-center justify-center text-[12px] text-[var(--cf-text-muted)]">
        {t("db.noColumns")}
      </p>
    );
  }

  const valueAt = (row: number, columnIndex: number): string | null => {
    const column = columns[columnIndex]?.name ?? "";
    if (row >= rows.length) return insertedRows[row - rows.length]?.[columnIndex] ?? null;
    if (displayValue) return displayValue(row, column);
    return rows[row]?.[columnIndex] ?? null;
  };

  const commit = (row: number, columnIndex: number, raw: string | null) => {
    const column = columns[columnIndex]?.name ?? "";
    const edit: GridEdit = { row, column, value: raw };
    if (row >= rows.length) onEditInserted?.({ ...edit, row: row - rows.length });
    else onEdit?.(edit);
    setEditing(null);
  };

  return (
    // `isolate` keeps the grid's own layers — the sticky header, the pinned row-number gutter —
    // inside the grid. They are ordered against each other, not against the rest of the app, and
    // left un-isolated they climb into the page's stacking context and paint over whatever chrome
    // sits alongside the panel, the resize seams included.
    <div className="isolate flex h-full min-h-0 flex-col overflow-hidden">
      {/* The sweep's move/up land here rather than on the row that was pressed: capture is held by
          this element, because it is the one that survives the windowing. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onPointerMove={sweep.move}
        onPointerUp={sweep.end}
        onPointerCancel={sweep.end}
      >
        <div style={{ minWidth: "100%", width: "max-content" }}>
          {/* Sticky so the column names survive scrolling a thousand rows — the single most useful
              thing a grid can do for a wide table. */}
          <div
            className="sticky top-0 z-10 flex border-b border-[var(--cf-border)] bg-[var(--cf-surface)]"
            style={{ height: HEADER_HEIGHT }}
          >
            {/* The corner over the row numbers: all or none, the way the gutter's own header
                behaves in every grid that lets you select rows. */}
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-center border-r border-[var(--cf-border)] bg-[var(--cf-surface)]"
              style={{ width: GUTTER_WIDTH }}
            >
              {onSelectAllRows && rows.length > 0 && (
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && (selectedRows?.size ?? 0) > 0}
                  onChange={onSelectAllRows}
                />
              )}
            </div>
            {columns.map((column, columnIndex) => {
              const sortIndex = sort?.findIndex((key) => key.column === column.name) ?? -1;
              const sortKey = sortIndex >= 0 ? sort?.[sortIndex] : undefined;
              const facts = fieldFacts(model, column, { primaryKeys, foreignKeys });
              return (
              <div
                key={`${column.name}-${columnIndex}`}
                style={{ width: widthOf(column.name) }}
                className="relative flex shrink-0 flex-col justify-center border-r border-[var(--cf-border)]"
              >
                {/*
                  The button *is* the cell — full width, full height, and it owns the padding.

                  It used to be a content-sized element inside a padded box, which meant the header
                  you saw and the header you could click were different rectangles: the two lines of
                  padding and the whole type row below the name did nothing, so sorting a column
                  meant hitting its name rather than its header. The visual box has to be the target,
                  or the target has to be found by trial.
                */}
                <button
                  type="button"
                  onClick={(e) => onSort?.(column.name, e.shiftKey || e.metaKey || e.ctrlKey)}
                  disabled={!onSort}
                  title={onSort ? t("db.sortHint") : column.name}
                  className="flex h-full w-full min-w-0 flex-col justify-center gap-[3px] px-2 py-1 text-left disabled:cursor-default"
                >
                  <span className="flex w-full min-w-0 items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold leading-none text-[var(--cf-text)]">
                      {column.name}
                    </span>
                    {facts.identity && model.identity && (
                      <span
                        title={t(model.identity.label)}
                        className="shrink-0 text-[9px] font-bold leading-none text-[var(--cf-accent)]"
                      >
                        {model.identity.badge}
                      </span>
                    )}
                    {sortKey && (
                      <span className="flex shrink-0 items-center text-[var(--cf-accent)]">
                        {sortKey.descending ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                        {/* Which key this is, when there is more than one — an arrow on three
                            columns says nothing about which of them breaks the tie. */}
                        {(sort?.length ?? 0) > 1 && (
                          <span className="text-[8.5px] font-bold leading-none tabular-nums">
                            {sortIndex + 1}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  {/* The type under the name: it is what decides whether a value will be accepted,
                      and the thing you check before typing into a cell. Inside the button rather
                      than beside it, so the line it occupies sorts like the rest of the header. */}
                  {facts.type && (
                    <span
                      // Italic when it came off a value rather than a declaration: on a document
                      // store this is the type of the first document that had the field, and saying
                      // it as flatly as a column type would be claiming the rest agree.
                      className={`min-w-0 truncate text-[9px] leading-none text-[var(--cf-text-muted)] ${
                        facts.typeFromRecord ? "italic" : ""
                      }`}
                    >
                      {facts.type}
                    </span>
                  )}
                </button>
                {/* The arrow rides beside the name, not over it: the header's job is still to sort.
                    Its tooltip names the destination, which is the only place the referenced table
                    is spelled out. A sibling of the button rather than a child — nesting one button
                    in another is invalid, and it needs to sit above the cell-sized target anyway. */}
                {facts.reference && onFollowForeignKey && (
                  <button
                    type="button"
                    onClick={() => onFollowForeignKey(facts.reference!, null)}
                    title={t("db.openReferencedTable", {
                      table: referenceLabel(facts.reference),
                    })}
                    className="absolute right-2.5 top-1 z-10 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                  >
                    <ExternalLink size={10} />
                  </button>
                )}
                <ColumnResizer
                  width={widthOf(column.name)}
                  onChange={(width) =>
                    setWidths((current) => ({ ...current, [column.name]: width }))
                  }
                />
              </div>
              );
            })}
          </div>

          <div style={{ height: totalRows * ROW_HEIGHT, position: "relative" }}>
            {visible.map((row) => {
              const inserted = row >= rows.length;
              const deleted = deletedRows?.has(row) ?? false;
              const selected = !inserted && (selectedRows?.has(row) ?? false);
              return (
                <div
                  key={row}
                  onContextMenu={(e) => {
                    if (!onRowContextMenu) return;
                    e.preventDefault();
                    onRowContextMenu(row, e);
                  }}
                  style={{
                    position: "absolute",
                    top: row * ROW_HEIGHT,
                    height: ROW_HEIGHT,
                    display: "flex",
                    minWidth: "100%",
                  }}
                  className={`border-b border-[var(--cf-border)] ${
                    inserted
                      ? "bg-[var(--cf-success)]/[0.07]"
                      : deleted
                        ? "bg-[var(--cf-danger)]/[0.08]"
                        : selected
                          ? "bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)]"
                          : "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                  }`}
                >
                  {/* The row number, pinned: the anchor for "the third row" in any conversation
                      about a result, where insert/delete state is marked — and, when the panel
                      wants a selection, the handle you click to build one. */}
                  <div
                    className={`sticky left-0 z-[5] flex shrink-0 items-center justify-end gap-1 border-r border-[var(--cf-border)] px-1.5 text-[10px] tabular-nums ${
                      selected
                        ? "bg-[color-mix(in_oklab,var(--cf-accent)_22%,var(--cf-surface))] font-semibold text-[var(--cf-text)]"
                        : "bg-[var(--cf-surface)] text-[var(--cf-text-muted)]"
                    }`}
                    style={{ width: GUTTER_WIDTH }}
                  >
                    {inserted && onRemoveInserted ? (
                      <button
                        onClick={() => onRemoveInserted(row - rows.length)}
                        title={t("db.discardRow")}
                        className="text-[var(--cf-danger)] hover:underline"
                      >
                        ✕
                      </button>
                    ) : null}
                    {inserted || !onSelectRow ? (
                      <span>{inserted ? "+" : row + 1}</span>
                    ) : (
                      <button
                        type="button"
                        // Click, ⇧-click for a run and ⌘/Ctrl-click to pick rows apart — the same
                        // grammar as every file list — *and* press-and-drag to sweep a range out.
                        // The sweep can't work off the rows themselves, because this grid only
                        // renders the ones near the viewport and a drag would fall through the gaps;
                        // it reads the pointer's y instead. See `useRowSweep`.
                        onPointerDown={(e) => {
                          onSelectRow(row, {
                            range: e.shiftKey,
                            toggle: e.metaKey || e.ctrlKey,
                          });
                          if (!e.shiftKey) sweep.start(e, row, e.metaKey || e.ctrlKey);
                        }}
                        title={t("db.selectRowHint")}
                        className="w-full cursor-pointer select-none text-right"
                      >
                        {row + 1}
                      </button>
                    )}
                  </div>
                  {columns.map((column, columnIndex) => {
                    const value = valueAt(row, columnIndex);
                    const isChanged =
                      inserted || (changed?.has(`${row}:${column.name}`) ?? false);
                    const isEditing =
                      editing?.row === row && editing.column === column.name;
                    const editable = inserted ? Boolean(onEditInserted) : Boolean(onEdit);
                    return (
                      <div
                        key={`${column.name}-${columnIndex}`}
                        style={{ width: widthOf(column.name) }}
                        onDoubleClick={() =>
                          editable && setEditing({ row, column: column.name, inserted })
                        }
                        onClick={(e) => {
                          // The shortcut for a click that would otherwise only select the cell.
                          // Plain clicks are left alone — see `onFollowForeignKey`.
                          const key = foreignKeys?.get(column.name);
                          if (!key || !onFollowForeignKey || !(e.metaKey || e.ctrlKey)) return;
                          e.preventDefault();
                          onFollowForeignKey(key, value);
                        }}
                        className={`group/cell relative flex shrink-0 items-center border-r border-[var(--cf-border)] px-2 ${
                          isChanged && !inserted ? "bg-[var(--cf-warning)]/[0.12]" : ""
                        } ${deleted ? "line-through opacity-60" : ""}`}
                      >
                        {isEditing ? (
                          <CellEditor
                            value={value}
                            onCommit={(next) => commit(row, columnIndex, next)}
                            onCancel={() => setEditing(null)}
                          />
                        ) : (
                          <>
                            <span
                              className={`min-w-0 flex-1 truncate font-mono text-[12px] ${
                                value === null
                                  ? "italic text-[var(--cf-text-muted)]"
                                  : "text-[var(--cf-text)]"
                              }`}
                            >
                              {value === null ? "NULL" : preview(value)}
                            </span>
                            {/* On every value that has one, not only on the ones past
                                `CELL_PREVIEW_LIMIT`. What makes a cell unreadable is the column
                                being narrower than its contents, and that is a width the user drags
                                — an 80-character JSON in a 200px column is cut off just as
                                thoroughly as a 4000-character one, and used to offer no way in. The
                                button costs nothing when it isn't needed: it is invisible until the
                                row is hovered, and its space is reserved either way, so nothing
                                shifts. */}
                            {value !== null && (
                              <button
                                onClick={() =>
                                  openModal({
                                    kind: "cell",
                                    column: column.name,
                                    value,
                                    editable,
                                    onSave: editable
                                      ? (next) => commit(row, columnIndex, next)
                                      : undefined,
                                  })
                                }
                                title={t("db.expandCell")}
                                className="shrink-0 text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-accent)] group-hover/cell:opacity-100"
                              >
                                <Maximize2 size={10} />
                              </button>
                            )}
                            {/* On hover rather than always: one arrow per foreign-key cell, on
                                every row, would be a column of arrows competing with the data. */}
                            {foreignKeys?.get(column.name) && onFollowForeignKey && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onFollowForeignKey(foreignKeys.get(column.name)!, value);
                                }}
                                title={t("db.followForeignKey", {
                                  table: referenceLabel(foreignKeys.get(column.name)!),
                                })}
                                className="shrink-0 text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-accent)] group-hover/cell:opacity-100"
                              >
                                <ExternalLink size={10} />
                              </button>
                            )}
                          </>
                        )}
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

/**
 * Press-and-drag row selection.
 *
 * The hard part is that this grid **doesn't render the rows you're dragging past**: it keeps a
 * window around the viewport, so a drag that relied on `pointerenter` firing per row would select
 * nothing below the fold and would stop dead the moment it outran the window. So the sweep never
 * looks at rows at all — it converts the pointer's y into a row index arithmetically, from the
 * scroll offset and the fixed row height, which is right whether or not that row exists in the DOM.
 *
 * Two things follow from the same choice. Pointer capture is taken on the **scroll container**, not
 * on the row number that was pressed: that row unmounts as soon as the sweep scrolls it out of the
 * window, and capture dies with the element — the drag would stop dead a screenful in. Capturing on
 * the container also keeps the moves coming after the pointer leaves the grid or the window.
 *
 * **The whole drag runs off one animation frame loop**, and that is what makes it feel like dragging
 * rather than like a series of jumps. `move` writes the pointer's position to a ref and returns —
 * it renders nothing. Once per frame the loop scrolls, works out which row is under the pointer, and
 * updates the selection at most once. A pointer device sending 120 events a second would otherwise
 * push 120 renders a second through a grid of several hundred cells, and the edge scroll on a timer
 * moved in visible steps between them.
 */
function useRowSweep({
  scrollRef,
  headerHeight,
  rowCount,
  onSelectRange,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  headerHeight: number;
  rowCount: number;
  onSelectRange?: (from: number, to: number, additive: boolean) => void;
}) {
  const state = useRef<{
    anchor: number;
    additive: boolean;
    clientY: number;
    last: number;
    time: number;
  } | null>(null);
  const frame = useRef<number | null>(null);
  // Read through a ref so the loop, which is started once per drag, always calls the current
  // handler instead of the one that existed when the pointer went down.
  const latest = useRef({ headerHeight, rowCount, onSelectRange });
  latest.current = { headerHeight, rowCount, onSelectRange };

  const stop = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  useEffect(() => stop, []);

  const tick = (now: number) => {
    const current = state.current;
    const element = scrollRef.current;
    if (!current || !element) {
      frame.current = null;
      return;
    }
    // Clamped, so one dropped frame — a garbage collection, a slow paint — doesn't teleport the
    // scroll a thousand rows.
    const elapsed = Math.min(64, current.time === 0 ? 16 : now - current.time);
    current.time = now;

    const box = element.getBoundingClientRect();
    const above = box.top + latest.current.headerHeight - current.clientY;
    const below = current.clientY - box.bottom;
    const past = above > 0 ? -above : below > 0 ? below : 0;
    if (past !== 0) {
      // Pixels per second, ramped by how far past the edge the pointer is: a hair over the edge
      // creeps, an inch past it flies. Multiplied by the frame's own duration, so the speed is the
      // same on a 60Hz panel and a 120Hz one.
      const speed = Math.sign(past) * Math.min(3000, 260 + Math.abs(past) * 26);
      element.scrollTop += (speed * elapsed) / 1000;
    }

    const y = current.clientY - box.top + element.scrollTop - latest.current.headerHeight;
    const row = Math.min(
      latest.current.rowCount - 1,
      Math.max(0, Math.floor(y / ROW_HEIGHT)),
    );
    if (row !== current.last) {
      current.last = row;
      latest.current.onSelectRange?.(current.anchor, row, current.additive);
    }
    frame.current = requestAnimationFrame(tick);
  };

  return {
    start: (e: React.PointerEvent, row: number, additive: boolean) => {
      if (!onSelectRange) return;
      e.preventDefault();
      scrollRef.current?.setPointerCapture?.(e.pointerId);
      state.current = { anchor: row, additive, clientY: e.clientY, last: row, time: 0 };
      stop();
      frame.current = requestAnimationFrame(tick);
    },
    move: (e: React.PointerEvent) => {
      // Deliberately just a write. Everything the move implies happens on the next frame.
      if (state.current) state.current.clientY = e.clientY;
    },
    end: () => {
      state.current = null;
      stop();
    },
  };
}

/** Long values are shown as one line: a newline inside a 26px row would be invisible anyway, and
 * seeing `\n` is how you know it's there. */
export function preview(value: string): string {
  const flat = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return flat.length > CELL_PREVIEW_LIMIT ? `${flat.slice(0, CELL_PREVIEW_LIMIT)}…` : flat;
}

/**
 * The in-cell editor.
 *
 * `⌘⌫` sets NULL — it has to be reachable, because "clear this cell" and "set this cell to NULL" are
 * different edits and a text box can only express the first. Escape cancels, Enter commits, and blur
 * commits too, since clicking another cell is a natural way to mean "done".
 */
export function CellEditor({
  value,
  onCommit,
  onCancel,
}: {
  value: string | null;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={draft}
      title={t("db.cellEditorHint")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if ((e.metaKey || e.ctrlKey) && (e.key === "Backspace" || e.key === "Delete")) {
          e.preventDefault();
          onCommit(null);
        }
      }}
      className="h-full w-full min-w-0 border-0 bg-[var(--cf-bg)] px-0 font-mono text-[12px] text-[var(--cf-text)] outline-none ring-1 ring-inset ring-[var(--cf-accent)]"
    />
  );
}

/** The seam between two column headers. Invisible until hovered — four visible dividers in a 28px
 * header row read as a barred table and end up heavier than the labels they separate. */
function ColumnResizer({
  width,
  onChange,
}: {
  width: number;
  onChange: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onChange(Math.max(MIN_COLUMN_WIDTH, start.current.width + (e.clientX - start.current.x)));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--cf-accent)]/40"
    />
  );
}
