import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, FileCode2, Loader2, Plus, Table2, Trash2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { INPUT } from "./dbChrome";
import { parseSpec, useDbStore } from "../../state/dbStore";
import { confirmAction } from "../../state/confirmStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { dbChildren, dbExecute } from "../../lib/tauri/dbCommands";
import { sqlDialectOf } from "../../lib/db/fakeData";
import {
  alterSql,
  commonTypes,
  createSql,
  designProblems,
  type DesignColumn,
  type DesignIndex,
  type TableDesign,
} from "../../lib/db/tableDesign";
import type { TranslationKey } from "../../lib/i18n/translations";
import { engineInfo, type DbNodeRef } from "../../types/database";

const PROBLEM_KEYS: Record<ReturnType<typeof designProblems>[number], TranslationKey> = {
  noName: "db.design.problemNoName",
  noColumns: "db.design.problemNoColumns",
  emptyColumn: "db.design.problemEmptyColumn",
  duplicate: "db.design.problemDuplicate",
  noType: "db.design.problemNoType",
};

/**
 * A table as a form: its columns (name, type, nullability, default, key) and indexes, and the
 * `CREATE`/`ALTER` statements the changes come to, shown before anything runs.
 *
 * Opened on a table it edits that table; opened on a schema (or a database, where the database is
 * the schema) it designs a new one. The statements can be run here — as one batch, after the same
 * read-only and production checks a console applies — or taken to a console to adjust first.
 */
