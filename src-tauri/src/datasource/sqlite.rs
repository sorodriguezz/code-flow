//! SQLite — a database that is a file.
//!
//! The one engine here with no server: `database` is a path, the network fields are ignored, and
//! the driver is the same bundled SQLite the app keeps its own data in (`rusqlite`, already
//! compiled into the binary for that — so this engine adds no dependency at all).
//!
//! What being a file changes, against the other SQL drivers:
//!
//! - **Read-only is real.** A read-only connection is opened `SQLITE_OPEN_READ_ONLY`, so the guard
//!   is SQLite refusing to write the file, not a keyword check — and each statement's own
//!   `sqlite3_stmt_readonly` answers whether it would write, which is what the console asks before
//!   sending one, rather than the leading-keyword guess the servers get.
//! - **Cancel is real, and harmless.** `sqlite3_interrupt` stops the running statement at its next
//!   step with `SQLITE_INTERRUPT`; the connection is fine afterwards, so nothing is thrown away.
//! - **The DDL is the real DDL.** SQLite keeps each object's `CREATE` statement verbatim in
//!   `sqlite_master`, so the DDL tab shows the text that made the table, not a reconstruction.
//! - **Statements are split by SQLite.** A `CREATE TRIGGER … BEGIN …; …; END;` is full of semicolons
//!   no scanner can place; `rusqlite::Batch` prepares one statement at a time and SQLite's parser
//!   says where each ends.
//!
//! The connection is synchronous, so every call crosses to a blocking thread holding a `Mutex` on
//! it. One connection per session is plenty for a file; the lock is what lets the registry share
//! the session across tabs, since a `rusqlite::Connection` is `Send` but not `Sync`.
//!
//! Every value still crosses as text, like every other driver: integers and reals as SQLite prints
//! them, text as itself, and blobs as the `X'…'` literal that writes them back.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rusqlite::types::ValueRef;
use rusqlite::{Batch, Connection, InterruptHandle, OpenFlags};

use super::postgres::{annotate_types, cell, relation_folders, schema_folders};
use super::sqlgen::{self, quote_ident, quote_literal};
use super::{
    read_only_refusal, DbColumn, DbColumnInfo, DbConnectionConfig, DbDiagramColumn,
    DbDiagramEdge, DbDiagramTable, DbEditResult, DbExecContext, DbExecuteResult, DbForeignKey,
    DbKind, DbNode, DbNodeKind, DbNodeRef, DbObjectInfo, DbRowEdit, DbSchemaDiagram,
    DbServerInfo, DbStatementResult, DbTableDataRequest, SqlDialect,
};

const DIALECT: SqlDialect = SqlDialect::Sqlite;

/// How long a statement waits for another process's lock on the file before giving up. The app a
/// database belongs to is often running while it is inspected here; without a wait, the first read
/// that races its write fails with `database is locked` instead of simply taking a moment.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub struct SqliteSession {
    conn: Arc<Mutex<Connection>>,
    interrupt: Arc<InterruptHandle>,
    /// The file, as the user named it — for the tree's root and the server info.
    path: String,
    read_only: bool,
}

