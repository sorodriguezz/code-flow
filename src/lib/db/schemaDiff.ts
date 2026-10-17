import { quoteIdent } from "./sqlTemplates";
import { quotingKind, type SqlDialect } from "./fakeData";
import type { DbDiagramColumn, DbDiagramTable, DbSchemaDiagram } from "../../types/database";

/**
 * Comparing two schemas, and the DDL that turns the second into the first.
 *
 * `A` is the **source** — the schema as it should be — and `B` the **target**, the one the script
 * runs on. Everything is said from B's side: "only in A" is a table B is missing and gets created,
 * "only in B" is one B has that A doesn't, and gets a `DROP` that is **commented out** unless the
 * caller asks otherwise. A comparison is the one place a stray `DROP TABLE` is easiest to run by
 * accident, because the script looks like something to run.
 *
 * Tables and columns match by name, case-insensitively: Oracle reports `CUSTOMERS` where Postgres
 * reports `customers`, and comparing the two is a large part of why this exists. Foreign keys match
 * by what they connect (columns → parent columns), not by constraint name, which differs between two
 * environments made by two runs of the same migration tool far more often than the keys do.
 *
 * Defaults are compared only when the diagram carries them: `DbDiagramColumn` has no default, so the
 * modal reads them per table and passes them in as `default` on each column (`ColumnWithDefault`).
 */

/** A diagram column, optionally with its default expression read separately. */
export type ColumnWithDefault = DbDiagramColumn & { default?: string | null };

export interface ColumnChange {
  name: string;
  /** The column as A has it — what the script makes B's look like. */
  source: ColumnWithDefault;
  target: ColumnWithDefault;
  type: boolean;
  nullable: boolean;
  default: boolean;
}

export interface ForeignKeySig {
  name: string;
  table: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}

export interface TableDiff {
  name: string;
  source: DbDiagramTable;
  target: DbDiagramTable;
  added: ColumnWithDefault[];
  removed: ColumnWithDefault[];
  changed: ColumnChange[];
  /** Set when the primary key's columns differ. */
  primaryKey: { source: string[]; target: string[] } | null;
  fkAdded: ForeignKeySig[];
  fkRemoved: ForeignKeySig[];
}

export interface SchemaDiff {
  sourceSchema: string | null;
  targetSchema: string | null;
  onlyInSource: DbDiagramTable[];
  onlyInTarget: DbDiagramTable[];
  changed: TableDiff[];
  /** Foreign keys of tables that exist only in A — created after every table, so order is moot. */
  newTableKeys: ForeignKeySig[];
  /** Tables in both with nothing to say. */
  unchanged: number;
}

const lower = (name: string) => name.toLowerCase();

/** Spellings of the same type, so `int4` vs `integer` is not a difference. Lossy on purpose. */
export function normalizeType(raw: string): string {
  let type = raw.trim().toLowerCase().replace(/\s+/g, " ");
  type = type.replace(/\s*\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")");
  const aliases: [RegExp, string][] = [
    [/^character varying/, "varchar"],
    [/^varchar2/, "varchar"],
    [/^nvarchar2/, "nvarchar"],
    [/^character(?!\s*varying)/, "char"],
    [/^timestamp without time zone/, "timestamp"],
    [/^timestamp with time zone/, "timestamptz"],
    [/^time without time zone/, "time"],
    [/^double precision/, "double"],
    [/^float8/, "double"],
    [/^float4/, "real"],
    [/^int4\b/, "integer"],
    [/^int\b/, "integer"],
    [/^int8\b/, "bigint"],
    [/^int2\b/, "smallint"],
    [/^bool\b/, "boolean"],
    [/^decimal/, "numeric"],
  ];
  for (const [pattern, replacement] of aliases) type = type.replace(pattern, replacement);
  // MySQL's display widths (`int(11)`) say nothing about what the column holds.
  type = type.replace(/^(tinyint|smallint|mediumint|integer|bigint)\(\d+\)/, "$1");
  return type;
}

