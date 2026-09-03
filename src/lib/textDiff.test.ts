import { describe, expect, it } from "vitest";
import { collapseUnchanged, countChanges, diffLines } from "./textDiff";

describe("diffLines", () => {
  it("reports no changes for identical text", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    expect(lines.every((line) => line.kind === "same")).toBe(true);
    expect(countChanges(lines)).toEqual({ added: 0, removed: 0 });
  });

  it("keeps the surrounding lines when one changes in the middle", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "same:a",
      "removed:b",
      "added:B",
      "same:c",
    ]);
  });

  it("puts the removal before the addition, so a rewrite reads was/now", () => {
    const lines = diffLines("old", "new");
    expect(lines.map((l) => l.kind)).toEqual(["removed", "added"]);
  });

  it("treats trailing whitespace as a real difference", () => {
    // A prompt whose line gained two spaces *is* edited — the badge and the diff must agree.
    expect(countChanges(diffLines("a", "a  "))).toEqual({ added: 1, removed: 1 });
  });

  it("handles one side being empty", () => {
    expect(countChanges(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 1 });
    expect(countChanges(diffLines("a\nb", ""))).toEqual({ added: 1, removed: 2 });
  });

  it("falls back to a whole-text replacement past the LCS ceiling", () => {
    const long = Array.from({ length: 601 }, (_, i) => `line ${i}`).join("\n");
    const lines = diffLines(long, long);
    // Identical input, but too long to compare line by line: every line is reported as changed
    // rather than the function getting slow about it.
    expect(lines.some((line) => line.kind === "same")).toBe(false);
    expect(countChanges(lines)).toEqual({ added: 601, removed: 601 });
  });
});

describe("collapseUnchanged", () => {
  it("elides long runs of untouched lines into a single gap", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "e", "f", "g", "H"].join("\n");
    const collapsed = collapseUnchanged(diffLines(before, after), 1);
    // One gap marker, and only the change plus its one line of context survives.
    expect(collapsed.filter((line) => line === null)).toHaveLength(1);
    expect(collapsed.filter((line) => line !== null).map((line) => line!.text)).toEqual(["g", "h", "H"]);
  });

  it("leaves a short diff alone", () => {
    const collapsed = collapseUnchanged(diffLines("a\nb", "a\nB"), 2);
    expect(collapsed.includes(null)).toBe(false);
  });
});
