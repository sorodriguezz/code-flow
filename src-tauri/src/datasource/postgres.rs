//! PostgreSQL — and therefore Supabase, which is a Postgres instance with a managed host.
//!
//! Everything runs through the **simple query protocol** (`simple_query_raw`), not the extended
//! one. That single decision is what makes the grid honest: the simple protocol answers in text,
//! so every value shown is the server's own rendering — the same string `psql` would print — and
//! this file contains no binary decoders to get a `numeric`, a `tstzrange` or a custom enum
//! subtly wrong. What it gives up is parameter binding, which is why the catalog queries below
//! interpolate names through `sqlgen::quote_literal` rather than passing them as `$1`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use tokio_postgres::config::SslMode;
use tokio_postgres::{AsyncMessage, Client, SimpleQueryMessage};

use super::sqlgen::{self, quote_ident, quote_literal};
use super::{
    describe_db_error, read_only_guard, read_only_refusal, split_statements, DbColumn,
    DbColumnInfo, DbConnectionConfig, DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbEditResult,
    DbExecContext, DbExecuteResult, DbForeignKey, DbKind, DbNode, DbNodeKind, DbNodeRef, DbRowEdit,
    DbSchemaDiagram, DbServerInfo, DbSslMode, DbStatementResult, DbTableDataRequest, SqlDialect,
};

const DIALECT: SqlDialect = SqlDialect::Postgres;

pub struct PgSession {
    client: Client,
    /// Cleared by the connection task when the socket dies, so the registry can throw the session
    /// away instead of handing back a client whose every call returns "connection closed".
    alive: Arc<AtomicBool>,
    /// `NOTICE`/`WARNING` messages the server pushed since the last statement. Postgres delivers
    /// these out of band — a `RAISE NOTICE` in a function is not part of any result — so without
    /// draining them here a procedure that only reports through notices looks like it did nothing.
    notices: Arc<Mutex<Vec<String>>>,
    kind: DbKind,
    database: String,
    user: String,
    version: String,
    port: u16,
    read_only: bool,
}