function normalizeDefault(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  let text = value.trim();
  // SQL Server wraps every default in parentheses, sometimes twice.
  while (/^\(.*\)$/.test(text) && balanced(text.slice(1, -1))) text = text.slice(1, -1).trim();
  // Postgres appends the cast it inferred: `'x'::character varying`.
  text = text.replace(/::[a-z ]+(\[\])?$/i, "");
  return text.toLowerCase();
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Foreign keys per table, grouped into constraints. Inferred edges (Mongo's guesses) are left out:
 * they are not something a script can create. */
export function foreignKeysOf(diagram: DbSchemaDiagram): ForeignKeySig[] {
  const byConstraint = new Map<string, ForeignKeySig>();
  for (const edge of diagram.edges) {
    if (edge.inferred) continue;
    const key = `${lower(edge.from_table)}\u0000${edge.constraint}`;
    const sig = byConstraint.get(key) ?? {
      name: edge.constraint,
      table: edge.from_table,
      columns: [],
      refSchema: edge.to_schema,
      refTable: edge.to_table,
      refColumns: [],
    };
    sig.columns.push(edge.from_column);
    sig.refColumns.push(edge.to_column);
    byConstraint.set(key, sig);
  }
  return [...byConstraint.values()];
}

function fkSignature(fk: ForeignKeySig): string {
  return [lower(fk.table), fk.columns.map(lower).join(","), lower(fk.refTable), fk.refColumns.map(lower).join(",")].join("|");
}

function primaryKeyOf(table: DbDiagramTable): string[] {
  return table.columns.filter((column) => column.primary_key).map((column) => column.name);
}

/** The diff of two schemas. Only tables (and collections) are compared; views hold no structure a
 * column-level script could reproduce. */
export function diffSchemas(source: DbSchemaDiagram, target: DbSchemaDiagram): SchemaDiff {
  const tablesOf = (diagram: DbSchemaDiagram) =>
    new Map(diagram.tables.filter((table) => table.kind !== "view").map((table) => [lower(table.name), table]));
  const a = tablesOf(source);
  const b = tablesOf(target);
  const fkA = foreignKeysOf(source);
  const fkB = foreignKeysOf(target);

  const onlyInSource = [...a.values()].filter((table) => !b.has(lower(table.name)));
  const onlyInTarget = [...b.values()].filter((table) => !a.has(lower(table.name)));
  const changed: TableDiff[] = [];
  let unchanged = 0;

  for (const [key, left] of a) {
    const right = b.get(key);
    if (!right) continue;
    const rightColumns = new Map(right.columns.map((column) => [lower(column.name), column as ColumnWithDefault]));
    const leftColumns = new Map(left.columns.map((column) => [lower(column.name), column as ColumnWithDefault]));
    const added = [...leftColumns.values()].filter((column) => !rightColumns.has(lower(column.name)));
    const removed = [...rightColumns.values()].filter((column) => !leftColumns.has(lower(column.name)));
    const changes: ColumnChange[] = [];
    for (const [name, column] of leftColumns) {
      const other = rightColumns.get(name);
      if (!other) continue;
      const type = normalizeType(column.data_type) !== normalizeType(other.data_type);
      const nullable = column.nullable !== other.nullable;
      // Only when both sides were read: an unread default is not a removed one.
      const def =
        column.default !== undefined &&
        other.default !== undefined &&
        normalizeDefault(column.default) !== normalizeDefault(other.default);
      if (type || nullable || def) {
        changes.push({ name: column.name, source: column, target: other, type, nullable, default: def });
      }
    }
    const pkA = primaryKeyOf(left);
    const pkB = primaryKeyOf(right);
    const samePk = pkA.map(lower).sort().join(",") === pkB.map(lower).sort().join(",");
    const leftKeys = fkA.filter((fk) => lower(fk.table) === key);
    const rightKeys = fkB.filter((fk) => lower(fk.table) === key);
    const rightSigs = new Set(rightKeys.map(fkSignature));
    const leftSigs = new Set(leftKeys.map(fkSignature));
    const fkAdded = leftKeys.filter((fk) => !rightSigs.has(fkSignature(fk)));
    const fkRemoved = rightKeys.filter((fk) => !leftSigs.has(fkSignature(fk)));

    if (added.length || removed.length || changes.length || !samePk || fkAdded.length || fkRemoved.length) {
      changed.push({
        name: left.name,
        source: left,
        target: right,
        added,
        removed,
        changed: changes,
        primaryKey: samePk ? null : { source: pkA, target: pkB },
        fkAdded,
        fkRemoved,
      });
    } else {
      unchanged += 1;
    }
  }

  const created = new Set(onlyInSource.map((table) => lower(table.name)));
  return {
    sourceSchema: source.schema,
    targetSchema: target.schema,
    onlyInSource,
    onlyInTarget,
    changed,
    newTableKeys: fkA.filter((fk) => created.has(lower(fk.table))),
    unchanged,
  };
}

/** Whether there is anything at all to do. */
export function isEmptyDiff(diff: SchemaDiff): boolean {
  return diff.onlyInSource.length === 0 && diff.onlyInTarget.length === 0 && diff.changed.length === 0;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  /** Emit `DROP`s as statements rather than as comments. Off by default. */
  includeDrops?: boolean;
}

/**
 * The script that turns B (the target) into A (the source), in the target's dialect.
 *
 * Types are copied from A verbatim. Across engines that is a draft rather than a script — a Postgres
 * `jsonb` means nothing to SQL Server — and the header says so when the two schemas came from
 * different places; the console is where it gets finished.
 */
export function migrationSql(diff: SchemaDiff, dialect: SqlDialect, options: MigrationOptions = {}): string {
  const kind = quotingKind(dialect);
  const q = (name: string) => quoteIdent(name, kind);
  const target = (table: string) => (diff.targetSchema ? `${q(diff.targetSchema)}.${q(table)}` : q(table));
  const drop = (statement: string) => (options.includeDrops ? statement : `-- ${statement}`);
  const out: string[] = [];
  const section = (title: string) => out.push("", `-- ${title}`);

  const columnDef = (column: ColumnWithDefault, withNull = true) => {
    let def = `${q(column.name)} ${column.data_type}`;
    if (column.default !== undefined && column.default !== null && column.default !== "") def += ` DEFAULT ${column.default}`;
    if (withNull && !column.nullable) def += " NOT NULL";
    return def;
  };
  const fkStatement = (fk: ForeignKeySig) => {
    const cols = fk.columns.map(q).join(", ");
    const refs = fk.refColumns.map(q).join(", ");
    return `ALTER TABLE ${target(fk.table)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${target(fk.refTable)} (${refs});`;
  };
  const rebuild = (table: string, what: string) =>
    `-- SQLite cannot ${what} on ${table} with ALTER TABLE: rebuild it (CREATE TABLE new, INSERT … SELECT, DROP, RENAME).`;

  if (diff.onlyInSource.length > 0) {
    section("Tables missing from the target");
    for (const table of diff.onlyInSource) {
      const lines = table.columns.map((column) => `  ${columnDef(column)}`);
      const pk = primaryKeyOf(table);
      if (pk.length > 0) lines.push(`  PRIMARY KEY (${pk.map(q).join(", ")})`);
      // SQLite declares foreign keys only inside CREATE TABLE.
      if (dialect === "sqlite") {
        for (const fk of diff.newTableKeys.filter((key) => lower(key.table) === lower(table.name))) {
          lines.push(`  FOREIGN KEY (${fk.columns.map(q).join(", ")}) REFERENCES ${q(fk.refTable)} (${fk.refColumns.map(q).join(", ")})`);
        }
      }
      out.push(`CREATE TABLE ${target(table.name)} (\n${lines.join(",\n")}\n);`);
    }
    if (dialect !== "sqlite" && diff.newTableKeys.length > 0) {
      section("Foreign keys of the new tables");
      for (const fk of diff.newTableKeys) out.push(fkStatement(fk));
    }
  }

  for (const table of diff.changed) {
    section(`${table.name}`);
    const t = target(table.name);
    for (const column of table.added) {
      const add = dialect === "sqlserver" || dialect === "oracle" ? "ADD" : "ADD COLUMN";
      const def = dialect === "oracle" ? `(${columnDef(column)})` : columnDef(column);
      if (!column.nullable && (column.default === undefined || column.default === null)) {
        out.push(`-- ${column.name} is NOT NULL with no default: this fails on a table that already has rows.`);
      }
      out.push(`ALTER TABLE ${t} ${add} ${def};`);
    }
    for (const change of table.changed) {
      const c = q(change.name);
      const src = change.source;
      switch (dialect) {
        case "postgres":
          if (change.type) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${src.data_type};`);
          if (change.nullable) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${src.nullable ? "DROP" : "SET"} NOT NULL;`);
          if (change.default) {
            out.push(src.default ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${src.default};` : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`);
          }
          break;
        case "mysql":
          // MODIFY restates the whole column, so one statement covers type, nullability and default.
          out.push(`ALTER TABLE ${t} MODIFY COLUMN ${columnDef(src)};`);
          break;
        case "sqlserver":
        case "iris":
          if (change.type || change.nullable) {
            out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${src.data_type} ${src.nullable ? "NULL" : "NOT NULL"};`);
          }
          if (change.default) {
            if (dialect === "sqlserver") {
              out.push(`-- The old default is a named constraint: find it in sys.default_constraints and drop it first.`);
              if (src.default) out.push(`ALTER TABLE ${t} ADD DEFAULT ${src.default} FOR ${c};`);
            } else {
              out.push(src.default ? `ALTER TABLE ${t} ALTER COLUMN ${c} DEFAULT ${src.default};` : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`);
            }
          }
          break;
        case "oracle": {
          const parts: string[] = [];
          if (change.type) parts.push(src.data_type);
          if (change.default) parts.push(`DEFAULT ${src.default || "NULL"}`);
          if (change.nullable) parts.push(src.nullable ? "NULL" : "NOT NULL");
          out.push(`ALTER TABLE ${t} MODIFY (${c} ${parts.join(" ")});`);
          break;
        }
        case "sqlite":
          out.push(rebuild(table.name, `change column ${change.name} (${describeChange(change)})`));
          break;
        default:
          if (change.type) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} SET DATA TYPE ${src.data_type};`);
          if (change.nullable) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${src.nullable ? "DROP" : "SET"} NOT NULL;`);
          if (change.default) {
            out.push(src.default ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${src.default};` : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`);
          }
      }
    }
    if (table.primaryKey) {
      const cols = table.primaryKey.source.map(q).join(", ");
      if (dialect === "sqlite") {
        out.push(rebuild(table.name, "change the primary key"));
      } else if (dialect === "mysql") {
        if (table.primaryKey.target.length > 0) out.push(drop(`ALTER TABLE ${t} DROP PRIMARY KEY;`));
        if (cols) out.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${cols});`);
      } else {
        if (table.primaryKey.target.length > 0) {
          out.push(drop(`ALTER TABLE ${t} DROP CONSTRAINT /* primary key name */;`));
        }
        if (cols) out.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${cols});`);
      }
    }
    for (const fk of table.fkRemoved) {
      if (dialect === "sqlite") out.push(rebuild(table.name, `drop foreign key ${fk.name}`));
      else if (dialect === "mysql") out.push(drop(`ALTER TABLE ${t} DROP FOREIGN KEY ${q(fk.name)};`));
      else out.push(drop(`ALTER TABLE ${t} DROP CONSTRAINT ${q(fk.name)};`));
    }
    for (const fk of table.fkAdded) {
      if (dialect === "sqlite") out.push(rebuild(table.name, `add foreign key (${fk.columns.join(", ")})`));
      else out.push(fkStatement(fk));
    }
    for (const column of table.removed) {
      if (dialect === "oracle") out.push(drop(`ALTER TABLE ${t} DROP (${q(column.name)});`));
      else out.push(drop(`ALTER TABLE ${t} DROP COLUMN ${q(column.name)};`));
    }
  }

  if (diff.onlyInTarget.length > 0) {
    section("Tables only in the target");
    for (const table of diff.onlyInTarget) out.push(drop(`DROP TABLE ${target(table.name)};`));
  }

  if (out.length === 0) return "-- The schemas match: nothing to do.";
  const header = [
    `-- Turns ${diff.targetSchema ?? "the target"} into ${diff.sourceSchema ?? "the source"}.`,
    options.includeDrops ? "-- DROP statements are included: review them before running." : "-- DROP statements are commented out.",
  ];
  return [...header, ...out].join("\n").trim() + "\n";
}

/** "type, nullability" — what changed about a column, for comments and badges. */
export function describeChange(change: ColumnChange): string {
  const parts: string[] = [];
  if (change.type) parts.push(`${change.target.data_type} → ${change.source.data_type}`);
  if (change.nullable) parts.push(change.source.nullable ? "NOT NULL → NULL" : "NULL → NOT NULL");
  if (change.default) parts.push(`DEFAULT ${change.target.default ?? "∅"} → ${change.source.default ?? "∅"}`);
  return parts.join(", ");
}
