import type { DbKind } from "../../types/database";

/**
 * Backup and restore through the engines' own tools (`pg_dump`, `mysqldump`, `mongodump`) — or, for
 * SQLite, the engine itself. The backend (`datasource::backup`) answers every other engine with an
 * error; this is the same list, so the explorer can leave the menu entry out instead.
 */
const SUPPORTED: ReadonlySet<DbKind> = new Set<DbKind>(["postgres", "supabase", "mysql", "mariadb", "mongodb", "sqlite"]);

export function backupSupported(kind: DbKind): boolean {
  return SUPPORTED.has(kind);
}

/** Postgres' two dump formats: a `.sql` script, or the compressed archive `pg_restore` reads. */
export type PgBackupFormat = "plain" | "custom";

/** Whether the engine offers a choice of format — only Postgres does. */
export function hasFormatChoice(kind: DbKind): boolean {
  return kind === "postgres" || kind === "supabase";
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** The save dialog's filter for a backup. */
export function backupFilters(kind: DbKind, format: PgBackupFormat = "plain"): FileFilter[] {
  switch (kind) {
    case "postgres":
    case "supabase":
      return format === "custom"
        ? [{ name: "pg_dump archive", extensions: ["dump"] }]
        : [{ name: "SQL", extensions: ["sql"] }];
    case "mysql":
    case "mariadb":
      return [{ name: "SQL", extensions: ["sql"] }];
    case "mongodb":
      return [{ name: "mongodump archive", extensions: ["gz", "archive"] }];
    case "sqlite":
      return [{ name: "SQLite", extensions: ["sqlite", "db", "sqlite3"] }];
    default:
      return [];
  }
}

/**
 * The open dialog's filter for a restore. A SQLite restore runs a `.sql` script into the open
 * file — copying a database file over the one in use is not offered.
 */
export function restoreFilters(kind: DbKind): FileFilter[] {
  switch (kind) {
    case "postgres":
    case "supabase":
      return [{ name: "SQL / pg_dump", extensions: ["sql", "dump", "backup"] }];
    case "mysql":
    case "mariadb":
    case "sqlite":
      return [{ name: "SQL", extensions: ["sql"] }];
    case "mongodb":
      return [{ name: "mongodump archive", extensions: ["gz", "archive"] }];
    default:
      return [];
  }
}

/** `<name>-<yyyy-mm-dd-hhmm>.<ext>` — sortable, and the name says which database it holds. */
export function backupFileName(name: string, kind: DbKind, format: PgBackupFormat = "plain", now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/\.(sqlite3?|db)$/i, "").replace(/[^\w.-]+/g, "_") || "backup";
  const extension = kind === "mongodb" ? "archive.gz" : (backupFilters(kind, format)[0]?.extensions[0] ?? "bak");
  return `${base}-${stamp}.${extension}`;
}
