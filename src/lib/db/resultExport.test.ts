import { describe, expect, it } from "vitest";
import { formatResult, toDelimited, toInsertStatements, toJson, toMarkdown } from "./resultExport";
import type { DbColumn, DbStatementResult } from "../../types/database";

const columns: DbColumn[] = [
  { name: "id", type_name: "int" },
  { name: "note", type_name: "text" },
];

describe("resultExport", () => {
  it("keeps NULL and the empty string apart in every format", () => {
    const rows = [["1", null], ["2", ""]];
    expect(toDelimited(columns, rows, ",")).toBe('id,note\n1,\n2,""');
    expect(JSON.parse(toJson(columns, rows))).toEqual([{ id: "1", note: null }, { id: "2", note: "" }]);
    expect(toInsertStatements("t", columns, rows)).toBe(
      `INSERT INTO t ("id", "note") VALUES ('1', NULL);\nINSERT INTO t ("id", "note") VALUES ('2', '');`,
    );
  });

  it("quotes what would break a field, a literal or a table", () => {
    expect(toDelimited(columns, [["1", 'say "hi", twice']], ",")).toBe('id,note\n1,"say ""hi"", twice"');
    expect(toInsertStatements("t", columns, [["1", "O'Brien"]])).toContain("'O''Brien'");
    expect(toMarkdown(columns, [["1", "a|b"]])).toContain("a\\|b");
  });

  it("exports Mongo documents as themselves, nesting kept", () => {
    const result: DbStatementResult = {
      statement: "db.c.find({})",
      columns,
      rows: [["1", null]],
      documents: ['{"_id": 1, "a": {"b": 2}}'],
      rows_affected: null,
      duration_ms: 1,
      truncated: false,
      messages: [],
      error: null,
    };
    expect(JSON.parse(formatResult(result, "json"))).toEqual([{ _id: 1, a: { b: 2 } }]);
  });
});
