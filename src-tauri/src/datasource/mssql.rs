//! Microsoft SQL Server, over TDS via tiberius.
//!
//! Two things about TDS shape this file. It is a **single-stream protocol**: the client writes a
//! request and then must read the whole answer before writing again, which is why the client lives
//! behind a `Mutex` and why abandoning a query poisons the session (see
//! `Session::poisoned_by_cancel`). And its results are **typed**, not text — so unlike the Postgres
//! driver, this one has to render every `ColumnData` variant itself. [`format_cell`] is where that
//! happens, and it renders each type in the *literal syntax T-SQL would accept back* (`0x…` for
//! binary, `1`/`0` for a bit), so a value read into the grid and written out again survives.

use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::TryStreamExt;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::entra;
use super::postgres::{annotate_types, cell, relation_folders, schema_folders};
use super::sqlgen::{self, quote_ident, quote_literal};
use super::postgres::parse_bytes;
use super::{
    describe_db_error, read_only_guard, read_only_refusal, split_statements, DbColumn,
    DbColumnInfo, DbConnectionConfig, DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbEditResult,
    DbExecContext, DbExecuteResult, DbForeignKey, DbKind, DbNode, DbNodeKind, DbNodeRef, DbRowEdit,
    DbObjectInfo, DbSchemaDiagram, DbServerInfo, DbSslMode, DbStatementResult,
    DbTableDataRequest, SqlDialect,
};

const DIALECT: SqlDialect = SqlDialect::TSql;

type TdsClient = Client<Compat<TcpStream>>;

pub struct MssqlSession {
    client: Mutex<TdsClient>,
    /// Cleared the first time the *stream* fails, so the registry throws this session away instead
    /// of handing it back forever. See [`MssqlSession::is_alive`].
    alive: AtomicBool,
    database: String,
    user: String,
    version: String,
    read_only: bool,
}

