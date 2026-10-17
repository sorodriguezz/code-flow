import { useEffect, useMemo, useState } from "react";
import { Dices, Loader2, RefreshCw, SquareTerminal } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { buttonClass } from "../common/Button";
import { Select } from "../common/Select";
import { dbChildren, dbExecute, dbForeignKeys } from "../../lib/tauri/dbCommands";
import {
  GENERATOR_KINDS,
  chooseGenerator,
  displayValue,
  fakeColumnsOf,
  generateRows,
  insertSql,
  insertedColumns,
  parentKeyOf,
  planProblems,
  planWarnings,
  quotingKind,
  sqlDialectOf,
  type ColumnPlan,
  type FakeColumn,
  type GeneratorKind,
  type ParentKeys,
  type SqlDialect,
} from "../../lib/db/fakeData";
import { quoteIdent } from "../../lib/db/sqlTemplates";
import type { TranslationKey } from "../../lib/i18n/translations";
import { parseSpec, useDbStore } from "../../state/dbStore";
import { sqlKindOf } from "../../state/driverStore";
import { useT } from "../../state/languageStore";
import { nodeRefOf, type DbExecContext, type DbNode } from "../../types/database";

const COUNTS = [10, 100, 1000];
const MAX_ROWS = 10_000;
const PREVIEW_ROWS = 5;
/** How many existing keys a foreign key samples its parent for. */
const PARENT_SAMPLE = 1000;

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

/** A string literal for the catalog probes below — names from the catalog, never typed input. */
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/**
 * Generating test rows for a table.
 *
 * Everything is read up front — the columns, the foreign keys, a sample of each parent's keys and
 * where an integer key's numbering stands — and from then on the rows are a pure function of the
 * plan and a seed (`lib/db/fakeData`). So the five rows previewed are the first five rows inserted,
 * and "Regenerar" is a new seed rather than another round trip.
 *
 * Nothing is written without being asked: "Abrir en consola" hands the script over to be read and
 * run there, and "Insertar" runs it on the app's own session — refused outright on a read-only
 * connection rather than left to the server to reject statement by statement.
 */
