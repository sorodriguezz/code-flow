import type { TranslationKey } from "./i18n/translations";

/**
 * Delimited text — `.csv`, `.tsv`, `.psv` — read as columns, the way the Rainbow CSV extension
 * reads it: every column in a colour of its own, so the eye can follow the fourth field down two
 * hundred rows without counting commas.
 *
 * This file is the half with no Monaco in it: which separators exist, which one a file uses, and how
 * one line splits into fields. `monacoCsv.ts` turns that into editor tokens, and the settings pane
 * draws its preview from the same tokenizer, so the sample there is exactly what the editor will do.
 *
 * # One language per separator
 *
 * Monaco hands a tokenizer the line and nothing else — no model, no file name — so the separator
 * cannot be a parameter. It is a language instead: `csv`, `csv-semicolon`, `tsv`, … each registered
 * with a tokenizer bound to its own character. Picking the separator for a file is then picking the
 * language the editor is given, which is also what Rainbow CSV does with its dialects.
 */

export type CsvSeparatorId = "comma" | "semicolon" | "tab" | "pipe" | "colon" | "caret" | "tilde";

/** What the setting stores: a separator, or "look at the file". */
export type CsvSeparatorChoice = "auto" | CsvSeparatorId;

export interface CsvSeparator {
  id: CsvSeparatorId;
  char: string;
  /** Monaco language id. Comma and tab keep the short names the formats already have. */
  language: string;
  /** How the separator is shown on a button: the character itself, or a mark for the invisible one. */
  glyph: string;
  labelKey: TranslationKey;
}

export const CSV_SEPARATORS: CsvSeparator[] = [
  { id: "comma", char: ",", language: "csv", glyph: ",", labelKey: "csv.sep.comma" },
  { id: "semicolon", char: ";", language: "csv-semicolon", glyph: ";", labelKey: "csv.sep.semicolon" },
  { id: "tab", char: "\t", language: "tsv", glyph: "⇥", labelKey: "csv.sep.tab" },
  { id: "pipe", char: "|", language: "csv-pipe", glyph: "|", labelKey: "csv.sep.pipe" },
  { id: "colon", char: ":", language: "csv-colon", glyph: ":", labelKey: "csv.sep.colon" },
  { id: "caret", char: "^", language: "csv-caret", glyph: "^", labelKey: "csv.sep.caret" },
  { id: "tilde", char: "~", language: "csv-tilde", glyph: "~", labelKey: "csv.sep.tilde" },
];

/**
 * The separators auto-detection may answer with.
 *
 * Deliberately not all of them. A colon is in every timestamp, so a two-column file of ids and times
 * splits *more* consistently on `:` than on the comma it actually uses; caret and tilde are rare
 * enough that guessing them costs more wrong answers than it saves. Those stay one click away in the
 * editor's own picker.
 */
const DETECTABLE: CsvSeparatorId[] = ["comma", "semicolon", "tab", "pipe"];

export function separatorById(id: CsvSeparatorId): CsvSeparator {
  return CSV_SEPARATORS.find((sep) => sep.id === id) ?? CSV_SEPARATORS[0];
}

export function isCsvSeparatorChoice(value: string | null | undefined): value is CsvSeparatorChoice {
  return value === "auto" || CSV_SEPARATORS.some((sep) => sep.id === value);
}

/**
 * The separator a file's extension promises, or `null` for a file that is not delimited text.
 *
 * `.tsv` and `.psv` name their separator; `.csv` only claims to, since half of Europe's spreadsheets
 * save it with semicolons — which is why the setting is about `.csv` and these two follow their name.
 */
export function extensionSeparator(path: string): CsvSeparatorId | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "csv":
      return "comma";
    case "tsv":
    case "tab":
      return "tab";
    case "psv":
      return "pipe";
    default:
      return null;
  }
}

/** How many records the detector reads, and how far into the text at most. The head of a file is
 *  where its shape is decided; reading a 200 MB export end to end to learn it uses commas is waste. */
const SAMPLE_RECORDS = 40;
const SAMPLE_CHARS = 64 * 1024;

/**
 * Fields per record in the head of `text`, split on `sep`.
 *
 * Quote-aware, because that is the whole reason a CSV quotes a field: `"Santiago, Chile"` is one
 * column, and a quoted field may run over several lines. Blank lines are not records. A record cut
 * off by the sample limit is left out rather than counted short.
 */
export function fieldCounts(text: string, sep: string): number[] {
  const counts: number[] = [];
  const end = Math.min(text.length, SAMPLE_CHARS);
  let fields = 1;
  let quoted = false;
  let fieldStart = true;
  let content = false;
  for (let at = 0; at < end; at += 1) {
    const ch = text[at];
    if (quoted) {
      if (ch === '"') {
        if (text[at + 1] === '"') at += 1;
        else quoted = false;
      }
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[at + 1] === "\n") at += 1;
      if (content) counts.push(fields);
      if (counts.length >= SAMPLE_RECORDS) return counts;
      fields = 1;
      fieldStart = true;
      content = false;
      continue;
    }
    content = true;
    if (ch === sep) {
      fields += 1;
      fieldStart = true;
    } else if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else {
      fieldStart = false;
    }
  }
  if (content && end === text.length) counts.push(fields);
  return counts;
}

