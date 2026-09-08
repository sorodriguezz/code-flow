/**
 * Twenty rows per table, from the types alone — the one place generated data earns its keep.
 *
 * Deliberately not the centre of anything. Typing rows by hand is what tells you whether a model is
 * pleasant to fill, whether a foreign key is annoying to satisfy, and whether a new `not null`
 * column is possible over what you already have; **generated rows satisfy every constraint by
 * construction**, so they can answer none of that. What they are good for is the other half: you
 * want a `SELECT` with a `GROUP BY` to have something to group, and writing twenty rows by hand to
 * get there is a chore, not an experiment.
 *
 * So: one menu item, a fixed number, no panel, no settings. It fills parents before children and
 * draws foreign keys from rows that already exist, because the alternative is twenty rejections.
 */

import { insertSql } from "./rows";
import { familyOf, isRowidAlias, orderTables, refsFrom } from "./sqlite";
import type { DbmlField, DbmlSchema, DbmlTable } from "./types";

/** How many rows one pass writes per table. Fixed on purpose — see the module note. */
export const FILL_ROWS = 20;

/**
 * A value for one column, given the row's index.
 *
 * Keyed off the index rather than off a random source so a fill is reproducible: pressing it twice
 * on a fresh sandbox gives the same rows, which is what makes "the same query, before and after my
 * change" a comparison rather than a coincidence.
 */
function valueFor(field: DbmlField, index: number, enums: Map<string, string[]>): string | null {
  const values = enums.get(field.type.trim());
  if (values && values.length > 0) return values[index % values.length];

  switch (familyOf(field.type)) {
    case "integer":
      return String(index + 1);
    case "real":
      // Two decimals, and never a round number — a column of `10.00` hides a formatting bug that a
      // column of `10.25` shows.
      return (((index + 1) * 37) % 1000 === 0 ? 12.5 : ((index + 1) * 37) / 4).toFixed(2);
    case "boolean":
      return index % 2 === 0 ? "1" : "0";
    default:
      break;
  }

  const name = field.name.toLowerCase();
  const at = index + 1;
  // By name, and only for the handful where a plausible value is genuinely more useful than
  // `texto-7`: an email column full of `texto-7` cannot exercise a `LIKE '%@%'`, and a date column
  // full of it cannot be sorted. Everything else gets the honest placeholder.
  if (name.includes("mail")) return `persona${at}@ejemplo.test`;
  if (name.includes("url") || name.includes("link")) return `https://ejemplo.test/${at}`;
  if (name.includes("slug") || name.includes("codigo") || name.includes("code")) {
    return `item-${String(at).padStart(3, "0")}`;
  }
  if (/date|fecha|_at$|creado|actualizado/.test(name)) {
    // A fixed origin plus the row's index: ordered, comparable, and the same on every run.
    const day = new Date(Date.UTC(2026, 0, 1 + (at % 365)));
    return day.toISOString().slice(0, 19).replace("T", " ");
  }
  if (/uuid|guid|ulid/.test(field.type.toLowerCase())) {
    const hex = (at * 2654435761).toString(16).padStart(8, "0").slice(-8);
    return `${hex}-0000-4000-8000-${String(at).padStart(12, "0")}`;
  }

  const length = /\(\s*(\d+)\s*\)/.exec(field.type);
  const text = `${field.name}-${at}`;
  const max = length ? Number(length[1]) : Infinity;
  return text.length > max ? text.slice(0, max) : text;
}

/** One table's twenty inserts, in order. `parents` supplies keys that already exist. */
function statementsFor(
  schema: DbmlSchema,
  table: DbmlTable,
  parents: Map<string, string[]>,
): string[] {
  const enums = new Map(
    schema.enums.flatMap((entry) => [
      [entry.id, entry.values.map((value) => value.name)] as [string, string[]],
      [entry.name, entry.values.map((value) => value.name)] as [string, string[]],
    ]),
  );
  const outgoing = refsFrom(schema, table.id);
  const statements: string[] = [];

  for (let index = 0; index < FILL_ROWS; index += 1) {
    const values: Record<string, string | null> = {};
    let blocked = false;
    for (const field of table.fields) {
      // Left out so the engine fills it — the same rule the grid's `auto` cell follows.
      if (isRowidAlias(table, field) || field.default !== null) continue;

      const reference = outgoing.find((entry) => entry.child.fields.includes(field.name));
      if (reference) {
        const at = reference.child.fields.indexOf(field.name);
        const available = parents.get(`${reference.parent.table}|${reference.parent.fields[at]}`);
        if (!available || available.length === 0) {
          // No parent row to point at. The row is skipped rather than written with a NULL that a
          // `not null` would reject anyway — twenty identical failures tell the user nothing.
          blocked = true;
          break;
        }
        values[field.name] = available[index % available.length];
        continue;
      }
      values[field.name] = valueFor(field, index, enums);
    }
    if (!blocked) statements.push(insertSql(table.id, values, false));
  }
  return statements;
}

/**
 * Every statement a fill runs, parents first.
 *
 * `existing` is what the sandbox already holds, per `table|column`, so a fill on top of rows you
 * typed by hand points its foreign keys at *your* rows rather than at nothing. A table whose parent
 * has no rows at all is skipped, and the caller is told which — that is a fact about the model
 * (a cycle, or a chain you have not started) rather than a failure of the fill.
 */
export function fillPlan(
  schema: DbmlSchema,
  existing: Map<string, string[]>,
): { statements: string[]; skipped: string[] } {
  const { order } = orderTables(schema);
  const parents = new Map(existing);
  const statements: string[] = [];
  const skipped: string[] = [];

  for (const id of order) {
    const table = schema.tables.find((entry) => entry.id === id);
    if (!table) continue;
    const written = statementsFor(schema, table, parents);
    if (written.length === 0) {
      skipped.push(id);
      continue;
    }
    statements.push(...written);

    // What this table now offers its children. Predicted rather than read back: the keys are the
    // values we just wrote, and for an autonumbered key they are 1..N on a table that was empty.
    for (const field of table.fields) {
      const generated = isRowidAlias(table, field);
      const keys = generated
        ? Array.from({ length: FILL_ROWS }, (_, index) => String(index + 1))
        : Array.from({ length: FILL_ROWS }, (_, index) =>
            valueFor(field, index, new Map()) ?? "",
          );
      const slot = `${table.id}|${field.name}`;
      parents.set(slot, [...(parents.get(slot) ?? []), ...keys]);
    }
  }
  return { statements, skipped };
}