export function FakeDataModal({
  connectionId,
  node,
  onClose,
  onOpenInConsole,
}: {
  connectionId: string;
  /** The table, as the explorer lists it. */
  node: DbNode;
  onClose: () => void;
  onOpenInConsole: (sql: string) => void;
}) {
  const t = useT();
  const row = useDbStore((s) => s.connections.find((connection) => connection.id === connectionId));
  const kind = row ? sqlKindOf(row) : "postgres";
  const dialect: SqlDialect = sqlDialectOf(kind);
  const readOnly = row ? (parseSpec(row)?.read_only ?? false) : false;
  const ref = useMemo(() => nodeRefOf(node), [node]);
  const ctx: DbExecContext = useMemo(
    () => ({ database: node.database, schema: node.schema, max_rows: PARENT_SAMPLE }),
    [node.database, node.schema],
  );

  const [columns, setColumns] = useState<FakeColumn[] | null>(null);
  const [generators, setGenerators] = useState<Record<string, GeneratorKind>>({});
  const [starts, setStarts] = useState<Record<string, number>>({});
  const [parents, setParents] = useState<Record<string, ParentKeys>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [countChoice, setCountChoice] = useState("100");
  const [custom, setCustom] = useState("500");
  const [seed, setSeed] = useState(newSeed);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<{ inserted: number; errors: string[] } | null>(null);

  // The catalog, once: columns, keys, identity columns, parents' keys and the current maximum of
  // every integer key, so a generated key starts past what is already there.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const kq = quotingKind(dialect);
      const q = (name: string) => quoteIdent(name, kq);
      const qualified = (schema: string | null, table: string) => (schema ? `${q(schema)}.${q(table)}` : q(table));
      const read = async (sql: string) => {
        const result = await dbExecute(connectionId, sql, ctx, `dbfake-${newSeed().toString(36)}`);
        const first = result.results[0];
        if (!first || first.error) throw new Error(first?.error ?? "no result");
        return first.rows;
      };

      const [nodes, keys] = await Promise.all([
        dbChildren(connectionId, { ...ref, kind: "column_folder" }),
        dbForeignKeys(connectionId, ref).catch(() => []),
      ]);
      // Postgres keeps identity and generated columns out of the default expression, so the catalog
      // has to be asked separately. A failure only costs the hint, never the dialog.
      let identity: string[] = [];
      if (dialect === "postgres" && node.schema) {
        identity = await read(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = ${literal(node.schema)} ` +
            `AND table_name = ${literal(node.name)} AND (is_identity = 'YES' OR is_generated = 'ALWAYS')`,
        )
          .then((rows) => rows.map((r) => r[0] ?? ""))
          .catch(() => []);
      }
      const found = fakeColumnsOf(nodes, keys, dialect, identity);

      const byParent = new Map<string, { schema: string | null; table: string; columns: string[] }>();
      for (const column of found) {
        if (!column.ref) continue;
        const key = parentKeyOf(column.ref);
        const entry = byParent.get(key) ?? { schema: column.ref.schema, table: column.ref.table, columns: [] };
        if (!entry.columns.includes(column.ref.column)) entry.columns.push(column.ref.column);
        byParent.set(key, entry);
      }
      const sampled: Record<string, ParentKeys> = {};
      await Promise.all(
        [...byParent.entries()].map(async ([key, parent]) => {
          const list = parent.columns.map(q).join(", ");
          const rows = await read(`SELECT DISTINCT ${list} FROM ${qualified(parent.schema, parent.table)}`).catch(() => []);
          sampled[key] = { columns: parent.columns, rows };
        }),
      );

      const maxima: Record<string, number> = {};
      const table = qualified(node.schema, node.name);
      await Promise.all(
        found
          .filter((column) => column.primaryKey && !column.autoIncrement && chooseGenerator(column) === "sequence")
          .map(async (column) => {
            const rows = await read(`SELECT MAX(${q(column.name)}) FROM ${table}`).catch(() => []);
            const max = Number(rows[0]?.[0] ?? 0);
            maxima[column.name] = Number.isFinite(max) ? Math.floor(max) + 1 : 1;
          }),
      );

      if (cancelled) return;
      setColumns(found);
      setGenerators(Object.fromEntries(found.map((column) => [column.name, chooseGenerator(column)])));
      setParents(sampled);
      setStarts(maxima);
    };
    run().catch((e) => !cancelled && setLoadError(String(e instanceof Error ? e.message : e)));
    return () => {
      cancelled = true;
    };
  }, [connectionId, ref, ctx, dialect, node.schema, node.name]);

  const plans: ColumnPlan[] = useMemo(
    () =>
      (columns ?? []).map((column) => ({
        column,
        generator: generators[column.name] ?? "skip",
        start: starts[column.name] ?? 1,
      })),
    [columns, generators, starts],
  );

  const count = countChoice === "custom" ? Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(custom) || 0))) : Number(countChoice);
  const problems = planProblems(plans, parents);
  const warnings = planWarnings(plans, parents);
  // A NOT NULL column with no default that was left out: the server will refuse every row.
  const missing = plans
    .filter((plan) => plan.generator === "skip" && !plan.column.nullable && plan.column.default === null && !plan.column.autoIncrement)
    .map((plan) => plan.column.name);
  const used = insertedColumns(plans);
  const preview = useMemo(() => generateRows(plans, PREVIEW_ROWS, seed, parents), [plans, seed, parents]);
  const table = { schema: node.schema, name: node.name };
  const blocked = !columns || problems.length > 0;

  const script = () => insertSql(table, plans, generateRows(plans, count, seed, parents), dialect);

  const insert = async () => {
    if (readOnly || blocked) return;
    setRunning(true);
    setOutcome(null);
    try {
      const result = await dbExecute(connectionId, script(), { ...ctx, max_rows: 0 }, `dbfake-${newSeed().toString(36)}`);
      const inserted = result.results.reduce((sum, r) => sum + (r.error ? 0 : (r.rows_affected ?? 0)), 0);
      setOutcome({ inserted, errors: result.results.filter((r) => r.error).map((r) => r.error as string) });
    } catch (e) {
      setOutcome({ inserted: 0, errors: [String(e instanceof Error ? e.message : e)] });
    } finally {
      setRunning(false);
    }
  };

  const generatorOptions = (column: FakeColumn) =>
    GENERATOR_KINDS.filter((kind) => kind !== "fk" || column.ref).map((kind) => ({
      value: kind,
      label: t(`db.fake.gen.${kind}` as TranslationKey),
    }));

  return (
    <ApiModal
      icon={Dices}
      title={t("db.fake.title")}
      subtitle={node.schema ? `${node.schema}.${node.name}` : node.name}
      width="max-w-4xl"
      busy={running}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <div className="w-[130px]">
            <Select
              size="sm"
              value={countChoice}
              onChange={setCountChoice}
              options={[
                ...COUNTS.map((n) => ({ value: String(n), label: t("db.fake.rows", { n: n.toLocaleString() }) })),
                { value: "custom", label: t("db.fake.custom") },
              ]}
              ariaLabel={t("db.fake.count")}
            />
          </div>
          {countChoice === "custom" && (
            <input
              type="number"
              min={1}
              max={MAX_ROWS}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              title={t("db.fake.customHint", { max: MAX_ROWS.toLocaleString() })}
              className="w-[80px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2 py-1 text-[12px] text-[var(--cf-text)]"
            />
          )}
          <GhostButton onClick={() => setSeed(newSeed())} disabled={running || !columns}>
            <RefreshCw size={12} />
            {t("db.fake.regenerate")}
          </GhostButton>
          <span className="flex-1" />
          <GhostButton onClick={onClose} disabled={running}>
            {outcome ? t("db.importClose") : t("common.cancel")}
          </GhostButton>
          <GhostButton onClick={() => onOpenInConsole(script())} disabled={running || blocked || used.length === 0}>
            <SquareTerminal size={12} />
            {t("db.fake.openInConsole")}
          </GhostButton>
          <button
            onClick={() => void insert()}
            disabled={running || blocked || readOnly}
            title={readOnly ? t("db.fake.readOnly") : undefined}
            className={buttonClass({ variant: "primary" })}
          >
            {running && <Loader2 size={12} className="animate-spin" />}
            {running ? t("db.fake.inserting", { n: count.toLocaleString() }) : t("db.fake.insert", { n: count.toLocaleString() })}
          </button>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
        {loadError && <p className="whitespace-pre-wrap break-words text-[var(--cf-danger)]">{loadError}</p>}
        {!columns && !loadError && (
          <p className="flex items-center gap-2 text-[var(--cf-text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            {t("db.fake.loading")}
          </p>
        )}
        {readOnly && <p className="text-[var(--cf-text-muted)]">{t("db.fake.readOnly")}</p>}
        {problems.length > 0 && (
          <p className="text-[var(--cf-danger)]">{t("db.fake.emptyParent", { columns: problems.join(", ") })}</p>
        )}
        {warnings.length > 0 && (
          <p className="text-[var(--cf-warning)]">{t("db.fake.nullParent", { columns: warnings.join(", ") })}</p>
        )}
        {missing.length > 0 && (
          <p className="text-[var(--cf-warning)]">{t("db.fake.missingRequired", { columns: missing.join(", ") })}</p>
        )}
        {outcome && (
          <div className="space-y-1">
            <p className={outcome.errors.length ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}>
              {t("db.fake.done", { n: outcome.inserted.toLocaleString() })}
            </p>
            {outcome.errors.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[var(--cf-danger)]">
                {outcome.errors.map((error, index) => (
                  <li key={index} className="break-words">
                    {error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {columns && (
          <div className="overflow-x-auto rounded-md border border-[var(--cf-border)]">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] text-left text-[var(--cf-text-muted)]">
                  <th className="px-2 py-1.5 font-medium">{t("db.fake.column")}</th>
                  <th className="px-2 py-1.5 font-medium">{t("db.fake.type")}</th>
                  <th className="px-2 py-1.5 font-medium">{t("db.fake.generator")}</th>
                  <th className="px-2 py-1.5 font-medium">{t("db.fake.sample")}</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => {
                  const at = used.indexOf(plan);
                  const sample = at >= 0 ? displayValue(preview[0]?.[at] ?? { t: "null" }) : undefined;
                  const column = plan.column;
                  return (
                    <tr key={column.name} className="border-b border-[var(--cf-border)] last:border-b-0">
                      <td className="px-2 py-1 font-mono text-[var(--cf-text)]">
                        {column.name}
                        {column.primaryKey && <span className="ml-1 text-[10px] text-[var(--cf-text-faint)]">PK</span>}
                        {column.ref && (
                          <span className="ml-1 text-[10px] text-[var(--cf-text-faint)]" title={`${column.ref.table}.${column.ref.column}`}>
                            FK
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono text-[var(--cf-text-muted)]">
                        {column.type}
                        {!column.nullable && <span className="ml-1 text-[10px] text-[var(--cf-text-faint)]">NOT NULL</span>}
                      </td>
                      <td className="px-2 py-1">
                        <div className="w-[170px]">
                          <Select
                            size="sm"
                            value={plan.generator}
                            onChange={(value) => setGenerators((current) => ({ ...current, [column.name]: value as GeneratorKind }))}
                            options={generatorOptions(column)}
                            ariaLabel={t("db.fake.generatorFor", { column: column.name })}
                          />
                        </div>
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1 font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={sample ?? undefined}>
                        {sample === undefined ? (
                          <span className="italic text-[var(--cf-text-faint)]">{t("db.fake.byServer")}</span>
                        ) : sample === null ? (
                          <span className="italic opacity-60">NULL</span>
                        ) : (
                          sample
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {columns && used.length > 0 && (
          <>
            <p className="text-[var(--cf-text-muted)]">{t("db.fake.preview", { n: PREVIEW_ROWS })}</p>
            <div className="overflow-x-auto rounded-md border border-[var(--cf-border)]">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] text-left">
                    {used.map((plan) => (
                      <th key={plan.column.name} className="min-w-[100px] px-2 py-1.5 font-medium text-[var(--cf-text)]">
                        {plan.column.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((values, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-[var(--cf-border)] last:border-b-0">
                      {values.map((value, index) => {
                        const shown = displayValue(value);
                        return (
                          <td key={index} className="max-w-[200px] truncate px-2 py-1 font-mono text-[11.5px] text-[var(--cf-text)]" title={shown ?? "NULL"}>
                            {shown === null ? <span className="italic opacity-60">NULL</span> : shown}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </ApiModal>
  );
}
