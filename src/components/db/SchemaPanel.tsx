import { useMemo } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  FileCode2,
  Loader2,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-react";
import { nodeIcon } from "./dbChrome";
import { useDbStore, type DbSchemaSortKey as SortKey, type DbSchemaTab } from "../../state/dbStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { DbNodeKind, DbObjectInfo } from "../../types/database";

/**
 * A whole schema, listed.
 *
 * The tree answers "what is in here" one name at a time; this answers the question you actually have
 * when you are *comparing* rather than opening — which of these is a table and which a view, when
 * were they last altered, which one is the big one, what did somebody write about it. That is a grid,
 * not a tree, and it is why this panel exists.
 *
 * **Only the categories the engine returned are shown.** A fixed rail of ten headings would promise
 * Postgres a "Synonyms" section it has never had and Mongo a "Sequences" one that means nothing —
 * so the rail is built from what came back, and a column whose engine will not answer it (dates on
 * Postgres, sizes on IRIS) is dropped rather than filled with zeros.
 */

/** The categories, in the order the rail lists them. `kind` matches `DbNodeKind` so the rows can
 * reuse the tree's own icons and stay recognisable between the two views. */
const CATEGORIES: { kind: DbNodeKind; labelKey: TranslationKey }[] = [
  { kind: "table", labelKey: "db.catTables" },
  { kind: "view", labelKey: "db.catViews" },
  { kind: "collection", labelKey: "db.catCollections" },
  { kind: "routine", labelKey: "db.catRoutines" },
  { kind: "sequence", labelKey: "db.catSequences" },
];

/** Bytes as something readable. Deliberately the same 1024 steps the explorer's own size text uses,
 * so a number does not change meaning between the tree and this grid. */
