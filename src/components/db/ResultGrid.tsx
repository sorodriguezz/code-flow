import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Maximize2 } from "lucide-react";
import { useDbModalStore } from "../../state/dbModalStore";
import { useT } from "../../state/languageStore";
import type { DbColumn } from "../../types/database";

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

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
/** Rows rendered above and below the viewport, so a fast scroll doesn't flash empty space. */
const OVERSCAN = 12;
const MIN_COLUMN_WIDTH = 64;
const DEFAULT_COLUMN_WIDTH = 160;
/** Beyond this a cell is shown truncated with an expander — a 40KB JSON document in a 26px row is
 * unreadable, and laying it out costs more than reading it. */
const CELL_PREVIEW_LIMIT = 300;

export interface GridEdit {
  row: number;
  column: string;
  value: string | null;
}

export interface ResultGridProps {
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
  /** Clicking a column header sorts by it, when set. */
  onSort?: (column: string) => void;
  sortColumn?: string | null;
  sortDescending?: boolean;
  /** Marks primary-key columns, which the header shows and the editor relies on. */
  primaryKeys?: Set<string>;
}

export function ResultGrid({
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
  onSort,
  sortColumn,
  sortDescending,
  primaryKeys,
}: ResultGridProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<{ row: number; column: string; inserted: boolean } | null>(
    null,
  );
  const openModal = useDbModalStore((s) => s.openDbModal);

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ minWidth: "100%", width: "max-content" }}>
          {/* Sticky so the column names survive scrolling a thousand rows — the single most useful
              thing a grid can do for a wide table. */}
          <div
            className="sticky top-0 z-10 flex border-b border-[var(--cf-border)] bg-[var(--cf-surface)]"
            style={{ height: HEADER_HEIGHT }}
          >
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-[var(--cf-border)] bg-[var(--cf-surface)]"
              style={{ width: 48 }}
            />
            {columns.map((column, columnIndex) => (
              <div
                key={`${column.name}-${columnIndex}`}
                style={{ width: widthOf(column.name) }}
                className="relative flex shrink-0 items-center gap-1 border-r border-[var(--cf-border)] px-2"
              >
                <button
                  type="button"
                  onClick={() => onSort?.(column.name)}
                  disabled={!onSort}
                  title={column.type_name ? `${column.name} · ${column.type_name}` : column.name}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--cf-text)]">
                    {column.name}
                  </span>
                  {primaryKeys?.has(column.name) && (
                    <span
                      title={t("db.primaryKey")}
                      className="shrink-0 text-[9px] font-bold text-[var(--cf-accent)]"
                    >
                      PK
                    </span>
                  )}
                  {sortColumn === column.name &&
                    (sortDescending ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
                </button>
                {/* The type under the name: it is what decides whether a value will be accepted,
                    and the thing you check before typing into a cell. */}
                {column.type_name && (
                  <span className="pointer-events-none absolute bottom-[1px] left-2 truncate text-[9px] text-[var(--cf-text-muted)]">
                    {column.type_name}
                  </span>
                )}
                <ColumnResizer
                  width={widthOf(column.name)}
                  onChange={(width) =>
                    setWidths((current) => ({ ...current, [column.name]: width }))
                  }
                />
              </div>
            ))}
          </div>

          <div style={{ height: totalRows * ROW_HEIGHT, position: "relative" }}>
            {visible.map((row) => {
              const inserted = row >= rows.length;
              const deleted = deletedRows?.has(row) ?? false;
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
                        : "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                  }`}
                >
                  {/* The row number, pinned: the anchor for "the third row" in any conversation
                      about a result, and where insert/delete state is marked. */}
                  <div
                    className="sticky left-0 z-[5] flex shrink-0 items-center justify-end gap-1 border-r border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 text-[10px] tabular-nums text-[var(--cf-text-muted)]"
                    style={{ width: 48 }}
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
                    <span>{inserted ? "+" : row + 1}</span>
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
                            {value !== null && value.length > CELL_PREVIEW_LIMIT && (
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

/** Long values are shown as one line: a newline inside a 26px row would be invisible anyway, and
 * seeing `\n` is how you know it's there. */
function preview(value: string): string {
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
function CellEditor({
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
