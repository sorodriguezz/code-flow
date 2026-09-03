import { describe, expect, it } from "vitest";
import { inlineSpans, pairHunkLines, worthHighlighting } from "./diffText";

/** Compact reading of a span list: the changed runs only. */
const changed = (spans: { text: string; changed: boolean }[]) =>
  spans.filter((s) => s.changed).map((s) => s.text);

describe("inlineSpans", () => {
  it("marks only the run that differs", () => {
    const { before, after } = inlineSpans("const timeout = 30;", "const timeout = 60;");
    expect(changed(before)).toEqual(["3"]);
    expect(changed(after)).toEqual(["6"]);
  });

  it("keeps a shared prefix and suffix out of the highlight", () => {
    const { before, after } = inlineSpans("foo(a, b)", "foo(a, c)");
    expect(before.map((s) => s.text).join("")).toBe("foo(a, b)");
    expect(after.map((s) => s.text).join("")).toBe("foo(a, c)");
    expect(changed(before)).toEqual(["b"]);
    expect(changed(after)).toEqual(["c"]);
  });

  it("handles a pure insertion at the end", () => {
    const { before, after } = inlineSpans("hello", "hello world");
    expect(changed(before)).toEqual([]);
    expect(changed(after)).toEqual([" world"]);
  });

  it("handles a pure insertion at the start", () => {
    const { after } = inlineSpans("world", "hello world");
    expect(changed(after)).toEqual(["hello "]);
  });

  it("never loses or duplicates characters", () => {
    const a = "the quick brown fox";
    const b = "the slow brown fox jumps";
    const { before, after } = inlineSpans(a, b);
    expect(before.map((s) => s.text).join("")).toBe(a);
    expect(after.map((s) => s.text).join("")).toBe(b);
  });

  it("returns one unchanged span for identical text", () => {
    const { before } = inlineSpans("same", "same");
    expect(changed(before)).toEqual([]);
  });
});

describe("worthHighlighting", () => {
  it("accepts a small edit inside a line", () => {
    expect(worthHighlighting("const timeout = 30;", "const timeout = 60;")).toBe(true);
  });

  it("refuses two lines that share almost nothing", () => {
    // Marking 95% of both as "changed" would be noise dressed as information.
    expect(worthHighlighting("import fs from 'fs';", "export default class Widget {}")).toBe(false);
  });

  it("refuses a blank side", () => {
    expect(worthHighlighting("", "something")).toBe(false);
    expect(worthHighlighting("   ", "something")).toBe(false);
  });
});

describe("pairHunkLines", () => {
  it("pairs a rewritten block line for line", () => {
    const pairs = pairHunkLines([" ", "-", "-", "+", "+", " "]);
    expect(pairs.get(1)).toBe(3);
    expect(pairs.get(2)).toBe(4);
    // And back the other way, so either side can look up its counterpart.
    expect(pairs.get(3)).toBe(1);
    expect(pairs.get(4)).toBe(2);
  });

  it("leaves the surplus unpaired when the counts differ", () => {
    const pairs = pairHunkLines(["-", "+", "+", "+"]);
    expect(pairs.get(0)).toBe(1);
    // Two genuinely new lines, not edits of anything.
    expect(pairs.has(2)).toBe(false);
    expect(pairs.has(3)).toBe(false);
  });

  it("pairs nothing in a pure addition", () => {
    expect(pairHunkLines([" ", "+", "+"]).size).toBe(0);
  });

  it("pairs nothing in a pure removal", () => {
    expect(pairHunkLines([" ", "-", "-"]).size).toBe(0);
  });

  it("handles several runs in one hunk", () => {
    const pairs = pairHunkLines(["-", "+", " ", " ", "-", "+"]);
    expect(pairs.get(0)).toBe(1);
    expect(pairs.get(4)).toBe(5);
  });
});
