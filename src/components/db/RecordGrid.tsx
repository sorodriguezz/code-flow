import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Maximize2 } from "lucide-react";
import {
  CELL_PREVIEW_LIMIT,
  CellEditor,
  MIN_COLUMN_WIDTH,
  preview,
  referenceLabel,
  type ResultGridProps,
} from "./ResultGrid";
import { useDbModalStore } from "../../state/dbModalStore";
import { useT } from "../../state/languageStore";

/**
 * The same result, read down the page instead of across it.
 *
 * A grid is the right shape for scanning many rows of a few columns and the wrong one for reading a
 * single row of forty — which is most of what a real table looks like. Here the axes are swapped:
 * the field names run down the left, one column per record runs across, and a record is read the way
 * a form is. Comparing two of them is looking at two adjacent columns rather than dragging a
 * horizontal scrollbar and holding the first one in your head.
 *
 * It takes the *same props* as [`ResultGrid`], deliberately — editing, staged changes, deleted rows,
 * selection, foreign keys and the cell expander all behave identically, because this is a way of
 * looking at the data and not a different feature. The panel switches between the two and nothing
 * else changes.
 *
 * The windowing runs the other way round for the same reason it exists at all: it is the *records*
 * that number in the hundreds here, so the horizontal axis is what gets sliced.
 */

const FIELD_HEIGHT = 24;
const HEADER_HEIGHT = 26;
const DEFAULT_FIELD_WIDTH = 170;
const DEFAULT_RECORD_WIDTH = 260;
/** Records rendered either side of the viewport, so a fast sideways scroll doesn't flash gaps. */
const OVERSCAN = 4;

