//! MySQL and MariaDB, over `mysql_async`.
//!
//! One driver for both: they share the wire protocol, the catalog (`information_schema`) and the
//! dialect. Where they differ it is in what the server can do rather than in how to talk to it —
//! MariaDB has sequences and cannot `EXPLAIN FORMAT=TREE` — and those differences are read from the
//! server's own version string, not from which of the two the user picked, because people connect
//! to MariaDB as "MySQL" all the time and the driver should still do the right thing.
//!
//! The choices that matter, against the other SQL drivers:
//!
//! - **The text protocol, always.** Every statement goes through `query_iter` (`COM_QUERY`), whose
//!   rows arrive as the server's own text — the same invariant the Postgres driver gets from the
//!   simple query protocol, and the reason there is no decoder here to get a `DECIMAL` or a
//!   `DATETIME(6)` subtly wrong. Binary columns are the exception: their bytes are rendered as the
//!   `0x…` literal that writes them back.
//! - **Literals know about backslashes.** MySQL's default `sql_mode` makes `\` an escape character
//!   inside strings, so the session reads its `sql_mode` once and the dialect carries the answer —
//!   see `sqlgen::literal`, and the test beside it, which is the one to keep passing.
//! - **The database *is* the schema.** MySQL has one namespace level, so the tree goes connection →
//!   database → Tables/Views/Routines, and every node under a database carries its name as the
//!   schema too, which is what qualifies a table as `` `db`.`table` ``.
//! - **Cancel reaches the server.** `KILL QUERY <id>` from a second, short-lived connection stops
//!   the statement where it runs and releases its locks. The session is still discarded afterwards
//!   (`Session::poisoned_by_cancel`): the abandoned call may have left half a result on the socket.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::Queryable;
use mysql_async::{ClientIdentity, Conn, Opts, OptsBuilder, SslOpts, Value};
use tokio::sync::Mutex;

use super::postgres::{annotate_types, cell, parse_bytes};
use super::sqlgen::{self, literal, quote_ident};
use super::{
    describe_db_error, read_only_guard, read_only_refusal, split_statements, DbColumn,
    DbColumnInfo, DbConnectionConfig, DbDiagramColumn, DbDiagramEdge, DbDiagramTable,
    DbEditResult, DbExecContext, DbExecuteResult, DbForeignKey, DbKind, DbNode, DbNodeKind,
    DbNodeRef, DbObjectInfo, DbRowEdit, DbSchemaDiagram, DbServerInfo, DbSslMode,
    DbStatementResult, DbTableDataRequest, SqlDialect,
};

/// MySQL's binary character set. A column in it holds bytes, not text.
const BINARY_CHARSET: u16 = 63;

/// `VERSION()`, `CURRENT_USER()`, `DATABASE()` and `@@SESSION.sql_mode`, read once at connect.
type IdentityRow = (Option<String>, Option<String>, Option<String>, Option<String>);

pub struct MysqlSession {
    kind: DbKind,
    conn: Mutex<Conn>,
    /// Kept to open the second connection `KILL QUERY` has to come from.
    opts: Opts,
    /// The server's id for this connection — what `KILL QUERY` names.
    connection_id: u32,
    /// The database statements run against, updated when a console `USE`s another.
    database: Mutex<String>,
    user: String,
    version: String,
    mariadb: bool,
    dialect: SqlDialect,
    read_only: bool,
    alive: AtomicBool,
    notes: Vec<String>,
}

