import { describe, expect, it } from "vitest";
import { blockAt, lineEnding, parseConflicts, resolveBlock, stepBlock } from "./conflictMarkers";

const MERGE_STYLE = [
  "top",
  "<<<<<<< HEAD",
  "ours line",
  "=======",
  "theirs line",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "=======",
  "only theirs",
  ">>>>>>> feature",
  "bottom",
  "",
].join("\n");

const DIFF3 = [
  "<<<<<<< ours",
  "ours line",
  "||||||| base",
  "shared",
  "=======",
  "theirs line",
  ">>>>>>> theirs",
  "",
].join("\n");

describe("parseConflicts", () => {
  it("reads git's default style", () => {
    const blocks = parseConflicts(MERGE_STYLE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      startLine: 1,
      endLine: 5,
      ours: ["ours line"],
      base: null,
      theirs: ["theirs line"],
      oursLabel: "HEAD",
      theirsLabel: "feature",
    });
    expect(blocks[1]).toMatchObject({ startLine: 7, endLine: 10, ours: [], theirs: ["only theirs"] });
  });

  it("reads the diff3 base section", () => {
    const [block] = parseConflicts(DIFF3);
    expect(block.base).toEqual(["shared"]);
    expect(block.ours).toEqual(["ours line"]);
    expect(block.theirs).toEqual(["theirs line"]);
  });

  it("leaves lookalikes outside a block alone", () => {
    const text = "Title\n=======\n\n<<<<<<<< eight is text\nnot a block\n>>>>>>> alone\n";
    expect(parseConflicts(text)).toEqual([]);
  });

  it("skips an incomplete block and still finds the next one", () => {
    const text = ["<<<<<<< HEAD", "dangling", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x"].join("\n");
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(2);
  });
});

describe("resolveBlock", () => {
  it("replaces one block and keeps everything else", () => {
    const blocks = parseConflicts(MERGE_STYLE);
    expect(resolveBlock(MERGE_STYLE, blocks[0], "theirs")).toBe(
      [
        "top",
        "theirs line",
        "middle",
        "<<<<<<< HEAD",
        "=======",
        "only theirs",
        ">>>>>>> feature",
        "bottom",
        "",
      ].join("\n"),
    );
  });

  it("offers both orders of both sides", () => {
    const [block] = parseConflicts(DIFF3);
    expect(resolveBlock(DIFF3, block, "both-ours-first")).toBe("ours line\ntheirs line\n");
    expect(resolveBlock(DIFF3, block, "both-theirs-first")).toBe("theirs line\nours line\n");
    expect(resolveBlock(DIFF3, block, "ours")).toBe("ours line\n");
  });

  it("keeps CRLF line endings and a missing final newline", () => {
    const text = "a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\nz";
    const [block] = parseConflicts(text);
    expect(block.ours).toEqual(["x"]);
    expect(resolveBlock(text, block, "ours")).toBe("a\r\nx\r\nz");
    expect(lineEnding(text)).toBe("\r\n");
  });

  it("an empty side removes the block's lines entirely", () => {
    const blocks = parseConflicts(MERGE_STYLE);
    const resolved = resolveBlock(MERGE_STYLE, blocks[1], "ours");
    expect(resolved).toBe(["top", "<<<<<<< HEAD", "ours line", "=======", "theirs line", ">>>>>>> feature", "middle", "bottom", ""].join("\n"));
    expect(parseConflicts(resolved)).toHaveLength(1);
  });
});

describe("navigation", () => {
  it("finds the block under a line and steps between blocks, wrapping", () => {
    const blocks = parseConflicts(MERGE_STYLE);
    expect(blockAt(blocks, 3)).toBe(0);
    expect(blockAt(blocks, 6)).toBe(-1);
    expect(stepBlock(blocks, 0, 1)).toBe(0);
    expect(stepBlock(blocks, 3, 1)).toBe(1);
    expect(stepBlock(blocks, 9, 1)).toBe(0);
    expect(stepBlock(blocks, 9, -1)).toBe(0);
    expect(stepBlock(blocks, 0, -1)).toBe(1);
    expect(stepBlock([], 0, 1)).toBe(-1);
  });
});
