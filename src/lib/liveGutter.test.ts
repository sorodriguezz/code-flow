import { describe, expect, it } from "vitest";
import { liveGutterMarks } from "./liveGutter";

const lines = (...xs: string[]) => xs.join("\n");

describe("liveGutterMarks", () => {
  it("draws nothing for an unchanged buffer", () => {
    expect(liveGutterMarks("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("ignores line endings, so switching LF and CRLF marks nothing", () => {
    expect(liveGutterMarks("a\nb\nc\n", "a\r\nb\r\nc\r\n")).toEqual([]);
  });

  // The report: lines typed into a saved file, no mark until the file was saved.
  it("marks lines typed into the middle as added, in buffer line numbers", () => {
    const base = lines("one", "two", "three");
    const buffer = lines("one", "new a", "new b", "two", "three");
    expect(liveGutterMarks(base, buffer)).toEqual([{ kind: "added", start: 2, end: 3, blockIndex: -1 }]);
  });

  it("marks a rewritten line as modified", () => {
    expect(liveGutterMarks(lines("a", "b", "c"), lines("a", "B", "c"))).toEqual([
      { kind: "modified", start: 2, end: 2, blockIndex: -1 },
    ]);
  });

  it("anchors a deletion on the line that now follows it", () => {
    expect(liveGutterMarks(lines("a", "b", "c", "d"), lines("a", "d"))).toEqual([
      { kind: "deleted", start: 2, end: 2, blockIndex: -1 },
    ]);
  });

  it("anchors a deletion at the end one line past the last, for the decoration to clamp", () => {
    expect(liveGutterMarks(lines("a", "b", "c"), lines("a"))).toEqual([
      { kind: "deleted", start: 2, end: 2, blockIndex: -1 },
    ]);
  });

  it("keeps separate edits separate", () => {
    const base = lines("1", "2", "3", "4", "5", "6", "7");
    const buffer = lines("1", "x", "3", "4", "5", "6", "7", "8");
    expect(liveGutterMarks(base, buffer)).toEqual([
      { kind: "modified", start: 2, end: 2, blockIndex: -1 },
      { kind: "added", start: 8, end: 8, blockIndex: -1 },
    ]);
  });

  it("finds a one-line edit in a long file without effort", () => {
    const base = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const buffer = [...base];
    buffer[25_000] = "changed";
    const started = performance.now();
    expect(liveGutterMarks(base.join("\n"), buffer.join("\n"))).toEqual([
      { kind: "modified", start: 25_001, end: 25_001, blockIndex: -1 },
    ]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  /** Myers is minimal: the lines it marks as typed are exactly those an LCS says cannot be kept. */
  it("marks exactly as many new lines as a longest-common-subsequence leaves", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = () => ["a", "b", "c", "d"][Math.floor(random() * 4)];
    for (let round = 0; round < 300; round += 1) {
      // Round-tripped through text, as the buffer is: an empty file is one empty line, not none.
      const a = Array.from({ length: Math.floor(random() * 12) }, pick).join("\n").split("\n");
      const b = Array.from({ length: Math.floor(random() * 12) }, pick).join("\n").split("\n");
      const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
        }
      }
      const inserted = b.length - table[a.length][b.length];
      const marks = liveGutterMarks(a.join("\n"), b.join("\n")) ?? [];
      const marked = marks
        .filter((mark) => mark.kind !== "deleted")
        .reduce((sum, mark) => sum + mark.end - mark.start + 1, 0);
      expect(marked, `${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBe(inserted);
    }
  });
});
