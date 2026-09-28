import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JsonNumber, compareKeys, detectIndent, isJsonObject, parseJson, serializeJson } from "./json";
import {
  NotebookFormatError,
  cellOutputs,
  cellSource,
  changeCellType,
  clearAllOutputs,
  deleteCell,
  emptyNotebook,
  hasCellIds,
  insertCell,
  moveCell,
  newCell,
  notebookKernelspec,
  notebookLanguage,
  parseNotebook,
  serializeNotebook,
  setSource,
  splitLines,
} from "./nbformat";

/** Written by Python's `json` exactly as `nbformat.write` calls it — see the generator's notes in
 *  the fixtures' own shape: split lines, indent 1, sorted keys, `ensure_ascii=False`, newline. */
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("json", () => {
  it("keeps number text a JS number would not reproduce", () => {
    const value = parseJson('{"a": 1.0, "b": 1e-05, "c": 12345678901234567890, "d": 0.5, "e": -3, "f": 1e+20}');
    expect(isJsonObject(value)).toBe(true);
    const object = value as Record<string, unknown>;
    expect(object.a).toBeInstanceOf(JsonNumber);
    expect((object.a as JsonNumber).raw).toBe("1.0");
    expect((object.b as JsonNumber).raw).toBe("1e-05");
    expect((object.c as JsonNumber).raw).toBe("12345678901234567890");
    expect(object.d).toBe(0.5);
    expect(object.e).toBe(-3);
    expect(serializeJson(value as never, " ")).toBe(
      '{\n "a": 1.0,\n "b": 1e-05,\n "c": 12345678901234567890,\n "d": 0.5,\n "e": -3,\n "f": 1e+20\n}',
    );
  });

  it("reads escapes, surrogate pairs and a __proto__ key as data", () => {
    const value = parseJson('{"s": "tab\\there \\"q\\" \\\\ \\u0001 \\u001b \\ud83d\\ude00 \\/", "__proto__": {"x": 1}}') as Record<
      string,
      unknown
    >;
    expect(value.s).toBe('tab\there "q" \\ \u0001 \u001b 😀 /');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toContain("__proto__");
  });

  it("escapes strings the way Python's json does with ensure_ascii=False", () => {
    // `json.dumps({"s": …}, ensure_ascii=False)` in Python 3.
    expect(serializeJson({ s: 'tab\there "q" \\ \u0001 \u001b é 😀 \u2028 \u007f' }, "")).toBe(
      '{\n"s": "tab\\there \\"q\\" \\\\ \\u0001 \\u001b é 😀 \u2028 \u007f"\n}',
    );
  });

  it("refuses what is not JSON", () => {
    for (const bad of ['{"a": 1,}', "[1 2]", '{"a": "\u0001"}', '{"a": tru}', "{} x", '"open', '{"a": "\\x"}']) {
      expect(() => parseJson(bad), bad).toThrow();
    }
  });

  it("sorts keys the way Python's sorted() does", () => {
    expect(["a", "B", "_x", "Z", "b"].sort(compareKeys)).toEqual(["B", "Z", "_x", "a", "b"]);
    // Beyond the BMP a code point outranks U+FFxx, where UTF-16 order says the opposite.
    expect(["😀", "\uff01"].sort(compareKeys)).toEqual(["\uff01", "😀"]);
  });

  it("detects the indentation a document was written with", () => {
    expect(detectIndent('{\n "a": 1\n}')).toBe(" ");
    expect(detectIndent('{\n    "a": 1\n}')).toBe("    ");
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectIndent('{"a": 1}')).toBeNull();
  });
});

describe("splitLines", () => {
  it("splits exactly where Python's str.splitlines(keepends=True) does", () => {
    // `'a\r\nb\rc\x0bd\x0ce\x1cf\x1dg\x1eh\x85i\u2028j\u2029k\nl'.splitlines(True)` in Python 3.
    const text = "a\r\nb\rc\u000bd\u000ce\u001cf\u001dg\u001eh\u0085i\u2028j\u2029k\nl";
    expect(splitLines(text)).toEqual([
      "a\r\n",
      "b\r",
      "c\u000b",
      "d\u000c",
      "e\u001c",
      "f\u001d",
      "g\u001e",
      "h\u0085",
      "i\u2028",
      "j\u2029",
      "k\n",
      "l",
    ]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("x\n")).toEqual(["x\n"]);
    expect(splitLines("\n\n")).toEqual(["\n", "\n"]);
  });
});

