import { quoteIdent } from "./sqlTemplates";
import { quotingKind, type SqlDialect } from "./fakeData";

/**
 * The table designer's model, and the DDL that turns one shape of a table into another.
 *
 * The form edits a `TableDesign`; nothing is sent until the user has read the statements this
 * writes. Every row keeps the name it had when the dialog opened (`original`), which is what tells
 * a rename from a drop-and-add — the difference between keeping a column's data and losing it.
 *
 * What a dialect cannot do in place is written as a comment saying so (SQLite has almost no ALTER;
 * SQL Server and Oracle name their constraints, and the catalog the dialog reads does not carry
 * those names), never as a statement that silently does something else.
 */
export interface DesignColumn {
  id: string;
  /** The name on the server, `null` for a column added in the dialog. */
  original: string | null;
  name: string;
  type: string;
  nullable: boolean;
  /** The default as an SQL expression (`0`, `'x'`, `now()`), or `null` for none. */
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface DesignIndex {
  id: string;
  original: string | null;
  name: string;
  /** Empty for an index read from the server — only new indexes are built from the form. */
  columns: string[];
  unique: boolean;
}

export interface TableDesign {
  name: string;
  columns: DesignColumn[];
  indexes: DesignIndex[];
}

interface Target {
  schema: string | null;
  dialect: SqlDialect;
}

function namer(dialect: SqlDialect) {
  const kind = quotingKind(dialect);
  return (name: string) => quoteIdent(name, kind);
}

function tableRef(name: string, target: Target): string {
  const q = namer(target.dialect);
  return target.schema && target.dialect !== "sqlite" ? `${q(target.schema)}.${q(name)}` : q(name);
}

function columnDefinition(column: DesignColumn, dialect: SqlDialect): string {
  const q = namer(dialect);
  const parts = [q(column.name), column.type.trim()];
  if (column.defaultValue !== null && column.defaultValue.trim() !== "") parts.push(`DEFAULT ${column.defaultValue.trim()}`);
  if (!column.nullable) parts.push("NOT NULL");
  return parts.join(" ");
}

/** The statements that create `design` from nothing. */
export function createSql(design: TableDesign, target: Target): string[] {
  const q = namer(target.dialect);
  const table = tableRef(design.name, target);
  const lines = design.columns.map((column) => `  ${columnDefinition(column, target.dialect)}`);
  const keys = design.columns.filter((column) => column.primaryKey).map((column) => q(column.name));
  if (keys.length > 0) lines.push(`  PRIMARY KEY (${keys.join(", ")})`);
  const out = [`CREATE TABLE ${table} (\n${lines.join(",\n")}\n)`];
  for (const index of design.indexes) out.push(createIndex(index, design.name, target));
  return out;
}

function createIndex(index: DesignIndex, table: string, target: Target): string {
  const q = namer(target.dialect);
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(index.name)} ON ${tableRef(table, target)} (${index.columns
    .map((column) => q(column))
    .join(", ")})`;
}

function dropIndex(name: string, table: string, target: Target): string {
  const q = namer(target.dialect);
  switch (target.dialect) {
    case "mysql":
    case "sqlserver":
      return `DROP INDEX ${q(name)} ON ${tableRef(table, target)}`;
    case "postgres":
    case "oracle":
      return `DROP INDEX ${target.schema ? `${q(target.schema)}.` : ""}${q(name)}`;
    default:
      return `DROP INDEX ${q(name)}`;
  }
}

/** The statements that turn `before` into `after`, in an order the server accepts. */
export function alterSql(before: TableDesign, after: TableDesign, target: Target): string[] {
  const { dialect } = target;
  const q = namer(dialect);
  const out: string[] = [];
  let tableName = before.name;
  const table = () => tableRef(tableName, target);

  // Indexes first: a dropped index may cover a column that is about to be dropped or changed.
  for (const index of before.indexes) {
    if (!after.indexes.some((other) => other.original === index.original)) out.push(dropIndex(index.name, tableName, target));
  }

  const oldKeys = before.columns.filter((c) => c.primaryKey).map((c) => c.original ?? c.name);
  const newKeys = after.columns.filter((c) => c.primaryKey).map((c) => c.original ?? c.name);
  const keysChanged = oldKeys.join("\u0000") !== newKeys.join("\u0000");
  if (keysChanged && oldKeys.length > 0) out.push(dropPrimaryKey(before.name, target));

  for (const column of before.columns) {
    if (!after.columns.some((other) => other.original === column.original)) {
      out.push(`ALTER TABLE ${table()} DROP COLUMN ${q(column.name)}`);
    }
  }

  for (const column of after.columns) {
    const was = before.columns.find((other) => other.original !== null && other.original === column.original);
    if (!was) {
      out.push(addColumn(table(), column, dialect));
      continue;
    }
    if (was.name !== column.name) out.push(renameColumn(table(), tableName, target, was.name, column.name));
    out.push(...changeColumn(table(), was, column, dialect));
  }

  if (keysChanged && newKeys.length > 0) {
    const names = after.columns.filter((c) => c.primaryKey).map((c) => q(c.name));
    out.push(
      dialect === "sqlite"
        ? `-- SQLite cannot add a primary key to an existing table: rebuild it (CREATE TABLE … AS, copy, rename).`
        : `ALTER TABLE ${table()} ADD PRIMARY KEY (${names.join(", ")})`,
    );
  }

  for (const index of after.indexes) {
    if (index.original === null && index.columns.length > 0) out.push(createIndex(index, tableName, target));
  }

  if (after.name !== before.name) {
    out.push(renameTable(tableName, after.name, target));
    tableName = after.name;
  }
  return out;
}

function addColumn(table: string, column: DesignColumn, dialect: SqlDialect): string {
  const definition = columnDefinition(column, dialect);
  switch (dialect) {
    case "oracle":
      return `ALTER TABLE ${table} ADD (${definition})`;
    case "sqlserver":
      return `ALTER TABLE ${table} ADD ${definition}`;
    default:
      return `ALTER TABLE ${table} ADD COLUMN ${definition}`;
  }
}

function renameColumn(table: string, bare: string, target: Target, from: string, to: string): string {
  const q = namer(target.dialect);
  if (target.dialect === "sqlserver") {
    const object = target.schema ? `${target.schema}.${bare}.${from}` : `${bare}.${from}`;
    return `EXEC sp_rename '${object.replace(/'/g, "''")}', '${to.replace(/'/g, "''")}', 'COLUMN'`;
  }
  return `ALTER TABLE ${table} RENAME COLUMN ${q(from)} TO ${q(to)}`;
}

function renameTable(from: string, to: string, target: Target): string {
  const q = namer(target.dialect);
  if (target.dialect === "sqlserver") {
    const object = target.schema ? `${target.schema}.${from}` : from;
    return `EXEC sp_rename '${object.replace(/'/g, "''")}', '${to.replace(/'/g, "''")}'`;
  }
  // Every other dialect takes the new name bare: the table stays in its schema.
  return `ALTER TABLE ${tableRef(from, target)} RENAME TO ${q(to)}`;
}

function dropPrimaryKey(table: string, target: Target): string {
  const q = namer(target.dialect);
  switch (target.dialect) {
    case "mysql":
      return `ALTER TABLE ${tableRef(table, target)} DROP PRIMARY KEY`;
    case "postgres":
      // Postgres names an unnamed primary key `<table>_pkey`; a key created with another name
      // fails here with that name in the error.
      return `ALTER TABLE ${tableRef(table, target)} DROP CONSTRAINT ${q(`${table}_pkey`)}`;
    case "oracle":
      return `ALTER TABLE ${tableRef(table, target)} DROP PRIMARY KEY`;
    case "sqlite":
      return `-- SQLite cannot drop a primary key in place: rebuild the table.`;
    default:
      return `-- ALTER TABLE ${tableRef(table, target)} DROP CONSTRAINT <primary key name>  -- look it up in the catalog`;
  }
}

function changeColumn(table: string, was: DesignColumn, now: DesignColumn, dialect: SqlDialect): string[] {
  const q = namer(dialect);
  const c = q(now.name);
  const typeChanged = was.type.trim() !== now.type.trim();
  const nullChanged = was.nullable !== now.nullable;
  const defaultChanged = (was.defaultValue ?? "").trim() !== (now.defaultValue ?? "").trim();
  if (!typeChanged && !nullChanged && !defaultChanged) return [];
  const newDefault = (now.defaultValue ?? "").trim();
  switch (dialect) {
    case "postgres": {
      const out: string[] = [];
      if (typeChanged) out.push(`ALTER TABLE ${table} ALTER COLUMN ${c} TYPE ${now.type.trim()}`);
      if (nullChanged) out.push(`ALTER TABLE ${table} ALTER COLUMN ${c} ${now.nullable ? "DROP" : "SET"} NOT NULL`);
      if (defaultChanged)
        out.push(`ALTER TABLE ${table} ALTER COLUMN ${c} ${newDefault ? `SET DEFAULT ${newDefault}` : "DROP DEFAULT"}`);
      return out;
    }
    case "mysql":
      // MODIFY restates the whole column, so one statement carries every change at once.
      return [`ALTER TABLE ${table} MODIFY COLUMN ${columnDefinition(now, dialect)}`];
    case "sqlserver": {
      const out: string[] = [];
      if (typeChanged || nullChanged) out.push(`ALTER TABLE ${table} ALTER COLUMN ${c} ${now.type.trim()} ${now.nullable ? "NULL" : "NOT NULL"}`);
      if (defaultChanged) {
        if ((was.defaultValue ?? "").trim())
          out.push(`-- ALTER TABLE ${table} DROP CONSTRAINT <default constraint of ${now.name}>  -- look it up in sys.default_constraints`);
        if (newDefault) out.push(`ALTER TABLE ${table} ADD DEFAULT ${newDefault} FOR ${c}`);
      }
      return out;
    }
    case "oracle": {
      const parts = [c];
      if (typeChanged) parts.push(now.type.trim());
      if (defaultChanged) parts.push(`DEFAULT ${newDefault || "NULL"}`);
      if (nullChanged) parts.push(now.nullable ? "NULL" : "NOT NULL");
      return [`ALTER TABLE ${table} MODIFY (${parts.join(" ")})`];
    }
    case "sqlite":
      return [`-- SQLite cannot change ${now.name}'s type, nullability or default in place: rebuild the table.`];
    default: {
      const out: string[] = [];
      if (typeChanged) out.push(`ALTER TABLE ${table} ALTER COLUMN ${c} ${now.type.trim()}`);
      if (nullChanged) out.push(`ALTER TABLE ${table} ALTER COLUMN ${c} ${now.nullable ? "NULL" : "NOT NULL"}`);
      if (defaultChanged)
        out.push(`ALTER TABLE ${table} ALTER COLUMN ${c} ${newDefault ? `SET DEFAULT ${newDefault}` : "DROP DEFAULT"}`);
      return out;
    }
  }
}

