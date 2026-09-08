/**
 * A `DbmlSchema` as SQLite DDL — the one translation between "what you drew" and "a database you
 * can type rows into".
 *
 * It lives on the frontend because the parsed schema does. The backend (`sandbox.rs`) runs the text
 * this produces and reports what SQLite said; it never reads DBML.
 *
 * Three things make this more than a `join("\n")`, and each of them is a bug that would otherwise
 * ship silently:
 *
 * 1. **SQLite's affinity does not reject anything.** `'abc'` in an `INTEGER` column is stored as
 *    text; `typeof()` says `text`. A grid that claims to validate "by the engine" would therefore
 *    validate no types at all. So every numeric column carries a named `CHECK`, and the name is
 *    what turns `CHECK constraint failed: ck_usuarios_edad_type` back into a message pinned to a
 *    cell. The names cannot be taken apart afterwards — `_` is legal in identifiers — so the map
 *    from name to meaning is built here and stored in the file.
 * 2. **Not every id is an integer**, and SQLite has three separate traps for that. See
 *    `sqliteType` and `DEFAULT_SHELF` below; all three are measured, and all three are silent.
 * 3. **A composite primary key is only visible on `DbmlIndex.pk`.** When a table declares one, its
 *    fields come back with `pk`, `unique` and `notNull` all false. Reading the fields alone
 *    produces a table with no key, and then every reference into it is a `foreign key mismatch`
 *    against a model that was correct.
 *
 * There is no target engine — this is a simulation for trying data and queries out, not a fidelity
 * check against a deployment — so the warnings here are only the ones that *block* you. Nothing is
 * reported for "Postgres would have done this differently".
 */

import type { DbmlEndpoint, DbmlField, DbmlRef, DbmlSchema, DbmlTable } from "./types";

/** What a named CHECK meant, so an engine error can be turned back into a sentence about a cell. */
export interface ConstraintNote {
  table: string;
  column: string;
  rule: "type" | "enum" | "length";
  /** For `enum`, the values; for `length`, the maximum; for `type`, the family name. */
  detail: string;
}

/** Something the build could not do, or did differently than the document asked. */
export interface SqliteWarning {
  /** The qualified table id, so the panel can point at it. */
  table: string;
  column: string | null;
  /** A translation key under `dbml.sandbox.warn.*`. */
  code:
    | "increment"
    | "manyToMany"
    | "defaultDropped"
    | "refMissing"
    | "refNotUnique"
    | "refWidth"
    | "noTables";
  /** Whatever the message needs to name — a column, an expression, the other table. */
  detail: string;
}

