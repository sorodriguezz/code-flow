import type { DbColumn, DbForeignKey, DbKind } from "../../types/database";
import type { TranslationKey } from "../i18n/translations";

/**
 * What one engine's records are made of, in that engine's own terms.
 *
 * The workspace talks to engines that agree on almost nothing below the surface, and the views that
 * read a record used to paper over it: every field got a `PK` badge from a primary-key list, a type
 * line from `type_name`, and a foreign-key arrow. Three of those concepts belong to relational
 * engines, one is spelled differently on IRIS, and one MongoDB does not have at all. Where an
 * engine had no answer the view drew nothing — so "this engine has no foreign keys" and "this table
 * happens to have none" came out looking the same, and `_id`, the one field in a document that *is*
 * an identity, was never marked at all.
 *
 * So each engine says what it has, and the views ask instead of assuming. A concept an engine lacks
 * is then missing by declaration rather than by accident.
 *
 * **Adding an engine.** `Record<DbKind, …>` is exhaustive on purpose: a new `DbKind` will not
 * compile until it has an entry here. That is the point. A key-value store or a vector index should
 * have to answer what it calls a record and what identifies one before any of these views will draw
 * it, rather than inheriting Postgres's answers by saying nothing.
 */
export interface EngineRecordModel {
  /** What the engine calls a page of these things — rows, documents. Used where the view counts
   *  them, so a MongoDB result is never described as a number of rows. */
  countLabel: TranslationKey;
  /** The same noun in the singular, numbered: what heads one record's block. Separate from
   *  `countLabel` because "3 documents" and "Document 3" are different sentences in most languages,
   *  and one of them was reading "Row 3" over a document. */
  itemLabel: TranslationKey;
  /**
   * The same noun again, in the four sentences a result panel writes.
   *
   * Separate from `countLabel` — which heads a modal and is written "3 record(s)" — because a
   * status line is read at a glance and the parenthetical plural is noise there. Grouped rather
   * than four more fields on the interface, since they are one decision: what this engine calls
   * the things it just returned.
   *
   * These are what stopped a Mongo console reporting "50 filas" under a page of documents.
   */
  counts: {
    /** "{n} rows" — the plain count. */
    n: TranslationKey;
    /** "{n} of {total}" — a page out of a known total. */
    ofTotal: TranslationKey;
    /** "{n} rows affected" — what a write reports back. */
    affected: TranslationKey;
    /** "{n} selected" — the gutter selection's badge. */
    selected: TranslationKey;
    /** What a grid says when the result has no fields at all to draw. "No columns" is a claim about
     *  a schema, and a collection has none to be missing. */
    empty: TranslationKey;
  };
  /**
   * The field that identifies a record, or `null` for an engine with no such notion.
   *
   * `badge` is what is drawn beside the field name, in the engine's own spelling: `PK` reads as
   * "primary key", which is the wrong two words for a document.
   */
  identity: { label: TranslationKey; badge: string } | null;
  /**
   * Field names that are an identity by convention rather than by declaration.
   *
   * A catalog read knows a table's primary key. A console result does not, and for an arbitrary
   * query it never can — there is no one table to resolve against. These are the names an engine
   * gives its own identity regardless, so the field worth marking is still marked in a result that
   * nobody could attribute to a table.
   */
  conventionalIdentity: string[];
  /**
   * Where a field's type comes from.
   *
   * - `"schema"` — declared on the column, and the same for every record.
   * - `"record"` — carried by the value, so what is shown describes the record that answered and
   *   the next one is free to disagree.
   * - `"none"` — the engine reports no per-field type worth drawing.
   *
   * This describes the *engine*, not one result: Postgres columns have types, but a console result
   * read over the simple query protocol carries none of them, and an empty `type_name` is what says
   * so. Both have to be true before a type is drawn.
   */
  fieldTypes: "schema" | "record" | "none";
  /**
   * Whether the engine declares references between records — what the "open the referenced table"
   * arrow follows. `false` drops the affordance rather than leaving one that never fires.
   */
  references: boolean;
}

