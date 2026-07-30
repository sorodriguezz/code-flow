//! InterSystems IRIS, over **JDBC**.
//!
//! IRIS has no pure-Rust driver and no third-party implementation of its superserver protocol. Its
//! one real client is the InterSystems Type 4 JDBC driver, which is Java — so this file is a client
//! of [`super::jvm`], a single `java` process running `com.codeflow.iris.IrisBridge` that CodeFlow
//! spawns on the first IRIS connection and shuts down when the last one closes. Both the trimmed
//! runtime and the driver jar ship inside the app, so nothing has to be installed for this to work.
//!
//! Going through JDBC rather than the Atelier REST API (which this replaces) is what makes IRIS a
//! first-class engine in the workspace instead of an approximation of one:
//!
//! - **The data editor gets a real transaction.** REST is stateless, so "Apply" used to be a series
//!   of independent writes that could stop half-done. Edits now run inside one
//!   `setAutoCommit(false) … commit()` and roll back together.
//! - **Cancel reaches the server.** `Statement.cancel()` stops the query where it runs, so IRIS
//!   joins Postgres as an engine where the Cancel button means something, rather than only dropping
//!   our end of the call.
//! - **Writes report what they touched.** `getUpdateCount()` is a real affected-row count, which
//!   the REST endpoint never returned.
//! - **Columns arrive typed and in order**, from `ResultSetMetaData`, instead of being recovered
//!   from the key order of a JSON object.
//!
//! It also moves the port: JDBC talks to the **superserver on 1972**, not the web server on 52773.
//! A connection still pointed at the old port is caught in [`IrisSession::open`] and told so.
//!
//! Every value still crosses as text — the Java side reads each column with `getString`, which is
//! the same invariant the other four drivers hold.

use std::sync::Arc;

use serde_json::{Map, Value};

use super::jvm::{self, Bridge};
use super::postgres::{annotate_types, cell, relation_folders, schema_folders};
use super::sqlgen::{self, quote_ident, quote_literal};
use super::{
    read_only_guard, read_only_refusal, split_statements, DbColumn, DbColumnInfo,
    DbConnectionConfig, DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbEditResult, DbExecContext,
    DbExecuteResult, DbForeignKey, DbKind, DbNode, DbNodeKind, DbNodeRef, DbRowEdit,
    DbSchemaDiagram, DbServerInfo, DbSslMode, DbStatementResult,
    DbTableDataRequest, SqlDialect,
};

const DIALECT: SqlDialect = SqlDialect::Iris;

/// The port the Atelier REST driver used. A saved connection that still names it is pointed at the
/// web server, which speaks HTTP and will never answer a JDBC handshake.
const WEB_SERVER_PORT: u16 = 52773;

pub struct IrisSession {
    bridge: Arc<Bridge>,
    /// Identifies this connection inside the shared JVM. One per connection *and* namespace,
    /// because a JDBC URL names its namespace and cannot be switched afterwards.
    session_id: String,
    namespace: String,
    user: String,
    version: String,
    driver: String,
    /// Namespaces this instance has, when it would tell us. Empty means the tree shows just the one
    /// we are connected to, which is truer than showing a list we had to guess at.
    namespaces: Vec<String>,
    read_only: bool,
    /// Set when the connection asked for TLS, since the driver's idea of it differs from the other
    /// engines' and the difference belongs in front of the user rather than in this comment alone.
    tls_note: Option<String>,
    /// Connection options that aren't JDBC properties — leftovers from the REST driver, named so
    /// the user can delete them rather than wonder why they stopped mattering.
    ignored_options: Vec<String>,
}

