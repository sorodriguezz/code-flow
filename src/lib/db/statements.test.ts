import { describe, expect, it } from "vitest";
import { firstStatement, splitStatements } from "./statements";

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