impl MssqlSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();
        // Fetched before the TDS config is built, because it *is* the credential: an Entra-only
        // Azure SQL server has SQL logins disabled and will refuse anything else. Its failures are
        // about the sign-in rather than about the database, so they surface verbatim instead of
        // being wrapped in "couldn't connect to host".
        let token = if config.auth_method.is_entra() {
            Some(entra::access_token(&config, entra::SQL_RESOURCE).await?)
        } else {
            None
        };
        let tds = tds_config(&config, database, token)?;
        let label = format!("Connecting to {}", config.endpoint());

        // A named instance (`HOST\SQLEXPRESS`) listens on a port assigned at startup; the SQL
        // Browser service on UDP 1434 is the only way to find out which. `connect_named` asks it.
        let tcp = if config.host.contains('\\') || tds.get_addr().contains('\\') {
            use tiberius::SqlBrowser;
            TcpStream::connect_named(&tds)
                .await
                .map_err(|e| describe_db_error(&config, &label, &e.to_string()))?
        } else {
            TcpStream::connect(tds.get_addr())
                .await
                .map_err(|e| describe_db_error(&config, &label, &e.to_string()))?
        };
        // TDS round trips are small and latency-bound; Nagle would add 40ms to every one.
        let _ = tcp.set_nodelay(true);

        let client = Client::connect(tds, tcp.compat_write())
            .await
            .map_err(|e| describe_db_error(&config, &label, &e.to_string()))?;

        let mut session = Self {
            client: Mutex::new(client),
            alive: AtomicBool::new(true),
            database: database.unwrap_or(&config.database).to_string(),
            user: config.user.clone(),
            version: String::new(),
            read_only: config.read_only,
        };

        if let Ok(rows) = session
            .text_rows("SELECT @@VERSION, DB_NAME(), SUSER_SNAME()")
            .await
        {
            if let Some(row) = rows.first() {
                // `@@VERSION` is four lines of build detail; the first is the product name.
                session.version =
                    cell(row, 0).lines().next().unwrap_or_default().trim().to_string();
                session.database = cell(row, 1);
                session.user = cell(row, 2);
            }
        }
        Ok(session)
    }

    pub fn info(&self) -> DbServerInfo {
        DbServerInfo {
            kind: DbKind::Sqlserver,
            version: self.version.clone(),
            database: self.database.clone(),
            user: self.user.clone(),
            notes: Vec::new(),
        }
    }

    /// False once the TDS stream has failed, which for this protocol is unrecoverable.
    ///
    /// tiberius offers no way to ask, so the answer is remembered from the last failure instead —
    /// see [`MssqlSession::note`]. Without it the registry's liveness check is `true` forever, and a
    /// server that restarted, timed the session out, or had it killed leaves a dead client cached:
    /// every statement after that fails identically, with no path back except the user finding
    /// Disconnect by hand.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Formats a driver error, and records whether it means the session is gone.
    ///
    /// The test is deliberately narrow — what killed the *socket*, not what merely failed. Only two
    /// families qualify. `Io` and `Tls` are the transport itself giving out. And a `Server` token of
    /// class 20 or above is the server announcing that it is closing the connection as it says so
    /// (`KILL <spid>`, a fatal internal error), which reads like every other server answer and is
    /// the one that would otherwise leave a dead client cached forever.
    ///
    /// Everything else stays alive on purpose. A `Server` token below class 20 is an ordinary answer
    /// — bad syntax, no such table, permission denied — and the next statement works. The decoding
    /// failures (`Encoding`, `Utf8`, `Utf16`, `Conversion`, `ParseInt`) are about one *value*, on a
    /// stream whose packet framing is untouched, and tiberius resynchronises before every request:
    /// `simple_query` opens with `flush_stream`, which truncates the local buffer and drains to the
    /// end of the previous message. Treating those as fatal would spend a full reconnect — login,
    /// TLS handshake and all — on a column whose collation isn't in the driver's LCID table.
    fn note(&self, error: tiberius::error::Error) -> String {
        use tiberius::error::Error;
        let terminal = match &error {
            Error::Io { .. } | Error::Tls(_) => true,
            // 20-25 is SQL Server's "the connection is going away with this message".
            Error::Server(token) => token.class() >= 20,
            _ => false,
        };
        if terminal {
            self.alive.store(false, Ordering::Relaxed);
        }
        tds_error(error)
    }

    /// Marks the session unusable from outside, for the cases the driver never gets to report.
    ///
    /// Abandoning a TDS call mid-stream is the one that matters: dropping the future leaves tokens
    /// unread and `flushed` false, so the next statement opens by draining a socket that may never
    /// answer. Nothing returns an error on that path — the future simply stops — so [`Self::note`]
    /// never runs and the session would stay in the registry looking healthy.
    pub fn poison(&self) {
        self.alive.store(false, Ordering::Relaxed);
    }

    // ---------------------------------------------------------------- queries

    /// Runs one statement and returns every result set it produced, flattened to text.
    async fn run_statement(
        &self,
        statement: &str,
        limit: Option<usize>,
    ) -> Result<Vec<DbStatementResult>, String> {
        let mut client = self.client.lock().await;
        let stream = client
            .simple_query(statement.to_string())
            .await
            .map_err(|e| self.note(e))?;
        let mut stream = Box::pin(stream);

        let mut results: Vec<DbStatementResult> = Vec::new();
        let mut current: Option<DbStatementResult> = None;
        // `QueryItem` isn't re-exported by tiberius, so the variants are read through its
        // accessors instead of matched — same two cases, no name to import.
        while let Some(item) = stream.try_next().await.map_err(|e| self.note(e))? {
            if let Some(metadata) = item.as_metadata() {
                // A new result set starts; whatever was being built is finished.
                if let Some(previous) = current.take() {
                    results.push(previous);
                }
                let mut result = DbStatementResult::empty(statement);
                result.columns = metadata
                    .columns()
                    .iter()
                    .map(|column| {
                        DbColumn::new(column.name(), format!("{:?}", column.column_type()))
                    })
                    .collect();
                current = Some(result);
                continue;
            }
            let Some(row) = item.as_row() else { continue };
            let Some(result) = current.as_mut() else {
                continue;
            };
            if limit.is_some_and(|max| result.rows.len() >= max) {
                // Unlike Postgres, stopping here is not free: TDS would leave the remaining rows
                // in the stream and the next statement would read them as its own answer. So the
                // flag is set and the loop keeps draining — the rows are discarded, not the
                // protocol state.
                result.truncated = true;
                continue;
            }
            result.rows.push(
                row.cells()
                    .map(|(_, data)| format_cell(data))
                    .collect::<Vec<_>>(),
            );
        }

        if let Some(previous) = current.take() {
            results.push(previous);
        }
        drop(stream);
        drop(client);
        if results.is_empty() {
            // No projection at all — a DML or DDL statement. tiberius only reports affected counts
            // through `ExecuteResult`, which `simple_query` doesn't produce, so the honest answer
            // is "it ran" rather than a number invented here.
            results.push(DbStatementResult::empty(statement));
        }
        Ok(results)
    }

    async fn text_rows(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
        let results = self.run_statement(sql, None).await?;
        Ok(results.into_iter().next().map(|r| r.rows).unwrap_or_default())
    }

    async fn scalar(&self, sql: &str) -> Result<Option<String>, String> {
        Ok(self.text_rows(sql).await?.first().and_then(|row| row.first().cloned()).flatten())
    }

    /// Fire-and-forget: used for `SET`/`USE`/transaction control where the answer is uninteresting
    /// but the statement still has to be read to completion.
    async fn run_silent(&self, sql: &str) -> Result<(), String> {
        let mut client = self.client.lock().await;
        let stream = client.simple_query(sql.to_string()).await.map_err(|e| self.note(e))?;
        let mut stream = Box::pin(stream);
        while stream.try_next().await.map_err(|e| self.note(e))?.is_some() {}
        Ok(())
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        if let Some(schema) = ctx.schema.as_deref().filter(|s| !s.is_empty()) {
            // `USE` switches database, not schema; the closest T-SQL has to a default schema for a
            // session is the login's, which can't be changed here. Qualifying names is the answer,
            // and the console's schema picker is what pre-qualifies them.
            let _ = schema;
        }
        if let Some(database) = ctx.database.as_deref().filter(|d| !d.is_empty()) {
            let _ = self.run_silent(&format!("USE {}", quote_ident(database, DIALECT))).await;
        }

        let mut results = Vec::new();
        for statement in tsql_batches(sql) {
            if let Err(refused) = read_only_guard(&statement, self.read_only) {
                results.push(DbStatementResult::failed(&statement, refused));
                break;
            }
            let statement_started = std::time::Instant::now();
            match self.run_statement(&statement, ctx.limit()).await {
                Ok(mut batch) => {
                    let elapsed = statement_started.elapsed().as_millis() as u64;
                    for result in batch.iter_mut() {
                        result.duration_ms = elapsed;
                    }
                    results.append(&mut batch);
                }
                Err(error) => {
                    let mut failed = DbStatementResult::failed(&statement, error);
                    failed.duration_ms = statement_started.elapsed().as_millis() as u64;
                    results.push(failed);
                    break;
                }
            }
        }
        Ok(DbExecuteResult {
            results,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// `SHOWPLAN_ALL` — the estimated plan, without running the statement.
    ///
    /// It has to be its own batch, which is exactly what a `simple_query` call is, so the three
    /// steps below are three calls rather than one script.
    pub async fn explain(&self, sql: &str, _ctx: &DbExecContext) -> Result<String, String> {
        let statement = tsql_batches(sql)
            .into_iter()
            .next()
            .ok_or_else(|| "There is no statement to explain.".to_string())?;
        self.run_silent("SET SHOWPLAN_ALL ON").await?;
        let plan = self.run_statement(&statement, None).await;
        // Always turned back off, including after a failure — leaving it on would make every
        // later statement in this session return a plan instead of doing its job.
        let _ = self.run_silent("SET SHOWPLAN_ALL OFF").await;
        let results = plan?;

        let mut lines = Vec::new();
        for result in results {
            let text_index =
                result.columns.iter().position(|c| c.name.eq_ignore_ascii_case("StmtText"));
            for row in result.rows {
                let value = match text_index {
                    Some(index) => cell(&row, index),
                    None => row.iter().flatten().cloned().collect::<Vec<_>>().join(" | "),
                };
                if !value.trim().is_empty() {
                    lines.push(value);
                }
            }
        }
        Ok(lines.join("\n"))
    }

    // ------------------------------------------------------------ introspect

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => self.databases().await,
            DbNodeKind::Database => self.schemas(node).await,
            DbNodeKind::Schema => Ok(schema_folders(node)),
            DbNodeKind::TableFolder => self.tables(node).await,
            DbNodeKind::ViewFolder => self.views(node).await,
            DbNodeKind::RoutineFolder => self.routines(node).await,
            DbNodeKind::SequenceFolder => self.sequences(node).await,
            DbNodeKind::Table | DbNodeKind::View => Ok(relation_folders(node)),
            DbNodeKind::ColumnFolder => self.columns(node).await,
            DbNodeKind::IndexFolder => self.indexes(node).await,
            DbNodeKind::KeyFolder => self.keys(node).await,
            _ => Ok(Vec::new()),
        }
    }

    async fn databases(&self) -> Result<Vec<DbNode>, String> {
        // `HAS_DBACCESS` filters the ones this login can't open — listing them would only produce
        // a tree that errors on click.
        let rows = self
            .text_rows(
                "SELECT name, state_desc FROM sys.databases \
                 WHERE HAS_DBACCESS(name) = 1 ORDER BY name",
            )
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("db:{name}"),
                    kind: DbNodeKind::Database,
                    name: name.clone(),
                    detail: cell(row, 1).to_lowercase(),
                    database: Some(name),
                    schema: None,
                    table: None,
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    /// Switches the session to `database` if it isn't already there.
    ///
    /// Every introspection query below reads `sys.*`, which is per-database — without this, opening
    /// a second database in the tree would show the first one's tables.
    async fn use_database(&self, node: &DbNodeRef) -> Result<(), String> {
        if let Some(database) = node.db() {
            self.run_silent(&format!("USE {}", quote_ident(database, DIALECT))).await?;
        }
        Ok(())
    }

    async fn schemas(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let rows = self
            .text_rows(
                "SELECT s.name FROM sys.schemas s \
                 WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA') \
                   AND s.name NOT LIKE 'db[_]%' \
                 ORDER BY s.name",
            )
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("schema:{}:{name}", node.db().unwrap_or_default()),
                    kind: DbNodeKind::Schema,
                    name: name.clone(),
                    detail: String::new(),
                    database: node.db().map(str::to_string),
                    schema: Some(name),
                    table: None,
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    async fn tables(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let rows = self
            .text_rows(&format!(
                "SELECT t.name, \
                        CAST(ISNULL(SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows END), 0) AS bigint) \
                 FROM sys.tables t \
                 JOIN sys.schemas s ON s.schema_id = t.schema_id \
                 LEFT JOIN sys.partitions p ON p.object_id = t.object_id \
                 WHERE s.name = {} \
                 GROUP BY t.name ORDER BY t.name",
                quote_literal(Some(schema))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let count = cell(row, 1);
                DbNode {
                    id: format!("rel:{schema}:{name}"),
                    kind: DbNodeKind::Table,
                    name: name.clone(),
                    detail: if count == "0" { String::new() } else { format!("~{count} rows") },
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(name),
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    async fn views(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let rows = self
            .text_rows(&format!(
                "SELECT v.name FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id \
                 WHERE s.name = {} ORDER BY v.name",
                quote_literal(Some(schema))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("view:{schema}:{name}"),
                    kind: DbNodeKind::View,
                    name: name.clone(),
                    detail: String::new(),
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(name),
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    async fn routines(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let rows = self
            .text_rows(&format!(
                "SELECT o.name, o.type_desc FROM sys.objects o \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 WHERE s.name = {} AND o.type IN ('P', 'FN', 'IF', 'TF', 'AF') \
                 ORDER BY o.name",
                quote_literal(Some(schema))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("routine:{schema}:{name}"),
                    kind: DbNodeKind::Routine,
                    name: name.clone(),
                    detail: cell(row, 1).to_lowercase().replace('_', " "),
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(name),
                    has_children: false,
                    column: None,
                }
            })
            .collect())
    }

    async fn sequences(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        // `sys.sequences` only exists from SQL Server 2012; an older server answers with an error
        // rather than an empty list, and an empty folder is the honest rendering of "none here".
        let rows = self
            .text_rows(&format!(
                "SELECT q.name, CAST(q.current_value AS nvarchar(64)) FROM sys.sequences q \
                 JOIN sys.schemas s ON s.schema_id = q.schema_id \
                 WHERE s.name = {} ORDER BY q.name",
                quote_literal(Some(schema))?
            ))
            .await
            .unwrap_or_default();
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("seq:{schema}:{name}"),
                    kind: DbNodeKind::Sequence,
                    name: name.clone(),
                    detail: format!("at {}", cell(row, 1)),
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(name),
                    has_children: false,
                    column: None,
                }
            })
            .collect())
    }

    async fn columns(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let table = node.name()?;
        let rows = self
            .text_rows(&format!(
                "SELECT c.name, TYPE_NAME(c.user_type_id), c.max_length, c.precision, c.scale, \
                        c.is_nullable, ISNULL(OBJECT_DEFINITION(c.default_object_id), ''), \
                        c.column_id, \
                        CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END, c.is_identity \
                 FROM sys.columns c \
                 JOIN sys.objects o ON o.object_id = c.object_id \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic \
                            JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
                            WHERE i.is_primary_key = 1) pk \
                   ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
                 WHERE s.name = {} AND o.name = {} \
                 ORDER BY c.column_id",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
            ))
            .await?;

        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let data_type = tsql_type_name(
                    &cell(row, 1),
                    cell(row, 2).parse().ok(),
                    cell(row, 3).parse().ok(),
                    cell(row, 4).parse().ok(),
                );
                let nullable = cell(row, 5) == "1";
                let default = cell(row, 6);
                let primary_key = cell(row, 8) == "1";
                let identity = cell(row, 9) == "1";
                let mut detail = data_type.clone();
                if primary_key {
                    detail.push_str(" · PK");
                }
                if identity {
                    detail.push_str(" · identity");
                }
                if !nullable {
                    detail.push_str(" · not null");
                }
                DbNode {
                    id: format!("col:{schema}:{table}:{name}"),
                    kind: DbNodeKind::Column,
                    name: name.clone(),
                    detail,
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(table.to_string()),
                    has_children: false,
                    column: Some(DbColumnInfo {
                        data_type,
                        nullable,
                        primary_key,
                        default_value: (!default.is_empty()).then_some(default),
                        position: cell(row, 7).parse().unwrap_or_default(),
                    }),
                }
            })
            .collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let table = node.name()?;
        // `FOR XML PATH` rather than `STRING_AGG`: the latter needs SQL Server 2017, and an
        // explorer that breaks on a 2016 server for the sake of a nicer subquery is a bad trade.
        let rows = self
            .text_rows(&format!(
                "SELECT i.name, i.type_desc, i.is_unique, \
                        STUFF((SELECT ', ' + c.name \
                               FROM sys.index_columns ic \
                               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                               WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id \
                               ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') \
                 FROM sys.indexes i \
                 WHERE i.object_id = OBJECT_ID({}) AND i.name IS NOT NULL \
                 ORDER BY i.name",
                quote_literal(Some(&format!("{schema}.{table}")))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let unique = if cell(row, 2) == "1" { "unique " } else { "" };
                DbNode {
                    id: format!("idx:{schema}:{table}:{}", cell(row, 0)),
                    kind: DbNodeKind::Index,
                    name: cell(row, 0),
                    detail: format!(
                        "{unique}{} ({})",
                        cell(row, 1).to_lowercase(),
                        cell(row, 3)
                    ),
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(table.to_string()),
                    has_children: false,
                    column: None,
                }
            })
            .collect())
    }

    /// The foreign keys of one table, one row per column pair.
    ///
    /// `sys.foreign_key_columns` is already the per-column view — one row per pair, with the
    /// ordinal handled for us — so there is no array to unpack the way Postgres needs.
    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let table = node.name()?;
        let object = quote_literal(Some(&format!("{schema}.{table}")))?;
        let rows = self
            .text_rows(&format!(
                "SELECT pc.name, OBJECT_SCHEMA_NAME(fkc.referenced_object_id), \
                        OBJECT_NAME(fkc.referenced_object_id), rc.name \
                 FROM sys.foreign_key_columns fkc \
                 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id \
                                    AND pc.column_id = fkc.parent_column_id \
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id \
                                    AND rc.column_id = fkc.referenced_column_id \
                 WHERE fkc.parent_object_id = OBJECT_ID({object}) \
                 ORDER BY fkc.constraint_object_id, fkc.constraint_column_id"
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

    /// A whole schema in two queries. See [`super::DbSchemaDiagram`] for why it isn't assembled
    /// from the per-table calls.
    ///
    /// `sys.partitions` gives the row count the same way the tables folder does — metadata, not a
    /// scan — and the primary-key flag comes from `sys.index_columns` on the PK index, which is
    /// where T-SQL actually keeps it.
    /// Every object of a schema, with the metadata SQL Server actually keeps: the type it calls the
    /// object, when it was created and last altered, what it reserves and uses on disk, and the
    /// `MS_Description` extended property if somebody wrote one.
    ///
    /// The size columns come from `sys.dm_db_partition_stats`, which needs `VIEW DATABASE STATE`.
    /// A login without it makes the whole statement fail, so the query is tried once with the sizes
    /// and once without: a reader who cannot see the DMV still gets the names, types and dates
    /// rather than an error where the tab should be.
    pub async fn schema_objects(&self, node: &DbNodeRef) -> Result<Vec<DbObjectInfo>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let literal = quote_literal(Some(schema))?;

        // 121 is ODBC canonical with milliseconds — `2026-06-15 18:38:46.037`, sortable as text and
        // free of the locale the server happens to run under.
        let select = |sizes: bool| {
            let (size_cols, size_join) = if sizes {
                (
                    "CAST(ISNULL(ps.reserved_bytes, 0) AS bigint), \
                     CAST(ISNULL(ps.used_bytes, 0) AS bigint), \
                     CAST(ISNULL(ps.row_total, 0) AS bigint)",
                    "LEFT JOIN ( \
                         SELECT object_id, \
                                SUM(reserved_page_count) * 8192 AS reserved_bytes, \
                                SUM(used_page_count) * 8192 AS used_bytes, \
                                SUM(CASE WHEN index_id IN (0, 1) THEN row_count ELSE 0 END) AS row_total \
                         FROM sys.dm_db_partition_stats GROUP BY object_id \
                     ) ps ON ps.object_id = o.object_id ",
                )
            } else {
                ("NULL, NULL, NULL", "")
            };
            format!(
                "SELECT o.name, o.type_desc, \
                        CONVERT(varchar(23), o.create_date, 121), \
                        CONVERT(varchar(23), o.modify_date, 121), \
                        {size_cols}, \
                        ISNULL(CAST(ep.value AS nvarchar(4000)), '') \
                 FROM sys.objects o \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 {size_join}\
                 LEFT JOIN sys.extended_properties ep \
                        ON ep.major_id = o.object_id AND ep.minor_id = 0 \
                       AND ep.class = 1 AND ep.name = 'MS_Description' \
                 WHERE s.name = {literal} \
                   AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SO') \
                 ORDER BY o.name"
            )
        };

        let rows = match self.text_rows(&select(true)).await {
            Ok(rows) => rows,
            Err(_) => self.text_rows(&select(false)).await?,
        };

        Ok(rows
            .iter()
            .map(|row| {
                let object_type = cell(row, 1);
                let kind = match object_type.as_str() {
                    "VIEW" => DbNodeKind::View,
                    "SEQUENCE_OBJECT" => DbNodeKind::Sequence,
                    "USER_TABLE" => DbNodeKind::Table,
                    // Everything else in the `type` filter above is a routine of some shape.
                    _ => DbNodeKind::Routine,
                };
                DbObjectInfo {
                    name: cell(row, 0),
                    kind,
                    object_type,
                    created_at: Some(cell(row, 2)).filter(|v| !v.is_empty()),
                    modified_at: Some(cell(row, 3)).filter(|v| !v.is_empty()),
                    total_bytes: parse_bytes(&cell(row, 4)),
                    used_bytes: parse_bytes(&cell(row, 5)),
                    rows: parse_bytes(&cell(row, 6)),
                    comment: cell(row, 7),
                }
            })
            .collect())
    }

    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let literal = quote_literal(Some(schema))?;

        let rows = self
            .text_rows(&format!(
                "SELECT o.name, o.type, ISNULL(c.name, ''), \
                        ISNULL(TYPE_NAME(c.user_type_id), ''), \
                        ISNULL(c.max_length, 0), ISNULL(c.precision, 0), ISNULL(c.scale, 0), \
                        ISNULL(c.is_nullable, 0), \
                        CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END, \
                        ISNULL(p.rows, 0) \
                 FROM sys.objects o \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 LEFT JOIN sys.columns c ON c.object_id = o.object_id \
                 LEFT JOIN (SELECT object_id, SUM(rows) AS rows FROM sys.partitions \
                            WHERE index_id IN (0, 1) GROUP BY object_id) p \
                        ON p.object_id = o.object_id \
                 LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic \
                            JOIN sys.indexes i ON i.object_id = ic.object_id \
                                              AND i.index_id = ic.index_id \
                            WHERE i.is_primary_key = 1) pk \
                        ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
                 WHERE s.name = {literal} AND o.type IN ('U', 'V') \
                 ORDER BY o.name, c.column_id"
            ))
            .await?;

        let mut tables: Vec<DbDiagramTable> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let table = match tables.last_mut() {
                Some(last) if last.name == name => last,
                _ => {
                    tables.push(DbDiagramTable {
                        schema: Some(schema.to_string()),
                        name: name.clone(),
                        kind: if cell(row, 1).trim() == "V" {
                            DbNodeKind::View
                        } else {
                            DbNodeKind::Table
                        },
                        columns: Vec::new(),
                        row_estimate: cell(row, 9).parse().ok(),
                    });
                    tables.last_mut().expect("just pushed")
                }
            };
            let column = cell(row, 2);
            if column.is_empty() {
                continue;
            }
            table.columns.push(DbDiagramColumn {
                name: column,
                data_type: tsql_type_name(
                    &cell(row, 3),
                    cell(row, 4).parse().ok(),
                    cell(row, 5).parse().ok(),
                    cell(row, 6).parse().ok(),
                ),
                nullable: cell(row, 7) == "1",
                primary_key: cell(row, 8) == "1",
                foreign_key: false,
            });
        }

        let edges = self
            .text_rows(&format!(
                "SELECT f.name, OBJECT_NAME(fkc.parent_object_id), pc.name, \
                        OBJECT_SCHEMA_NAME(fkc.referenced_object_id), \
                        OBJECT_NAME(fkc.referenced_object_id), rc.name \
                 FROM sys.foreign_keys f \
                 JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = f.object_id \
                 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id \
                                    AND pc.column_id = fkc.parent_column_id \
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id \
                                    AND rc.column_id = fkc.referenced_column_id \
                 WHERE OBJECT_SCHEMA_NAME(f.parent_object_id) = {literal} \
                 ORDER BY f.name, fkc.constraint_column_id"
            ))
            .await?
            .iter()
            .map(|row| DbDiagramEdge {
                constraint: cell(row, 0),
                from_schema: Some(schema.to_string()),
                from_table: cell(row, 1),
                from_column: cell(row, 2),
                to_schema: Some(cell(row, 3)),
                to_table: cell(row, 4),
                to_column: cell(row, 5),
                inferred: false,
            })
            .collect();

        Ok(DbSchemaDiagram {
            database: node.db().map(str::to_string),
            schema: Some(schema.to_string()),
            tables,
            edges,
            notes: Vec::new(),
        })
    }

    async fn keys(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let table = node.name()?;
        let object = quote_literal(Some(&format!("{schema}.{table}")))?;
        let rows = self
            .text_rows(&format!(
                "SELECT k.name, k.type_desc, '' \
                 FROM sys.key_constraints k WHERE k.parent_object_id = OBJECT_ID({object}) \
                 UNION ALL \
                 SELECT f.name, 'FOREIGN KEY', \
                        OBJECT_SCHEMA_NAME(f.referenced_object_id) + '.' + OBJECT_NAME(f.referenced_object_id) \
                 FROM sys.foreign_keys f WHERE f.parent_object_id = OBJECT_ID({object}) \
                 ORDER BY 2, 1"
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let references = cell(row, 2);
                DbNode {
                    id: format!("key:{schema}:{table}:{}", cell(row, 0)),
                    kind: DbNodeKind::Key,
                    name: cell(row, 0),
                    detail: if references.is_empty() {
                        cell(row, 1).to_lowercase().replace('_', " ")
                    } else {
                        format!("references {references}")
                    },
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(table.to_string()),
                    has_children: false,
                    column: None,
                }
            })
            .collect())
    }

    // ----------------------------------------------------------------- data

    pub async fn table_data(
        &self,
        request: &DbTableDataRequest,
    ) -> Result<DbStatementResult, String> {
        self.use_database(&request.node).await?;
        let sql = sqlgen::select_page(
            &request.node,
            DIALECT,
            &request.filter,
            &request.sort,
            request.offset,
            request.limit,
        )?;
        let mut result = self
            .run_statement(&sql, Some(request.limit as usize))
            .await?
            .into_iter()
            .next()
            .unwrap_or_else(|| DbStatementResult::empty(&sql));
        if let Ok(columns) = self.columns(&request.node).await {
            annotate_types(&mut result, &columns);
        }
        Ok(result)
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        self.use_database(node).await?;
        let sql = sqlgen::count_rows(node, DIALECT, filter)?;
        Ok(self.scalar(&sql).await?.and_then(|v| v.parse().ok()).unwrap_or_default())
    }

    pub async fn apply_edits(
        &self,
        node: &DbNodeRef,
        edits: &[DbRowEdit],
    ) -> Result<DbEditResult, String> {
        let mut statements = Vec::with_capacity(edits.len());
        for edit in edits {
            statements.push(sqlgen::edit_statement(node, DIALECT, edit)?);
        }
        if self.read_only {
            return Err(read_only_refusal());
        }
        self.use_database(node).await?;

        self.run_silent("BEGIN TRANSACTION").await?;
        let mut applied = 0u32;
        for statement in &statements {
            if let Err(error) = self.run_silent(statement).await {
                let _ = self.run_silent("ROLLBACK").await;
                return Ok(DbEditResult {
                    applied: 0,
                    statements: statements.clone(),
                    error: Some(format!("{error}\n\n{statement}")),
                });
            }
            applied += 1;
        }
        self.run_silent("COMMIT").await?;
        Ok(DbEditResult {
            applied,
            statements,
            error: None,
        })
    }

    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        self.use_database(node).await?;
        let schema = node.schema().unwrap_or("dbo");
        let name = node.name()?;

        if matches!(node.kind, DbNodeKind::View | DbNodeKind::Routine) {
            // The server kept the original text, which beats anything reconstructed.
            let definition = self
                .scalar(&format!(
                    "SELECT OBJECT_DEFINITION(OBJECT_ID({}))",
                    quote_literal(Some(&format!("{schema}.{name}")))?
                ))
                .await?
                .unwrap_or_default();
            if !definition.trim().is_empty() {
                return Ok(definition);
            }
        }

        let columns = self.columns(node).await?;
        let mut ddl = sqlgen::create_table_ddl(
            node,
            DIALECT,
            &columns
                .iter()
                .map(|c| {
                    let info = c.column.as_ref();
                    (
                        c.name.clone(),
                        info.map(|i| i.data_type.clone()).unwrap_or_default(),
                        info.map_or(true, |i| i.nullable),
                        info.and_then(|i| i.default_value.clone()),
                    )
                })
                .collect::<Vec<_>>(),
            &columns
                .iter()
                .filter(|c| c.column.as_ref().is_some_and(|i| i.primary_key))
                .map(|c| c.name.clone())
                .collect::<Vec<_>>(),
        )?;
        for index in self.indexes(node).await.unwrap_or_default() {
            ddl.push_str(&format!("\n\n-- {} {}", index.name, index.detail));
        }
        for key in self.keys(node).await.unwrap_or_default() {
            ddl.push_str(&format!("\n\n-- {} {}", key.name, key.detail));
        }
        Ok(ddl)
    }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// One cell, rendered in the literal syntax T-SQL would accept back.