export interface SqliteBuild {
  ddl: string;
  constraints: Record<string, ConstraintNote>;
  warnings: SqliteWarning[];
  /** Changes exactly when something that shapes the database changes. See `fingerprint`. */
  fingerprint: string;
  /** Table ids in the order they were emitted: parents before children. The rail's order. */
  order: string[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Declared types that SQLite does not recognise and therefore gives **NUMERIC affinity** — which
 * silently eats text ids that look like numbers.
 *
 * Measured, column by column: `INSERT INTO t VALUES ('0012')` into a `uuid` column stores the
 * *integer* 12. The leading zeros are gone and `typeof` says `integer`. `varchar`, `text`, `char`
 * and `citext` all carry TEXT affinity already and are fine.
 *
 * A `CHECK (typeof(c) = 'text')` does **not** fix this: affinity converts before the check runs, so
 * a perfectly legitimate `'0012'` would come back as a constraint failure. The only fix is to give
 * the column TEXT affinity, which means the emitted type has to contain `CHAR`, `CLOB` or `TEXT`.
 */
const TEXT_AFFINITY_NEEDED = new Set([
  "uuid",
  "guid",
  "ulid",
  "cuid",
  "nanoid",
  "json",
  "jsonb",
  "xml",
  "inet",
  "cidr",
  "macaddr",
  "money",
  "bit",
  "enum",
]);

const INT_FAMILY = /^(int|integer|int2|int4|int8|smallint|mediumint|bigint|serial|bigserial|smallserial)$/;
const REAL_FAMILY = /^(real|float|float4|float8|double|double precision|numeric|decimal|money)$/;
const BOOL_FAMILY = /^(bool|boolean)$/;

/** The bare type name, lowercased, without its arguments: `varchar(100)` → `varchar`. */
function baseType(type: string): string {
  return type.replace(/\[\]$/, "").replace(/\(.*$/, "").trim().toLowerCase();
}

export type Family = "integer" | "real" | "boolean" | "text";

/**
 * Which family a declared type belongs to.
 *
 * Exported because the grid has to agree with the emitter about exactly one thing: whether a
 * single-column key autonumbers. It does when the emitter writes `INTEGER PRIMARY KEY`, and that
 * decision is made here — a second regular expression in the grid drifted from this one on
 * `mediumint` and `bigserial` before it was pulled out.
 */
export function familyOf(type: string): Family {
  const base = baseType(type);
  if (INT_FAMILY.test(base)) return "integer";
  if (REAL_FAMILY.test(base)) return "real";
  if (BOOL_FAMILY.test(base)) return "boolean";
  return "text";
}

/**
 * Whether this column is the one SQLite will fill on its own.
 *
 * True exactly when the emitter writes `INTEGER PRIMARY KEY`: a single-column key of an integer
 * family, declared inline rather than as a composite index. Note that `increment` is **not** part
 * of it — an `INTEGER PRIMARY KEY` autonumbers whether or not the document asked it to, so a grid
 * that required `increment` would offer you a cell the engine is about to overwrite.
 */
export function isRowidAlias(table: DbmlTable, field: DbmlField): boolean {
  const pkIndex = table.indexes.find((index) => index.pk && index.columns.length > 0);
  if (pkIndex) return false;
  const keys = table.fields.filter((entry) => entry.pk).map((entry) => entry.name);
  return keys.length === 1 && keys[0] === field.name && familyOf(field.type) === "integer";
}

/**
 * The type to emit, which is not always the type that was written.
 *
 * Two rewrites, both measured, both silent if skipped:
 *
 * - **`INT PRIMARY KEY` is not `INTEGER PRIMARY KEY`.** Only the exact word `INTEGER` aliases the
 *   rowid. DBML writes `int`, so an omitted id on an `INT PRIMARY KEY` stores `null` instead of
 *   autonumbering — the column the user thought was automatic is empty and the next insert fails
 *   the key. So a single-column integer key is emitted as the exact word, arguments dropped.
 * - **An unrecognised type falls to NUMERIC affinity.** `TEXT` is emitted with the real type kept
 *   as a comment: the affinity is right, `pragma_table_info` reports `TEXT`, and `sqlite_master`
 *   stores the comment verbatim — so the DDL still reads like the model it came from, which is the
 *   property that ruled out `STRICT` tables.
 */
function sqliteType(field: DbmlField, isSoleIntegerKey: boolean): string {
  if (isSoleIntegerKey) return "INTEGER";
  const base = baseType(field.type);
  if (TEXT_AFFINITY_NEEDED.has(base)) return `TEXT /* ${field.type} */`;
  // An array type has no SQLite equivalent at all; text is the honest carrier, and the original is
  // kept in the comment for the same reason as above.
  if (field.type.trim().endsWith("[]")) return `TEXT /* ${field.type} */`;
  return field.type.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default expressions we can carry across, and what they become.
 *
 * The translation shelf exists because of a measured trap: SQLite does **not** validate the
 * functions in a `DEFAULT` when the table is created. `DEFAULT (gen_random_uuid())` builds clean
 * and then fails *every* insert with `unknown function` — a message that says nothing about the
 * user's model. So an expression that is not on this shelf is refused **here**, at build time, with
 * a warning that names it.
 *
 * The UUID replacement is pure SQLite and produces the right v4 shape — measured, it returns
 * `059517c8-3534-48ca-b762-c62d78b651b0`.
 */
const UUID_V4 =
  "lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||" +
  "substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||" +
  "substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))";

const DEFAULT_SHELF: Record<string, string> = {
  "now()": "CURRENT_TIMESTAMP",
  "current_timestamp": "CURRENT_TIMESTAMP",
  "current_timestamp()": "CURRENT_TIMESTAMP",
  "getdate()": "CURRENT_TIMESTAMP",
  "current_date": "CURRENT_DATE",
  "current_date()": "CURRENT_DATE",
  "current_time": "CURRENT_TIME",
  "gen_random_uuid()": UUID_V4,
  "uuid_generate_v4()": UUID_V4,
  "uuid()": UUID_V4,
  "newid()": UUID_V4,
  "true": "1",
  "false": "0",
  "null": "NULL",
};

/** `null` when there is no default; `{ sql }` when it can be carried; `{ dropped }` when it can't. */
function translateDefault(raw: string | null): { sql: string } | { dropped: string } | null {
  if (raw === null) return null;
  // **The backticks come through.** `DbmlField.default` is documented as "as it should be
  // re-emitted", and for a string or a number it is — but DBML marks an *expression* default with
  // backticks and the parser hands them back attached: `now()` arrives as "`now()`", not "now()".
  // Looked up with them on, every expression on the shelf missed, and every one of them was
  // dropped with a warning — which is how a `uuid` key ended up NULL on a row that should have
  // filled itself. Stripping them is also what identifies an expression in the first place.
  const value = raw.trim().replace(/^`(.*)`$/s, "$1").trim();
  if (value === "") return null;
  const known = DEFAULT_SHELF[value.toLowerCase()];
  if (known !== undefined) return { sql: `(${known})` };
  // A quoted string or a number is already a literal SQLite understands. The parser has already
  // done the requoting (`DbmlField.default` is documented as "as it should be re-emitted"), so this
  // only has to recognise the shapes rather than produce them.
  if (/^'([^']|'')*'$/.test(value)) return { sql: value };
  if (/^-?\d+(\.\d+)?$/.test(value)) return { sql: value };
  // Anything else that is a bare word is an identifier or a keyword we don't know; anything with
  // parentheses is a function call we can't run. Both are dropped with a warning rather than
  // emitted, because emitting one builds a table that rejects every row.
  return { dropped: value };
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The one physical table name for a DBML table id.
 *
 * SQLite has no schemas inside one file, so `core.usuarios` and `shop.usuarios` would collide. The
 * separator is flattened rather than dropped: `core.usuarios` becomes `core.usuarios` *as a single
 * identifier*, quoted — which keeps the name the user reads in the rail identical to the name they
 * write in the console, and keeps two schemas' same-named tables apart.
 */
const physical = (tableId: string) => tableId;

/** A constraint name, and the map entry that says what it meant. Never parsed back apart. */
function constraintName(kind: string, table: string, column: string): string {
  return `ck_${table}_${column}_${kind}`.replace(/[^A-Za-z0-9_.]/g, "_");
}

// ---------------------------------------------------------------------------
// Which end holds the key
// ---------------------------------------------------------------------------

/**
 * Which end of a reference is the child (holds the foreign key) and which is the parent.
 *
 * **`from` is not the child.** Measured against this repository's own parser, the position flips
 * with how the reference was written:
 *
 * | written                     | `from`            | `to`              |
 * |-----------------------------|-------------------|-------------------|
 * | `pid integer [ref: > p.id]` | `p.id` **parent** | `c.pid` child     |
 * | `Ref: c.pid > p.id`         | `c.pid` child     | `p.id` **parent** |
 * | `Ref: p.id < c.pid`         | `p.id` **parent** | `c.pid` child     |
 *
 * The inline form is the one most people write, and it is the one that is reversed. Emitting a
 * foreign key off `from` produces a constraint pointing the wrong way — a *different* constraint,
 * which is worse than a missing one, and one that no error message would ever explain.
 *
 * The **relation** is what is reliable: the `*` end holds the key. For `1-1`, where it says
 * nothing, the tiebreak is that a foreign key must point at something unique — so the end whose
 * column is a primary key is the parent. If that is still a tie, `to` is taken as the parent, which
 * is the reading of the explicit `Ref:` form somebody wrote deliberately.
 */
export function orientRef(
  schema: DbmlSchema,
  ref: DbmlRef,
): { child: DbmlEndpoint; parent: DbmlEndpoint } | null {
  // Many-to-many needs a junction table; neither end holds a key.
  if (ref.from.relation === "*" && ref.to.relation === "*") return null;
  if (ref.from.relation === "*") return { child: ref.from, parent: ref.to };
  if (ref.to.relation === "*") return { child: ref.to, parent: ref.from };

  const keyed = (endpoint: DbmlEndpoint): boolean => {
    const table = schema.tables.find((entry) => entry.id === endpoint.table);
    if (!table) return false;
    const pkIndex = table.indexes.find((index) => index.pk && index.columns.length > 0);
    const keys = pkIndex ? pkIndex.columns : table.fields.filter((field) => field.pk).map((f) => f.name);
    return endpoint.fields.every((field) => keys.includes(field));
  };
  const fromKeyed = keyed(ref.from);
  const toKeyed = keyed(ref.to);
  if (fromKeyed && !toKeyed) return { child: ref.to, parent: ref.from };
  if (toKeyed && !fromKeyed) return { child: ref.from, parent: ref.to };
  return { child: ref.from, parent: ref.to };
}

/** Every reference whose foreign key sits on `tableId`. The question four call sites ask. */
export function refsFrom(
  schema: DbmlSchema,
  tableId: string,
): { ref: DbmlRef; child: DbmlEndpoint; parent: DbmlEndpoint }[] {
  const out: { ref: DbmlRef; child: DbmlEndpoint; parent: DbmlEndpoint }[] = [];
  for (const ref of schema.refs) {
    const oriented = orientRef(schema, ref);
    if (oriented && oriented.child.table === tableId) out.push({ ref, ...oriented });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Tables with their parents before them, cycles tolerated.
 *
 * The rail promises "parents first" so you land on the table you can actually fill. A cycle —
 * `usuarios.org_id → orgs` and `orgs.owner_id → usuarios`, a real and common shape — makes that
 * promise unsatisfiable, and the caller is told so via `cyclic` rather than being handed an order
 * that quietly is not one.
 */
export function orderTables(schema: DbmlSchema): { order: string[]; cyclic: string[] } {
  const parents = new Map<string, Set<string>>();
  for (const table of schema.tables) parents.set(table.id, new Set());
  for (const ref of schema.refs) {
    const oriented = orientRef(schema, ref);
    if (!oriented) continue;
    const child = parents.get(oriented.child.table);
    if (child && oriented.parent.table !== oriented.child.table) {
      child.add(oriented.parent.table);
    }
  }
  const order: string[] = [];
  const placed = new Set<string>();
  let moved = true;
  while (moved) {
    moved = false;
    for (const table of schema.tables) {
      if (placed.has(table.id)) continue;
      const missing = [...(parents.get(table.id) ?? [])].some(
        (parent) => parents.has(parent) && !placed.has(parent),
      );
      if (missing) continue;
      placed.add(table.id);
      order.push(table.id);
      moved = true;
    }
  }
  const cyclic = schema.tables.map((table) => table.id).filter((id) => !placed.has(id));
  return { order: [...order, ...cyclic], cyclic };
}

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------

export function toSqliteDdl(schema: DbmlSchema): SqliteBuild {
  const warnings: SqliteWarning[] = [];
  const constraints: Record<string, ConstraintNote> = {};
  const enumValues = new Map(schema.enums.map((entry) => [entry.id, entry.values.map((v) => v.name)]));
  const byId = new Map(schema.tables.map((table) => [table.id, table]));
  const { order } = orderTables(schema);
  const statements: string[] = [];

  if (schema.tables.length === 0) {
    warnings.push({ table: "", column: null, code: "noTables", detail: "" });
  }

  /** Which columns on a table are unique enough to be a reference target. */
  const uniqueColumns = (table: DbmlTable): Set<string> => {
    const unique = new Set<string>();
    for (const field of table.fields) {
      if (field.pk || field.unique) unique.add(field.name);
    }
    for (const index of table.indexes) {
      if ((index.unique || index.pk) && index.columns.length === 1) unique.add(index.columns[0]);
    }
    return unique;
  };

  for (const id of order) {
    const table = byId.get(id);
    if (!table) continue;

    // The composite key, read from `indexes` — the only place it appears. Getting this wrong is the
    // easiest bug in the file to ship: the fields would all say `pk: false` and the table would
    // come out with no key at all.
    const pkIndex = table.indexes.find((index) => index.pk && index.columns.length > 0);
    const inlineKeys = table.fields.filter((field) => field.pk).map((field) => field.name);
    const keyColumns = pkIndex ? pkIndex.columns : inlineKeys;
    const soleKey = keyColumns.length === 1 ? keyColumns[0] : null;

    const lines: string[] = [];
    for (const field of table.fields) {
      const family = familyOf(field.type);
      // Only a *single-column* integer key becomes the rowid alias. A composite key that happens to
      // contain an integer must not, or `PRIMARY KEY (a, b)` would be declared twice.
      const soleIntegerKey = field.name === soleKey && family === "integer" && !pkIndex;
      const parts = [quote(field.name), sqliteType(field, soleIntegerKey)];

      if (field.name === soleKey && !pkIndex) parts.push("PRIMARY KEY");
      // `increment` never becomes `AUTOINCREMENT`. On an `INTEGER PRIMARY KEY` it is redundant —
      // SQLite already fills the rowid — and on anything else it is the DDL error
      // `AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`, which would fail the whole
      // build. That case is worth *saying*, so it is a warning rather than a silent drop.
      if (field.increment && !soleIntegerKey) {
        warnings.push({ table: id, column: field.name, code: "increment", detail: field.type });
      }
      // A key is not-null by definition, and declaring it again on the rowid alias is harmless
      // (measured: `INTEGER PRIMARY KEY NOT NULL` still autonumbers on an omitted insert).
      if (field.notNull && field.name !== soleKey) parts.push("NOT NULL");
      if (field.unique && field.name !== soleKey) parts.push("UNIQUE");

      const fallback = translateDefault(field.default);
      if (fallback && "sql" in fallback) {
        parts.push(`DEFAULT ${fallback.sql}`);
      } else if (fallback) {
        warnings.push({
          table: id,
          column: field.name,
          code: "defaultDropped",
          detail: fallback.dropped,
        });
      }

      // The typed CHECK. Only for the families where affinity is not enough — a text column holds
      // text whatever you put in it, so there is nothing to check and nothing to say.
      if (family === "integer" || family === "real" || family === "boolean") {
        const name = constraintName("type", id, field.name);
        const column = quote(field.name);
        const test =
          family === "integer"
            ? `typeof(${column}) = 'integer'`
            : family === "real"
              ? `typeof(${column}) IN ('integer','real')`
              : `${column} IN (0,1)`;
        parts.push(`CONSTRAINT ${quote(name)} CHECK (${column} IS NULL OR ${test})`);
        constraints[name] = { table: id, column: field.name, rule: "type", detail: family };
      }

      // A DBML enum becomes a value list. SQLite has no enum type, and this is the whole of the
      // difference: the values still reject anything outside them, with a named constraint.
      const values = enumValues.get(baseTypeId(field.type, schema));
      if (values && values.length > 0) {
        const name = constraintName("enum", id, field.name);
        const column = quote(field.name);
        const list = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
        parts.push(`CONSTRAINT ${quote(name)} CHECK (${column} IS NULL OR ${column} IN (${list}))`);
        constraints[name] = {
          table: id,
          column: field.name,
          rule: "enum",
          detail: values.join(", "),
        };
      }

      // `varchar(100)` is a length the user wrote down, and one they will want tested — SQLite
      // itself ignores it entirely.
      const length = /\(\s*(\d+)\s*\)/.exec(field.type);
      if (length && family === "text" && !values) {
        const name = constraintName("len", id, field.name);
        const column = quote(field.name);
        parts.push(
          `CONSTRAINT ${quote(name)} CHECK (${column} IS NULL OR length(${column}) <= ${length[1]})`,
        );
        constraints[name] = {
          table: id,
          column: field.name,
          rule: "length",
          detail: length[1],
        };
      }

      lines.push(`  ${parts.join(" ")}`);
    }

    if (pkIndex) {
      lines.push(`  PRIMARY KEY (${pkIndex.columns.map(quote).join(", ")})`);
    }

    // Many-to-many, reported once from whichever table the endpoint names. DBML writes it as one
    // line; a database needs a junction table, and inventing one would be inventing a table the
    // user did not draw.
    for (const ref of schema.refs) {
      if (ref.from.relation !== "*" || ref.to.relation !== "*") continue;
      if (ref.from.table !== id) continue;
      warnings.push({ table: id, column: null, code: "manyToMany", detail: ref.to.table });
    }

    // Foreign keys, as table-level constraints so a composite one can name all its columns.
    // `refsFrom` and not `ref.from.table === id`: which end holds the key depends on how the
    // reference was written, not on which slot it landed in. See `orientRef`.
    for (const { child, parent: end } of refsFrom(schema, id)) {
      const parent = byId.get(end.table);
      if (!parent) {
        warnings.push({
          table: id,
          column: child.fields[0] ?? null,
          code: "refMissing",
          detail: end.table,
        });
        continue;
      }
      if (child.fields.length !== end.fields.length || child.fields.length === 0) {
        warnings.push({
          table: id,
          column: child.fields[0] ?? null,
          code: "refWidth",
          detail: end.table,
        });
        continue;
      }
      // A reference into a column that is not unique is a `foreign key mismatch` — reported by
      // SQLite only when something touches the table, and by then it reads like a data error. Said
      // here, against the model, where it is a modelling answer.
      const unique = uniqueColumns(parent);
      const composite = parent.indexes.some(
        (index) =>
          (index.pk || index.unique) &&
          index.columns.length === end.fields.length &&
          end.fields.every((field) => index.columns.includes(field)),
      );
      if (!composite && end.fields.some((field) => !unique.has(field))) {
        warnings.push({
          table: id,
          column: child.fields[0] ?? null,
          code: "refNotUnique",
          detail: `${end.table}.${end.fields.join(", ")}`,
        });
      }
      lines.push(
        `  FOREIGN KEY (${child.fields.map(quote).join(", ")}) ` +
          `REFERENCES ${quote(physical(parent.id))} (${end.fields.map(quote).join(", ")})`,
      );
    }

    statements.push(`CREATE TABLE ${quote(physical(id))} (\n${lines.join(",\n")}\n);`);

    // Secondary indexes. The primary-key one is already expressed above, so it is skipped rather
    // than emitted twice.
    for (const index of table.indexes) {
      if (index.pk || index.columns.length === 0) continue;
      const name = (index.name || `idx_${id}_${index.columns.join("_")}`).replace(
        /[^A-Za-z0-9_.]/g,
        "_",
      );
      statements.push(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(name)} ` +
          `ON ${quote(physical(id))} (${index.columns.map(quote).join(", ")});`,
      );
    }
  }

  return {
    ddl: statements.join("\n\n"),
    constraints,
    warnings,
    fingerprint: fingerprint(schema),
    order,
  };
}

/**
 * The enum a field's type names, as a qualified id — or `undefined`.
 *
 * A field typed `rol` in schema `core` means `core.rol` if that enum exists there and `rol`
 * otherwise, which is the same resolution the parser does for tables. Written out rather than
 * matched on the bare name, because two schemas may each declare a `status`.
 */
function baseTypeId(type: string, schema: DbmlSchema): string {
  const bare = type.replace(/\(.*$/, "").trim();
  if (schema.enums.some((entry) => entry.id === bare)) return bare;
  const match = schema.enums.find((entry) => entry.name === bare);
  return match ? match.id : bare;
}

/**
 * A hash of everything that shapes the database, and nothing that does not.
 *
 * Positions, notes and colours move constantly while a diagram is being drawn; none of them can
 * make a row invalid. Comparing whole documents would put the drift bar on screen every time
 * somebody dragged a box, which is the fastest way to teach a user to ignore it.
 */
export function fingerprint(schema: DbmlSchema): string {
  const shape = schema.tables
    .map((table) =>
      [
        table.id,
        table.fields
          .map((field) =>
            [
              field.name,
              field.type,
              field.pk ? "p" : "",
              field.notNull ? "n" : "",
              field.unique ? "u" : "",
              field.increment ? "i" : "",
              field.default ?? "",
            ].join(":"),
          )
          .join(","),
        table.indexes
          .map((index) => `${index.columns.join("+")}${index.unique ? "u" : ""}${index.pk ? "p" : ""}`)
          .join(","),
      ].join("|"),
    )
    .join(";");
  const refs = schema.refs
    .map((ref) =>
      [ref.from.table, ref.from.fields.join("+"), ref.to.table, ref.to.fields.join("+")].join(">"),
    )
    .sort()
    .join(";");
  const enums = schema.enums
    .map((entry) => `${entry.id}=${entry.values.map((value) => value.name).join(",")}`)
    .join(";");
  return hash(`${shape}#${refs}#${enums}`);
}

/** FNV-1a, as 8 hex characters. Not a security hash — an equality test that fits in a row. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Reading the engine back
// ---------------------------------------------------------------------------

/** An engine error, turned into something that can be pinned to one cell. */
export interface CellFailure {
  table: string | null;
  column: string | null;
  /** A translation key under `dbml.sandbox.cell.*`. */
  code: "notNull" | "unique" | "type" | "enum" | "length" | "foreignKey" | "check" | "other";
  detail: string;
}

/**
 * What SQLite said, as a table, a column and a reason.
 *
 * The two shapes it has to read are genuinely different: `NOT NULL constraint failed: usuarios.email`
 * carries a dotted path, and `CHECK constraint failed: ck_usuarios_edad_type` carries a name that
 * cannot be taken apart — `_` is legal in identifiers, so `ck_perfil_usuario_nombre_len` has two
 * valid readings. Hence `notes`, built at build time and stored in the file.
 *
 * And a third that carries nothing at all: measured, a foreign key violation is exactly
 * `FOREIGN KEY constraint failed`, with no table, column or value. Naming the offending column is
 * the caller's job — it probes the parents before inserting — so this reports the code and leaves
 * the column `null`.
 */
export function readFailure(
  message: string,
  notes: Record<string, ConstraintNote>,
): CellFailure {
  const check = /CHECK constraint failed:\s*(\S+)/i.exec(message);
  if (check) {
    const note = notes[check[1]];
    if (note) {
      return { table: note.table, column: note.column, code: note.rule, detail: note.detail };
    }
    return { table: null, column: null, code: "check", detail: check[1] };
  }
  const notNull = /NOT NULL constraint failed:\s*(.+?)\.([^.\s]+)\s*$/i.exec(message);
  if (notNull) return { table: notNull[1], column: notNull[2], code: "notNull", detail: "" };
  const unique = /UNIQUE constraint failed:\s*(.+)$/i.exec(message);
  if (unique) {
    // A multi-column unique index reports every column: `t.a, t.b`. The first one is where the
    // caret goes; the whole list is the detail, because "these two together must be unique" is a
    // different sentence from "this must be unique".
    const columns = unique[1].split(",").map((entry) => entry.trim());
    const first = /^(.+)\.([^.\s]+)$/.exec(columns[0] ?? "");
    return {
      table: first ? first[1] : null,
      column: first ? first[2] : null,
      code: "unique",
      detail: columns.join(", "),
    };
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return { table: null, column: null, code: "foreignKey", detail: "" };
  }
  return { table: null, column: null, code: "other", detail: message };
}
