import { useCallback, useEffect, useState } from "react";
import { Database, Play, RefreshCw, Table2, Trash2 } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { CARD } from "./remoteChrome";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  remoteTableDeleteEntity,
  remoteTableQuery,
  remoteTableRemove,
  remoteTables,
} from "../../lib/tauri/remoteCommands";
import type { TablePage, TableSummary } from "../../types/remote";

/**
 * Azure Table storage: the account's tables down one side, an entity grid beside it.
 *
 * **The columns come from the data, because there is no schema.** Two entities in one table may
 * carry entirely different properties, so the grid's header is the union of what the current page
 * happens to contain — with `PartitionKey`, `RowKey` and `Timestamp` pinned first, since those three
 * are the only ones the service guarantees.
 *
 * **The filter box says what a filter costs.** A query on both keys is a point read; one on the
 * partition scans that partition; one on neither scans the table and is billed accordingly. The
 * service will run all three without comment, so the panel is where the difference is stated —
 * quietly, under the box, rather than as a warning nobody reads twice.
 */
export function TablePanel({ hostId }: { hostId: string }) {
  const t = useT();
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState<TablePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => pushErrorToast(String(e));

  const loadTables = useCallback(async () => {
    setLoading(true);
    try {
      const found = await remoteTables(hostId);
      setTables(found);
      setSelected((current) => (current && found.some((one) => one.name === current) ? current : found[0]?.name ?? ""));
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  /** Runs the query from the first page. `more` continues from where the last one stopped. */
  const run = useCallback(
    async (name: string, expression: string, more?: TablePage) => {
      if (!name) return setPage(null);
      setBusy(true);
      try {
        const next = await remoteTableQuery(
          hostId,
          name,
          expression,
          "",
          more?.next_partition_key ?? "",
          more?.next_row_key ?? "",
        );
        // Appending rather than replacing on a continuation: the point of "load more" is a longer
        // list, and a grid that jumped to page two would lose whatever the user was comparing.
        setPage((current) =>
          more && current
            ? {
                ...next,
                columns: [...new Set([...current.columns, ...next.columns])],
                rows: [...current.rows, ...next.rows],
              }
            : next,
        );
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    },
    [hostId],
  );

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  useEffect(() => {
    setFilter("");
    void run(selected, "");
  }, [selected, run]);

  const removeEntity = async (row: Record<string, unknown>) => {
    const partition = String(row.PartitionKey ?? "");
    const rowKey = String(row.RowKey ?? "");
    const ok = await confirmAction(t("remote.tableDeleteEntityConfirm", { key: `${partition}/${rowKey}` }));
    if (!ok) return;
    try {
      await remoteTableDeleteEntity(hostId, selected, partition, rowKey);
      setPage((current) =>
        current
          ? { ...current, rows: current.rows.filter((one) => one.PartitionKey !== row.PartitionKey || one.RowKey !== row.RowKey) }
          : current,
      );
    } catch (e) {
      fail(e);
    }
  };

  const deleteTable = async (name: string) => {
    const ok = await confirmAction(t("remote.tableDeleteConfirm", { name }), true, t("common.delete"));
    if (!ok) return;
    try {
      await remoteTableRemove(hostId, name);
      if (selected === name) setSelected("");
      void loadTables();
    } catch (e) {
      fail(e);
    }
  };

  /** Which of the three shapes this filter is, so the cost is stated rather than discovered. */
  const shape = (() => {
    const text = filter.toLowerCase();
    const hasPartition = text.includes("partitionkey");
    const hasRow = text.includes("rowkey");
    if (hasPartition && hasRow) return t("remote.tableFilterPoint");
    if (hasPartition) return t("remote.tableFilterPartition");
    return t("remote.tableFilterScan");
  })();

  return (
    <div className={`flex h-full min-h-0 ${CARD}`}>
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--cf-border)]">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
          <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("remote.tables")}
          </span>
          <IconButton icon={RefreshCw} label={t("remote.refresh")} onClick={() => void loadTables()} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("remote.loading")}</p>
          ) : tables.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("remote.tablesEmpty")}</p>
          ) : (
            tables.map((one) => (
              <button
                key={one.name}
                onClick={() => setSelected(one.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void deleteTable(one.name);
                }}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] ${
                  one.name === selected
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                <Table2 size={12} className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{one.name}</span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[var(--cf-border)] px-2 py-1.5">
          <div className="flex items-center gap-1">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run(selected, filter);
              }}
              placeholder="PartitionKey eq 'eu' and RowKey eq '42'"
              disabled={!selected}
              className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-40"
            />
            <button
              type="button"
              onClick={() => void run(selected, filter)}
              disabled={!selected || busy}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
            >
              <Play size={12} />
              {t("remote.tableRun")}
            </button>
          </div>
          {selected && (
            <p className="pt-1 text-[10px] text-[var(--cf-text-muted)]">{shape}</p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!selected ? (
            <EmptyState icon={Database} title={t("remote.tablePickOne")} subtitle={t("remote.tablePickOneHint")} />
          ) : !page || page.rows.length === 0 ? (
            <EmptyState icon={Database} title={t("remote.tableNoRows")} subtitle={t("remote.tableNoRowsHint")} />
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 bg-[var(--cf-surface)]">
                <tr>
                  {page.columns.map((column) => (
                    <th
                      key={column}
                      className="border-b border-[var(--cf-border)] px-2 py-1 text-left font-medium text-[var(--cf-text-muted)]"
                    >
                      {column}
                    </th>
                  ))}
                  <th className="border-b border-[var(--cf-border)] px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, at) => (
                  <tr key={`${row.PartitionKey}/${row.RowKey}/${at}`} className="group hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                    {page.columns.map((column) => (
                      <td
                        key={column}
                        className="max-w-[24rem] truncate border-b border-[var(--cf-border)] px-2 py-1 font-mono text-[var(--cf-text)]"
                        title={cell(row[column])}
                      >
                        {cell(row[column])}
                      </td>
                    ))}
                    <td className="border-b border-[var(--cf-border)] px-1 py-1">
                      <IconButton
                        icon={Trash2}
                        label={t("remote.tableDeleteEntity")}
                        onClick={() => void removeEntity(row)}
                        danger
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Both continuation tokens or neither — resuming from a partition without its row silently
            repeats rows, so the button only appears when the service gave us both. */}
        {page?.next_partition_key && page?.next_row_key && (
          <button
            type="button"
            onClick={() => void run(selected, filter, page)}
            disabled={busy}
            className="shrink-0 border-t border-[var(--cf-border)] py-1.5 text-[11px] text-[var(--cf-accent)] hover:bg-black/[0.03] disabled:opacity-40 dark:hover:bg-white/[0.04]"
          >
            {t("remote.tableMore")}
          </button>
        )}
      </div>
    </div>
  );
}

/** One cell. Objects and arrays are stringified rather than rendered — a Table property can hold a
 *  JSON blob, and a grid is not where it gets expanded. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Play;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08] ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}