impl PgSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();
        let mut pg = pg_config(&config, database)?;
        if pg.get_application_name().is_none() {
            pg.application_name("CodeFlow");
        }
        pg.connect_timeout(config.connect_timeout());

        let alive = Arc::new(AtomicBool::new(true));
        let notices: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let label = format!("Connecting to {}", config.endpoint());

        // Supabase and every other hosted Postgres require TLS; a container on localhost usually
        // has none at all. `Prefer` (tokio-postgres's default when a URL says nothing) is treated
        // as "bring TLS" — negotiation still falls back if the server refuses it.
        let encrypted = config.ssl != DbSslMode::Disable || pg.get_ssl_mode() != SslMode::Disable;

        let client = if encrypted {
            let tls = tls_connector(&config)?;
            let (client, connection) = pg
                .connect(tls)
                .await
                .map_err(|e| describe_db_error(&config, &label, &e.to_string()))?;
            spawn_driver(connection, alive.clone(), notices.clone());
            client
        } else {
            let (client, connection) = pg
                .connect(tokio_postgres::NoTls)
                .await
                .map_err(|e| describe_db_error(&config, &label, &e.to_string()))?;
            spawn_driver(connection, alive.clone(), notices.clone());
            client
        };

        let mut session = Self {
            client,
            alive,
            notices,
            kind: config.kind,
            database: String::new(),
            user: String::new(),
            version: String::new(),
            port: config.effective_port(),
            read_only: config.read_only,
        };

        // One round trip for everything the status bar shows, rather than three.
        let rows = session
            .text_rows("SELECT current_database(), current_user, version()")
            .await
            .unwrap_or_default();
        if let Some(row) = rows.first() {
            session.database = cell(row, 0);
            session.user = cell(row, 1);
            session.version = cell(row, 2);
        }
        if session.database.is_empty() {
            session.database =
                database.unwrap_or(&config.database).to_string();
        }
        Ok(session)
    }

    pub fn info(&self) -> DbServerInfo {
        let mut notes = Vec::new();
        if self.kind == DbKind::Supabase && self.port == 6543 {
            notes.push(
                "Port 6543 is Supabase's transaction pooler: it multiplexes sessions, so temporary \
                 tables, advisory locks and `LISTEN` don't survive between statements. Use 5432 \
                 for a session that needs them."
                    .to_string(),
            );
        }
        DbServerInfo {
            kind: self.kind,
            version: self.version.clone(),
            database: self.database.clone(),
            user: self.user.clone(),
            notes,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed) && !self.client.is_closed()
    }

    pub async fn cancel_running(&self) {
        // Opens a second connection and sends `CancelRequest`, which is the only way to stop a
        // statement server-side. Plaintext because the cancel packet carries no credentials — just
        // the backend pid and a secret the server itself issued.
        let _ = self.client.cancel_token().cancel_query(tokio_postgres::NoTls).await;
    }

    // ---------------------------------------------------------------- queries

    /// Runs one statement and returns its rows as text. The workhorse for catalog queries, where
    /// the shape is known and a failure is worth surfacing verbatim.
    async fn text_rows(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
        let messages = self.client.simple_query(sql).await.map_err(pg_error)?;
        let mut rows = Vec::new();
        for message in messages {
            if let SimpleQueryMessage::Row(row) = message {
                rows.push(
                    (0..row.len())
                        .map(|i| row.get(i).map(str::to_string))
                        .collect(),
                );
            }
        }
        Ok(rows)
    }

    async fn scalar(&self, sql: &str) -> Result<Option<String>, String> {
        Ok(self
            .text_rows(sql)
            .await?
            .first()
            .and_then(|row| row.first().cloned())
            .flatten())
    }

    fn drain_notices(&self) -> Vec<String> {
        self.notices
            .lock()
            .map(|mut queue| std::mem::take(&mut *queue))
            .unwrap_or_default()
    }

    /// Runs one statement, stopping as soon as the row limit is reached.
    ///
    /// Stopping means dropping the stream, which tells the connection task to discard the rest of
    /// the answer. That is the point — a `SELECT *` on a hundred-million-row table must not stream
    /// a hundred million rows into a grid that will show a thousand — and the cost is that the
    /// server did start producing them. `truncated` says so, and the console offers "no limit" for
    /// when the whole thing really is wanted.
    async fn run_one(&self, statement: &str, ctx: &DbExecContext) -> DbStatementResult {
        let started = std::time::Instant::now();
        let mut result = DbStatementResult::empty(statement);
        let limit = ctx.limit();

        let stream = match self.client.simple_query_raw(statement).await {
            Ok(stream) => stream,
            Err(e) => {
                let mut failed = DbStatementResult::failed(statement, pg_error(e));
                failed.duration_ms = started.elapsed().as_millis() as u64;
                failed.messages = self.drain_notices();
                return failed;
            }
        };
        let mut stream = Box::pin(stream);

        while let Some(message) = stream.next().await {
            match message {
                Ok(SimpleQueryMessage::RowDescription(columns)) => {
                    result.columns =
                        columns.iter().map(|c| DbColumn::new(c.name(), String::new())).collect();
                }
                Ok(SimpleQueryMessage::Row(row)) => {
                    if result.columns.is_empty() {
                        result.columns = row
                            .columns()
                            .iter()
                            .map(|c| DbColumn::new(c.name(), String::new()))
                            .collect();
                    }
                    if limit.is_some_and(|max| result.rows.len() >= max) {
                        result.truncated = true;
                        break;
                    }
                    result.rows.push(
                        (0..row.len())
                            .map(|i| row.get(i).map(str::to_string))
                            .collect(),
                    );
                }
                Ok(SimpleQueryMessage::CommandComplete(affected)) => {
                    // A `SELECT` reports its row count here too; only a statement with no
                    // projection at all is described by "n rows affected".
                    if result.columns.is_empty() {
                        result.rows_affected = Some(affected as i64);
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    result.error = Some(pg_error(e));
                    break;
                }
            }
        }

        result.duration_ms = started.elapsed().as_millis() as u64;
        result.messages = self.drain_notices();
        result
    }

    /// Applies the console's schema choice for the rest of the session.
    ///
    /// `SET` (not `SET LOCAL`) on purpose: a console is a session, and a user who picks a schema in
    /// the toolbar expects the next statement to still see it.
    async fn apply_search_path(&self, ctx: &DbExecContext) {
        if let Some(schema) = ctx.schema.as_deref().filter(|s| !s.is_empty()) {
            let literal = quote_literal(Some(schema)).unwrap_or_else(|_| "'public'".into());
            let _ = self
                .client
                .simple_query(&format!("SET search_path TO {literal}, public"))
                .await;
        }
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        self.apply_search_path(ctx).await;

        // Statement by statement rather than one batched `simple_query`, for three reasons: the
        // batch would run as a single implicit transaction (so statement 4 failing would undo 1–3
        // even though the user wrote no `BEGIN`), a failure would abandon the rest with no way to
        // say which one broke, and each result gets its own timing this way.
        let mut results = Vec::new();
        for statement in split_statements(sql, Some(DIALECT)) {
            if let Err(refused) = read_only_guard(&statement, self.read_only) {
                results.push(DbStatementResult::failed(&statement, refused));
                break;
            }
            let result = self.run_one(&statement, ctx).await;
            let failed = result.error.is_some();
            results.push(result);
            // Stopping on the first failure matches what a script author means by writing
            // statements in an order: statement 5 usually assumes 4 worked.
            if failed {
                break;
            }
        }
        Ok(DbExecuteResult {
            results,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn explain(&self, sql: &str, ctx: &DbExecContext) -> Result<String, String> {
        let statement = split_statements(sql, Some(DIALECT))
            .into_iter()
            .next()
            .ok_or_else(|| "There is no statement to explain.".to_string())?;
        self.apply_search_path(ctx).await;
        // `ANALYZE false`: explaining must never *run* the statement. A plan for a `DELETE` is
        // information; executing one to get it is not what the user asked for.
        let rows = self
            .text_rows(&format!("EXPLAIN (VERBOSE, COSTS, FORMAT TEXT) {statement}"))
            .await?;
        Ok(rows
            .iter()
            .filter_map(|row| row.first().cloned().flatten())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    // ------------------------------------------------------------ introspect

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => self.databases().await,
            DbNodeKind::Database => self.schemas(node).await,
            DbNodeKind::Schema => Ok(schema_folders(node)),
            DbNodeKind::TableFolder => self.relations(node, &['r', 'p']).await,
            DbNodeKind::ViewFolder => self.relations(node, &['v', 'm']).await,
            DbNodeKind::RoutineFolder => self.routines(node).await,
            DbNodeKind::SequenceFolder => self.relations(node, &['S']).await,
            DbNodeKind::Table | DbNodeKind::View => Ok(relation_folders(node)),
            DbNodeKind::ColumnFolder => self.columns(node).await,
            DbNodeKind::IndexFolder => self.indexes(node).await,
            DbNodeKind::KeyFolder => self.keys(node).await,
            _ => Ok(Vec::new()),
        }
    }

    async fn databases(&self) -> Result<Vec<DbNode>, String> {
        let rows = self
            .text_rows(
                "SELECT datname, pg_encoding_to_char(encoding) \
                 FROM pg_database \
                 WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') \
                 ORDER BY datname",
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
                    detail: cell(row, 1),
                    database: Some(name),
                    schema: None,
                    table: None,
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    async fn schemas(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        // `pg_%` and `information_schema` are the server's own bookkeeping. Everything else stays,
        // including Supabase's `auth`/`storage`/`realtime` — they hold rows a user legitimately
        // wants to read, and hiding them would be this client deciding what their database is for.
        let rows = self
            .text_rows(
                "SELECT nspname FROM pg_namespace \
                 WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
                 ORDER BY nspname",
            )
            .await?;
        let database = node.db().map(str::to_string);
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("schema:{}:{name}", database.clone().unwrap_or_default()),
                    kind: DbNodeKind::Schema,
                    name: name.clone(),
                    detail: String::new(),
                    database: database.clone(),
                    schema: Some(name),
                    table: None,
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    async fn relations(&self, node: &DbNodeRef, kinds: &[char]) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("public");
        let kind_list = kinds
            .iter()
            .map(|k| quote_literal(Some(&k.to_string())).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(", ");
        let rows = self
            .text_rows(&format!(
                "SELECT c.relname, c.relkind, \
                        COALESCE(NULLIF(s.n_live_tup, 0)::text, ''), \
                        COALESCE(obj_description(c.oid, 'pg_class'), '') \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid \
                 WHERE n.nspname = {} AND c.relkind IN ({kind_list}) \
                 ORDER BY c.relname",
                quote_literal(Some(schema))?
            ))
            .await?;

        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let relkind = cell(row, 1);
                let kind = match relkind.as_str() {
                    "v" | "m" => DbNodeKind::View,
                    "S" => DbNodeKind::Sequence,
                    _ => DbNodeKind::Table,
                };
                // The row estimate, not a count: `COUNT(*)` on every table in a schema would make
                // expanding a folder cost a full scan per table.
                let rows_estimate = cell(row, 2);
                let comment = cell(row, 3);
                let detail = match (rows_estimate.is_empty(), comment.is_empty()) {
                    (false, false) => format!("~{rows_estimate} rows · {comment}"),
                    (false, true) => format!("~{rows_estimate} rows"),
                    (true, false) => comment,
                    (true, true) => String::new(),
                };
                DbNode {
                    id: format!("rel:{schema}:{name}"),
                    kind,
                    name: name.clone(),
                    detail,
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(name),
                    has_children: kind != DbNodeKind::Sequence,
                    column: None,
                }
            })
            .collect())
    }

    async fn routines(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("public");
        let rows = self
            .text_rows(&format!(
                "SELECT p.proname, pg_get_function_identity_arguments(p.oid), \
                        pg_get_function_result(p.oid) \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = {} ORDER BY p.proname",
                quote_literal(Some(schema))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("routine:{schema}:{name}:{}", cell(row, 1)),
                    kind: DbNodeKind::Routine,
                    name: format!("{name}({})", cell(row, 1)),
                    detail: format!("→ {}", cell(row, 2)),
                    database: node.db().map(str::to_string),
                    schema: Some(schema.to_string()),
                    table: Some(name),
                    has_children: false,
                    column: None,
                }
            })
            .collect())
    }

    /// Columns with everything the data editor needs in one query: type as the server renders it,
    /// nullability, default expression, and whether the column is part of the primary key.
    async fn columns(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("public");
        let table = node.name()?;
        let rows = self
            .text_rows(&format!(
                "SELECT a.attname, \
                        format_type(a.atttypid, a.atttypmod), \
                        CASE WHEN a.attnotnull THEN 'f' ELSE 't' END, \
                        COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), \
                        a.attnum, \
                        CASE WHEN pk.attnum IS NULL THEN 'f' ELSE 't' END, \
                        COALESCE(col_description(a.attrelid, a.attnum), '') \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 LEFT JOIN (SELECT conrelid, unnest(conkey) AS attnum FROM pg_constraint \
                            WHERE contype = 'p') pk \
                   ON pk.conrelid = a.attrelid AND pk.attnum = a.attnum \
                 WHERE n.nspname = {} AND c.relname = {} AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
            ))
            .await?;

        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let data_type = cell(row, 1);
                let nullable = cell(row, 2) == "t";
                let default = cell(row, 3);
                let primary_key = cell(row, 5) == "t";
                let comment = cell(row, 6);
                let mut detail = data_type.clone();
                if primary_key {
                    detail.push_str(" · PK");
                }
                if !nullable {
                    detail.push_str(" · not null");
                }
                if !comment.is_empty() {
                    detail.push_str(&format!(" · {comment}"));
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
                        position: cell(row, 4).parse().unwrap_or_default(),
                    }),
                }
            })
            .collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("public");
        let table = node.name()?;
        let rows = self
            .text_rows(&format!(
                "SELECT indexname, indexdef FROM pg_indexes \
                 WHERE schemaname = {} AND tablename = {} ORDER BY indexname",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| DbNode {
                id: format!("idx:{schema}:{table}:{}", cell(row, 0)),
                kind: DbNodeKind::Index,
                name: cell(row, 0),
                detail: cell(row, 1),
                database: node.db().map(str::to_string),
                schema: Some(schema.to_string()),
                table: Some(table.to_string()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    /// The foreign keys of one table, one row per column pair.
    ///
    /// `unnest(conkey, confkey)` walks the two arrays in step, which is what pairs each column with
    /// the one it points at — a composite key's columns are matched by position, not by name.
    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        let schema = node.schema().unwrap_or("public");
        let table = node.name()?;
        let rows = self
            .text_rows(&format!(
                "SELECT a.attname, rn.nspname, rc.relname, ra.attname \
                 FROM pg_constraint con \
                 JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_class rc ON rc.oid = con.confrelid \
                 JOIN pg_namespace rn ON rn.oid = rc.relnamespace \
                 JOIN LATERAL unnest(con.conkey, con.confkey) AS k(att, ratt) ON true \
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att \
                 JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ratt \
                 WHERE con.contype = 'f' AND n.nspname = {} AND c.relname = {} \
                 ORDER BY con.conname",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
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

    /// A whole schema in two queries: every column of every relation, then every foreign key.
    ///
    /// The first one `LEFT JOIN`s `pg_attribute` so a table with no columns still appears — rare,
    /// but a diagram that silently drops an object is worse than one that draws an empty box.
    /// `relkind` keeps ordinary tables, partitioned tables, foreign tables, views and materialised
    /// views; sequences and indexes have no place on an ER canvas.
    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let schema = node.schema().unwrap_or("public");
        let literal = quote_literal(Some(schema))?;

        let rows = self
            .text_rows(&format!(
                "SELECT c.relname, c.relkind, \
                        COALESCE(a.attname, ''), \
                        COALESCE(format_type(a.atttypid, a.atttypmod), ''), \
                        CASE WHEN a.attnotnull THEN 'f' ELSE 't' END, \
                        CASE WHEN pk.attnum IS NULL THEN 'f' ELSE 't' END, \
                        COALESCE(s.n_live_tup::text, '') \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid \
                 LEFT JOIN pg_attribute a \
                        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                 LEFT JOIN (SELECT conrelid, unnest(conkey) AS attnum FROM pg_constraint \
                            WHERE contype = 'p') pk \
                        ON pk.conrelid = c.oid AND pk.attnum = a.attnum \
                 WHERE n.nspname = {literal} AND c.relkind IN ('r', 'p', 'f', 'v', 'm') \
                 ORDER BY c.relname, a.attnum"
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
                        kind: match cell(row, 1).as_str() {
                            "v" | "m" => DbNodeKind::View,
                            _ => DbNodeKind::Table,
                        },
                        columns: Vec::new(),
                        // The planner's estimate, which is what `pg_stat_all_tables` holds — a
                        // table never analysed reports 0, and that is still the truth about what
                        // the server knows.
                        row_estimate: cell(row, 6).parse().ok(),
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
                data_type: cell(row, 3),
                nullable: cell(row, 4) == "t",
                primary_key: cell(row, 5) == "t",
                foreign_key: false,
            });
        }

        // Sources restricted to this schema, targets not: a key pointing at `auth.users` is a real
        // edge, and the panel draws its far end as a box outside the schema rather than dropping it.
        let edges = self
            .text_rows(&format!(
                "SELECT con.conname, c.relname, a.attname, rn.nspname, rc.relname, ra.attname \
                 FROM pg_constraint con \
                 JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_class rc ON rc.oid = con.confrelid \
                 JOIN pg_namespace rn ON rn.oid = rc.relnamespace \
                 JOIN LATERAL unnest(con.conkey, con.confkey) AS k(att, ratt) ON true \
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att \
                 JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ratt \
                 WHERE con.contype = 'f' AND n.nspname = {literal} \
                 ORDER BY con.conname"
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
        let schema = node.schema().unwrap_or("public");
        let table = node.name()?;
        let rows = self
            .text_rows(&format!(
                "SELECT con.conname, pg_get_constraintdef(con.oid) \
                 FROM pg_constraint con \
                 JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {} AND c.relname = {} \
                 ORDER BY con.contype, con.conname",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| DbNode {
                id: format!("key:{schema}:{table}:{}", cell(row, 0)),
                kind: DbNodeKind::Key,
                name: cell(row, 0),
                detail: cell(row, 1),
                database: node.db().map(str::to_string),
                schema: Some(schema.to_string()),
                table: Some(table.to_string()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    // ----------------------------------------------------------------- data

    pub async fn table_data(
        &self,
        request: &DbTableDataRequest,
    ) -> Result<DbStatementResult, String> {
        let sql = sqlgen::select_page(
            &request.node,
            DIALECT,
            &request.filter,
            &request.sort,
            request.offset,
            request.limit,
        )?;
        let ctx = DbExecContext {
            database: request.node.database.clone(),
            schema: None,
            // One over the page, so "is there a next page" is answered by the fetch itself instead
            // of by a second `COUNT(*)`.
            max_rows: request.limit.saturating_add(1),
        };
        let mut result = self.run_one(&sql, &ctx).await;
        if let Some(error) = result.error {
            return Err(error);
        }
        if result.rows.len() > request.limit as usize {
            result.rows.truncate(request.limit as usize);
            result.truncated = true;
        }
        // The column types the grid needs for editing don't come back with a simple query, so they
        // are filled in from the catalog — the same walk the explorer does.
        if let Ok(columns) = self.columns(&request.node).await {
            annotate_types(&mut result, &columns);
        }
        Ok(result)
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        let sql = sqlgen::count_rows(node, DIALECT, filter)?;
        Ok(self.scalar(&sql).await?.and_then(|v| v.parse().ok()).unwrap_or_default())
    }

    /// Applies the grid's pending edits in one transaction.
    ///
    /// All or nothing: a data editor that half-applies eight changes leaves the user with no idea
    /// which four landed. On any failure the whole thing rolls back and the offending statement is
    /// reported with its own error.
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

        self.client.simple_query("BEGIN").await.map_err(pg_error)?;
        let mut applied = 0u32;
        for statement in &statements {
            if let Err(e) = self.client.simple_query(statement).await {
                let _ = self.client.simple_query("ROLLBACK").await;
                return Ok(DbEditResult {
                    applied: 0,
                    statements: statements.clone(),
                    error: Some(format!("{}\n\n{statement}", pg_error(e))),
                });
            }
            applied += 1;
        }
        self.client.simple_query("COMMIT").await.map_err(pg_error)?;
        Ok(DbEditResult {
            applied,
            statements,
            error: None,
        })
    }

    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        let schema = node.schema().unwrap_or("public");
        let name = node.name()?;

        match node.kind {
            DbNodeKind::View => {
                let sql = self
                    .scalar(&format!(
                        "SELECT pg_get_viewdef(format('%I.%I', {}, {})::regclass, true)",
                        quote_literal(Some(schema))?,
                        quote_literal(Some(name))?
                    ))
                    .await?
                    .unwrap_or_default();
                Ok(format!(
                    "CREATE OR REPLACE VIEW {}.{} AS\n{sql}",
                    quote_ident(schema, DIALECT),
                    quote_ident(name, DIALECT)
                ))
            }
            DbNodeKind::Routine => {
                // `::regproc`, not `::regprocedure`: the node ref carries the bare name without its
                // argument list, and `regprocedure` requires one. The cost is that an overloaded
                // name is ambiguous and errors — which is the honest outcome, rather than picking
                // one of the overloads and presenting it as the definition of the other.
                let signature = format!("{schema}.{name}");
                self.scalar(&format!(
                    "SELECT pg_get_functiondef({}::regproc)",
                    quote_literal(Some(&signature))?
                ))
                .await
                .map(|v| v.unwrap_or_default())
            }
            _ => {
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
                    if !index.detail.is_empty() {
                        ddl.push_str(&format!("\n\n{};", index.detail));
                    }
                }
                for key in self.keys(node).await.unwrap_or_default() {
                    ddl.push_str(&format!(
                        "\n\nALTER TABLE {}.{} ADD CONSTRAINT {} {};",
                        quote_ident(schema, DIALECT),
                        quote_ident(name, DIALECT),
                        quote_ident(&key.name, DIALECT),
                        key.detail
                    ));
                }
                Ok(ddl)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers shared with the other SQL drivers
// ---------------------------------------------------------------------------

/// Copies the catalog's type names onto a result set's columns, matched by name.
///
/// A result whose columns came from `SELECT *` on one table can be typed from that table's
/// catalog entry; a join or an expression can't, and those columns keep an empty type — which the
/// grid reads as "display as text, don't offer to edit".
pub(super) fn annotate_types(result: &mut DbStatementResult, columns: &[DbNode]) {
    for column in result.columns.iter_mut() {
        if let Some(node) = columns.iter().find(|c| c.name == column.name) {
            if let Some(info) = &node.column {
                column.type_name = info.data_type.clone();
            }
        }
    }
}

/// The four grouping rows under a schema. Built here rather than queried: which folders a schema
/// has is a property of the engine, not of the server.
pub(super) fn schema_folders(node: &DbNodeRef) -> Vec<DbNode> {
    let schema = node.schema().unwrap_or_default().to_string();
    let database = node.db().map(str::to_string);
    [
        (DbNodeKind::TableFolder, "Tables"),
        (DbNodeKind::ViewFolder, "Views"),
        (DbNodeKind::RoutineFolder, "Routines"),
        (DbNodeKind::SequenceFolder, "Sequences"),
    ]
    .into_iter()
    .map(|(kind, name)| DbNode {
        id: format!("folder:{schema}:{name}"),
        kind,
        name: name.to_string(),
        detail: String::new(),
        database: database.clone(),
        schema: Some(schema.clone()),
        table: None,
        has_children: true,
        column: None,
    })
    .collect()
}

/// Columns / indexes / keys under a table.
pub(super) fn relation_folders(node: &DbNodeRef) -> Vec<DbNode> {
    let schema = node.schema().map(str::to_string);
    let table = node.name.clone().unwrap_or_default();
    let database = node.db().map(str::to_string);
    [
        (DbNodeKind::ColumnFolder, "Columns"),
        (DbNodeKind::IndexFolder, "Indexes"),
        (DbNodeKind::KeyFolder, "Keys"),
    ]
    .into_iter()
    .map(|(kind, name)| DbNode {
        id: format!("folder:{}:{table}:{name}", schema.clone().unwrap_or_default()),
        kind,
        name: name.to_string(),
        detail: String::new(),
        database: database.clone(),
        schema: schema.clone(),
        table: Some(table.clone()),
        has_children: true,
        column: None,
    })
    .collect()
}

pub(super) fn cell(row: &[Option<String>], index: usize) -> String {
    row.get(index).cloned().flatten().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Connection plumbing
// ---------------------------------------------------------------------------

/// Postgres wraps a server error in its own type whose `Display` is already the sentence the
/// server sent; what it drops is the detail and hint lines, which are often the actionable part.
fn pg_error(error: tokio_postgres::Error) -> String {
    let Some(db) = error.as_db_error() else {
        return match crate::api::root_cause(&error) {
            Some(cause) => cause,
            None => error.to_string(),
        };
    };
    let mut message = db.message().to_string();
    if let Some(detail) = db.detail() {
        message.push_str(&format!("\n{detail}"));
    }
    if let Some(hint) = db.hint() {
        message.push_str(&format!("\nHint: {hint}"));
    }
    if let Some(position) = db.position() {
        message.push_str(&format!("\n(at {position:?})"));
    }
    message
}

fn pg_config(
    config: &DbConnectionConfig,
    database: Option<&str>,
) -> Result<tokio_postgres::Config, String> {
    let mut pg = if config.url.trim().is_empty() {
        let mut pg = tokio_postgres::Config::new();
        pg.host(&config.host).port(config.effective_port());
        if !config.user.is_empty() {
            pg.user(&config.user);
        }
        if !config.password.is_empty() {
            pg.password(&config.password);
        }
        if !config.database.is_empty() {
            pg.dbname(&config.database);
        }
        pg
    } else {
        // A pasted URI wins outright: it is what the provider handed the user, and re-deriving it
        // from six fields is where a `?sslmode=` or a percent-encoded password gets lost.
        config
            .url
            .trim()
            .parse::<tokio_postgres::Config>()
            .map_err(|e| format!("That connection URL couldn't be parsed: {e}"))?
    };

    if let Some(database) = database.filter(|d| !d.is_empty()) {
        pg.dbname(database);
    }
    // A URI with no password still needs the keychain's, and `Config::parse` leaves it unset.
    if pg.get_password().is_none() && !config.password.is_empty() {
        pg.password(&config.password);
    }
    for (key, value) in &config.options {
        if key.eq_ignore_ascii_case("application_name") && !value.is_empty() {
            pg.application_name(value);
        }
    }
    Ok(pg)
}

/// The TLS stack for an encrypted connection.
///
/// `VerifyFull` trusts the OS certificate store, falling back to the bundled Mozilla roots when
/// the platform store can't be read — a self-hosted server is usually signed by a company CA only
/// the OS knows about, and a hosted one (Supabase, RDS) by a public CA in the bundle.
fn tls_connector(
    config: &DbConnectionConfig,
) -> Result<tokio_postgres_rustls::MakeRustlsConnect, String> {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));

    if config.ssl == DbSslMode::VerifyFull {
        // The shortcut, for the common case of a public or OS-known CA and no client certificate.
        // Kept because it is also the path that works when the config names no files at all.
        //
        // The key is checked as well as the certificate: a key on its own is a half-filled form,
        // and taking the shortcut past it would silently ignore something the user typed.
        if config.ssl_ca_file.trim().is_empty()
            && config.ssl_cert_file.trim().is_empty()
            && config.ssl_key_file.trim().is_empty()
        {
            return Ok(tokio_postgres_rustls::MakeRustlsConnect::with_native_certs()
                .map(|(connector, _errors)| connector)
                .unwrap_or_else(|_| tokio_postgres_rustls::MakeRustlsConnect::with_webpki_roots()));
        }
        let builder = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(root_store(config)?);
        return Ok(tokio_postgres_rustls::MakeRustlsConnect::new(with_client_auth(
            builder, config,
        )?));
    }

    // `Require` means "encrypt, don't validate" — the mode a dev server with a self-signed
    // certificate needs. Signature checking stays on, so a genuinely broken peer still fails.
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)));
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(with_client_auth(builder, config)?))
}

/// The roots to trust: the platform's, plus the CA file when one is named.
///
/// *Plus*, not *instead of*. A private CA is almost always an addition to the public ones — the
/// database is behind it, the rest of the world isn't — and replacing the store would break every
/// other name the same connection might have to verify.
fn root_store(config: &DbConnectionConfig) -> Result<rustls::RootCertStore, String> {
    let mut roots = rustls::RootCertStore::empty();
    for certificate in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(certificate);
    }
    let path = config.ssl_ca_file.trim();
    if !path.is_empty() {
        let pem = std::fs::read(path)
            .map_err(|e| format!("couldn't read the CA file at {path}: {e}"))?;
        let mut reader = std::io::BufReader::new(pem.as_slice());
        let mut added = 0usize;
        for certificate in rustls_pemfile::certs(&mut reader) {
            let certificate =
                certificate.map_err(|e| format!("{path} isn't a readable PEM certificate: {e}"))?;
            roots.add(certificate).map_err(|e| format!("{path} was rejected: {e}"))?;
            added += 1;
        }
        if added == 0 {
            return Err(format!("{path} holds no certificates."));
        }
    }
    Ok(roots)
}

/// Attaches the client certificate, when the connection names one.
///
/// Both halves or neither: a certificate without its key cannot authenticate anything, and saying
/// so here is better than a TLS handshake that fails with the server's opinion of the problem.
fn with_client_auth(
    builder: rustls::ConfigBuilder<rustls::ClientConfig, rustls::client::WantsClientCert>,
    config: &DbConnectionConfig,
) -> Result<rustls::ClientConfig, String> {
    let cert_path = config.ssl_cert_file.trim();
    let key_path = config.ssl_key_file.trim();
    if cert_path.is_empty() && key_path.is_empty() {
        return Ok(builder.with_no_client_auth());
    }
    if cert_path.is_empty() || key_path.is_empty() {
        return Err(
            "A client certificate needs both the certificate and its private key. Fill in the \
             missing one, or clear both."
                .to_string(),
        );
    }

    let cert_pem = std::fs::read(cert_path)
        .map_err(|e| format!("couldn't read the client certificate at {cert_path}: {e}"))?;
    let certificates = rustls_pemfile::certs(&mut std::io::BufReader::new(cert_pem.as_slice()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("{cert_path} isn't a readable PEM certificate: {e}"))?;
    if certificates.is_empty() {
        return Err(format!("{cert_path} holds no certificates."));
    }

    let key_pem = std::fs::read(key_path)
        .map_err(|e| format!("couldn't read the client key at {key_path}: {e}"))?;
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(key_pem.as_slice()))
        .map_err(|e| format!("couldn't read the client key at {key_path}: {e}"))?
        .ok_or_else(|| {
            format!("{key_path} holds no private key. An encrypted key has to be decrypted first.")
        })?;

    builder
        .with_client_auth_cert(certificates, key)
        .map_err(|e| format!("the client certificate and key were rejected: {e}"))
}

/// Drives the connection and collects the server's out-of-band messages.
///
/// `connection.await` would be shorter, but it discards `AsyncMessage`s — and those carry every
/// `NOTICE` a function raised. Polling explicitly is what lets `messages` on a result be real.
fn spawn_driver<S, T>(
    connection: tokio_postgres::Connection<S, T>,
    alive: Arc<AtomicBool>,
    notices: Arc<Mutex<Vec<String>>>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio_postgres::tls::TlsStream + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut connection = connection;
        let mut stream =
            futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        while let Some(message) = stream.next().await {
            match message {
                Ok(AsyncMessage::Notice(notice)) => {
                    if let Ok(mut queue) = notices.lock() {
                        // Bounded: a loop raising a notice per iteration must not grow this
                        // without limit while nothing drains it.
                        if queue.len() < 500 {
                            queue.push(format!("{}: {}", notice.severity(), notice.message()));
                        }
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        alive.store(false, Ordering::Relaxed);
    });
}

/// Reachable only when the connection asked for encryption without validation.
#[derive(Debug)]
struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::DbSslMode;

    fn config() -> DbConnectionConfig {
        DbConnectionConfig {
            id: "c".into(),
            kind: DbKind::Postgres,
            host: "localhost".into(),
            port: 0,
            database: "app".into(),
            user: "postgres".into(),
            password: String::new(),
            url: String::new(),
            ssl: DbSslMode::VerifyFull,
            options: Vec::new(),
            read_only: false,
            connect_timeout_ms: 0,
            show_all_databases: false,
            visible_schemas: Vec::new(),
            schemas_filtered: false,
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

    /// Half a client certificate authenticates nothing. Saying so here beats a TLS handshake that
    /// fails with the server's opinion of what went wrong.
    #[test]
    fn a_client_certificate_needs_both_halves() {
        let mut config = config();
        config.ssl_cert_file = "/tmp/client.pem".into();
        let refused = tls_connector(&config).err().expect("half a certificate is refused");
        assert!(refused.contains("private key"), "{refused}");

        config.ssl_cert_file = String::new();
        config.ssl_key_file = "/tmp/client.key".into();
        let refused = tls_connector(&config).err().expect("half a certificate is refused");
        assert!(refused.contains("certificate"), "{refused}");
    }

    /// A CA path that isn't there has to be reported as that, and not as a connection failure ten
    /// seconds later.
    #[test]
    fn a_missing_ca_file_is_named() {
        let mut config = config();
        config.ssl_ca_file = "/nowhere/ca.pem".into();
        let refused = tls_connector(&config).err().expect("a missing CA file is refused");
        assert!(refused.contains("/nowhere/ca.pem"), "{refused}");
    }
}
