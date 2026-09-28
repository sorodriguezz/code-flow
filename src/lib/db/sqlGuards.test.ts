import { describe, expect, it } from "vitest";
import { blankQuotedAndComments, unguardedDelete, unguardedWrites } from "./sqlGuards";

const verbs = (sql: string) => unguardedWrites(sql).map((write) => write.verb);

describe("blankQuotedAndComments", () => {
  it("keeps the text's length and line structure so offsets still line up", () => {
    const sql = "SELECT 'a;b' -- no\nFROM \"t\" /* x */";
    const masked = blankQuotedAndComments(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.split("\n")).toHaveLength(2);
    expect(masked).not.toContain("a;b");
    expect(masked).not.toContain("no");
    expect(masked).toContain("SELECT");
  });

  it("blanks a dollar-quoted body, where a DELETE without WHERE is only text", () => {
    expect(blankQuotedAndComments("SELECT $$DELETE FROM t$$")).not.toContain("DELETE");
  });
});

describe("unguardedWrites", () => {
  it("finds a DELETE and an UPDATE with no WHERE", () => {
    expect(verbs("DELETE FROM users")).toEqual(["DELETE"]);
    expect(verbs("update users set email = 'x'")).toEqual(["UPDATE"]);
  });

  it("leaves a DELETE or an UPDATE that has one alone", () => {
    expect(verbs("DELETE FROM users WHERE id = 1")).toEqual([]);
    expect(verbs("UPDATE users SET a = 1\nWHERE id = 7")).toEqual([]);
    expect(verbs("UPDATE t SET a = 1 FROM u WHERE u.id = t.id")).toEqual([]);
  });

  it("does not count a WHERE that belongs to a subquery", () => {
    expect(verbs("UPDATE t SET a = (SELECT b FROM c WHERE c.id = t.id)")).toEqual(["UPDATE"]);
    expect(verbs("DELETE FROM t USING (SELECT id FROM u WHERE flag) s")).toEqual(["DELETE"]);
    expect(verbs("DELETE FROM t WHERE id IN (SELECT id FROM u)")).toEqual([]);
  });

  it("reads the statement a WITH wraps, and the writes inside its CTEs", () => {
    expect(verbs("WITH s AS (SELECT id FROM u WHERE x) DELETE FROM t USING s")).toEqual(["DELETE"]);
    expect(verbs("WITH s AS (SELECT 1) UPDATE t SET a = 1 WHERE id = 2")).toEqual([]);
    expect(verbs("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")).toEqual(["DELETE"]);
    expect(verbs("WITH d AS (DELETE FROM t WHERE x RETURNING *) SELECT * FROM d")).toEqual([]);
  });

  it("is not fooled by a WHERE in a string or a comment", () => {
    expect(verbs("DELETE FROM t -- WHERE id = 1")).toEqual(["DELETE"]);
    expect(verbs("UPDATE t SET note = 'where it was'")).toEqual(["UPDATE"]);
    expect(verbs("SELECT 'DELETE FROM t'")).toEqual([]);
  });

  it("knows the verbs that are scoped by something other than a WHERE", () => {
    for (const sql of [
      "SELECT * FROM t FOR UPDATE",
      "INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET a = excluded.a",
      "INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE a = 2",
      "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN DELETE",
      "CREATE TABLE t (id int REFERENCES u ON DELETE CASCADE ON UPDATE CASCADE)",
      "GRANT SELECT, UPDATE, DELETE ON t TO app",
      "SELECT updated_at, deleted FROM t",
    ]) {
      expect(verbs(sql), sql).toEqual([]);
    }
  });

  it("does not lend one statement's WHERE to the one before it", () => {
    expect(verbs("DELETE FROM a; SELECT * FROM b WHERE x = 1")).toEqual(["DELETE"]);
    // A T-SQL batch needs no semicolon between statements.
    expect(verbs("DELETE FROM a\nSELECT * FROM b WHERE x = 1")).toEqual(["DELETE"]);
  });

  it("names every unguarded statement in the box, in order", () => {
    const found = unguardedWrites("UPDATE a SET x = 1; DELETE FROM b WHERE y; DELETE FROM c");
    expect(found.map((write) => write.statement)).toEqual(["UPDATE a SET x = 1", "DELETE FROM c"]);
  });

  it("shortens a long statement for the question", () => {
    const [found] = unguardedWrites(`DELETE FROM t ${"-- padding\n".repeat(40)}`);
    expect(found.statement.length).toBeLessThanOrEqual(161);
    expect(found.statement.endsWith("…")).toBe(true);
  });
});

describe("unguardedDelete", () => {
  it("still answers the delete-only question", () => {
    expect(unguardedDelete("UPDATE t SET a = 1")).toBeNull();
    expect(unguardedDelete("DELETE FROM t")).toBe("DELETE FROM t");
  });
});
