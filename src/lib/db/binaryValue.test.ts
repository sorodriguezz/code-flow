import { describe, expect, it } from "vitest";
import { decodeBinary, extensionFor, hexDump, imageType, toBase64 } from "./binaryValue";

describe("binaryValue", () => {
  it("reads each engine's spelling of bytes", () => {
    expect(Array.from(decodeBinary("\\x89504e47")!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Array.from(decodeBinary("0xFFD8FF")!)).toEqual([0xff, 0xd8, 0xff]);
    expect(Array.from(decodeBinary("X'4142'")!)).toEqual([0x41, 0x42]);
  });

  it("is not fooled by text", () => {
    expect(decodeBinary("0x123")).toBeNull();
    expect(decodeBinary("hello")).toBeNull();
    expect(decodeBinary("0xZZ")).toBeNull();
  });

  it("knows images and a few files by their first bytes", () => {
    expect(imageType(decodeBinary("\\x89504e470d0a1a0a")!)).toBe("image/png");
    expect(extensionFor(decodeBinary("0xFFD8FFE0")!)).toBe("jpg");
    expect(extensionFor(decodeBinary("0x25504446")!)).toBe("pdf");
    expect(extensionFor(decodeBinary("0x00")!)).toBe("bin");
  });

  it("dumps sixteen bytes a line with their text", () => {
    expect(hexDump(new TextEncoder().encode("AB\n"))).toBe("00000000  41 42 0a" + " ".repeat(39) + "  AB.");
  });

  it("encodes Base64", () => {
    expect(toBase64(new TextEncoder().encode("hi"))).toBe("aGk=");
  });
});
