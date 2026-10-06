import { describe, expect, it } from "vitest";
import { smallestChange } from "./smallestChange";

const apply = (before: string, change: ReturnType<typeof smallestChange>) =>
  before.slice(0, change.start) + change.text + before.slice(change.end);

describe("smallestChange", () => {
  it("replaces only what differs", () => {
    const before = "Table a {\n  id int\n}\n// codeflow:layout {\"a\":[1,2]}\n";
    const after = "Table a {\n  id int\n}\n// codeflow:layout {\"a\":[10,20]}\n";
    const change = smallestChange(before, after);
    expect(change.start).toBeGreaterThan(before.indexOf("codeflow"));
    expect(apply(before, change)).toBe(after);
  });

  it("handles insertions, deletions, identity and emptiness", () => {
    for (const [before, after] of [
      ["abc", "abXc"],
      ["abXc", "abc"],
      ["same", "same"],
      ["", "new"],
      ["old", ""],
      ["aaa", "aaaa"],
    ]) {
      expect(apply(before, smallestChange(before, after))).toBe(after);
    }
    expect(smallestChange("same", "same")).toEqual({ start: 4, end: 4, text: "" });
  });

  it("does not cut an emoji in half", () => {
    const before = "x 😀 y";
    const after = "x 😃 y";
    const change = smallestChange(before, after);
    expect(apply(before, change)).toBe(after);
    expect(/[\uDC00-\uDFFF]/.test(change.text[0] ?? "")).toBe(false);
  });
});
