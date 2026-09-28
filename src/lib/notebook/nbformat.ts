import {
  detectIndent,
  isJsonObject,
  jsonNumber,
  parseJson,
  serializeJson,
  compareKeys,
  type JsonObject,
  type JsonValue,
} from "./json";

/**
 * A Jupyter notebook (nbformat 4), as the editor holds it.
 *
 * **The file's own JSON is the model.** Each cell is the object that was read, with every field it
 * had — known or not, `metadata` included — and an edit replaces the fields it changes and nothing
 * else. Saving writes those objects back the way `nbformat` does (see `json.ts` and
 * [`splitLines`]), so a notebook opened and saved unchanged comes out byte for byte, and one with a
 * cell edited differs in that cell's lines only. That is the whole promise to `git diff`.
 *
 * Multi-line text is kept however the file had it. `nbformat` writes a cell's `source` (and text
 * outputs, and text MIME data) as a list of lines and reads either form; an untouched value stays a
 * list here, an edited one becomes a string, and the serializer splits strings into lines exactly
 * as Python's `str.splitlines(keepends=True)` does.
 *
 * Cell ids (nbformat 4.5+) are kept, and new cells get one — but only in a notebook that already
 * has them: a 4.4 notebook is not upgraded behind the user's back.
 */

export type CellType = "code" | "markdown" | "raw";

export interface NotebookCell {
  /** What React and the notebook's own bookkeeping know the cell by: its nbformat `id` when the
   *  notebook has ids, a key minted when it was read otherwise. Never written to the file. */
  key: string;
  /** The cell as it is in the file. */
  json: JsonObject;
}

export interface NotebookDoc {
  /** Everything at the top level but `cells` — `metadata`, `nbformat`, `nbformat_minor`, and any
   *  key some other tool put there. */
  top: JsonObject;
  cells: NotebookCell[];
  /** The indentation the file was written with (one space for Jupyter). */
  indent: string;
  /** The line ending it was written with. Jupyter on Windows writes in text mode, so its files end
   *  lines with CRLF; writing them back with LF would change every line. */
  eol?: "\n" | "\r\n";
}

export class NotebookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotebookFormatError";
  }
}