describe("notebook round trip", () => {
  it("re-saves an unmodified Jupyter-written notebook byte for byte", () => {
    const text = fixture("jupyter-written.ipynb");
    expect(serializeNotebook(parseNotebook(text))).toBe(text);
  });

  it("re-saves an nbformat 4.4 notebook without giving it ids", () => {
    const text = fixture("nbformat-4.4.ipynb");
    const doc = parseNotebook(text);
    expect(hasCellIds(doc)).toBe(false);
    expect(serializeNotebook(doc)).toBe(text);
    const added = insertCell(doc, 2, newCell(doc, "code", "x = 1"));
    const saved = serializeNotebook(added);
    expect(saved).not.toContain('"id"');
    expect(parseNotebook(saved).cells).toHaveLength(3);
  });

  it("gives new cells an id in a 4.5 notebook, and keeps every existing one", () => {
    const doc = parseNotebook(fixture("jupyter-written.ipynb"));
    expect(hasCellIds(doc)).toBe(true);
    expect(doc.cells.map((cell) => cell.key)).toEqual(["a1b2c3d4", "e5f6a7b8", "c9d0e1f2", "f3a4b5c6", "0badf00d", "raw-cell_1"]);
    const cell = newCell(doc, "markdown", "nota");
    expect(cell.json.id).toMatch(/^[0-9a-f]{8}$/);
    expect(cell.key).toBe(cell.json.id);
  });

  it("changes only the edited cell's lines", () => {
    const text = fixture("jupyter-written.ipynb");
    const doc = parseNotebook(text);
    const saved = serializeNotebook(setSource(doc, "f3a4b5c6", "1/1\nprint('ok')"));
    const before = text.split("\n");
    const after = saved.split("\n");
    const changed = after.filter((line, i) => line !== before[i]);
    // `"1/0"` became two lines: the difference is that cell's source and nothing else.
    expect(after.length).toBe(before.length + 1);
    expect(changed[0]).toBe('    "1/1\\n",');
    expect(saved).toContain('    "1/1\\n",\n    "print(\'ok\')"\n   ]');
    // Everything before the cell is untouched.
    const at = before.findIndex((line) => line === '    "1/0"');
    expect(after.slice(0, at)).toEqual(before.slice(0, at));
  });

  it("keeps unknown metadata, fields and numbers exactly", () => {
    const doc = parseNotebook(fixture("jupyter-written.ipynb"));
    const saved = serializeNotebook(setSource(doc, "0badf00d", "y = 2"));
    expect(saved).toContain('"_x": 3.0');
    expect(saved).toContain("1e-07");
    expect(saved).toContain("1e+20");
    expect(saved).toContain('"w": 1.0');
    expect(saved).toContain('"toc": {\n   "number_sections": true\n  }');

    const custom = JSON.stringify({
      cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [], x_tool: { keep: true } }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 4,
      x_top: [1, 2],
    });
    const round = serializeNotebook(parseNotebook(custom));
    expect(round).toContain('"x_tool": {\n    "keep": true\n   }');
    expect(round).toContain('"x_top": [\n  1,\n  2\n ]');
  });

  it("reads outputs of every kind", () => {
    const doc = parseNotebook(fixture("jupyter-written.ipynb"));
    const types = doc.cells.flatMap((cell) => cellOutputs(cell).map((output) => output.output_type));
    expect(types).toEqual([
      "stream",
      "stream",
      "execute_result",
      "display_data",
      "display_data",
      "display_data",
      "display_data",
      "display_data",
      "error",
    ]);
    const mimes = cellOutputs(doc.cells[2]).flatMap((output) => Object.keys(output.data as object));
    expect(mimes).toEqual(
      expect.arrayContaining(["image/png", "image/svg+xml", "application/json", "text/latex", "text/markdown", "application/vnd.jupyter.widget-view+json"]),
    );
    expect(cellSource(doc.cells[0])).toContain("Análisis de ventas 😀");
  });

  it("writes an edited empty cell the way Jupyter does", () => {
    const doc = parseNotebook(fixture("jupyter-written.ipynb"));
    const saved = serializeNotebook(setSource(setSource(doc, "0badf00d", "x"), "0badf00d", ""));
    expect(saved).toBe(fixture("jupyter-written.ipynb"));
  });

  it("keeps the line endings a Windows Jupyter wrote", () => {
    const text = fixture("jupyter-written.ipynb").replace(/\n/g, "\r\n");
    const doc = parseNotebook(text);
    expect(serializeNotebook(doc)).toBe(text);
    const edited = serializeNotebook(setSource(doc, "0badf00d", "z = 3"));
    // `"source": []` became a three-line list: two lines more, every one of them CRLF.
    expect(edited.split("\r\n").length).toBe(text.split("\r\n").length + 2);
    expect(edited.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("keeps a document's own indentation", () => {
    const text = '{\n  "cells": [],\n  "metadata": {},\n  "nbformat": 4,\n  "nbformat_minor": 5\n}\n';
    expect(serializeNotebook(parseNotebook(text))).toBe(text);
  });

  it("opens an empty file as an empty notebook, and writes what Python would", () => {
    const doc = parseNotebook("");
    expect(doc.cells).toHaveLength(0);
    expect(serializeNotebook(doc)).toBe(serializeNotebook(emptyNotebook()));
    // `json.dumps({...}, indent=1, sort_keys=True)` + newline.
    expect(serializeNotebook(doc)).toBe('{\n "cells": [],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n');
  });

  it("refuses what is not an nbformat 4 notebook", () => {
    expect(() => parseNotebook("[1, 2]")).toThrow(NotebookFormatError);
    expect(() => parseNotebook('{"nbformat": 3, "worksheets": []}')).toThrow(/nbformat 3/);
    expect(() => parseNotebook('{"nbformat": 4}')).toThrow(/cells/);
    expect(() => parseNotebook('{"nbformat": 4, "cells": [{"source": "x"}]}')).toThrow(/celda 1/);
    expect(() => parseNotebook("{broken")).toThrow(NotebookFormatError);
  });

  it("keeps cell keys across a re-read when the cells have no ids", () => {
    const text = fixture("nbformat-4.4.ipynb");
    const first = parseNotebook(text);
    const edited = serializeNotebook(setSource(first, first.cells[1].key, "print('adiós')"));
    const second = parseNotebook(edited, first);
    expect(second.cells.map((cell) => cell.key)).toEqual(first.cells.map((cell) => cell.key));
    // A cell moved elsewhere is still found by its text.
    const moved = serializeNotebook(moveCell(first, first.cells[1].key, -1));
    const third = parseNotebook(moved, first);
    expect(third.cells.map((cell) => cell.key)).toEqual([first.cells[1].key, first.cells[0].key]);
  });

  it("reads the notebook's language and kernelspec", () => {
    const doc = parseNotebook(fixture("nbformat-4.4.ipynb"));
    expect(notebookLanguage(doc)).toBe("r");
    expect(notebookKernelspec(doc)).toEqual({ name: "ir", displayName: "R", language: "R" });
    expect(notebookLanguage(emptyNotebook())).toBe("python");
  });
});

describe("cell edits", () => {
  const doc = parseNotebook(fixture("jupyter-written.ipynb"));

  it("moves, deletes and inserts without touching the other cells", () => {
    const moved = moveCell(doc, "e5f6a7b8", 1);
    expect(moved.cells.map((cell) => cell.key).slice(0, 3)).toEqual(["a1b2c3d4", "c9d0e1f2", "e5f6a7b8"]);
    expect(moveCell(doc, "a1b2c3d4", -1)).toBe(doc);
    const deleted = deleteCell(doc, "f3a4b5c6");
    expect(deleted.cells).toHaveLength(doc.cells.length - 1);
    expect(deleted.cells[0]).toBe(doc.cells[0]);
  });

  it("drops outputs when a code cell becomes Markdown, and attachments the other way", () => {
    const markdown = changeCellType(doc, "e5f6a7b8", "markdown");
    const cell = markdown.cells.find((c) => c.key === "e5f6a7b8")!;
    expect(cell.json.outputs).toBeUndefined();
    expect(cell.json.execution_count).toBeUndefined();
    expect(cell.json.metadata).toEqual(doc.cells[1].json.metadata);
    const code = changeCellType(doc, "a1b2c3d4", "code");
    const converted = code.cells[0].json;
    expect(converted.attachments).toBeUndefined();
    expect(converted.outputs).toEqual([]);
    expect(converted.execution_count).toBeNull();
    expect(converted.id).toBe("a1b2c3d4");
  });

  it("clears every output", () => {
    const cleared = clearAllOutputs(doc);
    expect(cleared.cells.every((cell) => cellOutputs(cell).length === 0)).toBe(true);
    expect(cleared.cells.filter((c) => c.json.cell_type === "code").every((c) => c.json.execution_count === null)).toBe(true);
    expect(clearAllOutputs(cleared)).toBe(cleared);
  });
});
