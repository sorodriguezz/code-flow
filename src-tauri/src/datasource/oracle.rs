//! Oracle, over **JDBC** — the thin driver, through the same JVM sidecar IRIS uses.
//!
//! Oracle's own clients need an Oracle Client installed (the OCI libraries), which is exactly the
//! thing nobody wants to install to look at a table. Its *thin* JDBC driver is pure Java and needs
//! nothing, and CodeFlow already ships a trimmed Java runtime for IRIS — so Oracle rides that: the
//! same `com.codeflow.iris.IrisBridge` process ([`super::jvm`]), with `ojdbc11` on its classpath and
//! this file naming Oracle's driver class when it opens a session. Nothing to install, and a
//! workspace with no Oracle or IRIS connection never starts the JVM at all.
//!
//! What is specific to Oracle, and why:
//!
//! - **Schemas are users.** The tree goes connection → the pluggable database → schemas → folders,
//!   and the schema list is the accounts that own something, with Oracle's own (`SYS`, `SYSTEM`,
//!   the dozens of `ORACLE_MAINTAINED` ones) left out — plus the connected user's, always.
//! - **The session speaks one date and number format.** How Oracle renders a `DATE` and how it
//!   reads `'150.25'` back both depend on NLS settings, which the thin driver derives from the
//!   *Java* locale — so on a machine set to Spanish, a decimal comma. Every session therefore sets
//!   `NLS_DATE_FORMAT`, the timestamp formats and `NLS_NUMERIC_CHARACTERS` once at open, which is
//!   what makes a cell read from the grid a literal the same session accepts back.
//! - **PL/SQL ends at a `/`.** `split_statements` knows the Oracle convention: a block runs to a line
//!   holding only `/`, a plain statement ends at `;`, and the `;` is not sent — the server rejects
//!   one on a statement on its own.
//! - **The DDL is the server's.** `DBMS_METADATA.GET_DDL` returns the real definition, cleaned of
//!   storage clauses; a user without the privilege for another schema's objects still gets a
//!   reconstruction from the catalog rather than an error.
//! - **Paging is 12c's `OFFSET … FETCH`.** Oracle 11g and older are out of support and not handled.

use std::sync::Arc;

use serde_json::{Map, Value};

use super::iris::{decode_statement, text};
use super::jvm::{self, Bridge};
use super::postgres::{annotate_types, cell, parse_bytes, relation_folders, schema_folders};
use super::sqlgen::{self, quote_ident, quote_literal};
use super::{
    read_only_guard, read_only_refusal, split_statements, DbColumnInfo, DbConnectionConfig,
    DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbEditResult, DbExecContext, DbExecuteResult,
    DbForeignKey, DbKind, DbNode, DbNodeKind, DbNodeRef, DbObjectInfo, DbRowEdit,
    DbSchemaDiagram, DbServerInfo, DbSslMode, DbStatementResult, DbTableDataRequest, SqlDialect,
};

const DIALECT: SqlDialect = SqlDialect::Oracle;
const DRIVER_CLASS: &str = "oracle.jdbc.OracleDriver";

/// Set on every session before anything else runs — see the module note on NLS.
const SESSION_SETUP: &[&str] = &[
    "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
    "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'",
    "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'",
    "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'",
];

/// `GET_DDL` without the storage and tablespace clauses that make a table's definition three
/// screens long, and with a terminator so what comes back runs as it is. Best-effort: a server that
/// refuses it still returns DDL, only longer.
const METADATA_SETUP: &str = "BEGIN \
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE); \
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE); \
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE); \
    END;";

pub struct OracleSession {
    bridge: Arc<Bridge>,
    session_id: String,
    /// The pluggable database the connection landed in (`CON_NAME`), shown as the tree's root.
    database: String,
    /// The schema unqualified names resolve in — the user's own until a console moves it.
    schema: tokio::sync::Mutex<String>,
    user: String,
    version: String,
    driver: String,
    read_only: bool,
    notes: Vec<String>,
}