impl MysqlSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();
        let opts = connection_opts(&config, database)?;
        let conn = tokio::time::timeout(config.connect_timeout(), Conn::new(opts.clone()))
            .await
            .map_err(|_| describe_db_error(&config, "connect", "connection timed out"))?
            .map_err(|e| describe_db_error(&config, "connect", &e.to_string()))?;

        let mut conn = conn;
        let row: Option<IdentityRow> = conn
            .query_first("SELECT VERSION(), CURRENT_USER(), DATABASE(), @@SESSION.sql_mode")
            .await
            .map_err(|e| e.to_string())?;
        let (version, user, current, sql_mode) = row.unwrap_or_default();
        let version = version.unwrap_or_default();
        let sql_mode = sql_mode.unwrap_or_default().to_ascii_uppercase();
        let mariadb = version.to_ascii_lowercase().contains("mariadb");

        let mut notes = Vec::new();
        if mariadb && config.kind == DbKind::Mysql {
            notes.push("This server is MariaDB. It is handled as such whichever engine the connection names.".to_string());
        }
        if config.read_only {
            // A session whose transactions are read-only is refused writes by the server itself —
            // stronger than the keyword guard, which stays as the first line.
            if conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.is_ok() {
                notes.push("Transactions on this connection are read-only on the server.".to_string());
            }
        }
        let connection_id = conn.id();
        Ok(Self {
            kind: if mariadb { DbKind::Mariadb } else { config.kind },
            conn: Mutex::new(conn),
            opts,
            connection_id,
            database: Mutex::new(current.unwrap_or_default()),
            user: user.unwrap_or_else(|| config.user.clone()),
            version,
            mariadb,
            dialect: SqlDialect::MySql {
                backslash_escapes: !sql_mode.contains("NO_BACKSLASH_ESCAPES"),
            },
            read_only: config.read_only,
            alive: AtomicBool::new(true),
            notes,
        })
    }

    pub fn info(&self) -> DbServerInfo {
        DbServerInfo {
            kind: self.kind,
            version: self.version.clone(),
            database: self.database.try_lock().map(|db| db.clone()).unwrap_or_default(),
            user: self.user.clone(),
            notes: self.notes.clone(),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn poison(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    /// `KILL QUERY` from a connection of its own — the session's is busy running the very
    /// statement being stopped.
    pub async fn cancel_running(&self) {
        let Ok(Ok(mut killer)) = tokio::time::timeout(Duration::from_secs(5), Conn::new(self.opts.clone())).await else {
            return;
        };
        let _ = killer.query_drop(format!("KILL QUERY {}", self.connection_id)).await;
        let _ = killer.disconnect().await;
    }

    /// A failure on the socket rather than from the server means the connection is gone; the
    /// registry replaces a session that says so.
    fn note_failure(&self, error: &mysql_async::Error) {
        if matches!(error, mysql_async::Error::Io(_) | mysql_async::Error::Driver(_)) {
            self.alive.store(false, Ordering::SeqCst);
        }
    }

    // ------------------------------------------------------------------ wire

    /// Runs one statement and reads its first result set, up to `limit` rows.
    async fn statement(&self, conn: &mut Conn, sql: &str, limit: Option<usize>) -> DbStatementResult {
        let started = Instant::now();
        let mut result = DbStatementResult::empty(sql);
        match read_statement(conn, sql, limit).await {
            Ok((columns, rows, truncated, affected)) => {
                result.columns = columns;
                result.rows = rows;
                result.truncated = truncated;
                result.rows_affected = affected;
            }
            Err(error) => {
                self.note_failure(&error);
                result.error = Some(error.to_string());
            }
        }
        if result.error.is_none() && conn.get_warnings() > 0 {
            if let Ok(warnings) = conn.query::<(String, u32, String), _>("SHOW WARNINGS").await {
                result.messages = warnings
                    .into_iter()
                    .map(|(level, code, message)| format!("{level} {code}: {message}"))
                    .collect();
            }
        }
        result.duration_ms = started.elapsed().as_millis() as u64;
        result
    }

    /// Rows only, with a failure as a real error. Every catalog query goes through this.
    async fn rows(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
        let mut conn = self.conn.lock().await;
        match read_statement(&mut conn, sql, None).await {
            Ok((_, rows, _, _)) => Ok(rows),
            Err(error) => {
                self.note_failure(&error);
                Err(error.to_string())
            }
        }
    }

    async fn scalar(&self, sql: &str) -> Result<Option<String>, String> {
        Ok(self.rows(sql).await?.first().and_then(|row| row.first().cloned()).flatten())
    }

    fn quote(&self, value: &str) -> Result<String, String> {
        literal(Some(value), self.dialect)
    }

    /// Points the session at `database`, when a console asks for another one.
    async fn use_database(&self, conn: &mut Conn, database: &str) -> Result<(), String> {
        let mut current = self.database.lock().await;
        if database.is_empty() || *current == database {
            return Ok(());
        }
        conn.query_drop(format!("USE {}", quote_ident(database, self.dialect)))
            .await
            .map_err(|e| e.to_string())?;
        *current = database.to_string();
        Ok(())
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = Instant::now();
        let mut conn = self.conn.lock().await;
        // The database is the schema here, so either field of the context can name it.
        if let Some(target) = ctx.schema.as_deref().or(ctx.database.as_deref()) {
            self.use_database(&mut conn, target).await?;
        }
        let mut results = Vec::new();
        for statement in split_statements(sql, Some(self.dialect)) {
            if let Err(refused) = read_only_guard(&statement, self.read_only) {
                results.push(DbStatementResult::failed(&statement, refused));
                break;
            }
            let result = self.statement(&mut conn, &statement, ctx.limit()).await;
            // A console `USE` moves the session; remember where it went.
            if result.error.is_none() {
                if let Some(target) = used_database(&statement) {
                    *self.database.lock().await = target;
                }
            }
            let failed = result.error.is_some();
            results.push(result);
            if failed {
                break;
            }
        }
        Ok(DbExecuteResult { results, duration_ms: started.elapsed().as_millis() as u64 })
    }

    /// MySQL's own tree rendering where the server has it (8.0.16 and later), MariaDB's JSON, and the
    /// classic table as the last resort — each is the most readable plan that server will give.
    pub async fn explain(&self, sql: &str, _ctx: &DbExecContext) -> Result<String, String> {
        let statement = split_statements(sql, Some(self.dialect))
            .into_iter()
            .next()
            .ok_or_else(|| "There is no statement to explain.".to_string())?;
        let formats: &[&str] = if self.mariadb { &["FORMAT=JSON "] } else { &["FORMAT=TREE ", "FORMAT=JSON "] };
        for format in formats {
            if let Ok(rows) = self.rows(&format!("EXPLAIN {format}{statement}")).await {
                return Ok(rows.iter().filter_map(|row| row.first().cloned().flatten()).collect::<Vec<_>>().join("\n"));
            }
        }
        let mut conn = self.conn.lock().await;
        let result = self.statement(&mut conn, &format!("EXPLAIN {statement}"), None).await;
        if let Some(error) = result.error {
            return Err(error);
        }
        Ok(render_table(&result))
    }

    // ------------------------------------------------------------ introspect

    /// The database a node belongs to: its schema, which every node under a database carries, or
    /// the database node itself.
    fn database_of<'a>(&self, node: &'a DbNodeRef) -> Result<&'a str, String> {
        node.schema()
            .or(node.db())
            .ok_or_else(|| "This action needs a database to work in.".to_string())
    }

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => self.databases().await,
            // No schema level: a database holds its folders directly.
            DbNodeKind::Database | DbNodeKind::Schema => Ok(folders(self.database_of(node)?)),
            DbNodeKind::TableFolder => self.relations(node, &["BASE TABLE", "SYSTEM VERSIONED"], DbNodeKind::Table).await,
            DbNodeKind::ViewFolder => self.relations(node, &["VIEW"], DbNodeKind::View).await,
            DbNodeKind::SequenceFolder => self.relations(node, &["SEQUENCE"], DbNodeKind::Sequence).await,
            DbNodeKind::RoutineFolder => self.routines(node).await,
            DbNodeKind::Table | DbNodeKind::View => Ok(super::postgres::relation_folders(node)),
            DbNodeKind::ColumnFolder => self.columns(node).await,
            DbNodeKind::IndexFolder => self.indexes(node).await,
            DbNodeKind::KeyFolder => self.keys(node).await,
            _ => Ok(Vec::new()),
        }
    }

    async fn databases(&self) -> Result<Vec<DbNode>, String> {
        let rows = self.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME").await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("db:{name}"),
                    kind: DbNodeKind::Database,
                    name: name.clone(),
                    detail: String::new(),
                    database: Some(name.clone()),
                    schema: Some(name),
                    table: None,
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    async fn relations(&self, node: &DbNodeRef, types: &[&str], kind: DbNodeKind) -> Result<Vec<DbNode>, String> {
        let db = self.database_of(node)?.to_string();
        let types = types.iter().map(|t| self.quote(t)).collect::<Result<Vec<_>, _>>()?.join(", ");
        let rows = self
            .rows(&format!(
                "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = {} AND TABLE_TYPE IN ({types}) ORDER BY TABLE_NAME",
                self.quote(&db)?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let estimate = cell(row, 1);
                DbNode {
                    id: format!("rel:{db}:{name}"),
                    kind,
                    name: name.clone(),
                    // `TABLE_ROWS` is InnoDB's estimate, which is all a tree should show — a count
                    // per table would scan every one of them to draw a list.
                    detail: if kind == DbNodeKind::Table && !estimate.is_empty() { format!("~{estimate} rows") } else { String::new() },
                    database: Some(db.clone()),
                    schema: Some(db.clone()),
                    table: Some(name),
                    has_children: kind != DbNodeKind::Sequence,
                    column: None,
                }
            })
            .collect())
    }

    async fn routines(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let db = self.database_of(node)?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = {} ORDER BY ROUTINE_NAME",
                self.quote(&db)?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("routine:{db}:{name}"),
                    kind: DbNodeKind::Routine,
                    name: name.clone(),
                    detail: cell(row, 1).to_lowercase(),
                    database: Some(db.clone()),
                    schema: Some(db.clone()),
                    table: Some(name),
                    has_children: false,
                    column: None,
                }
            })
            .collect())
    }

    async fn columns(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let db = self.database_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, COLUMN_KEY, EXTRA \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
                 ORDER BY ORDINAL_POSITION",
                self.quote(&db)?,
                self.quote(&table)?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let data_type = cell(row, 1);
                let nullable = cell(row, 2).eq_ignore_ascii_case("YES");
                let default = row.get(3).cloned().flatten();
                let primary_key = cell(row, 5) == "PRI";
                let extra = cell(row, 6);
                let mut detail = data_type.clone();
                if primary_key {
                    detail.push_str(" · PK");
                }
                if !nullable {
                    detail.push_str(" · not null");
                }
                if !extra.is_empty() {
                    detail.push_str(&format!(" · {}", extra.to_lowercase()));
                }
                DbNode {
                    id: format!("col:{db}:{table}:{name}"),
                    kind: DbNodeKind::Column,
                    name: name.clone(),
                    detail,
                    database: Some(db.clone()),
                    schema: Some(db.clone()),
                    table: Some(table.clone()),
                    has_children: false,
                    column: Some(DbColumnInfo {
                        data_type,
                        nullable,
                        primary_key,
                        default_value: default,
                        position: cell(row, 4).parse().unwrap_or_default(),
                    }),
                }
            })
            .collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let db = self.database_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                self.quote(&db)?,
                self.quote(&table)?
            ))
            .await?;
        let mut grouped: Vec<(String, Vec<String>, bool)> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let column = cell(row, 1);
            match grouped.iter_mut().find(|(existing, _, _)| *existing == name) {
                Some((_, columns, _)) => columns.push(column),
                None => grouped.push((name, vec![column], cell(row, 2) == "0")),
            }
        }
        Ok(grouped
            .into_iter()
            .map(|(name, columns, unique)| DbNode {
                id: format!("idx:{db}:{table}:{name}"),
                kind: DbNodeKind::Index,
                name: name.clone(),
                detail: format!("{}({})", if unique { "unique " } else { "" }, columns.join(", ")),
                database: Some(db.clone()),
                schema: Some(db.clone()),
                table: Some(table.clone()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    async fn keys(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let db = self.database_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY CONSTRAINT_NAME",
                self.quote(&db)?,
                self.quote(&table)?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| DbNode {
                id: format!("key:{db}:{table}:{}", cell(row, 0)),
                kind: DbNodeKind::Key,
                name: cell(row, 0),
                detail: cell(row, 1).to_lowercase(),
                database: Some(db.clone()),
                schema: Some(db.clone()),
                table: Some(table.clone()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    /// MySQL's `KEY_COLUMN_USAGE` names the referenced column on the same row, so a foreign key is
    /// one filtered read — no join back through `REFERENTIAL_CONSTRAINTS` as the standard needs.
    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        let db = self.database_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND REFERENCED_TABLE_NAME IS NOT NULL \
                 ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
                self.quote(&db)?,
                self.quote(&table)?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| DbForeignKey {
                column: cell(row, 0),
                ref_schema: Some(cell(row, 1)),
                ref_table: cell(row, 2),
                ref_column: cell(row, 3),
            })
            .collect())
    }

    // -------------------------------------------------------------- diagram

    /// Every table, view, routine and sequence of one database, from `information_schema.TABLES`,
    /// which — unusually — has it all: the storage engine, created and updated times, bytes on disk
    /// and InnoDB's row estimate.
    pub async fn schema_objects(&self, node: &DbNodeRef) -> Result<Vec<DbObjectInfo>, String> {
        let db = self.database_of(node)?.to_string();
        let quoted = self.quote(&db)?;
        let rows = self
            .rows(&format!(
                "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, CREATE_TIME, UPDATE_TIME, \
                        DATA_LENGTH + INDEX_LENGTH, DATA_LENGTH, TABLE_ROWS, TABLE_COMMENT \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = {quoted} ORDER BY TABLE_NAME"
            ))
            .await?;
        let mut out: Vec<DbObjectInfo> = rows
            .iter()
            .map(|row| {
                let table_type = cell(row, 1);
                let kind = match table_type.as_str() {
                    "VIEW" | "SYSTEM VIEW" => DbNodeKind::View,
                    "SEQUENCE" => DbNodeKind::Sequence,
                    _ => DbNodeKind::Table,
                };
                let engine = cell(row, 2);
                DbObjectInfo {
                    name: cell(row, 0),
                    kind,
                    object_type: if engine.is_empty() { table_type } else { format!("{table_type} ({engine})") },
                    created_at: Some(cell(row, 3)).filter(|v| !v.is_empty()),
                    modified_at: Some(cell(row, 4)).filter(|v| !v.is_empty()),
                    total_bytes: parse_bytes(&cell(row, 5)),
                    used_bytes: parse_bytes(&cell(row, 6)),
                    rows: parse_bytes(&cell(row, 7)),
                    comment: cell(row, 8),
                }
            })
            .collect();
        let routines = self
            .rows(&format!(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE, CREATED, LAST_ALTERED, ROUTINE_COMMENT \
                 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = {quoted} ORDER BY ROUTINE_NAME"
            ))
            .await
            .unwrap_or_default();
        out.extend(routines.iter().map(|row| DbObjectInfo {
            name: cell(row, 0),
            kind: DbNodeKind::Routine,
            object_type: cell(row, 1),
            created_at: Some(cell(row, 2)).filter(|v| !v.is_empty()),
            modified_at: Some(cell(row, 3)).filter(|v| !v.is_empty()),
            total_bytes: None,
            used_bytes: None,
            rows: None,
            comment: cell(row, 4),
        }));
        Ok(out)
    }

    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let db = self.database_of(node)?.to_string();
        let quoted = self.quote(&db)?;
        let rows = self
            .rows(&format!(
                "SELECT c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY, t.TABLE_ROWS \
                 FROM information_schema.COLUMNS c \
                 JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
                 WHERE c.TABLE_SCHEMA = {quoted} AND t.TABLE_TYPE <> 'SEQUENCE' \
                 ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
            ))
            .await?;
        let mut tables: Vec<DbDiagramTable> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let table = match tables.last_mut() {
                Some(last) if last.name == name => last,
                _ => {
                    let view = cell(row, 1).contains("VIEW");
                    tables.push(DbDiagramTable {
                        schema: Some(db.clone()),
                        name: name.clone(),
                        kind: if view { DbNodeKind::View } else { DbNodeKind::Table },
                        columns: Vec::new(),
                        row_estimate: if view { None } else { parse_bytes(&cell(row, 6)) },
                    });
                    tables.last_mut().expect("just pushed")
                }
            };
            table.columns.push(DbDiagramColumn {
                name: cell(row, 2),
                data_type: cell(row, 3),
                nullable: cell(row, 4).eq_ignore_ascii_case("YES"),
                primary_key: cell(row, 5) == "PRI",
                foreign_key: false,
            });
        }
        let edges = self
            .rows(&format!(
                "SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, \
                        REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = {quoted} AND REFERENCED_TABLE_NAME IS NOT NULL \
                 ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"
            ))
            .await?
            .iter()
            .map(|row| DbDiagramEdge {
                constraint: cell(row, 0),
                from_schema: Some(db.clone()),
                from_table: cell(row, 1),
                from_column: cell(row, 2),
                to_schema: Some(cell(row, 3)),
                to_table: cell(row, 4),
                to_column: cell(row, 5),
                inferred: false,
            })
            .collect();
        Ok(DbSchemaDiagram {
            database: Some(db.clone()),
            schema: Some(db),
            tables,
            edges,
            notes: Vec::new(),
        })
    }

    // ----------------------------------------------------------------- data

    pub async fn table_data(&self, request: &DbTableDataRequest) -> Result<DbStatementResult, String> {
        let node = self.qualified(&request.node)?;
        let sql = sqlgen::select_page(&node, self.dialect, &request.filter, &request.sort, request.offset, request.limit)?;
        let mut conn = self.conn.lock().await;
        let mut result = self.statement(&mut conn, &sql, Some(request.limit as usize)).await;
        drop(conn);
        if let Some(error) = result.error.take() {
            return Err(error);
        }
        // `varchar(255)` and `int unsigned` from the catalog, where the result set only knows the
        // wire type.
        if let Ok(columns) = self.columns(&node).await {
            annotate_types(&mut result, &columns);
        }
        Ok(result)
    }

    /// The node with its database as the schema, so `sqlgen` qualifies it as `` `db`.`table` ``.
    fn qualified(&self, node: &DbNodeRef) -> Result<DbNodeRef, String> {
        let mut node = node.clone();
        node.schema = Some(self.database_of(&node)?.to_string());
        Ok(node)
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        let sql = sqlgen::count_rows(&self.qualified(node)?, self.dialect, filter)?;
        Ok(self.scalar(&sql).await?.and_then(|value| value.parse().ok()).unwrap_or_default())
    }

    /// Applies the grid's edits as one transaction.
    pub async fn apply_edits(&self, node: &DbNodeRef, edits: &[DbRowEdit]) -> Result<DbEditResult, String> {
        if self.read_only {
            return Err(read_only_refusal());
        }
        let node = self.qualified(node)?;
        let statements = edits
            .iter()
            .map(|edit| sqlgen::edit_statement(&node, self.dialect, edit))
            .collect::<Result<Vec<String>, String>>()?;
        let mut conn = self.conn.lock().await;
        if let Err(e) = conn.query_drop("START TRANSACTION").await {
            self.note_failure(&e);
            return Ok(DbEditResult { applied: 0, statements, error: Some(e.to_string()) });
        }
        let mut applied = 0u32;
        for statement in &statements {
            if let Err(e) = conn.query_drop(statement).await {
                self.note_failure(&e);
                let _ = conn.query_drop("ROLLBACK").await;
                return Ok(DbEditResult { applied: 0, statements: statements.clone(), error: Some(format!("{e}\n\n{statement}")) });
            }
            applied += 1;
        }
        if let Err(e) = conn.query_drop("COMMIT").await {
            self.note_failure(&e);
            let _ = conn.query_drop("ROLLBACK").await;
            return Ok(DbEditResult { applied: 0, statements, error: Some(e.to_string()) });
        }
        Ok(DbEditResult { applied, statements, error: None })
    }

    /// The server's own `CREATE` statement — `SHOW CREATE` has one for every kind of object.
    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        let db = self.database_of(node)?.to_string();
        let name = node.name()?;
        let target = format!("{}.{}", quote_ident(&db, self.dialect), quote_ident(name, self.dialect));
        let (statement, column) = match node.kind {
            DbNodeKind::View => (format!("SHOW CREATE VIEW {target}"), 1),
            DbNodeKind::Sequence => (format!("SHOW CREATE SEQUENCE {target}"), 1),
            DbNodeKind::Routine => {
                let kind = self
                    .scalar(&format!(
                        "SELECT ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = {} AND ROUTINE_NAME = {}",
                        self.quote(&db)?,
                        self.quote(name)?
                    ))
                    .await?
                    .unwrap_or_else(|| "PROCEDURE".to_string());
                (format!("SHOW CREATE {} {target}", kind.to_uppercase()), 2)
            }
            _ => (format!("SHOW CREATE TABLE {target}"), 1),
        };
        let rows = self.rows(&statement).await?;
        let ddl = rows
            .first()
            .and_then(|row| row.get(column).cloned().flatten())
            .ok_or_else(|| format!("The server returned no definition for {name}."))?;
        Ok(format!("{};", ddl.trim_end_matches(';')))
    }
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

type ReadOutcome = (Vec<DbColumn>, Vec<Vec<Option<String>>>, bool, Option<i64>);

/// One statement through the text protocol: its first result set (up to `limit` rows), or the
/// affected-row count when it has none. Every later row and result set is read and dropped, so the
/// connection is left clean for the next statement.
async fn read_statement(conn: &mut Conn, sql: &str, limit: Option<usize>) -> Result<ReadOutcome, mysql_async::Error> {
    let mut result = conn.query_iter(sql).await?;
    let columns = result.columns();
    let Some(columns) = columns.filter(|c| !c.is_empty()) else {
        let affected = result.affected_rows() as i64;
        result.drop_result().await?;
        return Ok((Vec::new(), Vec::new(), false, Some(affected)));
    };
    let described: Vec<DbColumn> = columns.iter().map(|c| DbColumn::new(c.name_str().to_string(), type_name(c))).collect();
    let binary: Vec<bool> = columns.iter().map(is_binary).collect();
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(row) = result.next().await? {
        if limit.is_some_and(|max| rows.len() >= max) {
            truncated = true;
            continue; // keep reading: the rest has to come off the socket either way
        }
        let values = (0..row.len())
            .map(|index| row.as_ref(index).and_then(|value| text_of(value, binary.get(index).copied().unwrap_or(false))))
            .collect();
        rows.push(values);
    }
    result.drop_result().await?;
    Ok((described, rows, truncated, None))
}

/// One text-protocol value as the grid's text. NULL is `None`; bytes in a binary column are the
/// `0x…` literal that writes them back.
fn text_of(value: &Value, binary: bool) -> Option<String> {
    match value {
        Value::NULL => None,
        Value::Bytes(bytes) if binary => Some(format!("0x{}", bytes.iter().map(|b| format!("{b:02X}")).collect::<String>())),
        Value::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        // The text protocol only ever sends bytes; the arms below are for completeness.
        Value::Int(n) => Some(n.to_string()),
        Value::UInt(n) => Some(n.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(f) => Some(f.to_string()),
        other => Some(other.as_sql(true).trim_matches('\'').to_string()),
    }
}

/// Whether a column holds bytes rather than text: a string-shaped type in the binary charset, or a
/// `BIT`, whose value is a raw bit string.
fn is_binary(column: &mysql_async::Column) -> bool {
    use ColumnType::*;
    match column.column_type() {
        MYSQL_TYPE_BIT | MYSQL_TYPE_GEOMETRY => true,
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB
        | MYSQL_TYPE_STRING | MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => {
            column.character_set() == BINARY_CHARSET && !column.flags().contains(ColumnFlags::ENUM_FLAG)
        }
        _ => false,
    }
}

/// The wire type as a name — replaced by the catalog's richer `COLUMN_TYPE` wherever the column
/// comes straight from one table (see `annotate_types`).
fn type_name(column: &mysql_async::Column) -> String {
    use ColumnType::*;
    let binary = column.character_set() == BINARY_CHARSET;
    let unsigned = column.flags().contains(ColumnFlags::UNSIGNED_FLAG);
    let base = match column.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            if binary { "blob" } else { "text" }
        }
        MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => {
            if binary { "varbinary" } else { "varchar" }
        }
        MYSQL_TYPE_STRING => {
            if column.flags().contains(ColumnFlags::ENUM_FLAG) {
                "enum"
            } else if column.flags().contains(ColumnFlags::SET_FLAG) {
                "set"
            } else if binary {
                "binary"
            } else {
                "char"
            }
        }
        _ => "",
    };
    if unsigned && !base.is_empty() {
        format!("{base} unsigned")
    } else {
        base.to_string()
    }
}

