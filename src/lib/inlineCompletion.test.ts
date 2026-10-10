import { describe, expect, it } from "vitest";
import { completionShape } from "./inlineCompletion";

/** `|` marks the caret; it is removed before the lines are handed over. */
function shapeOf(source: string, tabSize = 2) {
  const lines = source.split("\n");
  const lineIndex = lines.findIndex((line) => line.includes("|"));
  const column = lines[lineIndex].indexOf("|") + 1;
  lines[lineIndex] = lines[lineIndex].replace("|", "");
  const position = { lineNumber: lineIndex + 1, column };
  return completionShape((n) => lines[n - 1], lines.length, position, tabSize);
}

describe("completionShape", () => {
  it("asks for a block on the empty line Enter leaves under an opener", () => {
    expect(shapeOf("function f() {\n  |\n}")).toEqual({ multiline: true, indent: 2 });
  });

  it("asks for one line when the block already has a body", () => {
    expect(shapeOf("function f() {\n  |\n  return 1;\n}")).toEqual({ multiline: false, indent: 0 });
  });

  it("asks for one line at the end of a finished statement", () => {
    expect(shapeOf("function f() {\n  let total = 0;|\n}").multiline).toBe(false);
  });

  it("asks for one line under a line that opens nothing", () => {
    expect(shapeOf("const items = [\n  a,\n  |\n];").multiline).toBe(false);
  });

  it("asks for one line on an unindented blank line", () => {
    expect(shapeOf("const a = 1;\n|\nconst b = 2;").multiline).toBe(false);
  });

  it("reads Python's colon and treats the end of the file as the block's end", () => {
    expect(shapeOf("def total(items):\n    |", 4)).toEqual({ multiline: true, indent: 4 });
  });

  it("compares widths with tabs expanded but reports the indent in characters", () => {
    expect(shapeOf("\tif (a) {\n\t\t|\n\t}", 4)).toEqual({ multiline: true, indent: 2 });
  });

  it("looks past a blank line for the opener", () => {
    expect(shapeOf("if (a) {\n\n  |\n}").multiline).toBe(true);
  });

  it("never asks for a block on a line that has text after the caret", () => {
    expect(shapeOf("function f() {\n  |}\n}").multiline).toBe(false);
  });
});
