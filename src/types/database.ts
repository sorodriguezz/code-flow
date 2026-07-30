/**
 * Wire types for the database workspace.
 *
 * Mirrored one-for-one from `src-tauri/src/datasource/mod.rs` and the `Db*` models in
 * `src-tauri/src/db/models.rs`. The names here are the serde wire names — snake_case, like the API
 * client's types — so renaming a field on either side is a breaking change on both.
 *
 * The shape worth understanding before reading the UI: **every value crosses as text**. A cell is
 * `string | null`, where `null` is SQL NULL and `""` is an empty string, and the two are never
 * interchangeable. The backend renders each value the way its own server does, so what the grid
 * shows is what `psql` / SSMS / the Mongo shell would show — and what can be pasted back into a
 * statement. See the module docs in `datasource/mod.rs` for why that beats decoding types here.
 */

/** Which engine a connection speaks. `supabase` is Postgres with different connection defaults. */
export type DbKind = "postgres" | "supabase" | "sqlserver" | "iris" | "mongodb";

export type DbSslMode = "disable" | "require" | "verify_full";

export interface DbConnectionConfig {
  id: string;
  kind: DbKind;
  host: string;
  /** 0 means "the engine's default port". */
  port: number;
  /** Postgres database / SQL Server database / IRIS namespace / Mongo database. */
  database: string;
  user: string;
  /**
   * Only ever set on an unsaved form being tested. A stored connection's password lives in the OS
   * keychain and never reaches the webview — there is no command that reads it back.
   */
  password: string;
  /** A full connection URI, which wins over every field above when set. */
  url: string;
  ssl: DbSslMode;
  /** Driver extras (`application_name`, `authSource`, `path`, …) as ordered pairs. */
  options: [string, string][];
  read_only: boolean;
  connect_timeout_ms: number;
}

export interface DbColumn {
  name: string;
  /** As the engine names it (`int4`, `nvarchar(50)`, `objectId`). Empty when it couldn't be known —
   * a computed column in a join, say — which the grid reads as "text, not editable". */
  type_name: string;
}

export interface DbStatementResult {
  statement: string;
  columns: DbColumn[];
  /** `null` is SQL NULL; `""` is an empty string. */
  rows: (string | null)[][];
  /** Mongo only: each document as JSON text, key order as stored. */
  documents: string[];
  rows_affected: number | null;
  duration_ms: number;
  /** The row limit cut this short — there is more where it came from. */
  truncated: boolean;
  /** Server chatter that isn't a result: Postgres `NOTICE`s, IRIS console output. */
  messages: string[];
  error: string | null;
}

export interface DbExecuteResult {
  results: DbStatementResult[];
  duration_ms: number;
}

export interface DbServerInfo {
  kind: DbKind;
  version: string;
  database: string;
  user: string;
  /** Things worth knowing that aren't failures — a pooler's limitations, the IRIS driver version. */
  notes: string[];
}

/**
 * What a node in the explorer is. The `*_folder` kinds are the grouping rows ("Tables", "Columns")
 * that carry no server object of their own.
 */
export type DbNodeKind =
  | "root"
  | "database"
  | "schema"
  | "table_folder"
  | "view_folder"
  | "routine_folder"
  | "sequence_folder"
  | "column_folder"
  | "index_folder"
  | "key_folder"
  | "table"
  | "view"
  | "routine"
  | "sequence"
  | "collection"
  | "column"
  | "index"
  | "key";

export interface DbColumnInfo {
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  default_value: string | null;
  position: number;
}

export interface DbNode {
  id: string;
  kind: DbNodeKind;
  name: string;
  /** The dim text after the name: a column's type, a table's row estimate. */
  detail: string;
  database: string | null;
  schema: string | null;
  /** The relation a column/index/key belongs to. */
  table: string | null;
  has_children: boolean;
  /** Set on `column` nodes only — what the data editor needs to build an `UPDATE`. */
  column: DbColumnInfo | null;
}

/** Where an operation applies. Sent back verbatim when expanding, which keeps the tree stateless
 * on the backend. */
export interface DbNodeRef {
  kind: DbNodeKind;
  database: string | null;
  schema: string | null;
  name: string | null;
}

export interface DbExecContext {
  database: string | null;
  schema: string | null;
  /** Rows to fetch before calling the result truncated. 0 means no limit. */
  max_rows: number;
}

export interface DbTableDataRequest {
  node: DbNodeRef;
  offset: number;
  limit: number;
  order_by: string | null;
  descending: boolean;
  /** A `WHERE` fragment (SQL) or a filter document (Mongo), exactly as typed. */
  filter: string;
}

export type DbRowEditKind = "insert" | "update" | "delete";