/// The database a successful `USE x` moved the session to.
fn used_database(statement: &str) -> Option<String> {
    let trimmed = statement.trim();
    let rest = trimmed.get(..4).filter(|head| head.eq_ignore_ascii_case("USE "))?;
    let _ = rest;
    let name = trimmed[4..].trim().trim_end_matches(';').trim();
    let name = name.trim_matches('`');
    (!name.is_empty()).then(|| name.replace("``", "`"))
}

/// A classic `EXPLAIN` table as aligned text, for servers with nothing better.
fn render_table(result: &DbStatementResult) -> String {
    let headers: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
    let rows: Vec<Vec<String>> = result
        .rows
        .iter()
        .map(|row| row.iter().map(|v| v.clone().unwrap_or_else(|| "NULL".to_string())).collect())
        .collect();
    let widths: Vec<usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| rows.iter().map(|r| r.get(i).map_or(0, |v| v.chars().count())).max().unwrap_or(0).max(h.chars().count()))
        .collect();
    let line = |cells: &[String]| {
        cells
            .iter()
            .enumerate()
            .map(|(i, v)| format!("{v:<width$}", width = widths.get(i).copied().unwrap_or(0)))
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    std::iter::once(line(&headers)).chain(rows.iter().map(|r| line(r))).collect::<Vec<_>>().join("\n")
}

