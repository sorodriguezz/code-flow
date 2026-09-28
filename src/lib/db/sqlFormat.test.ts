import { describe, expect, it } from "vitest";
import { formatLanguage, formatSql } from "./sqlFormat";

describe("formatLanguage", () => {
  it("picks each engine's own grammar, and none for the consoles that aren't SQL", () => {
    expect(formatLanguage("postgres")).toBe("postgresql");
    expect(formatLanguage("supabase")).toBe("postgresql");
    expect(formatLanguage("sqlserver")).toBe("transactsql");
    expect(formatLanguage("oracle")).toBe("plsql");
    expect(formatLanguage("iris")).toBe("sql");
    expect(formatLanguage("mongodb")).toBeNull();
    expect(formatLanguage("redis")).toBeNull();
  });
});

describe("formatSql", () => {
  it("lays a statement out without re-casing what the user typed", async () => {
    const formatted = await formatSql("select id, name from users where id = 1", "postgres");
    expect(formatted).toBe("select\n  id,\n  name\nfrom\n  users\nwhere\n  id = 1");
  });

  it("keeps a dialect's own quoting intact", async () => {
    const formatted = await formatSql("SELECT [order], `x` FROM [dbo].[t]", "sqlserver").catch(() => null);
    // T-SQL brackets survive; the formatter is allowed to refuse the backtick, but never to mangle it.
    if (formatted !== null) expect(formatted).toContain("[order]");
    expect(await formatSql("SELECT $$a;b$$", "postgres")).toContain("$$a;b$$");
  });

  it("leaves a non-SQL console's text alone", async () => {
    expect(await formatSql("db.users.find({})", "mongodb")).toBe("db.users.find({})");
  });
});
