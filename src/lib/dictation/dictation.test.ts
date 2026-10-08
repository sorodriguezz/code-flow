import { describe, expect, it } from "vitest";
import { spliceDictation } from "./insert";
import { downsample, pcmToBase64, toPcm16 } from "./recorder";

describe("spliceDictation", () => {
  it("joins words with one space on either side", () => {
    expect(spliceDictation("Revisa esto:", 12, 12, "hola")).toEqual({ value: "Revisa esto: hola", caret: 17 });
    expect(spliceDictation("antesdespués", 5, 5, "medio")).toEqual({ value: "antes medio después", caret: 11 });
  });

  it("adds nothing where there is already a space, or punctuation follows", () => {
    expect(spliceDictation("a ", 2, 2, "b")).toEqual({ value: "a b", caret: 3 });
    expect(spliceDictation("hola.", 4, 4, "mundo")).toEqual({ value: "hola mundo.", caret: 10 });
    expect(spliceDictation("", 0, 0, "solo")).toEqual({ value: "solo", caret: 4 });
  });

  it("replaces a selection", () => {
    expect(spliceDictation("uno dos tres", 4, 7, "DOS")).toEqual({ value: "uno DOS tres", caret: 7 });
  });
});

describe("recorder encoding", () => {
  it("averages each output sample's span when it downsamples", () => {
    const input = Float32Array.from([1, 1, 1, 0, 0, 0]);
    expect(Array.from(downsample(input, 48_000, 16_000))).toEqual([1, 0]);
    expect(downsample(input, 16_000, 16_000)).toBe(input);
  });

  it("clamps to 16-bit and writes little-endian base64", () => {
    const pcm = toPcm16(Float32Array.from([-2, -1, 0, 1, 2]));
    expect(Array.from(pcm)).toEqual([-32768, -32768, 0, 32767, 32767]);
    const bytes = Uint8Array.from(atob(pcmToBase64(Int16Array.from([1, -2]))), (c) => c.charCodeAt(0));
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0xfe, 0xff]);
  });
});
