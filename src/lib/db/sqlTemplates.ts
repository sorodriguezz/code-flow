import { engineInfo, type DbKind, type DbNode } from "../../types/database";

/**
 * Starter statements for a table, generated from its columns.
 *
 * The point is not to write the statement for you — it is to write the *boring* part: the qualified
 * name in the right quoting style, every column in catalog order, and the clause you must not
 * forget. What you get is a draft in a console, never a statement that runs on its own; the console
 * is where you finish it and decide to run it.
 *
 * Two rules the drafts follow:
 *
 * 1. **Nothing destructive is complete.** `UPDATE` and `DELETE` arrive with a `WHERE` that is
 *    deliberately unfinished, and the console refuses a `DELETE` with no `WHERE` at all (see
 *    `sqlGuards`). A generator that emitted a ready-to-run `DELETE FROM t` would be handing over a
 *    loaded statement one ⌘↵ away from an empty table.
 *
 *    `DROP` and `TRUNCATE` are the exception, and it is worth being clear about why. What makes an
 *    unguarded `DELETE` dangerous is that it is a statement you *meant* to finish — the clause is
 *    missing by accident. `DROP TABLE t` has no missing clause: it is exactly and only what was
 *    asked for, so leaving it half-written would be theatre rather than a safeguard. They carry a
 *    comment saying what they destroy, and nothing here runs on its own.
 * 2. **The dialect is respected.** Identifier quoting differs (`[x]` on SQL Server), and so does
 *    paging (`TOP` on IRIS and SQL Server, `LIMIT` elsewhere) — a draft that doesn't parse in the
 *    console it lands in has taught the user nothing.
 */

export type SqlTemplate =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "count"
  | "create"
  | "truncate"
  | "drop"
  | "grant"
  | "revoke";

/**
 * `CREATE TABLE` / `CREATE SCHEMA` drafts for a container node — a database or a schema.
 *
 * The pair the tree is missing: everything else in the explorer reads what exists, and the moment
 * you want a table there is nowhere to start one. These are drafts, like everything in this
 * module — the console is where they are finished and run — but they arrive already qualified with
 * the schema you right-clicked, which is the part that is tedious and easy to get wrong.
 *
 * `schema` is the schema to create in (or to create, for `newSchema`); pass `null` on an engine
 * that has no schemas, and the name comes out bare.
 */
export function createTemplate(
  what: "table" | "schema",
  kind: DbKind,
  schema: string | null,
): string {
  const language = engineInfo(kind).consoleLanguage;
  if (language === "redis") {
    // Redis has neither schemas nor tables. A namespace comes into being the moment a key is
    // written under it, so the honest draft is the write itself.
    return `# A namespace exists as soon as a key is written under it.\nSET nuevo:1 "value"`;
  }
  if (language === "javascript") {
    // Mongo makes a collection by writing to it; there is no DDL to draft.
    return `db.createCollection("nueva_coleccion")`;
  }
  if (what === "schema") {
    return `CREATE SCHEMA ${quote(schema ?? "nuevo_esquema", kind)}`;
  }
  const target = schema
    ? `${quote(schema, kind)}.${quote("nueva_tabla", kind)}`
    : quote("nueva_tabla", kind);
  // An identity/serial key and a timestamp: the two columns nearly every table starts with, in
  // the dialect that will accept them. Anything else is a guess about the table's purpose.
  const id =
    kind === "sqlserver"
      ? `  ${quote("id", kind)} INT IDENTITY(1,1) PRIMARY KEY`
      : kind === "iris"
        ? `  ${quote("id", kind)} INT NOT NULL PRIMARY KEY`
        : `  ${quote("id", kind)} SERIAL PRIMARY KEY`;
  const stamp =
    kind === "sqlserver"
      ? `  ${quote("created_at", kind)} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()`
      : kind === "iris"
        ? `  ${quote("created_at", kind)} TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
        : `  ${quote("created_at", kind)} TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  return `CREATE TABLE ${target} (\n${id},\n  ${quote("nombre", kind)} VARCHAR(120) NOT NULL,\n${stamp}\n)`;
}

