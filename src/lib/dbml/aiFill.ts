import { insertSql } from "./rows";
import { familyOf, isRowidAlias, orderTables, orientRef, refsFrom } from "./sqlite";
import type { DbmlField, DbmlSchema, DbmlTable } from "./types";

/**
 * Rows written by a model, turned into inserts the sandbox will accept.
 *
 * **The second way to fill the scratch database, next to `fill.ts` and not instead of it.** The two
 * answer different questions. `fillPlan` writes twenty rows from the column *types*: reproducible,
 * constraint-satisfying by construction, and content-free — `nombre-7` groups as well as any other
 * string. This one asks an engine for rows that mean something, which is what you want the moment
 * the query you are testing is `WHERE ciudad = 'Valparaíso'` or the screenshot you need has to look
 * like a product rather than like a test fixture.
 *
 * # Why the schema still has the last word
 *
 * The model writes **whole rows, keys included** — that is the point, and it is what lets the order
 * placed by `Ana` actually carry Ana's id. What it cannot do is put them in the database: a value
 * the column's type will not hold, an enum spelling nobody declared, a foreign key pointing at a
 * row that does not exist and a primary key used twice are all things a plausible-looking answer
 * contains regularly, and each of them is a failed statement rather than a bad row. So every value
 * is checked here first and the rows that do not survive are **dropped and counted**, never
 * repaired into something the model did not say and never sent to be rejected by SQLite.
 *
 * That the count is reported matters as much as the dropping. "Wrote 60 of 74 rows; 14 dropped, all
 * of them a `pedidos.cliente_id` naming a customer that is not there" is a fact about the answer,
 * and the person reading it can press the button again. A silent 60 is a fill that looks complete.
 *
 * # No SQL crosses the bridge from the model
 *
 * The engine is asked for *values*, in JSON, and the `INSERT` is built here with the same
 * `insertSql` the grid and `fill.ts` use. Asking a model for SQL and running it would make every
 * statement it can write — `DROP TABLE`, `ATTACH`, a `pragma` — reachable from a prompt, in a
 * database whose whole job is to be run against without thinking about it.
 */

/** One table's rows, as the engine is asked to shape them. */
export interface AiRowsTable {
  table: string;
  columns: string[];
  rows: unknown[][];
}

/** The whole answer. Nothing else in it is read. */
export interface AiRowsAnswer {
  tables: AiRowsTable[];
}

/**
 * Why a row was refused.
 *
 * Named rather than counted as one number, because the four mean different things to whoever
 * pressed the button: `foreignKey` and `duplicateKey` say the model was not consistent with itself,
 * `type` and `enum` say it ignored the schema, and `notNull` says it left something out.
 */
export type AiDropReason = "type" | "enum" | "notNull" | "foreignKey" | "duplicateKey";

export interface AiFillPlan {
  statements: string[];
  /** Rows that will be written, per table id. */
  written: Record<string, number>;
  /** Rows the schema refused, per table and reason. */
  dropped: { table: string; reason: AiDropReason; rows: number }[];
  /**
   * Rows written with at least one foreign key pointed somewhere real, per table id.
   *
   * See the loop below for why they are repaired rather than dropped. Counted separately from
   * `written` and reported separately, because a row whose link the app chose is not quite the row
   * the model wrote and the person reading the table deserves to know which.
   */
  repaired: Record<string, number>;
  /** Names the answer used that no table in the document declares. */
  unknown: string[];
}

/**
 * The most rows one answer may write per table.
 *
 * A cap and not a target: the prompt asks for a number, and what protects the sandbox is this,
 * because "how many rows did you ask for" is advice and a model that answers with four thousand
 * has not broken any rule it was given. Everything past the cap is dropped before it is validated.
 */
export const AI_FILL_MAX_ROWS = 200;

/**
 * The JSON in a reply, or `null` if there is none worth reading.
 *
 * Defensive on the frontend even though the Rust side already digs the object out of whatever prose
 * surrounded it: this is the boundary where a wrong shape becomes a wrong `INSERT`, so it is the
 * boundary that checks. Anything that is not an object with a `tables` array of the right shape is
 * refused whole rather than partly read — a half-understood answer is the one that writes rows
 * nobody asked for.
 */
