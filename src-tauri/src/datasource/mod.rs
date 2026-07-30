//! Driver layer for the database workspace.
//!
//! Five engines — PostgreSQL, Supabase, SQL Server, InterSystems IRIS and MongoDB — behind one
//! set of wire types, so the whole frontend (explorer tree, console, result grid, data editor)
//! is written once and every engine plugs into it.
//!
//! Three decisions shape everything here:
//!
//! 1. **Enum dispatch, not trait objects.** [`Session`] is an enum and every operation is a
//!    `match`, mirroring the VCS provider dispatch in `ado_cmd`. It costs a match arm per engine
//!    but keeps the sessions concrete: a Postgres client is shared by `&self`, a tiberius client
//!    needs `&mut`, and a Mongo client is a handle to a pool. A `dyn Driver` would have to paper
//!    over all three and would need `async-trait` to exist at all.
//!
//! 2. **Every value crosses the wire as text.** `rows: Vec<Vec<Option<String>>>` — `None` is SQL
//!    NULL, `Some(s)` is the value as the server itself renders it. The alternative (decode every
//!    engine's binary wire format into a typed JSON value) means writing a decoder per type per
//!    engine, and getting *one* of them wrong silently corrupts data in a grid the user is about
//!    to edit. Postgres gets this for free from the simple query protocol, which is the same path
//!    `psql` displays; the other three format from their own decoded types.
//!
//! 3. **The backend owns the credential, the frontend owns the query.** A command hands down the
//!    whole [`DbConnectionConfig`] minus the password, which is read here from the OS keychain —
//!    the one thing a webview cannot do. Everything else about a statement (which schema, which
//!    limit, which filter) is decided in the frontend and arrives fully resolved, the same split
//!    the API client draws in `api/mod.rs`.
//!
//! Every type below is mirrored one-for-one in `src/types/database.ts`; field names are the serde
//! wire names, so renaming one here is a breaking change on both sides.

pub mod iris;
pub mod jvm;
pub mod mongo;
pub mod mssql;
pub mod postgres;
pub mod sqlgen;
pub mod tunnel;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbKind {
    Postgres,
    /// A Supabase project *is* a Postgres instance, so it shares the driver outright. It stays a
    /// kind of its own because everything around the connection differs: the host shape
    /// (`db.<ref>.supabase.co` or a pooler), TLS being mandatory rather than optional, and a
    /// schema list where `public` is the user's and a dozen others are the platform's.
    Supabase,
    Sqlserver,
    Iris,
    Mongodb,
}

/// Which SQL to generate — identifier quoting, paging, `EXPLAIN`, and the catalog queries the
/// explorer runs. Postgres and Supabase collapse into one; Mongo has no dialect at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    Postgres,
    /// T-SQL: `[bracketed]` identifiers, `OFFSET … FETCH NEXT`, `sys.*` catalog.
    TSql,
    /// InterSystems SQL: `"quoted"` identifiers, `TOP` instead of `LIMIT`, `INFORMATION_SCHEMA`.
    Iris,
}