impl OracleSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();
        let bridge = jvm::bridge().await?;
        let service = database.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| config.database.clone());
        let session_id = format!("{}#oracle#{service}", config.id);

        let mut request = Map::new();
        request.insert("url".into(), Value::from(jdbc_url(&config)?));
        request.insert("driver".into(), Value::from(DRIVER_CLASS));
        request.insert("driverName".into(), Value::from("Oracle JDBC"));
        request.insert("user".into(), Value::from(config.user.clone()));
        // Over a pipe to a child process, never on its command line — argv is world-readable.
        request.insert("password".into(), Value::from(config.password.clone()));
        request.insert("readOnly".into(), Value::from(config.read_only));
        request.insert("timeoutMs".into(), Value::from(config.connect_timeout().as_millis() as u64));
        request.insert("properties".into(), Value::Object(driver_properties(&config)));

        let answer = bridge.call("open", &session_id, request).await.map_err(|e| explain_connect_failure(&config, &e))?;
        bridge.session_opened();

        let mut session = Self {
            bridge,
            session_id,
            database: service,
            schema: tokio::sync::Mutex::new(String::new()),
            user: text(&answer, "user").unwrap_or_else(|| config.user.clone()),
            version: text(&answer, "version").unwrap_or_default(),
            driver: text(&answer, "driver").unwrap_or_default(),
            read_only: config.read_only,
            notes: Vec::new(),
        };
        for statement in SESSION_SETUP {
            session.run(statement, None).await?;
        }
        let _ = session.run(METADATA_SETUP, None).await;
        if let Ok(rows) = session
            .rows("SELECT SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL")
            .await
        {
            if let Some(row) = rows.first() {
                let container = cell(row, 0);
                if !container.is_empty() {
                    session.database = container;
                }
                *session.schema.get_mut() = cell(row, 1);
            }
        }
        if config.ssl != DbSslMode::Disable {
            session.notes.push(
                "TLS (TCPS) is verified against the bundled Java runtime's trusted certificates; a \
                 server with a private certificate authority needs its CA in a wallet, set through \
                 the connection's options."
                    .to_string(),
            );
        }
        Ok(session)
    }

    pub fn info(&self) -> DbServerInfo {
        let mut notes = Vec::new();
        if !self.driver.is_empty() {
            notes.push(self.driver.clone());
        }
        notes.extend(self.notes.iter().cloned());
        DbServerInfo {
            kind: DbKind::Oracle,
            version: first_line(&self.version),
            database: self.database.clone(),
            user: self.user.clone(),
            notes,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.bridge.is_alive()
    }

    pub async fn cancel_running(&self) {
        let _ = self.bridge.call("cancel", &self.session_id, Map::new()).await;
    }

    // ------------------------------------------------------------------ wire

    async fn run(&self, sql: &str, max_rows: Option<usize>) -> Result<Value, String> {
        let mut request = Map::new();
        request.insert("sql".into(), Value::from(sql));
        request.insert("maxRows".into(), Value::from(max_rows.unwrap_or(0) as u64));
        self.bridge.call("exec", &self.session_id, request).await
    }

    async fn statement(&self, sql: &str, max_rows: Option<usize>) -> DbStatementResult {
        match self.run(sql, max_rows).await {
            Ok(answer) => decode_statement(sql, &answer),
            Err(error) => DbStatementResult::failed(sql, error),
        }
    }

    async fn rows(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
        let answer = self.run(sql, None).await?;
        let result = decode_statement(sql, &answer);
        match result.error {
            Some(error) => Err(error),
            None => Ok(result.rows),
        }
    }

    async fn scalar(&self, sql: &str) -> Result<Option<String>, String> {
        Ok(self.rows(sql).await?.first().and_then(|row| row.first().cloned()).flatten())
    }

    /// Points unqualified names at `schema`, when a console asks for another one.
    async fn use_schema(&self, schema: &str) -> Result<(), String> {
        let mut current = self.schema.lock().await;
        if schema.is_empty() || current.eq_ignore_ascii_case(schema) {
            return Ok(());
        }
        self.run(&format!("ALTER SESSION SET CURRENT_SCHEMA = {}", quote_ident(schema, DIALECT)), None).await?;
        *current = schema.to_string();
        Ok(())
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        if let Some(schema) = ctx.schema.as_deref() {
            self.use_schema(schema).await?;
        }
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
        Ok(DbExecuteResult { results, duration_ms: started.elapsed().as_millis() as u64 })
    }

    /// `EXPLAIN PLAN` into the plan table under an id of our own, then `DBMS_XPLAN.DISPLAY` for that
    /// id — the same text SQL Developer shows.
    pub async fn explain(&self, sql: &str, _ctx: &DbExecContext) -> Result<String, String> {
        let statement = split_statements(sql, Some(DIALECT))
            .into_iter()
            .next()
            .ok_or_else(|| "There is no statement to explain.".to_string())?;
        let id = format!("cf{}", std::process::id());
        let planned = self.statement(&format!("EXPLAIN PLAN SET STATEMENT_ID = {} FOR {statement}", quote_literal(Some(&id))?), None).await;
        if let Some(error) = planned.error {
            return Err(error);
        }
        let rows = self
            .rows(&format!(
                "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', {}, 'TYPICAL'))",
                quote_literal(Some(&id))?
            ))
            .await?;
        Ok(rows.iter().filter_map(|row| row.first().cloned().flatten()).collect::<Vec<_>>().join("\n"))
    }

    // ------------------------------------------------------------ introspect

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => Ok(vec![DbNode {
                id: format!("pdb:{}", self.database),
                kind: DbNodeKind::Database,
                name: self.database.clone(),
                detail: String::new(),
                database: Some(self.database.clone()),
                schema: None,
                table: None,
                has_children: true,
                column: None,
            }]),
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

    fn schema_of<'a>(&self, node: &'a DbNodeRef) -> Result<&'a str, String> {
        node.schema().ok_or_else(|| "This action needs a schema to work in.".to_string())
    }

    /// The accounts that are not Oracle's own, and the connected user's whatever it is.
    async fn schemas(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let current = self.schema.lock().await.clone();
        let mut names: Vec<String> = self
            .rows("SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N' ORDER BY USERNAME")
            .await?
            .iter()
            .map(|row| cell(row, 0))
            .collect();
        if !current.is_empty() && !names.contains(&current) {
            names.push(current);
            names.sort();
        }
        Ok(names
            .into_iter()
            .map(|name| DbNode {
                id: format!("schema:{name}"),
                kind: DbNodeKind::Schema,
                name: name.clone(),
                detail: String::new(),
                database: node.db().map(str::to_string),
                schema: Some(name),
                table: None,
                has_children: true,
                column: None,
            })
            .collect())
    }

    fn leaf(&self, node: &DbNodeRef, kind: DbNodeKind, name: String, detail: String, has_children: bool) -> DbNode {
        let schema = node.schema().unwrap_or_default().to_string();
        DbNode {
            id: format!("{kind:?}:{schema}:{name}"),
            kind,
            name: name.clone(),
            detail,
            database: node.db().map(str::to_string),
            schema: Some(schema),
            table: Some(name),
            has_children,
            column: None,
        }
    }

    async fn tables(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let owner = quote_literal(Some(self.schema_of(node)?))?;
        let rows = self
            .rows(&format!(
                "SELECT TABLE_NAME, NUM_ROWS FROM ALL_TABLES WHERE OWNER = {owner} AND NESTED = 'NO' \
                 AND SECONDARY = 'N' AND DROPPED = 'NO' AND (IOT_TYPE IS NULL OR IOT_TYPE = 'IOT') \
                 ORDER BY TABLE_NAME"
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let estimate = cell(row, 1);
                let detail = if estimate.is_empty() { String::new() } else { format!("~{estimate} rows") };
                self.leaf(node, DbNodeKind::Table, cell(row, 0), detail, true)
            })
            .collect())
    }

    async fn views(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let owner = quote_literal(Some(self.schema_of(node)?))?;
        let rows = self.rows(&format!("SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = {owner} ORDER BY VIEW_NAME")).await?;
        Ok(rows.iter().map(|row| self.leaf(node, DbNodeKind::View, cell(row, 0), String::new(), true)).collect())
    }

    async fn routines(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let owner = quote_literal(Some(self.schema_of(node)?))?;
        let rows = self
            .rows(&format!(
                "SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = {owner} \
                 AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION', 'PACKAGE') ORDER BY OBJECT_NAME"
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| self.leaf(node, DbNodeKind::Routine, cell(row, 0), cell(row, 1).to_lowercase(), false))
            .collect())
    }

    async fn sequences(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let owner = quote_literal(Some(self.schema_of(node)?))?;
        let rows = self
            .rows(&format!(
                "SELECT SEQUENCE_NAME, LAST_NUMBER FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = {owner} ORDER BY SEQUENCE_NAME"
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| self.leaf(node, DbNodeKind::Sequence, cell(row, 0), format!("next {}", cell(row, 1)), false))
            .collect())
    }

    /// The column list, with the primary-key flag read from the table's `P` constraint.
    async fn columns(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = self.schema_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.CHAR_LENGTH, \
                        c.CHAR_USED, c.NULLABLE, c.DATA_DEFAULT, c.COLUMN_ID, \
                        (SELECT COUNT(*) FROM ALL_CONS_COLUMNS cc JOIN ALL_CONSTRAINTS k \
                           ON k.OWNER = cc.OWNER AND k.CONSTRAINT_NAME = cc.CONSTRAINT_NAME \
                         WHERE k.CONSTRAINT_TYPE = 'P' AND cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME \
                           AND cc.COLUMN_NAME = c.COLUMN_NAME) \
                 FROM ALL_TAB_COLUMNS c WHERE c.OWNER = {} AND c.TABLE_NAME = {} ORDER BY c.COLUMN_ID",
                quote_literal(Some(&schema))?,
                quote_literal(Some(&table))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let data_type = oracle_type_name(row);
                let nullable = cell(row, 7) != "N";
                let default = cell(row, 8).trim().to_string();
                let primary_key = cell(row, 10).parse::<i64>().unwrap_or(0) > 0;
                let mut detail = data_type.to_lowercase();
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
                    schema: Some(schema.clone()),
                    table: Some(table.clone()),
                    has_children: false,
                    column: Some(DbColumnInfo {
                        data_type,
                        nullable,
                        primary_key,
                        default_value: (!default.is_empty()).then_some(default),
                        position: cell(row, 9).parse().unwrap_or_default(),
                    }),
                }
            })
            .collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = self.schema_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT i.INDEX_NAME, c.COLUMN_NAME, i.UNIQUENESS FROM ALL_INDEXES i \
                 JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME \
                 WHERE i.TABLE_OWNER = {} AND i.TABLE_NAME = {} ORDER BY i.INDEX_NAME, c.COLUMN_POSITION",
                quote_literal(Some(&schema))?,
                quote_literal(Some(&table))?
            ))
            .await?;
        let mut grouped: Vec<(String, Vec<String>, bool)> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let column = cell(row, 1);
            match grouped.iter_mut().find(|(existing, _, _)| *existing == name) {
                Some((_, columns, _)) => columns.push(column),
                None => grouped.push((name, vec![column], cell(row, 2) == "UNIQUE")),
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
                schema: Some(schema.clone()),
                table: Some(table.clone()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    /// Primary, unique, foreign and check constraints — not the `SYS_C…` checks Oracle writes for
    /// every `NOT NULL`, which the column list already says.
    async fn keys(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = self.schema_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM ALL_CONSTRAINTS \
                 WHERE OWNER = {} AND TABLE_NAME = {} AND CONSTRAINT_TYPE IN ('P', 'U', 'R', 'C') \
                 AND (CONSTRAINT_TYPE <> 'C' OR GENERATED = 'USER NAME') ORDER BY CONSTRAINT_NAME",
                quote_literal(Some(&schema))?,
                quote_literal(Some(&table))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let kind = match cell(row, 1).as_str() {
                    "P" => "primary key",
                    "U" => "unique",
                    "R" => "foreign key",
                    _ => "check",
                };
                DbNode {
                    id: format!("key:{schema}:{table}:{}", cell(row, 0)),
                    kind: DbNodeKind::Key,
                    name: cell(row, 0),
                    detail: kind.to_string(),
                    database: node.db().map(str::to_string),
                    schema: Some(schema.clone()),
                    table: Some(table.clone()),
                    has_children: false,
                    column: None,
                }
            })
            .collect())
    }

    /// One row per column pair: the `R` constraint's columns matched by position to those of the
    /// constraint it references.
    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        let schema = self.schema_of(node)?.to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(&format!(
                "{} AND c.TABLE_NAME = {} ORDER BY c.CONSTRAINT_NAME, a.POSITION",
                foreign_key_query(&quote_literal(Some(&schema))?),
                quote_literal(Some(&table))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| DbForeignKey {
                column: cell(row, 2),
                ref_schema: Some(cell(row, 3)),
                ref_table: cell(row, 4),
                ref_column: cell(row, 5),
            })
            .collect())
    }

    // -------------------------------------------------------------- diagram

    /// Every object of the schema, from `ALL_OBJECTS` joined to the table statistics and comments.
    /// Sizes come from `USER_SEGMENTS`, so they are there for the connected user's own schema and
    /// left empty for others — `DBA_SEGMENTS` would need a privilege most accounts don't have.
    pub async fn schema_objects(&self, node: &DbNodeRef) -> Result<Vec<DbObjectInfo>, String> {
        let schema = self.schema_of(node)?.to_string();
        let owner = quote_literal(Some(&schema))?;
        let rows = self
            .rows(&format!(
                "SELECT o.OBJECT_NAME, o.OBJECT_TYPE, TO_CHAR(o.CREATED, 'YYYY-MM-DD HH24:MI:SS'), \
                        TO_CHAR(o.LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS'), t.NUM_ROWS, cm.COMMENTS \
                 FROM ALL_OBJECTS o \
                 LEFT JOIN ALL_TABLES t ON t.OWNER = o.OWNER AND t.TABLE_NAME = o.OBJECT_NAME AND o.OBJECT_TYPE = 'TABLE' \
                 LEFT JOIN ALL_TAB_COMMENTS cm ON cm.OWNER = o.OWNER AND cm.TABLE_NAME = o.OBJECT_NAME \
                 WHERE o.OWNER = {owner} AND o.OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', \
                       'PROCEDURE', 'FUNCTION', 'PACKAGE', 'SEQUENCE') \
                 ORDER BY o.OBJECT_TYPE, o.OBJECT_NAME"
            ))
            .await?;
        let own = self.user.eq_ignore_ascii_case(&schema);
        let sizes = if own {
            self.rows("SELECT SEGMENT_NAME, SUM(BYTES) FROM USER_SEGMENTS GROUP BY SEGMENT_NAME").await.unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let object_type = cell(row, 1);
                let kind = match object_type.as_str() {
                    "TABLE" => DbNodeKind::Table,
                    "VIEW" | "MATERIALIZED VIEW" => DbNodeKind::View,
                    "SEQUENCE" => DbNodeKind::Sequence,
                    _ => DbNodeKind::Routine,
                };
                let bytes = sizes.iter().find(|s| cell(s, 0) == name).and_then(|s| parse_bytes(&cell(s, 1)));
                DbObjectInfo {
                    kind,
                    object_type,
                    created_at: Some(cell(row, 2)).filter(|v| !v.is_empty()),
                    modified_at: Some(cell(row, 3)).filter(|v| !v.is_empty()),
                    total_bytes: bytes,
                    used_bytes: None,
                    rows: parse_bytes(&cell(row, 4)),
                    comment: cell(row, 5),
                    name,
                }
            })
            .collect())
    }

    /// The whole schema in two catalog reads: every column of every table and view with its
    /// primary-key flag, then every foreign key.
    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let schema = self.schema_of(node)?.to_string();
        let owner = quote_literal(Some(&schema))?;
        let rows = self
            .rows(&format!(
                "SELECT c.TABLE_NAME, o.OBJECT_TYPE, c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.DATA_PRECISION, \
                        c.DATA_SCALE, c.CHAR_LENGTH, c.CHAR_USED, c.NULLABLE, \
                        CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END, t.NUM_ROWS \
                 FROM ALL_TAB_COLUMNS c \
                 JOIN ALL_OBJECTS o ON o.OWNER = c.OWNER AND o.OBJECT_NAME = c.TABLE_NAME AND o.OBJECT_TYPE IN ('TABLE', 'VIEW') \
                 LEFT JOIN ALL_TABLES t ON t.OWNER = c.OWNER AND t.TABLE_NAME = c.TABLE_NAME \
                 LEFT JOIN (SELECT cc.TABLE_NAME, cc.COLUMN_NAME FROM ALL_CONS_COLUMNS cc JOIN ALL_CONSTRAINTS k \
                              ON k.OWNER = cc.OWNER AND k.CONSTRAINT_NAME = cc.CONSTRAINT_NAME \
                            WHERE k.CONSTRAINT_TYPE = 'P' AND k.OWNER = {owner}) pk \
                   ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME \
                 WHERE c.OWNER = {owner} ORDER BY c.TABLE_NAME, c.COLUMN_ID"
            ))
            .await?;
        let mut tables: Vec<DbDiagramTable> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let table = match tables.last_mut() {
                Some(last) if last.name == name => last,
                _ => {
                    let view = cell(row, 1) == "VIEW";
                    tables.push(DbDiagramTable {
                        schema: Some(schema.clone()),
                        name: name.clone(),
                        kind: if view { DbNodeKind::View } else { DbNodeKind::Table },
                        columns: Vec::new(),
                        row_estimate: if view { None } else { parse_bytes(&cell(row, 11)) },
                    });
                    tables.last_mut().expect("just pushed")
                }
            };
            // The type columns sit one place further right here than in `columns`, behind the
            // object type — so they are picked out by position into the same shape.
            let typed: Vec<Option<String>> = vec![
                row.get(2).cloned().flatten(),
                row.get(3).cloned().flatten(),
                row.get(4).cloned().flatten(),
                row.get(5).cloned().flatten(),
                row.get(6).cloned().flatten(),
                row.get(7).cloned().flatten(),
                row.get(8).cloned().flatten(),
            ];
            table.columns.push(DbDiagramColumn {
                name: cell(row, 2),
                data_type: oracle_type_name(&typed).to_lowercase(),
                nullable: cell(row, 9) != "N",
                primary_key: cell(row, 10) == "1",
                foreign_key: false,
            });
        }
        let edges = self
            .rows(&format!("{} ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, a.POSITION", foreign_key_query(&owner)))
            .await?
            .iter()
            .map(|row| DbDiagramEdge {
                constraint: cell(row, 0),
                from_schema: Some(schema.clone()),
                from_table: cell(row, 1),
                from_column: cell(row, 2),
                to_schema: Some(cell(row, 3)),
                to_table: cell(row, 4),
                to_column: cell(row, 5),
                inferred: false,
            })
            .collect();
        Ok(DbSchemaDiagram { database: node.db().map(str::to_string), schema: Some(schema), tables, edges, notes: Vec::new() })
    }

    // ----------------------------------------------------------------- data

    pub async fn table_data(&self, request: &DbTableDataRequest) -> Result<DbStatementResult, String> {
        let sql = sqlgen::select_page(&request.node, DIALECT, &request.filter, &request.sort, request.offset, request.limit)?;
        let answer = self.run(&sql, Some(request.limit as usize)).await?;
        let mut result = decode_statement(&sql, &answer);
        if let Some(error) = result.error.take() {
            return Err(error);
        }
        if let Ok(columns) = self.columns(&request.node).await {
            annotate_types(&mut result, &columns);
        }
        Ok(result)
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        let sql = sqlgen::count_rows(node, DIALECT, filter)?;
        Ok(self.scalar(&sql).await?.and_then(|value| value.parse().ok()).unwrap_or_default())
    }

    /// The grid's edits as one JDBC transaction, through the bridge's `batch`.
    pub async fn apply_edits(&self, node: &DbNodeRef, edits: &[DbRowEdit]) -> Result<DbEditResult, String> {
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
        Ok(DbEditResult { applied, statements, error })
    }

    /// The server's own definition from `DBMS_METADATA`, or — for an account that may not read
    /// another schema's metadata — a reconstruction from the catalog, said to be one.
    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        let schema = self.schema_of(node)?.to_string();
        let name = node.name()?.to_string();
        let object_type = match node.kind {
            DbNodeKind::View => "VIEW".to_string(),
            DbNodeKind::Sequence => "SEQUENCE".to_string(),
            DbNodeKind::Routine => self
                .scalar(&format!(
                    "SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {} \
                     AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION', 'PACKAGE')",
                    quote_literal(Some(&schema))?,
                    quote_literal(Some(&name))?
                ))
                .await?
                .unwrap_or_else(|| "PROCEDURE".to_string()),
            _ => "TABLE".to_string(),
        };
        let metadata = self
            .scalar(&format!(
                "SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM DUAL",
                quote_literal(Some(&object_type))?,
                quote_literal(Some(&name))?,
                quote_literal(Some(&schema))?
            ))
            .await;
        if let Ok(Some(ddl)) = metadata {
            return Ok(ddl.trim().to_string());
        }
        // No `SELECT_CATALOG_ROLE` for someone else's object: rebuild a table from what the
        // catalog lists, and say so.
        if object_type != "TABLE" {
            return Err(metadata.err().unwrap_or_else(|| format!("Oracle returned no definition for {name}.")));
        }
        let columns = self.columns(node).await?;
        let ddl = sqlgen::create_table_ddl(
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
            &columns.iter().filter(|c| c.column.as_ref().is_some_and(|i| i.primary_key)).map(|c| c.name.clone()).collect::<Vec<_>>(),
        )?;
        Ok(format!("-- Reconstructed from the catalog: DBMS_METADATA refused this object to this account.\n\n{ddl}"))
    }
}

