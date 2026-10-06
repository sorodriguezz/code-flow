import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiffInfo } from "../types/domain";
import { bufferLineOf, changeBlocksOf, followHunk, inBufferLines } from "./diffBlocks";

/**
 * What lets the editor's change peek stay open across a stage or unstage: finding the hunk again on
 * the other side of the index, and placing a staged hunk on the buffer's lines when the file also has
 * unstaged changes that shift them.
 */

const ctx = (old: number, now: number, content: string): DiffLine => ({
  origin: " ",
  content,
  old_lineno: old,
  new_lineno: now,
});
const del = (old: number, content: string): DiffLine => ({ origin: "-", content, old_lineno: old, new_lineno: null });
const add = (now: number, content: string): DiffLine => ({ origin: "+", content, old_lineno: null, new_lineno: now });

const file = (...hunks: DiffLine[][]): FileDiffInfo => ({
  old_path: "src/app.ts",
  new_path: "src/app.ts",
  status: "modified",
  binary: false,
  hunks: hunks.map((lines) => ({ header: "@@", lines })),
});

describe("bufferLineOf: an index line, on the buffer's lines", () => {
  // Two lines inserted after index line 4.
  const inserted = file([ctx(2, 2, "b"), ctx(3, 3, "c"), ctx(4, 4, "d"), add(5, "x"), add(6, "y"), ctx(5, 7, "e"), ctx(6, 8, "f"), ctx(7, 9, "g")]);
  // Index line 5 deleted from the working tree.
  const deleted = file([ctx(2, 2, "b"), ctx(3, 3, "c"), ctx(4, 4, "d"), del(5, "e"), ctx(6, 5, "f"), ctx(7, 6, "g"), ctx(8, 7, "h")]);

  it("is the same line when there is no working change", () => {
    expect(bufferLineOf(undefined, 12)).toBe(12);
  });

  it("is untouched above the first working change", () => {
    expect(bufferLineOf(inserted, 1)).toBe(1);
    expect(bufferLineOf(inserted, 4)).toBe(4);
  });

  it("follows a shared line inside a working hunk", () => {
    expect(bufferLineOf(inserted, 5)).toBe(7);
  });

  it("is shifted by what each working hunk above it added or removed", () => {
    expect(bufferLineOf(inserted, 20)).toBe(22);
    expect(bufferLineOf(deleted, 20)).toBe(19);
  });

  it("answers a line the working tree deleted with the line that followed it", () => {
    expect(bufferLineOf(deleted, 5)).toBe(5);
  });
});

describe("inBufferLines", () => {
  it("re-anchors staged blocks below an unstaged insertion", () => {
    const working = file([ctx(2, 2, "b"), ctx(3, 3, "c"), ctx(4, 4, "d"), add(5, "x"), add(6, "y"), ctx(5, 7, "e"), ctx(6, 8, "f"), ctx(7, 9, "g")]);
    const staged = file([ctx(17, 17, "p"), del(18, "old"), add(18, "new"), ctx(19, 19, "q")]);
    const [block] = inBufferLines(changeBlocksOf(staged).blocks, working);
    expect([block.firstLine, block.lastLine]).toEqual([20, 20]);
  });

  it("hands the same array back when the working tree matches the index", () => {
    const blocks = changeBlocksOf(file([ctx(1, 1, "a"), add(2, "b")])).blocks;
    expect(inBufferLines(blocks, undefined)).toBe(blocks);
  });
});

describe("followHunk: the same change, on the other side of the index", () => {
  // The unstaged hunk the peek was showing: `return a;` became `return b;` at buffer line 11.
  const acted = changeBlocksOf(
    file([ctx(8, 8, "x"), ctx(9, 9, "y"), ctx(10, 10, "z"), del(11, "  return a;"), add(11, "  return b;"), ctx(12, 12, "}")]),
  ).blocks[0];

  it("finds it among the staged hunks, whatever their context and base", () => {
    const staged = changeBlocksOf(
      file(
        [ctx(1, 1, "import"), add(2, "import more;"), ctx(2, 3, "")],
        // HEAD numbers it differently, and its context is HEAD's.
        [ctx(9, 10, "y"), ctx(10, 11, "z"), del(11, "  return a;"), add(12, "  return b;"), ctx(12, 13, "}")],
      ),
    ).blocks;
    expect(followHunk(staged, acted)).toBe(1);
  });

  it("finds it merged into a hunk that was already staged beside it", () => {
    const staged = changeBlocksOf(
      file([ctx(7, 7, "w"), del(8, "x"), add(8, "X"), ctx(9, 9, "y"), ctx(10, 10, "z"), del(11, "  return a;"), add(11, "  return b;"), ctx(12, 12, "}")]),
    ).blocks;
    expect(followHunk(staged, acted)).toBe(0);
  });

  it("picks the nearest when the same edit was made twice", () => {
    const twice = changeBlocksOf(
      file(
        [ctx(2, 2, "q"), del(3, "  return a;"), add(3, "  return b;"), ctx(4, 4, "}")],
        [ctx(10, 10, "z"), del(11, "  return a;"), add(11, "  return b;"), ctx(12, 12, "}")],
      ),
    ).blocks;
    expect(followHunk(twice, acted)).toBe(1);
  });

  it("is -1 when the change is on neither side any more", () => {
    const other = changeBlocksOf(file([ctx(1, 1, "a"), add(2, "unrelated")])).blocks;
    expect(followHunk(other, acted)).toBe(-1);
    expect(followHunk([], acted)).toBe(-1);
  });
});
