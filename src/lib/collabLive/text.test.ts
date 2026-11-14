import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyEdits, deltaToEdits, minimalEdit, seedClientId } from "./text";

describe("minimalEdit", () => {
  it("is null for equal texts", () => {
    expect(minimalEdit("abc", "abc")).toBeNull();
  });

  it("finds the one region that changed", () => {
    expect(minimalEdit("const a = 1;\nconst b = 2;\n", "const a = 1;\nconst b = 3;\n")).toEqual({ index: 23, remove: 1, insert: "3" });
    expect(minimalEdit("hello world", "hello brave world")).toEqual({ index: 6, remove: 0, insert: "brave " });
    expect(minimalEdit("abc", "")).toEqual({ index: 0, remove: 3, insert: "" });
  });

  it("never splits a surrogate pair", () => {
    const edit = minimalEdit("a😀b", "a😃b")!;
    expect(edit.index).toBe(1);
    expect(edit.remove).toBe(2);
    expect(edit.insert).toBe("😃");
  });

  it("always rebuilds the target", () => {
    const pairs = [
      ["", "x"],
      ["aaaa", "aa"],
      ["abcabc", "abc"],
      ["x\r\ny\r\n", "x\r\nz\r\ny\r\n"],
    ];
    for (const [before, after] of pairs) expect(applyEdits(before, [minimalEdit(before, after)!])).toBe(after);
  });
});

describe("deltaToEdits", () => {
  it("counts every edit in the old text", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "one two three");
    const before = text.toString();
    let edits: ReturnType<typeof deltaToEdits> = [];
    text.observe((event) => {
      edits = deltaToEdits(event.delta as never);
    });
    doc.transact(() => {
      text.delete(0, 3);
      text.insert(0, "ONE");
      text.insert(text.length, "!");
    });
    expect(applyEdits(before, edits)).toBe(text.toString());
    expect(edits[0]).toEqual({ index: 0, remove: 3, insert: "ONE" });
  });
});

describe("seedClientId", () => {
  it("is the same for the same text and in range", () => {
    expect(seedClientId("abc")).toBe(seedClientId("abc"));
    expect(seedClientId("abc")).not.toBe(seedClientId("abd"));
    for (const t of ["", "x", "a".repeat(10_000)]) {
      expect(seedClientId(t)).toBeGreaterThan(0);
      expect(seedClientId(t)).toBeLessThan(2 ** 31);
    }
  });

  it("makes two seeds of one text a single copy", () => {
    const seed = (text: string) => {
      const doc = new Y.Doc();
      doc.clientID = seedClientId(text);
      doc.getText("t").insert(0, text);
      return Y.encodeStateAsUpdate(doc);
    };
    const merged = new Y.Doc();
    Y.applyUpdate(merged, seed("fn main() {}\n"));
    Y.applyUpdate(merged, seed("fn main() {}\n"));
    expect(merged.getText("t").toString()).toBe("fn main() {}\n");
  });
});