impl SqliteSession {
    pub async fn open(config: &DbConnectionConfig, _database: Option<&str>) -> Result<Self, String> {
        let path = database_path(config)?;
        let read_only = config.read_only;
        let opened_path = path.clone();
        let conn = tokio::task::spawn_blocking(move || open_file(&opened_path, read_only))
            .await
            .map_err(|e| format!("SQLite could not be opened: {e}"))??;
        let interrupt = Arc::new(conn.get_interrupt_handle());
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            interrupt,
            path,
            read_only,
        })
    }

    pub fn info(&self) -> DbServerInfo {
        let mut notes = Vec::new();
        if self.read_only {
            notes.push("Opened read-only: SQLite itself refuses every write to this file.".to_string());
        }
        DbServerInfo {
            kind: DbKind::Sqlite,
            version: format!("SQLite {}", rusqlite::version()),
            database: file_label(&self.path),
            user: String::new(),
            notes,
        }
    }

    /// Stops whatever this session is running, at SQLite's next step.
    pub fn cancel_running(&self) {
        self.interrupt.interrupt();
    }

    /// Runs `work` on a blocking thread with the connection locked.
    async fn with_conn<T, F>(&self, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().map_err(|_| "The SQLite connection is unusable after a failed call.".to_string())?;
            work(&guard)
        })
        .await
        .map_err(|e| format!("The SQLite call stopped unexpectedly: {e}"))?
    }

    /// Rows only, with a failure as a real error. Every catalog query goes through this.
    async fn rows(&self, sql: String) -> Result<Vec<Vec<Option<String>>>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let width = statement.column_count();
            let mut rows = statement.raw_query();
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut values = Vec::with_capacity(width);
                for index in 0..width {
                    values.push(text_of(row.get_ref(index).map_err(|e| e.to_string())?));
                }
                out.push(values);
            }
            Ok(out)
        })
        .await
    }

    async fn scalar(&self, sql: String) -> Result<Option<String>, String> {
        Ok(self.rows(sql).await?.first().and_then(|row| row.first().cloned()).flatten())
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = Instant::now();
        let sql = sql.to_string();
        let limit = ctx.limit();
        let read_only = self.read_only;
        let results = self.with_conn(move |conn| Ok(run_batch(conn, &sql, limit, read_only))).await?;
        Ok(DbExecuteResult {
            results,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// SQLite's plan, as the indented tree `EXPLAIN QUERY PLAN` describes: each row names its
    /// parent, and the depth is how far up that chain goes.
    pub async fn explain(&self, sql: &str, _ctx: &DbExecContext) -> Result<String, String> {
        let statement = sql.trim().trim_end_matches(';').trim();
        if statement.is_empty() {
            return Err("There is no statement to explain.".to_string());
        }
        let rows = self.rows(format!("EXPLAIN QUERY PLAN {statement}")).await?;
        let parsed: Vec<(i64, i64, String)> = rows
            .iter()
            .map(|row| (cell(row, 0).parse().unwrap_or(0), cell(row, 1).parse().unwrap_or(0), cell(row, 3)))
            .collect();
        let depth_of = |mut parent: i64| {
            let mut depth = 0;
            while parent != 0 {
                depth += 1;
                parent = parsed.iter().find(|(id, _, _)| *id == parent).map(|(_, p, _)| *p).unwrap_or(0);
                if depth > 64 {
                    break;
                }
            }
            depth
        };
        Ok(parsed
            .iter()
            .map(|(_, parent, detail)| format!("{}{detail}", "  ".repeat(depth_of(*parent))))
            .collect::<Vec<_>>()
            .join("\n"))
    }

    // ------------------------------------------------------------ introspect

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => Ok(vec![DbNode {
                id: "file".to_string(),
                kind: DbNodeKind::Database,
                name: file_label(&self.path),
                detail: self.path.clone(),
                database: Some(file_label(&self.path)),
                schema: None,
                table: None,
                has_children: true,
                column: None,
            }]),
            DbNodeKind::Database => self.schemas(node).await,
            DbNodeKind::Schema => Ok(schema_folders(node)),
            DbNodeKind::TableFolder => self.relations(node, "table").await,
            DbNodeKind::ViewFolder => self.relations(node, "view").await,
            // SQLite has no stored routines and no sequences of its own (`AUTOINCREMENT` keeps its
            // counters in the `sqlite_sequence` table, which the table list already shows). Empty
            // folders are the true answer.
            DbNodeKind::RoutineFolder | DbNodeKind::SequenceFolder => Ok(Vec::new()),
            DbNodeKind::Table | DbNodeKind::View => Ok(relation_folders(node)),
            DbNodeKind::ColumnFolder => self.columns(node).await,
            DbNodeKind::IndexFolder => self.indexes(node).await,
            DbNodeKind::KeyFolder => self.keys(node).await,
            _ => Ok(Vec::new()),
        }
    }

    /// `main`, and whatever else is attached. `temp` only when something lives in it — it always
    /// exists, and an empty folder named after a scratch area is noise.
    async fn schemas(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let rows = self.rows("SELECT name FROM pragma_database_list ORDER BY seq".to_string()).await?;
        let mut names = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            if name == "temp" {
                let count = self
                    .scalar("SELECT COUNT(*) FROM temp.sqlite_master".to_string())
                    .await
                    .ok()
                    .flatten()
                    .and_then(|n| n.parse::<i64>().ok())
                    .unwrap_or(0);
                if count == 0 {
                    continue;
                }
            }
            names.push(name);
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

    async fn relations(&self, node: &DbNodeRef, kind: &str) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let rows = self
            .rows(format!(
                "SELECT name FROM {}.sqlite_master WHERE type = {} AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                 ORDER BY name",
                quote_ident(&schema, DIALECT),
                quote_literal(Some(kind))?
            ))
            .await?;
        let node_kind = if kind == "view" { DbNodeKind::View } else { DbNodeKind::Table };
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                DbNode {
                    id: format!("rel:{schema}:{name}"),
                    kind: node_kind,
                    name: name.clone(),
                    detail: String::new(),
                    database: node.db().map(str::to_string),
                    schema: Some(schema.clone()),
                    table: Some(name),
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    /// `pragma_table_info` — the table-valued form of `PRAGMA table_info`, so the schema and the
    /// table can both be passed as quoted literals rather than spliced into a pragma's syntax.
    async fn columns(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(format!(
                "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info({}, {}) ORDER BY cid",
                quote_literal(Some(&table))?,
                quote_literal(Some(&schema))?
            ))
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 1);
                let data_type = cell(row, 2);
                let nullable = cell(row, 3) != "1";
                let default = cell(row, 4);
                let primary_key = cell(row, 5).parse::<i64>().unwrap_or(0) > 0;
                let mut detail = if data_type.is_empty() { "any".to_string() } else { data_type.to_lowercase() };
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
                        position: cell(row, 0).parse::<i64>().unwrap_or(0) + 1,
                    }),
                }
            })
            .collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(format!(
                "SELECT il.name, il.\"unique\", ii.name FROM pragma_index_list({table}, {schema}) il \
                 JOIN pragma_index_info(il.name, {schema}) ii ORDER BY il.name, ii.seqno",
                table = quote_literal(Some(&table))?,
                schema = quote_literal(Some(&schema))?
            ))
            .await?;
        let mut grouped: Vec<(String, Vec<String>, bool)> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let column = cell(row, 2);
            match grouped.iter_mut().find(|(existing, _, _)| *existing == name) {
                Some((_, columns, _)) => columns.push(column),
                None => grouped.push((name, vec![column], cell(row, 1) == "1")),
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

    /// The primary key and the foreign keys. SQLite's foreign keys are usually unnamed, so they are
    /// named by what they do rather than by an identifier nobody wrote.
    async fn keys(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let table = node.name()?.to_string();
        let mut out = Vec::new();
        let key_columns: Vec<String> = self
            .columns(node)
            .await?
            .into_iter()
            .filter(|c| c.column.as_ref().is_some_and(|info| info.primary_key))
            .map(|c| c.name)
            .collect();
        if !key_columns.is_empty() {
            out.push(DbNode {
                id: format!("key:{schema}:{table}:pk"),
                kind: DbNodeKind::Key,
                name: "PRIMARY KEY".to_string(),
                detail: format!("primary key ({})", key_columns.join(", ")),
                database: node.db().map(str::to_string),
                schema: Some(schema.clone()),
                table: Some(table.clone()),
                has_children: false,
                column: None,
            });
        }
        for key in self.foreign_keys(node).await.unwrap_or_default() {
            out.push(DbNode {
                id: format!("key:{schema}:{table}:fk:{}", key.column),
                kind: DbNodeKind::Key,
                name: format!("FOREIGN KEY ({})", key.column),
                detail: format!("foreign key → {}({})", key.ref_table, key.ref_column),
                database: node.db().map(str::to_string),
                schema: Some(schema.clone()),
                table: Some(table.clone()),
                has_children: false,
                column: None,
            });
        }
        Ok(out)
    }

    /// One row per column pair. `to` is NULL when the constraint names only the parent table —
    /// SQLite then means the parent's primary key, in order, so the gap is filled from that.
    pub async fn foreign_keys(&self, node: &DbNodeRef) -> Result<Vec<DbForeignKey>, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let table = node.name()?.to_string();
        let rows = self
            .rows(format!(
                "SELECT \"from\", \"table\", \"to\", seq FROM pragma_foreign_key_list({}, {}) ORDER BY id, seq",
                quote_literal(Some(&table))?,
                quote_literal(Some(&schema))?
            ))
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            let parent = cell(row, 1);
            let mut to = cell(row, 2);
            if to.is_empty() {
                let parent_ref = DbNodeRef {
                    kind: DbNodeKind::Table,
                    database: node.database.clone(),
                    schema: Some(schema.clone()),
                    name: Some(parent.clone()),
                };
                let seq: usize = cell(row, 3).parse().unwrap_or(0);
                to = self
                    .columns(&parent_ref)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|c| c.column.as_ref().is_some_and(|info| info.primary_key))
                    .nth(seq)
                    .map(|c| c.name)
                    .unwrap_or_default();
            }
            out.push(DbForeignKey {
                column: cell(row, 0),
                ref_schema: Some(schema.clone()),
                ref_table: parent,
                ref_column: to,
            });
        }
        Ok(out)
    }

    // -------------------------------------------------------------- diagram

    /// Every table and view of one attached database. Rows come from `sqlite_stat1` when the file
    /// has been `ANALYZE`d (its first number is the table's row count at the time); sizes from the
    /// `dbstat` virtual table, which the bundled SQLite is built with. Either can be missing, and
    /// then the cell is left empty rather than guessed.
    pub async fn schema_objects(&self, node: &DbNodeRef) -> Result<Vec<DbObjectInfo>, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let master = format!("{}.sqlite_master", quote_ident(&schema, DIALECT));
        let rows = self
            .rows(format!(
                "SELECT name, type FROM {master} WHERE type IN ('table', 'view') \
                 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
            ))
            .await?;
        let stats = self
            .rows(format!("SELECT tbl, stat FROM {}.sqlite_stat1", quote_ident(&schema, DIALECT)))
            .await
            .unwrap_or_default();
        let sizes = self
            .rows(format!(
                "SELECT name, SUM(pgsize), SUM(pgsize - unused) FROM dbstat({}) GROUP BY name",
                quote_literal(Some(&schema))?
            ))
            .await
            .unwrap_or_default();
        Ok(rows
            .iter()
            .map(|row| {
                let name = cell(row, 0);
                let object_type = cell(row, 1);
                let size = sizes.iter().find(|s| cell(s, 0) == name);
                DbObjectInfo {
                    kind: if object_type == "view" { DbNodeKind::View } else { DbNodeKind::Table },
                    object_type: object_type.to_uppercase(),
                    created_at: None,
                    modified_at: None,
                    total_bytes: size.and_then(|s| cell(s, 1).parse().ok()),
                    used_bytes: size.and_then(|s| cell(s, 2).parse().ok()),
                    rows: stats
                        .iter()
                        .find(|s| cell(s, 0) == name)
                        .and_then(|s| cell(s, 1).split_whitespace().next().and_then(|n| n.parse().ok())),
                    comment: String::new(),
                    name,
                }
            })
            .collect())
    }

    /// The whole database in two queries: every column of every table and view, then every foreign
    /// key — each through a table-valued pragma joined to `sqlite_master`, so neither is a query per
    /// table.
    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let master = format!("{}.sqlite_master", quote_ident(&schema, DIALECT));
        let literal = quote_literal(Some(&schema))?;
        let rows = self
            .rows(format!(
                "SELECT m.name, m.type, p.name, p.type, p.\"notnull\", p.pk \
                 FROM {master} m JOIN pragma_table_info(m.name, {literal}) p \
                 WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                 ORDER BY m.name, p.cid"
            ))
            .await?;
        let mut tables: Vec<DbDiagramTable> = Vec::new();
        // (table, pk ordinal, column) — to resolve a foreign key that names only its parent table.
        let mut primary: Vec<(String, i64, String)> = Vec::new();
        for row in &rows {
            let name = cell(row, 0);
            let table = match tables.last_mut() {
                Some(last) if last.name == name => last,
                _ => {
                    tables.push(DbDiagramTable {
                        schema: Some(schema.clone()),
                        name: name.clone(),
                        kind: if cell(row, 1) == "view" { DbNodeKind::View } else { DbNodeKind::Table },
                        columns: Vec::new(),
                        row_estimate: None,
                    });
                    tables.last_mut().expect("just pushed")
                }
            };
            let pk = cell(row, 5).parse::<i64>().unwrap_or(0);
            if pk > 0 {
                primary.push((name.clone(), pk, cell(row, 2)));
            }
            table.columns.push(DbDiagramColumn {
                name: cell(row, 2),
                data_type: cell(row, 3).to_lowercase(),
                nullable: cell(row, 4) != "1",
                primary_key: pk > 0,
                foreign_key: false,
            });
        }

        let edges = self
            .rows(format!(
                "SELECT m.name, f.id, f.\"from\", f.\"table\", f.\"to\", f.seq \
                 FROM {master} m JOIN pragma_foreign_key_list(m.name, {literal}) f \
                 WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq"
            ))
            .await?
            .iter()
            .map(|row| {
                let parent = cell(row, 3);
                let to = cell(row, 4);
                let to = if to.is_empty() {
                    let seq = cell(row, 5).parse::<i64>().unwrap_or(0) + 1;
                    primary
                        .iter()
                        .find(|(table, ordinal, _)| *table == parent && *ordinal == seq)
                        .map(|(_, _, column)| column.clone())
                        .unwrap_or_default()
                } else {
                    to
                };
                DbDiagramEdge {
                    constraint: format!("{}_fk{}", cell(row, 0), cell(row, 1)),
                    from_schema: Some(schema.clone()),
                    from_table: cell(row, 0),
                    from_column: cell(row, 2),
                    to_schema: Some(schema.clone()),
                    to_table: parent,
                    to_column: to,
                    inferred: false,
                }
            })
            .collect();

        Ok(DbSchemaDiagram {
            database: node.db().map(str::to_string),
            schema: Some(schema),
            tables,
            edges,
            notes: Vec::new(),
        })
    }

    // ----------------------------------------------------------------- data

    pub async fn table_data(&self, request: &DbTableDataRequest) -> Result<DbStatementResult, String> {
        let sql = sqlgen::select_page(
            &request.node,
            DIALECT,
            &request.filter,
            &request.sort,
            request.offset,
            request.limit,
        )?;
        let limit = request.limit as usize;
        let read_only = self.read_only;
        let statement = sql.clone();
        let mut result = self
            .with_conn(move |conn| {
                Ok(run_batch(conn, &statement, Some(limit), read_only).into_iter().next())
            })
            .await?
            .unwrap_or_else(|| DbStatementResult::empty(&sql));
        if let Some(error) = result.error.take() {
            return Err(error);
        }
        // SQLite types a result column only when it comes straight from a table column, and then
        // with its declared type — which is exactly what the catalog says too, but the catalog also
        // covers a view's columns, which the statement cannot type.
        if let Ok(columns) = self.columns(&request.node).await {
            annotate_types(&mut result, &columns);
        }
        Ok(result)
    }

    pub async fn row_count(&self, node: &DbNodeRef, filter: &str) -> Result<i64, String> {
        let sql = sqlgen::count_rows(node, DIALECT, filter)?;
        Ok(self.scalar(sql).await?.and_then(|value| value.parse().ok()).unwrap_or_default())
    }

    /// Applies the grid's edits as one transaction: every statement commits together or none do.
    pub async fn apply_edits(&self, node: &DbNodeRef, edits: &[DbRowEdit]) -> Result<DbEditResult, String> {
        if self.read_only {
            return Err(read_only_refusal());
        }
        let statements = edits
            .iter()
            .map(|edit| sqlgen::edit_statement(node, DIALECT, edit))
            .collect::<Result<Vec<String>, String>>()?;
        let batch = statements.clone();
        let (applied, error) = self
            .with_conn(move |conn| {
                if let Err(e) = conn.execute_batch("BEGIN") {
                    return Ok((0, Some(e.to_string())));
                }
                let mut applied = 0u32;
                for statement in &batch {
                    if let Err(e) = conn.execute(statement, []) {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Ok((0, Some(format!("{e}\n\n{statement}"))));
                    }
                    applied += 1;
                }
                match conn.execute_batch("COMMIT") {
                    Ok(()) => Ok((applied, None)),
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        Ok((0, Some(e.to_string())))
                    }
                }
            })
            .await?;
        Ok(DbEditResult { applied, statements, error })
    }

    /// The object's own `CREATE` statement, as SQLite stored it, with the indexes and triggers that
    /// belong to it after — the whole definition, in the words it was written in.
    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        let schema = node.schema().unwrap_or("main").to_string();
        let name = node.name()?.to_string();
        let master = format!("{}.sqlite_master", quote_ident(&schema, DIALECT));
        let own = self
            .scalar(format!("SELECT sql FROM {master} WHERE name = {}", quote_literal(Some(&name))?))
            .await?
            .ok_or_else(|| format!("SQLite has no definition stored for {name}."))?;
        let mut ddl = format!("{};", own.trim_end_matches(';'));
        let extras = self
            .rows(format!(
                "SELECT sql FROM {master} WHERE tbl_name = {} AND type IN ('index', 'trigger') \
                 AND sql IS NOT NULL ORDER BY type, name",
                quote_literal(Some(&name))?
            ))
            .await
            .unwrap_or_default();
        for row in extras {
            let sql = cell(&row, 0);
            ddl.push_str(&format!("\n\n{};", sql.trim_end_matches(';')));
        }
        Ok(ddl)
    }
}

