import { describe, expect, it } from "vitest";
import { Reassembler, docId, fileOf, fromBase64, open, seal, sealingKey, split, toBase64, topicOf, type LiveMessage } from "./wire";

describe("the channel's secrets", () => {
  it("derives a topic that says nothing and is stable", async () => {
    const topic = await topicOf("k1");
    expect(topic).toMatch(/^cf-collab-[0-9a-f]{40}$/);
    expect(await topicOf("k1")).toBe(topic);
    expect(await topicOf("k2")).not.toBe(topic);
  });

  it("opens what it sealed, and nothing sealed under another key", async () => {
    const message: LiveMessage = { k: "here", from: { id: "p1", nick: "Dev B" }, file: { repoKey: "github.com/a/b", path: "src/x.ts" } };
    const key = await sealingKey("k1");
    const sealed = await seal(key, message);
    expect(sealed).not.toContain("Dev B");
    expect(await open(key, sealed)).toEqual(message);
    expect(await open(await sealingKey("k2"), sealed)).toBeNull();
    expect(await open(key, "not base64 at all!")).toBeNull();
  });
});

describe("parts", () => {
  it("leaves a small message whole", () => {
    expect(split("abc", "id")).toEqual([{ c: "abc" }]);
  });

  it("puts a large one back together in any order, once", () => {
    const big = "x".repeat(25) + "y".repeat(25);
    const parts = split(big, "m1", 10);
    expect(parts).toHaveLength(5);
    const r = new Reassembler();
    const shuffled = [parts[3], parts[0], parts[4], parts[0], parts[1]];
    for (const p of shuffled) expect(r.push(p)).toBeNull();
    expect(r.push(parts[2])).toBe(big);
    expect(r.push(parts[2])).toBeNull();
  });

  it("drops parts of a message that never completes", () => {
    const r = new Reassembler(1000);
    const parts = split("abcdefghij", "m2", 5);
    expect(r.push(parts[0], 0)).toBeNull();
    expect(r.push(split("zz", "m3", 1)[0], 5000)).toBeNull();
    expect(r.push(parts[1], 5000)).toBeNull();
  });

  it("refuses absurd part counts", () => {
    expect(new Reassembler().push({ p: "x", i: 0, n: 1_000_000, c: "a" })).toBeNull();
  });
});

describe("ids and bytes", () => {
  it("round-trips a file id with any path", () => {
    const file = { repoKey: "github.com/org/repo", path: "src/a b/ñ.ts" };
    expect(fileOf(docId(file))).toEqual(file);
  });

  it("round-trips bytes through base64, large ones included", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