/// The folders under a database — no schema level in between.
fn folders(db: &str) -> Vec<DbNode> {
    [
        (DbNodeKind::TableFolder, "Tables"),
        (DbNodeKind::ViewFolder, "Views"),
        (DbNodeKind::RoutineFolder, "Routines"),
        (DbNodeKind::SequenceFolder, "Sequences"),
    ]
    .into_iter()
    .map(|(kind, name)| DbNode {
        id: format!("folder:{db}:{name}"),
        kind,
        name: name.to_string(),
        detail: String::new(),
        database: Some(db.to_string()),
        schema: Some(db.to_string()),
        table: None,
        has_children: true,
        column: None,
    })
    .collect()
}

// ---------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------

/// The options for one connection: a pasted `mysql://` URL when there is one, the fields otherwise,
/// and the explorer's database on top of either.
fn connection_opts(config: &DbConnectionConfig, database: Option<&str>) -> Result<Opts, String> {
    let base = if config.url.trim().is_empty() {
        OptsBuilder::default()
            .ip_or_hostname(config.host.trim())
            .tcp_port(config.effective_port())
            .user(Some(config.user.clone()).filter(|u| !u.is_empty()))
            .pass(Some(config.password.clone()).filter(|p| !p.is_empty()))
            .db_name(Some(config.database.clone()).filter(|d| !d.is_empty()))
    } else {
        let url = config.url.trim().replacen("mariadb://", "mysql://", 1);
        let parsed = Opts::from_url(&url).map_err(|e| format!("The connection URL could not be read: {e}"))?;
        let mut builder = OptsBuilder::from_opts(parsed.clone());
        if parsed.pass().is_none() && !config.password.is_empty() {
            builder = builder.pass(Some(config.password.clone()));
        }
        builder
    };
    let mut builder = base
        .db_name(database.filter(|d| !d.is_empty()).map(str::to_string).or_else(|| Some(config.database.clone()).filter(|d| !d.is_empty())))
        // Prepared statements are never used — see the module note — so there is nothing to cache.
        .stmt_cache_size(0)
        .init(startup_statements(config));
    builder = builder.ssl_opts(ssl_opts(config)?);
    Ok(builder.into())
}

