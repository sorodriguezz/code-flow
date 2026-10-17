import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Copy, GitCompareArrows, Loader2, SquareTerminal } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { dbChildren, dbSchemaCatalog, dbSchemaDiagram } from "../../lib/tauri/dbCommands";
import { sqlDialectOf } from "../../lib/db/fakeData";
import {
  describeChange,
  diffSchemas,
  isEmptyDiff,
  migrationSql,
  type ColumnWithDefault,
  type SchemaDiff,
} from "../../lib/db/schemaDiff";
import { useDbStore } from "../../state/dbStore";
import { sqlKindOf } from "../../state/driverStore";
import { useT } from "../../state/languageStore";
import { useToastStore } from "../../state/toastStore";
import {
  engineInfo,
  type DbNodeRef,
  type DbSchemaDiagram,
  type DbSchemaGroup,
} from "../../types/database";

export interface CompareSide {
  connectionId: string;
  database: string | null;
  schema: string | null;
}

/** Past this many tables in common, defaults are not read: it is one catalog call per table a side. */
const DEFAULTS_TABLE_LIMIT = 300;
/** Catalog calls in flight at once while reading defaults. */
const DEFAULTS_CONCURRENCY = 6;

const runId = () => `dbcompare-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** What `dbSchemaDiagram` is asked with for one side. MySQL's database *is* the schema. */
function diagramRef(side: CompareSide, databaseIsSchema: boolean): DbNodeRef {
  if (side.schema && !databaseIsSchema) {
    return { kind: "schema", database: side.database, schema: side.schema, name: side.schema };
  }
  const name = side.database ?? side.schema;
  return { kind: "database", database: side.database, schema: databaseIsSchema ? name : null, name };
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

/** Reads each table's column defaults into the diagram — the one thing the diagram doesn't carry. */
async function withDefaults(connectionId: string, diagram: DbSchemaDiagram, side: CompareSide, tables: Set<string>) {
  const copy: DbSchemaDiagram = { ...diagram, tables: diagram.tables.map((table) => ({ ...table })) };
  await inBatches(
    copy.tables.filter((table) => tables.has(table.name.toLowerCase())),
    DEFAULTS_CONCURRENCY,
    async (table) => {
      const nodes = await dbChildren(connectionId, {
        kind: "column_folder",
        database: side.database,
        schema: table.schema ?? side.schema,
        name: table.name,
      }).catch(() => null);
      if (!nodes) return;
      const defaults = new Map(nodes.map((node) => [node.name.toLowerCase(), node.column?.default_value ?? null]));
      table.columns = table.columns.map(
        (column): ColumnWithDefault => ({ ...column, default: defaults.get(column.name.toLowerCase()) ?? null }),
      );
    },
  );
  return copy;
}

/**
 * Comparing two schemas — on one connection or across two — and drafting the script that brings the
 * target in line with the source (`lib/db/schemaDiff`).
 *
 * The script is a draft for the target's console, never run from here: "Abrir en consola (destino)"
 * is the only way out of the dialog for it, and its `DROP`s arrive commented unless the box says
 * otherwise.
 */
export function SchemaCompareModal({
  initial,
  onClose,
  onOpenInConsole,
}: {
  initial: CompareSide;
  onClose: () => void;
  onOpenInConsole: (connectionId: string, database: string | null, sql: string) => void;
}) {
  const t = useT();
  const connections = useDbStore((s) => s.connections);
  const sqlConnections = useMemo(() => connections.filter((row) => engineInfo(row.kind).consoleLanguage === "sql"), [connections]);
  const [source, setSource] = useState<CompareSide>(initial);
  const [target, setTarget] = useState<CompareSide>(initial);
  const [catalogs, setCatalogs] = useState<Record<string, DbSchemaGroup[] | "loading" | string>>({});
  const [readDefaults, setReadDefaults] = useState(true);
  const [includeDrops, setIncludeDrops] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ diff: SchemaDiff; notes: string[]; defaultsSkipped: boolean } | null>(null);

  // Each connection's databases and schemas, read once when it is first picked.
  useEffect(() => {
    for (const id of new Set([source.connectionId, target.connectionId])) {
      if (!id || catalogs[id] !== undefined) continue;
      setCatalogs((current) => ({ ...current, [id]: "loading" }));
      dbSchemaCatalog(id)
        .then((groups) => setCatalogs((current) => ({ ...current, [id]: groups })))
        .catch((e) => setCatalogs((current) => ({ ...current, [id]: String(e) })));
    }
  }, [source.connectionId, target.connectionId, catalogs]);

  const rowOf = (id: string) => connections.find((row) => row.id === id);
  const targetRow = rowOf(target.connectionId);
  const dialect = sqlDialectOf(targetRow ? sqlKindOf(targetRow) : "postgres");
  const script = useMemo(() => (result ? migrationSql(result.diff, dialect, { includeDrops }) : ""), [result, dialect, includeDrops]);

  const compare = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const read = (side: CompareSide) => {
        const row = rowOf(side.connectionId);
        const ref = diagramRef(side, row ? engineInfo(row.kind).databaseIsSchema : false);
        return dbSchemaDiagram(side.connectionId, ref, runId());
      };
      let [a, b] = await Promise.all([read(source), read(target)]);
      const names = (diagram: DbSchemaDiagram) => new Set(diagram.tables.map((table) => table.name.toLowerCase()));
      const inA = names(a);
      const common = new Set([...names(b)].filter((name) => inA.has(name)));
      const defaultsSkipped = readDefaults && common.size > DEFAULTS_TABLE_LIMIT;
      if (readDefaults && !defaultsSkipped && common.size > 0) {
        [a, b] = await Promise.all([
          withDefaults(source.connectionId, a, source, common),
          withDefaults(target.connectionId, b, target, common),
        ]);
      }
      setResult({ diff: diffSchemas(a, b), notes: [...a.notes, ...b.notes], defaultsSkipped });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setRunning(false);
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(script);
    useToastStore.getState().pushToast(t("db.copied"), "success");
  };

  const sideLabel = (side: CompareSide) => {
    const row = rowOf(side.connectionId);
    return [row?.name, side.database, side.schema].filter(Boolean).join(" · ");
  };

  return (
    <ApiModal
      icon={GitCompareArrows}
      title={t("db.compare.title")}
      subtitle={result ? `${sideLabel(source)} → ${sideLabel(target)}` : undefined}
      width="max-w-5xl"
      busy={running}
      onClose={onClose}
      footer={
        <>
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]" title={t("db.compare.defaultsHint")}>
            <Checkbox checked={readDefaults} onChange={setReadDefaults} disabled={running} />
            {t("db.compare.defaults")}
          </label>
          <span className="flex-1" />
          <GhostButton onClick={onClose} disabled={running}>
            {t("db.importClose")}
          </GhostButton>
          <button
            onClick={() => void compare()}
            disabled={running || !source.connectionId || !target.connectionId}
            className={buttonClass({ variant: "primary" })}
          >
            {running && <Loader2 size={12} className="animate-spin" />}
            {running ? t("db.compare.running") : t("db.compare.run")}
          </button>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
        <div className="flex flex-wrap items-end gap-3">
          <SidePicker
            label={t("db.compare.source")}
            side={source}
            onChange={setSource}
            connections={sqlConnections}
            catalog={catalogs[source.connectionId]}
            disabled={running}
          />
          <ArrowRight size={14} className="mb-2 text-[var(--cf-text-faint)]" />
          <SidePicker
            label={t("db.compare.target")}
            side={target}
            onChange={setTarget}
            connections={sqlConnections}
            catalog={catalogs[target.connectionId]}
            disabled={running}
          />
        </div>

        {error && <p className="whitespace-pre-wrap break-words text-[var(--cf-danger)]">{error}</p>}
        {result?.defaultsSkipped && (
          <p className="text-[var(--cf-text-muted)]">{t("db.compare.defaultsSkipped", { n: DEFAULTS_TABLE_LIMIT })}</p>
        )}
        {result?.notes.map((note, index) => (
          <p key={index} className="text-[var(--cf-text-muted)]">
            {note}
          </p>
        ))}

        {result && <DiffList diff={result.diff} />}

        {result && !isEmptyDiff(result.diff) && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-[var(--cf-text)]">{t("db.compare.script")}</span>
              <label className="flex cursor-pointer items-center gap-2 text-[var(--cf-text-muted)]">
                <Checkbox checked={includeDrops} onChange={setIncludeDrops} />
                {t("db.compare.includeDrops")}
              </label>
              <span className="flex-1" />
              <GhostButton onClick={copy}>
                <Copy size={12} />
                {t("db.copy")}
              </GhostButton>
              <GhostButton onClick={() => onOpenInConsole(target.connectionId, target.database, script)}>
                <SquareTerminal size={12} />
                {t("db.compare.openInConsole")}
              </GhostButton>
            </div>
            <pre
              className="max-h-80 select-text overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[var(--cf-text)]"
              style={{ WebkitUserSelect: "text" }}
            >
              {script}
            </pre>
          </div>
        )}
      </div>
    </ApiModal>
  );
}

/** Connection, database and schema for one side. */
function SidePicker({
  label,
  side,
  onChange,
  connections,
  catalog,
  disabled,
}: {
  label: string;
  side: CompareSide;
  onChange: (side: CompareSide) => void;
  connections: { id: string; name: string }[];
  catalog: DbSchemaGroup[] | "loading" | string | undefined;
  disabled: boolean;
}) {
  const t = useT();
  const groups = Array.isArray(catalog) ? catalog : [];
  const group = groups.find((g) => g.database === side.database) ?? null;
  const schemas = group?.schemas ?? [];

  // A database or schema that isn't in the catalog just read (a different connection's, say) is
  // replaced by the first one that is.
  useEffect(() => {
    if (!Array.isArray(catalog) || catalog.length === 0) return;
    const db = catalog.find((g) => g.database === side.database) ?? catalog[0];
    const schema = db.schemas.length === 0 ? null : db.schemas.includes(side.schema ?? "") ? side.schema : db.schemas[0];
    if (db.database !== side.database || schema !== side.schema) onChange({ ...side, database: db.database, schema });
  }, [catalog, side, onChange]);

  return (
    <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</span>
      <Select
        size="sm"
        value={side.connectionId}
        disabled={disabled}
        onChange={(connectionId) => onChange({ connectionId, database: null, schema: null })}
        options={connections.map((row) => ({ value: row.id, label: row.name }))}
        ariaLabel={t("db.compare.connection")}
      />
      <div className="flex gap-1.5">
        <div className="min-w-0 flex-1">
          <Select
            size="sm"
            value={side.database ?? ""}
            loading={catalog === "loading"}
            disabled={disabled || groups.length === 0}
            onChange={(database) => {
              const next = groups.find((g) => g.database === database);
              onChange({ ...side, database, schema: next?.schemas[0] ?? null });
            }}
            options={groups.map((g) => ({ value: g.database, label: g.database }))}
            placeholder={t("db.compare.database")}
            ariaLabel={t("db.compare.database")}
          />
        </div>
        {schemas.length > 0 && (
          <div className="min-w-0 flex-1">
            <Select
              size="sm"
              value={side.schema ?? ""}
              disabled={disabled}
              onChange={(schema) => onChange({ ...side, schema })}
              options={schemas.map((schema) => ({ value: schema, label: schema }))}
              ariaLabel={t("db.compare.schema")}
            />
          </div>
        )}
      </div>
      {typeof catalog === "string" && catalog !== "loading" && (
        <span className="break-words text-[11px] text-[var(--cf-danger)]">{catalog}</span>
      )}
    </div>
  );
}

type BadgeTone = "added" | "removed" | "changed";

const TONE: Record<BadgeTone, string> = {
  added: "bg-[var(--cf-success-soft)] text-[var(--cf-success-text)]",
  removed: "bg-[var(--cf-danger-soft)] text-[var(--cf-danger-text)]",
  changed: "bg-[var(--cf-warning-soft)] text-[var(--cf-warning-text)]",
};

function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${TONE[tone]}`}>{children}</span>;
}