function quote(name: string, kind: DbKind): string {
  if (kind === "sqlserver") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function qualify(node: DbNode, kind: DbKind): string {
  return node.schema ? `${quote(node.schema, kind)}.${quote(node.name, kind)}` : quote(node.name, kind);
}

/**
 * How a console names this object — what dragging it out of the explorer inserts.
 *
 * The same `qualify` every draft above is built on, exported so the drop and the generated
 * statements cannot disagree: a name dragged in reads identically to one that arrived with a
 * `SELECT`, quotes and all.
 *
 * Quoted even when the name would survive bare, which is the deliberate half of that. Unquoted is
 * prettier right up until the collection holds a `"Users"` on Postgres or an `order` anywhere, and
 * the failure then is a syntax error in a query the user did not type — the one kind of paste that
 * teaches nothing. The schema is included whenever the node has one rather than when the console's
 * current scope makes it necessary: that scope is a dropdown two clicks from changing, and a query
 * that silently starts resolving against a different schema is worse than a redundant prefix.
 */
export function objectReference(node: DbNode, kind: DbKind): string {
  switch (engineInfo(kind).consoleLanguage) {
    // A Redis key is named by itself — it *is* the identifier, prefix and all. `node.schema` holds
    // the namespace prefix and `node.name` the last segment; see `full_key` in `redis.rs`.
    case "redis":
      return node.schema ? `${node.schema}:${node.name}` : node.name;
    // Mongo names a collection through `db`, exactly as every Mongo draft above does; the bare
    // name is not valid anywhere in that shell.
    case "javascript":
      return `db.${node.name}`;
    default:
      return qualify(node, kind);
  }
}

/** A placeholder that is obviously one, so an unfinished draft can't be mistaken for a finished one. */
const VALUE = "?";

/**
 * Builds one draft. `columns` may be empty — the catalog read that fills it is allowed to fail, and
 * a draft with a "columns" marker where the list should be is more useful than no draft at all.
 */
export function sqlTemplate(
  template: SqlTemplate,
  node: DbNode,
  kind: DbKind,
  columns: string[],
): string {
  const target = qualify(node, kind);
  const language = engineInfo(kind).consoleLanguage;

  if (language === "redis") {
    // The same intents, as Redis commands. Note what `truncate` and `drop` are *not*: FLUSHDB.
    // "Empty this namespace" means the keys under it, and a draft that reached for the whole
    // database would be one keystroke from an outage — the driver refuses FLUSHDB anyway.
    const key = objectReference(node, kind);
    switch (template) {
      case "select":
        return `SCAN 0 MATCH ${key}* COUNT 100`;
      case "count":
        return `# DBSIZE counts the whole database; there is no count for one namespace.\nDBSIZE`;
      case "insert":
        return `SET ${key} "value"`;
      case "update":
        return `HSET ${key} field "value"`;
      case "delete":
      case "drop":
        return `DEL ${key}`;
      case "truncate":
        return `# Delete the keys under ${key}, one SCAN page at a time.\n# FLUSHDB would take the whole database and is refused by this console.\nSCAN 0 MATCH ${key}:* COUNT 100`;
      case "create":
        return `# A key comes into being by writing a value into it.\nSET ${key} "value"`;
      case "grant":
      case "revoke":
        return `# Redis grants permissions per ACL user, not per key.\n# ACL SETUSER <user> on >password ~${key}* +@read`;
    }
  }

  if (language === "javascript") {
    // Mongo: the same intents, in the shell syntax the console speaks.
    switch (template) {
      case "insert":
        return `db.${node.name}.insertOne({ })`;
      case "update":
        return `db.${node.name}.updateMany({ /* filter */ }, { $set: { } })`;
      case "delete":
        return `db.${node.name}.deleteMany({ /* filter — never leave this empty */ })`;
      case "count":
        return `db.${node.name}.countDocuments({})`;
      case "drop":
        return `// Drops the ${node.name} collection and every document in it.\ndb.${node.name}.drop()`;
      case "truncate":
        // Mongo has no TRUNCATE. Emptying a collection while keeping it is a filterless
        // `deleteMany` — the one place this module writes one, because here it is the request.
        return `// Empties ${node.name}, keeping the collection itself.\ndb.${node.name}.deleteMany({})`;
      // No Mongo equivalent, and these are hidden from the menu on this engine (`sqlOnly` in
      // `DbExplorer`'s `GENERATED`). Answered with the reason rather than by falling through to the
      // `find` below, which is what used to happen: a row labelled GRANT that silently drafted a
      // read is worse than one that says the operation does not exist here.
      case "create":
        return `// A collection is created by writing to it — there is no schema to declare.\ndb.createCollection(${JSON.stringify(node.name)})`;
      case "grant":
      case "revoke":
        return `// MongoDB grants roles to a user on a database, not privileges on a collection.\n// Run this against the admin database:\n// db.grantRolesToUser("<user>", [{ role: "readWrite", db: ${JSON.stringify(node.database ?? "<db>")} }])`;
      case "select":
        return `db.${node.name}.find({}).limit(50)`;
    }
  }

  const names = columns.length > 0 ? columns.map((column) => quote(column, kind)) : ["/* columns */"];
  const first = columns[0] ? quote(columns[0], kind) : "/* key */";
  const top = kind === "sqlserver" || kind === "iris";

  switch (template) {
    case "select":
      return top
        ? `SELECT TOP 50 ${names.join(", ")}\nFROM ${target}`
        : `SELECT ${names.join(", ")}\nFROM ${target}\nLIMIT 50`;
    case "count":
      return `SELECT COUNT(*)\nFROM ${target}`;
    case "insert":
      return `INSERT INTO ${target} (${names.join(", ")})\nVALUES (${names.map(() => VALUE).join(", ")})`;
    case "update":
      return `UPDATE ${target}\nSET ${names.map((name) => `${name} = ${VALUE}`).join(",\n    ")}\nWHERE ${first} = ${VALUE}`;
    case "delete":
      // The `WHERE` is part of the draft, not an afterthought: this is the statement where a
      // missing clause is the whole accident.
      return `DELETE FROM ${target}\nWHERE ${first} = ${VALUE}`;
    case "create":
      return columns.length > 0
        ? `CREATE TABLE ${target} (\n${names.map((name) => `  ${name} /* type */`).join(",\n")}\n)`
        : `CREATE TABLE ${target} (\n  /* columns */\n)`;
    case "truncate":
      // Every row, and no clause that could narrow it — which is the whole difference from the
      // `DELETE` above, and worth saying in the draft rather than only in a tooltip.
      return `-- Empties ${node.name}. Every row, no WHERE; the table itself stays.\nTRUNCATE TABLE ${target}`;
    case "drop":
      // `DROP VIEW` on a view: the menu opens on views too, and `DROP TABLE` against one is an
      // error on every engine here — a draft that cannot run is worse than no draft.
      return `-- Drops ${node.name} and everything in it. Not undoable.\nDROP ${
        node.kind === "view" ? "VIEW" : "TABLE"
      } ${target}`;
    case "grant":
      return `GRANT SELECT, INSERT, UPDATE, DELETE\nON ${target}\nTO /* role */`;
    case "revoke":
      return `REVOKE SELECT, INSERT, UPDATE, DELETE\nON ${target}\nFROM /* role */`;
  }
}
