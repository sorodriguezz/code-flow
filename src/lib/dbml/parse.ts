import { importer, Parser } from "@dbml/core";
import { readLayout } from "./layout";
import { sqlToDbml } from "./sqlToDbml";
import {
  EMPTY_SCHEMA,
  qualify,
  type DbmlCardinality,
  type DbmlGroup,
  type DbmlEnum,
  type DbmlField,
  type DbmlIndex,
  type DbmlRef,
  type DbmlSchema,
  type DbmlTable,
} from "./types";

/**
 * DBML in, model out.
 *
 * **The heavy half of `lib/dbml`, and the only module in it that imports `@dbml/core`.** That
 * package is 21 MB on disk and around 15 MB of JavaScript — by a wide margin the largest thing this
 * app can load — so it is quarantined here and every caller reaches it through `import()`. The rest
 * of the folder (the converters, the diff, the formatter, the layout) is ordinary code that runs
 * over the model this produces, and none of it costs anything to import. Breaking that rule does
 * not fail the build; it just puts fifteen megabytes into the startup bundle of an app most of
 * whose users never open a `.dbml` file.
 *
 * **Two parsers, and the second one is not a fallback for bugs.** `@dbml/core` is a PEG parser: it
 * either accepts the whole document or it accepts none of it. A document being *typed* is invalid
 * for most of its life — half a table, an unclosed brace — and a canvas that empties itself on
 * every keystroke is unusable. So a rejected document goes to a forgiving regex reader that
 * recovers whatever tables it can, and the diagram keeps drawing while the error is reported. The
 * error is always the real parser's: it is the one that knows what was wrong and where.
 */

// ---------------------------------------------------------------------------
// The real parser
// ---------------------------------------------------------------------------

/** The shapes `@dbml/core` hands back. Declared here rather than imported: the package's own types
 *  describe its model classes, and what arrives at runtime is a plain-object subset of them. */
interface CoreType {
  type_name?: unknown;
}
interface CoreDefault {
  value?: unknown;
  type?: unknown;
}
interface CoreField {
  name?: unknown;
  type?: CoreType | string;
  pk?: unknown;
  not_null?: unknown;
  unique?: unknown;
  increment?: unknown;
  dbdefault?: CoreDefault | null;
  note?: unknown;
}
interface CoreIndexColumn {
  value?: unknown;
  type?: unknown;
}
interface CoreIndex {
  name?: unknown;
  unique?: unknown;
  pk?: unknown;
  type?: unknown;
  columns?: (CoreIndexColumn | string)[];
}
interface CoreTable {
  name?: unknown;
  alias?: unknown;
  note?: unknown;
  schema?: { name?: unknown };
  fields?: CoreField[];
  indexes?: CoreIndex[];
}
interface CoreEndpoint {
  schemaName?: unknown;
  tableName?: unknown;
  fieldNames?: unknown;
  relation?: unknown;
}
interface CoreRef {
  endpoints?: CoreEndpoint[];
}
interface CoreEnum {
  name?: unknown;
  note?: unknown;
  schema?: { name?: unknown };
  values?: { name?: unknown; note?: unknown }[];
}
interface CoreSchema {
  name?: unknown;
  tables?: CoreTable[];
  enums?: CoreEnum[];
  refs?: CoreRef[];
  tableGroups?: CoreTableGroup[];
}

