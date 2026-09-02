/**
 * The column types offered wherever a type is being typed.
 *
 * One list, read by three places that used to disagree: the Monarch grammar's `types` (which
 * decides what gets coloured as a type), the DBML completion provider in the editor, and the
 * inspector's column form. Two of those had their own copy and the third had nothing — the form
 * offered only *the types already used in this document*, which on a schema with one `integer` in
 * it is a list containing the word `integer`. That is the "no sirve de nada" the suggestion list
 * earned.
 *
 * Deliberately in `lib/dbml` rather than in `monacoDbml.ts`: the form must not import Monaco to
 * find out what a `varchar` is.
 */

/**
 * The bare type names, for the grammar and for exact-match colouring.
 *
 * Bare because that is what the Monarch tokenizer matches — it sees `varchar` and the `(120)` after
 * it separately, so a list containing `varchar(120)` would never match anything.
 */
export const DBML_TYPES = [
  "int",
  "integer",
  "bigint",
  "smallint",
  "tinyint",
  "serial",
  "bigserial",
  "varchar",
  "char",
  "text",
  "boolean",
  "bool",
  "float",
  "double",
  "real",
  "decimal",
  "numeric",
  "money",
  "date",
  "datetime",
  "timestamp",
  "timestamptz",
  "time",
  "json",
  "jsonb",
  "uuid",
  "bytea",
  "blob",
  "binary",
];

/**
 * What the form actually offers, in the order it offers it.
 *
 * Not `DBML_TYPES` alphabetically. Three differences, each one earned by what people type:
 *
 * 1. **The parametrised forms are here as themselves.** `varchar(255)` and `decimal(10,2)` are what
 *    somebody means when they reach for `varchar`, and a list that offers the bare word makes them
 *    type the parentheses by hand every time.
 * 2. **Ordered by how often a column is that type**, not by spelling. `varchar(255)` and `integer`
 *    are the first two rows because they are most of every schema; `bytea` is near the bottom
 *    because it is rare, not because `b` is late in the alphabet.
 * 3. **Grouped loosely** — numbers, text, time, then the rest — so scanning it works even when the
 *    filter has not narrowed it much.
 *
 * The document's own enums and the types it already uses are put *in front* of this by the caller,
 * because those are the answer more often than anything generic can be.
 */
export const TYPE_SUGGESTIONS = [
  // The two that are most of every schema.
  "integer",
  "varchar(255)",
  // Text.
  "varchar(50)",
  "varchar(100)",
  "text",
  "char(1)",
  // Numbers.
  "bigint",
  "smallint",
  "serial",
  "bigserial",
  "decimal(10,2)",
  "numeric",
  "float",
  "double",
  "boolean",
  // Time.
  "timestamp",
  "timestamptz",
  "date",
  "datetime",
  "time",
  // Everything else.
  "uuid",
  "json",
  "jsonb",
  "bytea",
  "blob",
];

/**
 * The suggestion list for one document: its enums, then the types it already uses, then the rest.
 *
 * The ordering is the whole point. A type this schema already contains is a better guess than any
 * generic default — schemas are internally consistent, and the column you are adding is very often
 * the same shape as one three rows up. An enum is better still: it is a type that exists *only*
 * here, so nothing else could have suggested it.
 *
 * De-duplicated case-insensitively, keeping the first spelling seen, so a document using `VARCHAR`
 * does not get both.
 */
export function typeSuggestions(used: Iterable<string>, enums: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...enums, ...used, ...TYPE_SUGGESTIONS]) {
    const type = candidate.trim();
    if (!type) continue;
    const key = type.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(type);
  }
  return out;
}
