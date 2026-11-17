import { describe, expect, it } from "vitest";
import { insideDestructuringPattern, suppressSnippetsAt } from "./snippetContext";

describe("insideDestructuringPattern", () => {
  it("is inside an open object or array pattern", () => {
    expect(insideDestructuringPattern("const { isRechazado, ")).toBe(true);
    expect(insideDestructuringPattern("const {")).toBe(true);
    expect(insideDestructuringPattern("let [first, ")).toBe(true);
    expect(insideDestructuringPattern("const {\n  a,\n  b,\n  ")).toBe(true);
    // A default value with its own brackets does not close the pattern.
    expect(insideDestructuringPattern("const { a = { x: 1 }, b = fn(), ")).toBe(true);
  });

  it("is outside once the pattern closed, and anywhere else", () => {
    expect(insideDestructuringPattern("const { a } = await this._alta.execute({ ")).toBe(false);
    expect(insideDestructuringPattern("const { a } = b;\n")).toBe(false);
    expect(insideDestructuringPattern("const x = ")).toBe(false);
    expect(insideDestructuringPattern("if (alta.isRechazado) {\n  ")).toBe(false);
    expect(insideDestructuringPattern("")).toBe(false);
  });
});

describe("suppressSnippetsAt", () => {
  const lines = ["async function f() {", "  const { isRechazado,  } = await g();", "}"];
  const at = (rows: string[]) => (n: number) => rows[n - 1] ?? "";

  it("suppresses at the caret inside the pattern, in TS/JS only", () => {
    const column = lines[1].indexOf(",  }") + 3;
    expect(suppressSnippetsAt("typescript", at(lines), 2, column)).toBe(true);
    expect(suppressSnippetsAt("javascript", at(lines), 2, column)).toBe(true);
    expect(suppressSnippetsAt("python", at(lines), 2, column)).toBe(false);
  });

  it("offers snippets at a statement", () => {
    expect(suppressSnippetsAt("typescript", at(lines), 3, 1)).toBe(false);
    expect(suppressSnippetsAt("typescript", at(["  "]), 1, 3)).toBe(false);
  });
});
