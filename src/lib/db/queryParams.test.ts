import { describe, expect, it } from "vitest";
import { fillParams, findParams, literalFor } from "./queryParams";

describe("findParams", () => {
  it("finds the three spellings, once each, in order", () => {
    expect(findParams("SELECT * FROM t WHERE a = :id AND b = ${name} AND c = ? AND d = :id", "sql")).toEqual([
      { key: "id", token: ":id" },
      { key: "name", token: "${name}" },
      { key: "?1", token: "?" },
    ]);
  });

  it("ignores casts, assignments, literals, comments and JSON operators", () => {
    expect(findParams("SELECT a::text, '10:30', b ?| array['x'] -- :nope ?\nFROM t", "sql")).toEqual([]);
    expect(findParams("BEGIN x := 1; END;", "sql")).toEqual([]);
  });

  it("does not treat `?` as positional outside SQL", () => {
    expect(findParams("db.t.find({ a: ? })", "javascript")).toEqual([]);
    expect(findParams("GET :key", "redis")).toEqual([]);
  });
});

describe("fillParams", () => {
  it("writes values in as literals", () => {
    const sql = "SELECT * FROM t WHERE a = :id AND b = :name AND c IN (:list) AND d = ?";
    expect(
      fillParams(
        sql,
        {
          id: { value: "42", raw: false },
          name: { value: "O'Hara", raw: false },
          list: { value: "1, 2", raw: true },
          "?1": { value: "null", raw: false },
        },
        "sql",
      ),
    ).toBe("SELECT * FROM t WHERE a = 42 AND b = 'O''Hara' AND c IN (1, 2) AND d = NULL");
  });

  it("quotes as JSON in a Mongo buffer", () => {
    expect(literalFor({ value: 'a"b', raw: false }, "javascript")).toBe('"a\\"b"');
  });
});