///
/// That constraint is what picks each format: `1`/`0` for a bit (not `true`, which T-SQL rejects
/// in a bit column), `0x…` for binary, and `YYYY-MM-DD HH:MM:SS.fff` for the date types, which is
/// unambiguous under every `DATEFORMAT` setting. A grid cell copied and pasted into an `INSERT`
/// therefore works, which is the whole reason not to prettify these.
fn format_cell(data: &ColumnData<'static>) -> Option<String> {
    match data {
        ColumnData::U8(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::I16(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::I32(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::I64(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::F32(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::F64(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::Bit(v) => v.as_ref().map(|v| if *v { "1".into() } else { "0".into() }),
        ColumnData::String(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::Guid(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::Binary(v) => v.as_ref().map(|bytes| format!("0x{}", hex::encode(bytes))),
        ColumnData::Numeric(v) => v.as_ref().map(|v| v.to_string()),
        ColumnData::Xml(v) => v.as_ref().map(|xml| xml.to_string()),
        // The temporal variants carry TDS's own day counters and sub-second increments, not a
        // calendar date; tiberius converts them only through `FromSql`, which is what
        // `format_temporal` reaches for.
        other => format_temporal(other),
    }
}

/// The date/time variants, via tiberius's own chrono conversions.
fn format_temporal(data: &ColumnData<'static>) -> Option<String> {
    use tiberius::time::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
    use tiberius::FromSql;

    match data {
        ColumnData::Date(_) => NaiveDate::from_sql(data)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d").to_string()),
        ColumnData::Time(_) => NaiveTime::from_sql(data)
            .ok()
            .flatten()
            .map(|t| t.format("%H:%M:%S%.f").to_string()),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            NaiveDateTime::from_sql(data)
                .ok()
                .flatten()
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.f").to_string())
        }
        ColumnData::DateTimeOffset(_) => chrono::DateTime::<chrono::FixedOffset>::from_sql(data)
            .ok()
            .flatten()
            .map(|dt| dt.to_rfc3339()),
        _ => None,
    }
}

/// `nvarchar(50)`, `decimal(18,2)`, `int` — the type as a `CREATE TABLE` would spell it.
///
/// `max_length` is in *bytes*, so the two-byte-per-character types report double what the
/// declaration said; `-1` is the `(max)` sentinel.
fn tsql_type_name(
    base: &str,
    max_length: Option<i32>,
    precision: Option<i32>,
    scale: Option<i32>,
) -> String {
    let lower = base.to_ascii_lowercase();
    match lower.as_str() {
        "nvarchar" | "nchar" | "varchar" | "char" | "varbinary" | "binary" => {
            let divisor = if lower.starts_with('n') { 2 } else { 1 };
            match max_length {
                Some(-1) => format!("{base}(max)"),
                Some(length) => format!("{base}({})", length / divisor),
                None => base.to_string(),
            }
        }
        "decimal" | "numeric" => match (precision, scale) {
            (Some(p), Some(s)) => format!("{base}({p},{s})"),
            _ => base.to_string(),
        },
        "datetime2" | "time" | "datetimeoffset" => match scale {
            Some(s) if s != 7 => format!("{base}({s})"),
            _ => base.to_string(),
        },
        _ => base.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Connection plumbing
// ---------------------------------------------------------------------------

/// Splits a console buffer into batches the way SQL Server's own tools do.
///
/// `GO` is not T-SQL — it is a batch separator the client acts on — and when a script uses it, each
/// batch has to be sent whole, semicolons and all, because `CREATE PROCEDURE … AS BEGIN … END` is
/// one statement containing several. So: if the buffer has `GO` lines, split only on those;
/// otherwise fall back to splitting on `;`, which is what a console session actually types.
fn tsql_batches(sql: &str) -> Vec<String> {
    let has_go = sql
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("go") || is_go_with_count(line.trim()));
    if !has_go {
        return split_statements(sql, Some(DIALECT));
    }
    let mut batches = Vec::new();
    let mut current = String::new();
    for line in sql.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("go") || is_go_with_count(trimmed) {
            if !current.trim().is_empty() {
                batches.push(current.trim().to_string());
            }
            current.clear();
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        batches.push(current.trim().to_string());
    }
    batches
}

/// `GO 5` repeats the batch five times. Recognized as a separator (the repeat count is ignored)
/// rather than sent to the server, which would reject it as a syntax error.
fn is_go_with_count(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    matches!(parts.next(), Some(word) if word.eq_ignore_ascii_case("go"))
        && parts.next().is_some_and(|count| count.parse::<u32>().is_ok())
        && parts.next().is_none()
}

/// Builds the TDS configuration. `token` is a Microsoft Entra ID access token when the connection
/// authenticates that way, and wins over anything the fields or the connection string say about a
/// login — see [`entra`].
fn tds_config(
    config: &DbConnectionConfig,
    database: Option<&str>,
    token: Option<String>,
) -> Result<Config, String> {
    let mut tds = if config.url.trim().is_empty() {
        let mut tds = Config::new();
        tds.host(&config.host);
        tds.port(config.effective_port());
        if !config.user.is_empty() {
            tds.authentication(AuthMethod::sql_server(&config.user, &config.password));
        }
        tds
    } else {
        // An ADO.NET connection string ("Server=…;Database=…;User Id=…") is what a .NET shop has
        // on hand, and tiberius parses both it and the JDBC form.
        let trimmed = config.url.trim();
        if trimmed.starts_with("jdbc:") {
            Config::from_jdbc_string(trimmed)
        } else {
            Config::from_ado_string(trimmed)
        }
        .map_err(|e| format!("That connection string couldn't be parsed: {e}"))?
    };

    let target = database.filter(|d| !d.is_empty()).unwrap_or(config.database.as_str());
    if !target.is_empty() {
        tds.database(target);
    }

    // Set after the connection string is parsed, so a pasted `User Id=…;Password=…` can't quietly
    // win over the sign-in the user chose in the dialog.
    if let Some(token) = token {
        tds.authentication(AuthMethod::aad_token(token));
    }

    match config.ssl {
        // A bearer token in cleartext is a credential anyone on the path can replay, so this is one
        // of the few places where the connection's own setting doesn't get the last word. Azure SQL
        // mandates TLS regardless; the refusal to send the token unencrypted is ours.
        DbSslMode::Disable if config.auth_method.is_entra() => {
            tds.encryption(EncryptionLevel::Required);
            tds.trust_cert();
        }
        DbSslMode::Disable => tds.encryption(EncryptionLevel::NotSupported),
        DbSslMode::Require => {
            tds.encryption(EncryptionLevel::Required);
            // Azure SQL and a dev box with a self-signed certificate both land here; only the
            // latter needs this, and `Require` is how the user asked for it.
            tds.trust_cert();
        }
        DbSslMode::VerifyFull => tds.encryption(EncryptionLevel::Required),
    }
    // Verified against a private CA. tiberius takes the path itself rather than a built trust
    // store, so unlike the Postgres driver there is nothing to merge with the system's — naming a
    // CA here means the server's certificate is checked against *that* file.
    if !config.ssl_ca_file.trim().is_empty() {
        let path = config.ssl_ca_file.trim();
        if !std::path::Path::new(path).is_file() {
            return Err(format!("There is no CA file at {path}."));
        }
        tds.trust_cert_ca(path);
    }
    if let Some(instance) = config.option("instance_name") {
        tds.instance_name(instance);
    }
    if let Some(name) = config.option("application_name") {
        tds.application_name(name);
    }
    Ok(tds)
}

/// tiberius wraps a server error in `Error::Server(TokenError)`, whose `Display` is the bare
/// message. The number and line are what make an error findable in a long script.
fn tds_error(error: tiberius::error::Error) -> String {
    match &error {
        tiberius::error::Error::Server(token) => {
            format!("[{}] {} (line {})", token.code(), token.message(), token.line())
        }
        other => match crate::api::root_cause(other) {
            Some(cause) => cause,
            None => other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stored procedure body is full of semicolons; splitting on them would send the server four
    /// fragments. When a script says `GO`, that is the only separator that counts.
    #[test]
    fn go_separates_batches_and_semicolons_do_not() {
        let sql = "CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END\nGO\nSELECT 3;";
        let batches = tsql_batches(sql);
        assert_eq!(batches.len(), 2, "{batches:?}");
        assert!(batches[0].contains("SELECT 1; SELECT 2;"));
        assert_eq!(batches[1], "SELECT 3;");
    }

    /// Without a `GO` anywhere, a console buffer is just statements — and each should run on its
    /// own so one failing doesn't take the others with it.
    #[test]
    fn without_go_the_buffer_splits_on_semicolons() {
        assert_eq!(tsql_batches("SELECT 1; SELECT 2").len(), 2);
    }

    #[test]
    fn go_with_a_repeat_count_is_still_a_separator() {
        assert!(is_go_with_count("GO 5"));
        assert!(!is_go_with_count("GO TO"));
        assert_eq!(tsql_batches("SELECT 1\nGO 3\nSELECT 2").len(), 2);
    }

    /// `max_length` is bytes, so an `nvarchar(50)` reports 100 — printing that would misdescribe
    /// every unicode column in the tree.
    #[test]
    fn unicode_lengths_are_halved_and_max_is_named() {
        assert_eq!(tsql_type_name("nvarchar", Some(100), None, None), "nvarchar(50)");
        assert_eq!(tsql_type_name("varchar", Some(50), None, None), "varchar(50)");
        assert_eq!(tsql_type_name("nvarchar", Some(-1), None, None), "nvarchar(max)");
        assert_eq!(tsql_type_name("decimal", Some(9), Some(18), Some(2)), "decimal(18,2)");
        assert_eq!(tsql_type_name("int", Some(4), Some(10), Some(0)), "int");
    }
}