impl DbKind {
    pub fn default_port(self) -> u16 {
        match self {
            DbKind::Postgres | DbKind::Supabase => 5432,
            DbKind::Sqlserver => 1433,
            // The IRIS superserver, which is what JDBC talks to. Not 52773 — that is the web
            // server, and it is where this driver used to go when it spoke the Atelier REST API.
            DbKind::Iris => 1972,
            DbKind::Mongodb => 27017,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbSslMode {
    /// Plaintext. The only sane default for `localhost` and a Docker container.
    Disable,
    /// Encrypt, but accept any certificate — what a self-signed dev server needs.
    Require,
    /// Encrypt and verify the chain and hostname. Required for anything over the internet.
    VerifyFull,
}

// ---------------------------------------------------------------------------
// Connection configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbConnectionConfig {
    pub id: String,
    pub kind: DbKind,
    pub host: String,
    /// 0 means "the engine's default" — stored rather than resolved so changing a default here
    /// moves every connection that never set one.
    #[serde(default)]
    pub port: u16,
    /// Postgres database / SQL Server database / IRIS namespace / Mongo database.
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    /// Empty on every stored connection: the real value is read from the OS keychain by
    /// [`resolve_password`]. Only "Test connection" on an unsaved form fills it in, because there
    /// is nothing in the keychain to read yet.
    #[serde(default)]
    pub password: String,
    /// A full connection URI, which wins over every field above when set. Present because that is
    /// how these credentials are actually handed out — Supabase and Mongo Atlas both give you a
    /// URI to paste, and re-typing it into six boxes is a chance to get it wrong.
    #[serde(default)]
    pub url: String,
    pub ssl: DbSslMode,
    /// Driver-specific extras (`application_name`, `authSource`, `web_prefix`, …). A list of pairs
    /// rather than a map so the UI can keep the user's ordering and allow an empty new row.
    #[serde(default)]
    pub options: Vec<(String, String)>,
    /// Refuses anything but a read at the driver level. Not a substitute for a read-only database
    /// role — it is a guard against a typo in a console pointed at production.
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub connect_timeout_ms: u64,
    /// Whether the tree's root lists every database on the server or only the one this connection
    /// is on. Off by default: naming a database is how the user says which one they came for, and
    /// a root offering the other forty answers a question they didn't ask. See
    /// [`scope_to_current_database`].
    #[serde(default)]
    pub show_all_databases: bool,
    /// Which schemas the tree lists. Empty means all of them — a filter nobody set is not a filter.
    ///
    /// An allowlist rather than a list of things to hide, because that is the question the user is
    /// actually answering: a database with ninety schemas and three that matter is named by the
    /// three. See [`filter_children`].
    #[serde(default)]
    pub visible_schemas: Vec<String>,
    /// A substring every table, view and routine name must contain to be listed. Empty means no
    /// filter. Matched case-insensitively, since no engine here agrees with another about case.
    #[serde(default)]
    pub object_filter: String,

    // ----------------------------------------------------------------- session

    /// Seconds of idleness after which a trivial statement is sent to keep the connection open.
    /// 0 is off. For the firewalls and pgbouncer-style poolers that drop a quiet socket without
    /// telling either end — the failure that otherwise shows up as one mysterious dead query.
    #[serde(default)]
    pub keep_alive_secs: u32,
    /// Seconds of idleness after which the session is closed. 0 is off. The opposite trade from
    /// keep-alive, and both are legitimate: a licence-limited server wants the connection back.
    #[serde(default)]
    pub auto_disconnect_secs: u32,
    /// SQL run once, immediately after connecting — a `SET search_path`, a role, a timezone.
    /// A failure here fails the connection: a session that silently didn't get its `search_path`
    /// answers every later query from the wrong schema.
    #[serde(default)]
    pub startup_script: String,

    // --------------------------------------------------------------------- TLS

    /// A PEM certificate authority to trust *in addition to* the system's. For the self-signed and
    /// private-CA servers that `verify_full` would otherwise reject and `require` would accept
    /// without checking anything.
    #[serde(default)]
    pub ssl_ca_file: String,
    /// Client certificate and its private key, both PEM, for servers that authenticate the client
    /// by certificate rather than (or as well as) by password.
    #[serde(default)]
    pub ssl_cert_file: String,
    #[serde(default)]
    pub ssl_key_file: String,

    // --------------------------------------------------------------------- SSH

    /// Whether to reach the database through an SSH tunnel. See [`super::tunnel`].
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    /// 0 means 22.
    #[serde(default)]
    pub ssh_port: u16,
    /// Empty defers to `~/.ssh/config` and then to the local username, exactly as `ssh` itself does.
    #[serde(default)]
    pub ssh_user: String,
    /// A private key to use. Empty means whatever `ssh` would pick on its own — the agent, then the
    /// default identities — which is usually the right answer on a machine that already pushes.
    #[serde(default)]
    pub ssh_key_file: String,
}

impl DbConnectionConfig {
    pub fn option(&self, key: &str) -> Option<&str> {
        self.options
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    }

    pub fn effective_port(&self) -> u16 {
        if self.port == 0 {
            self.kind.default_port()
        } else {
            self.port
        }
    }

    pub fn connect_timeout(&self) -> std::time::Duration {
        let ms = if self.connect_timeout_ms == 0 { 15_000 } else { self.connect_timeout_ms };
        std::time::Duration::from_millis(ms)
    }

    /// `host:port` for error messages, matching how `explain_cause` in `api::mod` phrases them.
    pub fn endpoint(&self) -> String {
        format!("{}:{}", self.host, self.effective_port())
    }

    /// The password the driver should actually use: whatever the form passed inline, else the one
    /// in the OS keychain.
    ///
    /// A missing keychain entry is not an error — plenty of local databases have no password, and
    /// trust auth is the default in a Postgres container.
    pub fn resolve_password(&mut self) {
        if !self.password.is_empty() {
            return;
        }
        if self.id.is_empty() {
            return;
        }
        if let Ok(Some(secret)) = crate::secrets::get_secret(&password_key(&self.id)) {
            self.password = secret;
        }
    }
}

/// Rejects a statement that would write, when the connection is marked read-only.
///
/// Deliberately a *prefix* check on the leading keyword rather than a parse: the real guard is a
/// read-only database role, and pretending a keyword match is one would be worse than being
/// obviously shallow about it. What it does buy is catching the `DELETE FROM users` typed into the
/// wrong console, which is the accident this flag exists for.
pub fn read_only_guard(statement: &str, read_only: bool) -> Result<(), String> {
    if !read_only {
        return Ok(());
    }
    let head = statement
        .trim_start()
        .split(|c: char| c.is_whitespace() || c == '(')
        .find(|word| !word.is_empty())
        .unwrap_or("")
        .to_ascii_uppercase();
    const READS: [&str; 9] = [
        "SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "SET", "USE", "CALL",
    ];
    if READS.contains(&head.as_str()) || head.is_empty() {
        return Ok(());
    }
    Err(format!(
        "This connection is marked read-only, so `{head}` was not sent. Turn off \"Read-only\" in \
         the connection's settings to run it."
    ))
}

/// What a write is refused with when the connection is read-only. Separate from
/// [`read_only_guard`] because the data editor has no statement keyword to name — it is refusing
/// the whole operation.
pub fn read_only_refusal() -> String {
    "This connection is marked read-only, so nothing was written. Turn off \"Read-only\" in the \
     connection's settings to save changes."
        .to_string()
}

/// Keychain key for a connection's password. Per connection id, so two databases on the same host
/// keep separate credentials.
pub fn password_key(connection_id: &str) -> String {
    format!("db-password:{connection_id}")
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbColumn {
    pub name: String,
    /// As the engine names it (`int4`, `nvarchar`, `%Library.String`, `objectId`). Shown under the
    /// column header in the grid, and used to decide how to render and re-encode a cell.
    pub type_name: String,
}

impl DbColumn {
    pub fn new(name: impl Into<String>, type_name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            type_name: type_name.into(),
        }
    }
}

/// One statement's outcome. A console run produces one of these per statement in the batch, which
/// is what lets the UI show "3 of 4 statements ran, the fourth failed here".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbStatementResult {
    pub statement: String,
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Mongo only: each document as JSON *text*, so the console can offer a real JSON view beside
    /// the flattened grid. Empty for every SQL engine.
    ///
    /// Text rather than a `serde_json::Value` because a `Value`'s object map sorts its keys, which
    /// would move `_id` to wherever the alphabet puts it. `JSON.parse` on the frontend keeps the
    /// order this string has, so the document reads the way it is stored.
    #[serde(default)]
    pub documents: Vec<String>,
    pub rows_affected: Option<i64>,
    pub duration_ms: u64,
    /// The row limit cut the result short — there is more where this came from.
    pub truncated: bool,
    /// Server chatter that isn't a result: Postgres `NOTICE`s, SQL Server `PRINT`, IRIS console
    /// output. Losing these makes a stored procedure look like it did nothing.
    pub messages: Vec<String>,
    pub error: Option<String>,
}

impl DbStatementResult {
    pub fn empty(statement: &str) -> Self {
        Self {
            statement: statement.to_string(),
            columns: Vec::new(),
            rows: Vec::new(),
            documents: Vec::new(),
            rows_affected: None,
            duration_ms: 0,
            truncated: false,
            messages: Vec::new(),
            error: None,
        }
    }

