import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  Loader2,
  Plus,
  Rows3,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { RecordGrid } from "./RecordGrid";
import { ResultGrid } from "./ResultGrid";
import { nodeLabel } from "./SqlConsolePanel";
import { EngineBadge, ToolbarButton, formatCount, formatDuration } from "./dbChrome";
import {
  buildEdits,
  displayCell,
  hasPrimaryKey,
  pendingCount,
  useDbStore,
  type DbDataTab,
} from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useDbCommandStore } from "../../state/dbCommandStore";
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { EXPORT_EXTENSIONS, formatResult, type ExportFormat } from "../../lib/db/resultExport";
import { engineInfo, type DbForeignKey } from "../../types/database";

const PAGE_SIZES = [50, 100, 200, 500, 1000];

/**
 * What the floating menu is showing.
 *
 * `export` carries the rows it is about — an empty list meaning the whole page — so the format the
 * user then picks can't apply to a different set than the item they opened it from named.
 */
type PanelMenu =
  | { x: number; y: number; kind: "row"; row: number }
  | { x: number; y: number; kind: "export"; rows: number[] }
  | { x: number; y: number; kind: "pageSize" };

/**
 * One relation's rows, editable.
 *
 * The editing model is the whole design: **nothing is written until Apply.** Typing stages a change,
 * the changed cell is tinted, the pending count sits on the Apply button, and Apply sends the batch —
 * showing every statement it generated first. A grid that saved on blur would make an accidental
 * keystroke on a production table indistinguishable from an intentional edit.
 *
 * A selection is the second half of that model: the row numbers down the left select rows the way a
 * file list does, and what the selection is *for* — export these, stage these for deletion, read
 * these one field per line — is what the bar above the grid offers. Deleting a selection stages it
 * like every other edit; the Delete key does the same, and Apply is still what writes.
 *
 * The other thing worth knowing: **a table without a primary key is edited by matching every column
 * of the row.** That works, and it can match more than one row when the table holds exact
 * duplicates, so the panel says so before applying rather than after.
 */
