import { isJsonObject, type JsonObject, type JsonValue } from "./json";
import {
  cellOutputs,
  setExecutionCount,
  setOutputs,
  textOf,
  type NotebookDoc,
} from "./nbformat";

/**
 * What a kernel's messages do to a notebook's outputs — the part of Jupyter's front end that
 * decides what ends up saved in the file, kept pure so it can be checked message by message.
 *
 * The rules are JupyterLab's (`OutputAreaModel`), because a notebook run here and saved should read
 * the same as one run there: consecutive stream chunks of the same stream merge into one output,
 * with `\b` and `\r` applied as a terminal would (a progress bar is one line, not a thousand);
 * `clear_output(wait=True)` clears when the next output arrives rather than at once, so a live
 * figure does not flicker; `update_display_data` rewrites every output that was displayed under
 * its `display_id`, in whatever cell it is.
 */

/**
 * Backspaces, then carriage returns, applied the way JupyterLab's `removeOverwrittenChars` applies
 * them: `\b` deletes the character before it on its line, `\r` returns to the start of the line and
 * what follows overwrites what was there (`"abcdef\rxy"` reads `"xycdef"`), and `\r\n` is a plain
 * line ending. A `\r` at the very end is kept — the next chunk of the stream is what it is waiting
 * to overwrite.
 */
export function fixOverwrites(text: string): string {
  if (!text.includes("\r") && !text.includes("\b")) return text;
  let out = text;
  if (out.includes("\b")) {
    const kept: string[] = [];
    for (const ch of out) {
      if (ch === "\b" && kept.length > 0 && kept[kept.length - 1] !== "\n") kept.pop();
      else kept.push(ch);
    }
    out = kept.join("");
  }
  if (!out.includes("\r")) return out;
  out = out.replace(/\r+\n/g, "\n");
  const pending = out.endsWith("\r");
  const lines = out.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    let visible = "";
    for (const segment of line.split("\r")) {
      if (segment) visible = segment + visible.slice(segment.length);
    }
    return visible;
  });
  return lines.join("\n") + (pending ? "\r" : "");
}

/**
 * A stream chunk added to a cell's outputs: merged into the last output when that is the same
 * stream, a new output otherwise.
 *
 * Only the last line of what is already there is re-read, since nothing in a new chunk can reach
 * past a newline — which keeps a loop printing a hundred thousand chunks linear.
 */
export function appendStream(outputs: JsonObject[], name: string, text: string): JsonObject[] {
  const last = outputs[outputs.length - 1];
  if (last && last.output_type === "stream" && last.name === name) {
    const before = textOf(last.text);
    const cut = before.lastIndexOf("\n") + 1;
    const merged = before.slice(0, cut) + fixOverwrites(before.slice(cut) + text);
    return [...outputs.slice(0, -1), { ...last, text: merged }];
  }
  return [...outputs, { name, output_type: "stream", text: fixOverwrites(text) }];
}

/** The nbformat output a kernel message stands for, or `null` for one that is not an output. */
export function outputFromMessage(msgType: string, content: JsonObject): JsonObject | null {
  const data = isJsonObject(content.data) ? content.data : {};
  const metadata = isJsonObject(content.metadata) ? content.metadata : {};
  switch (msgType) {
    case "stream":
      return { name: typeof content.name === "string" ? content.name : "stdout", output_type: "stream", text: textOf(content.text) };
    case "display_data":
      // `transient` (the display id) is the front end's business, never the file's.
      return { data, metadata, output_type: "display_data" };
    case "execute_result":
      return { data, execution_count: content.execution_count ?? null, metadata, output_type: "execute_result" };
    case "error":
      return {
        ename: typeof content.ename === "string" ? content.ename : "",
        evalue: typeof content.evalue === "string" ? content.evalue : "",
        output_type: "error",
        traceback: Array.isArray(content.traceback) ? content.traceback.map((line) => textOf(line)) : [],
      };
    default:
      return null;
  }
}

/** What running a notebook needs remembered between messages that the file does not hold. */
export interface OutputState {
  /** Cells whose outputs a `clear_output(wait=True)` is holding for the next output. */
  clearPending: Set<string>;
  /** The display id each output was shown under — `transient`, so never saved. */
  displayIds: WeakMap<JsonObject, string>;
}

export function newOutputState(): OutputState {
  return { clearPending: new Set(), displayIds: new WeakMap() };
}

function displayIdOf(content: JsonObject): string | null {
  const transient = content.transient;
  if (!isJsonObject(transient)) return null;
  return typeof transient.display_id === "string" && transient.display_id ? transient.display_id : null;
}

/** The outputs a new one lands among — none, if a `clear_output(wait=True)` was waiting for it. */
function landing(doc: NotebookDoc, key: string, state: OutputState): JsonObject[] {
  const cell = doc.cells.find((c) => c.key === key);
  if (!cell) return [];
  if (state.clearPending.delete(key)) return [];
  return cellOutputs(cell);
}

/**
 * Applies one kernel message addressed to the cell `key` (by its parent execution). Messages that
 * do not touch outputs — `status`, replies — come back as the same document.
 */