export function RecordGrid({
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
  primaryKeys,
  foreignKeys,
  onFollowForeignKey,
}: ResultGridProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [fieldWidth, setFieldWidth] = useState(DEFAULT_FIELD_WIDTH);
  const [recordWidth, setRecordWidth] = useState(DEFAULT_RECORD_WIDTH);
  const [editing, setEditing] = useState<{ row: number; column: string } | null>(null);
  const openModal = useDbModalStore((s) => s.openDbModal);
  const sweep = useRecordSweep({ scrollRef, fieldWidth, recordWidth, count: rows.length, onSelectRange });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth));
    observer.observe(element);
    setViewportWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // A new result invalidates the scroll position, exactly as it does in the grid: record 90 of the
  // last page is nowhere in this one.
  useEffect(() => {
    scrollRef.current?.scrollTo({ left: 0 });
    setScrollLeft(0);
    setEditing(null);
  }, [columns, rows]);

  const total = rows.length + insertedRows.length;
  const first = Math.max(0, Math.floor(scrollLeft / recordWidth) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollLeft + viewportWidth) / recordWidth) + OVERSCAN);
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
    if (row >= rows.length) onEditInserted?.({ row: row - rows.length, column, value: raw });
    else onEdit?.({ row, column, value: raw });
    setEditing(null);
  };

  /** The gap standing in for the records scrolled off to the left, so the visible ones land in the
   * right place without every one of them being rendered. */
  const leadingGap = first * recordWidth;

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-0 overflow-auto"
      onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      onPointerMove={sweep.move}
      onPointerUp={sweep.end}
      onPointerCancel={sweep.end}
    >
      <div style={{ width: fieldWidth + total * recordWidth, minWidth: "100%" }}>
        {/* The record headers, pinned to the top. */}
        <div
          className="sticky top-0 z-20 flex bg-[var(--cf-surface)]"
          style={{ height: HEADER_HEIGHT }}
        >
          <div
            className="sticky left-0 z-30 flex shrink-0 items-center border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]"
            style={{ width: fieldWidth }}
          >
            {t("db.field")}
            <Resizer width={fieldWidth} onChange={setFieldWidth} />
          </div>
          <div style={{ width: leadingGap }} className="shrink-0" />
          {visible.map((row) => {
            const inserted = row >= rows.length;
            const selected = !inserted && (selectedRows?.has(row) ?? false);
            return (
              <div
                key={row}
                onContextMenu={(e) => {
                  if (!onRowContextMenu || inserted) return;
                  e.preventDefault();
                  onRowContextMenu(row, e);
                }}
                onPointerDown={(e) => {
                  if (inserted || !onSelectRow || e.button !== 0) return;
                  onSelectRow(row, { range: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
                  if (!e.shiftKey) sweep.start(e, row, e.metaKey || e.ctrlKey);
                }}
                title={inserted ? t("db.discardRow") : t("db.selectRowHint")}
                style={{ width: recordWidth }}
                className={`relative flex shrink-0 select-none items-center gap-1 border-b border-r border-[var(--cf-border)] px-2 text-[11px] ${
                  inserted
                    ? "bg-[color-mix(in_oklab,var(--cf-success)_18%,var(--cf-surface))] text-[var(--cf-text)]"
                    : selected
                      ? "bg-[color-mix(in_oklab,var(--cf-accent)_22%,var(--cf-surface))] font-semibold text-[var(--cf-text)]"
                      : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                } ${onSelectRow && !inserted ? "cursor-pointer" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate tabular-nums">
                  {inserted ? t("db.newRecord") : t("db.recordN", { n: String(row + 1) })}
                </span>
                {inserted && onRemoveInserted && (
                  <button
                    onClick={() => onRemoveInserted(row - rows.length)}
                    title={t("db.discardRow")}
                    className="shrink-0 text-[var(--cf-danger)] hover:underline"
                  >
                    ✕
                  </button>
                )}
                <Resizer width={recordWidth} onChange={setRecordWidth} />
              </div>
            );
          })}
        </div>

        {/* One flow row per field. The name cell is `sticky left-0`, which is what keeps the labels
            on screen however far right the records are scrolled. */}
        {columns.map((column, columnIndex) => (
          <div key={`${column.name}-${columnIndex}`} className="flex" style={{ height: FIELD_HEIGHT }}>
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] px-2"
              style={{ width: fieldWidth }}
            >
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text)]">
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
              {/* The type shares this line: there is no second line to give it here, and a record of
                  forty fields would be twice as tall for no more meaning. */}
              {column.type_name && (
                <span className="max-w-[42%] shrink-0 truncate text-[9.5px] text-[var(--cf-text-muted)]">
                  {column.type_name}
                </span>
              )}
              {foreignKeys?.get(column.name) && onFollowForeignKey && (
                <button
                  type="button"
                  onClick={() => onFollowForeignKey(foreignKeys.get(column.name)!, null)}
                  title={t("db.openReferencedTable", {
                    table: referenceLabel(foreignKeys.get(column.name)!),
                  })}
                  className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                >
                  <ExternalLink size={10} />
                </button>
              )}
            </div>
            <div style={{ width: leadingGap }} className="shrink-0" />
            {visible.map((row) => {
              const inserted = row >= rows.length;
              const deleted = deletedRows?.has(row) ?? false;
              const selected = !inserted && (selectedRows?.has(row) ?? false);
              const value = valueAt(row, columnIndex);
              const isChanged = inserted || (changed?.has(`${row}:${column.name}`) ?? false);
              const isEditing = editing?.row === row && editing.column === column.name;
              const editable = inserted ? Boolean(onEditInserted) : Boolean(onEdit);
              return (
                <div
                  key={row}
                  onDoubleClick={() => editable && setEditing({ row, column: column.name })}
                  onClick={(e) => {
                    const key = foreignKeys?.get(column.name);
                    if (!key || !onFollowForeignKey || !(e.metaKey || e.ctrlKey)) return;
                    e.preventDefault();
                    onFollowForeignKey(key, value);
                  }}
                  style={{ width: recordWidth }}
                  className={`group/cell flex shrink-0 items-center border-b border-r border-[var(--cf-border)] px-2 ${
                    isChanged && !inserted
                      ? "bg-[var(--cf-warning)]/[0.12]"
                      : inserted
                        ? "bg-[var(--cf-success)]/[0.07]"
                        : selected
                          ? "bg-[color-mix(in_oklab,var(--cf-accent)_10%,transparent)]"
                          : ""
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
        ))}
      </div>
    </div>
  );
}

/**
 * Press-and-drag record selection, the sideways twin of the grid's `useRowSweep`.
 *
 * Same reasoning, one axis over: records are windowed here, so the sweep converts the pointer's x
 * into a record index instead of waiting for events from headers that may not be rendered.
 */
function useRecordSweep({
  scrollRef,
  fieldWidth,
  recordWidth,
  count,
  onSelectRange,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  fieldWidth: number;
  recordWidth: number;
  count: number;
  onSelectRange?: (from: number, to: number, additive: boolean) => void;
}) {
  const state = useRef<{ anchor: number; additive: boolean; clientX: number; last: number } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const recordAt = (clientX: number): number => {
    const element = scrollRef.current;
    if (!element) return 0;
    const box = element.getBoundingClientRect();
    const x = clientX - box.left + element.scrollLeft - fieldWidth;
    return Math.min(count - 1, Math.max(0, Math.floor(x / recordWidth)));
  };

  const extend = () => {
    const current = state.current;
    if (!current || !onSelectRange) return;
    const record = recordAt(current.clientX);
    if (record === current.last) return;
    current.last = record;
    onSelectRange(current.anchor, record, current.additive);
  };

  const stopTimer = () => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  };

  useEffect(() => stopTimer, []);

  return {
    start: (e: React.PointerEvent, record: number, additive: boolean) => {
      if (!onSelectRange) return;
      e.preventDefault();
      // On the scroll container, not the header that was pressed: that header unmounts as soon as
      // the sweep scrolls it out of the window, and capture would die with it.
      scrollRef.current?.setPointerCapture?.(e.pointerId);
      state.current = { anchor: record, additive, clientX: e.clientX, last: record };
      stopTimer();
      timer.current = setInterval(() => {
        const element = scrollRef.current;
        const current = state.current;
        if (!element || !current) return;
        const box = element.getBoundingClientRect();
        const before = box.left + fieldWidth - current.clientX;
        const after = current.clientX - box.right;
        if (before > 0) element.scrollLeft -= Math.min(240, 24 + before);
        else if (after > 0) element.scrollLeft += Math.min(240, 24 + after);
        else return;
        extend();
      }, 60);
    },
    move: (e: React.PointerEvent) => {
      if (!state.current) return;
      state.current.clientX = e.clientX;
      extend();
    },
    end: () => {
      state.current = null;
      stopTimer();
    },
  };
}

/** The seam on the right of a header, dragged to resize. Invisible until hovered, like the grid's. */
function Resizer({ width, onChange }: { width: number; onChange: (width: number) => void }) {
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
      className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-[var(--cf-accent)]/40"
    />
  );
}
