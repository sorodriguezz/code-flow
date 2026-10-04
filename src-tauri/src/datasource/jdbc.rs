//! Every database in the driver catalogue that has no Rust driver of its own — Snowflake, Db2,
//! ClickHouse, Trino, H2, Firebird and the forty others — through its own JDBC driver.
//!
//! The same JVM sidecar IRIS and Oracle use ([`super::jvm`]), with the driver's jars named in the
//! request that opens the session; the jars and the runtime are downloaded the first time a
//! connection needs them ([`super::drivers`]).
//!
//! # Knowing nothing about the engine
//!
//! The other drivers here are written against their engine's catalogue — `pg_catalog`, `sys.*`,
//! `ALL_TABLES`. This one cannot be: there are dozens of engines behind it, and most have no
//! `information_schema` to write one query against. What every JDBC driver does have is
//! `DatabaseMetaData`, and the bridge hands its listings back as ordinary result sets (`meta`). The
//! explorer is built from those alone — catalogs, schemas, tables, columns, keys, indexes — which is
//! what lets a new engine be a catalogue entry instead of a new driver.
//!
//! What metadata cannot say is how the engine writes a page of rows or a plan, so the catalogue
//! names those per driver ([`SqlTraits`]): `LIMIT/OFFSET`, `OFFSET … FETCH`, `TOP`, or nothing at
//! all — in which case JDBC's `setMaxRows` caps the page and the bridge skips the rows before it.
//!
//! # Catalogs, schemas, or neither
//!
//! JDBC lets a driver have catalogs (Snowflake's databases, Trino's catalogs), schemas, both, or
//! neither (Firebird), and says which. The tree follows: a catalog is a database node, a schema a
//! schema node, and a level the driver doesn't have is skipped rather than drawn empty. Names are
//! qualified the same way — a table in another catalog than the session's is written with it.

use std::sync::Arc;

use serde_json::{Map, Value};

use super::catalog::{self, Paging};
use super::drivers::{self, ResolvedDriver};
use super::iris::{decode_statement, text};
use super::jvm::{self, Bridge};
use super::postgres::{annotate_types, cell};
use super::sqlgen::{self, quote_ident};
use super::{
    describe_db_error_at, read_only_guard, read_only_refusal, split_statements, DbColumnInfo, DbConnectionConfig,
    DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbEditResult, DbExecContext, DbExecuteResult, DbForeignKey,
    DbKind, DbNode, DbNodeKind, DbNodeRef, DbObjectInfo, DbRowEdit, DbSchemaDiagram, DbServerInfo,
    DbStatementResult, DbTableDataRequest, SqlDialect,
};

/// How many tables a schema diagram reads keys for. Keys come one table at a time from JDBC — there
/// is no "every key of the schema" call — so a warehouse with thousands of tables is drawn from its
/// first few hundred rather than taking minutes.
const DIAGRAM_TABLES: usize = 300;

pub struct JdbcSession {
    bridge: Arc<Bridge>,
    session_id: String,
    driver: ResolvedDriver,
    /// The catalog the session is in (`Connection.getCatalog`), or empty for a driver without them.
    database: String,
    /// The schema unqualified names resolve in, until a console moves it.
    schema: tokio::sync::Mutex<String>,
    user: String,
    product: String,
    version: String,
    driver_version: String,
    /// How the driver says identifiers are quoted. Read once; the dialect below already quotes the
    /// same way for every driver the catalogue has, and this is the check that says so.
    catalogs: bool,
    schemas: bool,
    catalog_separator: String,
    catalog_at_start: bool,
    dialect: SqlDialect,
    read_only: bool,
}

/// The dialect a catalogue entry's SQL traits name — what quoting, literals, statement splitting and
/// the read-only guard follow.
fn dialect_of(traits: &catalog::SqlTraits) -> SqlDialect {
    match traits.dialect.as_str() {
        // Hive, Spark, Databricks, BigQuery, ClickHouse, Couchbase: backticks, and a backslash that
        // escapes inside a literal — exactly MySQL's rules for both.
        "backtick" => SqlDialect::MySql { backslash_escapes: true },
        "tsql" => SqlDialect::TSql,
        "oracle" => SqlDialect::Oracle,
        // The standard's: double-quoted identifiers, quotes doubled inside a literal, `;` between
        // statements — which is SQLite's dialect here, statement for statement.
        _ => SqlDialect::Sqlite,
    }
}

/// A connection's URL: the one the user typed on the URL tab, or the driver's template filled in
/// from the fields. `database` is the catalog the explorer is opening the session for, when the
/// template has a place for it.
pub fn connection_url(config: &DbConnectionConfig, driver: &ResolvedDriver, database: Option<&str>) -> Result<String, String> {
    if !config.url.trim().is_empty() {
        return Ok(config.url.trim().to_string());
    }
    let template = driver
        .urls
        .iter()
        .find(|url| !config.url_template.is_empty() && url.name == config.url_template)
        .or_else(|| driver.urls.first())
        .ok_or_else(|| format!("{} has no URL template — type the connection's URL instead.", driver.name))?;
    Ok(catalog::render_template(&template.template, &|name| field_value(config, driver, database, name)))
}

