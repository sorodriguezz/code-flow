import { describe, expect, it } from "vitest";
import { folderName, parseTurnUsage, turnNotes, usageLine } from "./wsChatTurnNotes";

const t = ((key: string, params?: Record<string, string | number>) =>
  `${key}${params ? JSON.stringify(params) : ""}`) as never;

describe("usageLine", () => {
  it("is nothing when the engine reported nothing, and not zero", () => {
    expect(usageLine(null, t)).toBeNull();
    expect(usageLine(undefined, t)).toBeNull();
  });
  it("counts cached input, and prices only when reported", () => {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 500, cache_write_tokens: 500, cost_usd: null };
    expect(usageLine(usage, t)).toBe('pr.costTokens{"input":"2.0k","output":"200"}');
    expect(usageLine({ ...usage, cost_usd: 0.0123 }, t)).toContain("≈ $0.012");
  });
});

describe("turnNotes", () => {
  it("names unprotected folders by basename, once", () => {
    expect(folderName("/w/scratch/")).toBe("scratch");
    expect(folderName("C:\\w\\docs")).toBe("docs");
    const notes = turnNotes({ unprotectedDirs: ["/a/notes", "/b/notes", "/a/docs"] }, t);
    expect(notes.unprotected).toBe('assistant.wsChatUnprotected{"folders":"notes, docs"}');
    expect(turnNotes({}, t)).toEqual({ usage: null, unprotected: null });
  });
});

describe("parseTurnUsage", () => {
  const good = { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, cost_usd: null };
  it("reads a stored usage and ignores absent, bad or misshapen data", () => {
    expect(parseTurnUsage(JSON.stringify(good))).toEqual(good);
    for (const bad of [null, undefined, "", "{nope", "null", "[]", JSON.stringify({ input_tokens: 1 })]) {
      expect(parseTurnUsage(bad)).toBeUndefined();
    }
  });
});