// ---------------------------------------------------------------------------
// Running statements
// ---------------------------------------------------------------------------

/// Runs every statement of `sql` in order, the way the console reports them: one result each, and
/// the first failure ends the batch with its error in place.
///
/// The statement text each result carries is SQLite's own slice of the input (`expanded_sql`),
/// which starts where the previous one ended — so the offsets add up, and a statement that fails to
/// even parse is reported with the part of the buffer SQLite choked on.
fn run_batch(conn: &Connection, sql: &str, limit: Option<usize>, read_only: bool) -> Vec<DbStatementResult> {
    let mut results = Vec::new();
    let mut consumed = 0usize;
    let mut batch = Batch::new(conn, sql);
    loop {
        let started = Instant::now();
        let mut statement = match batch.next() {
            Ok(Some(statement)) => statement,
            Ok(None) => break,
            Err(error) => {
                let rest = sql.get(consumed..).unwrap_or_default().trim();
                let shown = rest.split(';').next().unwrap_or(rest).trim();
                results.push(DbStatementResult::failed(shown, error.to_string()));
                break;
            }
        };
        let text = statement.expanded_sql().unwrap_or_default();
        consumed += text.len();
        let shown = text.trim().to_string();

        if read_only && !statement.readonly() {
            results.push(DbStatementResult::failed(
                &shown,
                "This connection is marked read-only, so this statement was not run. Turn off \
                 \"Read-only\" in the connection's settings to run it.",
            ));
            break;
        }

        let mut result = DbStatementResult::empty(&shown);
        let width = statement.column_count();
        if width > 0 {
            result.columns = statement
                .columns()
                .iter()
                .map(|column| DbColumn::new(column.name(), column.decl_type().unwrap_or_default()))
                .collect();
            let mut rows = statement.raw_query();
            loop {
                match rows.next() {
                    Ok(Some(row)) => {
                        if limit.is_some_and(|max| result.rows.len() >= max) {
                            result.truncated = true;
                            break;
                        }
                        let mut values = Vec::with_capacity(width);
                        for index in 0..width {
                            values.push(row.get_ref(index).map(text_of).unwrap_or(None));
                        }
                        result.rows.push(values);
                    }
                    Ok(None) => break,
                    Err(error) => {
                        result.error = Some(interrupted_or(error));
                        break;
                    }
                }
            }
        } else {
            match statement.raw_execute() {
                // `changes()` keeps the last DML's count through a DDL statement, so it is only
                // reported for the statements that can change rows.
                Ok(_) => result.rows_affected = writes_rows(&shown).then(|| conn.changes() as i64),
                Err(error) => result.error = Some(interrupted_or(error)),
            }
        }
        result.duration_ms = started.elapsed().as_millis() as u64;
        let failed = result.error.is_some();
        results.push(result);
        if failed {
            break;
        }
    }
    results
}

