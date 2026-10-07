import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eraser, Pencil, Plus, Table2, Trash2, Upload, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Button, iconButtonClass } from "../common/Button";
import { DataGrid, autoFitWidths, type GridColumn } from "../common/DataGrid";
import { fieldClass, toolbarClass } from "../common/recipes";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { parseCsvGrid, toCsv } from "../../lib/csv";
import { readFileText, writeFileText } from "../../lib/tauri/commands";
import {
  flowsTableClear,
  flowsTableCreate,
  flowsTableDelete,
  flowsTableDeleteRows,
  flowsTableImport,
  flowsTablePutRow,
  flowsTableRename,
  flowsTableRows,
  flowsTablesList,
  type FlowTable,
  type FlowTableRow,
} from "../../lib/tauri/flowsCommands";

/** Rows read a page at a time; the grid windows them. */
const PAGE = 500;

/** A flow writing in a loop changes its table many times a second: read again at most this often. */
const RELOAD_EVERY_MS = 250;

const cellText = (value: unknown): string | null =>
  value === undefined ? null : value === null ? "null" : typeof value === "string" ? value : JSON.stringify(value);

/** A path split into the folder and the name `readFileText` / `writeFileText` take. */
function splitPath(path: string): [string, string] {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at < 0 ? [".", path] : [path.slice(0, at) || "/", path.slice(at + 1)];
}

/**
 * «Tablas»: the workspace's own tables, the ones «Tabla de datos» writes — a list beside a grid, to
 * look at what the flows remember and to fix it by hand. Rows are JSON objects under a key; the
 * columns are the fields in the order they were first written.
 */
