import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiffInfo } from "../types/domain";
import {
  changedLines,
  hunkAnchors,
  hunkLineIds,
  lineId,
  pruneSelection,
  rangeIds,
  selectionCounts,
  selectionPayload,
} from "./lineSelection";

const ctx = (n: number, text: string): DiffLine => ({ origin: " ", content: text, old_lineno: n, new_lineno: n });
const add = (n: number, text: string): DiffLine => ({ origin: "+", content: text, old_lineno: null, new_lineno: n });
const del = (n: number, text: string): DiffLine => ({ origin: "-", content: text, old_lineno: n, new_lineno: null });

/** A file drawn at full context: one hunk, two separate edits. */
const FULL: FileDiffInfo = {
  old_path: "a.txt",
  new_path: "a.txt",
  status: "modified",
  binary: false,
  hunks: [
    {
      header: "@@ -1,6 +1,7 @@",
      lines: [ctx(1, "one"), del(2, "two"), add(2, "TWO"), add(3, "extra"), ctx(3, "three"), ctx(4, "four"), del(5, "five"), ctx(6, "six")],
    },
  ],
};

/** The same change at three lines of context, the way the store holds it. */
const NARROW: FileDiffInfo = {
  ...FULL,
  hunks: [
    { header: "@@ -1,6 +1,6 @@", lines: [ctx(1, "one"), del(2, "two"), add(2, "TWO"), add(3, "extra"), ctx(3, "three"), ctx(4, "four"), del(5, "five"), ctx(6, "six")] },
  ],
};

describe("line identity", () => {
  it("names changed rows by sign, number and text, and context rows not at all", () => {
    expect(lineId(add(3, "extra"))).toBe("+:3:extra");
    expect(lineId(del(2, "two"))).toBe("-:2:two");
    expect(lineId(ctx(1, "one"))).toBeNull();
    const ids = changedLines(FULL).map(lineId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ranges", () => {
  it("covers every changed row between two ends, in either direction", () => {
    expect(rangeIds(FULL, "-:2:two", "+:3:extra")).toEqual(["-:2:two", "+:2:TWO", "+:3:extra"]);
    expect(rangeIds(FULL, "-:5:five", "+:2:TWO")).toEqual(["+:2:TWO", "+:3:extra", "-:5:five"]);
  });

  it("falls back to the end that still exists", () => {
    expect(rangeIds(FULL, "+:9:gone", "-:5:five")).toEqual(["-:5:five"]);
    expect(rangeIds(FULL, "-:5:five", "+:9:gone")).toEqual(["-:5:five"]);
    expect(rangeIds(FULL, "+:9:gone", "+:8:gone")).toEqual([]);
  });
});

describe("selection", () => {
  it("drops rows the refreshed diff no longer has — including a row whose text changed", () => {
    const edited: FileDiffInfo = {
      ...FULL,
      hunks: [{ ...FULL.hunks[0], lines: FULL.hunks[0].lines.map((l) => (l.content === "extra" ? { ...l, content: "EXTRA" } : l)) }],
    };
    const kept = pruneSelection(edited, new Set(["+:3:extra", "-:5:five"]));
    expect([...kept]).toEqual(["-:5:five"]);
    expect(pruneSelection(null, new Set(["-:5:five"])).size).toBe(0);
  });

  it("sends the selected rows verbatim, in drawing order, and counts them", () => {
    const selected = new Set(["-:5:five", "+:2:TWO"]);
    const payload = selectionPayload(FULL, "a.txt", selected);
    expect(payload.file_path).toBe("a.txt");
    expect(payload.lines).toEqual([add(2, "TWO"), del(5, "five")]);
    expect(selectionCounts(FULL, selected)).toEqual({ added: 1, removed: 1 });
  });
});

describe("hunk anchors", () => {
  it("places each narrow hunk at the full-view row identical to its first line", () => {
    expect([...hunkAnchors(FULL, NARROW)]).toEqual([["0:0", 0]]);
    expect(hunkLineIds(NARROW.hunks[0])).toEqual(["-:2:two", "+:2:TWO", "+:3:extra", "-:5:five"]);
  });

  it("leaves out a hunk whose first row is not in the full view", () => {
    const stale: FileDiffInfo = { ...NARROW, hunks: [{ header: "@@ -40,1 +40,1 @@", lines: [ctx(40, "elsewhere")] }] };
    expect(hunkAnchors(FULL, stale).size).toBe(0);
    expect(hunkAnchors(FULL, undefined).size).toBe(0);
  });
});
