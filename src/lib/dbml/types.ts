/**
 * What a DBML document *is*, once parsed, for everything downstream of the parser.
 *
 * One model, four consumers: the canvas draws it, the converters emit code from it, the diff
 * compares two of them, and the inspector reads one table out of it. That is the reason this file
 * holds no rendering concern and no `@dbml/core` type — a shape that mentioned either would tie the
 * converters to the parser's version, and the version is the one thing about `@dbml/core` that
 * moves.
 *
 * **Names are qualified once, here, and never re-derived.** DBML has schemas (`Table core.users`),
 * so `users` is not an identity — `core.users` is. Every table and enum carries an `id` built by
 * `qualify`, refs point at those ids, and no consumer is ever asked to work out whether the
 * `user_id` it is looking at means the one in `core` or the one in `shop`. Getting this wrong is
 * invisible in a single-schema document and silently draws the wrong arrows in a multi-schema one.
 */

/** How many rows one end of a reference stands for. DBML's own vocabulary, kept verbatim. */
export type DbmlCardinality = "1" | "*";

/** One end of a reference: a table, the columns on it, and how many rows this end means. */
export interface DbmlEndpoint {
  /** The qualified table id — see `qualify`. Never a bare name. */
  table: string;
  /** Composite references are legal DBML, so this is a list even though it is usually one. */
  fields: string[];
  relation: DbmlCardinality;
}

export interface DbmlField {
  name: string;
  /** As written, arguments included: `varchar(100)`, `decimal(10,2)`, `text[]`. */
  type: string;
  pk: boolean;
  notNull: boolean;
  unique: boolean;
  increment: boolean;
  /**
   * The default **as it should be re-emitted**, quoting included — `'user'`, `now()`, `0`.
   *
   * Not the bare value: `@dbml/core` hands back `{ value: "user", type: "string" }`, and a
   * converter that writes `DEFAULT user` instead of `DEFAULT 'user'` produces SQL that does not
   * run. Requoting is done once, at the parser boundary, rather than in each of the ten emitters.
   */
  default: string | null;
  note: string;
}

/** An `indexes { … }` entry. Carried through so a round trip does not silently drop it. */
export interface DbmlIndex {
  columns: string[];
  unique: boolean;
  pk: boolean;
  name: string;
  /** `btree`, `hash`, … or empty for the engine's default. */
  type: string;
}

export interface DbmlTable {
  /** `qualify(schema, name)`. The key every ref, position and selection uses. */
  id: string;
  /** `public` for an unqualified table, which is what DBML itself calls it. */
  schema: string;
  name: string;
  alias: string | null;
  note: string;
  fields: DbmlField[];
  indexes: DbmlIndex[];
}

export interface DbmlEnumValue {
  name: string;
  note: string;
}

export interface DbmlEnum {
  id: string;
  schema: string;
  name: string;
  values: DbmlEnumValue[];
}

export interface DbmlRef {
  /** Stable across a re-parse of the same document, so a hover or a selection survives a keystroke. */
  id: string;
  from: DbmlEndpoint;
  to: DbmlEndpoint;
}

/**
 * A parsed document.
 *
 * `error` is a *value*, not an exception: DBML is edited live, so half of everything the parser
 * ever sees is mid-word. The canvas keeps drawing the last good schema and the editor shows the
 * message — which is only possible if a failure comes back as data.
 */
export interface DbmlSchema {
  tables: DbmlTable[];
  enums: DbmlEnum[];
  refs: DbmlRef[];
  /** `null` when the document parsed. Multi-line when the parser reported several diagnostics. */
  error: string | null;
}

/** An empty schema. One literal, so "nothing parsed yet" and "parsed to nothing" are the same shape. */
export const EMPTY_SCHEMA: DbmlSchema = { tables: [], enums: [], refs: [], error: null };

/**
 * The id of a table or enum: `name` in the default schema, `schema.name` anywhere else.
 *
 * `public` is skipped rather than always prefixed because it is what every unqualified table gets,
 * and `public.users` in a document that never mentions a schema would show up in the UI, in the
 * generated code and in the layout comment as a name the user did not write.
 */
export function qualify(schema: string | null | undefined, name: string): string {
  const scope = (schema ?? "").trim();
  return !scope || scope === "public" ? name : `${scope}.${name}`;
}

/** The table an endpoint names, or `undefined`. The lookup every consumer would otherwise write. */
export function tableOf(schema: DbmlSchema, id: string): DbmlTable | undefined {
  return schema.tables.find((table) => table.id === id);
}

/**
 * Every table id that `id` is joined to, and the refs that join them.
 *
 * The one graph question the UI keeps asking — the canvas lights up a selection's neighbours, the
 * inspector lists them — so it is answered once, here, over ids rather than over names.
 */
export function neighboursOf(
  schema: DbmlSchema,
  id: string,
): { tables: Set<string>; refs: Set<string> } {
  const tables = new Set<string>();
  const refs = new Set<string>();
  for (const ref of schema.refs) {
    if (ref.from.table === id) {
      tables.add(ref.to.table);
      refs.add(ref.id);
    } else if (ref.to.table === id) {
      tables.add(ref.from.table);
      refs.add(ref.id);
    }
  }
  // A self-reference — `categories.parent_id > categories.id` — puts the selected table in its own
  // neighbour set, where it would then be drawn as "related" *and* as "selected". The selection
  // wins, so it is removed here rather than guarded at each of the two call sites.
  tables.delete(id);
  return { tables, refs };
}

/**
 * What the canvas lights up, and what it pushes back.
 *
 * Two gestures ask it and they want different answers, so the focus says which:
 *
 * - `table` — a selected or hovered box. Its neighbourhood: itself, everything joined to it, every
 *   ref that does the joining, and the columns those refs are made of on **both** sides.
 * - `ref` — the pointer resting on one line. Exactly the pair that line joins, that line, and the
 *   columns at its two ends. Strictly narrower than the table answer, which is the point: once a
 *   table is selected there are five lines leaving it, and "which one is this" is a question only
 *   the line itself can answer.
 *
 * Pure and here rather than inline in the renderer because it is a question about the *graph*, like
 * `neighboursOf` right above it — and because a highlight that quietly returns the wrong pair looks
 * exactly like a rendering bug, which is the kind of thing worth being able to assert on.
 */
export interface DbmlHighlight {
  /** Drawn lit. Everything else is pushed back. */
  tables: Set<string>;
  /** Ref ids, so a line's membership is exact rather than guessed from its endpoints. */
  refs: Set<string>;
  /** `tableId|columnName` for the columns the lit refs are actually made of. */
  columns: Set<string>;
}

export function highlightFor(
  schema: DbmlSchema,
  focus: { kind: "table" | "ref"; id: string } | null,
): DbmlHighlight | null {
  if (!focus) return null;
  const columns = new Set<string>();
  const take = (ref: DbmlRef) => {
    for (const field of ref.from.fields) columns.add(`${ref.from.table}|${field}`);
    for (const field of ref.to.fields) columns.add(`${ref.to.table}|${field}`);
  };

  if (focus.kind === "ref") {
    const ref = schema.refs.find((entry) => entry.id === focus.id);
    if (!ref) return null;
    take(ref);
    // Both ends, even when they are the same table: a self-reference lights one box, not none.
    return { tables: new Set([ref.from.table, ref.to.table]), refs: new Set([ref.id]), columns };
  }

  const { tables, refs } = neighboursOf(schema, focus.id);
  for (const ref of schema.refs) {
    if (ref.from.table === focus.id || ref.to.table === focus.id) take(ref);
  }
  return { tables: new Set([focus.id, ...tables]), refs, columns };
}
