import { describe, expect, it } from "vitest";
import type { JsonObject } from "./json";
import { cellOutputs, executionCount, newCell, parseNotebook, type NotebookDoc } from "./nbformat";
import {
  appendStream,
  applyOutputMessage,
  chooseMime,
  clipLines,
  fixOverwrites,
  imageSrc,
  newOutputState,
  outputText,
} from "./outputs";

function notebook(): { doc: NotebookDoc; a: string; b: string } {
  let doc = parseNotebook('{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}');
  const a = newCell(doc, "code", "print(1)");
  doc = { ...doc, cells: [a] };
  const b = newCell(doc, "code", "print(2)");
  doc = { ...doc, cells: [a, b] };
  return { doc, a: a.key, b: b.key };
}

const outputsOf = (doc: NotebookDoc, key: string) => cellOutputs(doc.cells.find((c) => c.key === key)!);

describe("carriage returns and backspaces", () => {
  it("overwrites from the start of the line, as a terminal does", () => {
    expect(fixOverwrites("10%\r50%\r100%")).toBe("100%");
    expect(fixOverwrites("abcdef\rxy")).toBe("xycdef");
    expect(fixOverwrites("one\ntwo\rTWO\nthree")).toBe("one\nTWO\nthree");
  });

  it("reads \\r\\n as a line ending and keeps a trailing \\r for the next chunk", () => {
    expect(fixOverwrites("a\r\nb\r\n")).toBe("a\nb\n");
    expect(fixOverwrites("10%\r")).toBe("10%\r");
  });

  it("deletes the character before a backspace, never across a line", () => {
    expect(fixOverwrites("abc\b\bX")).toBe("aX");
    expect(fixOverwrites("a\n\bb")).toBe("a\n\bb");
  });
});

describe("streams", () => {
  it("merges consecutive chunks of the same stream and applies \\r across them", () => {
    let outputs: JsonObject[] = [];
    for (const chunk of ["loading 10%\r", "loading 50%\r", "loading 100%\n", "done\n"]) {
      outputs = appendStream(outputs, "stdout", chunk);
    }
    expect(outputs).toEqual([{ name: "stdout", output_type: "stream", text: "loading 100%\ndone\n" }]);
  });

  it("keeps stdout and stderr apart", () => {
    let outputs = appendStream([], "stdout", "a\n");
    outputs = appendStream(outputs, "stderr", "warn\n");
    outputs = appendStream(outputs, "stdout", "b\n");
    expect(outputs.map((o) => [o.name, o.text])).toEqual([
      ["stdout", "a\n"],
      ["stderr", "warn\n"],
      ["stdout", "b\n"],
    ]);
  });

  it("stays linear in the number of chunks", () => {
    let outputs: JsonObject[] = [];
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) outputs = appendStream(outputs, "stdout", `line ${i}\n`);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(String(outputs[0].text).split("\n")).toHaveLength(20_001);
  });
});

