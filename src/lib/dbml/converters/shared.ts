import { describeRef, orientReference, primaryKeyOf } from "../orient";
import type { DbmlField, DbmlSchema, DbmlTable } from "../types";

/**
 * What every code generator needs and none of them should work out for itself.
 *
 * Ten emitters over one model, and the three things they all got wrong independently are here:
 * which end of a reference holds the foreign key, what a type's base name is once its arguments are
 * stripped, and what a `snake_case` table is called in a language that capitalises. Each of those
 * having ten answers is how a schema converts to Prisma one way and to Drizzle another.
 */

/** `user_roles` → `UserRoles`. */
export function pascal(name: string): string {
  return name
    .replace(/[^\w]/g, "_")
    .replace(/_([a-z0-9])/gi, (_, char: string) => char.toUpperCase())
    .replace(/^\w/, (char) => char.toUpperCase());
}

/** `user_roles` → `userRoles`. */
export function camel(name: string): string {
  const upper = pascal(name);
  return upper.charAt(0).toLowerCase() + upper.slice(1);
}

/** `varchar(100)` → `varchar`; `text[]` → `text`. The key every type table is keyed by. */
export function baseType(type: string): string {
  return type
    .replace(/\(.*\)/, "")
    .replace(/\[\]/g, "")
    .toLowerCase()
    .trim();
}

/** The `100` of `varchar(100)`, or `null`. */
export function lengthOf(type: string): string | null {
  return type.match(/\((\d+)\)/)?.[1] ?? null;
}

/** The `10, 2` of `decimal(10,2)`, or `null`. */
export function precisionOf(type: string): [string, string] | null {
  const match = type.match(/\((\d+)\s*,\s*(\d+)\)/);
  return match ? [match[1], match[2]] : null;
}

/**
 * Whether a field may be omitted — a primary key never can, whatever the document says. Pass the
 * table to have the columns of a composite key counted too.
 */
export function isOptional(field: DbmlField, table?: DbmlTable): boolean {
  return !field.notNull && !field.pk && !(table && isKeyColumn(table, field));
}

/**
 * The name a *class* gets, which is not always the table's own.
 *
 * `core.users` and `shop.users` are two tables and must be two classes, so a qualified table
 * contributes its schema to the name. The physical name — what goes in `@@map`, `TableName()`,
 * `Schema::create` — stays `table.name`, because that is what the database is called.
 */
export function codeName(table: DbmlTable): string {
  return table.schema === "public" ? table.name : `${table.schema}_${table.name}`;
}

/**
 * A table's primary key when it spans several columns, else `null`.
 *
 * DBML says it two ways — `indexes { (shop_id, number) [pk] }`, or `[pk]` on more than one column —
 * and the generators knew neither: the first produced a table with no key at all, the second one
 * `PRIMARY KEY` per column, which no database accepts. A composite foreign key is only valid against
 * a composite key, so the one could not be fixed without the other.
 */
export function compositeKey(table: DbmlTable): string[] | null {
  const key = primaryKeyOf(table);
  return key.length > 1 ? key : null;
}

/** Whether a column is (part of) its table's primary key, however the key was declared. */
export function isKeyColumn(table: DbmlTable, field: DbmlField): boolean {
  return field.pk || (compositeKey(table)?.includes(field.name) ?? false);
}

/** Which way round a reference goes, in the vocabulary the generators think in. */
export type RelationKind = "many-to-one" | "one-to-one" | "many-to-many";

/**
 * A reference, oriented.
 *
 * **`fk` is always the side that holds the foreign key** — the many side of a one-to-many, and the
 * side the evidence names for a one-to-one (see `orientReference`: never the side that happened to
 * be written first). DBML lets a relationship be written from either end, and every generator here
 * needs it the same way round: the FK side is where a column exists and where the join belongs.
 *
 * **The columns are lists.** A composite reference — `Ref: lines.(shop_id, order_num) >
 * orders.(shop_id, num)` — is legal DBML, and reading only the first column emitted a foreign key
 * over half the key, which is a constraint that rejects valid rows. `fkFields[i]` references
 * `pkFields[i]`. For a many-to-many the two ends are simply `from` and `to`.
 */
export interface CodegenRef {
  fkTable: DbmlTable;
  fkFields: string[];
  pkTable: DbmlTable;
  pkFields: string[];
  kind: RelationKind;
}

/** Whether a reference joins on more than one column. */
export function isComposite(ref: CodegenRef): boolean {
  return ref.fkFields.length > 1;
}

/**
 * The name a relation property is derived from: the key column for a single-column reference
 * (`author_id` → `author`), the referenced table for a composite one, where no one column speaks
 * for the join.
 */
export function relationStem(ref: CodegenRef): string {
  return ref.fkFields.length === 1 ? ref.fkFields[0] : ref.pkTable.name;
}

/**
 * The schema's references, oriented and resolved to their tables.
 *
 * A reference to a table that is not in the document is dropped rather than emitted against a
 * missing class: `@dbml/core` rejects those outright, so one only reaches here from the forgiving
 * reader, mid-keystroke, and half a class is worse output than one fewer. A one-to-one whose
 * orientation the schema cannot settle is dropped too — see `codegenFindings`, which is how it is
 * reported rather than silently missing.
 */
