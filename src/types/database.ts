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

/**
 * Who the server is being asked to believe we are — a separate axis from the engine.
 *
 * `entra_cli` borrows the session `az login` already established, so no credential is stored here
 * and MFA / conditional access happen in Microsoft's own flow. `entra_service_principal` exchanges
 * a tenant + client id + client secret for a token. SQL Server only: an Azure SQL server set to
 * Entra-only has SQL logins disabled, which makes this the difference between the engine working
 * and being unreachable.
 */
export type DbAuthMethod = "password" | "entra_cli" | "entra_service_principal";

export interface DbConnectionConfig {
  id: string;
  kind: DbKind;
  host: string;
  /** 0 means "the engine's default port". */
  port: number;
  /** Postgres database / SQL Server database / IRIS namespace / Mongo database. */
  database: string;
  /** The login — or the application (client) ID under `entra_service_principal`. */
  user: string;
  /**
   * Only ever set on an unsaved form being tested. A stored connection's password lives in the OS
   * keychain and never reaches the webview — there is no command that reads it back. Holds the
   * client secret under `entra_service_principal`.
   */
  password: string;
  /** How to authenticate. `password` for everything made before this field existed. */
  auth_method: DbAuthMethod;
  /** The Entra ID directory (tenant). Required for a service principal, optional for the CLI. */
  tenant_id: string;
  /** A full connection URI, which wins over every field above when set. */
  url: string;
  ssl: DbSslMode;
  /** Driver extras (`application_name`, `authSource`, `path`, …) as ordered pairs. */
  options: [string, string][];
  read_only: boolean;
  connect_timeout_ms: number;
  /**
   * Whether the tree's root lists every database on the server or only the one this connection is
   * on. Off by default — a connection that names a database came for that database.
   */
  show_all_databases: boolean;
  /** Which schemas the tree lists, when `schemas_filtered` is on. */
  visible_schemas: string[];
  /**
   * Whether `visible_schemas` is a filter at all.
   *
   * Its own flag rather than "empty means everything", because those are three states and a list
   * only carries two: never configured (show it all — the default), these ones, and **none of
   * them**. The third has to be reachable: an IRIS namespace lists 348 schemas, and unticking the
   * last box must mean what it says instead of silently reverting to all 348.
   */
  schemas_filtered: boolean;
  /** A substring every table, view and routine name must contain to be listed. */
  object_filter: string;

  /** Seconds of idleness before a trivial statement is sent to hold the connection open. 0 is off. */
  keep_alive_secs: number;
  /** Seconds of idleness before the session is closed. 0 is off. */
  auto_disconnect_secs: number;
  /** SQL run once, right after connecting. A failure fails the connection. */
  startup_script: string;

  /** A PEM certificate authority to trust in addition to the system's. */
  ssl_ca_file: string;
  /** Client certificate and key, both PEM, for certificate authentication. */
  ssl_cert_file: string;
  ssl_key_file: string;

  /** Reach the database through an SSH tunnel. */
  ssh_enabled: boolean;
  ssh_host: string;
  /** 0 means 22. */
  ssh_port: number;
  /** Empty defers to `~/.ssh/config`, as `ssh` itself would. */
  ssh_user: string;
  /** A private key to use. Empty means whatever `ssh` would pick — the agent, then the defaults. */
  ssh_key_file: string;
}

/**
 * One column of a table, and the column it points at.
 *
 * Per column rather than per constraint: the question the grid asks is "I am on this cell — where
 * does it lead?", and a composite key answers that once per column.
 */
export interface DbForeignKey {
  column: string;
  ref_schema: string | null;
  ref_table: string;
  ref_column: string;
}

// ---------------------------------------------------------------------------
// Schema diagram
// ---------------------------------------------------------------------------

/** One column, as the diagram draws it — what makes it structural, and nothing else. */
export interface DbDiagramColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  /** Derived from the edge list on the backend, so the flag and the line can never disagree. */
  foreign_key: boolean;
}

export interface DbDiagramTable {
  schema: string | null;
  name: string;
  /** `table`, `view` or `collection`. A view holds no rows and declares no keys. */
  kind: DbNodeKind;
  columns: DbDiagramColumn[];
  /** The server's own estimate where it keeps one — never a `COUNT(*)`. `null` on IRIS, which
   * keeps no such figure. */
  row_estimate: number | null;
}

export interface DbDiagramEdge {
  constraint: string;
  from_schema: string | null;
  from_table: string;
  from_column: string;
  to_schema: string | null;
  to_table: string;
  to_column: string;
  /** True when no catalog declares this and it was guessed from a field name — the only kind Mongo
   * can have. Drawn dashed and counted apart: a guess shown as a constraint is worse than no line. */
  inferred: boolean;
}

export interface DbSchemaDiagram {
  database: string | null;
  schema: string | null;
  tables: DbDiagramTable[];
  edges: DbDiagramEdge[];
  /** What the reader needs in order to trust the picture: a sample size, a truncation. */
  notes: string[];
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

/** One database's schemas, as `dbSchemaCatalog` reads them for the connection dialog's chooser. */
export interface DbSchemaGroup {
  database: string;
  schemas: string[];
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

/**
 * One object of a schema, with everything its engine's catalog will say about it.
 *
 * Every field but the name and the kind is optional, and that is the honest shape: Postgres records
 * no creation date, IRIS reports no size, Mongo has neither. `null` means "this engine will not
 * say" and the grid leaves the cell empty rather than inventing a zero.
 */
export interface DbObjectInfo {
  name: string;
  kind: DbNodeKind;
  /** What the engine itself calls the type — `USER_TABLE`, `MATERIALIZED VIEW`, `SEQUENCE_OBJECT`. */
  objectType: string;
  createdAt: string | null;
  modifiedAt: string | null;
  /** Bytes reserved, indexes included. */
  totalBytes: number | null;
  /** Bytes actually holding data. */
  usedBytes: number | null;
  /** An estimate, never a `COUNT(*)`. */
  rows: number | null;
  comment: string;
}

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

/** One column of a sort, and which way. */
export interface DbSortKey {
  column: string;
  descending: boolean;
}

export interface DbTableDataRequest {
  node: DbNodeRef;
  offset: number;
  limit: number;
  /** The sort keys in order; empty for the server's own. */
  sort: DbSortKey[];
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
  /** Free text. Empty is "ungrouped", which the tree shows as a bucket of its own at the top. */
  group_name: string;
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

/**
 * A folder in the connection tree.
 *
 * Carries no members — a connection's `group_name` is what puts it in a group. This row exists so
 * a group can exist while empty, which is the state between making a folder and filling it.
 */
export interface DbGroupRow {
  id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface DbWorkspaceTree {
  connections: DbConnectionRow[];
  groups: DbGroupRow[];
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
    auth_method: "password",
    tenant_id: "",
    url: "",
    ssl: engine.defaultSsl,
    options: [],
    read_only: false,
    connect_timeout_ms: 15000,
    show_all_databases: false,
    visible_schemas: [],
    schemas_filtered: false,
    object_filter: "",
    keep_alive_secs: 0,
    auto_disconnect_secs: 0,
    startup_script: "",
    ssl_ca_file: "",
    ssl_cert_file: "",
    ssl_key_file: "",
    ssh_enabled: false,
    ssh_host: "",
    ssh_port: 0,
    ssh_user: "",
    ssh_key_file: "",
  };
}

/** The default row limit for a console run. Matches what DataGrip's page size defaults to. */
export const DEFAULT_MAX_ROWS = 500;

/** Page size for the data editor. */
export const DEFAULT_PAGE_SIZE = 200;