/**
 * Which of the common separators `text` is written with.
 *
 * The one that splits the records into the same number of fields wins — agreement first, then the
 * number of columns, then the extension's own promise as the tie-break. Agreement is bucketed rather
 * than compared raw, so one ragged row among forty does not hand the file to a separator that
 * happens to appear once per line inside the values (a `|` in every description, say) over the comma
 * that gives it ten real columns.
 *
 * Nothing splits → `fallback`: a one-column file, or an empty one.
 */
export function detectSeparator(text: string, fallback: CsvSeparatorId): CsvSeparatorId {
  let best: { id: CsvSeparatorId; bucket: number; columns: number } | null = null;
  for (const id of DETECTABLE) {
    const counts = fieldCounts(text, separatorById(id).char);
    if (counts.length === 0) continue;
    const tally = new Map<number, number>();
    for (const n of counts) tally.set(n, (tally.get(n) ?? 0) + 1);
    let columns = 0;
    let agreeing = 0;
    for (const [n, seen] of tally) {
      if (seen > agreeing || (seen === agreeing && n > columns)) {
        columns = n;
        agreeing = seen;
      }
    }
    if (columns < 2) continue;
    const agreement = agreeing / counts.length;
    const bucket = agreement >= 0.9 ? 2 : agreement >= 0.6 ? 1 : 0;
    if (bucket === 0) continue;
    const better =
      !best ||
      bucket > best.bucket ||
      (bucket === best.bucket && columns > best.columns) ||
      (bucket === best.bucket && columns === best.columns && id === fallback);
    if (better) best = { id, bucket, columns };
  }
  return best?.id ?? fallback;
}

export interface CsvPrefs {
  /** Whether delimited files are coloured at all. Off, they open as plain text, as they used to. */
  rainbow: boolean;
  /** The setting: what a `.csv` uses. `.tsv`/`.psv` are always read by detection, falling back to
   *  what their name promises — a forced `;` meant for `.csv` files has no business in a `.tsv`. */
  separator: CsvSeparatorChoice;
  /** This one file's pick from the editor's toolbar, which beats both. */
  override?: CsvSeparatorId | null;
}

/**
 * The separator `path` is read with, or `null` when it is not delimited text (or colouring is off).
 *
 * `text` is only consulted when something says "auto" — pass the text the file had when it was
 * opened, not the live buffer, or typing a `;` into the header would re-colour the whole file.
 */
export function csvSeparatorFor(path: string, text: string, prefs: CsvPrefs): CsvSeparatorId | null {
  if (!prefs.rainbow) return null;
  const promised = extensionSeparator(path);
  if (!promised) return null;
  if (prefs.override) return prefs.override;
  if (prefs.separator !== "auto" && promised === "comma") return prefs.separator;
  return detectSeparator(text, promised);
}

/** The Monaco language for [`csvSeparatorFor`]'s answer, or `null` for "not a delimited file". */
export function csvLanguageFor(path: string, text: string, prefs: CsvPrefs): string | null {
  const id = csvSeparatorFor(path, text, prefs);
  return id ? separatorById(id).language : null;
}

// ---------------------------------------------------------------------------------------------
// Tokenizing one line
// ---------------------------------------------------------------------------------------------

/**
 * How many columns get a colour of their own before the cycle starts again.
 *
 * Eight, because that is how many distinct token colours the sparsest shipped scheme can give
 * without repeating one (see `rainbowPalette` in `codeThemes.ts`). Past eight, column nine wears
 * column one's colour — far enough apart that no one reads the two as the same field.
 */
export const RAINBOW_COLUMNS = 8;

/** Where the tokenizer is between lines: which column it is in, and whether a quoted field is still
 *  open — the one way a record spans two lines. */
export interface CsvLineState {
  column: number;
  quoted: boolean;
}

export const CSV_START: CsvLineState = { column: 0, quoted: false };

export interface CsvSpan {
  start: number;
  /** A column's colour slot, 1-based, or `null` for the separator between two of them. */
  slot: number | null;
}

/** The colour slot of a zero-based column: `1…RAINBOW_COLUMNS`, cycling. */
export function slotOf(column: number): number {
  return (column % RAINBOW_COLUMNS) + 1;
}

/**
 * Splits one line into coloured spans.
 *
 * A line that starts outside a quote starts a new record, so it starts at column zero; one that
 * starts inside a quote is the rest of a field the previous line opened, and keeps its column. A
 * quote only opens a field when it is the field's first character — anywhere else it is data, the
 * way every spreadsheet reads `5" pipe`.
 */
export function tokenizeCsvLine(
  line: string,
  sep: string,
  state: CsvLineState,
): { spans: CsvSpan[]; end: CsvLineState } {
  let column = state.quoted ? state.column : 0;
  let quoted = state.quoted;
  let fieldStart = !quoted;
  const spans: CsvSpan[] = [];
  if (line.length > 0) spans.push({ start: 0, slot: slotOf(column) });

  for (let at = 0; at < line.length; at += 1) {
    const ch = line[at];
    if (quoted) {
      if (ch === '"') {
        if (line[at + 1] === '"') at += 1;
        else quoted = false;
      }
      continue;
    }
    if (ch === sep) {
      spans.push({ start: at, slot: null });
      column += 1;
      if (at + 1 < line.length) spans.push({ start: at + 1, slot: slotOf(column) });
      fieldStart = true;
      continue;
    }
    if (ch === '"' && fieldStart) quoted = true;
    fieldStart = false;
  }

  return { spans, end: { column, quoted } };
}
