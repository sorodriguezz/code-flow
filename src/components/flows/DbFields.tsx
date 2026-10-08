import { useEffect, useId, useState } from "react";
import { RefreshCw } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { Rows, asRows, str } from "./fieldRows";
import { SmartInput } from "./ParamFields";
import { dbChildren, dbLoadTree } from "../../lib/tauri/dbCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { DbNodeKind, DbNodeRef } from "../../types/database";

/**
 * The fields of «Base de datos» (`data.database`) that know the node's connection: the table, typed
 * or picked from what the connection lists, and the conditions, whose columns are offered from that
 * table. Both ask the Databases workspace (`db_children`), so a connection open there is reused and
 * a password is never seen here.
 */

type Row = Record<string, unknown>;

/** Where the node points: its connection and, when written, a database and a schema. */
export interface DbPlace {
  connection: string;
  database: string;
  schema: string;
}

/** The operators a database filter pushes down to the server — `nodes::database::sql_condition`. */
const DB_OPERATORS = ["equals", "notEquals", "gt", "gte", "lt", "lte", "contains", "notContains", "startsWith", "endsWith", "isNull", "notNull", "inList"] as const;
const DB_UNARY = new Set(["isNull", "notNull"]);

/** A connection's engine and own database — a MongoDB node lists collections of a database. */
async function connectionOf(workspaceId: string, id: string): Promise<{ mongo: boolean; database: string }> {
  const tree = await dbLoadTree(workspaceId);
  const row = tree.connections.find((c) => c.id === id);
  let database = "";
  try {
    database = String((JSON.parse(row?.spec ?? "{}") as { database?: unknown }).database ?? "");
  } catch {
    // A spec that does not parse leaves the database to the field.
  }
  return { mongo: row?.kind === "mongodb", database };
}

/** `schema.table` in the table field, with no schema written, is both — on a SQL engine. */
function splitTable(schema: string, table: string, mongo: boolean): { schema: string; table: string } {
  const dot = table.indexOf(".");
  if (!schema.trim() && !mongo && dot > 0 && dot < table.length - 1) return { schema: table.slice(0, dot), table: table.slice(dot + 1) };
  return { schema: schema.trim(), table: table.trim() };
}

/**
 * Names the connection lists under one node — the tables and views of a schema, or the columns of
 * a table — asked again when the place changes or `tick` moves. Quiet while there is no connection.
 */
function useDbNames(place: DbPlace, table: string | null, tick: number): { names: string[]; problem: string | null } {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [names, setNames] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const { connection, database, schema } = place;
  useEffect(() => {
    if (!workspaceId || !connection || (table !== null && !table.trim())) {
      setNames([]);
      setProblem(null);
      return;
    }
    let alive = true;
    // Typing a table name should not ask the server once per key.
    const timer = setTimeout(async () => {
      try {
        const engine = await connectionOf(workspaceId, connection);
        const db = database.trim() || (engine.mongo ? engine.database : "");
        const at = (kind: DbNodeKind, name: string | null, owner = schema.trim()): DbNodeRef => ({ kind, database: db || null, schema: owner || null, name });
        let listed: string[];
        if (table !== null) {
          const where = splitTable(schema, table, engine.mongo);
          const columns = await dbChildren(connection, at("column_folder", where.table, where.schema));
          listed = columns.filter((node) => node.kind === "column").map((node) => node.name);
        } else if (engine.mongo) {
          listed = (await dbChildren(connection, at("database", null))).map((node) => node.name);
        } else {
          const tables = await dbChildren(connection, at("table_folder", null));
          // Views are offered too, when the engine lists them: a read is as good from one.
          const views = await dbChildren(connection, at("view_folder", null)).catch(() => []);
          listed = [...tables, ...views].map((node) => node.name);
        }
        if (!alive) return;
        setNames([...new Set(listed)]);
        setProblem(null);
      } catch (error) {
        if (alive) {
          setNames([]);
          setProblem(String(error));
        }
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [workspaceId, connection, database, schema, table, tick]);
  return { names, problem };
}

/** The table: typed, or picked from the connection's tables, views or collections. */
export function DbTableField({ value, onChange, place }: { value: unknown; onChange: (next: unknown) => void; place: DbPlace }) {
  const t = useT();
  const listId = useId();
  const [tick, setTick] = useState(0);
  const { names, problem } = useDbNames(place, null, tick);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          list={listId}
          className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
          value={str(value)}
          placeholder={place.connection ? t("flows.db.pickTable") : t("flows.db.needsConnection")}
          aria-label={t("flows.param.dbTable")}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id={listId}>
          {names.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.db.reload")}
          aria-label={t("flows.db.reload")}
          disabled={!place.connection}
          onClick={() => setTick((n) => n + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {problem && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{problem}</span>}
    </div>
  );
}

/** What rows to read: column, operator, value — the value may be an expression of the item. */
export function DbFiltersEditor({ value, onChange, place, table }: { value: unknown; onChange: (next: unknown) => void; place: DbPlace; table: string }) {
  const t = useT();
  const listId = useId();
  const spec = (value && typeof value === "object" ? value : {}) as Row;
  const rows = asRows(spec.conditions);
  const { names } = useDbNames(place, table, 0);
  const update = (change: Row) => onChange({ ...spec, ...change });
  const operators = DB_OPERATORS.map((op) => ({ value: op, label: t(`flows.op.${op}` as TranslationKey) }));
  return (
    <div className="flex flex-col gap-2">
      <datalist id={listId}>
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Rows
        rows={rows}
        onChange={(conditions) => update({ conditions })}
        blank={() => ({ column: "", op: "equals", value: "" })}
        addLabel={t("flows.param.addCondition")}
        render={(row, set) => (
          <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-[var(--cf-sunken)] p-1.5">
            <div className="flex min-w-0 gap-1.5">
              <input
                list={listId}
                className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
                value={str(row.column)}
                placeholder={t("flows.db.column")}
                aria-label={t("flows.db.column")}
                onChange={(event) => set({ ...row, column: event.target.value })}
              />
              <div className="w-[132px] shrink-0">
                <Select value={str(row.op) || "equals"} onChange={(op) => set({ ...row, op })} options={operators} size="sm" />
              </div>
            </div>
            {!DB_UNARY.has(str(row.op)) && (
              <SmartInput value={str(row.value)} onChange={(next) => set({ ...row, value: next })} placeholder={t("flows.db.value")} ariaLabel={t("flows.db.value")} />
            )}
          </div>
        )}
      />
      {rows.length > 1 && (
        <div className="w-[120px]">
          <Select
            value={spec.combinator === "or" ? "or" : "and"}
            onChange={(combinator) => update({ combinator })}
            options={[
              { value: "and", label: t("flows.param.all") },
              { value: "or", label: t("flows.param.any") },
            ]}
            size="sm"
          />
        </div>
      )}
    </div>
  );
}