let keySeed = 0;
/** A key for a cell without an id. Only has to be unique in this window. */
function mintKey(): string {
  keySeed += 1;
  return `cell-${keySeed.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** An nbformat cell id: eight hex characters, as `nbformat.v4.random_cell_id` makes them. */
export function newCellId(taken: (id: string) => boolean): string {
  for (;;) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!taken(id)) return id;
  }
}

const ID_PATTERN = /^[a-zA-Z0-9-_]{1,64}$/;

/** Whether this notebook carries cell ids — nbformat 4.5 and later. */
export function hasCellIds(doc: NotebookDoc): boolean {
  const minor = jsonNumber(doc.top.nbformat_minor) ?? 0;
  return (jsonNumber(doc.top.nbformat) ?? 4) > 4 || minor >= 5;
}

/** A value that may be a string or a list of lines, as one string. */
export function textOf(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((line) => (typeof line === "string" ? line : String(line ?? ""))).join("");
  return "";
}

/**
 * Python's `str.splitlines(keepends=True)`: every line with its ending, split at `\n`, `\r`,
 * `\r\n`, and the rarer boundaries Python also honours (vertical tab, form feed, the file/group/
 * record separators, NEL, and the Unicode line and paragraph separators). An empty string has no
 * lines at all — which is why an empty cell is written `"source": []`.
 */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  const boundary = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length;
    out.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** MIME types whose data `nbformat` writes as lines, beside every `text/*`. */
const SPLIT_MIMES = new Set(["application/javascript", "image/svg+xml"]);

function splitBundle(bundle: JsonValue): JsonValue {
  if (!isJsonObject(bundle)) return bundle;
  let changed = false;
  const out: JsonObject = {};
  for (const [mime, data] of Object.entries(bundle)) {
    if (typeof data === "string" && (mime.startsWith("text/") || SPLIT_MIMES.has(mime))) {
      out[mime] = splitLines(data);
      changed = true;
    } else {
      out[mime] = data;
    }
  }
  return changed ? out : bundle;
}

function splitOutput(output: JsonValue): JsonValue {
  if (!isJsonObject(output)) return output;
  const type = output.output_type;
  if (type === "stream" && typeof output.text === "string") return { ...output, text: splitLines(output.text) };
  if ((type === "execute_result" || type === "display_data") && isJsonObject(output.data)) {
    const data = splitBundle(output.data);
    return data === output.data ? output : { ...output, data };
  }
  return output;
}

/** A cell as `nbformat.v4.rwbase.split_lines` leaves it before writing. */
function forWriting(cell: JsonObject): JsonObject {
  const out: JsonObject = { ...cell };
  if (typeof out.source === "string") out.source = splitLines(out.source);
  if (out.cell_type === "code" && Array.isArray(out.outputs)) out.outputs = out.outputs.map(splitOutput);
  if (isJsonObject(out.attachments)) {
    const attachments: JsonObject = {};
    for (const [name, bundle] of Object.entries(out.attachments)) attachments[name] = splitBundle(bundle);
    out.attachments = attachments;
  }
  return out;
}

/** Each cell's text, per indentation — a cell object is never changed in place, so an unchanged
 *  one is never serialized twice. What keeps saving on every keystroke cheap in a notebook of
 *  images: only the edited cell is written out again. */
const cellText = new WeakMap<JsonObject, { indent: string; text: string }>();

function serializeCell(cell: JsonObject, indent: string): string {
  const cached = cellText.get(cell);
  if (cached && cached.indent === indent) return cached.text;
  const text = indent.repeat(2) + serializeJson(forWriting(cell), indent, 2);
  cellText.set(cell, { indent, text });
  return text;
}

/** The notebook as Jupyter would write it, trailing newline included. */
export function serializeNotebook(doc: NotebookDoc): string {
  const indent = doc.indent;
  const keys = [...new Set([...Object.keys(doc.top), "cells"])].sort(compareKeys);
  const lines = keys.map((key) => {
    const value =
      key === "cells"
        ? doc.cells.length === 0
          ? "[]"
          : `[\n${doc.cells.map((cell) => serializeCell(cell.json, indent)).join(",\n")}\n${indent}]`
        : serializeJson(doc.top[key], indent, 1);
    return `${indent}${JSON.stringify(key)}: ${value}`;
  });
  const text = `{\n${lines.join(",\n")}\n}\n`;
  // Safe as a blanket replace: inside a JSON string a newline is always the escape `\n`, never
  // the character, so every raw newline here is one this serializer put between two tokens.
  return doc.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** An empty notebook — what an empty `.ipynb` file opens as. */
export function emptyNotebook(): NotebookDoc {
  return {
    top: { metadata: {}, nbformat: 4, nbformat_minor: 5 },
    cells: [],
    indent: " ",
  };
}

/**
 * Reads a notebook. Throws [`NotebookFormatError`] for anything that is not an nbformat 4
 * notebook — the editor then offers the file as the JSON it is.
 *
 * `previous` is the document this text replaces, when there is one: cells that are still there
 * keep their keys, so a reload from disk does not remount (and lose the undo history of) every
 * cell on screen.
 */
export function parseNotebook(text: string, previous?: NotebookDoc | null): NotebookDoc {
  if (text.trim() === "") return emptyNotebook();
  let value: JsonValue;
  try {
    value = parseJson(text);
  } catch (e) {
    throw new NotebookFormatError(e instanceof Error ? e.message : String(e));
  }
  if (!isJsonObject(value)) throw new NotebookFormatError("El archivo no es un notebook: falta el objeto principal");
  const major = jsonNumber(value.nbformat);
  if (major !== 4) {
    throw new NotebookFormatError(
      major === null ? "El archivo no es un notebook: falta «nbformat»" : `nbformat ${major} no es compatible (solo 4)`,
    );
  }
  if (!Array.isArray(value.cells)) throw new NotebookFormatError("El archivo no es un notebook: falta «cells»");
  const top: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) if (key !== "cells") top[key] = entry;

  const seenIds = new Set<string>();
  const cells: NotebookCell[] = value.cells.map((cell, index) => {
    if (!isJsonObject(cell) || typeof cell.cell_type !== "string") {
      throw new NotebookFormatError(`La celda ${index + 1} no es válida`);
    }
    const id = typeof cell.id === "string" && ID_PATTERN.test(cell.id) && !seenIds.has(cell.id) ? cell.id : null;
    if (id) seenIds.add(id);
    return { key: id ?? "", json: cell };
  });
  reuseKeys(cells, previous?.cells ?? []);
  const newline = text.indexOf("\n");
  const eol = newline > 0 && text[newline - 1] === "\r" ? "\r\n" : "\n";
  return { top, cells, indent: detectIndent(text) ?? " ", eol };
}

/**
 * Gives cells without an id the key of the cell they most plausibly are in `previous`: the same
 * text first, then the same position and type. The rest get fresh keys.
 */
function reuseKeys(cells: NotebookCell[], previous: NotebookCell[]): void {
  const taken = new Set(cells.filter((cell) => cell.key).map((cell) => cell.key));
  const bySource = new Map<string, string[]>();
  for (const old of previous) {
    if (taken.has(old.key)) continue;
    const text = `${String(old.json.cell_type)}\u0000${textOf(old.json.source)}`;
    const list = bySource.get(text);
    if (list) list.push(old.key);
    else bySource.set(text, [old.key]);
  }
  for (const cell of cells) {
    if (cell.key) continue;
    const text = `${String(cell.json.cell_type)}\u0000${textOf(cell.json.source)}`;
    const key = bySource.get(text)?.shift();
    if (key && !taken.has(key)) {
      cell.key = key;
      taken.add(key);
    }
  }
  cells.forEach((cell, index) => {
    if (cell.key) return;
    const old = previous[index];
    if (old && !taken.has(old.key) && old.json.cell_type === cell.json.cell_type) {
      cell.key = old.key;
      taken.add(old.key);
    } else {
      cell.key = mintKey();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export function cellType(cell: NotebookCell): CellType | string {
  return String(cell.json.cell_type);
}

export function cellSource(cell: NotebookCell): string {
  return textOf(cell.json.source);
}

export function cellOutputs(cell: NotebookCell): JsonObject[] {
  const outputs = cell.json.outputs;
  return Array.isArray(outputs) ? outputs.filter(isJsonObject) : [];
}

export function executionCount(cell: NotebookCell): number | null {
  return jsonNumber(cell.json.execution_count);
}

/** The kernelspec the notebook asks for — `metadata.kernelspec`. */
export function notebookKernelspec(doc: NotebookDoc): { name: string; displayName: string; language: string } | null {
  const metadata = doc.top.metadata;
  const spec = isJsonObject(metadata) ? metadata.kernelspec : null;
  if (!isJsonObject(spec)) return null;
  return {
    name: typeof spec.name === "string" ? spec.name : "",
    displayName: typeof spec.display_name === "string" ? spec.display_name : "",
    language: typeof spec.language === "string" ? spec.language : "",
  };
}

/** The notebook's programming language, lower-cased: its `language_info`, else its kernelspec,
 *  else Python — which is what an `.ipynb` without either almost always is. */
export function notebookLanguage(doc: NotebookDoc): string {
  const metadata = doc.top.metadata;
  const info = isJsonObject(metadata) ? metadata.language_info : null;
  if (isJsonObject(info) && typeof info.name === "string" && info.name) return info.name.toLowerCase();
  const spec = notebookKernelspec(doc);
  if (spec?.language) return spec.language.toLowerCase();
  return "python";
}

/** The extension the notebook's language uses (`.py`), from `language_info.file_extension`. */
export function notebookFileExtension(doc: NotebookDoc): string | null {
  const metadata = doc.top.metadata;
  const info = isJsonObject(metadata) ? metadata.language_info : null;
  const ext = isJsonObject(info) ? info.file_extension : null;
  return typeof ext === "string" && ext.startsWith(".") ? ext : null;
}

// ---------------------------------------------------------------------------------------------
// Editing — every function returns a new document and leaves the one it was given alone.
// ---------------------------------------------------------------------------------------------

function withCells(doc: NotebookDoc, cells: NotebookCell[]): NotebookDoc {
  return { ...doc, cells };
}

function mapCell(doc: NotebookDoc, key: string, update: (cell: NotebookCell) => NotebookCell): NotebookDoc {
  let changed = false;
  const cells = doc.cells.map((cell) => {
    if (cell.key !== key) return cell;
    const next = update(cell);
    if (next !== cell) changed = true;
    return next;
  });
  return changed ? withCells(doc, cells) : doc;
}

/** A fresh cell of `type`, with an id when the notebook uses them. */
export function newCell(doc: NotebookDoc, type: CellType, source = ""): NotebookCell {
  const json: JsonObject =
    type === "code"
      ? { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source }
      : { cell_type: type, metadata: {}, source };
  if (hasCellIds(doc)) {
    const ids = new Set(doc.cells.map((cell) => (typeof cell.json.id === "string" ? cell.json.id : "")));
    json.id = newCellId((id) => ids.has(id));
    return { key: json.id as string, json };
  }
  return { key: mintKey(), json };
}

export function setSource(doc: NotebookDoc, key: string, source: string): NotebookDoc {
  return mapCell(doc, key, (cell) => (cellSource(cell) === source ? cell : { ...cell, json: { ...cell.json, source } }));
}

/** Inserts `cell` at `index` (clamped). */
export function insertCell(doc: NotebookDoc, index: number, cell: NotebookCell): NotebookDoc {
  const cells = [...doc.cells];
  cells.splice(Math.max(0, Math.min(index, cells.length)), 0, cell);
  return withCells(doc, cells);
}

export function deleteCell(doc: NotebookDoc, key: string): NotebookDoc {
  const cells = doc.cells.filter((cell) => cell.key !== key);
  return cells.length === doc.cells.length ? doc : withCells(doc, cells);
}

/** Moves a cell up (`-1`) or down (`+1`); at an edge it stays. */
export function moveCell(doc: NotebookDoc, key: string, delta: -1 | 1): NotebookDoc {
  const from = doc.cells.findIndex((cell) => cell.key === key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= doc.cells.length) return doc;
  const cells = [...doc.cells];
  [cells[from], cells[to]] = [cells[to], cells[from]];
  return withCells(doc, cells);
}

/**
 * Changes a cell's type, keeping its id, source and metadata. A cell that stops being code loses
 * its outputs and execution count — the schema has no place for them on the other types — and one
 * that becomes code gains empty ones and loses attachments, which only Markdown and raw cells carry.
 */
export function changeCellType(doc: NotebookDoc, key: string, type: CellType): NotebookDoc {
  return mapCell(doc, key, (cell) => {
    if (cell.json.cell_type === type) return cell;
    const json: JsonObject = { ...cell.json, cell_type: type };
    if (type === "code") {
      delete json.attachments;
      json.execution_count = null;
      json.outputs = [];
    } else {
      delete json.outputs;
      delete json.execution_count;
    }
    return { ...cell, json };
  });
}

export function setOutputs(doc: NotebookDoc, key: string, outputs: JsonObject[]): NotebookDoc {
  return mapCell(doc, key, (cell) =>
    cell.json.cell_type !== "code" ? cell : { ...cell, json: { ...cell.json, outputs } },
  );
}

export function setExecutionCount(doc: NotebookDoc, key: string, count: number | null): NotebookDoc {
  return mapCell(doc, key, (cell) =>
    cell.json.cell_type !== "code" || executionCount(cell) === count
      ? cell
      : { ...cell, json: { ...cell.json, execution_count: count } },
  );
}

/** Every code cell's outputs and execution count gone — Jupyter's "clear all outputs". */
export function clearAllOutputs(doc: NotebookDoc): NotebookDoc {
  let changed = false;
  const cells = doc.cells.map((cell) => {
    if (cell.json.cell_type !== "code") return cell;
    const outputs = cell.json.outputs;
    if ((!Array.isArray(outputs) || outputs.length === 0) && cell.json.execution_count === null) return cell;
    changed = true;
    return { ...cell, json: { ...cell.json, outputs: [], execution_count: null } };
  });
  return changed ? withCells(doc, cells) : doc;
}

/** Sets `metadata[key]`, keeping the rest of the metadata as it was. */
export function setNotebookMetadata(doc: NotebookDoc, key: string, value: JsonValue): NotebookDoc {
  const metadata = isJsonObject(doc.top.metadata) ? doc.top.metadata : {};
  if (JSON.stringify(metadata[key] ?? null) === JSON.stringify(value)) return doc;
  return { ...doc, top: { ...doc.top, metadata: { ...metadata, [key]: value } } };
}