/** The differences, table by table: what the target is missing, what it has extra, what differs. */
function DiffList({ diff }: { diff: SchemaDiff }) {
  const t = useT();
  if (isEmptyDiff(diff)) {
    return <p className="text-[var(--cf-text-muted)]">{t("db.compare.identical", { n: diff.unchanged })}</p>;
  }
  const line = "flex items-center gap-2 px-3 py-1";
  return (
    <div className="space-y-1">
      <p className="text-[var(--cf-text-muted)]">
        {t("db.compare.summary", {
          added: diff.onlyInSource.length,
          removed: diff.onlyInTarget.length,
          changed: diff.changed.length,
          same: diff.unchanged,
        })}
      </p>
      <ul className="max-h-72 overflow-y-auto rounded-md border border-[var(--cf-border)] py-1">
        {diff.onlyInSource.map((table) => (
          <li key={`a-${table.name}`} className={line}>
            <Badge tone="added">{t("db.compare.tableAdded")}</Badge>
            <span className="font-mono text-[var(--cf-text)]">{table.name}</span>
            <span className="text-[var(--cf-text-faint)]">{t("db.compare.columns", { n: table.columns.length })}</span>
          </li>
        ))}
        {diff.onlyInTarget.map((table) => (
          <li key={`b-${table.name}`} className={line}>
            <Badge tone="removed">{t("db.compare.tableRemoved")}</Badge>
            <span className="font-mono text-[var(--cf-text)]">{table.name}</span>
          </li>
        ))}
        {diff.changed.map((table) => (
          <li key={`c-${table.name}`}>
            <div className={line}>
              <Badge tone="changed">{t("db.compare.tableChanged")}</Badge>
              <span className="font-mono text-[var(--cf-text)]">{table.name}</span>
            </div>
            <ul className="pb-1 pl-8">
              {table.added.map((column) => (
                <li key={`ca-${column.name}`} className="flex items-center gap-2 py-0.5">
                  <Badge tone="added">+</Badge>
                  <span className="font-mono">{column.name}</span>
                  <span className="font-mono text-[var(--cf-text-faint)]">{column.data_type}</span>
                </li>
              ))}
              {table.removed.map((column) => (
                <li key={`cr-${column.name}`} className="flex items-center gap-2 py-0.5">
                  <Badge tone="removed">−</Badge>
                  <span className="font-mono">{column.name}</span>
                  <span className="font-mono text-[var(--cf-text-faint)]">{column.data_type}</span>
                </li>
              ))}
              {table.changed.map((change) => (
                <li key={`cc-${change.name}`} className="flex items-center gap-2 py-0.5">
                  <Badge tone="changed">~</Badge>
                  <span className="font-mono">{change.name}</span>
                  <span className="font-mono text-[var(--cf-text-faint)]">{describeChange(change)}</span>
                </li>
              ))}
              {table.primaryKey && (
                <li className="flex items-center gap-2 py-0.5">
                  <Badge tone="changed">PK</Badge>
                  <span className="font-mono text-[var(--cf-text-faint)]">
                    ({table.primaryKey.target.join(", ")}) → ({table.primaryKey.source.join(", ")})
                  </span>
                </li>
              )}
              {table.fkAdded.map((fk) => (
                <li key={`fa-${fk.name}`} className="flex items-center gap-2 py-0.5">
                  <Badge tone="added">FK</Badge>
                  <span className="font-mono text-[var(--cf-text-faint)]">
                    ({fk.columns.join(", ")}) → {fk.refTable} ({fk.refColumns.join(", ")})
                  </span>
                </li>
              ))}
              {table.fkRemoved.map((fk) => (
                <li key={`fr-${fk.name}`} className="flex items-center gap-2 py-0.5">
                  <Badge tone="removed">FK</Badge>
                  <span className="font-mono text-[var(--cf-text-faint)]">
                    {fk.name}: ({fk.columns.join(", ")}) → {fk.refTable}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