/**
 * What the relational engines share: a declared schema, a primary key, real foreign keys.
 *
 * Written once rather than three times, but as a starting point an entry can disagree with — not as
 * a default an engine inherits by staying silent. Every engine below still names its own model.
 */
const RELATIONAL: EngineRecordModel = {
  countLabel: "db.countRows",
  itemLabel: "db.rowN",
  counts: {
    n: "db.rowsN",
    ofTotal: "db.rowsOfTotal",
    affected: "db.rowsAffected",
    selected: "db.rowsSelectedN",
    empty: "db.noColumns",
  },
  identity: { label: "db.primaryKey", badge: "PK" },
  conventionalIdentity: [],
  fieldTypes: "schema",
  references: true,
};

export const ENGINE_RECORD_MODELS: Record<DbKind, EngineRecordModel> = {
  postgres: RELATIONAL,
  // Postgres with a bill attached: same wire protocol, same catalog, same everything this describes.
  supabase: RELATIONAL,
  sqlserver: RELATIONAL,
  iris: {
    ...RELATIONAL,
    // IRIS projects a persistent class as a table with an `ID` column — the RowID — and that is
    // what identifies the row, whether or not the class also declares a primary key. Naming it "the
    // primary key" in the UI would be repeating a word IRIS itself doesn't use here.
    identity: { label: "db.rowId", badge: "ID" },
    // Worth marking without a catalog read behind it: a console `SELECT` on a persistent class
    // brings `ID` back, and it is the column you copy when you want to find the row again.
    conventionalIdentity: ["ID"],
  },
  mongodb: {
    countLabel: "db.countDocuments",
    itemLabel: "db.documentN",
    counts: {
      n: "db.documentsN",
      ofTotal: "db.documentsOfTotal",
      affected: "db.documentsAffected",
      selected: "db.documentsSelectedN",
      empty: "db.noFields",
    },
    identity: { label: "db.documentId", badge: "_id" },
    // Every document has one and no catalog read ever produces it — the flattened keys of a query
    // result are all these views are ever given.
    conventionalIdentity: ["_id"],
    // Off the value, not off a declaration: `{ n: 1 }` and `{ n: "one" }` sit in one collection
    // happily, and the driver reports the type of the first document that answered for the field.
    fieldTypes: "record",
    // Not "this collection declares none" — the engine has no such concept, so an arrow that
    // follows one is never the right control here.
    references: false,
  },
};

/**
 * The model for a connection's engine.
 *
 * The fallback is for a stored connection whose `kind` this build doesn't know — a workspace
 * carried back to an older version — which should read as an ordinary relational result rather than
 * crash the pane it is drawn in.
 */
export function recordModel(kind: DbKind): EngineRecordModel {
  return ENGINE_RECORD_MODELS[kind] ?? RELATIONAL;
}

/** What a catalog read knows about the fields. Empty for a console result. */
export interface FieldContext {
  primaryKeys?: Set<string>;
  foreignKeys?: Map<string, DbForeignKey>;
}

/** What a view draws beside one field, once the engine's model and the context have been put
 *  together. */
export interface FieldFacts {
  identity: boolean;
  /** Empty when there is nothing to draw — either the engine has no field types, or this result
   *  didn't carry them. */
  type: string;
  /** `type` came off a value rather than a declaration, so it describes the record that answered
   *  and not the field. Drawn as a hint, never as a promise. */
  typeFromRecord: boolean;
  reference: DbForeignKey | null;
}

export function fieldFacts(
  model: EngineRecordModel,
  column: DbColumn,
  context: FieldContext = {},
): FieldFacts {
  return {
    identity:
      model.identity !== null &&
      ((context.primaryKeys?.has(column.name) ?? false) ||
        model.conventionalIdentity.includes(column.name)),
    type: model.fieldTypes === "none" ? "" : column.type_name,
    typeFromRecord: model.fieldTypes === "record",
    // Gated on the engine and not merely on the map being empty, so an engine without references
    // never draws the control — and a relational table that genuinely has none still doesn't.
    reference: model.references ? (context.foreignKeys?.get(column.name) ?? null) : null,
  };
}