impl IrisSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();

        let namespace = database
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if config.database.is_empty() {
                    "USER".to_string()
                } else {
                    config.database.clone()
                }
            });

        let bridge = jvm::bridge().await?;
        let session_id = format!("{}#{namespace}", config.id);
        let (properties, ignored_options) = driver_properties(&config);

        let mut request = Map::new();
        request.insert("url".into(), Value::from(jdbc_url(&config, &namespace)));
        request.insert("user".into(), Value::from(config.user.clone()));
        // Over a pipe to a child process, never on its command line — argv is world-readable.
        request.insert("password".into(), Value::from(config.password.clone()));
        request.insert("readOnly".into(), Value::from(config.read_only));
        request.insert(
            "timeoutMs".into(),
            Value::from(config.connect_timeout().as_millis() as u64),
        );
        request.insert("properties".into(), Value::Object(properties));

        let answer = bridge
            .call("open", &session_id, request)
            .await
            .map_err(|e| explain_connect_failure(&config, &e))?;
        bridge.session_opened();

        let mut session = Self {
            bridge,
            session_id,
            namespace,
            user: text(&answer, "user").unwrap_or_else(|| config.user.clone()),
            version: text(&answer, "version").unwrap_or_default(),
            driver: text(&answer, "driver").unwrap_or_default(),
            namespaces: Vec::new(),
            read_only: config.read_only,
            tls_note: tls_note(&config),
            ignored_options,
        };
        session.namespaces = session.list_namespaces().await;
        Ok(session)
    }

    pub fn info(&self) -> DbServerInfo {
        let mut notes = Vec::new();
        if !self.driver.is_empty() {
            notes.push(self.driver.clone());
        }
        if let Some(tls) = &self.tls_note {
            notes.push(tls.clone());
        }
        if !self.ignored_options.is_empty() {
            notes.push(format!(
                "These connection options aren't JDBC properties and were ignored: {}. They were \
                 needed by the older REST-based driver and can be removed.",
                self.ignored_options.join(", ")
            ));
        }
        DbServerInfo {
            kind: DbKind::Iris,
            version: self.version.clone(),
            database: self.namespace.clone(),
            user: self.user.clone(),
            notes,
        }
    }

    /// False once the JVM is gone, so the registry opens a fresh session instead of handing back
    /// one whose every statement would fail.
    pub fn is_alive(&self) -> bool {
        self.bridge.is_alive()
    }

    // ------------------------------------------------------------------ wire

    /// Runs one statement and returns the bridge's raw answer.
    async fn run(&self, sql: &str, max_rows: Option<usize>) -> Result<Value, String> {
        let mut request = Map::new();
        request.insert("sql".into(), Value::from(sql));
        request.insert("maxRows".into(), Value::from(max_rows.unwrap_or(0) as u64));
        self.bridge.call("exec", &self.session_id, request).await
    }

    /// Runs one statement as a console would: a failure becomes the result's `error` rather than
    /// the call's, so a batch can report "three ran, the fourth failed here".
    async fn statement(&self, sql: &str, max_rows: Option<usize>) -> DbStatementResult {
        match self.run(sql, max_rows).await {
            Ok(answer) => decode_statement(sql, &answer),
            Err(error) => DbStatementResult::failed(sql, error),
        }
    }

    /// Rows only, with a failure as a real error. Every catalog query goes through this.
    async fn rows(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
        let answer = self.run(sql, None).await?;
        Ok(decode_statement(sql, &answer).rows)
    }

    async fn scalar(&self, sql: &str) -> Result<Option<String>, String> {
        Ok(self.rows(sql).await?.first().and_then(|row| row.first().cloned()).flatten())
    }

    /// Asks the server to abandon whatever this session is running.
    pub async fn cancel_running(&self) {
        let _ = self.bridge.call("cancel", &self.session_id, Map::new()).await;
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        let mut results = Vec::new();
        for statement in split_statements(sql, Some(DIALECT)) {
            if let Err(refused) = read_only_guard(&statement, self.read_only) {
                results.push(DbStatementResult::failed(&statement, refused));
                break;
            }
            let result = self.statement(&statement, ctx.limit()).await;
            let failed = result.error.is_some();
            results.push(result);
            if failed {
                break;
            }
        }
        Ok(DbExecuteResult {
            results,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// IRIS's plan comes from `EXPLAIN`, which returns it as an XML document in one cell.
    pub async fn explain(&self, sql: &str, _ctx: &DbExecContext) -> Result<String, String> {
        let statement = split_statements(sql, Some(DIALECT))
            .into_iter()
            .next()
            .ok_or_else(|| "There is no statement to explain.".to_string())?;
        let result = self.statement(&format!("EXPLAIN {statement}"), None).await;
        if let Some(error) = result.error {
            return Err(error);
        }
        Ok(result
            .rows
            .iter()
            .flat_map(|row| row.iter().flatten().cloned())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    // ------------------------------------------------------------ introspect

    /// The namespaces this instance has.
    ///
    /// `%SYS.Namespace_List()` is the SQL projection of the class query every IRIS instance ships,
    /// but reaching it needs privileges a locked-down account may not have — and an account that
    /// can read one namespace's tables is still a useful connection. So a refusal here is not an
    /// error: the tree falls back to showing the one namespace we are connected to.
    async fn list_namespaces(&self) -> Vec<String> {
        let Ok(rows) = self.rows("SELECT Nsp FROM %SYS.Namespace_List()").await else {
            return Vec::new();
        };
        rows.iter()
            .filter_map(|row| row.first().cloned().flatten())
            .filter(|name| !name.is_empty())
            .collect()
    }

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => Ok(self.namespace_nodes()),
            DbNodeKind::Database => self.schemas(node).await,
            DbNodeKind::Schema => Ok(schema_folders(node)),
            DbNodeKind::TableFolder => self.relations(node, "BASE TABLE").await,
            DbNodeKind::ViewFolder => self.relations(node, "VIEW").await,
            DbNodeKind::RoutineFolder => self.routines(node).await,
            // IRIS has no sequences of its own; identity columns do the job, and an empty folder is
            // a truer answer than a folder that errors.
            DbNodeKind::SequenceFolder => Ok(Vec::new()),
            DbNodeKind::Table | DbNodeKind::View => Ok(relation_folders(node)),
            DbNodeKind::ColumnFolder => self.columns(node).await,
            DbNodeKind::IndexFolder => self.indexes(node).await,
            DbNodeKind::KeyFolder => self.keys(node).await,
            _ => Ok(Vec::new()),
        }
    }

    fn namespace_nodes(&self) -> Vec<DbNode> {
        let mut names = self.namespaces.clone();
        if names.is_empty() {
            names.push(self.namespace.clone());
        }
        names
            .iter()
            .map(|name| DbNode {
                id: format!("ns:{name}"),
                kind: DbNodeKind::Database,
                name: name.clone(),
                detail: String::new(),
                database: Some(name.clone()),
                schema: None,
                table: None,
                has_children: true,
                column: None,
            })
            .collect()
    }

    async fn schemas(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let rows = self
            .rows(
                "SELECT DISTINCT TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA",
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

    async fn relations(&self, node: &DbNodeRef, table_type: &str) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("SQLUser");
        let rows = self
            .rows(&format!(
                "SELECT TABLE_NAME, CLASSNAME FROM INFORMATION_SCHEMA.TABLES \
                 WHERE TABLE_SCHEMA = {} AND TABLE_TYPE = {} ORDER BY TABLE_NAME",
                quote_literal(Some(schema))?,
                quote_literal(Some(table_type))?
            ))
            .await?;
        let kind = if table_type == "VIEW" { DbNodeKind::View } else { DbNodeKind::Table };
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("rel:{schema}:{name}"),
                    kind,
                    name: name.clone(),
                    // The class a table is projected from — the thing to open in Studio or VS Code,
                    // and the piece of context no other engine's explorer has to show.
                    detail: cell(row, 1),
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
        let schema = node.schema().unwrap_or("SQLUser");
        let rows = self
            .rows(&format!(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES \
                 WHERE ROUTINE_SCHEMA = {} ORDER BY ROUTINE_NAME",
                quote_literal(Some(schema))?
            ))
            .await
            .unwrap_or_default();
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("routine:{schema}:{name}"),
                    kind: DbNodeKind::Routine,
                    name: name.clone(),
                    detail: cell(row, 1).to_lowercase(),
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
        let schema = node.schema().unwrap_or("SQLUser");
        let table = node.name()?;
        let rows = self
            .rows(&format!(
                "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
                        c.ORDINAL_POSITION, c.CHARACTER_MAXIMUM_LENGTH, \
                        c.NUMERIC_PRECISION, c.NUMERIC_SCALE, \
                        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                         WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
                           AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME %STARTSWITH 'PK') \
                 FROM INFORMATION_SCHEMA.COLUMNS c \
                 WHERE c.TABLE_SCHEMA = {} AND c.TABLE_NAME = {} \
                 ORDER BY c.ORDINAL_POSITION",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
            ))
            .await?;

        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let data_type = iris_type_name(
                    &cell(row, 1),
                    cell(row, 5).parse().ok(),
                    cell(row, 6).parse().ok(),
                    cell(row, 7).parse().ok(),
                );
                let nullable = cell(row, 2).eq_ignore_ascii_case("YES") || cell(row, 2) == "1";
                let default = cell(row, 3);
                let primary_key = cell(row, 8).parse::<i64>().unwrap_or(0) > 0;
                let mut detail = data_type.clone();
                if primary_key {
                    detail.push_str(" · PK");
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
                        position: cell(row, 4).parse().unwrap_or_default(),
                    }),
                }
            })
            .collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("SQLUser");
        let table = node.name()?;
        let rows = self
            .rows(&format!(
                "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, PRIMARY_KEY \
                 FROM INFORMATION_SCHEMA.INDEXES \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
                 ORDER BY INDEX_NAME, ORDINAL_POSITION",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
            ))
            .await?;

        // One row per indexed column; the tree wants one node per index.
        let mut grouped: Vec<(String, Vec<String>, bool)> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let column = cell(row, 1);
            let unique = cell(row, 2) == "0" || cell(row, 2).eq_ignore_ascii_case("NO");
            match grouped.iter_mut().find(|(existing, _, _)| *existing == name) {
                Some((_, columns, _)) => columns.push(column),
                None => grouped.push((name, vec![column], unique)),
            }
        }
        Ok(grouped
            .into_iter()
            .map(|(name, columns, unique)| DbNode {
                id: format!("idx:{schema}:{table}:{name}"),
                kind: DbNodeKind::Index,
                name: name.clone(),
                detail: format!("{}({})", if unique { "unique " } else { "" }, columns.join(", ")),
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
    /// Through `REFERENTIAL_CONSTRAINTS`, which is the standard catalog's way of saying "this key
    /// points at that one": the second join back into `KEY_COLUMN_USAGE` resolves the referenced
    /// constraint into the columns it is made of, matched to ours by ordinal.
    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        let schema = node.schema().unwrap_or("SQLUser");
        let table = node.name()?;
        let rows = self
            .rows(&format!(
                "SELECT k.COLUMN_NAME, t.TABLE_SCHEMA, t.TABLE_NAME, t.COLUMN_NAME \
                 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                 JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r \
                   ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
                  AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
                 JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE t \
                   ON t.CONSTRAINT_NAME = r.UNIQUE_CONSTRAINT_NAME \
                  AND t.CONSTRAINT_SCHEMA = r.UNIQUE_CONSTRAINT_SCHEMA \
                  AND t.ORDINAL_POSITION = k.ORDINAL_POSITION \
                 WHERE k.TABLE_SCHEMA = {} AND k.TABLE_NAME = {} \
                 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
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

    /// A whole schema in two queries, from the standard catalog.
    ///
    /// No row estimate: IRIS keeps its counts in the class's storage definition rather than in
    /// `INFORMATION_SCHEMA`, and a `COUNT(*)` per table is exactly what
    /// [`super::DbSchemaDiagram`] says this must never do. The panel simply omits the figure rather
    /// than showing a zero it can't stand behind.
    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let schema = node.schema().unwrap_or("SQLUser");
        let literal = quote_literal(Some(schema))?;

        // `%STARTSWITH 'PK'` is the same primary-key test the column list uses: IRIS names the
        // constraint after the class, and its own catalog offers no flag for it.
        let rows = self
            .rows(&format!(
                "SELECT c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, \
                        c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, \
                        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                         WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
                           AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME %STARTSWITH 'PK') \
                 FROM INFORMATION_SCHEMA.COLUMNS c \
                 JOIN INFORMATION_SCHEMA.TABLES t \
                   ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
                 WHERE c.TABLE_SCHEMA = {literal} \
                 ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
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
                        kind: if cell(row, 1).eq_ignore_ascii_case("VIEW") {
                            DbNodeKind::View
                        } else {
                            DbNodeKind::Table
                        },
                        columns: Vec::new(),
                        row_estimate: None,
                    });
                    tables.last_mut().expect("just pushed")
                }
            };
            let nullable = cell(row, 4);
            table.columns.push(DbDiagramColumn {
                name: cell(row, 2),
                data_type: iris_type_name(
                    &cell(row, 3),
                    cell(row, 5).parse().ok(),
                    cell(row, 6).parse().ok(),
                    cell(row, 7).parse().ok(),
                ),
                nullable: nullable.eq_ignore_ascii_case("YES") || nullable == "1",
                primary_key: cell(row, 8).parse::<i64>().unwrap_or(0) > 0,
                foreign_key: false,
            });
        }

        let edges = self
            .rows(&format!(
                "SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, \
                        t.TABLE_SCHEMA, t.TABLE_NAME, t.COLUMN_NAME \
                 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                 JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r \
                   ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
                  AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
                 JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE t \
                   ON t.CONSTRAINT_NAME = r.UNIQUE_CONSTRAINT_NAME \
                  AND t.CONSTRAINT_SCHEMA = r.UNIQUE_CONSTRAINT_SCHEMA \
                  AND t.ORDINAL_POSITION = k.ORDINAL_POSITION \
                 WHERE k.TABLE_SCHEMA = {literal} \
                 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
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
        let schema = node.schema().unwrap_or("SQLUser");
        let table = node.name()?;
        let rows = self
            .rows(&format!(
                "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE \
                 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY CONSTRAINT_NAME",
                quote_literal(Some(schema))?,
                quote_literal(Some(table))?
            ))
            .await
            .unwrap_or_default();
        Ok(rows
            .iter()
            .map(|row| DbNode {
                id: format!("key:{schema}:{table}:{}", cell(row, 0)),
                kind: DbNodeKind::Key,
                name: cell(row, 0),
                detail: cell(row, 1).to_lowercase(),
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
        let answer = self.run(&sql, Some(request.limit as usize)).await?;
        let mut result = decode_statement(&sql, &answer);
        if let Some(error) = result.error {
            return Err(error);
        }
        // The `%VID` paging trick adds a bookkeeping column; it is an artefact of how the window
        // was taken, not part of the table.
        if let Some(index) =
            result.columns.iter().position(|c| c.name.eq_ignore_ascii_case("cf_vid"))
        {
            result.columns.remove(index);
            for row in result.rows.iter_mut() {
                if index < row.len() {
                    row.remove(index);
                }
            }
        }
        // The catalog knows `VARCHAR(50)` where the result set only knows `VARCHAR`, so the richer
        // name wins when it is available.
        if let Ok(columns) = self.columns(&request.node).await {
            annotate_types(&mut result, &columns);
        }
        Ok(result)
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        let sql = sqlgen::count_rows(node, DIALECT, filter)?;
        Ok(self
            .scalar(&sql)
            .await?
            .and_then(|value| value.parse().ok())
            .unwrap_or_default())
    }

    /// Applies the grid's edits as one transaction.
    ///
    /// The REST driver this replaced could not do that — a stateless request has no session to hold
    /// a transaction open in, so its `applied` count was "how far it got before something broke".
    /// Here the whole batch commits or none of it does, which is what the preview in the UI has
    /// always implied.
    pub async fn apply_edits(
        &self,
        node: &DbNodeRef,
        edits: &[DbRowEdit],
    ) -> Result<DbEditResult, String> {
        if self.read_only {
            return Err(read_only_refusal());
        }
        let statements = edits
            .iter()
            .map(|edit| sqlgen::edit_statement(node, DIALECT, edit))
            .collect::<Result<Vec<String>, String>>()?;

        let mut request = Map::new();
        request.insert("statements".into(), Value::from(statements.clone()));
        request.insert("transactional".into(), Value::from(true));
        let answer = self.bridge.call("batch", &self.session_id, request).await?;

        let applied = answer.get("applied").and_then(Value::as_u64).unwrap_or(0) as u32;
        let error = answer.get("error").and_then(Value::as_str).map(|message| {
            match answer.get("failedStatement").and_then(Value::as_str) {
                Some(statement) if !statement.is_empty() => format!("{message}\n\n{statement}"),
                _ => message.to_string(),
            }
        });
        Ok(DbEditResult {
            applied,
            statements,
            error,
        })
    }

    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        let schema = node.schema().unwrap_or("SQLUser");
        let name = node.name()?;

        if node.kind == DbNodeKind::View {
            if let Ok(Some(definition)) = self
                .scalar(&format!(
                    "SELECT VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS \
                     WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                    quote_literal(Some(schema))?,
                    quote_literal(Some(name))?
                ))
                .await
            {
                return Ok(format!(
                    "CREATE VIEW {}.{} AS\n{definition}",
                    quote_ident(schema, DIALECT),
                    quote_ident(name, DIALECT)
                ));
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
                        info.is_none_or(|i| i.nullable),
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

        // The class name is the part an IRIS developer actually wants: a table here is a projection
        // of a class, and the class is where its real definition lives.
        if let Ok(Some(class)) = self
            .scalar(&format!(
                "SELECT CLASSNAME FROM INFORMATION_SCHEMA.TABLES \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                quote_literal(Some(schema))?,
                quote_literal(Some(name))?
            ))
            .await
        {
            if !class.is_empty() {
                ddl = format!(
                    "-- Projected from class {class}\n-- (this table's definition lives in that \
                     class, not in DDL)\n\n{ddl}"
                );
            }
        }
        for index in self.indexes(node).await.unwrap_or_default() {
            ddl.push_str(&format!("\n\n-- INDEX {} {}", index.name, index.detail));
        }
        Ok(ddl)
    }
}

impl Drop for IrisSession {
    /// Releases the JDBC connection inside the JVM, and lets the JVM itself exit when this was the
    /// last session.
    ///
    /// Detached rather than awaited, because `Drop` cannot be async — and routed through the
    /// bridge's own runtime handle rather than `Handle::current()`, because this drop often happens
    /// on a thread that has no runtime in context: `db_disconnect` is a sync command, and it is the
    /// call that drops the session.
    fn drop(&mut self) {
        self.bridge.close_session_detached(std::mem::take(&mut self.session_id));
    }
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}

/// Turns the bridge's answer into the shape the whole workspace reads.
fn decode_statement(sql: &str, answer: &Value) -> DbStatementResult {
    let mut result = DbStatementResult::empty(sql);

    result.columns = answer
        .get("columns")
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .map(|column| {
                    DbColumn::new(
                        column.get("name").and_then(Value::as_str).unwrap_or_default(),
                        column.get("type").and_then(Value::as_str).unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    result.rows = answer
        .get("rows")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|cell| match cell {
                                    // JSON null is SQL NULL. `Some("")` is an empty string, and the
                                    // two are never interchangeable.
                                    Value::Null => None,
                                    Value::String(text) => Some(text.clone()),
                                    other => Some(other.to_string()),
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default();

    result.truncated = answer.get("truncated").and_then(Value::as_bool).unwrap_or(false);
    result.duration_ms = answer.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
    // JDBC answers -1 for "this statement had no update count", which is not the same as zero rows
    // touched and must not be shown as one.
    result.rows_affected =
        answer.get("rowsAffected").and_then(Value::as_i64).filter(|count| *count >= 0);
    result.messages = answer
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages.iter().filter_map(Value::as_str).map(str::to_string).collect()
        })
        .unwrap_or_default();
    result
}

// ---------------------------------------------------------------------------
// Connection shape
// ---------------------------------------------------------------------------

/// `jdbc:IRIS://host:port/NAMESPACE`.
///
/// A `url` on the connection wins outright, because that is how these are handed out — but it is
/// still pointed at this session's namespace, since the explorer's whole job is walking the others.
fn jdbc_url(config: &DbConnectionConfig, namespace: &str) -> String {
    let trimmed = config.url.trim();
    if !trimmed.is_empty() {
        // The namespace is the segment after the third slash of `jdbc:IRIS://host:port/NS`. Only
        // that segment is replaced — anything past it is the driver's own parameters
        // (`/?log=…`), and dropping those would silently undo the user's configuration.
        let Some(start) = trimmed.match_indices('/').nth(2).map(|(index, _)| index + 1) else {
            return format!("{}/{namespace}", trimmed.trim_end_matches('/'));
        };
        let rest = &trimmed[start..];
        let end = start + rest.find(['/', '?']).unwrap_or(rest.len());
        return format!("{}{namespace}{}", &trimmed[..start], &trimmed[end..]);
    }
    format!("jdbc:IRIS://{}:{}/{namespace}", config.host, config.effective_port())
}

/// The driver's own property names, verified against `IRISDriver.getPropertyInfo`.
///
/// Options are matched against this list rather than passed through wholesale: the driver rejects a
/// property it doesn't know, and a connection that fails because of a stale `path` left over from
/// the REST driver would be a mystery. Anything unmatched is reported in [`IrisSession::info`]
/// instead of being sent.
const DRIVER_PROPERTIES: [&str; 18] = [
    "AccessToken",
    "TCP_NODELAY",
    "SO_SNDBUF",
    "SO_RCVBUF",
    "TransactionIsolationLevel",
    "service principal name",
    "connection security level",
    "SSL configuration name",
    "key recovery password",
    "dialect",
    "autobalance",
    "LoaderPoolSize",
    "PipeJDBC",
    "SharedMemory",
    "SSLContext",
    "log",
    "FeatureOption",
    "NetworkTimeout",
];

/// The JDBC properties for a connection, plus the option keys that aren't any.
fn driver_properties(config: &DbConnectionConfig) -> (Map<String, Value>, Vec<String>) {
    let mut properties = Map::new();
    let mut ignored = Vec::new();

    // 10 is the driver's "SSL/TLS" level; 0 is password authentication over plaintext.
    properties.insert(
        "connection security level".into(),
        Value::from(if config.ssl == DbSslMode::Disable { "0" } else { "10" }),
    );

    for (key, value) in &config.options {
        if key.trim().is_empty() || value.is_empty() {
            continue;
        }
        match DRIVER_PROPERTIES.iter().find(|known| known.eq_ignore_ascii_case(key.trim())) {
            // The driver's own spelling, so a user who typed `sslcontext` still gets `SSLContext`.
            Some(known) => {
                properties.insert((*known).to_string(), Value::from(value.clone()));
            }
            None => ignored.push(key.trim().to_string()),
        }
    }
    (properties, ignored)
}

/// What to say about TLS, when the connection asked for it.
///
/// The other engines draw a line between "encrypt" and "encrypt and verify"; the IRIS driver does
/// not. It always validates against the JVM's truststore, so `Require` is not the escape hatch for
/// a self-signed certificate that it is elsewhere — and saying so up front is better than a
/// handshake failure the user has no way to read.
fn tls_note(config: &DbConnectionConfig) -> Option<String> {
    // Said before anything about the mode, because a user who filled these in believes they are in
    // effect, and silence would leave them debugging a certificate that was never presented.
    let named_files = [
        (&config.ssl_ca_file, "CA file"),
        (&config.ssl_cert_file, "client certificate"),
        (&config.ssl_key_file, "client key"),
    ]
    .into_iter()
    .filter(|(path, _)| !path.trim().is_empty())
    .map(|(_, what)| what)
    .collect::<Vec<_>>();
    if !named_files.is_empty() {
        return Some(format!(
            "The {} set on this connection {} ignored: the InterSystems JDBC driver takes no \
             certificate paths. It verifies against the Java truststore, and a client \
             configuration is selected by adding an \"SSL configuration name\" driver option \
             naming one defined on the IRIS server.",
            named_files.join(", "),
            if named_files.len() == 1 { "is" } else { "are" }
        ));
    }
    match config.ssl {
        DbSslMode::Disable => None,
        DbSslMode::Require => Some(
            "TLS is on. The InterSystems JDBC driver always verifies the server's certificate \
             against the Java truststore, so \"Require\" behaves as \"Verify full\" here — a \
             self-signed certificate needs its CA imported, or an \"SSL configuration name\" \
             option naming a client configuration on the server."
                .to_string(),
        ),
        DbSslMode::VerifyFull => Some(
            "TLS is on, verified against the Java truststore that ships with CodeFlow.".to_string(),
        ),
    }
}

/// Adds the one piece of context a failed IRIS connection usually needs.
///
/// The Atelier REST driver this replaced ran on the web server's port. A connection saved back
/// then still names it, and "connection refused on 52773" is a dead end unless someone points out
/// that JDBC doesn't live there.
fn explain_connect_failure(config: &DbConnectionConfig, error: &str) -> String {
    if config.effective_port() == WEB_SERVER_PORT {
        return format!(
            "Connecting to {} failed: {error}\n\nPort {WEB_SERVER_PORT} is the IRIS web server. \
             CodeFlow now reaches IRIS over JDBC, which talks to the superserver — usually port \
             1972. Change the port in this connection's settings.",
            config.endpoint()
        );
    }
    format!("Connecting to {} failed: {error}", config.endpoint())
}

/// `VARCHAR(50)`, `NUMERIC(18,2)` — the type as IRIS would declare it.
fn iris_type_name(
    base: &str,
    length: Option<i64>,
    precision: Option<i64>,
    scale: Option<i64>,
) -> String {
    let lower = base.to_ascii_lowercase();
    if lower.contains("char") || lower.contains("binary") {
        if let Some(length) = length.filter(|l| *l > 0) {
            return format!("{base}({length})");
        }
    }
    if lower.contains("numeric") || lower.contains("decimal") {
        if let (Some(precision), Some(scale)) = (precision, scale) {
            return format!("{base}({precision},{scale})");
        }
    }
    base.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> DbConnectionConfig {
        DbConnectionConfig {
            id: "c".into(),
            kind: DbKind::Iris,
            host: "iris.local".into(),
            port: 0,
            database: "USER".into(),
            user: "_SYSTEM".into(),
            password: String::new(),
            auth_method: crate::datasource::DbAuthMethod::Password,
            tenant_id: String::new(),
            url: String::new(),
            ssl: DbSslMode::Disable,
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

    /// The default port has to be the superserver's — 52773 is the web server, which never answers
    /// a JDBC handshake.
    #[test]
    fn the_url_targets_the_superserver_and_the_session_namespace() {
        assert_eq!(jdbc_url(&config(), "USER"), "jdbc:IRIS://iris.local:1972/USER");
        assert_eq!(jdbc_url(&config(), "%SYS"), "jdbc:IRIS://iris.local:1972/%SYS");
    }

    /// A pasted URL is written for one namespace, and the explorer's job is walking the others —
    /// so the namespace it names is replaced, not honoured.
    #[test]
    fn a_pasted_url_still_follows_the_explorer() {
        let mut config = config();
        config.url = "jdbc:IRIS://prod.example.com:1972/APP".into();
        assert_eq!(jdbc_url(&config, "APP"), "jdbc:IRIS://prod.example.com:1972/APP");
        assert_eq!(jdbc_url(&config, "%SYS"), "jdbc:IRIS://prod.example.com:1972/%SYS");

        // Driver parameters live past the namespace, and swapping the namespace must not take them
        // with it — losing them would silently undo whatever the user configured.
        config.url = "jdbc:IRIS://h:1972/APP/?log=/tmp/jdbc.log".into();
        assert_eq!(jdbc_url(&config, "%SYS"), "jdbc:IRIS://h:1972/%SYS/?log=/tmp/jdbc.log");

        // A URL with no namespace at all still has to name one — the driver requires it.
        config.url = "jdbc:IRIS://h:1972".into();
        assert_eq!(jdbc_url(&config, "USER"), "jdbc:IRIS://h:1972/USER");
    }

    /// Options are the driver's properties, spelled the driver's way. A leftover from the REST
    /// driver must not be sent — the driver rejects properties it doesn't know.
    #[test]
    fn options_become_driver_properties_and_leftovers_are_reported() {
        let mut config = config();
        config.options = vec![
            ("sslcontext".into(), "mycontext".into()),
            ("path".into(), "/iris".into()),
            ("dialect".into(), "mssql".into()),
            ("empty".into(), String::new()),
        ];
        let (properties, ignored) = driver_properties(&config);
        assert_eq!(properties.get("SSLContext").unwrap(), "mycontext");
        assert_eq!(properties.get("dialect").unwrap(), "mssql");
        assert_eq!(properties.get("connection security level").unwrap(), "0");
        assert_eq!(ignored, vec!["path".to_string()]);
    }

    #[test]
    fn tls_raises_the_security_level() {
        let mut config = config();
        config.ssl = DbSslMode::VerifyFull;
        let (properties, _) = driver_properties(&config);
        assert_eq!(properties.get("connection security level").unwrap(), "10");
    }

    /// A connection still on the old REST port fails in a way nobody could diagnose without being
    /// told the port moved.
    #[test]
    fn the_old_rest_port_is_called_out() {
        let mut config = config();
        config.port = WEB_SERVER_PORT;
        let explained = explain_connect_failure(&config, "Connection refused");
        assert!(explained.contains("1972"), "{explained}");
        assert!(explained.contains("superserver"), "{explained}");

        config.port = 1972;
        assert!(!explain_connect_failure(&config, "Connection refused").contains("superserver"));
    }

    /// NULL and the empty string are different values, and a grid that confuses them writes the
    /// wrong one back.
    #[test]
    fn null_and_empty_stay_distinct() {
        let answer = serde_json::json!({
            "columns": [{"name": "Name", "type": "VARCHAR"}, {"name": "Note", "type": "VARCHAR"}],
            "rows": [["Ana", null], ["", "x"]],
            "truncated": false,
            "rowsAffected": null,
            "durationMs": 3,
            "messages": []
        });
        let result = decode_statement("SELECT 1", &answer);
        assert_eq!(result.columns[0].type_name, "VARCHAR");
        assert_eq!(result.rows[0][0], Some("Ana".to_string()));
        assert_eq!(result.rows[0][1], None);
        assert_eq!(result.rows[1][0], Some(String::new()));
        assert_eq!(result.rows_affected, None);
    }

    /// `-1` is JDBC's "there was no update count", which is not "nothing was touched".
    #[test]
    fn an_absent_update_count_is_not_zero() {
        let none = decode_statement("x", &serde_json::json!({"rowsAffected": -1}));
        assert_eq!(none.rows_affected, None);
        let some = decode_statement("x", &serde_json::json!({"rowsAffected": 4}));
        assert_eq!(some.rows_affected, Some(4));
    }
}