export interface DbCell {
  column: string;
  /** `null` is NULL. */
  value: string | null;
  type_name: string;
}

export interface DbRowEdit {
  kind: DbRowEditKind;
  /** Columns being written. Empty for a delete. */
  values: DbCell[];
  /** How to find the row again: the primary key, else every original value. Empty for an insert. */
  keys: DbCell[];
}

export interface DbEditResult {
  applied: number;
  /** Every statement that ran, in order — shown because generated DML you can't see is DML you
   * can't trust. */
  statements: string[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// Stored rows
// ---------------------------------------------------------------------------

export interface DbConnectionRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: DbKind;
  /** JSON `DbConnectionConfig`, minus the password. */
  spec: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DbConsole {
  id: string;
  connection_id: string;
  name: string;
  body: string;
  database_name: string;
  schema_name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DbQueryHistoryEntry {
  id: string;
  workspace_id: string;
  connection_id: string;
  connection_name: string;
  statement: string;
  database_name: string;
  duration_ms: number;
  row_count: number;
  /** Empty when the statement succeeded. */
  error: string;
  ran_at: string;
}

export interface DbWorkspaceTree {
  connections: DbConnectionRow[];
  consoles: DbConsole[];
}

// ---------------------------------------------------------------------------
// Engine metadata
// ---------------------------------------------------------------------------

/**
 * What the connection form needs to know per engine, in one place so adding an engine is one entry
 * here plus a driver in Rust.
 */
export interface DbEngineInfo {
  kind: DbKind;
  label: string;
  defaultPort: number;
  /** SQL engines get a schema level in the tree and a SQL console; Mongo gets neither. */
  sql: boolean;
  /** What the "database" field is called for this engine — the word the server itself uses. */
  databaseLabel: string;
  /** Shown under the URL field. */
  urlPlaceholder: string;
  defaultSsl: DbSslMode;
  /** Pre-filled user, when the engine has a conventional one. */
  defaultUser: string;
}

export const DB_ENGINES: DbEngineInfo[] = [
  {
    kind: "postgres",
    label: "PostgreSQL",
    defaultPort: 5432,
    sql: true,
    databaseLabel: "Database",
    urlPlaceholder: "postgres://user:password@host:5432/database",
    defaultSsl: "disable",
    defaultUser: "postgres",
  },
  {
    kind: "supabase",
    label: "Supabase",
    defaultPort: 5432,
    sql: true,
    databaseLabel: "Database",
    // The string Supabase's dashboard hands out verbatim, so it can be pasted as-is.
    urlPlaceholder: "postgresql://postgres.<ref>:password@aws-0-<region>.pooler.supabase.com:5432/postgres",
    // Everything reaches Supabase over the internet, so verification is the only sane default.
    defaultSsl: "verify_full",
    defaultUser: "postgres",
  },
  {
    kind: "sqlserver",
    label: "SQL Server",
    defaultPort: 1433,
    sql: true,
    databaseLabel: "Database",
    urlPlaceholder: "Server=host,1433;Database=db;User Id=sa;Password=…;Encrypt=true",
    defaultSsl: "require",
    defaultUser: "sa",
  },
  {
    kind: "iris",
    label: "InterSystems IRIS",
    // The superserver, which is what JDBC talks to — not the web server's 52773, where this
    // driver used to go when it spoke the Atelier REST API.
    defaultPort: 1972,
    sql: true,
    databaseLabel: "Namespace",
    urlPlaceholder: "jdbc:IRIS://host:1972/USER",
    defaultSsl: "disable",
    defaultUser: "_SYSTEM",
  },
  {
    kind: "mongodb",
    label: "MongoDB",
    defaultPort: 27017,
    sql: false,
    databaseLabel: "Database",
    urlPlaceholder: "mongodb+srv://user:password@cluster.mongodb.net/database",
    defaultSsl: "disable",
    defaultUser: "",
  },
];

export function engineInfo(kind: DbKind): DbEngineInfo {
  return DB_ENGINES.find((engine) => engine.kind === kind) ?? DB_ENGINES[0];
}

export function defaultConnectionConfig(kind: DbKind): DbConnectionConfig {
  const engine = engineInfo(kind);
  return {
    id: "",
    kind,
    host: "localhost",
    port: 0,
    database: kind === "iris" ? "USER" : "",
    user: engine.defaultUser,
    password: "",
    url: "",
    ssl: engine.defaultSsl,
    options: [],
    read_only: false,
    connect_timeout_ms: 15000,
  };
}

/** The default row limit for a console run. Matches what DataGrip's page size defaults to. */
export const DEFAULT_MAX_ROWS = 500;

/** Page size for the data editor. */
export const DEFAULT_PAGE_SIZE = 200;
