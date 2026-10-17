import { describe, expect, it } from "vitest";
import { hexDump } from "./hexDump";

describe("hexDump", () => {
  it("lays out offset, byte pairs and printable text", () => {
    const bytes = [...new TextEncoder().encode("Hello, hex view!"), 0, 255];
    const [first, second] = hexDump(bytes, 0x20).split("\n");
    expect(first).toBe("00000020  4865 6c6c 6f2c 2068  6578 2076 6965 7721  Hello, hex view!");
    expect(second.startsWith("00000030  00ff")).toBe(true);
    expect(second.endsWith(" ..")).toBe(true);
  });
});
