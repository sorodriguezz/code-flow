import type { DbKind } from "../../types/database";

/**
 * The console's "Format", in the dialect of the connection it is typed against.
 *
 * `sql-formatter` is ~200 KB of grammars nobody needs until they press the button, so it is loaded
 * on the first use and never before — a dynamic `import()` of a package nothing else reaches, which
 * Rollup gives a chunk of its own without a `manualChunks` rule (and so without a chance of joining
 * a cycle; see `assertNoChunkCycles` in `vite.config.ts`).
 *
 * `keywordCase: "preserve"` on purpose: re-casing every keyword rewrites the whole statement, and a
 * console someone has been typing in lower case is not asking for that. Layout is the job.
 */

export type SqlFormatLanguage =
  | "postgresql"
  | "transactsql"
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "plsql"
  | "sql"
  | "bigquery"
  | "clickhouse"
  | "db2"
  | "db2i"
  | "duckdb"
  | "hive"
  | "n1ql"
  | "redshift"
  | "singlestoredb"
  | "snowflake"
  | "spark"
  | "tidb"
  | "trino";

/**
 * The drivers whose engine has a grammar of its own in the formatter, by catalogue id. Anything not
 * here formats as its session's kind does — CockroachDB as PostgreSQL — or, for the rest of the JDBC
 * drivers, as standard SQL.
 */
const DRIVER_LANGUAGES: Record<string, SqlFormatLanguage> = {
  bigquery: "bigquery",
  clickhouse: "clickhouse",
  db2: "db2",
  "db2-legacy": "db2",
  "db2-jtopen": "db2i",
  duckdb: "duckdb",
  hive: "hive",
  spark: "spark",
  databricks: "spark",
  couchbase: "n1ql",
  "oracle-legacy": "plsql",
  redshift: "redshift",
  singlestore: "singlestoredb",
  "singlestore-mysql": "singlestoredb",
  snowflake: "snowflake",
  tidb: "tidb",
  trino: "trino",
  presto: "trino",
  athena: "trino",
  "sqlserver-jdbc": "transactsql",
  "sqlserver-jtds": "transactsql",
  "sqlserver-localdb": "transactsql",
  "sybase-jtds": "transactsql",
  "sybase-jconnect": "transactsql",
};

/** The formatter's grammar for an engine, or `null` for the consoles that aren't SQL. IRIS has no
 *  grammar of its own there, and its SQL is close enough to the standard one to lay out. `driverId`
 *  refines it: a Snowflake connection formats as Snowflake, not as generic JDBC. */
export function formatLanguage(kind: DbKind, driverId = ""): SqlFormatLanguage | null {
  const own = DRIVER_LANGUAGES[driverId];
  if (own) return own;
  switch (kind) {
    case "postgres":
    case "supabase":
      return "postgresql";
    case "sqlserver":
      return "transactsql";
    case "mysql":
      return "mysql";
    case "mariadb":
      return "mariadb";
    case "sqlite":
      return "sqlite";
    case "oracle":
      return "plsql";
    case "iris":
    case "jdbc":
      return "sql";
    default:
      return null;
  }
}

/** Lays out `text` in the engine's dialect. Throws the formatter's own message when the text isn't
 *  something its grammar can read — the caller shows it and leaves the text alone. */
export async function formatSql(text: string, kind: DbKind, driverId = ""): Promise<string> {
  const language = formatLanguage(kind, driverId);
  if (!language) return text;
  const { format } = await import("sql-formatter");
  return format(text, { language, keywordCase: "preserve", tabWidth: 2, linesBetweenQueries: 1 });
}