export function parseAiRows(text: string): AiRowsAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const tables = (parsed as { tables?: unknown }).tables;
  if (!Array.isArray(tables)) return null;

  const out: AiRowsTable[] = [];
  for (const entry of tables) {
    if (!entry || typeof entry !== "object") continue;
    const { table, columns, rows } = entry as Record<string, unknown>;
    if (typeof table !== "string" || !table.trim()) continue;
    if (!Array.isArray(columns) || !columns.every((name) => typeof name === "string")) continue;
    if (!Array.isArray(rows)) continue;
    out.push({
      table: table.trim(),
      columns: columns as string[],
      rows: rows.filter((row): row is unknown[] => Array.isArray(row)),
    });
  }
  return out.length > 0 ? { tables: out } : null;
}

/**
 * Every insert an answer earns, parents first.
 *
 * `existing` is what the sandbox already holds, per `table|column`, exactly as `fillPlan` takes it:
 * a foreign key may point at a row you typed by hand as legitimately as at one this same answer is
 * about to write.
 */
export function planAiFill(
  schema: DbmlSchema,
  answer: AiRowsAnswer,
  existing: Map<string, string[]>,
): AiFillPlan {
  const { order } = orderTables(schema);
  /** Values a child may point at: what is already there, plus what this plan has written so far. */
  const available = new Map<string, Set<string>>();
  for (const [slot, values] of existing) available.set(slot, new Set(values));

  const enums = new Map(
    schema.enums.flatMap((entry) => [
      [entry.id.toLowerCase(), entry.values.map((value) => value.name)] as [string, string[]],
      [entry.name.toLowerCase(), entry.values.map((value) => value.name)] as [string, string[]],
    ]),
  );

  const sent = new Map<string, AiRowsTable>();
  const unknown: string[] = [];
  for (const entry of answer.tables) {
    const table = resolveTable(schema, entry.table);
    if (!table) {
      if (!unknown.includes(entry.table)) unknown.push(entry.table);
      continue;
    }
    // Merged rather than overwritten: a model that split one table across two entries meant both.
    const held = sent.get(table.id);
    if (held && sameColumns(held.columns, entry.columns)) {
      held.rows.push(...entry.rows);
    } else if (!held) {
      sent.set(table.id, { ...entry, rows: [...entry.rows] });
    }
  }

  const statements: string[] = [];
  const written: Record<string, number> = {};
  const repaired: Record<string, number> = {};
  /** Where each reference's round-robin over the real parent keys has got to. */
  const cursor = new Map<string, number>();
  const refused = new Map<string, number>();
  const refuse = (table: string, reason: AiDropReason) =>
    refused.set(`${table}|${reason}`, (refused.get(`${table}|${reason}`) ?? 0) + 1);

  for (const id of order) {
    const table = schema.tables.find((entry) => entry.id === id);
    const entry = sent.get(id);
    if (!table || !entry) continue;

    // A column the document does not declare is dropped from the row rather than refusing it: a
    // model that invents one extra field has still written a usable row for the ones that exist.
    const slots = entry.columns.map(
      (name) => table.fields.find((field) => field.name.toLowerCase() === name.toLowerCase()) ?? null,
    );
    const outgoing = refsFrom(schema, id);
    /** Single-column keys already used by this table, so the same id is not written twice. */
    const usedKeys = new Map<string, Set<string>>();
    for (const field of table.fields) {
      if (!field.pk && !field.unique) continue;
      usedKeys.set(field.name, new Set(available.get(`${id}|${field.name}`) ?? []));
    }

    for (const row of entry.rows.slice(0, AI_FILL_MAX_ROWS)) {
      const values: Record<string, string | null> = {};
      let reason: AiDropReason | null = null;

      for (let at = 0; at < slots.length && reason === null; at += 1) {
        const field = slots[at];
        if (!field) continue;
        const raw = row[at];
        // `undefined` is a short row, which is the model leaving the column out — the same thing
        // as `null`, and legal wherever a missing value is.
        const value = raw === undefined ? null : coerce(raw, field, enums);
        if (value === REFUSED) {
          reason = enumValuesFor(field, enums) ? "enum" : "type";
          break;
        }
        if (value === null) {
          // Left out entirely, so SQLite applies the default or the autonumber. A `not null` column
          // with neither is the one case that has to refuse: the statement would fail.
          if (field.notNull && field.default === null && !isRowidAlias(table, field)) {
            reason = "notNull";
          }
          continue;
        }
        values[field.name] = value;
      }
      if (reason !== null) {
        refuse(id, reason);
        continue;
      }

      /*
       * **Every foreign key has to name a row that exists** — in the sandbox or earlier in this
       * same plan, including earlier in this same table, which is what makes a self-reference like
       * `empleados.jefe_id` work.
       *
       * A value that names nothing is **repointed at a real parent, not thrown away**, and that is
       * a deliberate reversal of what this did first. Dropping was right in principle and wrong in
       * practice for one reason: keys are routinely `uuid`s. Asked to reuse
       * `9f2c1a44-3e6b-4a91-8d02-5c7e10ab33f1`, a model reproduces it *almost* exactly, and one
       * character costs the whole row — so on a schema with uuid keys every table that had a
       * foreign key came out empty while the one lookup table that had none filled perfectly. That
       * is not a fill anybody can use.
       *
       * What is lost by repairing is small and what is kept is the feature: which specific parent
       * a row points at is the part of a generated row that means least — the model was inventing
       * the link anyway — while the row's own content is the part somebody asked for. The keys are
       * handed out round-robin from the real ones, the same way `fill.ts` does it, so the children
       * spread across the parents instead of piling onto the first.
       *
       * It is counted, and the panel says so. A row whose link the app chose is not quite the row
       * the model wrote.
       *
       * The one case still refused: a reference whose parent has **no rows at all**. There is
       * nothing to point at, and inventing one would be writing a row into a table nobody asked to
       * fill.
       */
      let mended = false;
      for (const reference of outgoing) {
        for (let at = 0; at < reference.child.fields.length && reason === null; at += 1) {
          const column = reference.child.fields[at];
          const slot = `${reference.parent.table}|${reference.parent.fields[at]}`;
          const target = available.get(slot);
          const value = values[column];
          if (value !== undefined && value !== null && target?.has(value)) continue;

          const field = table.fields.find((entry) => entry.name === column);
          // A nullable column the answer left empty is a deliberate blank, not a broken link.
          if ((value === undefined || value === null) && field && !field.notNull) continue;

          const keys = target ? [...target] : [];
          if (keys.length === 0) {
            reason = "foreignKey";
            break;
          }
          const next = cursor.get(slot) ?? 0;
          values[column] = keys[next % keys.length];
          cursor.set(slot, next + 1);
          mended = true;
        }
        if (reason !== null) break;
      }
      if (reason !== null) {
        refuse(id, reason);
        continue;
      }

      // Columns the answer never mentioned, and that the repair above did not fill either: a
      // `not null` with no default and no autonumber cannot be written.
      for (const field of table.fields) {
        if (field.name in values) continue;
        if (field.notNull && field.default === null && !isRowidAlias(table, field)) {
          reason = "notNull";
          break;
        }
      }
      if (reason !== null) {
        refuse(id, reason);
        continue;
      }

      for (const [column, used] of usedKeys) {
        const value = values[column];
        if (value === undefined || value === null) continue;
        if (used.has(value)) reason = "duplicateKey";
      }
      if (reason !== null) {
        refuse(id, reason);
        continue;
      }

      for (const [column, used] of usedKeys) {
        const value = values[column];
        if (value !== undefined && value !== null) used.add(value);
      }
      // Registered as the row is accepted, not once the table is done, so a later row in the same
      // table can point at this one.
      for (const [column, value] of Object.entries(values)) {
        if (value === null) continue;
        const slot = `${id}|${column}`;
        const set = available.get(slot) ?? new Set<string>();
        set.add(value);
        available.set(slot, set);
      }

      statements.push(insertSql(id, values, false));
      written[id] = (written[id] ?? 0) + 1;
      if (mended) repaired[id] = (repaired[id] ?? 0) + 1;
    }
  }

  const dropped = [...refused.entries()].map(([key, rows]) => {
    const at = key.lastIndexOf("|");
    return { table: key.slice(0, at), reason: key.slice(at + 1) as AiDropReason, rows };
  });
  return { statements, written, dropped, repaired, unknown };
}

