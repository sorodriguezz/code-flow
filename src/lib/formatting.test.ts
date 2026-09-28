import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { eolOf, lineEdits, prettierCanFormat } from "./formatting";
import { applyTextEdits } from "./workspaceEdit";

describe("which files Prettier is asked about", () => {
  it("covers the languages it formats, by extension, whatever the case", () => {
    for (const path of ["src/a.ts", "App.TSX", "x.mjs", "package.json", "a.scss", "README.md", "ci.yml", "App.vue"]) {
      expect(prettierCanFormat(path), path).toBe(true);
    }
  });

  it("never spawns it for a file it has nothing to say about — or a notebook", () => {
    for (const path of ["src/main.rs", "Makefile", "a.py", ".prettierrc", "analysis.ipynb", "Cargo.toml"]) {
      expect(prettierCanFormat(path), path).toBe(false);
    }
  });
});

describe("a formatter's answer as line edits", () => {
  const roundTrip = (before: string, after: string) =>
    applyTextEdits(before, lineEdits(before, after, eolOf(before)));

  it("reproduces the answer, for changes at the start, the middle and the end", () => {
    const cases: [string, string][] = [
      ["const a=1\nconst b=2\n", "const a = 1;\nconst b = 2;\n"],
      ["a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n"],
      ["a\nb\nc", "a\nc"],
      ["a\nb\nc\n", "a\nb\nc\nd\n"],
      ["a\nb", "a\nb\n"],
      ["a\nb\n", "a\nb"],
      ["x\n", "header\nx\n"],
      ["", "fresh\n"],
      ["only\n", ""],
      ["a\n\n\n\nb\n", "a\n\nb\n"],
    ];
    for (const [before, after] of cases) expect(roundTrip(before, after), JSON.stringify(before)).toBe(after);
  });

  it("leaves unchanged lines alone, so a caret on one keeps its place", () => {
    const edits = lineEdits("keep\nfix  me\nkeep too\n", "keep\nfix me\nkeep too\n", "\n");
    expect(edits).toEqual([
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: "fix me\n" },
    ]);
  });

  it("writes the file's own line ending, and makes no edits for a difference in endings alone", () => {
    const before = "a\r\nb  \r\nc\r\n";
    expect(roundTrip(before, "a\nb\nc\n")).toBe("a\r\nb\r\nc\r\n");
    expect(lineEdits("a\r\nb\r\n", "a\nb\n", "\r\n")).toEqual([]);
  });

  it("reads the ending a text mostly uses", () => {
    expect(eolOf("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(eolOf("a\nb\r\nc\n")).toBe("\n");
    expect(eolOf("single line")).toBe("\n");
  });
});