    pub fn failed(statement: &str, error: impl Into<String>) -> Self {
        let mut result = Self::empty(statement);
        result.error = Some(error.into());
        result
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbExecuteResult {
    pub results: Vec<DbStatementResult>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbServerInfo {
    pub kind: DbKind,
    pub version: String,
    pub database: String,
    pub user: String,
    /// Anything the user should know that isn't a failure — which IRIS JDBC driver answered, "the
    /// pooler doesn't support prepared statements".
    #[serde(default)]
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// The explorer tree
// ---------------------------------------------------------------------------

/// What a node in the explorer is.
///
/// The `*Folder` kinds are the grouping rows ("Tables", "Columns", …) that make a tree readable
/// instead of a wall of names. They carry no server object of their own — expanding one runs the
/// query that lists what it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbNodeKind {
    /// The connection itself. Expanding it lists databases (or namespaces).
    Root,
    Database,
    Schema,
    TableFolder,
    ViewFolder,
    RoutineFolder,
    SequenceFolder,
    ColumnFolder,
    IndexFolder,
    KeyFolder,
    Table,
    View,
    Routine,
    Sequence,
    /// Mongo's answer to a table.
    Collection,
    Column,
    Index,
    /// A foreign key or a primary key constraint.
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbColumnInfo {
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbNode {
    /// Stable within a connection, built from the path (`db|schema|table|column`) so the frontend
    /// can key expansion state on it without inventing ids of its own.
    pub id: String,
    pub kind: DbNodeKind,
    pub name: String,
    /// The dim text after the name: a column's type, a table's row estimate, an index's columns.
    #[serde(default)]
    pub detail: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    /// The relation a column/index/key belongs to.
    pub table: Option<String>,
    pub has_children: bool,
    /// Set on `Column` nodes only — the data editor needs the type and the primary-key flag to
    /// build an `UPDATE`, and it has them here rather than re-querying the catalog.
    pub column: Option<DbColumnInfo>,
}

/// Where in the tree an operation applies. Sent back verbatim by the frontend when it expands a
/// node, which is what keeps the tree stateless on this side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbNodeRef {
    pub kind: DbNodeKind,
    pub database: Option<String>,
    pub schema: Option<String>,
    /// The object's own name — the table under a `ColumnFolder`, the table itself for a `Table`.
    pub name: Option<String>,
}

impl DbNodeRef {
    pub fn db(&self) -> Option<&str> {
        self.database.as_deref().filter(|d| !d.is_empty())
    }

    pub fn schema(&self) -> Option<&str> {
        self.schema.as_deref().filter(|s| !s.is_empty())
    }

    pub fn name(&self) -> Result<&str, String> {
        self.name
            .as_deref()
            .filter(|n| !n.is_empty())
            .ok_or_else(|| "This action needs a table or collection to work on.".to_string())
    }
}

/// Narrows the tree's root to the database the connection is actually on.
///
/// Every driver answers the root with what its account can *reach* — `pg_database`, `sys.databases`,
/// `%SYS.Namespace_List()` — which is the right answer for browsing a server and the wrong one for a
/// connection that named a database. This is the narrowing, applied over the drivers rather than
/// inside them so the rule is one rule and not five.
///
/// `current` is the server's own spelling of the database (`current_database()`, the IRIS
/// namespace), not the config field, so it holds for a connection made from a URL as well.
///
/// A `current` that matches nothing is left alone rather than filtered to an empty root: the name
/// can be one this server doesn't have, and a tree showing too much is a smaller failure than a
/// tree showing nothing.
pub fn scope_to_current_database(mut nodes: Vec<DbNode>, current: &str) -> Vec<DbNode> {
    if current.is_empty() {
        return nodes;
    }
    // Exact before loose, since two databases can differ only in case. The loose pass is for IRIS,
    // whose namespace list comes back upper-cased however the connection spelled it.
    let exact = nodes.iter().any(|node| node.database.as_deref() == Some(current));
    let keep = |node: &DbNode| match node.database.as_deref() {
        Some(name) if exact => name == current,
        Some(name) => name.eq_ignore_ascii_case(current),
        None => false,
    };
    if nodes.iter().any(keep) {
        nodes.retain(keep);
    }
    nodes
}

/// Applies the connection's own visibility rules to a level of the tree.
///
/// Over the drivers rather than inside them, for the same reason as [`scope_to_current_database`]:
/// this is a rule about what *this user* wants to look at, not about what the engine holds, and a
/// driver that knew about it would be answering a question it was never asked.
///
/// Nothing is filtered when the corresponding setting is empty, and a filter that would empty a
/// level still empties it — unlike the database narrowing, a schema list is something the user typed
/// deliberately, so "you asked for a schema this database doesn't have" is worth seeing.
pub fn filter_children(
    config: &DbConnectionConfig,
    node: &DbNodeRef,
    mut nodes: Vec<DbNode>,
) -> Vec<DbNode> {
    if node.kind == DbNodeKind::Database && !config.visible_schemas.is_empty() {
        nodes.retain(|child| {
            config.visible_schemas.iter().any(|name| name.eq_ignore_ascii_case(&child.name))
        });
    }
    let named = matches!(
        node.kind,
        DbNodeKind::TableFolder
            | DbNodeKind::ViewFolder
            | DbNodeKind::RoutineFolder
            | DbNodeKind::SequenceFolder
    );
    if named && !config.object_filter.is_empty() {
        let needle = config.object_filter.to_lowercase();
        nodes.retain(|child| child.name.to_lowercase().contains(&needle));
    }
    nodes
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The parts of a run that aren't the statement itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbExecContext {
    /// Which database/namespace the console is pointed at, when it isn't the connection's own.
    pub database: Option<String>,
    /// The default schema for unqualified names (`search_path`, `USE`, no-op on Mongo).
    pub schema: Option<String>,
    /// Rows to fetch before calling the result truncated. 0 means no limit — which is a real
    /// choice for an export, and a bad one for a console.
    pub max_rows: u32,
}

impl DbExecContext {
    pub fn limit(&self) -> Option<usize> {
        if self.max_rows == 0 {
            None
        } else {
            Some(self.max_rows as usize)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbTableDataRequest {
    pub node: DbNodeRef,
    pub offset: u32,
    pub limit: u32,
    pub order_by: Option<String>,
    pub descending: bool,
    /// A `WHERE` fragment (SQL) or a filter document (Mongo), exactly as typed. Interpolating it
    /// is the point — this is a database client, and the user is entitled to write predicates.
    #[serde(default)]
    pub filter: String,
}

/// One column of this table, and the column it points at.
///
/// Per *column* rather than per constraint, because the question the grid asks is "I am standing on
/// this cell — where does it lead?". A composite foreign key answers that question once per column;
/// following any one of them lands on the right row, since the others are constrained to match.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbForeignKey {
    /// The column in the table being viewed.
    pub column: String,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_column: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbRowEditKind {
    Insert,
    Update,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbCell {
    pub column: String,
    /// `None` is NULL. A literal empty string is `Some("")`, and the two are not interchangeable —
    /// which is why this isn't a bare `String`.
    pub value: Option<String>,
    /// The column's type as introspection reported it, so the driver can cast the text back
    /// (`$1::numeric`) instead of guessing from the characters.
    #[serde(default)]
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbRowEdit {
    pub kind: DbRowEditKind,
    /// Columns being written. Empty for a delete.
    #[serde(default)]
    pub values: Vec<DbCell>,
    /// How to find the row again: the primary key when there is one, otherwise every original
    /// value of the row. Empty for an insert.
    #[serde(default)]
    pub keys: Vec<DbCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbEditResult {
    pub applied: u32,
    /// Every statement that ran, in order. Shown back to the user because a data editor that
    /// silently generates DML is a data editor you cannot trust.
    pub statements: Vec<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// A live connection to one database.
pub enum Session {
    Postgres(postgres::PgSession),
    Mssql(mssql::MssqlSession),
    Mongo(mongo::MongoSession),
    Iris(iris::IrisSession),
}

impl Session {
    /// Opens a connection. `database` overrides the config's own — that is how the explorer walks
    /// a server with several databases on it.
    ///
    /// Two things happen around the driver's own connect: the SSH tunnel is raised first and the
    /// config re-pointed at its local end, so no driver has to know tunnelling exists; and the
    /// startup script runs last, so a session is only ever handed out already set up.
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let tunnelled;
        let config = if config.ssh_enabled {
            // A URL names the real host and port, and every driver here prefers it over the
            // fields — so a tunnelled connection defined by URL would quietly connect *around* the
            // tunnel, to a host that is usually unreachable and occasionally the wrong one. Silently
            // dropping the URL is worse still: it carries the credentials. So this is refused.
            if !config.url.trim().is_empty() {
                return Err("A connection through an SSH tunnel has to be defined by fields, not \
                            by a URL: the URL names the host to connect to directly, which is what \
                            the tunnel exists to avoid. Switch to Fields on the General tab, or \
                            turn the tunnel off."
                    .to_string());
            }
            let tunnel = tunnel::open(config).await?;
            let mut through = config.clone();
            through.host = "127.0.0.1".to_string();
            through.port = tunnel.local_port;
            tunnelled = through;
            &tunnelled
        } else {
            config
        };

        let session = match config.kind {
            DbKind::Postgres | DbKind::Supabase => postgres::PgSession::open(config, database)
                .await
                .map(Session::Postgres),
            DbKind::Sqlserver => mssql::MssqlSession::open(config, database)
                .await
                .map(Session::Mssql),
            DbKind::Mongodb => mongo::MongoSession::open(config, database)
                .await
                .map(Session::Mongo),
            DbKind::Iris => iris::IrisSession::open(config, database)
                .await
                .map(Session::Iris),
        }?;
        session.run_startup_script(config).await?;
        Ok(session)
    }

    /// Runs the connection's startup script, if it has one.
    ///
    /// A failure fails the *connection*, rather than being reported and moved past. The script's
    /// whole purpose is to put the session into a state the rest of the work assumes — a
    /// `search_path`, a role, a timezone — so a session that didn't get it is not a working session
    /// with a warning attached, it is a session that will answer later questions wrongly.
    async fn run_startup_script(&self, config: &DbConnectionConfig) -> Result<(), String> {
        if config.startup_script.trim().is_empty() {
            return Ok(());
        }
        let ctx = DbExecContext { database: None, schema: None, max_rows: 1 };
        let result = self.execute(&config.startup_script, &ctx).await?;
        let failed = result
            .results
            .iter()
            .find_map(|statement| statement.error.as_ref().map(|error| (statement, error)));
        if let Some((statement, error)) = failed {
            return Err(format!(
                "This connection's startup script failed, so the connection was not opened.\n\n{}\n\n{error}",
                statement.statement.trim()
            ));
        }
        Ok(())
    }

    /// The cheapest statement that proves the connection still works, for the keep-alive sweep.
    async fn ping(&self) -> Result<(), String> {
        let ctx = DbExecContext { database: None, schema: None, max_rows: 1 };
        match self {
            // `{ ping: 1 }` is the command Mongo's own drivers use for exactly this.
            Session::Mongo(_) => self.execute("{ \"ping\": 1 }", &ctx).await.map(|_| ()),
            _ => self.execute("SELECT 1", &ctx).await.map(|_| ()),
        }
    }

    pub fn info(&self) -> DbServerInfo {
        match self {
            Session::Postgres(s) => s.info(),
            Session::Mssql(s) => s.info(),
            Session::Mongo(s) => s.info(),
            Session::Iris(s) => s.info(),
        }
    }

    /// False once the connection is unusable, so the registry replaces it instead of handing back
    /// a client whose every call will fail.
    ///
    /// Postgres answers from its connection task's flag, and IRIS from whether the JVM carrying its
    /// JDBC driver is still running. The other two find out by trying.
    pub fn is_alive(&self) -> bool {
        match self {
            Session::Postgres(s) => s.is_alive(),
            Session::Iris(s) => s.is_alive(),
            _ => true,
        }
    }

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match self {
            Session::Postgres(s) => s.children(node).await,
            Session::Mssql(s) => s.children(node).await,
            Session::Mongo(s) => s.children(node).await,
            Session::Iris(s) => s.children(node).await,
        }
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        match self {
            Session::Postgres(s) => s.execute(sql, ctx).await,
            Session::Mssql(s) => s.execute(sql, ctx).await,
            Session::Mongo(s) => s.execute(sql, ctx).await,
            Session::Iris(s) => s.execute(sql, ctx).await,
        }
    }

    pub async fn table_data(
        &self,
        request: &DbTableDataRequest,
    ) -> Result<DbStatementResult, String> {
        match self {
            Session::Postgres(s) => s.table_data(request).await,
            Session::Mssql(s) => s.table_data(request).await,
            Session::Mongo(s) => s.table_data(request).await,
            Session::Iris(s) => s.table_data(request).await,
        }
    }

    /// This table's foreign keys, for the grid to follow. Empty is a real answer — a table without
    /// them, or an engine with no such concept — and never an error: no column of this table leads
    /// anywhere is exactly what the grid needs to know.
    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        match self {
            Session::Postgres(s) => s.foreign_keys(node).await,
            Session::Mssql(s) => s.foreign_keys(node).await,
            // Mongo has no foreign keys to read: a reference between collections is a convention
            // held by the application, and guessing at one would send the user to a wrong document.
            Session::Mongo(_) => Ok(Vec::new()),
            Session::Iris(s) => s.foreign_keys(node).await,
        }
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        match self {
            Session::Postgres(s) => s.row_count(node, filter).await,
            Session::Mssql(s) => s.row_count(node, filter).await,
            Session::Mongo(s) => s.row_count(node, filter).await,
            Session::Iris(s) => s.row_count(node, filter).await,
        }
    }

    pub async fn apply_edits(
        &self,
        node: &DbNodeRef,
        edits: &[DbRowEdit],
    ) -> Result<DbEditResult, String> {
        match self {
            Session::Postgres(s) => s.apply_edits(node, edits).await,
            Session::Mssql(s) => s.apply_edits(node, edits).await,
            Session::Mongo(s) => s.apply_edits(node, edits).await,
            Session::Iris(s) => s.apply_edits(node, edits).await,
        }
    }

    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        match self {
            Session::Postgres(s) => s.object_ddl(node).await,
            Session::Mssql(s) => s.object_ddl(node).await,
            Session::Mongo(s) => s.object_ddl(node).await,
            Session::Iris(s) => s.object_ddl(node).await,
        }
    }

    pub async fn explain(&self, sql: &str, ctx: &DbExecContext) -> Result<String, String> {
        match self {
            Session::Postgres(s) => s.explain(sql, ctx).await,
            Session::Mssql(s) => s.explain(sql, ctx).await,
            Session::Mongo(s) => s.explain(sql, ctx).await,
            Session::Iris(s) => s.explain(sql, ctx).await,
        }
    }

    /// Asks the *server* to abandon the running statement.
    ///
    /// Two engines can. Postgres opens a second connection and sends `CancelRequest`; IRIS calls
    /// `Statement.cancel()` on the JDBC statement, which the driver turns into the same request on
    /// its own control channel. Either way the query stops server-side and its transaction rolls
    /// back. For the other two, cancelling only drops our end of the call — see [`DbRegistry::run`]
    /// for what that means.
    pub async fn cancel_running(&self) {
        match self {
            Session::Postgres(s) => s.cancel_running().await,
            Session::Iris(s) => s.cancel_running().await,
            _ => {}
        }
    }

    /// Whether abandoning a call leaves the connection unusable. TDS interleaves a result set with
    /// the request stream, so a query dropped mid-flight leaves unread tokens that the next
    /// statement would misread as its own answer — the session has to go.
    pub fn poisoned_by_cancel(&self) -> bool {
        matches!(self, Session::Mssql(_))
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Live sessions, keyed by connection *and* database: Postgres can't switch database on an open
/// connection, so "expand another database" genuinely is another connection. The other engines
/// could share one, and don't, because a per-database key also means one slow database can't hold
/// up the explorer for the rest.
fn session_key(connection_id: &str, database: Option<&str>) -> String {
    match database.filter(|d| !d.is_empty()) {
        Some(db) => format!("{connection_id}#{db}"),
        None => connection_id.to_string(),
    }
}

/// One open session, plus what the idle sweep needs to know about it.
struct Live {
    session: Arc<Session>,
    connection_id: String,
    /// Milliseconds since process start, at the last time this session was handed to a caller.
    /// Monotonic and atomic, so the sweep can read it without taking the map's lock.
    last_used: std::sync::atomic::AtomicU64,
    /// Zero means off, for both.
    keep_alive: std::time::Duration,
    auto_disconnect: std::time::Duration,
}

type Sessions = Arc<Mutex<HashMap<String, Arc<Live>>>>;

/// How often the idle sweep runs. Coarse on purpose: both settings it serves are measured in tens
/// of seconds, and a sweep is a lock and some arithmetic per open session.
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Default)]
pub struct DbRegistry {
    sessions: Sessions,
    /// `run_id` → the switch that stops it. A `oneshot` rather than a flag so the waiting side is
    /// a future `select!` can race, the same shape `ApiRegistry` uses for an in-flight send.
    cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Whether the idle sweep has been started. Started on the first session rather than at
    /// construction, because the registry is built before there is a Tokio runtime to spawn into.
    sweeping: std::sync::atomic::AtomicBool,
}

/// Milliseconds since the first call. Monotonic — unlike the wall clock, which a machine waking
/// from sleep or an NTP correction can move backwards, and which would then make a session look
/// like it was used in the future.
fn now_millis() -> u64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

impl DbRegistry {
    /// The session for this connection/database, opening one if there isn't a usable one already.
    ///
    /// Two callers racing here both open a connection and the later one wins the map; the loser is
    /// closed when its `Arc` drops. Worth the simplicity — the alternative is holding a lock across
    /// a network connect, which would stall every other database in the workspace behind it.
    pub async fn session(
        &self,
        config: &DbConnectionConfig,
        database: Option<&str>,
    ) -> Result<Arc<Session>, String> {
        self.ensure_sweeper();
        let key = session_key(&config.id, database);
        if let Some(existing) = self.lookup(&key) {
            if existing.session.is_alive() {
                existing.last_used.store(now_millis(), std::sync::atomic::Ordering::Relaxed);
                return Ok(existing.session.clone());
            }
            self.forget(&key);
        }
        let session = Arc::new(Session::open(config, database).await?);
        let live = Arc::new(Live {
            session: session.clone(),
            connection_id: config.id.clone(),
            last_used: std::sync::atomic::AtomicU64::new(now_millis()),
            keep_alive: std::time::Duration::from_secs(config.keep_alive_secs as u64),
            auto_disconnect: std::time::Duration::from_secs(config.auto_disconnect_secs as u64),
        });
        if let Ok(mut map) = self.sessions.lock() {
            map.insert(key, live);
        }
        Ok(session)
    }

    /// Starts the idle sweep, once. See [`sweep`] for what it does.
    fn ensure_sweeper(&self) {
        if self.sweeping.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(SWEEP_INTERVAL).await;
                sweep(&sessions).await;
            }
        });
    }

    fn lookup(&self, key: &str) -> Option<Arc<Live>> {
        self.sessions.lock().ok()?.get(key).cloned()
    }

    fn forget(&self, key: &str) {
        if let Ok(mut map) = self.sessions.lock() {
            map.remove(key);
        }
    }

    /// Closes every session of a connection — both the bare key and the per-database ones — and the
    /// SSH tunnel they shared, which has nothing left to carry.
    pub fn disconnect(&self, connection_id: &str) {
        tunnel::close(connection_id);
        let prefix = format!("{connection_id}#");
        if let Ok(mut map) = self.sessions.lock() {
            map.retain(|key, _| key != connection_id && !key.starts_with(&prefix));
        }
    }

    /// Which connections currently hold at least one open session. Drives the dot next to a
    /// connection in the explorer.
    pub fn connected(&self) -> Vec<String> {
        let Ok(map) = self.sessions.lock() else {
            return Vec::new();
        };
        let mut ids: Vec<String> = map
            .keys()
            .map(|key| key.split('#').next().unwrap_or(key).to_string())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Runs one cancellable operation.
    ///
    /// On cancel the server is asked to stop (Postgres only) and the local future is dropped. When
    /// dropping it would leave the protocol mid-stream — TDS — the session is discarded too, so
    /// the next statement reconnects rather than reading the abandoned rows as its own result.
    pub async fn run<T, F>(
        &self,
        run_id: &str,
        session: &Arc<Session>,
        key: &str,
        operation: F,
    ) -> Result<T, String>
    where
        F: Future<Output = Result<T, String>>,
    {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(run_id.to_string(), tx);
        }
        let outcome = tokio::select! {
            result = operation => result,
            _ = rx => {
                session.cancel_running().await;
                if session.poisoned_by_cancel() {
                    self.forget(key);
                }
                Err(CANCELLED.to_string())
            }
        };
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(run_id);
        }
        outcome
    }

    /// Stops a run. Unknown ids are fine: a cancel legitimately races a query that just finished.
    pub fn cancel(&self, run_id: &str) {
        let sender = self.cancels.lock().ok().and_then(|mut map| map.remove(run_id));
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }

    pub fn session_key(connection_id: &str, database: Option<&str>) -> String {
        session_key(connection_id, database)
    }
}

/// One pass of the idle sweep: close what has gone quiet for too long, and poke what would
/// otherwise be closed *for* us.
///
/// The two settings pull opposite ways and both are legitimate, so a session can have either, and
/// auto-disconnect wins when it somehow has both — the connection the user asked to be let go of is
/// not one to keep alive.
///
/// **A session in use is never dropped.** `Arc::strong_count == 1` means nobody but this map holds
/// it; a query in flight holds a second `Arc` from [`DbRegistry::session`], so the sweep skips it
/// however idle the clock says it is. Without that check a long-running query would have the
/// session closed out from under it at exactly the moment it looked idlest.
async fn sweep(sessions: &Sessions) {
    use std::sync::atomic::Ordering;

    let now = now_millis();
    let mut expired: Vec<(String, String)> = Vec::new();
    let mut due: Vec<Arc<Live>> = Vec::new();

    if let Ok(map) = sessions.lock() {
        for (key, live) in map.iter() {
            let idle = now.saturating_sub(live.last_used.load(Ordering::Relaxed));
            let past = |limit: std::time::Duration| {
                !limit.is_zero() && idle >= limit.as_millis() as u64
            };
            if past(live.auto_disconnect) && Arc::strong_count(&live.session) == 1 {
                expired.push((key.clone(), live.connection_id.clone()));
            } else if past(live.keep_alive) {
                due.push(live.clone());
            }
        }
    }

    if !expired.is_empty() {
        let mut orphaned: Vec<String> = Vec::new();
        if let Ok(mut map) = sessions.lock() {
            for (key, connection_id) in &expired {
                map.remove(key);
                // The tunnel belongs to the connection, not to one of its sessions, so it only goes
                // when the last of them has.
                let prefix = format!("{connection_id}#");
                let still_open = map
                    .keys()
                    .any(|other| other == connection_id || other.starts_with(&prefix));
                if !still_open {
                    orphaned.push(connection_id.clone());
                }
            }
        }
        for connection_id in orphaned {
            tunnel::close(&connection_id);
        }
    }

    for live in due {
        // Stamped before the ping rather than after: a ping that is slow — which is exactly what
        // happens on the flaky link this feature exists for — must not make the next sweep think
        // the session went idle again and send a second one.
        live.last_used.store(now_millis(), Ordering::Relaxed);
        let _ = live.session.ping().await;
    }
}

/// The one error string the frontend matches on, to show "cancelled" instead of a red failure.
pub const CANCELLED: &str = "Query cancelled";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Splits a console buffer into statements on `;`, ignoring the ones inside a string literal, a
/// quoted identifier, a line comment or a block comment.
///
/// Not a parser — a scanner with five states. It gets `';'` and `-- ;` right, which is what
/// actually appears in a console; what it cannot know about is a dialect's own statement
/// terminator (`GO`, `$$`), so `$$`-quoted bodies are handled explicitly for Postgres and `GO` is
/// left to the engine that understands it.
pub fn split_statements(sql: &str, dialect: Option<SqlDialect>) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    // Postgres function bodies are wrapped in a `$tag$ … $tag$` literal that can hold anything,
    // semicolons included. While inside one, nothing else is looked at.
    let mut dollar_tag: Option<String> = None;

    while i < chars.len() {
        let c = chars[i];

        if let Some(tag) = &dollar_tag {
            if chars[i..].starts_with(&tag.chars().collect::<Vec<_>>()[..]) {
                current.push_str(tag);
                i += tag.chars().count();
                dollar_tag = None;
                continue;
            }
            current.push(c);
            i += 1;
            continue;
        }

        match c {
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < chars.len() && chars[i] != '\n' {
                    current.push(chars[i]);
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                current.push('/');
                current.push('*');
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    current.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    current.push('*');
                    current.push('/');
                    i += 2;
                }
            }
            '\'' | '"' | '`' | '[' => {
                let close = match c {
                    '[' => ']',
                    other => other,
                };
                current.push(c);
                i += 1;
                while i < chars.len() {
                    let ch = chars[i];
                    current.push(ch);
                    i += 1;
                    if ch == close {
                        // Doubling is how every dialect here escapes the closer inside a literal.
                        if chars.get(i) == Some(&close) {
                            current.push(close);
                            i += 1;
                            continue;
                        }
                        break;
                    }
                }
            }
            '$' if dialect == Some(SqlDialect::Postgres) => {
                let mut tag = String::from("$");
                let mut j = i + 1;
                while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                    tag.push(chars[j]);
                    j += 1;
                }
                if chars.get(j) == Some(&'$') {
                    tag.push('$');
                    current.push_str(&tag);
                    i = j + 1;
                    dollar_tag = Some(tag);
                } else {
                    current.push(c);
                    i += 1;
                }
            }
            ';' => {
                i += 1;
                if !current.trim().is_empty() {
                    out.push(current.trim().to_string());
                }
                current.clear();
            }
            _ => {
                current.push(c);
                i += 1;
            }
        }
    }

    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// Rewrites a driver failure into the sentence the API client's transports already use for the
/// same conditions, so an unreachable host reads the same whether it was an HTTP request or a
/// database connection.
pub fn describe_db_error(config: &DbConnectionConfig, context: &str, raw: &str) -> String {
    let host = config.host.clone();
    let port = Some(config.effective_port());
    match crate::api::explain_cause(&host, port, raw) {
        Some(explained) => format!("{context} — {explained}"),
        None => format!("{context}: {raw}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statements_split_on_semicolons_outside_literals() {
        let sql = "SELECT ';' AS a; -- not a split;\nUPDATE t SET s = 'a;b' WHERE id = 1;";
        let parts = split_statements(sql, Some(SqlDialect::Postgres));
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert!(parts[0].contains("';'"));
        assert!(parts[1].contains("'a;b'"));
    }

    /// A function body is one statement however many semicolons it contains — splitting it would
    /// send Postgres four fragments none of which parse.
    #[test]
    fn dollar_quoted_bodies_stay_whole() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN x; y; RETURN 1; END $$ LANGUAGE plpgsql;";
        assert_eq!(split_statements(sql, Some(SqlDialect::Postgres)).len(), 1);
    }

    #[test]
    fn bracketed_identifiers_are_a_literal_in_tsql() {
        let parts = split_statements("SELECT * FROM [a;b]; SELECT 1", Some(SqlDialect::TSql));
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert!(parts[0].contains("[a;b]"));
    }

    fn db_node(name: &str) -> DbNode {
        DbNode {
            id: format!("db:{name}"),
            kind: DbNodeKind::Database,
            name: name.to_string(),
            detail: String::new(),
            database: Some(name.to_string()),
            schema: None,
            table: None,
            has_children: true,
            column: None,
        }
    }

    #[test]
    fn the_root_narrows_to_the_connected_database() {
        let roots = || vec![db_node("SAP"), db_node("USER"), db_node("%SYS")];

        let scoped = scope_to_current_database(roots(), "SAP");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].name, "SAP");