/** A `TableGroup`. Its `tables` are the table objects themselves, not references to them. */
interface CoreTableGroup {
  name?: unknown;
  note?: unknown;
  tables?: CoreTable[];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** The type as it was written — `varchar(100)`, `decimal(10,2)` — which is what re-emitting needs. */
function typeName(type: CoreType | string | undefined): string {
  if (typeof type === "string") return type;
  return text(type?.type_name, "");
}

/**
 * A default value, requoted for re-emission.
 *
 * `@dbml/core` hands back the *unwrapped* value plus a tag, so `default: 'user'` arrives as
 * `{ value: "user", type: "string" }`. Every consumer of this model writes code — SQL, a decorator,
 * a Prisma attribute — and a string default written without its quotes is a syntax error in all ten
 * of them. Requoting once here is the difference between one correct answer and ten chances to get
 * it wrong.
 */
function defaultValue(dbdefault: CoreDefault | null | undefined): string | null {
  if (!dbdefault || dbdefault.value === undefined || dbdefault.value === null) return null;
  const value = String(dbdefault.value);
  switch (text(dbdefault.type)) {
    case "string":
      return `'${value.replace(/'/g, "\\'")}'`;
    case "expression":
      return `\`${value}\``;
    default:
      return value;
  }
}

function fieldOf(field: CoreField): DbmlField {
  const pk = field.pk === true;
  return {
    name: text(field.name),
    type: typeName(field.type) || "varchar",
    pk,
    // A primary key is not null by definition, and DBML does not make you say so. Deriving it here
    // means the ten emitters below do not each have to remember that rule.
    notNull: field.not_null === true || pk,
    unique: field.unique === true || pk,
    increment: field.increment === true,
    default: defaultValue(field.dbdefault),
    note: text(field.note),
  };
}

function indexOf(index: CoreIndex): DbmlIndex {
  const columns = (index.columns ?? []).map((column) =>
    typeof column === "string" ? column : text(column.value),
  );
  return {
    columns: columns.filter(Boolean),
    unique: index.unique === true,
    pk: index.pk === true,
    name: text(index.name),
    type: text(index.type),
  };
}

function cardinality(relation: unknown): DbmlCardinality {
  return relation === "*" ? "*" : "1";
}

function parseWithCore(source: string): DbmlSchema | null {
  const database = Parser.parse(source, "dbml") as { schemas?: CoreSchema[] };
  const tables: DbmlTable[] = [];
  const enums: DbmlEnum[] = [];
  const refs: DbmlRef[] = [];
  /**
   * References, held back until every table has been read.
   *
   * They cannot be resolved as they are found: an endpoint may name a table declared in a *later*
   * schema, and — the case that actually bit — an endpoint with no schema of its own is not in the
   * schema the reference happens to be filed under. `Ref: shop.line_items.order_id > orders.id`
   * lives on `shop`, and `orders` is in `public`; resolving it against the containing schema
   * invented a `shop.orders` that nothing declares, which then drew as a fifth box joined to
   * nothing. See `resolveEndpoint`.
   */
  const pending: { from: CoreEndpoint; to: CoreEndpoint; scope: string }[] = [];
  const groups: DbmlGroup[] = [];

  for (const schema of database.schemas ?? []) {
    const scope = text(schema.name, "public");
    for (const entry of schema.enums ?? []) {
      enums.push({
        id: qualify(text(entry.schema?.name, scope), text(entry.name)),
        schema: text(entry.schema?.name, scope),
        name: text(entry.name),
        values: (entry.values ?? []).map((value) => ({
          name: text(value.name),
          note: text(value.note),
        })),
      });
    }
    for (const table of schema.tables ?? []) {
      const owner = text(table.schema?.name, scope);
      tables.push({
        id: qualify(owner, text(table.name)),
        schema: owner,
        name: text(table.name),
        alias: typeof table.alias === "string" && table.alias ? table.alias : null,
        note: text(table.note),
        fields: (table.fields ?? []).map(fieldOf),
        indexes: (table.indexes ?? []).map(indexOf),
      });
    }
    for (const ref of schema.refs ?? []) {
      const [from, to] = ref.endpoints ?? [];
      if (!from || !to) continue;
      pending.push({ from, to, scope });
    }
    for (const group of schema.tableGroups ?? []) {
      const label = text(group.name);
      if (!label) continue;
      const [owner, name] = splitQualified(label);
      // A group's members arrive as the *table objects themselves*, each carrying the schema it was
      // declared in — so unlike a ref endpoint there is nothing to guess at here, and no reason to
      // hold them back until every table is read.
      groups.push({
        id: qualify(owner || scope, name),
        schema: owner || scope,
        name,
        note: text(group.note),
        tables: [
          ...new Set(
            (group.tables ?? []).map((member) =>
              qualify(text(member.schema?.name, scope), text(member.name)),
            ),
          ),
        ],
      });
    }
  }

  const known = new Set(tables.map((table) => table.id));
  /** Bare name → the tables carrying it, for an endpoint that named no schema. */
  const byName = new Map<string, string[]>();
  for (const table of tables) {
    const list = byName.get(table.name) ?? [];
    list.push(table.id);
    byName.set(table.name, list);
  }

  for (const { from, to, scope } of pending) {
    const fromId = resolveEndpoint(from, scope, known, byName);
    const toId = resolveEndpoint(to, scope, known, byName);
    const fromFields = Array.isArray(from.fieldNames) ? from.fieldNames.map((f) => String(f)) : [];
    const toFields = Array.isArray(to.fieldNames) ? to.fieldNames.map((f) => String(f)) : [];
    refs.push({
      id: refId(fromId, fromFields, toId, toFields),
      from: { table: fromId, fields: fromFields, relation: cardinality(from.relation) },
      to: { table: toId, fields: toFields, relation: cardinality(to.relation) },
    });
  }

  // A member naming no declared table is dropped rather than kept as a dangling id: the boundary is
  // drawn from where its members ended up, and a member with no box has no position to contribute —
  // it would stretch the group over empty canvas.
  for (const group of groups) group.tables = group.tables.filter((id: string) => known.has(id));

  return { tables, enums, refs, groups, error: null };
}

/**
 * Which declared table an endpoint means.
 *
 * An endpoint that names its schema is unambiguous. One that does not is resolved against what was
 * actually declared, in the order that gets it right: the default schema first — an unqualified
 * name in DBML *is* `public` — then a unique match anywhere, which is what makes
 * `Ref: a.x > b.y` work in a document whose only `b` happens to live in a schema. Only when neither
 * settles it does the containing schema get a say, and by then the answer is a guess either way.
 */
function resolveEndpoint(
  endpoint: CoreEndpoint,
  scope: string,
  known: Set<string>,
  byName: Map<string, string[]>,
): string {
  const name = text(endpoint.tableName);
  const declared = text(endpoint.schemaName);
  if (declared) return qualify(declared, name);
  if (known.has(name)) return name;
  const matches = byName.get(name);
  if (matches && matches.length === 1) return matches[0];
  return qualify(scope, name);
}

/**
 * A reference's identity, built from its endpoints rather than counted.
 *
 * Counting would give a ref a different id every time a table is added above it, which is exactly
 * the moment a hover or a selection is most likely to be live — and the canvas keys its highlight
 * on this. Two references between the same columns cannot exist: `@dbml/core` rejects the document.
 */
function refId(fromTable: string, fromFields: string[], toTable: string, toFields: string[]): string {
  return `${fromTable}.${fromFields.join("+")}->${toTable}.${toFields.join("+")}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface Diagnostic {
  message?: string;
  location?: { start?: { line?: number; column?: number } };
}

/**
 * The message behind a rejected document.
 *
 * `@dbml/core` does not throw plain `Error`s: it throws a `CompilerError` shaped as
 * `{ diags: [...] }`, so `String(e)` and `e.message` both come out as `[object Object]` unless that
 * shape is unpacked. The line and column are kept because they are the whole value of the message —
 * "Expected newline" ten lines from where you are typing is not actionable on its own.
 */
export function formatParseError(error: unknown): string {
  if (error && typeof error === "object" && "diags" in error) {
    const diags = (error as { diags: unknown }).diags;
    if (Array.isArray(diags) && diags.length > 0) {
      return (diags as Diagnostic[])
        .map((diag) => {
          const start = diag.location?.start;
          const at = start?.line ? ` (${start.line}:${start.column ?? 1})` : "";
          return `${diag.message ?? "Parse error"}${at}`;
        })
        .join("\n");
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The line a parse error points at, 1-based, or `null`. What the editor needs to put a marker on it. */
export function errorLine(error: unknown): number | null {
  if (error && typeof error === "object" && "diags" in error) {
    const diags = (error as { diags: Diagnostic[] }).diags;
    const line = Array.isArray(diags) ? diags[0]?.location?.start?.line : undefined;
    if (typeof line === "number" && line > 0) return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The forgiving reader
// ---------------------------------------------------------------------------

/**
 * Whatever can be recovered from a document the real parser refused.
 *
 * Deliberately structural rather than correct: it finds `Table x { … }` blocks and the field lines
 * inside them, and ignores everything it does not recognise. A document mid-keystroke is the case
 * it exists for, so "nine of the ten tables, and the tenth one when you finish typing it" is the
 * right answer — the error from the real parser is on screen the whole time saying what is wrong.
 */
function parseWithRegex(source: string): DbmlSchema {
  const tables: DbmlTable[] = [];
  const enums: DbmlEnum[] = [];
  const refs: DbmlRef[] = [];
  const clean = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const named = (raw: string) => raw.replace(/^["'`]|["'`]$/g, "");

  let match: RegExpExecArray | null;

  const enumBlock = /\benum\s+("[^"]+"|[\w.]+)\s*\{([^}]*)\}/gi;
  while ((match = enumBlock.exec(clean)) !== null) {
    const [scope, name] = splitQualified(named(match[1]));
    enums.push({
      id: qualify(scope, name),
      schema: scope,
      name,
      values: match[2]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !/^note\b/i.test(line))
        .map((line) => ({ name: named(line.replace(/\s*\[.*$/, "")), note: "" })),
    });
  }

  // The body may not cross into the next top-level declaration.
  //
  // Without that guard, a table whose `}` is not at the start of its own line — `Table t { id int }`,
  // which the real parser rejects outright, so this reader is exactly what sees it — runs on until it
  // finds a line-leading `}`, which is the *next* table's. Everything in between is then filed as
  // that first table's columns, inline refs included, and the canvas draws a schema nobody wrote:
  // phantom columns called `Table`, and a relationship attributed to the wrong end. Losing a
  // malformed table is fine and recoverable by typing; inventing a wrong one is neither.
  //
  // The lookahead insists on the `{` of a block header, so a column that happens to be *named*
  // `table` or `enum` does not end the body it lives in.
  const tableBlock =
    /\btable\s+("[^"]+"|[\w.]+)\s*(?:as\s+(\w+)\s*)?\{((?:(?!\n\s*(?:table|enum|ref|tablegroup|project)\s+[^\n{]*\{)[\s\S])*?)\n\}/gi;
  while ((match = tableBlock.exec(clean)) !== null) {
    const [scope, name] = splitQualified(named(match[1]));
    const id = qualify(scope, name);
    const fields: DbmlField[] = [];
    // Note blocks first: they can hold anything, braces and field-shaped lines included.
    const body = match[3]
      .replace(/\bnote\s*:\s*'''[\s\S]*?'''/gi, "")
      .replace(/\bnote\s*:\s*"""[\s\S]*?"""/gi, "")
      .replace(/\bnote\s*:\s*'[^']*'/gi, "")
      .replace(/\bnote\s*:\s*"[^"]*"/gi, "")
      .replace(/\bindexes\s*\{[\s\S]*?\}/gi, "");
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || /^(indexes|note|\{|\})/i.test(line)) continue;
      const field = line.match(
        /^("[^"]+"|\w+)\s+("[^"]+"|[\w."]+(?:\([^)]*\))?(?:\[\])?)\s*(\[[\s\S]*\])?/,
      );
      if (!field) continue;
      const settings = field[3] ?? "";
      const pk = /\bpk\b/i.test(settings) || /\bprimary key\b/i.test(settings);
      const increment = /\bincrement\b/i.test(settings);
      const inline = settings.match(/\bref\s*:\s*([<>-])\s*([\w.]+)\.(\w+)/i);
      if (inline) {
        const [toScope, toName] = splitQualified(inline[2]);
        const toId = qualify(toScope, toName);
        const fieldName = named(field[1]);
        // `>` on this side means many of these to one of those, and `<` the reverse. `-` is
        // one-to-one. The written order is kept, unlike the real parser's, which normalises.
        const here: DbmlCardinality = inline[1] === ">" ? "*" : "1";
        const there: DbmlCardinality = inline[1] === "<" ? "*" : "1";
        refs.push({
          id: refId(id, [fieldName], toId, [inline[3]]),
          from: { table: id, fields: [fieldName], relation: here },
          to: { table: toId, fields: [inline[3]], relation: there },
        });
      }
      fields.push({
        name: named(field[1]),
        type: named(field[2]),
        pk: pk || increment,
        notNull: /\bnot\s+null\b/i.test(settings) || pk || increment,
        unique: /\bunique\b/i.test(settings) || pk || increment,
        increment,
        default: settings.match(/\bdefault\s*:\s*(`[^`]*`|'[^']*'|"[^"]*"|[\w.()]+)/i)?.[1] ?? null,
        note: settings.match(/\bnote\s*:\s*['"]([^'"]*)['"]/i)?.[1] ?? "",
      });
    }
    tables.push({ id, schema: scope, name, alias: match[2] ?? null, note: "", fields, indexes: [] });
  }

  // `TableGroup billing { a\n b }` — a flat list of names, one per line. Same shape as an enum
  // body, so the same `[^}]*` bound applies: a group cannot contain a nested block, and stopping at
  // the first `}` is therefore exactly right here even though it would be wrong for a table.
  const groups: DbmlGroup[] = [];
  const groupBlock = /\btablegroup\s+("[^"]+"|[\w.]+)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/gi;
  while ((match = groupBlock.exec(clean)) !== null) {
    const [scope, name] = splitQualified(named(match[1]));
    const members = match[2]
      .split("\n")
      .map((line) => line.trim().replace(/\s*\[.*$/, ""))
      .filter((line) => line && !/^note\b/i.test(line))
      .map((line) => {
        const [memberScope, memberName] = splitQualified(named(line));
        return qualify(memberScope, memberName);
      });
    groups.push({
      id: qualify(scope, name),
      schema: scope || "public",
      name,
      note: "",
      tables: [...new Set(members)],
    });
  }

  const standalone = /\bref\s*[\w]*\s*:\s*([\w.]+)\.(\w+)\s*([<>-]|<>)\s*([\w.]+)\.(\w+)/gi;
  while ((match = standalone.exec(clean)) !== null) {
    const [fromScope, fromName] = splitQualified(match[1]);
    const [toScope, toName] = splitQualified(match[4]);
    const fromId = qualify(fromScope, fromName);
    const toId = qualify(toScope, toName);
    const symbol = match[3];
    refs.push({
      id: refId(fromId, [match[2]], toId, [match[5]]),
      from: {
        table: fromId,
        fields: [match[2]],
        relation: symbol === ">" || symbol === "<>" ? "*" : "1",
      },
      to: {
        table: toId,
        fields: [match[5]],
        relation: symbol === "<" || symbol === "<>" ? "*" : "1",
      },
    });
  }

  // Both readers can produce the same reference — an inline `ref:` and a standalone `Ref:` for the
  // same pair — and a duplicate would be drawn twice, in the same place, with the same id.
  const seen = new Set<string>();
  const unique = refs.filter((ref) => (seen.has(ref.id) ? false : (seen.add(ref.id), true)));
  // Same rule as the real parser's: a group member that names no recovered table has no box to be
  // drawn around, so it cannot contribute to the boundary.
  const declared = new Set(tables.map((table) => table.id));
  for (const group of groups) group.tables = group.tables.filter((id) => declared.has(id));
  return { tables, enums, refs: unique, groups, error: null };
}

/** `core.users` → `["core", "users"]`; `users` → `["public", "users"]`. */
function splitQualified(raw: string): [string, string] {
  const dot = raw.lastIndexOf(".");
  return dot === -1 ? ["public", raw] : [raw.slice(0, dot), raw.slice(dot + 1)];
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Parses a DBML document — a stored diagram or the contents of a `.dbml` file, either way.
 *
 * The layout marker is stripped first rather than left to the parser. It *is* a comment and the
 * parser does skip it, but stripping it here means the forgiving reader below never sees a line of
 * JSON either, and that reader is not a parser — it is a set of regular expressions that would
 * happily find a `Table` inside a string.
 */
export function parseDbml(doc: string): DbmlSchema {
  const { source } = readLayout(doc);
  if (!source.trim()) return { ...EMPTY_SCHEMA };
  try {
    return parseWithCore(source) ?? { ...EMPTY_SCHEMA };
  } catch (error) {
    // The recovered schema, with the *real* parser's complaint attached. Both halves matter: the
    // tables are what keeps the canvas drawn, and the message is the only thing that says why the
    // one being typed is missing from it.
    const recovered = parseWithRegex(source);
    return { ...recovered, error: formatParseError(error) };
  }
}

// ---------------------------------------------------------------------------
// SQL, through the real importer
// ---------------------------------------------------------------------------

/**
 * SQL DDL to DBML, using `@dbml/core`'s own dialect-aware importer.
 *
 * The same two-tier arrangement as the parser above, for the same reason. The importer is a real
 * grammar per dialect and gets `CHECK` constraints, composite keys and quoted identifiers right —
 * and refuses the whole paste over one statement it cannot read, which is a common way to paste a
 * production dump. `sqlToDbml` is the reader that takes what it can get, and is what answers when
 * the grammar says no.
 *
 * Lives here rather than in `sqlToDbml.ts` because it is the half that costs 15 MB.
 */
export function sqlToDbmlWithCore(sql: string, dialect: SqlImportDialect): string {
  if (!sql.trim()) return "";
  try {
    const converted = importer.import(sql, dialect);
    if (converted.trim()) return converted;
  } catch {
    // Falls through to the forgiving reader, which is the point of having one.
  }
  return sqlToDbml(sql);
}

/** The dialects `@dbml/core`'s importer knows. `postgres` is the default a paste is read as. */
export type SqlImportDialect = "postgres" | "mysql" | "mssql" | "oracle" | "snowflake";
