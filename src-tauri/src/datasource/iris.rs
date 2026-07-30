//! InterSystems IRIS, over the **Atelier REST API**.
//!
//! IRIS has no pure-Rust driver. Its own clients are JDBC, ODBC and the native SDKs, every one of
//! which would make a vendor runtime a prerequisite for opening this app — a JVM, an ODBC manager
//! plus the InterSystems ODBC driver, or the Python/Node bridge. None of that belongs in a desktop
//! git client's install instructions.
//!
//! What IRIS *does* expose out of the box is the Source Code File REST API (`/api/atelier/`), the
//! same one the VS Code ObjectScript extension uses. Its `action/query` endpoint runs arbitrary
//! SQL and answers with JSON:
//!
//! ```text
//! POST /api/atelier/v1/USER/action/query?max=1000
//! {"query": "SELECT TOP 10 * FROM Sample.Person"}
//! → {"status": {"errors": [], "summary": ""}, "console": [], "result": {"content": [ {…}, … ]}}
//! ```
//!
//! So this driver is an HTTP client. That has consequences worth knowing about, all of them
//! surfaced to the user rather than hidden:
//!
//! - **It needs the web server**, port 52773 by default, not the superserver on 1972.
//! - **Every statement is its own transaction.** REST is stateless, so there is no session to hold
//!   one open across two requests — which is why the data editor reports each row separately
//!   instead of promising all-or-nothing.
//! - **Values arrive as JSON**, already rendered by IRIS, which is the same property the Postgres
//!   driver gets from the simple query protocol.
//! - **The account needs privileges** on `%Development` (or at least the `/api/atelier` web
//!   application) as well as on the tables being read.

use serde::Deserialize;

use super::postgres::{annotate_types, cell, relation_folders, schema_folders};
use super::sqlgen::{self, quote_ident, quote_literal};
use super::{
    describe_db_error, read_only_guard, read_only_refusal, split_statements, DbColumn, DbColumnInfo,
    DbConnectionConfig, DbEditResult, DbExecContext, DbExecuteResult, DbKind, DbNode, DbNodeKind,
    DbNodeRef, DbRowEdit, DbServerInfo, DbSslMode, DbStatementResult, DbTableDataRequest,
    SqlDialect,
};

const DIALECT: SqlDialect = SqlDialect::Iris;

pub struct IrisSession {
    http: reqwest::Client,
    /// `https://host:52773` plus any web-application prefix, no trailing slash.
    base: String,
    namespace: String,
    user: String,
    password: String,
    version: String,
    api_version: i64,
    /// Namespaces the server told us about at connect time; the tree shows these rather than
    /// querying a catalog, because `GET /api/atelier/` already answered the question.
    namespaces: Vec<String>,
    read_only: bool,
    endpoint: String,
}