        // IRIS answers `%SYS.Namespace_List()` in upper case however the connection spelled it.
        assert_eq!(scope_to_current_database(roots(), "sap").len(), 1);

        // Nothing to narrow to: a whole tree beats an empty one.
        assert_eq!(scope_to_current_database(roots(), "").len(), 3);
        assert_eq!(scope_to_current_database(roots(), "nowhere").len(), 3);
    }

    fn config_for_tests() -> DbConnectionConfig {
        DbConnectionConfig {
            id: "c".into(),
            kind: DbKind::Postgres,
            host: "localhost".into(),
            port: 0,
            database: "app".into(),
            user: "postgres".into(),
            password: String::new(),
            url: String::new(),
            ssl: DbSslMode::Disable,
            options: Vec::new(),
            read_only: false,
            connect_timeout_ms: 0,
            show_all_databases: false,
            visible_schemas: Vec::new(),
            object_filter: String::new(),
            keep_alive_secs: 0,
            auto_disconnect_secs: 0,
            startup_script: String::new(),
            ssl_ca_file: String::new(),
            ssl_cert_file: String::new(),
            ssl_key_file: String::new(),
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_user: String::new(),
            ssh_key_file: String::new(),
        }
    }

    fn schema_node(name: &str) -> DbNode {
        DbNode {
            id: format!("schema:{name}"),
            kind: DbNodeKind::Schema,
            name: name.to_string(),
            detail: String::new(),
            database: Some("app".into()),
            schema: Some(name.to_string()),
            table: None,
            has_children: true,
            column: None,
        }
    }

