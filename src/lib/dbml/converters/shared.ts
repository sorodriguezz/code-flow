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

/** Whether a field may be omitted — a primary key never can, whatever the document says. */
export function isOptional(field: DbmlField): boolean {
  return !field.notNull && !field.pk;
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

/** Which way round a reference goes, in the vocabulary the generators think in. */
export type RelationKind = "many-to-one" | "one-to-one" | "many-to-many";

/**
 * A reference, oriented.
 *
 * **`fk` is always the side that holds the foreign key** — the many side of a one-to-many, and the
 * declaring side of a one-to-one. DBML lets a relationship be written from either end (`>` and `<`
 * are the same relationship read in opposite directions), and every generator here needs it the
 * same way round: the FK side is where a column exists and where the join belongs.
 */
export interface CodegenRef {
  fkTable: DbmlTable;
  fkField: string;
  pkTable: DbmlTable;
  pkField: string;
  kind: RelationKind;
}

/**
 * The schema's references, oriented and resolved to their tables.
 *
 * A reference to a table that is not in the document is dropped rather than emitted against a
 * missing class: `@dbml/core` rejects those outright, so one only reaches here from the forgiving
 * reader, mid-keystroke, and half a class is worse output than one fewer.
 */
export function codegenRefs(schema: DbmlSchema): CodegenRef[] {
  const byId = new Map(schema.tables.map((table) => [table.id, table]));
  const refs: CodegenRef[] = [];
  for (const ref of schema.refs) {
    const from = byId.get(ref.from.table);
    const to = byId.get(ref.to.table);
    if (!from || !to) continue;
    const fromField = ref.from.fields[0] ?? "";
    const toField = ref.to.fields[0] ?? "";
    if (!fromField || !toField) continue;

    const many = ref.from.relation === "*";
    const otherMany = ref.to.relation === "*";
    if (many && otherMany) {
      refs.push({
        fkTable: from,
        fkField: fromField,
        pkTable: to,
        pkField: toField,
        kind: "many-to-many",
      });
    } else if (many) {
      // `from` is the many side: it is the one carrying the column.
      refs.push({ fkTable: from, fkField: fromField, pkTable: to, pkField: toField, kind: "many-to-one" });
    } else if (otherMany) {
      refs.push({ fkTable: to, fkField: toField, pkTable: from, pkField: fromField, kind: "many-to-one" });
    } else {
      refs.push({ fkTable: from, fkField: fromField, pkTable: to, pkField: toField, kind: "one-to-one" });
    }
  }
  return refs;
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