export function applyOutputMessage(
  doc: NotebookDoc,
  key: string,
  msgType: string,
  content: JsonObject,
  state: OutputState,
): NotebookDoc {
  switch (msgType) {
    case "stream": {
      const outputs = landing(doc, key, state);
      return setOutputs(doc, key, appendStream(outputs, typeof content.name === "string" ? content.name : "stdout", textOf(content.text)));
    }
    case "display_data":
    case "execute_result":
    case "error": {
      const output = outputFromMessage(msgType, content);
      if (!output) return doc;
      const id = msgType === "error" ? null : displayIdOf(content);
      if (id) state.displayIds.set(output, id);
      return setOutputs(doc, key, [...landing(doc, key, state), output]);
    }
    case "clear_output": {
      if (content.wait === true) {
        state.clearPending.add(key);
        return doc;
      }
      state.clearPending.delete(key);
      return setOutputs(doc, key, []);
    }
    case "update_display_data": {
      const id = displayIdOf(content);
      return id ? updateDisplay(doc, id, content, state) : doc;
    }
    case "execute_input": {
      const count = typeof content.execution_count === "number" ? content.execution_count : null;
      return count === null ? doc : setExecutionCount(doc, key, count);
    }
    default:
      return doc;
  }
}

/** Every output shown under `id`, in any cell, given the new data. */
export function updateDisplay(doc: NotebookDoc, id: string, content: JsonObject, state: OutputState): NotebookDoc {
  let next = doc;
  for (const cell of doc.cells) {
    const outputs = cellOutputs(cell);
    if (!outputs.some((output) => state.displayIds.get(output) === id)) continue;
    const updated = outputs.map((output) => {
      if (state.displayIds.get(output) !== id) return output;
      const replaced: JsonObject = {
        ...output,
        data: isJsonObject(content.data) ? content.data : {},
        metadata: isJsonObject(content.metadata) ? content.metadata : {},
      };
      state.displayIds.set(replaced, id);
      return replaced;
    });
    next = setOutputs(next, cell.key, updated);
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Choosing what to show
// ---------------------------------------------------------------------------------------------

/** MIME types that only mean something with JavaScript running — widgets, Plotly, Bokeh, Vega. */
const NEEDS_JS = /^application\/(?:javascript|vnd\.jupyter\.widget-view\+json|vnd\.plotly\.v1\+json|vnd\.bokehjs_(?:exec|load)\.v0\+json|vnd\.holoviews_(?:exec|load)\.v0\+json|vnd\.vega(?:lite)?\.v\d+(?:\.\d+)?\+json)$/;

/** The order a rich output is shown in: the first of these a bundle has wins. */
export const MIME_ORDER = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "text/html",
  "text/markdown",
  "application/json",
  "text/latex",
  "text/plain",
] as const;

export type RenderedMime = (typeof MIME_ORDER)[number];

export interface MimeChoice {
  /** What to draw, or `null` when nothing in the bundle can be drawn here. */
  mime: RenderedMime | null;
  /** The bundle held something that needs JavaScript — said so, instead of drawing a blank frame. */
  needsJs: boolean;
  /** The types that were there, for the note when nothing could be drawn. */
  available: string[];
}

/**
 * Which of a bundle's representations to draw.
 *
 * A bundle with a JavaScript-only type is shown as the note that says so, plus an image or its
 * plain text when it carries one — but not its HTML, which for these libraries is a `<script>` that
 * the sandboxed frame will never run, and would draw as an empty box.
 */
export function chooseMime(data: JsonObject): MimeChoice {
  const available = Object.keys(data);
  const needsJs = available.some((mime) => NEEDS_JS.test(mime));
  for (const mime of MIME_ORDER) {
    if (!(mime in data)) continue;
    if (needsJs && (mime === "text/html" || mime === "text/markdown")) continue;
    return { mime, needsJs, available };
  }
  return { mime: null, needsJs, available };
}

/** An image's data as a URL an `<img>` can show. SVG is text and goes URL-encoded; the rest is
 *  base64 already, give or take the newlines some writers leave in it. */
export function imageSrc(mime: string, data: JsonValue): string {
  const raw = textOf(data);
  if (mime === "image/svg+xml") return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
  return `data:${mime};base64,${raw.replace(/\s+/g, "")}`;
}

/** An output as plain text — for copying, for the AI's context, for search. Images are named. */
export function outputText(output: JsonObject): string {
  switch (output.output_type) {
    case "stream":
      return textOf(output.text).replace(/\r$/, "");
    case "error": {
      const trace = Array.isArray(output.traceback) ? output.traceback.map((line) => textOf(line)).join("\n") : "";
      return trace || `${textOf(output.ename)}: ${textOf(output.evalue)}`;
    }
    case "execute_result":
    case "display_data": {
      const data = isJsonObject(output.data) ? output.data : {};
      if ("text/plain" in data) return textOf(data["text/plain"]);
      const image = Object.keys(data).find((mime) => mime.startsWith("image/"));
      return image ? `[${image}]` : "";
    }
    default:
      return "";
  }
}

/** A long text shown as its head and tail, with how much was left out between them. */
export interface Clipped {
  head: string;
  tail: string;
  hiddenLines: number;
}

/** `null` when the text is short enough to show whole. */
export function clipLines(text: string, headLines = 100, tailLines = 40, maxChars = 200_000): Clipped | null {
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines + 10 && text.length <= maxChars) return null;
  if (lines.length <= headLines + tailLines + 10) {
    // Few lines, enormous ones: cut by characters instead.
    const half = Math.floor(maxChars / 2);
    return { head: text.slice(0, half), tail: text.slice(-half), hiddenLines: 0 };
  }
  return {
    head: lines.slice(0, headLines).join("\n"),
    tail: lines.slice(-tailLines).join("\n"),
    hiddenLines: lines.length - headLines - tailLines,
  };
}