export function codegenRefs(schema: DbmlSchema): CodegenRef[] {
  const byId = new Map(schema.tables.map((table) => [table.id, table]));
  const refs: CodegenRef[] = [];
  for (const ref of schema.refs) {
    const from = byId.get(ref.from.table);
    const to = byId.get(ref.to.table);
    if (!from || !to) continue;
    if (ref.from.fields.length === 0 || ref.to.fields.length === 0) continue;
    if (ref.from.fields.length !== ref.to.fields.length) continue;

    const oriented = orientReference(schema, ref);
    if (oriented.kind === "ambiguous") continue;
    if (oriented.kind === "many-to-many") {
      refs.push({
        fkTable: from,
        fkFields: ref.from.fields,
        pkTable: to,
        pkFields: ref.to.fields,
        kind: "many-to-many",
      });
      continue;
    }
    const child = byId.get(oriented.child.table);
    const parent = byId.get(oriented.parent.table);
    if (!child || !parent) continue;
    refs.push({
      fkTable: child,
      fkFields: oriented.child.fields,
      pkTable: parent,
      pkFields: oriented.parent.fields,
      kind: oriented.kind,
    });
  }
  return refs;
}

/**
 * The references a generator had to leave out, as sentences — printed as comments at the top of
 * the generated file, because a relationship that silently is not there reads as a generator bug
 * and one that is there the wrong way round is worse.
 */
export function codegenFindings(schema: DbmlSchema): string[] {
  const known = new Set(schema.tables.map((table) => table.id));
  const findings: string[] = [];
  for (const ref of schema.refs) {
    if (!known.has(ref.from.table) || !known.has(ref.to.table)) continue;
    if (ref.from.fields.length !== ref.to.fields.length) {
      findings.push(
        `Skipped ${describeRef(ref)}: the two ends name a different number of columns.`,
      );
      continue;
    }
    if (orientReference(schema, ref).kind !== "ambiguous") continue;
    findings.push(
      `Skipped ${describeRef(ref)}: a one-to-one where nothing says which side holds the key — ` +
        "make only one end the primary key, or mark the foreign-key column unique.",
    );
  }
  return findings;
}

/** The findings as comment lines, followed by a blank line, or nothing at all. */
export function findingLines(schema: DbmlSchema, comment = "//"): string[] {
  const findings = codegenFindings(schema);
  if (findings.length === 0) return [];
  return [...findings.map((finding) => `${comment} ${finding}`), ""];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * A column default, classified — what every emitter needs to know before it can write one.
 *
 * `DbmlField.default` is kept *as DBML wrote it* (the sandbox depends on that — see
 * `codeflow-dbml-sandbox`): `` `now()` `` with its backticks, `'user'` with its quotes, `0` bare. The
 * backticks are the whole difference between an expression and a value, and every emitter that
 * copied the string through got it wrong in its own way: the DDL printed `DEFAULT \`now()\``, which
 * no database parses, and TypeORM, Sequelize and Mongoose turned it into the *string* "now()". So the
 * question "what is this?" is answered once, here, and each emitter only decides how its language
 * spells the answer.
 */
export type DefaultValue =
  | { kind: "expression"; sql: string }
  | { kind: "string"; value: string }
  | { kind: "number"; text: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

export function defaultOf(field: DbmlField): DefaultValue | null {
  const raw = field.default?.trim();
  if (raw === undefined || raw === "") return null;
  if (raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`")) {
    return { kind: "expression", sql: raw.slice(1, -1).trim() };
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    // The parser escapes an embedded quote as `\'` (see `parse.ts` `defaultValue`).
    return { kind: "string", value: raw.slice(1, -1).replace(/\\'/g, "'") };
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return { kind: "string", value: raw.slice(1, -1) };
  }
  if (/^(true|false)$/i.test(raw)) return { kind: "boolean", value: raw.toLowerCase() === "true" };
  if (/^null$/i.test(raw)) return { kind: "null" };
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) return { kind: "number", text: raw };
  // Anything else reached the model without backticks — the forgiving reader, mid-keystroke. A
  // bare word in a default position is an expression to every database this emits for.
  return { kind: "expression", sql: raw };
}

/** `now()`, `CURRENT_TIMESTAMP`, `getdate()` — the ones every ORM has a word for. */
export function isNowExpression(sql: string): boolean {
  return /^(now\(\)|current_timestamp(\(\))?|localtimestamp|getdate\(\)|sysdate)$/i.test(sql.trim());
}

/** `gen_random_uuid()` and its relatives — the other expression ORMs name. */
export function isUuidExpression(sql: string): boolean {
  return /^(gen_random_uuid\(\)|uuid_generate_v4\(\)|newid\(\)|uuid\(\))$/i.test(sql.trim());
}

/** A string as a single-quoted JavaScript / TypeScript / PHP literal. */
export function quotedLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A non-expression default as a JavaScript literal. */
export function jsLiteral(value: Exclude<DefaultValue, { kind: "expression" }>): string {
  switch (value.kind) {
    case "string":
      return quotedLiteral(value.value);
    case "number":
      return value.text;
    case "boolean":
      return String(value.value);
    case "null":
      return "null";
  }
}

/** The references whose foreign key lives on `table` — the ones that become a join column. */
export function outgoing(refs: CodegenRef[], table: DbmlTable): CodegenRef[] {
  return refs.filter((ref) => ref.fkTable.id === table.id);
}

/** The references pointing *at* `table` — the ones that become a collection. */
export function incoming(refs: CodegenRef[], table: DbmlTable): CodegenRef[] {
  return refs.filter((ref) => ref.pkTable.id === table.id && ref.fkTable.id !== table.id);
}

/** The field named on a table, for the generators that need to know if a key is nullable. */
export function fieldOf(table: DbmlTable, name: string): DbmlField | undefined {
  return table.fields.find((field) => field.name === name);
}

/** What every generator prints when there is nothing to generate from. */
export const NOTHING_TO_CONVERT = "// Write some DBML and the generated code appears here.";

/** The banner each generated file carries, so a pasted file says where it came from. */
export function banner(what: string, comment = "//"): string {
  return `${comment} ${what} — generated by CodeFlow from DBML`;
}