impl IrisSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();

        let base = base_url(&config);
        let http = reqwest::Client::builder()
            .connect_timeout(config.connect_timeout())
            // No overall request timeout: a report that takes four minutes is a report, not a
            // hang, and the console's Cancel button is the way to stop one.
            .danger_accept_invalid_certs(config.ssl != DbSslMode::VerifyFull)
            .build()
            .map_err(|e| e.to_string())?;

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

        let mut session = Self {
            http,
            base,
            namespace,
            user: config.user.clone(),
            password: config.password.clone(),
            version: String::new(),
            api_version: 0,
            namespaces: Vec::new(),
            read_only: config.read_only,
            endpoint: config.endpoint(),
        };

        // `GET /api/atelier/` is the handshake: it authenticates, proves the web application is
        // reachable, and returns the version and namespace list in one call.
        let server: AtelierEnvelope<ServerContent> = session
            .get("/api/atelier/")
            .await
            .map_err(|e| describe_db_error(&config, "Connecting", &e))?;
        if let Some(error) = server.first_error() {
            return Err(error);
        }
        if let Some(content) = server.result.and_then(|result| result.content) {
            session.version = content.version.unwrap_or_default();
            session.api_version = content.api.unwrap_or_default();
            session.namespaces = content.namespaces.unwrap_or_default();
        }
        Ok(session)
    }

    pub fn info(&self) -> DbServerInfo {
        let mut notes = Vec::new();
        if self.api_version > 0 {
            notes.push(format!("Atelier REST API v{}", self.api_version));
        }
        notes.push(
            "Statements run over the Atelier REST API, so each one is its own transaction — there \
             is no session to hold one open across requests."
                .to_string(),
        );
        DbServerInfo {
            kind: DbKind::Iris,
            version: self.version.clone(),
            database: self.namespace.clone(),
            user: self.user.clone(),
            notes,
        }
    }

    // -------------------------------------------------------------------- HTTP

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, String> {
        let url = format!("{}{path}", self.base);
        let response = self
            .http
            .get(&url)
            .basic_auth(&self.user, Some(&self.password))
            .send()
            .await
            .map_err(|e| http_error(&self.endpoint, &e))?;
        self.decode(response, &url).await
    }

    async fn post<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, String> {
        let url = format!("{}{path}", self.base);
        let response = self
            .http
            .post(&url)
            .basic_auth(&self.user, Some(&self.password))
            .json(&body)
            .send()
            .await
            .map_err(|e| http_error(&self.endpoint, &e))?;
        self.decode(response, &url).await
    }

    async fn decode<T: for<'de> Deserialize<'de>>(
        &self,
        response: reqwest::Response,
        url: &str,
    ) -> Result<T, String> {
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;

        // IRIS answers a failed query with HTTP 500 and the real reason in `status.errors`, so the
        // body is parsed before the status is judged — the status alone would throw the message
        // away.
        if let Ok(parsed) = serde_json::from_str::<T>(&text) {
            return Ok(parsed);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(format!(
                "IRIS rejected the credentials for {}. Check the username and password, and that \
                 the account is enabled for the /api/atelier web application.",
                self.endpoint
            ));
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(format!(
                "{url} returned 404. The Atelier REST API doesn't seem to be enabled on this \
                 instance — in the Management Portal, check that the /api/atelier web application \
                 exists and is enabled."
            ));
        }
        Err(format!(
            "IRIS answered {status} with something that isn't the expected JSON:\n{}",
            text.chars().take(500).collect::<String>()
        ))
    }

    /// Runs one SQL statement through `action/query`.
    ///
    /// `max` is the endpoint's own row cap, which is better than a `TOP` rewritten into the user's
    /// SQL: it applies to whatever they wrote, including a statement that already has its own
    /// `TOP`.
    async fn query(
        &self,
        namespace: &str,
        sql: &str,
        max_rows: Option<usize>,
    ) -> Result<DbStatementResult, String> {
        let started = std::time::Instant::now();
        let namespace = if namespace.is_empty() { &self.namespace } else { namespace };
        let path = match max_rows {
            // One over the asked-for limit, so "there is more" can be detected rather than guessed.
            Some(max) => format!(
                "/api/atelier/v1/{}/action/query?max={}",
                encode_namespace(namespace),
                max.saturating_add(1)
            ),
            None => format!("/api/atelier/v1/{}/action/query", encode_namespace(namespace)),
        };

        let envelope: AtelierEnvelope<QueryContent> =
            self.post(&path, serde_json::json!({ "query": sql })).await?;

        let mut result = DbStatementResult::empty(sql);
        result.duration_ms = started.elapsed().as_millis() as u64;
        result.messages = envelope.console.clone().unwrap_or_default();
        if let Some(error) = envelope.first_error() {
            result.error = Some(error);
            return Ok(result);
        }

        let rows = envelope
            .result
            .and_then(|result| result.content)
            .map(|content| content.0)
            .unwrap_or_default();

        // The endpoint answers with an array of objects, so the column order has to be recovered
        // from the objects themselves — first-seen order across the rows, which is the order IRIS
        // projected them in.
        let mut columns: Vec<String> = Vec::new();
        for row in &rows {
            for key in row.keys() {
                if !columns.iter().any(|existing| existing == key) {
                    columns.push(key.clone());
                }
            }
        }
        result.columns = columns.iter().map(|name| DbColumn::new(name, String::new())).collect();
        result.rows = rows
            .iter()
            .map(|row| columns.iter().map(|name| render_value(row.get(name))).collect())
            .collect();

        if let Some(max) = max_rows {
            if result.rows.len() > max {
                result.rows.truncate(max);
                result.truncated = true;
            }
        }
        // A statement with no projection comes back with no rows and no error; "it ran" is the only
        // honest thing to report, since `action/query` doesn't return an affected count.
        Ok(result)
    }

    async fn text_rows(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
        let result = self.query(&self.namespace, sql, None).await?;
        match result.error {
            Some(error) => Err(error),
            None => Ok(result.rows),
        }
    }

    async fn rows_in(
        &self,
        namespace: Option<&str>,
        sql: &str,
    ) -> Result<Vec<Vec<Option<String>>>, String> {
        let result = self.query(namespace.unwrap_or(&self.namespace), sql, None).await?;
        match result.error {
            Some(error) => Err(error),
            None => Ok(result.rows),
        }
    }

    async fn scalar(&self, sql: &str) -> Result<Option<String>, String> {
        Ok(self.text_rows(sql).await?.first().and_then(|row| row.first().cloned()).flatten())
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        let namespace = ctx
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| self.namespace.clone());

        let mut results = Vec::new();
        for statement in split_statements(sql, Some(DIALECT)) {
            if let Err(refused) = read_only_guard(&statement, self.read_only) {
                results.push(DbStatementResult::failed(&statement, refused));
                break;
            }
            // The console's schema picker doesn't reach here: IRIS has no `SET SCHEMA` that would
            // outlive a REST request, so what it does instead is qualify the names it inserts into
            // new statements. Rewriting the user's SQL to add a schema would be guesswork.
            let result = self.query(&namespace, &statement, ctx.limit()).await?;
            let failed = result.error.is_some();
            results.push(result);
            if failed {
                break;
            }
        }
        Ok(DbExecuteResult { results, duration_ms: started.elapsed().as_millis() as u64 })
    }

    /// IRIS's plan comes from `EXPLAIN`, which returns it as an XML document in one cell.
    pub async fn explain(&self, sql: &str, ctx: &DbExecContext) -> Result<String, String> {
        let statement = split_statements(sql, Some(DIALECT))
            .into_iter()
            .next()
            .ok_or_else(|| "There is no statement to explain.".to_string())?;
        let namespace = ctx.database.clone().unwrap_or_else(|| self.namespace.clone());
        let result = self.query(&namespace, &format!("EXPLAIN {statement}"), None).await?;
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
            .rows_in(
                node.db(),
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
            .rows_in(
                node.db(),
                &format!(
                    "SELECT TABLE_NAME, CLASSNAME FROM INFORMATION_SCHEMA.TABLES \
                     WHERE TABLE_SCHEMA = {} AND TABLE_TYPE = {} ORDER BY TABLE_NAME",
                    quote_literal(Some(schema))?,
                    quote_literal(Some(table_type))?
                ),
            )
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
            .rows_in(
                node.db(),
                &format!(
                    "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES \
                     WHERE ROUTINE_SCHEMA = {} ORDER BY ROUTINE_NAME",
                    quote_literal(Some(schema))?
                ),
            )
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
            .rows_in(
                node.db(),
                &format!(
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
                ),
            )
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
            .rows_in(
                node.db(),
                &format!(
                    "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, PRIMARY_KEY \
                     FROM INFORMATION_SCHEMA.INDEXES \
                     WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
                     ORDER BY INDEX_NAME, ORDINAL_POSITION",
                    quote_literal(Some(schema))?,
                    quote_literal(Some(table))?
                ),
            )
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
                detail: format!(
                    "{}({})",
                    if unique { "unique " } else { "" },
                    columns.join(", ")
                ),
                database: node.db().map(str::to_string),
                schema: Some(schema.to_string()),
                table: Some(table.to_string()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    async fn keys(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("SQLUser");
        let table = node.name()?;
        let rows = self
            .rows_in(
                node.db(),
                &format!(
                    "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE \
                     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS \
                     WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY CONSTRAINT_NAME",
                    quote_literal(Some(schema))?,
                    quote_literal(Some(table))?
                ),
            )
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
            request.order_by.as_deref(),
            request.descending,
            request.offset,
            request.limit,
        )?;
        let namespace = request.node.db().unwrap_or(&self.namespace).to_string();
        let mut result = self.query(&namespace, &sql, Some(request.limit as usize)).await?;
        if let Some(error) = result.error {
            return Err(error);
        }
        // The `%VID` paging trick adds a bookkeeping column; it is an artefact of how the window
        // was taken, not part of the table.
        if let Some(index) = result.columns.iter().position(|c| c.name.eq_ignore_ascii_case("cf_vid"))
        {
            result.columns.remove(index);
            for row in result.rows.iter_mut() {
                if index < row.len() {
                    row.remove(index);
                }
            }
        }
        if let Ok(columns) = self.columns(&request.node).await {
            annotate_types(&mut result, &columns);
        }
        Ok(result)
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        let sql = sqlgen::count_rows(node, DIALECT, filter)?;
        let namespace = node.db().unwrap_or(&self.namespace).to_string();
        let result = self.query(&namespace, &sql, None).await?;
        if let Some(error) = result.error {
            return Err(error);
        }
        Ok(result
            .rows
            .first()
            .and_then(|row| row.first().cloned())
            .flatten()
            .and_then(|value| value.parse().ok())
            .unwrap_or_default())
    }

    /// Applies the grid's edits, one request each.
    ///
    /// Not a transaction, and it says so: the REST endpoint has no session to hold one in, so
    /// `applied` is a count of what actually went through and the first failure stops the rest.
    /// A set of edits that must be atomic belongs in a console statement wrapped in `START
    /// TRANSACTION … COMMIT`, which IRIS does support within a single request.
    pub async fn apply_edits(
        &self,
        node: &DbNodeRef,
        edits: &[DbRowEdit],
    ) -> Result<DbEditResult, String> {
        if self.read_only {
            return Err(read_only_refusal());
        }
        let namespace = node.db().unwrap_or(&self.namespace).to_string();
        let mut statements = Vec::with_capacity(edits.len());
        for edit in edits {
            statements.push(sqlgen::edit_statement(node, DIALECT, edit)?);
        }

        let mut applied = 0u32;
        for statement in &statements {
            let result = self.query(&namespace, statement, None).await?;
            if let Some(error) = result.error {
                return Ok(DbEditResult {
                    applied,
                    statements: statements.clone(),
                    error: Some(format!("{error}\n\n{statement}")),
                });
            }
            applied += 1;
        }
        Ok(DbEditResult { applied, statements, error: None })
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

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/// Every Atelier response has the same envelope: a `status` with an error array, a `console` array
/// of anything the routine printed, and a `result` whose `content` differs per endpoint.
#[derive(Debug, Deserialize)]
struct AtelierEnvelope<T> {
    status: Option<AtelierStatus>,
    console: Option<Vec<String>>,
    result: Option<AtelierResult<T>>,
}

#[derive(Debug, Deserialize)]
struct AtelierResult<T> {
    content: Option<T>,
}

#[derive(Debug, Deserialize)]
struct AtelierStatus {
    errors: Option<Vec<serde_json::Value>>,
    summary: Option<String>,
}

impl<T> AtelierEnvelope<T> {
    /// The first error, phrased as a sentence.
    ///
    /// IRIS puts errors in an array whose entries are sometimes strings and sometimes objects
    /// (`{"error": "…", "id": "…"}`), so both shapes are handled — a client that only read one of
    /// them would show "something went wrong" for half of all failures.
    fn first_error(&self) -> Option<String> {
        let status = self.status.as_ref()?;
        let errors = status.errors.as_ref()?;
        let first = errors.first()?;
        let text = match first {
            serde_json::Value::String(text) => text.clone(),
            serde_json::Value::Object(map) => map
                .get("error")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| first.to_string()),
            other => other.to_string(),
        };
        if text.trim().is_empty() {
            return status.summary.clone().filter(|summary| !summary.trim().is_empty());
        }
        Some(text)
    }
}

#[derive(Debug, Deserialize)]
struct ServerContent {
    version: Option<String>,
    api: Option<i64>,
    namespaces: Option<Vec<String>>,
}

/// `action/query` answers with an array of objects — one per row, keyed by column name.
///
/// `BTreeMap` would sort the columns alphabetically; `serde_json::Map` keeps insertion order only
/// with the `preserve_order` feature, which isn't on. So the rows are kept as ordered pair lists
/// and the column order is recovered from them.
#[derive(Debug, Deserialize)]
struct QueryContent(Vec<QueryRow>);

#[derive(Debug)]
struct QueryRow(Vec<(String, serde_json::Value)>);

impl QueryRow {
    fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(key, _)| key)
    }

    fn get(&self, key: &str) -> Option<&serde_json::Value> {
        self.0.iter().find(|(existing, _)| existing == key).map(|(_, value)| value)
    }
}

