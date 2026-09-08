/**
 * The statements the grid writes, and the probe that makes one of its errors legible.
 *
 * Small and separate from `sqlite.ts` because it answers a different question: that file turns a
 * *schema* into a database, this one turns a *cell edit* into SQL. They share nothing but the
 * quoting rules, which are here because these are the statements built from values the user typed.
 *
 * **Every value goes in as a literal, not a parameter.** The command surface takes a string of SQL
 * — the console needs that, and giving the grid a second, parameterised path would mean two ways
 * for a value to reach SQLite and two places for the NULL-versus-empty-string distinction to be
 * lost. So the quoting is done once, here, and it is the only thing in this file that has to be
 * right.
 */

/** An identifier, quoted. Doubling is the whole escape: SQLite has no backslash in identifiers. */
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * A value, as a SQL literal.
 *
 * `null` is `NULL` and `""` is `''`, and the two never collapse — a column you left blank and one
 * you set to the empty string are different rows, and finding that out is exactly the sort of thing
 * a scratch database is for.
 *
 * Everything else becomes a quoted string, including numbers. That is deliberate and safe: SQLite's
 * affinity converts `'5'` to the integer 5 on the way into an `INTEGER` column *before* the typed
 * CHECK runs, so a number typed into a numeric column is stored as a number, while `'abc'` stays
 * text and the CHECK rejects it. One quoting rule, and the engine sorts out the types — which is
 * the same policy `datasource::sqlgen::quote_literal` already uses on the Rust side.
 */
export function quoteValue(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * An insert that comes back with what the engine decided.
 *
 * `RETURNING rowid, *` is one round trip rather than two: the row's identity, the id the engine
 * assigned and every default it applied all arrive with the acknowledgement. Without it the grid
 * would have to insert and then re-read to find out what it just wrote, and the row would flicker
 * through a state where its key was blank.
 */
export function insertSql(
  table: string,
  values: Record<string, string | null>,
  /**
   * Ask for the written row back. On by default because the grid needs it, and off for the bulk
   * fill — sixty rows of `RETURNING` is sixty result sets nobody reads, crossing the bridge to be
   * thrown away.
   */
  returning = true,
): string {
  const tail = returning ? " RETURNING rowid, *" : "";
  const columns = Object.keys(values);
  if (columns.length === 0) {
    // Every column left to its default. `DEFAULT VALUES` is the only legal way to say that.
    return `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES${tail};`;
  }
  const names = columns.map(quoteIdent).join(", ");
  const literals = columns.map((column) => quoteValue(values[column])).join(", ");
  return `INSERT INTO ${quoteIdent(table)} (${names}) VALUES (${literals})${tail};`;
}

export function updateSql(
  table: string,
  rowid: number,
  column: string,
  value: string | null,
): string {
  return (
    `UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ${quoteValue(value)} ` +
    `WHERE rowid = ${rowid} RETURNING rowid, *;`
  );
}

export function deleteSql(table: string, rowids: number[]): string {
  return `DELETE FROM ${quoteIdent(table)} WHERE rowid IN (${rowids.join(", ")});`;
}

/**
 * Does this parent row exist? One `SELECT 1` per foreign key, run before the insert.
 *
 * It exists because of a measured gap: SQLite's foreign key error is exactly
 * `FOREIGN KEY constraint failed`, with no table, no column and no value. On a row with three
 * references that is unusable — the user is told something is wrong and not which of the three
 * cells to look at. Probing first costs one cheap indexed lookup per key and turns it into a
 * message pinned to the cell that is actually empty.
 *
 * The probe is a *diagnosis*, never a gate: the insert runs regardless and the engine stays the
 * authority. A race between the probe and the insert therefore costs nothing but a less specific
 * message.
 */
export function parentProbeSql(
  parent: string,
  columns: string[],
  values: (string | null)[],
): string {
  const where = columns
    .map((column, index) => `${quoteIdent(column)} = ${quoteValue(values[index])}`)
    .join(" AND ");
  return `SELECT 1 FROM ${quoteIdent(parent)} WHERE ${where} LIMIT 1;`;
}

/**
 * The label a foreign-key picker shows beside a key.
 *
 * The key alone is not an answer — `1` tells you nothing about which user that is — so the picker
 * shows the first text-ish column beside it. Picked by *shape* rather than by name: the first
 * column that is neither the key nor numeric is almost always the one a human would have named
 * (`email`, `nombre`, `title`), and a name list would be wrong in every language but English.
 */
export function labelColumnFor(
  columns: { name: string; type_name: string }[],
  keys: string[],
): string | null {
  const numeric = /^(int|integer|bigint|smallint|real|numeric|decimal|float|double|bool)/i;
  const candidate = columns.find(
    (column) => !keys.includes(column.name) && !numeric.test(column.type_name.trim()),
  );
  return candidate ? candidate.name : null;
}

/**
 * A key, shortened when it is not something a person can read.
 *
 * A UUID in front of the label turns the picker into thirty-six characters of hexadecimal followed
 * by the only part that identifies the row. Short keys — `1`, `TEC-01` — are left exactly as they
 * are, because those *are* readable and eliding them would lose information for nothing.
 */
export function shortKey(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…` : value;
}

/** Types whose values are a UUID, however the column was spelled. */
const UUID_TYPES = /^(uuid|guid|uniqueidentifier)\b/i;

/**
 * Does this column hold a UUID?
 *
 * By declared type and not by name, because `id uuid` and `external_ref uuid` are the same problem
 * and `id integer` is not. A `varchar(36)` that happens to hold UUIDs is left out: guessing from a
 * length would put the button on half the text columns in a schema.
 */
export const isUuidType = (type: string) => UUID_TYPES.test(type.trim());

/**
 * A version 4 UUID, for the cell that asks for one.
 *
 * The reason this exists is narrow and real: a `uuid` primary key with no default is *yours* to
 * fill, and there is nothing to type. Filling it by hand means inventing 32 hex digits, which
 * people do by mashing the keyboard — and then the row that is supposed to prove the model works
 * is keyed by `aaaa`. One button, and the key looks like the keys the application will write.
 *
 * `crypto.randomUUID` where the webview has it; the fallback is the same v4 layout built from
 * `getRandomValues`, because a UUID that is not random is a UUID that collides on the second row.
 */
export function newUuid(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
