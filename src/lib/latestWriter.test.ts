import { describe, expect, it } from "vitest";
import { createLatestWriter } from "./latestWriter";

describe("latest writer", () => {
  it("writes the first value at once and only the newest of what arrived meanwhile", async () => {
    const written: string[] = [];
    let release: (() => void) | null = null;
    const writer = createLatestWriter(async (v: string) => {
      written.push(v);
      if (v === "a") await new Promise<void>((r) => (release = r));
    });
    writer.push("a");
    writer.push("ab");
    writer.push("abc");
    expect(written).toEqual(["a"]);
    const done = writer.flush();
    release!();
    await done;
    expect(written).toEqual(["a", "abc"]);
  });

  it("flush waits for the last keystroke, even an empty one", async () => {
    const written: string[] = [];
    const writer = createLatestWriter(async (v: string) => {
      await Promise.resolve();
      written.push(v);
    });
    writer.push("hola");
    writer.push("");
    await writer.flush();
    expect(written[written.length - 1]).toBe("");
  });

  it("keeps going after a failed write", async () => {
    const written: string[] = [];
    const writer = createLatestWriter(async (v: string) => {
      if (v === "bad") throw new Error("no");
      written.push(v);
    });
    writer.push("bad");
    await writer.flush();
    writer.push("good");
    await writer.flush();
    expect(written).toEqual(["good"]);
  });
});