function formatBytes(value: number | null): string {
  // `Number.isFinite` rather than a `null` check alone: the empty cell is the panel's answer for
  // "this engine will not say", and anything that isn't a usable number means exactly that. A
  // missing field used to fall through to `undefined / 1024` and print `NaN KB`, which reads as a
  // size the engine reported and got wrong.
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatCount(value: number | null): string {
  return typeof value === "number" ? value.toLocaleString() : "";
}

function SortHeader({
  label,
  column,
  sort,
  numeric,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; desc: boolean };
  numeric?: boolean;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === column;
  return (
    <th
      onClick={() => onSort(column)}
      className={`cursor-pointer select-none border-b border-[var(--cf-border)] px-2.5 py-1.5 font-medium ${
        numeric ? "text-right" : "text-left"
      } ${active ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"} hover:text-[var(--cf-text)]`}
    >
      <span className={`inline-flex items-center gap-1 ${numeric ? "flex-row-reverse" : ""}`}>
        {label}
        {active &&
          (sort.desc ? <ArrowDown size={10} className="shrink-0" /> : <ArrowUp size={10} className="shrink-0" />)}
      </span>
    </th>
  );
}

export function SchemaPanel({ tab }: { tab: DbSchemaTab }) {
  const t = useT();
  const loadSchema = useDbStore((s) => s.loadSchema);
  const openData = useDbStore((s) => s.openData);
  const openDdl = useDbStore((s) => s.openDdl);
  /**
   * The rail selection, the filter box and the sort — on the tab record rather than in a
   * `useState` here.
   *
   * `DatabaseView` renders one `SchemaPanel` for every schema tab, so held locally these were one
   * set of controls shared by all of them: sorting one schema by size sorted the next one too, and
   * a search typed in one listing was still in the box when a different schema opened.
   */
  const { category, query, sort } = tab.ui;
  const setUi = useDbStore((s) => s.setSchemaUi);

  const objects = tab.objects ?? [];

  /** Only the categories this engine actually returned, with their counts. */
  const rail = useMemo(
    () =>
      CATEGORIES.map((entry) => ({
        ...entry,
        count: objects.filter((object) => object.kind === entry.kind).length,
      })).filter((entry) => entry.count > 0),
    [objects],
  );

  // The first category with anything in it, until the user picks another. Kept out of an effect so
  // a reload that changes the counts doesn't yank the selection out from under them.
  const selected = category && rail.some((entry) => entry.kind === category) ? category : rail[0]?.kind ?? null;

  /**
   * Which columns are worth a heading.
   *
   * An engine that never answers a column would otherwise get a header with nothing under it for
   * every row — which reads as missing data rather than as "this engine does not record that".
   */
  const columns = useMemo(() => {
    const visible = objects.filter((object) => object.kind === selected);
    return {
      created: visible.some((object) => object.created_at),
      modified: visible.some((object) => object.modified_at),
      total: visible.some((object) => object.total_bytes !== null),
      used: visible.some((object) => object.used_bytes !== null),
      rows: visible.some((object) => object.rows !== null),
      comment: visible.some((object) => object.comment),
    };
  }, [objects, selected]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = objects.filter(
      (object) =>
        object.kind === selected &&
        (needle === "" ||
          object.name.toLowerCase().includes(needle) ||
          object.comment.toLowerCase().includes(needle)),
    );
    const direction = sort.desc ? -1 : 1;
    return [...list].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      // Nulls last whichever way it is sorted: "this engine won't say" is not a value that belongs
      // at either end of an ordering.
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
      return String(left).localeCompare(String(right), undefined, { numeric: true }) * direction;
    });
  }, [objects, selected, query, sort]);

  const toggleSort = (key: SortKey) =>
    setUi(tab.id, { sort: sort.key === key ? { key, desc: !sort.desc } : { key, desc: false } });

  /** A row's own actions — the same two the tree offers, so this view is a place to work from
   * rather than only a place to look. */
  const canOpenData = selected === "table" || selected === "view" || selected === "collection";
  const open = (object: DbObjectInfo) => {
    const ref = { kind: object.kind, database: tab.node.database, schema: tab.node.schema, name: object.name };
    if (canOpenData) openData(tab.connectionId, ref, object.name);
    else void openDdl(tab.connectionId, ref, object.name);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2.5 py-1.5">
        <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--cf-text)]">{tab.name}</span>
        <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
          {t("db.schemaObjectCount", { n: objects.length })}
        </span>
        <div className="relative ml-auto flex min-w-0 items-center">
          <Search size={11} className="pointer-events-none absolute left-2 text-[var(--cf-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setUi(tab.id, { query: e.target.value })}
            placeholder={t("db.schemaFilter")}
            className="w-40 rounded-md border border-[var(--cf-border)] bg-transparent py-1 pl-6 pr-6 text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
          {query && (
            <button
              onClick={() => setUi(tab.id, { query: "" })}
              className="absolute right-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          onClick={() => void loadSchema(tab.id)}
          disabled={tab.loading}
          title={t("db.refresh")}
          className="shrink-0 rounded-md p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] disabled:opacity-50 dark:hover:bg-white/[0.06]"
        >
          {tab.loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      {tab.error ? (
        <div className="flex min-h-0 flex-1 items-start gap-2 p-4 text-[12px] text-[var(--cf-danger)]">
          <AlertTriangle size={13} className="mt-[2px] shrink-0" />
          <div className="min-w-0">
            <p className="break-words">{tab.error}</p>
            <button
              onClick={() => void loadSchema(tab.id)}
              className="mt-1 text-[var(--cf-accent)] underline"
            >
              {t("db.retry")}
            </button>
          </div>
        </div>
      ) : tab.loading && tab.objects === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
          <Loader2 size={13} className="animate-spin" />
          {t("db.loading")}
        </div>
      ) : rail.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-[var(--cf-text-muted)]">
          {t("db.empty")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* The rail is what the engine returned, not a fixed list of headings — see the module
              comment. Counts sit on it because "which of these has anything in it" is the first
              thing anybody asks of a schema they don't know. */}
          <nav className="w-40 shrink-0 overflow-y-auto border-r border-[var(--cf-border)] py-1">
            {rail.map((entry) => {
              const Icon = nodeIcon(entry.kind);
              const active = entry.kind === selected;
              return (
                <button
                  key={entry.kind}
                  onClick={() => setUi(tab.id, { category: entry.kind })}
                  className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] ${
                    active
                      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                      : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <Icon size={12} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t(entry.labelKey)}</span>
                  <span className="shrink-0 text-[10.5px] tabular-nums opacity-70">{entry.count}</span>
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 z-10 bg-[var(--cf-surface-raised)]">
                <tr>
                  <SortHeader label={t("db.colName")} column="name" sort={sort} onSort={toggleSort} />
                  <SortHeader label={t("db.colType")} column="object_type" sort={sort} onSort={toggleSort} />
                  {columns.created && (
                    <SortHeader label={t("db.colCreated")} column="created_at" sort={sort} onSort={toggleSort} />
                  )}
                  {columns.modified && (
                    <SortHeader label={t("db.colModified")} column="modified_at" sort={sort} onSort={toggleSort} />
                  )}
                  {columns.rows && (
                    <SortHeader label={t("db.colRows")} column="rows" sort={sort} numeric onSort={toggleSort} />
                  )}
                  {columns.total && (
                    <SortHeader
                      label={t("db.colTotalBytes")}
                      column="total_bytes"
                      sort={sort}
                      numeric
                      onSort={toggleSort}
                    />
                  )}
                  {columns.used && (
                    <SortHeader
                      label={t("db.colUsedBytes")}
                      column="used_bytes"
                      sort={sort}
                      numeric
                      onSort={toggleSort}
                    />
                  )}
                  {columns.comment && (
                    <th className="border-b border-[var(--cf-border)] px-2.5 py-1.5 text-left font-medium text-[var(--cf-text-muted)]">
                      {t("db.colComment")}
                    </th>
                  )}
                  <th className="w-16 border-b border-[var(--cf-border)]" />
                </tr>
              </thead>
              <tbody>
                {shown.map((object) => {
                  const Icon = nodeIcon(object.kind);
                  return (
                    <tr
                      key={`${object.kind}:${object.name}`}
                      onDoubleClick={() => open(object)}
                      className="group cursor-default border-b border-[var(--cf-border)]/50 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    >
                      <td className="max-w-[24rem] truncate px-2.5 py-1 text-[var(--cf-text)]">
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <Icon size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                          <span className="truncate">{object.name}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-1 text-[var(--cf-text-muted)]">
                        {object.object_type}
                      </td>
                      {columns.created && (
                        <td className="whitespace-nowrap px-2.5 py-1 tabular-nums text-[var(--cf-text-muted)]">
                          {object.created_at ?? ""}
                        </td>
                      )}
                      {columns.modified && (
                        <td className="whitespace-nowrap px-2.5 py-1 tabular-nums text-[var(--cf-text-muted)]">
                          {object.modified_at ?? ""}
                        </td>
                      )}
                      {columns.rows && (
                        <td className="whitespace-nowrap px-2.5 py-1 text-right tabular-nums text-[var(--cf-text-muted)]">
                          {formatCount(object.rows)}
                        </td>
                      )}
                      {columns.total && (
                        <td className="whitespace-nowrap px-2.5 py-1 text-right tabular-nums text-[var(--cf-text-muted)]">
                          {formatBytes(object.total_bytes)}
                        </td>
                      )}
                      {columns.used && (
                        <td className="whitespace-nowrap px-2.5 py-1 text-right tabular-nums text-[var(--cf-text-muted)]">
                          {formatBytes(object.used_bytes)}
                        </td>
                      )}
                      {columns.comment && (
                        <td
                          title={object.comment}
                          className="max-w-[28rem] truncate px-2.5 py-1 text-[var(--cf-text-muted)]"
                        >
                          {object.comment}
                        </td>
                      )}
                      <td className="px-1.5 py-1">
                        <span className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          {canOpenData && (
                            <button
                              onClick={() => open(object)}
                              title={t("db.openData")}
                              className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.06] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                            >
                              <Table2 size={11} />
                            </button>
                          )}
                          <button
                            onClick={() =>
                              void openDdl(
                                tab.connectionId,
                                {
                                  kind: object.kind,
                                  database: tab.node.database,
                                  schema: tab.node.schema,
                                  name: object.name,
                                },
                                object.name,
                              )
                            }
                            title={t("db.showDdl")}
                            className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.06] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                          >
                            <FileCode2 size={11} />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-2.5 py-4 text-center text-[var(--cf-text-muted)]">
                      {t("db.noMatches")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