impl Drop for OracleSession {
    /// Releases the JDBC connection inside the JVM — see `IrisSession`'s, which this mirrors.
    fn drop(&mut self) {
        self.bridge.close_session_detached(std::mem::take(&mut self.session_id));
    }
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

/// The foreign keys of a schema, a column pair per row: constraint, table, column, and the
/// referenced schema, table and column. Callers append the rest of the `WHERE` and the order.
fn foreign_key_query(owner: &str) -> String {
    format!(
        "SELECT c.CONSTRAINT_NAME, c.TABLE_NAME, a.COLUMN_NAME, r.OWNER, r.TABLE_NAME, b.COLUMN_NAME \
         FROM ALL_CONSTRAINTS c \
         JOIN ALL_CONS_COLUMNS a ON a.OWNER = c.OWNER AND a.CONSTRAINT_NAME = c.CONSTRAINT_NAME \
         JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME \
         JOIN ALL_CONS_COLUMNS b ON b.OWNER = r.OWNER AND b.CONSTRAINT_NAME = r.CONSTRAINT_NAME AND b.POSITION = a.POSITION \
         WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = {owner}"
    )
}

/// A column's type as Oracle writes it in DDL, from `ALL_TAB_COLUMNS`' parts — the row starting at
/// the column name: name, type, length, precision, scale, char length, char used.
fn oracle_type_name(row: &[Option<String>]) -> String {
    let data_type = cell(row, 1);
    let precision = cell(row, 3);
    let scale = cell(row, 4);
    let char_length = cell(row, 5);
    let char_used = cell(row, 6);
    match data_type.as_str() {
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" => {
            let unit = if data_type.starts_with('N') {
                String::new()
            } else if char_used == "C" {
                " CHAR".to_string()
            } else {
                " BYTE".to_string()
            };
            format!("{data_type}({char_length}{unit})")
        }
        "NUMBER" if !precision.is_empty() => {
            if scale.is_empty() || scale == "0" {
                format!("NUMBER({precision})")
            } else {
                format!("NUMBER({precision},{scale})")
            }
        }
        "RAW" => format!("RAW({})", cell(row, 2)),
        _ => data_type,
    }
}