/** Problems that stop the statements from being worth running. */
export function designProblems(design: TableDesign): ("noName" | "noColumns" | "emptyColumn" | "duplicate" | "noType")[] {
  const out: ("noName" | "noColumns" | "emptyColumn" | "duplicate" | "noType")[] = [];
  if (!design.name.trim()) out.push("noName");
  if (design.columns.length === 0) out.push("noColumns");
  if (design.columns.some((column) => !column.name.trim())) out.push("emptyColumn");
  if (design.columns.some((column) => !column.type.trim())) out.push("noType");
  const names = design.columns.map((column) => column.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) out.push("duplicate");
  return out;
}

/** Types offered in the type field's list, per dialect — a start, not a limit: any text is accepted. */
export function commonTypes(dialect: SqlDialect): string[] {
  switch (dialect) {
    case "postgres":
      return ["bigint", "integer", "smallint", "numeric(12,2)", "boolean", "text", "varchar(255)", "uuid", "date", "timestamptz", "jsonb", "bytea"];
    case "mysql":
      return ["bigint", "int", "smallint", "decimal(12,2)", "tinyint(1)", "varchar(255)", "text", "date", "datetime", "timestamp", "json", "blob"];
    case "sqlserver":
      return ["bigint", "int", "smallint", "decimal(12,2)", "bit", "nvarchar(255)", "nvarchar(max)", "uniqueidentifier", "date", "datetime2", "varbinary(max)"];
    case "oracle":
      return ["NUMBER(19)", "NUMBER(10)", "NUMBER(12,2)", "VARCHAR2(255)", "CLOB", "DATE", "TIMESTAMP", "BLOB"];
    case "sqlite":
      return ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"];
    default:
      return ["BIGINT", "INTEGER", "VARCHAR(255)", "DATE", "TIMESTAMP"];
  }
}
