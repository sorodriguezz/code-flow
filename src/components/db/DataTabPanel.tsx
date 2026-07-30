import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { Select } from "../common/Select";
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
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { EXPORT_EXTENSIONS, formatResult, type ExportFormat } from "../../lib/db/resultExport";
import { engineInfo, type DbForeignKey } from "../../types/database";

const PAGE_SIZES = [50, 100, 200, 500, 1000];

/**
 * One relation's rows, editable.
 *
 * The editing model is the whole design: **nothing is written until Apply.** Typing stages a change,
 * the changed cell is tinted, the pending count sits on the Apply button, and Apply sends the batch —
 * showing every statement it generated first. A grid that saved on blur would make an accidental
 * keystroke on a production table indistinguishable from an intentional edit.
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
  const [menu, setMenu] = useState<{ x: number; y: number; row: number | null } | null>(null);

  const engine = connection ? engineInfo(connection.kind) : null;
  const staged = pendingCount(tab);
  const identified = hasPrimaryKey(tab);

  // A restored tab has no rows yet — reopening the app deliberately doesn't fire a query per tab —
  // so the first look at one is what loads it.
  useEffect(() => {
    if (!tab.result && !tab.loading && !tab.error) void store.loadData(tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

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

  const page = Math.floor(tab.offset / tab.limit) + 1;
  const lastPage = tab.total === null ? null : Math.max(1, Math.ceil(tab.total / tab.limit));

  const rowMenu = (row: number): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: deleted.has(row) ? t("db.undoDelete") : t("db.deleteRow"),
        icon: Trash2,
        danger: !deleted.has(row),
        onClick: () => store.toggleDeleteRow(tab.id, row),
      },
      {
        label: t("db.copyRow"),
        icon: Copy,
        onClick: () => {
          const values = tab.result?.rows[row] ?? [];
          void navigator.clipboard.writeText(
            values.map((value) => (value === null ? "NULL" : value)).join("\t"),
          );
        },
      },
    ];
    return items;
  };

  const exportItems: MenuItem[] = (["csv", "tsv", "json", "sql", "markdown"] as ExportFormat[]).map(
    (format) => ({
      label: t("db.exportAs", { format: format.toUpperCase() }),
      icon: Download,
      onClick: async () => {
        if (!tab.result) return;
        const contents = formatResult(tab.result, format, nodeLabel(tab.node));
        const saved = await apiSaveFile(
          `${tab.node.name ?? "rows"}.${EXPORT_EXTENSIONS[format]}`,
          contents,
        ).catch(() => null);
        if (saved) useToastStore.getState().pushToast(t("db.exported", { path: saved }), "success");
      },
    }),
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        {connection && <EngineBadge kind={connection.kind} label={engine?.label ?? ""} />}
        <span className="max-w-[240px] truncate text-[12px] font-medium text-[var(--cf-text)]">
          {nodeLabel(tab.node)}
        </span>

        <span className="mx-0.5 h-4 w-px bg-[var(--cf-border)]" />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Applied on submit, not per keystroke: a half-written predicate would otherwise run —
            // and fail — on every character.
            store.updateData(tab.id, { filter: tab.filterDraft, offset: 0 });
            void store.loadData(tab.id);
          }}
          className="flex min-w-[180px] flex-1 items-center gap-1"
        >
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
            {engine?.sql ? "WHERE" : t("db.filter")}
          </span>
          <input
            value={tab.filterDraft}
            onChange={(e) => store.updateData(tab.id, { filterDraft: e.target.value })}
            placeholder={engine?.sql ? t("db.wherePlaceholder") : t("db.filterPlaceholder")}
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-[3px] font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:font-sans focus:border-[var(--cf-accent)]"
          />
        </form>

        <div className="flex items-center gap-1">
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
          <ToolbarButton
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 180, y: rect.bottom + 2, row: null });
            }}
            disabled={!tab.result || tab.result.rows.length === 0}
            title={t("db.export")}
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

      {/* Grid */}
      <div className="relative min-h-0 flex-1">
        {tab.error ? (
          <div className="p-3">
            <p className="flex items-start gap-2 rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.06] p-2 font-mono text-[12px] text-[var(--cf-danger)]">
              <AlertTriangle size={13} className="mt-[2px] shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{tab.error}</span>
            </p>
          </div>
        ) : tab.result ? (
          <ResultGrid
            columns={tab.result.columns}
            rows={tab.result.rows}
            displayValue={(row, column) => displayCell(tab, row, column)}
            onEdit={({ row, column, value }) => store.setCell(tab.id, row, column, value)}
            changed={changed}
            deletedRows={deleted}
            insertedRows={tab.inserted}
            onEditInserted={({ row, column, value }) =>
              store.setInsertedCell(tab.id, row, column, value)
            }
            onRemoveInserted={(row) => store.removeInsertedRow(tab.id, row)}
            onRowContextMenu={(row, event) =>
              setMenu({ x: event.clientX, y: event.clientY, row })
            }
            onSort={(column) => {
              const descending = tab.orderBy === column ? !tab.descending : false;
              store.updateData(tab.id, { orderBy: column, descending, offset: 0 });
              void store.loadData(tab.id);
            }}
            sortColumn={tab.orderBy}
            sortDescending={tab.descending}
            primaryKeys={primaryKeys}
            foreignKeys={foreignKeys}
            onFollowForeignKey={(key, value) => store.followForeignKey(tab, key, value)}
          />
        ) : null}

        {tab.loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[var(--cf-surface)]/70 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("db.loading")}
          </div>
        )}
      </div>

      {/* Pager */}
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">
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
        <span className="tabular-nums">
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

        <Select
          size="sm"
          className="w-[112px]"
          ariaLabel={t("db.perPage", { n: formatCount(tab.limit) })}
          value={String(tab.limit)}
          onChange={(value) => {
            store.updateData(tab.id, { limit: Number(value), offset: 0 });
            void store.loadData(tab.id);
          }}
          options={PAGE_SIZES.map((size) => ({
            value: String(size),
            label: t("db.perPage", { n: formatCount(size) }),
          }))}
        />

        <span className="ml-auto flex items-center gap-2 tabular-nums">
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
          items={menu.row === null ? exportItems : rowMenu(menu.row)}
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