/// The thin driver's URL: a pasted `jdbc:oracle:…` as it is, an Easy Connect string
/// (`host:port/service`) behind the thin prefix, or the fields — `//host:port/service`, over TCPS
/// when TLS is asked for, or `host:port:SID` when the connection's options say `sid = true`.
fn jdbc_url(config: &DbConnectionConfig) -> Result<String, String> {
    let url = config.url.trim();
    if !url.is_empty() {
        if url.to_ascii_lowercase().starts_with("jdbc:oracle:") {
            return Ok(url.to_string());
        }
        return Ok(format!("jdbc:oracle:thin:@{url}"));
    }
    let service = config.database.trim();
    if service.is_empty() {
        return Err("Enter the Oracle service name to connect to (for example FREEPDB1 or ORCLPDB1).".to_string());
    }
    let host = config.host.trim();
    let port = config.effective_port();
    if config.option("sid").is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        return Ok(format!("jdbc:oracle:thin:@{host}:{port}:{service}"));
    }
    let protocol = if config.ssl == DbSslMode::Disable { "" } else { "tcps://" };
    Ok(format!("jdbc:oracle:thin:@{protocol}{host}:{port}/{service}"))
}

/// Connection options become JDBC driver properties — except `sid`, which is ours and shapes the
/// URL. Hostname verification follows the TLS mode: `Require` encrypts without matching the
/// certificate's name, the same bargain it means for every other engine here.
fn driver_properties(config: &DbConnectionConfig) -> Map<String, Value> {
    let mut properties = Map::new();
    for (key, value) in &config.options {
        if key.trim().is_empty() || key.eq_ignore_ascii_case("sid") {
            continue;
        }
        properties.insert(key.trim().to_string(), Value::from(value.clone()));
    }
    if config.ssl == DbSslMode::Require {
        properties.entry("oracle.net.ssl_server_dn_match").or_insert(Value::from("false"));
    }
    // Cancel as an in-band break. By default the thin driver interrupts a statement with TCP urgent
    // data, which NAT, many firewalls and Docker's port forwarding silently drop — the Cancel button
    // then does nothing for the ten minutes the query runs. In-band works through all of them.
    properties.entry("oracle.net.disableOob").or_insert(Value::from("true"));
    properties
}