/// A cancelled statement reads as cancelled, in the one wording the frontend recognises.
fn interrupted_or(error: rusqlite::Error) -> String {
    match &error {
        rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::OperationInterrupted => {
            super::CANCELLED.to_string()
        }
        _ => error.to_string(),
    }
}

/// Whether a statement is one whose `changes()` means something: `INSERT`, `UPDATE`, `DELETE` and
/// `REPLACE`, possibly behind a `WITH`. Comments before it are skipped.
fn writes_rows(statement: &str) -> bool {
    let mut rest = statement.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("").trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map(|(_, tail)| tail).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    let upper = rest.to_ascii_uppercase();
    ["INSERT", "UPDATE", "DELETE", "REPLACE", "WITH"]
        .iter()
        .any(|keyword| upper.starts_with(keyword))
}

/// One SQLite value as the text the grid shows and an edit can write back.
///
/// Reals through `{:?}`, which is Rust's shortest round-tripping form and, like SQLite's own
/// printing, keeps the `.0` on a whole number — `100.0` stays a real and `1e300` stays short.
fn text_of(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Null => None,
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(f) => Some(format!("{f:?}")),
        ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Some(format!(
            "X'{}'",
            bytes.iter().map(|b| format!("{b:02X}")).collect::<String>()
        )),
    }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/// The database file a connection names: the Database field, or the URL for a connection pasted as