export function DataTabPanel({ tab }: { tab: DbDataTab }) {
  const t = useT();
  const connection = useDbStore((s) => s.connections.find((c) => c.id === tab.connectionId));
  const openModal = useDbModalStore((s) => s.openDbModal);
  const store = useDbStore.getState();
  const [menu, setMenu] = useState<PanelMenu | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  /**
   * Which rows the gutter has selected, by index into the page.
   *
   * Here rather than in the store because it is about *this* look at the data: it indexes the page
   * on screen, so it cannot survive a reload, a sort or a page turn — and a persisted tab that
   * reopened with rows 3, 4 and 9 "selected" would be pointing at rows nobody chose.
   */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /**
   * Grid or record: rows across, or one record per column read down the page.
   *
   * A view state, so it lives here and not in the store — it is about this look at the data, like
   * the selection, and a persisted tab that reopened sideways would be surprising.
   */
  const [layout, setLayout] = useState<"grid" | "record">("grid");
  /** Where a ⇧-click measures its run from. */
  const anchor = useRef<number | null>(null);
  /** What a ⌘-drag must not throw away: the selection as it stood when the drag began. */
  const kept = useRef<Set<number>>(new Set());

  const engine = connection ? engineInfo(connection.kind) : null;
  const staged = pendingCount(tab);
  const identified = hasPrimaryKey(tab);

  // A restored tab has no rows yet — reopening the app deliberately doesn't fire a query per tab —
  // so the first look at one is what loads it.
  useEffect(() => {
    if (!tab.result && !tab.loading && !tab.error) void store.loadData(tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // New rows, new indexes. See the note on `selected`.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
    kept.current = new Set();
  }, [tab.result]);

  const primaryKeys = useMemo(
    () =>
      new Set(
        tab.columns.filter((column) => column.column?.primary_key).map((column) => column.name),
      ),
    [tab.columns],
  );

  /** By column, since that is how the grid asks — "the cell I'm on, where does it lead?". A column
   * in two foreign keys keeps the first, which is the one the catalog listed first. */
  const foreignKeys = useMemo(() => {
    const byColumn = new Map<string, DbForeignKey>();
    for (const key of tab.foreignKeys) {
      if (!byColumn.has(key.column)) byColumn.set(key.column, key);
    }
    return byColumn;
  }, [tab.foreignKeys]);

  const changed = useMemo(() => new Set(Object.keys(tab.pending)), [tab.pending]);
  const deleted = useMemo(() => new Set(tab.deleted), [tab.deleted]);

  /** The selection in page order, which is the order everything downstream should see it in. */
  const selectedRows = useMemo(
    () => [...selected].sort((a, b) => a - b),
    [selected],
  );

  /**
   * A click on a row number.
   *
   * Plain click picks one, ⇧ extends from the anchor, ⌘/Ctrl adds or removes one — and clicking the
   * only selected row clears it, so there is a way back to "nothing selected" that isn't hunting for
   * the header box.
   */
  const selectRow = (row: number, mods: { range: boolean; toggle: boolean }) => {
    // Always the first thing a press does, so a sweep that follows starts from what is on screen
    // now rather than from what the previous sweep happened to leave behind.
    kept.current = new Set();
    setSelected((current) => {
      if (mods.range && anchor.current !== null) {
        const [from, to] = [anchor.current, row].sort((a, b) => a - b);
        const next = new Set(mods.toggle ? current : []);
        for (let index = from; index <= to; index += 1) next.add(index);
        return next;
      }
      anchor.current = row;
      if (mods.toggle) {
        const next = new Set(current);
        if (!next.delete(row)) next.add(row);
        return next;
      }
      if (current.size === 1 && current.has(row)) return new Set();
      return new Set([row]);
    });
  };

  /**
   * A run swept out by dragging down the row numbers.
   *
   * Recomputed from the anchor every time rather than accumulated, so dragging back up *shrinks*
   * the run — which is what a drag means everywhere else and what accumulating would get wrong.
   * `additive` (the drag began with ⌘/Ctrl) keeps whatever was selected before it started.
   */
  const selectRange = (from: number, to: number, additive: boolean) => {
    const [start, end] = from <= to ? [from, to] : [to, from];
    setSelected((current) => {
      if (!additive) kept.current = new Set();
      else if (kept.current.size === 0) kept.current = new Set(current);
      const next = new Set(kept.current);
      for (let index = start; index <= end; index += 1) next.add(index);
      return next;
    });
  };

  const selectAll = (on: boolean) => {
    anchor.current = null;
    kept.current = new Set();
    setSelected(on ? new Set((tab.result?.rows ?? []).map((_, index) => index)) : new Set());
  };

  /**
   * A click on a column header: ascending → descending → unsorted, then round again.
   *
   * The third state is the one grids usually leave out, and it is the one you want most often — a
   * sort you added to look at something once otherwise has to be undone by sorting by something
   * else. ⇧ (or ⌘/Ctrl) adds the column to the sort instead of replacing it, so "newest first,
   * then by name" is two clicks; the same cycle then applies to that column alone, and its third
   * click drops it out of the sort and leaves the rest.
   */
  const cycleSort = (column: string, additive: boolean) => {
    const current = tab.sort;
    const index = current.findIndex((key) => key.column === column);
    let next: typeof current;
    if (index < 0) {
      next = additive ? [...current, { column, descending: false }] : [{ column, descending: false }];
    } else if (!current[index].descending) {
      const flipped = { column, descending: true };
      next = additive ? current.map((key, i) => (i === index ? flipped : key)) : [flipped];
    } else {
      next = additive ? current.filter((_, i) => i !== index) : [];
    }
    // Back to page one: the rows a sort brings to the top are the reason it was asked for, and
    // staying on page nine of the old order would hide them.
    store.updateData(tab.id, { sort: next, offset: 0 });
    void store.loadData(tab.id);
  };

  /** Stages the selection for deletion — nothing is written until Apply, as everywhere else here. */
  const deleteSelected = () => {
    if (selectedRows.length === 0) return;
    store.setDeletedRows(tab.id, selectedRows, true);
  };

  /** One field per line, for rows too wide to read across. Falls back to the whole page. */
  const openRecords = (rows: number[]) => {
    if (!tab.result) return;
    const indexes = rows.length > 0 ? rows : tab.result.rows.map((_, index) => index);
    if (indexes.length === 0) return;
    openModal({
      kind: "records",
      title: nodeLabel(tab.node),
      columns: tab.result.columns,
      // The row's own number travels with it: a record read on its own is worth nothing if you
      // can't find the row it came from back in the grid.
      records: indexes.map((index) => ({
        index,
        values: tab.result?.rows[index] ?? [],
      })),
    });
  };

  /** Saves rows in a format. `rows` empty means the page. */
  const exportRows = async (format: ExportFormat, rows: number[]) => {
    if (!tab.result) return;
    const picked =
      rows.length > 0 ? rows.map((index) => tab.result?.rows[index] ?? []) : tab.result.rows;
    // Mongo's own documents are picked the same way: exporting three selected documents as JSON
    // has to keep their nesting, which the column/value flattening would throw away.
    const documents =
      rows.length > 0
        ? rows.map((index) => tab.result?.documents[index]).filter((doc): doc is string => doc !== undefined)
        : tab.result.documents;
    const contents = formatResult(
      { ...tab.result, rows: picked, documents },
      format,
      nodeLabel(tab.node),
    );
    const saved = await apiSaveFile(
      `${tab.node.name ?? "rows"}.${EXPORT_EXTENSIONS[format]}`,
      contents,
    ).catch(() => null);
    if (saved) useToastStore.getState().pushToast(t("db.exported", { path: saved }), "success");
  };

  // ⌫/Del stages the selection for deletion, the way it does in a file list — but only when the
  // grid is what the keystroke was meant for: a cell editor, the WHERE box and any other input own
  // their own backspace.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selected.size === 0) return;
      // A modal has the user's attention; a keystroke aimed at it must not reach the grid behind.
      if (useDbModalStore.getState().modal !== null) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
      store.setDeletedRows(tab.id, [...selected].sort((a, b) => a - b), true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, store, tab.id]);

  /** Reloading throws staged edits away (row indexes shift), so it asks first when there are any. */
  const reload = async () => {
    if (staged > 0 && !(await confirmAction(t("db.discardEditsConfirm", { n: String(staged) })))) {
      return;
    }
    void store.loadData(tab.id);
  };

  const apply = () => {
    const edits = buildEdits(tab);
    if (edits.length === 0) return;
    openModal({
      kind: "preview",
      title: t("db.applyTitle", { n: String(staged) }),
      // What will run, before it runs. The backend returns the same list afterwards, so the two are
      // checkable against each other.
      statements: edits.map((edit) => describeEdit(edit.kind, edit.values.length, edit.keys.length)),
      onConfirm: () => void store.applyEdits(tab.id),
    });
  };

  // The keyboard routes to the three things this panel's toolbar and pager do. Every request is
  // consumed, handled or not: leaving one pending would replay it the moment another tab mounts.
  const request = useDbCommandStore((s) => s.request);
  useEffect(() => {
    if (!request) return;
    useDbCommandStore.getState().consume();
    if (request.command === "refresh") void reload();
    else if (request.command === "apply") apply();
    else if (request.command === "filter") {
      filterRef.current?.focus();
      filterRef.current?.select();
    }
    // `reload` and `apply` close over the tab, and re-running on every render would consume the
    // request twice; the nonce is what makes a repeated command a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  const page = Math.floor(tab.offset / tab.limit) + 1;
  const lastPage = tab.total === null ? null : Math.max(1, Math.ceil(tab.total / tab.limit));

  /**
   * The row menu.
   *
   * Right-clicking inside the selection acts on the selection; right-clicking outside it acts on
   * the row under the pointer, which is also what the click did to the selection a moment earlier.
   * Anything else would delete rows the user was not pointing at.
   */
  const rowMenu = (row: number, x: number, y: number): MenuItem[] => {
    const inSelection = selected.has(row);
    const rows = inSelection ? selectedRows : [row];
    const items: MenuItem[] = [];
    if (inSelection && rows.length > 1) {
      items.push({
        label: t("db.deleteSelectedRows", { n: String(rows.length) }),
        icon: Trash2,
        danger: true,
        onClick: () => store.setDeletedRows(tab.id, rows, true),
      });
    } else {
      items.push({
        label: deleted.has(row) ? t("db.undoDelete") : t("db.deleteRow"),
        icon: Trash2,
        danger: !deleted.has(row),
        onClick: () => store.toggleDeleteRow(tab.id, row),
      });
    }
    items.push({
      label: rows.length > 1 ? t("db.viewRecordsN", { n: String(rows.length) }) : t("db.viewRecord"),
      icon: Rows3,
      onClick: () => openRecords(rows),
    });
    items.push({
      label:
        rows.length > 1 ? t("db.exportSelectedN", { n: String(rows.length) }) : t("db.exportRow"),
      icon: Download,
      // Opens the format list where this menu already is: the formats are a second question about
      // the same rows, not a different menu somewhere else on screen.
      onClick: () => setMenu({ x, y, kind: "export", rows }),
    });
    items.push({
      label: rows.length > 1 ? t("db.copyRowsN", { n: String(rows.length) }) : t("db.copyRow"),
      icon: Copy,
      onClick: () => {
        const text = rows
          .map((index) =>
            (tab.result?.rows[index] ?? [])
              .map((value) => (value === null ? "NULL" : value))
              .join("\t"),
          )
          .join("\n");
        void navigator.clipboard.writeText(text);
      },
    });
    return items;
  };

  const exportItems = (rows: number[]): MenuItem[] =>
    (["csv", "tsv", "json", "sql", "markdown"] as ExportFormat[]).map((format) => ({
      label: t("db.exportAs", { format: format.toUpperCase() }),
      icon: Download,
      onClick: () => void exportRows(format, rows),
    }));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        {connection && <EngineBadge kind={connection.kind} label={engine?.label ?? ""} />}
        {/* Which connection these rows came from, in words. The engine badge says *what kind* of
            server it is, which is not the same question — two of the three connections in a
            workspace are usually the same engine, and the one you must not confuse is production
            with staging. The console has always said it; the grid used to leave it to the tab. */}
        <span
          className="max-w-[150px] shrink truncate text-[12px] text-[var(--cf-text-muted)]"
          title={connection?.name ?? t("db.connectionGone")}
        >
          {connection?.name ?? t("db.connectionGone")}
        </span>
        <span className="text-[var(--cf-text-muted)]">/</span>
        <span className="max-w-[240px] truncate text-[12px] font-medium text-[var(--cf-text)]">
          {nodeLabel(tab.node)}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {tab.loading ? (
            <ToolbarButton onClick={() => void store.cancelRun(tab.id)} title={t("db.cancel")}>
              <Square size={12} className="text-[var(--cf-danger)]" />
            </ToolbarButton>
          ) : (
            <ToolbarButton onClick={() => void reload()} title={t("db.refresh")}>
              <RefreshCw size={12} />
            </ToolbarButton>
          )}
          <ToolbarButton onClick={() => store.addRow(tab.id)} title={t("db.addRow")}>
            <Plus size={13} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => store.revertEdits(tab.id)}
            disabled={staged === 0}
            title={t("db.revert")}
          >
            <RotateCcw size={12} />
          </ToolbarButton>
          {/* How to look at the page, not what to do with a selection — which is why the "read
              these as records" action lives on the selection bar instead of beside this. */}
          <ToolbarButton
            onClick={() => setLayout((current) => (current === "grid" ? "record" : "grid"))}
            active={layout === "record"}
            disabled={!tab.result}
            title={layout === "grid" ? t("db.recordLayout") : t("db.gridLayout")}
          >
            {layout === "grid" ? <Columns3 size={12} /> : <Rows3 size={12} />}
          </ToolbarButton>
          <ToolbarButton
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 180, y: rect.bottom + 2, kind: "export", rows: selectedRows });
            }}
            disabled={!tab.result || tab.result.rows.length === 0}
            title={
              selectedRows.length > 0
                ? t("db.exportSelectedN", { n: String(selectedRows.length) })
                : t("db.export")
            }
          >
            <Download size={12} />
          </ToolbarButton>
          <button
            onClick={apply}
            disabled={staged === 0}
            className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-[3px] text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save size={11} />
            {staged > 0 ? t("db.applyN", { n: String(staged) }) : t("db.apply")}
          </button>
        </div>
      </div>

      {/* The warning that matters: without a primary key, an edit is matched by every column. */}
      {tab.result && tab.columns.length > 0 && !identified && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-warning)]/[0.08] px-2 py-1 text-[11px] text-[var(--cf-text)]">
          <AlertTriangle size={12} className="mt-[1px] shrink-0 text-[var(--cf-warning)]" />
          {t("db.noPrimaryKeyWarning")}
        </p>
      )}

      {/* Grid. Isolated so the selection bar below floats over the grid and nothing else. */}
      <div className="relative isolate min-h-0 flex-1">
        {tab.error ? (
          <div className="p-3">
            <p className="flex items-start gap-2 rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.06] p-2 font-mono text-[12px] text-[var(--cf-danger)]">
              <AlertTriangle size={13} className="mt-[2px] shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{tab.error}</span>
            </p>
          </div>
        ) : tab.result ? (
          // The same props either way: the two are one dataset seen along different axes, and
          // anything that behaved differently between them would be a bug rather than a feature.
          (() => {
            const shared = {
              columns: tab.result.columns,
              rows: tab.result.rows,
              displayValue: (row: number, column: string) => displayCell(tab, row, column),
              onEdit: ({ row, column, value }: { row: number; column: string; value: string | null }) =>
                store.setCell(tab.id, row, column, value),
              changed,
              deletedRows: deleted,
              insertedRows: tab.inserted,
              onEditInserted: ({
                row,
                column,
                value,
              }: {
                row: number;
                column: string;
                value: string | null;
              }) => store.setInsertedCell(tab.id, row, column, value),
              onRemoveInserted: (row: number) => store.removeInsertedRow(tab.id, row),
              onRowContextMenu: (row: number, event: React.MouseEvent) => {
                // Right-clicking outside the selection moves it, so the menu that opens is about
                // the row under the pointer and not about rows somewhere else on screen.
                if (!selected.has(row)) selectRow(row, { range: false, toggle: false });
                setMenu({ x: event.clientX, y: event.clientY, kind: "row", row });
              },
              selectedRows: selected,
              onSelectRow: selectRow,
              onSelectRange: selectRange,
              onSelectAllRows: selectAll,
              primaryKeys,
              foreignKeys,
              onFollowForeignKey: (key: DbForeignKey, value: string | null) =>
                store.followForeignKey(tab, key, value),
            };
            return layout === "record" ? (
              <RecordGrid {...shared} />
            ) : (
              // Sorting is the grid's alone: it is a click on a column header, and in the record
              // view a column header is a record.
              <ResultGrid {...shared} onSort={cycleSort} sort={tab.sort} />
            );
          })()
        ) : null}

        {/* What the selection can do, only while there is one — and floating over the grid rather
            than stacked above it. In the flow it pushed the whole grid down the instant a selection
            appeared, which during a press-and-drag means the rows move out from under the pointer
            on the very first one. A bar that is always there would cost a row of screen to say
            "nothing is selected". */}
        {selectedRows.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-2">
            <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1 shadow-[var(--cf-shadow)]">
              <span className="text-[11px] font-medium text-[var(--cf-text)]">
                {t("db.rowsSelectedN", { n: String(selectedRows.length) })}
              </span>
              <ToolbarButton
                onClick={() => openRecords(selectedRows)}
                title={t("db.viewRecordsSelected")}
              >
                <Rows3 size={12} />
              </ToolbarButton>
              <ToolbarButton
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.left, y: rect.top - 4, kind: "export", rows: selectedRows });
                }}
                title={t("db.exportSelectedN", { n: String(selectedRows.length) })}
              >
                <Download size={12} />
              </ToolbarButton>
              <ToolbarButton onClick={deleteSelected} title={t("db.deleteSelectedHint")}>
                <Trash2 size={12} className="text-[var(--cf-danger)]" />
              </ToolbarButton>
              <button
                type="button"
                onClick={() => selectAll(false)}
                className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={11} />
                {t("db.clearSelection")}
              </button>
            </div>
          </div>
        )}

        {tab.loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[var(--cf-surface)]/70 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("db.loading")}
          </div>
        )}
      </div>

      {/* Pager.
          One line that never wraps: every part of it is two or three characters, and the moment one
          of them folds onto a second line ("1 /" over "1") the bar stops reading as a control and
          starts reading as broken. So each piece is `whitespace-nowrap`, and the bar scrolls
          sideways in a panel too narrow for all of it rather than reflowing. */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">
        <ToolbarButton
          onClick={() => {
            store.updateData(tab.id, { offset: Math.max(0, tab.offset - tab.limit) });
            void store.loadData(tab.id);
          }}
          disabled={tab.offset === 0 || tab.loading}
          title={t("db.previousPage")}
        >
          <ChevronLeft size={13} />
        </ToolbarButton>
        <span className="shrink-0 whitespace-nowrap tabular-nums">
          {lastPage === null ? t("db.pageN", { n: String(page) }) : `${page} / ${lastPage}`}
        </span>
        <ToolbarButton
          onClick={() => {
            store.updateData(tab.id, { offset: tab.offset + tab.limit });
            void store.loadData(tab.id);
          }}
          // Enabled on a full page even when the total isn't known yet: the count is a separate,
          // slower query and paging shouldn't wait for it.
          disabled={
            tab.loading ||
            (tab.result !== null && tab.result.rows.length < tab.limit) ||
            (lastPage !== null && page >= lastPage)
          }
          title={t("db.nextPage")}
        >
          <ChevronRight size={13} />
        </ToolbarButton>

        {/* The page size, as a number you click — not a dropdown wide enough to hold a sentence.
            The choice is between five numbers and the current one is two or three digits, so the
            control is sized for a number and the list opens where it stands. */}
        <button
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4, kind: "pageSize" });
          }}
          title={t("db.perPage", { n: formatCount(tab.limit) })}
          className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded border border-[var(--cf-border)] px-1.5 py-[1px] tabular-nums text-[var(--cf-text)] hover:border-[var(--cf-accent)]"
        >
          {formatCount(tab.limit)}
          <ChevronDown size={11} className="text-[var(--cf-text-muted)]" />
        </button>

        <span className="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--cf-border)]" />

        {/* The filter sits down here rather than in the toolbar above. It belongs with the pager:
            both narrow the same result set, and a predicate typed above the grid competed for the
            eye with the connection and table it was already showing. It also costs no height here —
            the pager's middle was empty — and it is the one control on this bar that should take
            whatever width is left over, so it grows while everything else stays its own size. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Applied on submit, not per keystroke: a half-written predicate would otherwise run —
            // and fail — on every character.
            store.updateData(tab.id, { filter: tab.filterDraft, offset: 0 });
            void store.loadData(tab.id);
          }}
          className="flex min-w-[140px] flex-1 items-center gap-1"
        >
          <span className="shrink-0 text-[10px] uppercase tracking-wide">
            {engine?.sql ? "WHERE" : t("db.filter")}
          </span>
          <input
            ref={filterRef}
            value={tab.filterDraft}
            onChange={(e) => store.updateData(tab.id, { filterDraft: e.target.value })}
            placeholder={engine?.sql ? t("db.wherePlaceholder") : t("db.filterPlaceholder")}
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-[2px] font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:font-sans focus:border-[var(--cf-accent)]"
          />
        </form>

        <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap tabular-nums">
          {tab.result && <span>{formatDuration(tab.result.duration_ms)}</span>}
          <span>
            {tab.total === null
              ? t("db.rowsN", { n: formatCount(tab.result?.rows.length ?? 0) })
              : t("db.rowsOfTotal", {
                  n: formatCount(tab.result?.rows.length ?? 0),
                  total: formatCount(tab.total),
                })}
          </span>
        </span>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={menu.kind === "pageSize" ? t("db.rowsPerPage") : undefined}
          items={
            menu.kind === "row"
              ? rowMenu(menu.row, menu.x, menu.y)
              : menu.kind === "export"
                ? exportItems(menu.rows)
                : PAGE_SIZES.map((size) => ({
                    label: t("db.perPage", { n: formatCount(size) }),
                    onClick: () => {
                      store.updateData(tab.id, { limit: size, offset: 0 });
                      void store.loadData(tab.id);
                    },
                  }))
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** A one-line description of a staged edit, for the confirmation sheet. The real SQL comes back from
 * the backend after it runs — generating it twice, here and there, is how the two drift apart. */
function describeEdit(kind: string, values: number, keys: number): string {
  if (kind === "insert") return `INSERT — ${values} column(s)`;
  if (kind === "delete") return `DELETE — matched on ${keys} column(s)`;
  return `UPDATE — ${values} column(s), matched on ${keys}`;
}
