import { describe, expect, it } from "vitest";
import { errorLocation, locateStatement } from "./errorLocation";

describe("errorLocation", () => {
  it("reads Postgres' character position", () => {
    const sql = "SELECT *\nFROMM users";
    expect(errorLocation(sql, 'syntax error at or near "FROMM"\n(at Original(10))')).toEqual({
      line: 2,
      column: 1,
      endLine: 2,
      endColumn: 6,
    });
  });

  it("finds MySQL's `near` token on the line it names", () => {
    const sql = "SELECT 1;\nSELECT * FROMM t";
    const spot = errorLocation(
      sql,
      "You have an error in your SQL syntax; check the manual … near 'FROMM t' at line 2",
    );
    expect(spot).toEqual({ line: 2, column: 10, endLine: 2, endColumn: 15 });
  });

  it("finds SQLite's `near` token", () => {
    expect(errorLocation("SELEC 1", 'near "SELEC": syntax error')).toEqual({
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 6,
    });
  });

  it("underlines the whole line SQL Server names", () => {
    expect(errorLocation("SELECT 1\n  SELEC 2", "[102] Incorrect syntax near '2'. (line 2)")).toEqual({
      line: 2,
      column: 3,
      endLine: 2,
      endColumn: 10,
    });
  });

  it("reads line and column", () => {
    expect(errorLocation("SELECT x\nFROM dual", "ORA-00904: invalid identifier at line 1, column 8")?.column).toBe(8);
  });

  it("gives nothing when no place is named or the token is not there", () => {
    expect(errorLocation("SELECT 1", "permission denied for table t")).toBeNull();
    expect(errorLocation("SELECT 1", 'near "zzz": syntax error')).toBeNull();
  });
});

describe("locateStatement", () => {
  it("finds the second of two identical statements from where the first ended", () => {
    const buffer = "SELECT 1; SELECT 1;";
    expect(locateStatement(buffer, "SELECT 1", 9)).toBe(10);
  });
});
