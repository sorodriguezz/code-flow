import type { DbmlEndpoint, DbmlRef, DbmlSchema, DbmlTable } from "./types";

/**
 * Which end of a reference holds the foreign key — decided by evidence, never by position.
 *
 * **Position says nothing.** `@dbml/core` normalises an *inline* `ref:` target-first and keeps a
 * standalone `Ref:` in the order it was written (measured, see `codeflow-dbml-parser-modes`):
 *
 * | written as                            | `from`             | `to`               |
 * |---------------------------------------|--------------------|--------------------|
 * | `profiles.user_id [ref: - users.id]`  | `users.id`         | `profiles.user_id` |
 * | `Ref: profiles.user_id - users.id`    | `profiles.user_id` | `users.id`         |
 * | `Ref: users.id - profiles.user_id`    | `users.id`         | `profiles.user_id` |
 *
 * For a one-to-many that costs nothing — the `*` end holds the key whichever slot it landed in. For
 * a one-to-one both ends are `1`, so every emitter that read `from` as the child put the relation on
 * the wrong table for the form most people write. The sandbox had already found this out
 * (`orientRef`); the code generators had not, and emitted `users.id REFERENCES profiles(user_id)`.
 *
 * So a one-to-one is oriented by what the schema says about each end, in this order:
 *
 * 1. **The end whose columns are the table's effective primary key is the parent.** A foreign key
 *    points at a key; the other end is the one holding it.
 * 2. **Tie-break: the end declared `unique` but not `pk` is the child.** That is how a one-to-one's
 *    foreign-key column is written when the table has no declared key to compare against — the
 *    `unique` is what makes the relation one-to-one rather than one-to-many.
 * 3. **Otherwise it is ambiguous** — both ends are keys (a shared primary key), or both or neither
 *    are unique. Nothing in the model says which side was meant, and guessing produces a *different*
 *    constraint rather than a missing one. The generators drop the edge and say so; the sandbox,
 *    which has to build something to hold test rows, falls back to reading `to` as the parent.
 */
export type RefOrientation =
  | { kind: "many-to-many" }
  | {
      kind: "many-to-one" | "one-to-one";
      /** Holds the foreign key. */
      child: DbmlEndpoint;
      /** Is pointed at. */
      parent: DbmlEndpoint;
    }
  | { kind: "ambiguous" };

/** The columns of a table's primary key, from a `pk` index when there is one, else the `pk` flags. */
export function primaryKeyOf(table: DbmlTable): string[] {
  const index = table.indexes.find((entry) => entry.pk && entry.columns.length > 0);
  if (index) return index.columns;
  return table.fields.filter((field) => field.pk).map((field) => field.name);
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((column) => b.includes(column));
}

/** Whether an endpoint's columns are exactly its table's primary key. */
function isKey(table: DbmlTable | undefined, endpoint: DbmlEndpoint): boolean {
  if (!table || endpoint.fields.length === 0) return false;
  const key = primaryKeyOf(table);
  return key.length > 0 && sameColumns(endpoint.fields, key);
}

/**
 * Whether an endpoint is declared unique without being the key: a single `unique` column, or a
 * non-primary unique index over exactly these columns.
 */
function isUniqueNotKey(table: DbmlTable | undefined, endpoint: DbmlEndpoint): boolean {
  if (!table || endpoint.fields.length === 0 || isKey(table, endpoint)) return false;
  if (endpoint.fields.length === 1) {
    const field = table.fields.find((entry) => entry.name === endpoint.fields[0]);
    if (field && field.unique && !field.pk) return true;
  }
  return table.indexes.some(
    (index) => index.unique && !index.pk && sameColumns(index.columns, endpoint.fields),
  );
}

export function orientReference(schema: DbmlSchema, ref: DbmlRef): RefOrientation {
  const fromMany = ref.from.relation === "*";
  const toMany = ref.to.relation === "*";
  if (fromMany && toMany) return { kind: "many-to-many" };
  if (fromMany) return { kind: "many-to-one", child: ref.from, parent: ref.to };
  if (toMany) return { kind: "many-to-one", child: ref.to, parent: ref.from };

  const tableOf = (endpoint: DbmlEndpoint) =>
    schema.tables.find((table) => table.id === endpoint.table);
  const fromTable = tableOf(ref.from);
  const toTable = tableOf(ref.to);

  const fromKey = isKey(fromTable, ref.from);
  const toKey = isKey(toTable, ref.to);
  if (fromKey !== toKey) {
    return fromKey
      ? { kind: "one-to-one", child: ref.to, parent: ref.from }
      : { kind: "one-to-one", child: ref.from, parent: ref.to };
  }

  const fromUnique = isUniqueNotKey(fromTable, ref.from);
  const toUnique = isUniqueNotKey(toTable, ref.to);
  if (fromUnique !== toUnique) {
    return fromUnique
      ? { kind: "one-to-one", child: ref.from, parent: ref.to }
      : { kind: "one-to-one", child: ref.to, parent: ref.from };
  }
  return { kind: "ambiguous" };
}

/** `users.id - profiles.user_id` — how a reference is named in a finding, as it would be written. */
export function describeRef(ref: DbmlRef): string {
  const end = (endpoint: DbmlEndpoint) =>
    endpoint.fields.length === 1
      ? `${endpoint.table}.${endpoint.fields[0]}`
      : `${endpoint.table}.(${endpoint.fields.join(", ")})`;
  const symbol =
    ref.from.relation === "*" && ref.to.relation === "*"
      ? "<>"
      : ref.from.relation === "*"
        ? ">"
        : ref.to.relation === "*"
          ? "<"
          : "-";
  return `${end(ref.from)} ${symbol} ${end(ref.to)}`;
}