/// one (`sqlite:///path`, `sqlite:path`, `file:path`).
fn database_path(config: &DbConnectionConfig) -> Result<String, String> {
    let named = config.database.trim();
    let raw = if !named.is_empty() {
        named.to_string()
    } else {
        let url = config.url.trim();
        url.strip_prefix("sqlite://")
            .or_else(|| url.strip_prefix("sqlite:"))
            .or_else(|| url.strip_prefix("file://"))
            .or_else(|| url.strip_prefix("file:"))
            .unwrap_or(url)
            .to_string()
    };
    if raw.is_empty() {
        return Err("Choose the SQLite database file to open.".to_string());
    }
    Ok(expand_home(&raw))
}

fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Opens the file — never creating one.
///
/// SQLite's default is to create a missing file, and for a database *client* that is the wrong
/// default: a path with a typo in it would open a brand-new empty database and show an empty tree,
/// which reads as "your data is gone" rather than "that file isn't there". `:memory:` is the one
/// exception, being a scratch database by definition.
fn open_file(path: &str, read_only: bool) -> Result<Connection, String> {
    if path != ":memory:" && !Path::new(path).is_file() {
        return Err(format!(
            "There is no SQLite database at {path}. Check the path — CodeFlow opens an existing file \
             and does not create one."
        ));
    }
    let mut flags = OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
    flags |= if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let conn = Connection::open_with_flags(path, flags).map_err(|e| format!("SQLite could not open {path}: {e}"))?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(|e| e.to_string())?;
    // A file that isn't a database fails on its first read, not on open — so read once now, and
    // the error lands on "Connect" rather than on the first thing the user clicks.
    conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|e| format!("{path} could not be read as a SQLite database: {e}"))?;
    Ok(conn)
}