describe("kernel messages", () => {
  it("adds outputs to the cell that ran and sets its execution count", () => {
    const { doc, a } = notebook();
    const state = newOutputState();
    let next = applyOutputMessage(doc, a, "execute_input", { code: "print(1)", execution_count: 3 }, state);
    next = applyOutputMessage(next, a, "stream", { name: "stdout", text: "1\n" }, state);
    next = applyOutputMessage(
      next,
      a,
      "execute_result",
      { data: { "text/plain": "2" }, metadata: {}, execution_count: 3 },
      state,
    );
    next = applyOutputMessage(
      next,
      a,
      "error",
      { ename: "ValueError", evalue: "bad", traceback: ["\u001b[31mValueError\u001b[0m: bad"] },
      state,
    );
    expect(executionCount(next.cells[0])).toBe(3);
    expect(outputsOf(next, a)).toEqual([
      { name: "stdout", output_type: "stream", text: "1\n" },
      { data: { "text/plain": "2" }, execution_count: 3, metadata: {}, output_type: "execute_result" },
      { ename: "ValueError", evalue: "bad", output_type: "error", traceback: ["\u001b[31mValueError\u001b[0m: bad"] },
    ]);
    // Status and replies do not touch outputs.
    expect(applyOutputMessage(next, a, "status", { execution_state: "idle" }, state)).toBe(next);
  });

  it("never saves a display's transient id", () => {
    const { doc, a } = notebook();
    const next = applyOutputMessage(
      doc,
      a,
      "display_data",
      { data: { "text/plain": "x" }, metadata: {}, transient: { display_id: "d1" } },
      newOutputState(),
    );
    expect(outputsOf(next, a)[0]).toEqual({ data: { "text/plain": "x" }, metadata: {}, output_type: "display_data" });
  });

  it("clears at once, or on the next output when asked to wait", () => {
    const { doc, a } = notebook();
    const state = newOutputState();
    let next = applyOutputMessage(doc, a, "stream", { name: "stdout", text: "frame 1\n" }, state);
    next = applyOutputMessage(next, a, "clear_output", { wait: true }, state);
    expect(outputsOf(next, a)).toHaveLength(1);
    next = applyOutputMessage(next, a, "stream", { name: "stdout", text: "frame 2\n" }, state);
    expect(outputsOf(next, a)).toEqual([{ name: "stdout", output_type: "stream", text: "frame 2\n" }]);
    next = applyOutputMessage(next, a, "clear_output", { wait: false }, state);
    expect(outputsOf(next, a)).toEqual([]);
  });

  it("updates every output displayed under the same id, in any cell", () => {
    const { doc, a, b } = notebook();
    const state = newOutputState();
    const shown = { data: { "text/plain": "0%" }, metadata: {}, transient: { display_id: "progress" } };
    let next = applyOutputMessage(doc, a, "display_data", shown, state);
    next = applyOutputMessage(next, b, "display_data", shown, state);
    next = applyOutputMessage(next, b, "display_data", { data: { "text/plain": "other" }, metadata: {} }, state);
    next = applyOutputMessage(
      next,
      b,
      "update_display_data",
      { data: { "text/plain": "100%" }, metadata: { done: true }, transient: { display_id: "progress" } },
      state,
    );
    expect(outputsOf(next, a)[0].data).toEqual({ "text/plain": "100%" });
    expect(outputsOf(next, b).map((o) => (o.data as JsonObject)["text/plain"])).toEqual(["100%", "other"]);
    // And again: the replaced outputs are still the ones filed under that id.
    next = applyOutputMessage(
      next,
      a,
      "update_display_data",
      { data: { "text/plain": "again" }, metadata: {}, transient: { display_id: "progress" } },
      state,
    );
    expect(outputsOf(next, a)[0].data).toEqual({ "text/plain": "again" });
    // An update never adds an output of its own.
    expect(outputsOf(next, a)).toHaveLength(1);
  });
});

describe("choosing what to draw", () => {
  it("follows the MIME priority", () => {
    expect(chooseMime({ "text/plain": "x", "image/png": "…", "text/html": "<b>" }).mime).toBe("image/png");
    expect(chooseMime({ "text/plain": "x", "text/html": "<table>" }).mime).toBe("text/html");
    expect(chooseMime({ "text/plain": "x", "text/latex": "$x$" }).mime).toBe("text/latex");
    expect(chooseMime({ "text/plain": "x", "application/json": {} }).mime).toBe("application/json");
    expect(chooseMime({ "image/svg+xml": "<svg/>", "image/gif": "…" }).mime).toBe("image/gif");
    expect(chooseMime({ "application/pdf": "…" })).toEqual({ mime: null, needsJs: false, available: ["application/pdf"] });
  });

  it("says a widget needs JavaScript, and skips HTML that only works with it", () => {
    const widget = chooseMime({ "application/vnd.jupyter.widget-view+json": {}, "text/plain": "IntSlider(value=0)" });
    expect(widget).toEqual({
      mime: "text/plain",
      needsJs: true,
      available: ["application/vnd.jupyter.widget-view+json", "text/plain"],
    });
    const plotly = chooseMime({ "application/vnd.plotly.v1+json": {}, "text/html": "<script>…</script>" });
    expect(plotly.mime).toBeNull();
    expect(plotly.needsJs).toBe(true);
  });

  it("draws SVG as an image URL, never as markup", () => {
    const src = imageSrc("image/svg+xml", '<svg onload="alert(1)"/>');
    expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(src).not.toContain("<");
    expect(imageSrc("image/png", "iVBO\nRw0=\n")).toBe("data:image/png;base64,iVBORw0=");
  });

  it("reads outputs as text", () => {
    expect(outputText({ output_type: "stream", name: "stdout", text: ["a\n", "b"] })).toBe("a\nb");
    expect(outputText({ output_type: "display_data", data: { "image/png": "x" }, metadata: {} })).toBe("[image/png]");
    expect(outputText({ output_type: "error", ename: "E", evalue: "v", traceback: [] })).toBe("E: v");
  });

  it("clips a long text to its head and tail", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const clipped = clipLines(text)!;
    expect(clipped.head.split("\n")).toHaveLength(100);
    expect(clipped.tail.endsWith("line 999")).toBe(true);
    expect(clipped.hiddenLines).toBe(860);
    expect(clipLines("short\ntext")).toBeNull();
  });
});