    fn table_node(name: &str) -> DbNode {
        DbNode { kind: DbNodeKind::Table, ..schema_node(name) }
    }

    #[test]
    fn the_tree_lists_only_the_schemas_that_were_asked_for() {
        let db = DbNodeRef {
            kind: DbNodeKind::Database,
            database: Some("app".into()),
            schema: None,
            name: None,
        };
        let schemas = || vec![schema_node("public"), schema_node("audit"), schema_node("SAP")];
        let mut config = config_for_tests();

        // Nobody set a filter, so nothing is one.
        assert_eq!(filter_children(&config, &db, schemas()).len(), 3);

        config.visible_schemas = vec!["public".into(), "sap".into()];
        let kept = filter_children(&config, &db, schemas());
        assert_eq!(kept.len(), 2, "{kept:?}");
        assert!(kept.iter().any(|node| node.name == "SAP"), "case must not decide this");

        // A name this database doesn't have empties the level rather than being ignored: the user
        // typed it, and silently showing everything would hide the typo.
        config.visible_schemas = vec!["nowhere".into()];
        assert!(filter_children(&config, &db, schemas()).is_empty());
    }

    #[test]
    fn the_name_filter_applies_to_relations_and_not_to_schemas() {
        let folder = DbNodeRef {
            kind: DbNodeKind::TableFolder,
            database: Some("app".into()),
            schema: Some("public".into()),
            name: None,
        };
        let db = DbNodeRef { kind: DbNodeKind::Database, ..folder.clone() };
        let mut config = config_for_tests();
        config.object_filter = "invoice".into();

        let tables = vec![table_node("invoice_line"), table_node("Invoices"), table_node("orders")];
        let kept = filter_children(&config, &folder, tables);
        assert_eq!(kept.len(), 2, "{kept:?}");

        // A schema is not an object: narrowing table names must not also hide the schema they live
        // in, or the filter would take its own results off screen.
        let schemas = vec![schema_node("public"), schema_node("audit")];
        assert_eq!(filter_children(&config, &db, schemas).len(), 2);
    }