/// Statements every new connection runs before anything else: the connection's own startup script
/// is run by `Session::open` like every engine's, so this is only what the driver itself needs.
fn startup_statements(_config: &DbConnectionConfig) -> Vec<String> {
    Vec::new()
}

fn ssl_opts(config: &DbConnectionConfig) -> Result<Option<SslOpts>, String> {
    let mut ssl = match config.ssl {
        DbSslMode::Disable => return Ok(None),
        // Encrypt, but accept whatever certificate the server shows — what `Require` means for every
        // engine here, and what a self-signed dev server needs.
        DbSslMode::Require => SslOpts::default()
            .with_danger_accept_invalid_certs(true)
            .with_danger_skip_domain_validation(true),
        DbSslMode::VerifyFull => SslOpts::default(),
    };
    if !config.ssl_ca_file.trim().is_empty() {
        ssl = ssl.with_root_certs(vec![std::path::PathBuf::from(config.ssl_ca_file.trim()).into()]);
    }
    let (cert, key) = (config.ssl_cert_file.trim(), config.ssl_key_file.trim());
    if !cert.is_empty() && !key.is_empty() {
        ssl = ssl.with_client_identity(Some(ClientIdentity::new(
            std::path::PathBuf::from(cert).into(),
            std::path::PathBuf::from(key).into(),
        )));
    }
    Ok(Some(ssl))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_use_statement_names_where_the_session_went() {
        assert_eq!(used_database("USE shop").as_deref(), Some("shop"));
        assert_eq!(used_database("use `my db`;").as_deref(), Some("my db"));
        assert_eq!(used_database("SELECT 1"), None);
        assert_eq!(used_database("USER()"), None);
    }

    #[test]
    fn a_url_is_read_and_the_explorer_database_wins() {
        let mut config = crate::datasource::tests_support::config(DbKind::Mariadb);
        config.url = "mariadb://app:secret@db.example.com:3307/shop".into();
        let opts = connection_opts(&config, Some("reports")).unwrap();
        assert_eq!(opts.ip_or_hostname(), "db.example.com");
        assert_eq!(opts.tcp_port(), 3307);
        assert_eq!(opts.user(), Some("app"));
        assert_eq!(opts.db_name(), Some("reports"));
    }

    #[test]
    fn fields_are_used_without_a_url() {
        let mut config = crate::datasource::tests_support::config(DbKind::Mysql);
        config.user = "root".into();
        config.database = "shop".into();
        let opts = connection_opts(&config, None).unwrap();
        assert_eq!(opts.tcp_port(), 3306);
        assert_eq!(opts.db_name(), Some("shop"));
        assert!(opts.ssl_opts().is_none());
    }

    /// The whole driver against a real server. Ignored by default; run it with
    /// `CODEFLOW_TEST_MYSQL=host:port:user:password:database cargo test -p codeflow --lib
    /// datasource::mysql -- --ignored` against a disposable MySQL or MariaDB — it drops and
    /// recreates two tables in that database.
    #[tokio::test]
    #[ignore = "needs a MySQL or MariaDB server in CODEFLOW_TEST_MYSQL"]
    async fn against_a_live_server() {
        use crate::datasource::{DbCell, DbRowEditKind};
        let Ok(target) = std::env::var("CODEFLOW_TEST_MYSQL") else { return };
        let parts: Vec<&str> = target.splitn(5, ':').collect();
        let mut config = crate::datasource::tests_support::config(DbKind::Mysql);
        config.host = parts[0].into();
        config.port = parts[1].parse().unwrap();
        config.user = parts[2].into();
        config.password = parts[3].into();
        config.database = parts[4].into();
        let db = parts[4].to_string();
        let session = MysqlSession::open(&config, None).await.expect("connect");
        let ctx = DbExecContext { database: None, schema: None, max_rows: 100 };

        let setup = session
            .execute(
                "DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS customers;
                 CREATE TABLE customers (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100) NOT NULL,
                   note TEXT, flag BIT(1), avatar VARBINARY(16));
                 CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, total DECIMAL(10,2),
                   FOREIGN KEY (customer_id) REFERENCES customers(id));
                 INSERT INTO customers (name, note, flag, avatar) VALUES ('Ada', 'C:\\\\dir', b'1', 0x00FF);
                 INSERT INTO orders VALUES (1, 1, 150.25);",
                &ctx,
            )
            .await
            .unwrap();
        assert!(setup.results.iter().all(|r| r.error.is_none()), "{:?}", setup.results.iter().filter_map(|r| r.error.clone()).collect::<Vec<_>>());
        assert_eq!(setup.results.last().unwrap().rows_affected, Some(1));

        // Every value as the server's text; bytes as the literal that writes them back.
        let read = session.execute("SELECT id, name, note, flag, avatar FROM customers", &ctx).await.unwrap();
        assert_eq!(
            read.results[0].rows[0],
            vec![Some("1".into()), Some("Ada".into()), Some("C:\\dir".into()), Some("0x01".into()), Some("0x00FF".into())]
        );

        // The edit path: a backslash, a quote and an injection attempt all land as text, the bit and
        // the blob as themselves.
        let table = DbNodeRef { kind: DbNodeKind::Table, database: Some(db.clone()), schema: Some(db.clone()), name: Some("customers".into()) };
        let cell = |column: &str, value: &str, type_name: &str| DbCell { column: column.into(), value: Some(value.into()), type_name: type_name.into() };
        let hostile = "\\' OR 1=1 -- ";
        let edited = session
            .apply_edits(
                &table,
                &[DbRowEdit {
                    kind: DbRowEditKind::Update,
                    values: vec![
                        cell("name", "O'Brien \\ x", "varchar(100)"),
                        cell("note", hostile, "text"),
                        cell("flag", "0x00", "bit(1)"),
                        cell("avatar", "0x0102", "varbinary(16)"),
                    ],
                    keys: vec![cell("id", "1", "int")],
                    document: None,
                }],
            )
            .await
            .unwrap();
        assert_eq!(edited.applied, 1, "{:?} {:?}", edited.error, edited.statements);
        let back = session.execute("SELECT name, note, flag, avatar, (SELECT COUNT(*) FROM customers) FROM customers", &ctx).await.unwrap();
        assert_eq!(
            back.results[0].rows[0],
            vec![Some("O'Brien \\ x".into()), Some(hostile.into()), Some("0x00".into()), Some("0x0102".into()), Some("1".into())]
        );

        // The tree: databases, then folders straight under a database, then tables and their parts.
        let root = session.children(&DbNodeRef { kind: DbNodeKind::Root, database: None, schema: None, name: None }).await.unwrap();
        assert!(root.iter().any(|n| n.name == db));
        let folder = |kind| DbNodeRef { kind, database: Some(db.clone()), schema: Some(db.clone()), name: None };
        let folders_under = session.children(&DbNodeRef { kind: DbNodeKind::Database, database: Some(db.clone()), schema: None, name: None }).await.unwrap();
        assert_eq!(folders_under[0].kind, DbNodeKind::TableFolder);
        let tables = session.children(&folder(DbNodeKind::TableFolder)).await.unwrap();
        assert_eq!(tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["customers", "orders"]);
        let columns = session.columns(&table).await.unwrap();
        assert!(columns[0].column.as_ref().unwrap().primary_key);
        let orders = DbNodeRef { name: Some("orders".into()), ..table.clone() };
        let keys = session.foreign_keys(&orders).await.unwrap();
        assert_eq!((keys[0].column.as_str(), keys[0].ref_table.as_str(), keys[0].ref_column.as_str()), ("customer_id", "customers", "id"));
        let diagram = session.schema_diagram(&folder(DbNodeKind::Database)).await.unwrap();
        assert_eq!(diagram.edges.len(), 1);
        let objects = session.schema_objects(&folder(DbNodeKind::Database)).await.unwrap();
        assert!(objects.iter().any(|o| o.name == "orders" && o.total_bytes.is_some()));

        // Data, count, DDL and plan.
        let page = session
            .table_data(&DbTableDataRequest { node: orders.clone(), offset: 0, limit: 10, sort: vec![], filter: String::new(), options: Default::default() })
            .await
            .unwrap();
        assert_eq!(page.rows[0][2].as_deref(), Some("150.25"));
        assert_eq!(page.columns[2].type_name, "decimal(10,2)");
        assert_eq!(session.row_count(&orders, "total > 100").await.unwrap(), 1);
        let ddl = session.object_ddl(&orders).await.unwrap();
        assert!(ddl.starts_with("CREATE TABLE `orders`"), "{ddl}");
        assert!(!session.explain("SELECT * FROM orders WHERE id = 1", &ctx).await.unwrap().is_empty());

        // A procedure through DELIMITER, then called.
        let procedure = session
            .execute("DROP PROCEDURE IF EXISTS cf_count;\nDELIMITER //\nCREATE PROCEDURE cf_count() BEGIN SELECT COUNT(*) AS n FROM orders; END//\nDELIMITER ;\nCALL cf_count();", &ctx)
            .await
            .unwrap();
        assert!(procedure.results.iter().all(|r| r.error.is_none()), "{:?}", procedure.results);
        assert_eq!(procedure.results.last().unwrap().rows[0][0].as_deref(), Some("1"));

        // Cancel reaches the server: a ten-second sleep ends at once.
        let started = Instant::now();
        let sleeper = session.execute("SELECT SLEEP(10)", &ctx);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(400)).await;
            session.cancel_running().await;
        };
        let (slept, _) = tokio::join!(sleeper, cancel);
        assert!(started.elapsed() < Duration::from_secs(5), "cancel did not stop the query: {slept:?}");
    }

    #[test]
    fn an_explain_table_is_aligned() {
        let mut result = DbStatementResult::empty("EXPLAIN SELECT 1");
        result.columns = vec![DbColumn::new("id", ""), DbColumn::new("table", "")];
        result.rows = vec![vec![Some("1".into()), None]];
        assert_eq!(render_table(&result), "id  table\n1   NULL");
    }
}
