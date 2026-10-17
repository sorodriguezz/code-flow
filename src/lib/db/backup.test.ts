import { describe, expect, it } from "vitest";
import { backupFileName, backupFilters, backupSupported, hasFormatChoice, restoreFilters } from "./backup";
import type { DbKind } from "../../types/database";

describe("backup", () => {
  it("offers backup only where the backend has a tool for it", () => {
    const yes: DbKind[] = ["postgres", "supabase", "mysql", "mariadb", "mongodb", "sqlite"];
    const no: DbKind[] = ["sqlserver", "oracle", "iris", "redis", "jdbc"];
    for (const kind of yes) expect(backupSupported(kind)).toBe(true);
    for (const kind of no) expect(backupSupported(kind)).toBe(false);
  });

  it("filters files per engine and format", () => {
    expect(backupFilters("postgres", "custom")[0].extensions).toEqual(["dump"]);
    expect(backupFilters("supabase")[0].extensions).toEqual(["sql"]);
    expect(backupFilters("mongodb")[0].extensions).toContain("gz");
    expect(restoreFilters("postgres")[0].extensions).toEqual(["sql", "dump", "backup"]);
    // SQLite restores by running a script, never by copying a file over the open one.
    expect(restoreFilters("sqlite")[0].extensions).toEqual(["sql"]);
    expect(backupFilters("redis")).toEqual([]);
  });

  it("only Postgres has a format choice", () => {
    expect(hasFormatChoice("postgres")).toBe(true);
    expect(hasFormatChoice("mysql")).toBe(false);
  });

  it("names the file after the database and the time", () => {
    const at = new Date(2026, 9, 17, 9, 5);
    expect(backupFileName("shop", "postgres", "custom", at)).toBe("shop-2026-10-17-0905.dump");
    expect(backupFileName("/data/app.sqlite", "sqlite", "plain", at)).toBe("app-2026-10-17-0905.sqlite");
    expect(backupFileName("sales", "mongodb", "plain", at)).toBe("sales-2026-10-17-0905.archive.gz");
    expect(backupFileName("", "mysql", "plain", at)).toBe("backup-2026-10-17-0905.sql");
  });
});