/// A connect failure in the words that help: which host, and the ORA code's usual meaning where it
/// is one people meet on their first try.
fn explain_connect_failure(config: &DbConnectionConfig, error: &str) -> String {
    let hint = if error.contains("ORA-12514") {
        " The listener is up but doesn't know that service name — check it (FREEPDB1, ORCLPDB1, XEPDB1…)."
    } else if error.contains("ORA-01017") {
        " The user name or password was not accepted."
    } else if error.contains("ORA-12505") {
        " The listener doesn't know that SID. Most modern databases are reached by service name instead."
    } else {
        ""
    };
    format!("{}{hint}", super::describe_db_error(config, "connect", error))
}

/// Oracle's banner is several lines; the first says which database it is.
fn first_line(version: &str) -> String {
    version.lines().next().unwrap_or_default().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> DbConnectionConfig {
        let mut config = crate::datasource::tests_support::config(DbKind::Oracle);
        config.host = "db.example.com".into();
        config.database = "FREEPDB1".into();
        config
    }

    #[test]
    fn the_url_names_the_service_or_the_sid() {
        assert_eq!(jdbc_url(&config()).unwrap(), "jdbc:oracle:thin:@db.example.com:1521/FREEPDB1");
        let mut tls = config();
        tls.ssl = DbSslMode::VerifyFull;
        assert_eq!(jdbc_url(&tls).unwrap(), "jdbc:oracle:thin:@tcps://db.example.com:1521/FREEPDB1");
        let mut sid = config();
        sid.options = vec![("sid".into(), "true".into())];
        assert_eq!(jdbc_url(&sid).unwrap(), "jdbc:oracle:thin:@db.example.com:1521:FREEPDB1");
        let mut pasted = config();
        pasted.url = "db.example.com:1522/ORCLPDB1".into();
        assert_eq!(jdbc_url(&pasted).unwrap(), "jdbc:oracle:thin:@db.example.com:1522/ORCLPDB1");
        let mut missing = config();
        missing.database.clear();
        assert!(jdbc_url(&missing).is_err());
    }

    #[test]
    fn types_read_the_way_ddl_writes_them() {
        let row = |parts: [&str; 7]| parts.iter().map(|p| (!p.is_empty()).then(|| p.to_string())).collect::<Vec<_>>();
        assert_eq!(oracle_type_name(&row(["C", "VARCHAR2", "400", "", "", "100", "C"])), "VARCHAR2(100 CHAR)");
        assert_eq!(oracle_type_name(&row(["C", "NUMBER", "22", "10", "2", "", ""])), "NUMBER(10,2)");
        assert_eq!(oracle_type_name(&row(["C", "NUMBER", "22", "", "", "", ""])), "NUMBER");
        assert_eq!(oracle_type_name(&row(["C", "RAW", "16", "", "", "", ""])), "RAW(16)");
        assert_eq!(oracle_type_name(&row(["C", "DATE", "7", "", "", "", ""])), "DATE");
    }

    #[test]
    fn sid_is_not_passed_to_the_driver() {
        let mut with_options = config();
        with_options.options = vec![("sid".into(), "true".into()), ("oracle.net.CONNECT_TIMEOUT".into(), "5000".into())];
        with_options.ssl = DbSslMode::Require;
        let properties = driver_properties(&with_options);
        assert!(!properties.contains_key("sid"));
        assert_eq!(properties.get("oracle.net.CONNECT_TIMEOUT"), Some(&Value::from("5000")));
        assert_eq!(properties.get("oracle.net.ssl_server_dn_match"), Some(&Value::from("false")));
        assert_eq!(properties.get("oracle.net.disableOob"), Some(&Value::from("true")));
    }

    /// The whole driver against a real server. Ignored by default; run it with
    /// `CODEFLOW_TEST_ORACLE=host:port:user:password:service cargo test -p codeflow --lib
    /// datasource::oracle -- --ignored` against a disposable database — it drops and recreates two
    /// tables in that user's schema.
    #[tokio::test]
    #[ignore = "needs an Oracle server in CODEFLOW_TEST_ORACLE"]
    async fn against_a_live_server() {
        use crate::datasource::{DbCell, DbRowEditKind};
        let Ok(target) = std::env::var("CODEFLOW_TEST_ORACLE") else { return };
        let parts: Vec<&str> = target.splitn(5, ':').collect();
        let mut config = crate::datasource::tests_support::config(DbKind::Oracle);
        config.host = parts[0].into();
        config.port = parts[1].parse().unwrap();
        config.user = parts[2].into();
        config.password = parts[3].into();
        config.database = parts[4].into();
        let session = OracleSession::open(&config, None).await.expect("connect");
        let schema = session.schema.lock().await.clone();
        let ctx = DbExecContext { database: None, schema: None, max_rows: 100 };

        let setup = session
            .execute(
                "BEGIN
                   FOR t IN (SELECT table_name FROM user_tables WHERE table_name IN ('ORDERS', 'CUSTOMERS')) LOOP
                     EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS';
                   END LOOP;
                 END;
                 /
                 CREATE TABLE customers (id NUMBER(10) PRIMARY KEY, name VARCHAR2(100 CHAR) NOT NULL,
                   joined DATE, avatar RAW(16), note CLOB);
                 CREATE TABLE orders (id NUMBER(10) PRIMARY KEY, customer_id NUMBER(10) REFERENCES customers(id),
                   total NUMBER(10,2));
                 INSERT INTO customers VALUES (1, 'Ada', DATE '2024-01-15', HEXTORAW('00FF'), 'long text');
                 INSERT INTO orders VALUES (1, 1, 150.25);
                 COMMIT;",
                &ctx,
            )
            .await
            .unwrap();
        assert!(setup.results.iter().all(|r| r.error.is_none()), "{:?}", setup.results.iter().filter_map(|r| r.error.clone()).collect::<Vec<_>>());

        // Values as text in the session's fixed formats.
        let read = session.execute("SELECT id, name, joined, avatar, note FROM customers", &ctx).await.unwrap();
        let row = &read.results[0].rows[0];
        assert_eq!(row[0].as_deref(), Some("1"));
        assert_eq!(row[1].as_deref(), Some("Ada"));
        assert!(row[2].as_deref().unwrap_or_default().starts_with("2024-01-15"), "{:?}", row[2]);
        assert_eq!(row[3].as_deref().map(str::to_ascii_lowercase).as_deref(), Some("0x00ff"));
        assert_eq!(row[4].as_deref(), Some("long text"));

        // Edits round-trip: a quote, a date read from the grid, a number with decimals, raw bytes.
        let table = DbNodeRef { kind: DbNodeKind::Table, database: None, schema: Some(schema.clone()), name: Some("CUSTOMERS".into()) };
        let joined = row[2].clone().unwrap();
        let cell = |column: &str, value: &str, type_name: &str| DbCell { column: column.into(), value: Some(value.into()), type_name: type_name.into() };
        let edited = session
            .apply_edits(
                &table,
                &[DbRowEdit {
                    kind: DbRowEditKind::Update,
                    values: vec![cell("NAME", "O'Brien", "VARCHAR2(100 CHAR)"), cell("JOINED", &joined, "DATE"), cell("AVATAR", "0x0102", "RAW(16)")],
                    keys: vec![cell("ID", "1", "NUMBER(10)")],
                    document: None,
                }],
            )
            .await
            .unwrap();
        assert_eq!(edited.applied, 1, "{:?} {:?}", edited.error, edited.statements);
        let orders = DbNodeRef { name: Some("ORDERS".into()), ..table.clone() };
        let totals = session
            .apply_edits(&orders, &[DbRowEdit { kind: DbRowEditKind::Update, values: vec![cell("TOTAL", "99.95", "NUMBER(10,2)")], keys: vec![cell("ID", "1", "NUMBER(10)")], document: None }])
            .await
            .unwrap();
        assert_eq!(totals.applied, 1, "{:?}", totals.error);
        let back = session.execute("SELECT name, avatar FROM customers; SELECT total FROM orders", &ctx).await.unwrap();
        assert_eq!(back.results[0].rows[0][0].as_deref(), Some("O'Brien"));
        assert_eq!(back.results[0].rows[0][1].as_deref().map(str::to_ascii_lowercase).as_deref(), Some("0x0102"));
        assert_eq!(back.results[1].rows[0][0].as_deref(), Some("99.95"));

        // Tree, catalog, diagram.
        let root = session.children(&DbNodeRef { kind: DbNodeKind::Root, database: None, schema: None, name: None }).await.unwrap();
        let schemas = session.children(&DbNodeRef { kind: DbNodeKind::Database, database: Some(root[0].name.clone()), schema: None, name: None }).await.unwrap();
        assert!(schemas.iter().any(|s| s.name == schema), "{schemas:?}");
        let folder = |kind| DbNodeRef { kind, database: Some(root[0].name.clone()), schema: Some(schema.clone()), name: None };
        let tables = session.children(&folder(DbNodeKind::TableFolder)).await.unwrap();
        assert!(tables.iter().any(|t| t.name == "CUSTOMERS") && tables.iter().any(|t| t.name == "ORDERS"));
        let columns = session.columns(&table).await.unwrap();
        assert!(columns[0].column.as_ref().unwrap().primary_key);
        assert_eq!(columns[1].column.as_ref().unwrap().data_type, "VARCHAR2(100 CHAR)");
        let keys = session.foreign_keys(&orders).await.unwrap();
        assert_eq!((keys[0].column.as_str(), keys[0].ref_table.as_str(), keys[0].ref_column.as_str()), ("CUSTOMER_ID", "CUSTOMERS", "ID"));
        let diagram = session.schema_diagram(&folder(DbNodeKind::Schema)).await.unwrap();
        assert_eq!(diagram.edges.len(), 1);
        let objects = session.schema_objects(&folder(DbNodeKind::Schema)).await.unwrap();
        assert!(objects.iter().any(|o| o.name == "ORDERS"));

        // Data, count, DDL, plan.
        let page = session
            .table_data(&DbTableDataRequest { node: orders.clone(), offset: 0, limit: 10, sort: vec![], filter: String::new(), options: Default::default() })
            .await
            .unwrap();
        assert_eq!(page.rows[0][2].as_deref(), Some("99.95"));
        assert_eq!(page.columns[2].type_name, "NUMBER(10,2)");
        assert_eq!(session.row_count(&orders, "TOTAL > 1").await.unwrap(), 1);
        let ddl = session.object_ddl(&orders).await.unwrap();
        assert!(ddl.contains("CREATE TABLE"), "{ddl}");
        let plan = session.explain("SELECT * FROM orders WHERE id = 1", &ctx).await.unwrap();
        assert!(plan.contains("ORDERS"), "{plan}");

        // A PL/SQL block and a plain statement in one buffer.
        let mixed = session
            .execute("CREATE OR REPLACE PROCEDURE cf_touch AS BEGIN UPDATE orders SET total = total; END;\n/\nBEGIN cf_touch; END;\n/\nSELECT COUNT(*) FROM orders;", &ctx)
            .await
            .unwrap();
        assert!(mixed.results.iter().all(|r| r.error.is_none()), "{:?}", mixed.results);
        assert_eq!(mixed.results.last().unwrap().rows[0][0].as_deref(), Some("1"));

        // Cancel reaches the server: a query that would run for minutes stops at once. Not a PL/SQL
        // `DBMS_SESSION.SLEEP` — the server does not look for a break while it sleeps, so that one
        // runs out its time whatever the driver sends.
        let started = std::time::Instant::now();
        let sleeper = session.execute("SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c", &ctx);
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            session.cancel_running().await;
        };
        let (slept, _) = tokio::join!(sleeper, cancel);
        assert!(started.elapsed() < std::time::Duration::from_secs(6), "cancel did not stop the block: {slept:?}");
    }
}