impl<'de> Deserialize<'de> for QueryRow {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RowVisitor;
        impl<'de> serde::de::Visitor<'de> for RowVisitor {
            type Value = QueryRow;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object holding one row")
            }

            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let mut pairs = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, serde_json::Value>()? {
                    pairs.push((key, value));
                }
                Ok(QueryRow(pairs))
            }
        }
        deserializer.deserialize_map(RowVisitor)
    }
}

/// A JSON value as grid text. `null` and a missing key are both SQL NULL.
fn render_value(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Bool(flag) => Some(flag.to_string()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        other => Some(other.to_string()),
    }
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

/// `%SYS` has to reach the server as `%25SYS`: a bare `%` in a path is the start of a percent
/// escape, and `%SY` is not a valid one — the request would be rejected before IRIS saw it.
fn encode_namespace(namespace: &str) -> String {
    let mut out = String::with_capacity(namespace.len());
    for byte in namespace.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn base_url(config: &DbConnectionConfig) -> String {
    if !config.url.trim().is_empty() {
        return config.url.trim().trim_end_matches('/').to_string();
    }
    let scheme = if config.ssl == DbSslMode::Disable { "http" } else { "https" };
    // Some deployments front IRIS with a gateway that mounts it under a path (`/iris`), so the
    // prefix is configurable rather than assumed to be the server root.
    let prefix = config
        .option("path")
        .or_else(|| config.option("web_prefix"))
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    format!("{scheme}://{}:{}{prefix}", config.host, config.effective_port())
}

fn http_error(endpoint: &str, error: &reqwest::Error) -> String {
    crate::api::describe_transport_error(
        &format!("The IRIS web server at {endpoint}"),
        endpoint.split(':').next().unwrap_or(endpoint),
        endpoint.rsplit(':').next().and_then(|port| port.parse().ok()),
        error,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `%SYS` is the namespace every IRIS instance has, and it is the one that breaks a naive URL.
    #[test]
    fn a_percent_in_a_namespace_is_escaped() {
        assert_eq!(encode_namespace("%SYS"), "%25SYS");
        assert_eq!(encode_namespace("USER"), "USER");
        assert_eq!(encode_namespace("MY-NS.1"), "MY-NS.1");
    }

    /// Both error shapes IRIS uses have to produce a message; reading only one would show half of
    /// all failures as a blank error.
    #[test]
    fn both_error_shapes_are_understood() {
        let object: AtelierEnvelope<ServerContent> = serde_json::from_str(
            r#"{"status":{"errors":[{"error":"Table 'X.Y' not found","id":"5540"}],"summary":"x"},"console":[],"result":{"content":null}}"#,
        )
        .unwrap();
        assert_eq!(object.first_error().unwrap(), "Table 'X.Y' not found");

        let plain: AtelierEnvelope<ServerContent> = serde_json::from_str(
            r#"{"status":{"errors":["boom"],"summary":""},"console":[],"result":{"content":null}}"#,
        )
        .unwrap();
        assert_eq!(plain.first_error().unwrap(), "boom");

        let fine: AtelierEnvelope<ServerContent> = serde_json::from_str(
            r#"{"status":{"errors":[],"summary":""},"console":[],"result":{"content":{"version":"IRIS 2024.1","api":2,"namespaces":["%SYS","USER"]}}}"#,
        )
        .unwrap();
        assert!(fine.first_error().is_none());
        assert_eq!(fine.result.unwrap().content.unwrap().namespaces.unwrap().len(), 2);
    }

    /// Column order comes from the row objects, so it has to survive deserialization — sorting it
    /// would put a table's columns in alphabetical order instead of the order it declares them.
    #[test]
    fn row_key_order_is_preserved() {
        let content: QueryContent =
            serde_json::from_str(r#"[{"Name":"Ana","Age":31,"City":null}]"#).unwrap();
        let row = &content.0[0];
        assert_eq!(
            row.keys().cloned().collect::<Vec<_>>(),
            vec!["Name".to_string(), "Age".to_string(), "City".to_string()]
        );
        assert_eq!(render_value(row.get("Age")), Some("31".to_string()));
        assert_eq!(render_value(row.get("City")), None);
    }

    #[test]
    fn the_base_url_follows_the_ssl_mode_and_prefix() {
        let mut config = DbConnectionConfig {
            id: "c".into(),
            kind: DbKind::Iris,
            host: "iris.local".into(),
            port: 0,
            database: "USER".into(),
            user: "_SYSTEM".into(),
            password: String::new(),
            url: String::new(),
            ssl: DbSslMode::Disable,
            options: Vec::new(),
            read_only: false,
            connect_timeout_ms: 0,
        };
        assert_eq!(base_url(&config), "http://iris.local:52773");
        config.ssl = DbSslMode::VerifyFull;
        config.options = vec![("path".into(), "/iris/".into())];
        assert_eq!(base_url(&config), "https://iris.local:52773/iris");
    }
}