export function TablesView() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [tables, setTables] = useState<FlowTable[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<FlowTableRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ key: string; text: string; previous: string | null } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});

  const loadTables = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const list = await flowsTablesList(workspaceId);
      setTables(list);
      setSelectedId((current) => (current && list.some((table) => table.id === current) ? current : (list[0]?.id ?? null)));
    } catch (error) {
      pushErrorToast(String(error));
    }
  }, [workspaceId]);

  const table = tables.find((candidate) => candidate.id === selectedId) ?? null;

  const loadRows = useCallback(
    async (more = false) => {
      if (!selectedId) {
        setRows([]);
        setTotal(0);
        return;
      }
      try {
        const page = await flowsTableRows(selectedId, more ? rows.length : 0, PAGE, search.trim() || null);
        setRows((current) => (more ? [...current, ...page.rows] : page.rows));
        setTotal(page.total);
        setTables((list) => list.map((candidate) => (candidate.id === page.table.id ? page.table : candidate)));
        if (!more) setPicked(new Set());
      } catch (error) {
        pushErrorToast(String(error));
      }
    },
    [selectedId, search, rows.length],
  );

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  // The listener below lives as long as the view; it reads what is on screen now through this ref —
  // a loader it had kept from when the table was picked would reload without the search typed since,
  // and the grid would no longer match the box.
  const latest = useRef({ workspaceId, selectedId, loadRows, loadTables });
  latest.current = { workspaceId, selectedId, loadRows, loadTables };

  // A table changed by a running flow is read again — at most every `RELOAD_EVERY_MS` while it writes,
  // not once per write.
  useEffect(() => {
    let rowsDue: number | null = null;
    let tablesDue: number | null = null;
    const stop = listen<{ workspaceId: string; tableId: string }>("flows:tables-changed", ({ payload }) => {
      const now = latest.current;
      if (payload.workspaceId !== now.workspaceId) return;
      if (payload.tableId === now.selectedId) {
        rowsDue ??= window.setTimeout(() => {
          rowsDue = null;
          void latest.current.loadRows();
        }, RELOAD_EVERY_MS);
      } else {
        tablesDue ??= window.setTimeout(() => {
          tablesDue = null;
          void latest.current.loadTables();
        }, RELOAD_EVERY_MS);
      }
    });
    return () => {
      if (rowsDue !== null) window.clearTimeout(rowsDue);
      if (tablesDue !== null) window.clearTimeout(tablesDue);
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void loadRows(), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, search]);

  const columns = useMemo<GridColumn<FlowTableRow>[]>(() => {
    const keyColumn: GridColumn<FlowTableRow> = { key: "\u0000key", label: t("flows.tables.key"), text: (row) => row.key, mono: true };
    const fields = (table?.columns ?? []).map<GridColumn<FlowTableRow>>((name) => ({
      key: name,
      label: name,
      text: (row) => cellText(row.data[name]),
      cellClass: (row) => (row.data[name] === undefined ? "italic text-[var(--cf-text-faint)]" : ""),
    }));
    const updated: GridColumn<FlowTableRow> = { key: "\u0000updated", label: t("flows.tables.updated"), text: (row) => row.updatedAt.replace("T", " ").slice(0, 19), mono: true };
    return [keyColumn, ...fields, updated];
  }, [table?.columns, t]);

  useEffect(() => {
    const missing = columns.filter((column) => widths[column.key] === undefined);
    if (missing.length > 0 && rows.length > 0) setWidths((current) => ({ ...autoFitWidths(missing, rows), ...current }));
  }, [columns, rows, widths]);

  const create = async () => {
    if (!workspaceId) return;
    const name = await promptAction(t("flows.table.newPrompt"), { placeholder: t("flows.table.newPlaceholder"), confirmLabel: t("flows.table.create") });
    if (!name) return;
    try {
      const made = await flowsTableCreate(workspaceId, name);
      await loadTables();
      setSelectedId(made.id);
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const rename = async (target: FlowTable) => {
    const name = await promptAction(t("flows.tables.renamePrompt"), { initial: target.name, confirmLabel: t("flows.tables.rename") });
    if (!name || name === target.name) return;
    try {
      await flowsTableRename(target.id, name);
      await loadTables();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const remove = async (target: FlowTable) => {
    const ok = await confirmAction(t("flows.tables.deleteConfirm", { name: target.name, count: target.rows }), true, t("flows.tables.delete"));
    if (!ok) return;
    try {
      await flowsTableDelete(target.id);
      await loadTables();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const clear = async () => {
    if (!table) return;
    const ok = await confirmAction(t("flows.tables.clearConfirm", { name: table.name, count: table.rows }), true, t("flows.tables.clear"));
    if (!ok) return;
    await flowsTableClear(table.id).catch((error) => pushErrorToast(String(error)));
    void loadRows();
  };

  const removePicked = async () => {
    if (!table || picked.size === 0) return;
    const keys = [...picked].map((index) => rows[index]?.key).filter((key): key is string => !!key);
    await flowsTableDeleteRows(table.id, keys).catch((error) => pushErrorToast(String(error)));
    void loadRows();
  };

  const saveRow = async () => {
    if (!table || !editing) return;
    let data: unknown;
    try {
      data = JSON.parse(editing.text);
    } catch {
      pushErrorToast(t("flows.tables.notJson"));
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      pushErrorToast(t("flows.tables.notObject"));
      return;
    }
    if (!editing.key.trim()) {
      pushErrorToast(t("flows.tables.keyNeeded"));
      return;
    }
    try {
      await flowsTablePutRow(table.id, editing.key.trim(), data as Record<string, unknown>, editing.previous);
      setEditing(null);
      void loadRows();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const importFile = async () => {
    if (!table) return;
    const chosen = await openDialog({ multiple: false, filters: [{ name: "CSV / JSON", extensions: ["csv", "json"] }] });
    if (typeof chosen !== "string") return;
    try {
      const [folder, name] = splitPath(chosen);
      const text = await readFileText(folder, name);
      let records: Record<string, unknown>[];
      if (name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text) as unknown;
        records = (Array.isArray(parsed) ? parsed : [parsed]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
      } else {
        const [header = [], ...body] = parseCsvGrid(text);
        records = body.filter((cells) => cells.some((cell) => cell.trim() !== "")).map((cells) => Object.fromEntries(header.map((column, i) => [column, cells[i] ?? ""])));
      }
      const keyField = await promptAction(t("flows.tables.importKeyPrompt", { count: records.length }), { placeholder: "id", allowEmpty: true, confirmLabel: t("flows.tables.import") });
      if (keyField === null) return;
      const written = await flowsTableImport(table.id, records, keyField.trim() || null);
      pushSuccessToast(t("flows.tables.imported", { count: written }));
      void loadRows();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const exportFile = async () => {
    if (!table) return;
    const target = await saveDialog({ defaultPath: `${table.name}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }, { name: "JSON", extensions: ["json"] }] });
    if (!target) return;
    try {
      // Every row, not only the page on screen.
      const all: FlowTableRow[] = [];
      for (let offset = 0; ; offset += 5000) {
        const page = await flowsTableRows(table.id, offset, 5000, null);
        all.push(...page.rows);
        if (page.rows.length < 5000) break;
      }
      const content = target.toLowerCase().endsWith(".json")
        ? JSON.stringify(all.map((row) => ({ _key: row.key, ...row.data })), null, 2)
        : toCsv(["_key", ...table.columns], all.map((row) => [row.key, ...table.columns.map((column) => cellText(row.data[column]))]));
      const [folder, name] = splitPath(target);
      await writeFileText(folder, name, content);
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[220px] shrink-0 flex-col border-r border-[var(--cf-border)]">
        <div className="flex h-10 shrink-0 items-center gap-1 px-2.5">
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-muted)]">{t("flows.tables.title")}</span>
          <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.table.newHint")} aria-label={t("flows.table.new")} onClick={() => void create()}>
            <Plus size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {tables.map((candidate) => (
            <div
              key={candidate.id}
              className={`group flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] ${
                candidate.id === selectedId ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
              }`}
            >
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setSelectedId(candidate.id)}>
                <Table2 size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">{candidate.rows}</span>
              </button>
              <button type="button" className={iconButtonClass({ size: "xs", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })} title={t("flows.tables.rename")} aria-label={t("flows.tables.rename")} onClick={() => void rename(candidate)}>
                <Pencil size={11} />
              </button>
              <button type="button" className={iconButtonClass({ size: "xs", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })} title={t("flows.tables.delete")} aria-label={t("flows.tables.delete")} onClick={() => void remove(candidate)}>
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {table && (
          <>
            <div className={toolbarClass}>
              <input
                className={fieldClass({ size: "sm", className: "w-[220px]" })}
                value={search}
                placeholder={t("flows.tables.search")}
                aria-label={t("flows.tables.search")}
                onChange={(event) => setSearch(event.target.value)}
              />
              <span className="text-[11.5px] tabular-nums text-[var(--cf-text-faint)]">{t("flows.tables.count", { shown: rows.length, total })}</span>
              <span className="flex-1" />
              {picked.size > 0 && (
                <Button size="sm" variant="ghost" onClick={() => void removePicked()}>
                  <Trash2 size={13} />
                  {t("flows.tables.deleteRows", { count: picked.size })}
                </Button>
              )}
              <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.tables.addRow")} aria-label={t("flows.tables.addRow")} onClick={() => setEditing({ key: "", text: "{\n  \n}", previous: null })}>
                <Plus size={14} />
              </button>
              <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.tables.import")} aria-label={t("flows.tables.import")} onClick={() => void importFile()}>
                <Upload size={14} />
              </button>
              <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.tables.export")} aria-label={t("flows.tables.export")} onClick={() => void exportFile()}>
                <Download size={14} />
              </button>
              <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.tables.clear")} aria-label={t("flows.tables.clear")} onClick={() => void clear()}>
                <Eraser size={14} />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              <DataGrid
                resetKey={`${table.id}|${search}`}
                columns={columns}
                rows={rows}
                widths={widths}
                onWidth={(key, width) => setWidths((current) => ({ ...current, [key]: width }))}
                onAutoFit={(key) => {
                  const column = columns.find((c) => c.key === key);
                  if (column) setWidths((current) => ({ ...current, ...autoFitWidths([column], rows) }));
                }}
                sort={null}
                onSort={() => {}}
                selected={picked}
                onSelectRow={(index, { toggle }) =>
                  setPicked((current) => {
                    const next = new Set(toggle ? current : []);
                    if (next.has(index) && toggle) next.delete(index);
                    else next.add(index);
                    return next;
                  })
                }
                onSelectRange={(from, to, additive) =>
                  setPicked((current) => {
                    const next = new Set(additive ? current : []);
                    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(i);
                    return next;
                  })
                }
                onSelectAll={(all) => setPicked(all ? new Set(rows.map((_, index) => index)) : new Set())}
                onOpenRow={(index) => {
                  const row = rows[index];
                  if (row) setEditing({ key: row.key, text: JSON.stringify(row.data, null, 2), previous: row.key });
                }}
              />
            </div>
            {rows.length < total && (
              <div className="flex h-9 shrink-0 items-center justify-center border-t border-[var(--cf-border)]">
                <Button size="sm" variant="ghost" onClick={() => void loadRows(true)}>
                  {t("flows.tables.more")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
          <div className="flex w-[min(560px,calc(100%-32px))] flex-col gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[13px] font-semibold">{editing.previous === null ? t("flows.tables.addRow") : t("flows.tables.editRow")}</span>
              <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("flows.tables.cancel")} onClick={() => setEditing(null)}>
                <X size={14} />
              </button>
            </div>
            <input
              className={fieldClass({ size: "sm", className: "font-mono" })}
              value={editing.key}
              placeholder={t("flows.tables.key")}
              aria-label={t("flows.tables.key")}
              onChange={(event) => setEditing({ ...editing, key: event.target.value })}
            />
            <textarea
              className={fieldClass({ className: "h-[260px] resize-y py-2 font-mono text-[12px] leading-[1.5]" })}
              value={editing.text}
              spellCheck={false}
              aria-label={t("flows.tables.rowJson")}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void saveRow();
              }}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                {t("flows.tables.cancel")}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void saveRow()}>
                {t("flows.tables.save")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