    /// Two databases differing only in case are two databases — the exact one wins rather than both
    /// surviving on the loose comparison.
    #[test]
    fn narrowing_prefers_an_exact_name() {
        let scoped = scope_to_current_database(vec![db_node("Sap"), db_node("sap")], "sap");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].name, "sap");
    }

    /// The read-only guard has to let a `WITH … SELECT` through: refusing it would make the flag
    /// unusable on any real analytical query.
    #[test]
    fn read_only_allows_reads_and_refuses_writes() {
        let config = DbConnectionConfig {
            id: "c".into(),
            kind: DbKind::Postgres,
            host: "localhost".into(),
            port: 0,
            database: "app".into(),
            user: "postgres".into(),
            password: String::new(),
            url: String::new(),
            ssl: DbSslMode::Disable,
            options: Vec::new(),
            read_only: true,
            connect_timeout_ms: 0,
            show_all_databases: false,
            visible_schemas: Vec::new(),
            object_filter: String::new(),
            keep_alive_secs: 0,
            auto_disconnect_secs: 0,
            startup_script: String::new(),
            ssl_ca_file: String::new(),
            ssl_cert_file: String::new(),
            ssl_key_file: String::new(),
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_user: String::new(),
            ssh_key_file: String::new(),
        };
        let guard = |sql: &str| read_only_guard(sql, config.read_only);
        assert!(guard("WITH x AS (SELECT 1) SELECT * FROM x").is_ok());
        assert!(guard("  select 1").is_ok());
        let refused = guard("DELETE FROM users").unwrap_err();
        assert!(refused.contains("read-only"), "{refused}");
        assert!(guard("DROP TABLE users").is_err());
    }
}
