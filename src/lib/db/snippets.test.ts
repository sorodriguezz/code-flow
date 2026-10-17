import { describe, expect, it } from "vitest";
import { DEFAULT_SNIPPETS, escapeSnippetBody, parseSnippets, snippetsFor } from "./snippets";

describe("snippets", () => {
  it("drops malformed entries and keeps the rest", () => {
    const parsed = parseSnippets(
      JSON.stringify([
        { id: "a", prefix: " x ", body: "SELECT 1", language: "sql" },
        { id: "b", prefix: "", body: "nope" },
        { prefix: "c" },
        { id: "d", prefix: "d", body: "x", language: "cobol" },
      ]),
    );
    expect(parsed.map((s) => [s.prefix, s.language])).toEqual([
      ["x", "sql"],
      ["d", "any"],
    ]);
  });

  it("falls back to the defaults on garbage", () => {
    expect(parseSnippets("{")).toBe(DEFAULT_SNIPPETS);
  });

  it("offers a console only its own language and `any`", () => {
    const list = parseSnippets(
      JSON.stringify([
        { id: "a", prefix: "a", body: "1", language: "sql" },
        { id: "b", prefix: "b", body: "2", language: "javascript" },
        { id: "c", prefix: "c", body: "3", language: "any" },
      ]),
    );
    expect(snippetsFor(list, "sql").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("escapes a saved selection so `$` stays literal", () => {
    expect(escapeSnippetBody("SELECT '$1' }")).toBe("SELECT '\\$1' \\}");
  });
});
