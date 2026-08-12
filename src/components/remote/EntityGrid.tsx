import { preview, type GridColumn } from "../common/DataGrid";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * What an Azure Table entity's columns mean — and nothing about how a grid is drawn.
 *
 * The drawing moved to `common/DataGrid` once three other listings needed the same windowed grid.
 * What could not move is this: **a Table has no schema, so "this property is absent" is a fact about
 * the row, not about the column.** Azure does not store nulls — setting a property to null deletes
 * it — so a column exists exactly as long as some entity still carries it, and the difference
 * between "absent" and "the empty string" is the difference between two states the service treats
 * differently. That distinction is true of a Table entity and of nothing else the grid draws: a
 * share row with no size has no size because a share hasn't got one, and drawing an italic `null`
 * there would be Azure Table theology in a file browser.
 *
 * So the semantics come out as a column factory. `DataGrid` asks a column for text and gets `null`
 * back; what `null` looks like — the dim italic, the literal word, the "this entity has no X" hover
 * — is decided here.
 */

/**
 * One cell's text, or `null` when the entity has no such property.
 *
 * The distinction is the point: `null` is drawn as a dim italic `null` the way Storage Explorer
 * draws it, an empty string is drawn as nothing, and a sort puts the two in different places.
 * Objects and arrays are stringified — a Table property can hold a JSON blob, and a grid row is not
 * where it gets expanded.
 */
export function cellText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * One `GridColumn` per property name, in the order given.
 *
 * The label *is* the key here, and deliberately untranslated: these are wire names the user wrote
 * when they wrote the entity, and a `PartitionKey` header that changed with the language would stop
 * matching the filter expression typed under it. Every one is `mono` for the same reason — a
 * property name and its value are both literals, and reading them in the page's prose face invites
 * the assumption that a grid of them is a report.
 *
 * `cell`, `cellClass` and `title` carry the three Table-only facts. They are supplied here rather
 * than by the grid because each of them is a statement about *absence*, which only this service has
 * an opinion about.
 */
export function entityColumns(
  names: string[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): GridColumn<Record<string, unknown>>[] {
  return names.map((name) => ({
    key: name,
    label: name,
    text: (row) => cellText(row, name),
    cell: (row) => {
      const text = cellText(row, name);
      // The literal word, not a blank: a blank cell says "this property is empty here" and an
      // absent one is a different claim — the entity hasn't got the property at all.
      return text === null ? "null" : preview(text);
    },
    cellClass: (row) => (cellText(row, name) === null ? "italic text-[var(--cf-text-muted)]" : ""),
    // The hover is the value in full, untruncated — except where there is no value, and then it is
    // the sentence that says so rather than an empty tooltip.
    title: (row) => cellText(row, name) ?? t("remote.tableNullTitle", { column: name }),
    mono: true,
  }));
}