/// The value of one template field: the standard ones from the connection's fields, anything else
/// from the values the form collected for this driver.
fn field_value(config: &DbConnectionConfig, driver: &ResolvedDriver, database: Option<&str>, name: &str) -> String {
    match name {
        "host" => config.host.trim().to_string(),
        "port" => match (config.port, driver.default_port) {
            (0, 0) => String::new(),
            (0, default) => default.to_string(),
            (port, _) => port.to_string(),
        },
        "database" | "file" => database.filter(|d| !d.is_empty()).unwrap_or(&config.database).trim().to_string(),
        "user" => config.user.clone(),
        "password" => config.password.clone(),
        other => config
            .url_values
            .iter()
            .find(|(key, _)| key == other)
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default(),
    }
}

impl JdbcSession {
    /// `tag`: see `Session::open_tagged`.
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>, tag: &str) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();
        let driver = drivers::resolve(&config.driver_id)?;
        let bridge = jvm::bridge_for(&driver.jvm).await?;
        let url = connection_url(&config, &driver, database)?;
        let session_id = format!("{}#jdbc#{}{tag}", config.id, database.unwrap_or_default());

        let mut request = Map::new();
        request.insert("url".into(), Value::from(url.clone()));
        request.insert("driver".into(), Value::from(driver.class.clone()));
        request.insert("driverName".into(), Value::from(driver.name.clone()));
        request.insert("jars".into(), Value::from(driver.jar_paths()));
        request.insert("user".into(), Value::from(config.user.clone()));
        // Over a pipe to a child process, never on its command line — argv is world-readable.
        request.insert("password".into(), Value::from(config.password.clone()));
        request.insert("readOnly".into(), Value::from(config.read_only));
        request.insert("timeoutMs".into(), Value::from(config.connect_timeout().as_millis() as u64));
        let properties = drivers::connection_properties(&driver, &config.options, &|name| {
            field_value(&config, &driver, database, name)
        });
        request.insert(
            "properties".into(),
            Value::Object(properties.into_iter().map(|(key, value)| (key, Value::from(value))).collect()),
        );

        let answer = bridge.call("open", &session_id, request).await.map_err(|e| {
            // The URL decides where the driver went — the fields may not even have been used.
            let host = if config.host.trim().is_empty() { url.clone() } else { config.host.clone() };
            describe_db_error_at(&host, config.effective_port(), &format!("Couldn't connect with {}", driver.name), &e)
        })?;
        bridge.session_opened();

        let flag = |key: &str| answer.get(key).and_then(Value::as_bool);
        Ok(Self {
            bridge,
            session_id,
            database: text(&answer, "catalog").unwrap_or_default(),
            schema: tokio::sync::Mutex::new(text(&answer, "schema").unwrap_or_default()),
            user: text(&answer, "user").unwrap_or_else(|| config.user.clone()),
            product: text(&answer, "product").unwrap_or_else(|| driver.name.clone()),
            version: text(&answer, "version").unwrap_or_default(),
            driver_version: text(&answer, "driver").unwrap_or_default(),
            // A driver that doesn't say is taken to have the level: listing it and finding it empty
            // costs one call, and hiding a level that exists would hide everything under it.
            catalogs: flag("catalogs").unwrap_or(true),
            schemas: flag("schemas").unwrap_or(true),
            catalog_separator: text(&answer, "catalogSeparator").unwrap_or_else(|| ".".to_string()),
            catalog_at_start: flag("catalogAtStart").unwrap_or(true),
            dialect: dialect_of(&driver.sql),
            read_only: config.read_only,
            driver,
        })
    }

    pub fn info(&self) -> DbServerInfo {
        let mut notes = vec![self.driver.name.clone()];
        if !self.driver_version.is_empty() {
            notes.push(self.driver_version.clone());
        }
        let version = if self.version.is_empty() {
            self.product.clone()
        } else if self.version.contains(&self.product) {
            self.version.clone()
        } else {
            format!("{} {}", self.product, self.version)
        };
        DbServerInfo {
            kind: DbKind::Jdbc,
            version: version.lines().next().unwrap_or_default().to_string(),
            database: self.database.clone(),
            user: self.user.clone(),
            notes,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.bridge.is_alive()
    }

    pub fn dialect(&self) -> SqlDialect {
        self.dialect
    }

    pub async fn set_autocommit(&self, enabled: bool) -> Result<(), String> {
        let mut request = Map::new();
        request.insert("enabled".into(), Value::from(enabled));
        self.bridge.call("autocommit", &self.session_id, request).await.map(|_| ())
    }

    pub async fn cancel_running(&self) {
        let _ = self.bridge.call("cancel", &self.session_id, Map::new()).await;
    }

    /// `Connection.isValid` — the keep-alive. Not `SELECT 1`: half these engines refuse a `SELECT`
    /// without a `FROM`, and each spells its dummy table differently.
    pub async fn ping(&self) -> Result<(), String> {
        let answer = self.bridge.call("valid", &self.session_id, Map::new()).await?;
        match answer.get("valid").and_then(Value::as_bool) {
            Some(false) => Err(format!("The {} connection is no longer valid.", self.driver.name)),
            _ => Ok(()),
        }
    }

    // ------------------------------------------------------------------ wire

    async fn run(&self, sql: &str, max_rows: usize, skip_rows: u32) -> Result<Value, String> {
        let mut request = Map::new();
        request.insert("sql".into(), Value::from(sql));
        request.insert("maxRows".into(), Value::from(max_rows as u64));
        if skip_rows > 0 {
            request.insert("skipRows".into(), Value::from(skip_rows));
        }
        self.bridge.call("exec", &self.session_id, request).await
    }

    async fn statement(&self, sql: &str, max_rows: usize) -> DbStatementResult {
        match self.run(sql, max_rows, 0).await {
            Ok(answer) => decode_statement(sql, &answer),
            Err(error) => DbStatementResult::failed(sql, error),
        }
    }

    /// One `DatabaseMetaData` listing, as rows keyed by the specification's column names.
    async fn meta(&self, call: &str, catalog: Option<&str>, schema: Option<&str>, table: Option<&str>) -> Result<Vec<MetaRow>, String> {
        let mut request = Map::new();
        request.insert("call".into(), Value::from(call));
        for (key, value) in [("catalog", catalog), ("schema", schema), ("table", table)] {
            if let Some(value) = value.filter(|v| !v.is_empty()) {
                request.insert(key.into(), Value::from(value));
            }
        }
        let answer = self.bridge.call("meta", &self.session_id, request).await?;
        let result = decode_statement(call, &answer);
        let names: Vec<String> = result.columns.iter().map(|c| c.name.to_ascii_uppercase()).collect();
        Ok(result.rows.into_iter().map(|row| MetaRow { names: names.clone(), row }).collect())
    }

    /// Points unqualified names at `schema` — JDBC's `setSchema` — when a console asks for another.
    async fn use_schema(&self, schema: &str) -> Result<(), String> {
        let mut current = self.schema.lock().await;
        if schema.is_empty() || current.eq_ignore_ascii_case(schema) {
            return Ok(());
        }
        let mut request = Map::new();
        request.insert("schema".into(), Value::from(schema));
        // A driver without `setSchema` (it is optional in JDBC) keeps working in its default; the
        // console's statements can still name the schema themselves.
        if self.bridge.call("use", &self.session_id, request).await.is_ok() {
            *current = schema.to_string();
        }
        Ok(())
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        if let Some(schema) = ctx.schema.as_deref() {
            self.use_schema(schema).await?;
        }
        let mut results = Vec::new();
        for statement in split_statements(sql, Some(self.dialect)) {
            if let Err(refused) = read_only_guard(&statement, self.read_only, self.dialect) {
                results.push(DbStatementResult::failed(&statement, refused));
                break;
            }
            let result = self.statement(&statement, ctx.limit().unwrap_or(0)).await;
            let failed = result.error.is_some();
            results.push(result);
            if failed {
                break;
            }
        }
        Ok(DbExecuteResult { results, duration_ms: started.elapsed().as_millis() as u64 })
    }

    /// The plan, as the catalogue says the engine writes it (`EXPLAIN …`, `EXPLAIN PLAN FOR …`),
    /// with each row of the answer on a line of its own.
    pub async fn explain(&self, sql: &str, _ctx: &DbExecContext) -> Result<String, String> {
        let template = self
            .driver
            .sql
            .explain
            .as_deref()
            .ok_or_else(|| format!("{} has no query plan CodeFlow knows how to ask for.", self.driver.name))?;
        let statement = split_statements(sql, Some(self.dialect))
            .into_iter()
            .next()
            .ok_or_else(|| "There is no statement to explain.".to_string())?;
        let explained = template.replace("{sql}", &statement);
        let result = self.statement(&explained, 0).await;
        if let Some(error) = result.error {
            return Err(error);
        }
        Ok(result
            .rows
            .iter()
            .map(|row| row.iter().map(|value| value.clone().unwrap_or_default()).collect::<Vec<_>>().join("\t"))
            .collect::<Vec<_>>()
            .join("\n"))
    }

    // ------------------------------------------------------------ introspect

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => self.databases().await,
            DbNodeKind::Database => self.schemas_of(node).await,
            DbNodeKind::Schema => Ok(self.folders(node)),
            DbNodeKind::TableFolder => self.relations(node, false).await,
            DbNodeKind::ViewFolder => self.relations(node, true).await,
            DbNodeKind::RoutineFolder => self.routines(node).await,
            DbNodeKind::Table | DbNodeKind::View => Ok(self.relation_folders(node)),
            DbNodeKind::ColumnFolder => self.columns(node).await,
            DbNodeKind::IndexFolder => self.indexes(node).await,
            DbNodeKind::KeyFolder => self.keys(node).await,
            _ => Ok(Vec::new()),
        }
    }

    /// The catalogs, as the tree's databases — or one database standing for the connection, when the
    /// driver has no catalogs, so the tree keeps the shape every engine here draws.
    async fn databases(&self) -> Result<Vec<DbNode>, String> {
        let mut names: Vec<String> = if self.catalogs {
            self.meta("catalogs", None, None, None).await.unwrap_or_default().iter().map(|row| row.get("TABLE_CAT")).collect()
        } else {
            Vec::new()
        };
        names.retain(|name| !name.is_empty());
        if names.is_empty() {
            let name = if self.database.is_empty() { self.product.clone() } else { self.database.clone() };
            return Ok(vec![DbNode {
                id: "jdbc-db:".to_string(),
                kind: DbNodeKind::Database,
                name,
                detail: String::new(),
                // No catalog to name: everything under it is the session's own.
                database: None,
                schema: None,
                table: None,
                has_children: true,
                column: None,
            }]);
        }
        Ok(names
            .into_iter()
            .map(|name| DbNode {
                id: format!("jdbc-db:{name}"),
                kind: DbNodeKind::Database,
                name: name.clone(),
                detail: String::new(),
                database: Some(name),
                schema: None,
                table: None,
                has_children: true,
                column: None,
            })
            .collect())
    }

    /// A catalog's schemas — or its folders straight away, for a driver without schemas.
    async fn schemas_of(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let mut names: Vec<String> = if self.schemas {
            self.meta("schemas", node.db(), None, None)
                .await?
                .iter()
                // A driver that ignores the catalog argument lists every catalog's schemas; keep this
                // one's (or the ones that don't say).
                .filter(|row| {
                    let owner = row.get("TABLE_CATALOG");
                    node.db().is_none() || owner.is_empty() || Some(owner.as_str()) == node.db()
                })
                .map(|row| row.get("TABLE_SCHEM"))
                .collect()
        } else {
            Vec::new()
        };
        names.retain(|name| !name.is_empty());
        names.dedup();
        if names.is_empty() {
            return Ok(self.folders(node));
        }
        Ok(names
            .into_iter()
            .map(|name| DbNode {
                id: format!("jdbc-schema:{}:{name}", node.db().unwrap_or_default()),
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

    fn folders(&self, node: &DbNodeRef) -> Vec<DbNode> {
        let key = format!("{}:{}", node.db().unwrap_or_default(), node.schema().unwrap_or_default());
        [(DbNodeKind::TableFolder, "Tables"), (DbNodeKind::ViewFolder, "Views"), (DbNodeKind::RoutineFolder, "Routines")]
            .into_iter()
            .map(|(kind, name)| DbNode {
                id: format!("jdbc-folder:{key}:{name}"),
                kind,
                name: name.to_string(),
                detail: String::new(),
                database: node.db().map(str::to_string),
                schema: node.schema().map(str::to_string),
                table: None,
                has_children: true,
                column: None,
            })
            .collect()
    }

    fn relation_folders(&self, node: &DbNodeRef) -> Vec<DbNode> {
        let table = node.name.clone().unwrap_or_default();
        let key = format!("{}:{}:{table}", node.db().unwrap_or_default(), node.schema().unwrap_or_default());
        [(DbNodeKind::ColumnFolder, "Columns"), (DbNodeKind::IndexFolder, "Indexes"), (DbNodeKind::KeyFolder, "Keys")]
            .into_iter()
            .map(|(kind, name)| DbNode {
                id: format!("jdbc-folder:{key}:{name}"),
                kind,
                name: name.to_string(),
                detail: String::new(),
                database: node.db().map(str::to_string),
                schema: node.schema().map(str::to_string),
                table: Some(table.clone()),
                has_children: true,
                column: None,
            })
            .collect()
    }

    /// Tables, or views, of a schema. Which is which is the driver's `TABLE_TYPE`, and the drivers
    /// spell it a dozen ways (`TABLE`, `BASE TABLE`, `MANAGED_TABLE`, `MATERIALIZED VIEW`) — so
    /// anything with VIEW in it is a view, the system's own objects and the non-relations (indexes,
    /// sequences, synonyms) are left out, and the rest are tables.
    async fn relations(&self, node: &DbNodeRef, views: bool) -> Result<Vec<DbNode>, String> {
        let rows = self.meta("tables", node.db(), node.schema(), None).await?;
        let mut out: Vec<DbNode> = rows
            .iter()
            .filter(|row| relation_kind(&row.get("TABLE_TYPE")) == Some(views))
            .map(|row| {
                let name = row.get("TABLE_NAME");
                let kind = if views { DbNodeKind::View } else { DbNodeKind::Table };
                DbNode {
                    id: format!("jdbc-rel:{}:{}:{name}", node.db().unwrap_or_default(), node.schema().unwrap_or_default()),
                    kind,
                    name: name.clone(),
                    detail: row.get("REMARKS"),
                    database: node.db().map(str::to_string),
                    schema: node.schema().map(str::to_string),
                    table: Some(name),
                    has_children: true,
                    column: None,
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    }

    async fn routines(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let rows = self.meta("procedures", node.db(), node.schema(), None).await.unwrap_or_default();
        let mut names: Vec<String> = rows
            .iter()
            // SQL Server's drivers number overloads as `name;1`.
            .map(|row| row.get("PROCEDURE_NAME").split(';').next().unwrap_or_default().to_string())
            .filter(|name| !name.is_empty())
            .collect();
        names.sort_by_key(|name| name.to_lowercase());
        names.dedup();
        Ok(names
            .into_iter()
            .map(|name| DbNode {
                id: format!("jdbc-routine:{}:{}:{name}", node.db().unwrap_or_default(), node.schema().unwrap_or_default()),
                kind: DbNodeKind::Routine,
                name: name.clone(),
                detail: String::new(),
                database: node.db().map(str::to_string),
                schema: node.schema().map(str::to_string),
                table: Some(name),
                has_children: false,
                column: None,
            })
            .collect())
    }

    /// The table's columns, with the primary key read from `getPrimaryKeys` — the data editor builds
    /// its `UPDATE … WHERE` from that flag.
    async fn columns(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let table = node.name()?.to_string();
        let rows = self.meta("columns", node.db(), node.schema(), Some(&table)).await?;
        let keys: Vec<String> = self
            .meta("primaryKeys", node.db(), node.schema(), Some(&table))
            .await
            .unwrap_or_default()
            .iter()
            .map(|row| row.get("COLUMN_NAME"))
            .collect();
        let mut out: Vec<(i64, DbNode)> = rows
            .iter()
            // A driver that reads the table name as a pattern can answer for its look-alikes too.
            .filter(|row| row.get("TABLE_NAME").is_empty() || row.get("TABLE_NAME") == table)
            .map(|row| {
                let name = row.get("COLUMN_NAME");
                let data_type = type_name(row);
                // `NULLABLE` is 0 for no, 1 for yes, 2 for unknown — unknown is taken as yes.
                let nullable = row.get("NULLABLE") != "0";
                let primary_key = keys.iter().any(|key| *key == name);
                let default = row.get("COLUMN_DEF").trim().to_string();
                let position = row.get("ORDINAL_POSITION").parse().unwrap_or_default();
                let mut detail = data_type.to_lowercase();
                if primary_key {
                    detail.push_str(" · PK");
                }
                if !nullable {
                    detail.push_str(" · not null");
                }
                let node = DbNode {
                    id: format!("jdbc-col:{}:{}:{table}:{name}", node.db().unwrap_or_default(), node.schema().unwrap_or_default()),
                    kind: DbNodeKind::Column,
                    name: name.clone(),
                    detail,
                    database: node.db().map(str::to_string),
                    schema: node.schema().map(str::to_string),
                    table: Some(table.clone()),
                    has_children: false,
                    column: Some(DbColumnInfo {
                        data_type,
                        nullable,
                        primary_key,
                        default_value: (!default.is_empty()).then_some(default),
                        position,
                    }),
                };
                (position, node)
            })
            .collect();
        out.sort_by_key(|(position, _)| *position);
        Ok(out.into_iter().map(|(_, node)| node).collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let table = node.name()?.to_string();
        let rows = self.meta("indexInfo", node.db(), node.schema(), Some(&table)).await.unwrap_or_default();
        let mut grouped: Vec<(String, Vec<String>, bool)> = Vec::new();
        for row in &rows {
            let name = row.get("INDEX_NAME");
            // Type 0 is `tableIndexStatistic` — the table's row count dressed as an index.
            if name.is_empty() || row.get("TYPE") == "0" {
                continue;
            }
            let column = row.get("COLUMN_NAME");
            let unique = matches!(row.get("NON_UNIQUE").to_ascii_lowercase().as_str(), "false" | "0" | "f");
            match grouped.iter_mut().find(|(existing, _, _)| *existing == name) {
                Some((_, columns, _)) => columns.push(column),
                None => grouped.push((name, vec![column], unique)),
            }
        }
        Ok(grouped
            .into_iter()
            .map(|(name, columns, unique)| DbNode {
                id: format!("jdbc-idx:{}:{}:{table}:{name}", node.db().unwrap_or_default(), node.schema().unwrap_or_default()),
                kind: DbNodeKind::Index,
                name: name.clone(),
                detail: format!("{}({})", if unique { "unique " } else { "" }, columns.join(", ")),
                database: node.db().map(str::to_string),
                schema: node.schema().map(str::to_string),
                table: Some(table.clone()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    /// The primary key and the foreign keys — the two kinds of constraint JDBC metadata describes.
    async fn keys(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let table = node.name()?.to_string();
        let mut out = Vec::new();
        let primary = self.meta("primaryKeys", node.db(), node.schema(), Some(&table)).await.unwrap_or_default();
        if let Some(first) = primary.first() {
            let name = first.get("PK_NAME");
            let columns: Vec<String> = primary.iter().map(|row| row.get("COLUMN_NAME")).collect();
            out.push(self.key_node(node, &table, if name.is_empty() { "PRIMARY".to_string() } else { name }, format!("primary key ({})", columns.join(", "))));
        }
        let mut foreign: Vec<(String, String)> = Vec::new();
        for row in self.meta("importedKeys", node.db(), node.schema(), Some(&table)).await.unwrap_or_default() {
            let name = row.get("FK_NAME");
            let target = row.get("PKTABLE_NAME");
            if !foreign.iter().any(|(known, _)| *known == name) {
                foreign.push((name, target));
            }
        }
        for (name, target) in foreign {
            out.push(self.key_node(node, &table, if name.is_empty() { format!("→ {target}") } else { name }, format!("foreign key → {target}")));
        }
        Ok(out)
    }

    fn key_node(&self, node: &DbNodeRef, table: &str, name: String, detail: String) -> DbNode {
        DbNode {
            id: format!("jdbc-key:{}:{}:{table}:{name}", node.db().unwrap_or_default(), node.schema().unwrap_or_default()),
            kind: DbNodeKind::Key,
            name,
            detail,
            database: node.db().map(str::to_string),
            schema: node.schema().map(str::to_string),
            table: Some(table.to_string()),
            has_children: false,
            column: None,
        }
    }

    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        let table = node.name()?.to_string();
        Ok(self
            .meta("importedKeys", node.db(), node.schema(), Some(&table))
            .await?
            .iter()
            .map(|row| DbForeignKey {
                column: row.get("FKCOLUMN_NAME"),
                ref_schema: Some(row.get("PKTABLE_SCHEM")).filter(|s| !s.is_empty()),
                ref_table: row.get("PKTABLE_NAME"),
                ref_column: row.get("PKCOLUMN_NAME"),
            })
            .collect())
    }

    // -------------------------------------------------------------- diagram

    pub async fn schema_objects(&self, node: &DbNodeRef) -> Result<Vec<DbObjectInfo>, String> {
        let rows = self.meta("tables", node.db(), node.schema(), None).await?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let object_type = row.get("TABLE_TYPE");
                let view = relation_kind(&object_type)?;
                Some(DbObjectInfo {
                    kind: if view { DbNodeKind::View } else { DbNodeKind::Table },
                    object_type,
                    created_at: None,
                    modified_at: None,
                    total_bytes: None,
                    used_bytes: None,
                    rows: None,
                    comment: row.get("REMARKS"),
                    name: row.get("TABLE_NAME"),
                })
            })
            .collect())
    }

    /// Every table and view of the schema with its columns, and the foreign keys between them —
    /// columns in one listing for the whole schema, keys a table at a time (see [`DIAGRAM_TABLES`]).
    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let relations = self.meta("tables", node.db(), node.schema(), None).await?;
        let mut tables: Vec<DbDiagramTable> = relations
            .iter()
            .filter_map(|row| {
                let view = relation_kind(&row.get("TABLE_TYPE"))?;
                Some(DbDiagramTable {
                    schema: node.schema().map(str::to_string),
                    name: row.get("TABLE_NAME"),
                    kind: if view { DbNodeKind::View } else { DbNodeKind::Table },
                    columns: Vec::new(),
                    row_estimate: None,
                })
            })
            .collect();
        let mut notes = Vec::new();
        if tables.len() > DIAGRAM_TABLES {
            notes.push(format!(
                "Showing the first {DIAGRAM_TABLES} of {} tables: the driver lists keys one table at a time.",
                tables.len()
            ));
            tables.truncate(DIAGRAM_TABLES);
        }
        for row in self.meta("columns", node.db(), node.schema(), None).await.unwrap_or_default() {
            let owner = row.get("TABLE_NAME");
            if let Some(table) = tables.iter_mut().find(|table| table.name == owner) {
                table.columns.push(DbDiagramColumn {
                    name: row.get("COLUMN_NAME"),
                    data_type: type_name(&row).to_lowercase(),
                    nullable: row.get("NULLABLE") != "0",
                    primary_key: false,
                    foreign_key: false,
                });
            }
        }
        let mut edges = Vec::new();
        for table in tables.iter_mut().filter(|table| table.kind == DbNodeKind::Table) {
            let keys = self.meta("primaryKeys", node.db(), node.schema(), Some(&table.name)).await.unwrap_or_default();
            for key in &keys {
                let column = key.get("COLUMN_NAME");
                if let Some(found) = table.columns.iter_mut().find(|c| c.name == column) {
                    found.primary_key = true;
                }
            }
            for row in self.meta("importedKeys", node.db(), node.schema(), Some(&table.name)).await.unwrap_or_default() {
                edges.push(DbDiagramEdge {
                    constraint: row.get("FK_NAME"),
                    from_schema: node.schema().map(str::to_string),
                    from_table: table.name.clone(),
                    from_column: row.get("FKCOLUMN_NAME"),
                    to_schema: Some(row.get("PKTABLE_SCHEM")).filter(|s| !s.is_empty()),
                    to_table: row.get("PKTABLE_NAME"),
                    to_column: row.get("PKCOLUMN_NAME"),
                    inferred: false,
                });
            }
        }
        super::mark_foreign_keys(&mut tables, &edges);
        Ok(DbSchemaDiagram { database: node.db().map(str::to_string), schema: node.schema().map(str::to_string), tables, edges, notes })
    }

    // ----------------------------------------------------------------- data

    /// The relation's name as SQL: `schema.table`, with the catalog in front when it is another
    /// catalog than the session's — the only case where leaving it out would name the wrong table.
    fn qualify(&self, node: &DbNodeRef) -> Result<String, String> {
        let name = node.name()?;
        let mut parts = Vec::new();
        if let Some(schema) = node.schema() {
            parts.push(quote_ident(schema, self.dialect));
        }
        parts.push(quote_ident(name, self.dialect));
        let mut qualified = parts.join(".");
        if let Some(catalog) = node.db().filter(|db| self.catalogs && !db.eq_ignore_ascii_case(&self.database)) {
            let catalog = quote_ident(catalog, self.dialect);
            qualified = if self.catalog_at_start {
                // A catalog without a schema is still `catalog..table` in the engines that write it
                // that way (SQL Server); the others take `catalog.table`.
                if node.schema().is_none() && self.dialect == SqlDialect::TSql {
                    format!("{catalog}{0}{0}{qualified}", self.catalog_separator)
                } else {
                    format!("{catalog}{}{qualified}", self.catalog_separator)
                }
            } else {
                format!("{qualified}{}{catalog}", self.catalog_separator)
            };
        }
        Ok(qualified)
    }

    /// `SELECT *` under the grid's filter and sort, plus one page — written the way the catalogue
    /// says this engine pages, and with the rows before the page skipped by the bridge where it has
    /// no way to skip them itself.
    fn page_query(&self, request: &DbTableDataRequest) -> Result<(String, u32), String> {
        let target = self.qualify(&request.node)?;
        let filter = request.filter.trim();
        let where_clause = if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") };
        let keys: Vec<String> = request
            .sort
            .iter()
            .filter(|key| !key.column.trim().is_empty())
            .map(|key| format!("{}{}", quote_ident(&key.column, self.dialect), if key.descending { " DESC" } else { " ASC" }))
            .collect();
        let order = if keys.is_empty() { String::new() } else { format!(" ORDER BY {}", keys.join(", ")) };
        let (offset, limit) = (request.offset, request.limit);
        let through = offset.saturating_add(limit);
        Ok(match self.driver.sql.paging {
            Paging::LimitOffset if offset == 0 => (format!("SELECT * FROM {target}{where_clause}{order} LIMIT {limit}"), 0),
            Paging::LimitOffset => (format!("SELECT * FROM {target}{where_clause}{order} LIMIT {limit} OFFSET {offset}"), 0),
            Paging::OffsetFetch => (
                format!("SELECT * FROM {target}{where_clause}{order} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"),
                0,
            ),
            Paging::FetchFirst => (format!("SELECT * FROM {target}{where_clause}{order} FETCH FIRST {through} ROWS ONLY"), offset),
            Paging::Limit => (format!("SELECT * FROM {target}{where_clause}{order} LIMIT {through}"), offset),
            Paging::Top => (format!("SELECT TOP {through} * FROM {target}{where_clause}{order}"), offset),
            Paging::None => (format!("SELECT * FROM {target}{where_clause}{order}"), offset),
        })
    }

    pub async fn table_data(&self, request: &DbTableDataRequest) -> Result<DbStatementResult, String> {
        let (sql, skip) = self.page_query(request)?;
        let answer = self.run(&sql, request.limit as usize, skip).await?;
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
        let target = self.qualify(node)?;
        let filter = filter.trim();
        let sql = if filter.is_empty() {
            format!("SELECT COUNT(*) FROM {target}")
        } else {
            format!("SELECT COUNT(*) FROM {target} WHERE {filter}")
        };
        let result = self.statement(&sql, 1).await;
        if let Some(error) = result.error {
            return Err(error);
        }
        Ok(result.rows.first().map(|row| cell(row, 0)).and_then(|value| value.trim().parse().ok()).unwrap_or_default())
    }

    /// The grid's edits as one JDBC transaction, through the bridge's `batch` — every UPDATE and
    /// DELETE expected to touch exactly one row, or the batch rolls back.
    pub async fn apply_edits(&self, node: &DbNodeRef, edits: &[DbRowEdit]) -> Result<DbEditResult, String> {
        if self.read_only {
            return Err(read_only_refusal());
        }
        let target = self.qualify(node)?;
        let statements = edits
            .iter()
            .map(|edit| sqlgen::edit_statement_for(&target, self.dialect, edit))
            .collect::<Result<Vec<String>, String>>()?;
        let request = jvm::edit_batch_request(&statements, edits);
        let answer = self.bridge.call("batch", &self.session_id, request).await?;
        Ok(jvm::edit_batch_result(&answer, statements))
    }

    /// A table's definition rebuilt from the driver's metadata — JDBC has no call for the server's
    /// own DDL, so this is what introspection saw, and says it is.
    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        if !matches!(node.kind, DbNodeKind::Table) {
            return Err(format!("The {} driver doesn't describe definitions; only a table's can be rebuilt from its columns.", self.driver.name));
        }
        let columns = self.columns(node).await?;
        let ddl = sqlgen::create_table_ddl(
            node,
            self.dialect,
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
        Ok(format!("-- Reconstructed from the {} driver's metadata.\n\n{ddl}", self.driver.name))
    }
}

impl Drop for JdbcSession {
    /// Releases the JDBC connection inside the JVM — see `IrisSession`'s, which this mirrors.
    fn drop(&mut self) {
        self.bridge.close_session_detached(std::mem::take(&mut self.session_id));
    }
}

/// One row of a `DatabaseMetaData` listing, read by the specification's column names — whatever
/// order and case the driver put them in.
struct MetaRow {
    names: Vec<String>,
    row: Vec<Option<String>>,
}

impl MetaRow {
    fn get(&self, name: &str) -> String {
        self.names.iter().position(|known| known == name).map(|index| cell(&self.row, index)).unwrap_or_default()
    }
}

/// Whether a `TABLE_TYPE` is a view (`Some(true)`), a table (`Some(false)`), or neither — the
/// system's own objects, indexes, sequences, synonyms — which the tree leaves out.
fn relation_kind(table_type: &str) -> Option<bool> {
    let upper = table_type.to_ascii_uppercase();
    if upper.contains("VIEW") {
        return (!upper.contains("SYSTEM")).then_some(true);
    }
    if upper.contains("SYSTEM") || upper.contains("INDEX") || upper.contains("SEQUENCE") || upper.contains("SYNONYM") || upper.contains("ALIAS") {
        return None;
    }
    Some(false)
}

/// A column's type as `TYPE_NAME(size[,digits])` where the size means something — for character
/// and decimal types, which is where a person reads it.
fn type_name(row: &MetaRow) -> String {
    let name = row.get("TYPE_NAME");
    let size = row.get("COLUMN_SIZE");
    let digits = row.get("DECIMAL_DIGITS");
    let upper = name.to_ascii_uppercase();
    if name.contains('(') || size.is_empty() || size == "0" {
        return name;
    }
    if upper.contains("CHAR") || upper.contains("BINARY") {
        return format!("{name}({size})");
    }
    if upper.contains("DEC") || upper.contains("NUMERIC") || upper == "NUMBER" {
        return if digits.is_empty() || digits == "0" { format!("{name}({size})") } else { format!("{name}({size},{digits})") };
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_row(pairs: &[(&str, &str)]) -> MetaRow {
        MetaRow {
            names: pairs.iter().map(|(name, _)| name.to_string()).collect(),
            row: pairs.iter().map(|(_, value)| Some(value.to_string())).collect(),
        }
    }

    #[test]
    fn table_types_sort_into_tables_views_and_neither() {
        assert_eq!(relation_kind("TABLE"), Some(false));
        assert_eq!(relation_kind("BASE TABLE"), Some(false));
        assert_eq!(relation_kind("MANAGED_TABLE"), Some(false));
        assert_eq!(relation_kind("VIEW"), Some(true));
        assert_eq!(relation_kind("MATERIALIZED VIEW"), Some(true));
        assert_eq!(relation_kind("SYSTEM TABLE"), None);
        assert_eq!(relation_kind("SYSTEM VIEW"), None);
        assert_eq!(relation_kind("INDEX"), None);
        assert_eq!(relation_kind("SEQUENCE"), None);
    }

    #[test]
    fn a_columns_type_carries_its_size_where_it_means_something() {
        assert_eq!(type_name(&meta_row(&[("TYPE_NAME", "VARCHAR"), ("COLUMN_SIZE", "40")])), "VARCHAR(40)");
        assert_eq!(type_name(&meta_row(&[("TYPE_NAME", "DECIMAL"), ("COLUMN_SIZE", "10"), ("DECIMAL_DIGITS", "2")])), "DECIMAL(10,2)");
        assert_eq!(type_name(&meta_row(&[("TYPE_NAME", "INTEGER"), ("COLUMN_SIZE", "32")])), "INTEGER");
        assert_eq!(type_name(&meta_row(&[("TYPE_NAME", "varchar(20)"), ("COLUMN_SIZE", "20")])), "varchar(20)");
    }

    #[test]
    fn a_metadata_row_is_read_by_name_whatever_the_drivers_case() {
        let row = meta_row(&[("TABLE_SCHEM", "APP"), ("TABLE_NAME", "USERS")]);
        assert_eq!(row.get("TABLE_NAME"), "USERS");
        assert_eq!(row.get("REMARKS"), "");
    }

    #[test]
    fn each_catalogue_dialect_quotes_its_own_way() {
        let traits = |dialect: &str| catalog::SqlTraits { dialect: dialect.into(), ..Default::default() };
        assert_eq!(quote_ident("a b", dialect_of(&traits("ansi"))), "\"a b\"");
        assert_eq!(quote_ident("a b", dialect_of(&traits("backtick"))), "`a b`");
        assert_eq!(quote_ident("a b", dialect_of(&traits("tsql"))), "[a b]");
    }
}
