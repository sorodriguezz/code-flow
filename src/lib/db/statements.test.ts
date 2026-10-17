import { describe, expect, it } from "vitest";
import { firstStatement, splitStatements, statementAt, statementRanges } from "./statements";

describe("splitStatements", () => {
  it("splits SQL on semicolons outside literals, comments and dollar bodies", () => {
    expect(splitStatements("SELECT ';'; -- a; b\nSELECT 2;", "sql")).toEqual(["SELECT ';'", "-- a; b\nSELECT 2"]);
    expect(splitStatements("CREATE FUNCTION f() AS $$ a; b $$; SELECT 1", "sql")).toHaveLength(2);
  });

  it("drops what masks down to nothing — a comment on its own is not a statement", () => {
    expect(splitStatements("-- TODO\n\n;;", "sql")).toEqual([]);
  });

  it("splits a Mongo buffer on blank lines as well as semicolons", () => {
    expect(splitStatements("db.a.find({})\n\ndb.b.find({}); db.c.find({})", "javascript")).toEqual([
      "db.a.find({})",
      "db.b.find({})",
      "db.c.find({})",
    ]);
  });

  it("reads Redis one command per line, where `;` is a legal byte", () => {
    expect(splitStatements("SET a \"x;y\"\n# note\nGET a\n", "redis")).toEqual(['SET a "x;y"', "GET a"]);
  });
});

describe("firstStatement", () => {
  it("is the statement below a leading comment, and null for a console of comments", () => {
    expect(firstStatement("-- fix later\nSELECT 1; SELECT 2", "sql")).toBe("-- fix later\nSELECT 1");
    expect(firstStatement("/* nothing */", "sql")).toBeNull();
  });
});

describe("statementAt", () => {
  const text = "SELECT 1;\n\nSELECT 2;\nSELECT 3";
  it("is the statement the caret is inside, or just after the `;` of", () => {
    expect(statementAt(text, text.indexOf("2"), "sql")?.text).toBe("SELECT 2");
    expect(statementAt(text, text.indexOf("2;") + 2, "sql")?.text).toBe("SELECT 2");
    expect(statementAt(text, text.length, "sql")?.text).toBe("SELECT 3");
  });

  it("prefers the statement just above a blank line over the next one", () => {
    expect(statementAt(text, text.indexOf("\n\n") + 1, "sql")?.text).toBe("SELECT 1");
  });

  it("keeps offsets into the original text", () => {
    const range = statementRanges("  -- c\n  SELECT 'a;b' ;  SELECT 2", "sql");
    expect(range.map((r) => r.text)).toEqual(["-- c\n  SELECT 'a;b'", "SELECT 2"]);
    expect("  -- c\n  SELECT 'a;b' ;  SELECT 2".slice(range[1].start, range[1].end)).toBe("SELECT 2");
  });

  it("is null for an empty buffer", () => {
    expect(statementAt("  ", 1, "sql")).toBeNull();
  });
});