/**
 * The schema as the engine needs to see it: names, types, keys and references. Nothing else.
 *
 * **This replaced sending the DBML itself, and it is the fix for a real bug.** The document that
 * exposed it was 17 389 characters of which most were `note: '''…'''` blocks — design rationale,
 * written for people. The context is capped on the Rust side, the cap fell in the middle of it, and
 * what reached the model was the first eight tables and half of a comment. Every pass after the
 * second was then asked to write rows for tables it had never been shown, so it wrote none, and the
 * fill stopped at the same eight tables however the batches were arranged.
 *
 * So the notes go. A model inventing a row for `cita` needs to know that `fk_recurso` is a `uuid`
 * pointing at `recurso.id`; it does not need three paragraphs on why that table is the pivot. What
 * is left is about a fifth the size and carries strictly more of what the answer depends on —
 * `pk`, `not null` and the references are *derived from the parsed model* here, where in the raw
 * document they were spread across inline settings and separate `Ref:` lines.
 */
export function schemaOutline(schema: DbmlSchema): string {
  const lines: string[] = [];
  for (const table of schema.tables) {
    lines.push(`Table ${table.id} {`);
    for (const field of table.fields) {
      const flags = [
        field.pk ? "pk" : "",
        field.notNull && !field.pk ? "not null" : "",
        field.unique && !field.pk ? "unique" : "",
        // Named rather than described: a column the engine fills is one the answer may leave out,
        // and saying so is what stops a model inventing ids it did not need to.
        field.increment ? "autonumérico" : "",
        field.default !== null ? `default ${field.default}` : "",
      ].filter(Boolean);
      lines.push(`  ${field.name} ${field.type}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
    }
    lines.push("}");
  }
  for (const entry of schema.enums) {
    lines.push(`Enum ${entry.id} { ${entry.values.map((value) => value.name).join(" ")} }`);
  }
  // The references, oriented: which end is the child is the whole question a foreign key asks, and
  // leaving it to be read off an arrow in a document the model may only half remember is how a
  // reference ends up written backwards.
  for (const ref of schema.refs) {
    const oriented = orientRef(schema, ref);
    if (!oriented) continue;
    lines.push(
      `Ref: ${oriented.child.table}.${oriented.child.fields.join("+")} > ` +
        `${oriented.parent.table}.${oriented.parent.fields.join("+")}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Filling in passes
// ---------------------------------------------------------------------------

/**
 * Tables per pass.
 *
 * The first version of this feature asked for the whole schema in one call, and a fifteen-table
 * document came back with eight tables in it — not an error, just a reply that ran out of room and
 * stopped. Four is small enough that the answer is never the thing that runs out, and the cost of
 * the extra calls buys two more things: each pass is planned against the database *as it now is*,
 * and the engine can be told which keys the earlier passes actually wrote.
 */
export const AI_FILL_BATCH = 4;

/**
 * Ids per column named in the prompt.
 *
 * Twelve rather than the twenty-five this started at, because the values are routinely `uuid`s: at
 * 36 characters each, twenty-five of them across a dozen referenced columns is ten kilobytes of
 * prompt spent showing the same fact over and over. A dozen shows the *shape* of a real id, which
 * is all the model needs in order to copy one instead of inventing it.
 */
const KEYS_PER_COLUMN = 12;

/** `[a,b,c,d,e]` → `[[a,b,c,d],[e]]`. */
export function batchTables(ids: string[], size = AI_FILL_BATCH): string[][] {
  const out: string[][] = [];
  for (let at = 0; at < ids.length; at += size) out.push(ids.slice(at, at + size));
  return out;
}

/** An empty plan, to fold every pass into. */
export function emptyPlan(): AiFillPlan {
  return { statements: [], written: {}, dropped: [], repaired: {}, unknown: [] };
}

/**
 * Two plans as one, so the message at the end is about the whole fill and not about the last pass.
 *
 * Rows are summed per table and drops per table *and reason*: a fill that lost four rows to a
 * foreign key in one pass and three to a duplicate key in another has two different things to say,
 * and collapsing them into "seven dropped" throws away the half that tells you what to do next.
 */
export function mergePlans(into: AiFillPlan, next: AiFillPlan): AiFillPlan {
  into.statements.push(...next.statements);
  for (const [table, count] of Object.entries(next.written)) {
    into.written[table] = (into.written[table] ?? 0) + count;
  }
  for (const [table, count] of Object.entries(next.repaired)) {
    into.repaired[table] = (into.repaired[table] ?? 0) + count;
  }
  for (const entry of next.dropped) {
    const held = into.dropped.find((drop) => drop.table === entry.table && drop.reason === entry.reason);
    if (held) held.rows += entry.rows;
    else into.dropped.push({ ...entry });
  }
  for (const name of next.unknown) if (!into.unknown.includes(name)) into.unknown.push(name);
  return into;
}

/**
 * The keys a later pass may point at, as lines the prompt can carry.
 *
 * **Only the columns something actually references.** A table's every column would be the database
 * copied into the prompt, and the question being answered is much narrower than that: "what may
 * `pedidos.cliente_id` be". Capped per column, because the point is to show the *range* of real
 * ids, and twenty-five of them do that as well as three hundred would.
 *
 * Without this, batching trades one failure for another: every table gets written and half their
 * references name customers that were never created, because the pass that wrote the orders had no
 * way to know which ids the pass before it had chosen.
 */
export function keyHint(available: Map<string, string[]>, schema: DbmlSchema): string {
  // The **parent** side only. The child column is the one being written, so listing its current
  // values answers a question nobody asked and doubles the block.
  const targets = new Set<string>();
  for (const ref of schema.refs) {
    const oriented = orientRef(schema, ref);
    if (!oriented) continue;
    for (const field of oriented.parent.fields) targets.add(`${oriented.parent.table}|${field}`);
  }
  const lines: string[] = [];
  for (const slot of targets) {
    const values = available.get(slot);
    if (!values || values.length === 0) continue;
    const shown = values.slice(0, KEYS_PER_COLUMN);
    const tail = values.length > shown.length ? `, … (${values.length})` : "";
    lines.push(`${slot.replace("|", ".")}: ${shown.join(", ")}${tail}`);
  }
  return lines.join("\n");
}

/** A value the column will not hold. Distinct from `null`, which is a value it might. */
const REFUSED = Symbol("refused");

function enumValuesFor(field: DbmlField, enums: Map<string, string[]>): string[] | undefined {
  return enums.get(field.type.trim().toLowerCase());
}

/**
 * One JSON value as the string the row will carry, `null` for absent, or `REFUSED`.
 *
 * Everything on the wire to SQLite is text — the sandbox's own rule — so this is a *check* that
 * happens to return a string, not a conversion. A number where an integer is declared passes; the
 * word `"tres"` does not, and it is refused rather than coerced to `0`, because a zero nobody wrote
 * is worse than a row nobody gets.
 */
function coerce(
  raw: unknown,
  field: DbmlField,
  enums: Map<string, string[]>,
): string | null | typeof REFUSED {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return REFUSED;

  const values = enumValuesFor(field, enums);
  if (values) {
    if (typeof raw !== "string") return REFUSED;
    // Matched case-insensitively and written back in the *declared* spelling: `Pendiente` is
    // plainly the `pendiente` that was declared, and storing the model's capitalisation would make
    // the enum's own values fail to match it.
    const found = values.find((value) => value.toLowerCase() === raw.trim().toLowerCase());
    return found ?? REFUSED;
  }

  switch (familyOf(field.type)) {
    case "integer": {
      const number = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(number) || !Number.isInteger(number)) return REFUSED;
      if (typeof raw === "string" && raw.trim() === "") return REFUSED;
      return String(number);
    }
    case "real": {
      const number = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(number)) return REFUSED;
      if (typeof raw === "string" && raw.trim() === "") return REFUSED;
      return String(number);
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw ? "1" : "0";
      if (raw === 0 || raw === 1) return String(raw);
      const text = String(raw).trim().toLowerCase();
      if (text === "true") return "1";
      if (text === "false") return "0";
      return REFUSED;
    }
    default: {
      const text = typeof raw === "string" ? raw : String(raw);
      // Truncated to the declared length rather than refused. SQLite does not enforce it, so this
      // costs nothing here — but the sandbox's SQL can be exported into a database that does, and a
      // fill that only fails once it leaves the app is the worse of the two failures.
      const length = /\(\s*(\d+)\s*\)/.exec(field.type);
      const max = length ? Number(length[1]) : Infinity;
      return text.length > max ? text.slice(0, max) : text;
    }
  }
}

/** The table an answer names: by id, then by bare name, then case-insensitively on either. */
function resolveTable(schema: DbmlSchema, name: string): DbmlTable | undefined {
  const wanted = name.trim().toLowerCase();
  return (
    schema.tables.find((table) => table.id.toLowerCase() === wanted) ??
    schema.tables.find((table) => table.name.toLowerCase() === wanted)
  );
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, at) => name.toLowerCase() === b[at].toLowerCase());
}