/// The file's name, for the tree's root and the header.
fn file_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::{DbCell, DbRowEditKind};

    /// A directory of its own under the system temp dir, removed when dropped.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("codeflow-sqlite-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TempDir, String) {
        let dir = TempDir::new();
        let path = dir.path().join("shop.db");
        let conn = Connection::open(&path).expect("create");
        conn.execute_batch(
            "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar BLOB);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers, total REAL);
             CREATE INDEX orders_customer ON orders (customer_id);
             CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
             INSERT INTO customers (name, avatar) VALUES ('Ada', X'00FF'), ('O''Brien', NULL);
             INSERT INTO orders (customer_id, total) VALUES (1, 150.0), (2, 20.5);",
        )
        .expect("fixture");
        let path = path.to_string_lossy().into_owned();
        (dir, path)
    }

    fn config(path: &str, read_only: bool) -> DbConnectionConfig {
        let mut config = crate::datasource::tests_support::config(DbKind::Sqlite);
        config.database = path.to_string();
        config.read_only = read_only;
        config
    }

    fn ctx() -> DbExecContext {
        DbExecContext { database: None, schema: None, max_rows: 100 }
    }

    fn table(name: &str) -> DbNodeRef {
        DbNodeRef { kind: DbNodeKind::Table, database: Some("shop.db".into()), schema: Some("main".into()), name: Some(name.into()) }
    }

    #[tokio::test]
    async fn a_missing_file_is_refused_rather_than_created() {
        let dir = TempDir::new();
        let path = dir.path().join("typo.db").to_string_lossy().into_owned();
        let error = SqliteSession::open(&config(&path, false), None).await.err().expect("refused");
        assert!(error.contains("no SQLite database"), "{error}");
        assert!(!Path::new(&path).exists(), "the file must not have been created");
    }

    #[tokio::test]
    async fn statements_split_where_sqlite_says_and_values_come_back_as_text() {
        let (_dir, path) = fixture();
        let session = SqliteSession::open(&config(&path, false), None).await.unwrap();
        let run = session
            .execute(
                "CREATE TRIGGER stamp AFTER INSERT ON orders BEGIN UPDATE orders SET total = total; END;\n\
                 SELECT id, name, avatar, 1.5, NULL FROM customers ORDER BY id;\n\
                 UPDATE orders SET total = total + 1;",
                &ctx(),
            )
            .await
            .unwrap();
        assert_eq!(run.results.len(), 3, "{:?}", run.results.iter().map(|r| &r.statement).collect::<Vec<_>>());
        assert!(run.results[0].statement.ends_with("END;"), "{}", run.results[0].statement);
        assert_eq!(run.results[0].rows_affected, None);
        let select = &run.results[1];
        assert_eq!(select.rows[0], vec![Some("1".into()), Some("Ada".into()), Some("X'00FF'".into()), Some("1.5".into()), None]);
        assert_eq!(select.rows[1][1].as_deref(), Some("O'Brien"));
        assert_eq!(select.columns[1].type_name, "TEXT");
        assert_eq!(run.results[2].rows_affected, Some(2));
    }

    #[tokio::test]
    async fn a_parse_error_stops_the_batch_where_it_happened() {
        let (_dir, path) = fixture();
        let session = SqliteSession::open(&config(&path, false), None).await.unwrap();
        let run = session.execute("SELECT 1; SELEC 2; SELECT 3;", &ctx()).await.unwrap();
        assert_eq!(run.results.len(), 2);
        assert!(run.results[1].error.as_deref().unwrap_or_default().contains("syntax error"));
        assert_eq!(run.results[1].statement, "SELEC 2");
    }

    #[tokio::test]
    async fn read_only_is_enforced_by_sqlite_and_by_the_statement() {
        let (_dir, path) = fixture();
        let session = SqliteSession::open(&config(&path, true), None).await.unwrap();
        let run = session.execute("SELECT COUNT(*) FROM orders; DELETE FROM orders;", &ctx()).await.unwrap();
        assert_eq!(run.results[0].rows[0][0].as_deref(), Some("2"));
        assert!(run.results[1].error.as_deref().unwrap_or_default().contains("read-only"));
        let refused = session
            .apply_edits(&table("orders"), &[DbRowEdit { kind: DbRowEditKind::Delete, values: vec![], keys: vec![], document: None }])
            .await;
        assert!(refused.is_err());
    }

    #[tokio::test]
    async fn the_tree_walks_file_schema_tables_and_columns() {
        let (_dir, path) = fixture();
        let session = SqliteSession::open(&config(&path, false), None).await.unwrap();
        let root = session.children(&DbNodeRef { kind: DbNodeKind::Root, database: None, schema: None, name: None }).await.unwrap();
        assert_eq!(root[0].name, "shop.db");
        let schemas = session
            .children(&DbNodeRef { kind: DbNodeKind::Database, database: Some("shop.db".into()), schema: None, name: None })
            .await
            .unwrap();
        assert_eq!(schemas.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["main"]);
        let folder = |kind| DbNodeRef { kind, database: Some("shop.db".into()), schema: Some("main".into()), name: None };
        let tables = session.children(&folder(DbNodeKind::TableFolder)).await.unwrap();
        assert_eq!(tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["customers", "orders"]);
        let views = session.children(&folder(DbNodeKind::ViewFolder)).await.unwrap();
        assert_eq!(views[0].name, "big_orders");
        let columns = session.columns(&table("customers")).await.unwrap();
        assert!(columns[0].column.as_ref().unwrap().primary_key);
        assert!(!columns[1].column.as_ref().unwrap().nullable);
        let indexes = session.indexes(&table("orders")).await.unwrap();
        assert_eq!(indexes[0].detail, "(customer_id)");
    }

    /// `REFERENCES customers` names no column, which SQLite reads as "its primary key" — the
    /// grid's link and the diagram's line both need that filled in.
    #[tokio::test]
    async fn a_foreign_key_to_an_implicit_primary_key_is_resolved() {
        let (_dir, path) = fixture();
        let session = SqliteSession::open(&config(&path, false), None).await.unwrap();
        let keys = session.foreign_keys(&table("orders")).await.unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!((keys[0].column.as_str(), keys[0].ref_table.as_str(), keys[0].ref_column.as_str()), ("customer_id", "customers", "id"));
        let diagram = session
            .schema_diagram(&DbNodeRef { kind: DbNodeKind::Schema, database: Some("shop.db".into()), schema: Some("main".into()), name: None })
            .await
            .unwrap();
        assert_eq!(diagram.edges.len(), 1);
        assert_eq!(diagram.edges[0].to_column, "id");
        assert_eq!(diagram.tables.len(), 3);
    }

    #[tokio::test]
    async fn edits_page_and_ddl_round_trip() {
        let (_dir, path) = fixture();
        let session = SqliteSession::open(&config(&path, false), None).await.unwrap();
        let cell = |column: &str, value: Option<&str>, type_name: &str| DbCell {
            column: column.into(),
            value: value.map(str::to_string),
            type_name: type_name.into(),
        };
        let result = session
            .apply_edits(
                &table("customers"),
                &[
                    DbRowEdit {
                        kind: DbRowEditKind::Update,
                        values: vec![cell("name", Some("Ada L."), "TEXT"), cell("avatar", Some("X'0102'"), "BLOB")],
                        keys: vec![cell("id", Some("1"), "INTEGER")],
                        document: None,
                    },
                    DbRowEdit {
                        kind: DbRowEditKind::Insert,
                        values: vec![cell("name", Some("Grace"), "TEXT")],
                        keys: vec![],
                        document: None,
                    },
                ],
            )
            .await
            .unwrap();
        assert_eq!(result.applied, 2, "{:?}", result.error);
        let page = session
            .table_data(&DbTableDataRequest {
                node: table("customers"),
                offset: 0,
                limit: 2,
                sort: vec![],
                filter: String::new(),
                options: Default::default(),
            })
            .await
            .unwrap();
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.rows[0][1].as_deref(), Some("Ada L."));
        // The blob went back as a blob, not as the text of its literal.
        assert_eq!(page.rows[0][2].as_deref(), Some("X'0102'"));
        assert_eq!(session.row_count(&table("customers"), "").await.unwrap(), 3);
        let ddl = session.object_ddl(&table("orders")).await.unwrap();
        assert!(ddl.starts_with("CREATE TABLE orders"), "{ddl}");
        assert!(ddl.contains("CREATE INDEX orders_customer"), "{ddl}");
        let plan = session.explain("SELECT * FROM orders WHERE customer_id = 1", &ctx()).await.unwrap();
        assert!(plan.to_ascii_uppercase().contains("ORDERS"), "{plan}");
    }

    /// A failing statement rolls the whole batch back — the preview promised all or nothing.
    #[tokio::test]
    async fn a_failed_edit_rolls_the_batch_back() {
        let (_dir, path) = fixture();
        let session = SqliteSession::open(&config(&path, false), None).await.unwrap();
        let cell = |column: &str, value: Option<&str>| DbCell { column: column.into(), value: value.map(str::to_string), type_name: String::new() };
        let result = session
            .apply_edits(
                &table("customers"),
                &[
                    DbRowEdit { kind: DbRowEditKind::Insert, values: vec![cell("name", Some("Kept?"))], keys: vec![], document: None },
                    DbRowEdit { kind: DbRowEditKind::Insert, values: vec![cell("name", None)], keys: vec![], document: None },
                ],
            )
            .await
            .unwrap();
        assert_eq!(result.applied, 0);
        assert!(result.error.as_deref().unwrap_or_default().contains("NOT NULL"), "{:?}", result.error);
        assert_eq!(session.row_count(&table("customers"), "").await.unwrap(), 2);
    }
}