export function TableDesignerModal({
  connectionId,
  node,
  onClose,
}: {
  connectionId: string;
  node: DbNodeRef;
  onClose: () => void;
}) {
  const t = useT();
  const connection = useDbStore((s) => s.connections.find((c) => c.id === connectionId));
  const dialect = sqlDialectOf(connection?.kind ?? "postgres");
  const editing = node.kind === "table";
  // Where the table lives: the table's own schema, the schema right-clicked, or — on the engines
  // whose database *is* the schema — the database. A database on Postgres or SQL Server leaves it to
  // the session's default schema.
  const schema =
    node.kind === "table"
      ? node.schema
      : node.kind === "schema"
        ? node.name
        : engineInfo(connection?.kind ?? "postgres").databaseIsSchema
          ? node.database ?? node.name
          : null;
  const [original, setOriginal] = useState<TableDesign | null>(null);
  const [design, setDesign] = useState<TableDesign>({ name: editing ? node.name ?? "" : "", columns: [], indexes: [] });
  const [loading, setLoading] = useState(editing);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDesign({
        name: "",
        columns: [
          {
            id: crypto.randomUUID(),
            original: null,
            name: "id",
            type: commonTypes(dialect)[0],
            nullable: false,
            defaultValue: null,
            primaryKey: true,
          },
        ],
        indexes: [],
      });
      return;
    }
    let alive = true;
    void Promise.all([
      dbChildren(connectionId, { ...node, kind: "column_folder" }),
      dbChildren(connectionId, { ...node, kind: "index_folder" }).catch(() => []),
    ])
      .then(([columns, indexes]) => {
        if (!alive) return;
        const read: TableDesign = {
          name: node.name ?? "",
          columns: columns
            .filter((entry) => entry.kind === "column")
            .map((entry) => ({
              id: crypto.randomUUID(),
              original: entry.name,
              name: entry.name,
              type: entry.column?.data_type ?? entry.detail,
              nullable: entry.column?.nullable ?? true,
              defaultValue: entry.column?.default_value ?? null,
              primaryKey: entry.column?.primary_key ?? false,
            })),
          indexes: indexes
            .filter((entry) => entry.kind === "index")
            .map((entry) => ({ id: crypto.randomUUID(), original: entry.name, name: entry.name, columns: [], unique: false })),
        };
        setOriginal(read);
        setDesign(read);
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [connectionId, node, editing, dialect]);

  const target = { schema, dialect };
  const statements = useMemo(() => {
    if (designProblems(design).length > 0) return [];
    return original ? alterSql(original, design, target) : createSql(design, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, original, schema, dialect]);
  const problems = designProblems(design);
  const script = statements.map((statement) => (statement.startsWith("--") ? statement : `${statement};`)).join("\n");
  const runnable = statements.filter((statement) => !statement.startsWith("--"));

  const patchColumn = (id: string, next: Partial<DesignColumn>) =>
    setDesign((current) => ({ ...current, columns: current.columns.map((c) => (c.id === id ? { ...c, ...next } : c)) }));
  const patchIndex = (id: string, next: Partial<DesignIndex>) =>
    setDesign((current) => ({ ...current, indexes: current.indexes.map((i) => (i.id === id ? { ...i, ...next } : i)) }));

  const apply = async () => {
    if (!connection || runnable.length === 0) return;
    const config = parseSpec(connection);
    if (config?.read_only) {
      setError(t("db.design.readOnly"));
      return;
    }
    if (config?.environment === "prod" && !(await confirmAction(t("db.prodConfirm", { name: connection.name }), true, t("db.runAnyway")))) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const result = await dbExecute(
        connectionId,
        runnable.join(";\n"),
        { database: node.database, schema: schema ?? null, max_rows: 0 },
        crypto.randomUUID(),
      );
      const failed = result.results.find((entry) => entry.error);
      if (failed?.error) {
        setError(`${failed.statement}\n${failed.error}`);
        return;
      }
      useToastStore.getState().pushToast(t("db.design.applied"), "success");
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const toConsole = () => {
    if (!connection) return;
    useDbStore.getState().newConsole(connectionId, node.database ?? undefined, schema ?? undefined, script);
    onClose();
  };

  const types = commonTypes(dialect);

  return (
    <ApiModal
      icon={Table2}
      title={editing ? t("db.design.editTitle", { name: node.name ?? "" }) : t("db.design.newTitle")}
      subtitle={[connection?.name, node.database, schema !== node.database ? schema : null].filter(Boolean).join(" · ")}
      width="max-w-5xl"
      height="h-[84vh]"
      dismissOnBackdrop={false}
      busy={running}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {problems.length > 0 && (
            <span className="mr-auto flex items-center gap-1 text-[11px] text-[var(--cf-warning)]">
              <AlertTriangle size={11} />
              {t(PROBLEM_KEYS[problems[0]])}
            </span>
          )}
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <GhostButton onClick={toConsole} disabled={statements.length === 0}>
            <FileCode2 size={12} />
            {t("db.design.toConsole")}
          </GhostButton>
          <PrimaryButton onClick={() => void apply()} disabled={runnable.length === 0 || running}>
            {running ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t("db.design.apply", { n: String(runnable.length) })}
          </PrimaryButton>
        </div>
      }
    >
      {loading ? (
        <p className="flex flex-1 items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
          <Loader2 size={13} className="animate-spin" />
          {t("db.loading")}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          <label className="flex items-center gap-2">
            <span className="w-[90px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              {t("db.design.tableName")}
            </span>
            <input
              value={design.name}
              onChange={(e) => setDesign((current) => ({ ...current, name: e.target.value }))}
              className={`${INPUT} max-w-[320px]`}
              spellCheck={false}
              autoFocus={!editing}
            />
          </label>

          <section>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              {t("db.design.columns")}
            </h3>
            <datalist id="cf-db-design-types">
              {types.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
            <table className="w-full border-collapse text-[12px]">
              <thead className="text-left text-[10.5px] uppercase tracking-wide text-[var(--cf-text-faint)]">
                <tr>
                  <th className="px-1 py-1 font-semibold">{t("db.colName")}</th>
                  <th className="px-1 py-1 font-semibold">{t("db.colType")}</th>
                  <th className="px-1 py-1 text-center font-semibold">{t("db.design.nullable")}</th>
                  <th className="px-1 py-1 font-semibold">{t("db.design.default")}</th>
                  <th className="px-1 py-1 text-center font-semibold">{t("db.design.key")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {design.columns.map((column) => (
                  <tr key={column.id} className={column.original === null ? "bg-[var(--cf-success)]/[0.06]" : ""}>
                    <td className="px-1 py-0.5">
                      <input
                        value={column.name}
                        onChange={(e) => patchColumn(column.id, { name: e.target.value })}
                        className={`${INPUT} font-mono`}
                        spellCheck={false}
                      />
                    </td>
                    <td className="px-1 py-0.5">
                      <input
                        value={column.type}
                        list="cf-db-design-types"
                        onChange={(e) => patchColumn(column.id, { type: e.target.value })}
                        className={`${INPUT} font-mono`}
                        spellCheck={false}
                      />
                    </td>
                    <td className="px-1 py-0.5 text-center">
                      <Checkbox checked={column.nullable} onChange={(nullable) => patchColumn(column.id, { nullable })} />
                    </td>
                    <td className="px-1 py-0.5">
                      <input
                        value={column.defaultValue ?? ""}
                        placeholder="—"
                        onChange={(e) => patchColumn(column.id, { defaultValue: e.target.value === "" ? null : e.target.value })}
                        className={`${INPUT} font-mono`}
                        spellCheck={false}
                      />
                    </td>
                    <td className="px-1 py-0.5 text-center">
                      <Checkbox
                        checked={column.primaryKey}
                        onChange={(primaryKey) => patchColumn(column.id, { primaryKey, nullable: primaryKey ? false : column.nullable })}
                      />
                    </td>
                    <td className="px-1 py-0.5 text-right">
                      <GhostButton
                        onClick={() =>
                          setDesign((current) => ({ ...current, columns: current.columns.filter((c) => c.id !== column.id) }))
                        }
                      >
                        <Trash2 size={12} />
                      </GhostButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <GhostButton
              onClick={() =>
                setDesign((current) => ({
                  ...current,
                  columns: [
                    ...current.columns,
                    {
                      id: crypto.randomUUID(),
                      original: null,
                      name: "",
                      type: types.find((type) => /char|text/i.test(type)) ?? types[0],
                      nullable: true,
                      defaultValue: null,
                      primaryKey: false,
                    },
                  ],
                }))
              }
            >
              <Plus size={12} />
              {t("db.design.addColumn")}
            </GhostButton>
          </section>

          <section>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              {t("db.design.indexes")}
            </h3>
            {design.indexes.map((index) => (
              <div key={index.id} className="flex items-center gap-2 py-0.5">
                <input
                  value={index.name}
                  disabled={index.original !== null}
                  onChange={(e) => patchIndex(index.id, { name: e.target.value })}
                  className={`${INPUT} max-w-[220px] font-mono`}
                  spellCheck={false}
                />
                {index.original === null ? (
                  <>
                    <input
                      value={index.columns.join(", ")}
                      placeholder={t("db.design.indexColumns")}
                      onChange={(e) =>
                        patchIndex(index.id, {
                          columns: e.target.value
                            .split(",")
                            .map((part) => part.trim())
                            .filter(Boolean),
                        })
                      }
                      className={`${INPUT} max-w-[320px] font-mono`}
                      spellCheck={false}
                    />
                    <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                      <Checkbox checked={index.unique} onChange={(unique) => patchIndex(index.id, { unique })} />
                      {t("db.design.unique")}
                    </label>
                  </>
                ) : (
                  <span className="text-[11px] text-[var(--cf-text-faint)]">{t("db.design.existingIndex")}</span>
                )}
                <GhostButton
                  onClick={() => setDesign((current) => ({ ...current, indexes: current.indexes.filter((i) => i.id !== index.id) }))}
                >
                  <Trash2 size={12} />
                </GhostButton>
              </div>
            ))}
            <GhostButton
              onClick={() =>
                setDesign((current) => ({
                  ...current,
                  indexes: [
                    ...current.indexes,
                    {
                      id: crypto.randomUUID(),
                      original: null,
                      name: `${current.name || "table"}_idx${current.indexes.length + 1}`,
                      columns: [],
                      unique: false,
                    },
                  ],
                }))
              }
            >
              <Plus size={12} />
              {t("db.design.addIndex")}
            </GhostButton>
          </section>

          <section className="flex min-h-[120px] flex-col">
            <h3 className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              {t("db.design.preview")}
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(script)}
                title={t("db.copy")}
                className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <Copy size={11} />
              </button>
            </h3>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 font-mono text-[12px] text-[var(--cf-text)]">
              {statements.length === 0 ? t("db.design.noChanges") : script}
            </pre>
            {error && (
              <p className="mt-2 whitespace-pre-wrap rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.06] p-2 font-mono text-[12px] text-[var(--cf-danger)]">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </ApiModal>
  );
}
