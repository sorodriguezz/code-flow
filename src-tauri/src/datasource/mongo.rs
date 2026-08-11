//! MongoDB.
//!
//! Everything goes through **`runCommand`** — one entry point, no typed builders. `find`, `update`,
//! `aggregate`, `listIndexes` and `dbStats` are all database commands, so a console built on
//! `runCommand` can express anything the server understands rather than the subset a driver's
//! fluent API happens to cover. It also means the shell syntax below is a thin translation layer
//! (`db.users.find({…})` → `{find: "users", filter: {…}}`) instead of a switch over driver methods.
//!
//! Two details are load-bearing:
//!
//! - **Key order is preserved.** A command document's *first* key is the command name, so a
//!   `{find: …, filter: …}` whose keys got sorted alphabetically becomes an invalid command. That
//!   rules out routing through `serde_json::Value` (whose map sorts) and is why documents are
//!   deserialized straight into a `bson::Document` and rendered back to JSON *text* by
//!   [`bson_to_json_text`] rather than to a `serde_json::Value`.
//!
//! - **The shell dialect isn't JSON.** `{_id: ObjectId('…')}` is what people paste out of Compass
//!   and out of documentation, so [`relax_to_json`] accepts unquoted keys, single quotes,
//!   `ObjectId()`, `ISODate()` and the `Number*` wrappers, then [`to_extended`] turns those into
//!   real BSON types.

use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, Credential, ServerAddress, Tls, TlsOptions};
use serde::Deserialize;

use super::{
    describe_db_error, read_only_refusal, DbColumn, DbColumnInfo, DbConnectionConfig,
    DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbEditResult, DbExecContext, DbExecuteResult,
    DbKind, DbNode, DbNodeKind, DbNodeRef, DbObjectInfo, DbQueryOptions, DbRowEdit, DbRowEditKind,
    DbSchemaDiagram, DbServerInfo,
    DbSslMode, DbStatementResult, DbTableDataRequest,
};

/// How many documents to look at when working out a collection's fields. A collection has no
/// schema, so the field list in the tree is a sample — and a sample big enough to be useful has to
/// stay small enough that expanding a node isn't a scan.
const FIELD_SAMPLE: i64 = 100;

/// How many collections a diagram will sample, and how deep. Two commands per collection is two
/// round trips per collection, so a database with hundreds of them would take minutes over the
/// internet — the diagram stops here and says in its notes that it did.
const DIAGRAM_COLLECTIONS: usize = 40;
const DIAGRAM_SAMPLE: i64 = 20;

pub struct MongoSession {
    client: mongodb::Client,
    database: String,
    user: String,
    version: String,
    read_only: bool,
}

impl MongoSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();
        let options = client_options(&config).await?;
        let client = mongodb::Client::with_options(options)
            .map_err(|e| describe_db_error(&config, "Connecting", &e.to_string()))?;

        let database = database
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_database(&config));

        let mut session = Self {
            client,
            database,
            user: config.user.clone(),
            version: String::new(),
            read_only: config.read_only,
        };

        // `Client::with_options` doesn't connect — the driver dials lazily on first use. Running
        // `buildInfo` here is what turns a wrong host or a bad password into an error the user sees
        // on "Test connection" instead of on their first query.
        let info = session
            .command(&session.database.clone(), doc! { "buildInfo": 1 })
            .await
            .map_err(|e| describe_db_error(&config, "Connecting", &e))?;
        session.version = info
            .get_str("version")
            .map(|v| format!("MongoDB {v}"))
            .unwrap_or_else(|_| "MongoDB".to_string());
        Ok(session)
    }

    pub fn info(&self) -> DbServerInfo {
        DbServerInfo {
            kind: DbKind::Mongodb,
            version: self.version.clone(),
            database: self.database.clone(),
            user: self.user.clone(),
            notes: Vec::new(),
        }
    }

    // ---------------------------------------------------------------- commands

    async fn command(&self, database: &str, command: Document) -> Result<Document, String> {
        let database = if database.is_empty() { &self.database } else { database };
        self.client
            .database(database)
            .run_command(command)
            .await
            .map_err(|e| mongo_error(&e))
    }

    /// Runs a cursor-producing command and collects up to `limit` documents.
    ///
    /// A command answers with the first batch inline and a cursor id for the rest; without the
    /// `getMore` loop below, "no limit" would silently mean "the first 101 documents", which is the
    /// kind of wrong answer a database client must never give.
    async fn cursor_command(
        &self,
        database: &str,
        command: Document,
        limit: Option<usize>,
    ) -> Result<(Vec<Document>, bool), String> {
        let first = self.command(database, command).await?;
        let cursor = first
            .get_document("cursor")
            .map_err(|_| format!("That command didn't return a cursor: {}", summarize(&first)))?;
        let namespace = cursor.get_str("ns").unwrap_or_default().to_string();
        let collection = namespace.split_once('.').map(|(_, c)| c.to_string()).unwrap_or_default();

        let mut documents: Vec<Document> = Vec::new();
        let mut truncated = false;
        let push_batch = |batch: &mongodb::bson::Array, documents: &mut Vec<Document>| -> bool {
            for value in batch {
                if limit.is_some_and(|max| documents.len() >= max) {
                    return true;
                }
                if let Bson::Document(document) = value {
                    documents.push(document.clone());
                }
            }
            false
        };

        if let Ok(batch) = cursor.get_array("firstBatch") {
            truncated = push_batch(batch, &mut documents);
        }
        let mut cursor_id = cursor.get_i64("id").unwrap_or(0);

        while cursor_id != 0 && !truncated && limit.is_none_or(|max| documents.len() < max) {
            let batch_size = limit.map(|max| (max - documents.len()) as i64).unwrap_or(1000);
            let more = self
                .command(
                    database,
                    doc! {
                        "getMore": cursor_id,
                        "collection": collection.clone(),
                        "batchSize": batch_size,
                    },
                )
                .await?;
            let next = more
                .get_document("cursor")
                .map_err(|_| "The server stopped returning cursor batches.".to_string())?;
            if let Ok(batch) = next.get_array("nextBatch") {
                if batch.is_empty() {
                    break;
                }
                truncated = push_batch(batch, &mut documents);
            }
            cursor_id = next.get_i64("id").unwrap_or(0);
        }

        // A cursor still open when we stopped means there was more to read.
        if cursor_id != 0 && limit.is_some() {
            truncated = true;
            let _ = self
                .command(database, doc! { "killCursors": collection, "cursors": [cursor_id] })
                .await;
        }
        Ok((documents, truncated))
    }

    pub async fn execute(&self, sql: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        let database = ctx
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| self.database.clone());

        let mut results = Vec::new();
        // Statements separated by `;` or by a blank line — a Mongo console has no terminator of its
        // own, and a blank line is how people actually separate two commands in a scratch buffer.
        for statement in split_mongo_statements(sql) {
            let statement_started = std::time::Instant::now();
            let mut result = match self.run_expression(&database, &statement, ctx).await {
                Ok(result) => result,
                Err(error) => DbStatementResult::failed(&statement, error),
            };
            result.duration_ms = statement_started.elapsed().as_millis() as u64;
            let failed = result.error.is_some();
            results.push(result);
            if failed {
                break;
            }
        }
        Ok(DbExecuteResult { results, duration_ms: started.elapsed().as_millis() as u64 })
    }

    /// One shell expression → one command → one result.
    async fn run_expression(
        &self,
        database: &str,
        statement: &str,
        ctx: &DbExecContext,
    ) -> Result<DbStatementResult, String> {
        let plan = plan_command(statement, ctx.limit())?;
        if self.read_only && plan.writes {
            return Err(read_only_refusal());
        }

        let mut result = DbStatementResult::empty(statement);
        if plan.cursor {
            let (documents, truncated) =
                self.cursor_command(database, plan.command, ctx.limit()).await?;
            result.truncated = truncated;
            fill_from_documents(&mut result, documents);
        } else {
            let answer = self.command(database, plan.command).await?;
            // A write's answer is a small status document (`n`, `nModified`, `ok`); showing it as a
            // one-row grid is more useful than a count, because it also carries `writeErrors`.
            if let Some(count) = write_count(&answer) {
                result.rows_affected = Some(count);
            }
            fill_from_documents(&mut result, vec![answer]);
        }
        Ok(result)
    }

    pub async fn explain(&self, sql: &str, ctx: &DbExecContext) -> Result<String, String> {
        let statement = split_mongo_statements(sql)
            .into_iter()
            .next()
            .ok_or_else(|| "There is no command to explain.".to_string())?;
        let plan = plan_command(&statement, ctx.limit())?;
        let database = ctx
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| self.database.clone());
        let explained = self
            .command(
                &database,
                doc! { "explain": plan.command, "verbosity": "queryPlanner" },
            )
            .await?;
        Ok(bson_to_json_text(&Bson::Document(explained), true))
    }

    // ------------------------------------------------------------ introspect

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => self.databases().await,
            DbNodeKind::Database => self.collections(node).await,
            DbNodeKind::Collection => Ok(collection_folders(node)),
            DbNodeKind::ColumnFolder => self.fields(node).await,
            DbNodeKind::IndexFolder => self.indexes(node).await,
            _ => Ok(Vec::new()),
        }
    }

    async fn databases(&self) -> Result<Vec<DbNode>, String> {
        // `listDatabases` needs a cluster-wide privilege an application user usually lacks. When it
        // is refused, the connection's own database is still perfectly usable — so the tree shows
        // that one rather than an error.
        let answer = match self.command("admin", doc! { "listDatabases": 1 }).await {
            Ok(answer) => answer,
            Err(_) => {
                return Ok(vec![database_node(&self.database, String::new())]);
            }
        };
        let Ok(databases) = answer.get_array("databases") else {
            return Ok(vec![database_node(&self.database, String::new())]);
        };
        Ok(databases
            .iter()
            .filter_map(|entry| entry.as_document())
            .map(|entry| {
                let name = entry.get_str("name").unwrap_or_default().to_string();
                let size = entry
                    .get_i64("sizeOnDisk")
                    .ok()
                    .or_else(|| entry.get_f64("sizeOnDisk").ok().map(|v| v as i64))
                    .map(human_bytes)
                    .unwrap_or_default();
                database_node(&name, size)
            })
            .collect())
    }

    async fn collections(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let (documents, _) = self
            .cursor_command(&database, doc! { "listCollections": 1 }, None)
            .await?;
        let mut nodes: Vec<DbNode> = documents
            .iter()
            .map(|entry| {
                let name = entry.get_str("name").unwrap_or_default().to_string();
                let kind = entry.get_str("type").unwrap_or("collection");
                DbNode {
                    id: format!("coll:{database}:{name}"),
                    kind: DbNodeKind::Collection,
                    name: name.clone(),
                    detail: if kind == "view" { "view".to_string() } else { String::new() },
                    database: Some(database.clone()),
                    schema: None,
                    table: Some(name),
                    has_children: true,
                    column: None,
                }
            })
            .collect();
        nodes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(nodes)
    }

    /// The fields seen in a sample of documents, with the BSON types each one held.
    ///
    /// Presented as the equivalent of a column list, with the sample size in the detail so nobody
    /// mistakes it for a schema — a field absent from all 100 sampled documents isn't listed, and
    /// that is a property of the sample, not of the collection.
    async fn fields(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let collection = node.name()?;
        let (documents, _) = self
            .cursor_command(
                &database,
                doc! { "find": collection, "limit": FIELD_SAMPLE, "batchSize": FIELD_SAMPLE },
                Some(FIELD_SAMPLE as usize),
            )
            .await?;

        // Insertion-ordered: `_id` first, then whatever the documents actually put next.
        let mut fields: Vec<(String, Vec<String>, usize)> = Vec::new();
        for document in &documents {
            for (key, value) in document {
                let type_name = bson_type_name(value).to_string();
                match fields.iter_mut().find(|(name, _, _)| name == key) {
                    Some((_, types, seen)) => {
                        *seen += 1;
                        if !types.contains(&type_name) {
                            types.push(type_name);
                        }
                    }
                    None => fields.push((key.clone(), vec![type_name], 1)),
                }
            }
        }

        let sampled = documents.len();
        Ok(fields
            .into_iter()
            .map(|(name, types, seen)| {
                let data_type = types.join(" | ");
                let always = seen == sampled && sampled > 0;
                DbNode {
                    id: format!("field:{database}:{collection}:{name}"),
                    kind: DbNodeKind::Column,
                    name: name.clone(),
                    detail: if always {
                        data_type.clone()
                    } else {
                        format!("{data_type} · in {seen}/{sampled} sampled")
                    },
                    database: Some(database.clone()),
                    schema: None,
                    table: Some(collection.to_string()),
                    has_children: false,
                    column: Some(DbColumnInfo {
                        data_type,
                        nullable: !always,
                        primary_key: name == "_id",
                        default_value: None,
                        position: 0,
                    }),
                }
            })
            .collect())
    }

    // -------------------------------------------------------------- diagram

    /// The database's collections, their sampled shape, and the references that shape *suggests*.
    ///
    /// Every other engine reads its relationships out of the catalog. Mongo has none to read: a
    /// reference between collections is a convention the application holds, which is why
    /// `foreign_keys` returns an empty list rather than guessing — following a guessed link would
    /// land the user on a wrong document.
    ///
    /// A diagram is the one place where the guess is worth making, because it is *read* rather than
    /// navigated, and because "which collections look like they point at each other" is the question
    /// being asked. So the edges here are marked `inferred`, drawn dashed, and counted apart — and a
    /// note says so on the panel. Nothing downstream may treat them as constraints.
    /// Every collection of a database, with what `collStats` will say about it.
    ///
    /// Mongo has no schema level, so the "schema" a caller points at is the database — the same
    /// substitution the diagram makes. It also records no creation or modification date for a
    /// collection, so those stay `None`: a collection comes into existence on its first insert,
    /// and there is nothing to report.
    ///
    /// One `collStats` per collection is a round trip each, which is why it is bounded. Past the
    /// cap the names are still listed — a database with a thousand collections is exactly the one
    /// where waiting for a thousand stat calls would be the wrong trade.
    pub async fn schema_objects(&self, node: &DbNodeRef) -> Result<Vec<DbObjectInfo>, String> {
        const MAX_STATS: usize = 300;
        let database = node.db().unwrap_or(&self.database).to_string();
        let (documents, _) = self
            .cursor_command(&database, doc! { "listCollections": 1 }, None)
            .await?;

        let mut out = Vec::with_capacity(documents.len());
        for (index, entry) in documents.iter().enumerate() {
            let name = entry.get_str("name").unwrap_or_default().to_string();
            let is_view = entry.get_str("type").unwrap_or("collection") == "view";
            let comment = entry
                .get_document("options")
                .ok()
                .and_then(|options| options.get_str("comment").ok())
                .unwrap_or_default()
                .to_string();

            // A view has no storage of its own, so asking for its stats is a round trip that can
            // only answer zero.
            let stats = if is_view || index >= MAX_STATS {
                None
            } else {
                self.command(&database, doc! { "collStats": name.clone() }).await.ok()
            };
            let number = |key: &str| -> Option<i64> {
                let stats = stats.as_ref()?;
                stats
                    .get_i64(key)
                    .ok()
                    .or_else(|| stats.get_i32(key).ok().map(i64::from))
                    .or_else(|| stats.get_f64(key).ok().map(|v| v as i64))
            };

            out.push(DbObjectInfo {
                name,
                kind: DbNodeKind::Collection,
                object_type: if is_view { "VIEW".to_string() } else { "COLLECTION".to_string() },
                created_at: None,
                modified_at: None,
                // `storageSize` is what the collection reserves on disk and `size` what the
                // documents actually occupy — the same reserved/used pair the SQL engines report.
                total_bytes: number("storageSize"),
                used_bytes: number("size"),
                rows: number("count"),
                comment,
            });
        }
        Ok(out)
    }

    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let mut names: Vec<String> = self
            .collections(node)
            .await?
            .into_iter()
            .map(|collection| collection.name)
            .collect();

        let mut notes = Vec::new();
        if names.len() > DIAGRAM_COLLECTIONS {
            notes.push(format!(
                "Showing the first {DIAGRAM_COLLECTIONS} of {} collections.",
                names.len()
            ));
            names.truncate(DIAGRAM_COLLECTIONS);
        }

        let mut tables = Vec::new();
        for name in names {
            let reference = DbNodeRef {
                kind: DbNodeKind::ColumnFolder,
                database: Some(database.clone()),
                schema: None,
                name: Some(name.clone()),
            };
            // A collection whose sample can't be read (a view over a missing source, a permission
            // that stops at one namespace) still belongs on the canvas as an empty box: it exists,
            // and other collections may point at it.
            let fields = self.sampled_fields(&reference, DIAGRAM_SAMPLE).await.unwrap_or_default();
            let count = self
                .command(&database, doc! { "count": name.clone() })
                .await
                .ok()
                .and_then(|answer| {
                    answer
                        .get_i64("n")
                        .ok()
                        .or_else(|| answer.get_i32("n").ok().map(i64::from))
                });
            tables.push(DbDiagramTable {
                schema: None,
                name,
                kind: DbNodeKind::Collection,
                columns: fields,
                row_estimate: count,
            });
        }

        let edges = infer_references(&tables);
        if !edges.is_empty() {
            notes.push(format!(
                "MongoDB declares no foreign keys. The {} dashed link(s) are guesses from field \
                 names, not constraints.",
                edges.len()
            ));
        }
        notes.push(format!(
            "Fields come from a sample of {DIAGRAM_SAMPLE} documents per collection, so a field no \
             sampled document held is not drawn."
        ));

        Ok(DbSchemaDiagram {
            database: Some(database),
            schema: None,
            tables,
            edges,
            notes,
        })
    }

    /// The distinct top-level field names in a sample of one collection, as diagram columns.
    ///
    /// The same walk [`Self::fields`] does for the tree, kept separate because the two want
    /// different things out of it: the tree wants "in 7/20 sampled" spelled out per node, and this
    /// wants a compact list it can draw fifty of.
    async fn sampled_fields(
        &self,
        node: &DbNodeRef,
        limit: i64,
    ) -> Result<Vec<DbDiagramColumn>, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let collection = node.name()?;
        let (documents, _) = self
            .cursor_command(
                &database,
                doc! { "find": collection, "limit": limit, "batchSize": limit },
                Some(limit as usize),
            )
            .await?;

        let sampled = documents.len();
        let mut fields: Vec<(String, Vec<String>, usize)> = Vec::new();
        for document in &documents {
            for (key, value) in document {
                let type_name = bson_type_name(value).to_string();
                match fields.iter_mut().find(|(name, _, _)| name == key) {
                    Some((_, types, seen)) => {
                        *seen += 1;
                        if !types.contains(&type_name) {
                            types.push(type_name);
                        }
                    }
                    None => fields.push((key.clone(), vec![type_name], 1)),
                }
            }
        }

        Ok(fields
            .into_iter()
            .map(|(name, types, seen)| DbDiagramColumn {
                primary_key: name == "_id",
                name,
                data_type: types.join(" | "),
                // "Absent from some documents" is the nearest thing a schemaless store has to a
                // nullable column, and it is the more useful of the two facts at this zoom.
                nullable: seen < sampled,
                foreign_key: false,
            })
            .collect())
    }

    async fn indexes(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let collection = node.name()?;
        let (documents, _) = self
            .cursor_command(&database, doc! { "listIndexes": collection }, None)
            .await?;
        Ok(documents
            .iter()
            .map(|entry| {
                let name = entry.get_str("name").unwrap_or_default().to_string();
                let keys = entry
                    .get_document("key")
                    .map(|key| bson_to_json_text(&Bson::Document(key.clone()), false))
                    .unwrap_or_default();
                let unique = entry.get_bool("unique").unwrap_or(false);
                DbNode {
                    id: format!("idx:{database}:{collection}:{name}"),
                    kind: DbNodeKind::Index,
                    name,
                    detail: if unique { format!("unique {keys}") } else { keys },
                    database: Some(database.clone()),
                    schema: None,
                    table: Some(collection.to_string()),
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
        let database = request.node.db().unwrap_or(&self.database).to_string();
        let collection = request.node.name()?;
        let filter = if request.filter.trim().is_empty() {
            Document::new()
        } else {
            parse_relaxed_document(&request.filter)?
        };
        let options = &request.options;

        // What the user's own `skip` and `limit` do to paging. `skip` moves the whole window, so it
        // is added to the page's offset; `limit` is a ceiling on the *whole* query, so the page can
        // only ask for what is left of it — and a page past the ceiling asks for nothing rather
        // than for the server's default batch.
        let skip = number_option(&options.skip, "Skip")?.unwrap_or(0);
        let ceiling = number_option(&options.limit, "Limit")?;
        let offset = request.offset as i64;
        let page = match ceiling {
            Some(total) if total > 0 => (total - offset).clamp(0, request.limit as i64),
            _ => request.limit as i64,
        };
        // Past the ceiling there is nothing to ask for — and asking anyway would be worse than a
        // wasted round trip: `find` reads a `limit` of 0 as *no limit*, so the page beyond a limit
        // of 40 would come back as the whole collection.
        if page == 0 {
            let mut result = DbStatementResult::empty(&format!("db.{collection}.find(…)"));
            fill_from_documents(&mut result, Vec::new());
            return Ok(result);
        }

        let mut command = doc! {
            "find": collection,
            "filter": filter,
            "skip": skip + offset,
            "limit": page,
            "batchSize": page,
        };
        // A sort document keeps its key order in BSON, so the keys the grid collected sort in the
        // order it collected them — the same meaning the SQL engines give an `ORDER BY` list. A
        // sort typed into the options wins: it is the more specific instruction, and it can say
        // things a column header cannot (`{"address.city": 1}`).
        let mut sort = doc! {};
        for key in request.sort.iter().filter(|key| !key.column.is_empty()) {
            sort.insert(key.column.clone(), if key.descending { -1 } else { 1 });
        }
        if !options.sort.trim().is_empty() {
            sort = parse_relaxed_document(&options.sort)?;
        }
        if !sort.is_empty() {
            command.insert("sort", sort);
        }
        if !options.projection.trim().is_empty() {
            command.insert("projection", parse_relaxed_document(&options.projection)?);
        }
        apply_shared_options(&mut command, options)?;

        let (documents, truncated) = self
            .cursor_command(&database, command, Some(page as usize))
            .await?;
        let mut result = DbStatementResult::empty(&format!("db.{collection}.find(…)"));
        result.truncated = truncated;
        fill_from_documents(&mut result, documents);
        Ok(result)
    }

    pub async fn row_count(
        &self,
        node: &DbNodeRef,
        filter: &str,
        options: &DbQueryOptions,
    ) -> Result<i64, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let collection = node.name()?;
        let query = if filter.trim().is_empty() {
            Document::new()
        } else {
            parse_relaxed_document(filter)?
        };
        let mut command = doc! { "count": collection, "query": query };
        // `count` takes the same skip and limit a `find` does and answers with what the find would
        // have returned — so the pager's total agrees with the pages it can actually turn to.
        if let Some(skip) = number_option(&options.skip, "Skip")? {
            command.insert("skip", skip);
        }
        if let Some(limit) = number_option(&options.limit, "Limit")? {
            command.insert("limit", limit);
        }
        apply_shared_options(&mut command, options)?;
        let answer = self.command(&database, command).await?;
        Ok(answer
            .get_i64("n")
            .or_else(|_| answer.get_i32("n").map(i64::from))
            .or_else(|_| answer.get_f64("n").map(|v| v as i64))
            .unwrap_or_default())
    }

    /// Applies the grid's pending edits, one command each.
    ///
    /// Not a transaction: Mongo only has them on a replica set, and a standalone server rejects the
    /// attempt outright. So the report is honest instead — `applied` counts the commands that went
    /// through, and the first failure stops the rest.
    pub async fn apply_edits(
        &self,
        node: &DbNodeRef,
        edits: &[DbRowEdit],
    ) -> Result<DbEditResult, String> {
        if self.read_only {
            return Err(read_only_refusal());
        }
        let database = node.db().unwrap_or(&self.database).to_string();
        let collection = node.name()?.to_string();

        let mut statements = Vec::with_capacity(edits.len());
        let mut commands = Vec::with_capacity(edits.len());
        for edit in edits {
            let command = edit_command(&collection, edit)?;
            statements.push(bson_to_json_text(&Bson::Document(command.clone()), true));
            commands.push(command);
        }

        let mut applied = 0u32;
        for (index, command) in commands.into_iter().enumerate() {
            match self.command(&database, command).await {
                Ok(answer) => {
                    // A command can succeed and still not write — `writeErrors` is where a
                    // duplicate key or a failed validator shows up.
                    if let Ok(errors) = answer.get_array("writeErrors") {
                        if !errors.is_empty() {
                            let error = format!(
                                "{}\n\n{}",
                                bson_to_json_text(&Bson::Array(errors.clone()), true),
                                statements.get(index).cloned().unwrap_or_default()
                            );
                            return Ok(DbEditResult { applied, statements, error: Some(error) });
                        }
                    }
                    applied += 1;
                }
                Err(error) => {
                    return Ok(DbEditResult {
                        applied,
                        statements: statements.clone(),
                        error: Some(format!(
                            "{error}\n\n{}",
                            statements.get(index).cloned().unwrap_or_default()
                        )),
                    });
                }
            }
        }
        Ok(DbEditResult { applied, statements, error: None })
    }

    /// A collection has no DDL, so this is the nearest true thing: its options and its indexes, as
    /// the server reports them.
    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let collection = node.name()?;
        let mut out = String::new();

        let (info, _) = self
            .cursor_command(
                &database,
                doc! { "listCollections": 1, "filter": { "name": collection } },
                None,
            )
            .await?;
        if let Some(entry) = info.first() {
            out.push_str("// Collection\n");
            out.push_str(&bson_to_json_text(&Bson::Document(entry.clone()), true));
            out.push('\n');
        }
        let (indexes, _) = self
            .cursor_command(&database, doc! { "listIndexes": collection }, None)
            .await?;
        if !indexes.is_empty() {
            out.push_str("\n// Indexes\n");
            for index in indexes {
                out.push_str(&bson_to_json_text(&Bson::Document(index), true));
                out.push('\n');
            }
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// Turns documents into a grid *and* keeps the originals.
///
/// The grid's columns are the union of top-level keys in first-seen order — which puts `_id` first
/// for a normal collection without special-casing it. Nested values render as compact JSON in the
/// cell; the untouched document is carried in `documents` so the console can show it properly.
fn fill_from_documents(result: &mut DbStatementResult, documents: Vec<Document>) {
    let mut columns: Vec<String> = Vec::new();
    for document in &documents {
        for (key, _) in document {
            if !columns.iter().any(|existing| existing == key) {
                columns.push(key.clone());
            }
        }
    }
    result.columns = columns
        .iter()
        .map(|name| {
            let type_name = documents
                .iter()
                .find_map(|document| document.get(name))
                .map(bson_type_name)
                .unwrap_or("");
            DbColumn::new(name, type_name)
        })
        .collect();
    result.rows = documents
        .iter()
        .map(|document| {
            columns
                .iter()
                .map(|name| match document.get(name) {
                    None | Some(Bson::Null) => None,
                    Some(value) => Some(render_cell(value)),
                })
                .collect()
        })
        .collect();
    result.documents = documents
        .iter()
        .map(|document| bson_to_json_text(&Bson::Document(document.clone()), true))
        .collect();
}

/// One cell's text. Scalars render bare so the grid reads like a table; documents and arrays render
/// as compact JSON, because the alternative — "[Object]" — is the thing that makes a Mongo grid
/// useless.
fn render_cell(value: &Bson) -> String {
    match value {
        Bson::String(s) => s.clone(),
        Bson::Int32(v) => v.to_string(),
        Bson::Int64(v) => v.to_string(),
        Bson::Double(v) => v.to_string(),
        Bson::Boolean(v) => v.to_string(),
        Bson::ObjectId(id) => id.to_hex(),
        Bson::Decimal128(v) => v.to_string(),
        Bson::DateTime(dt) => dt.try_to_rfc3339_string().unwrap_or_else(|_| dt.to_string()),
        Bson::Undefined => "undefined".to_string(),
        other => bson_to_json_text(other, false),
    }
}

fn bson_type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// The options that mean the same thing to `find` and to `count`: which index, how strings compare,
/// and how long the server may spend.
///
/// Shared so the pager's total is counted under exactly the rules the page was read under — a
/// collation the count ignored would make it disagree with the documents on screen for every
/// accent-insensitive filter.
fn apply_shared_options(command: &mut Document, options: &DbQueryOptions) -> Result<(), String> {
    if !options.collation.trim().is_empty() {
        command.insert("collation", parse_relaxed_document(&options.collation)?);
    }
    if !options.hint.trim().is_empty() {
        // Either a key pattern or an index's name — the two forms the server itself accepts, and
        // both of what a user has in hand: `{email: 1}` from the index list, `"email_1"` from a
        // colleague's message.
        let hint = options.hint.trim();
        if hint.starts_with('{') {
            command.insert("hint", parse_relaxed_document(hint)?);
        } else {
            command.insert("hint", unquote(hint));
        }
    }
    if let Some(max_time) = number_option(&options.max_time_ms, "Max time MS")? {
        command.insert("maxTimeMS", max_time);
    }
    Ok(())
}

/// A number typed into an option box, or `None` for a box left empty.
///
/// Empty and zero are kept apart on purpose: `limit: 0` is Mongo's own spelling of "no limit", so a
/// blank box that parsed as zero would silently mean something the user did not write.
fn number_option(value: &str, label: &str) -> Result<Option<i64>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    trimmed
        .parse::<i64>()
        .map(Some)
        .map_err(|_| format!("{label} has to be a whole number — `{trimmed}` isn't one."))
}

/// The number of documents a write touched, from whichever field the command reports it in.
fn write_count(answer: &Document) -> Option<i64> {
    for field in ["nModified", "n"] {
        if let Ok(value) = answer.get_i32(field) {
            return Some(value as i64);
        }
        if let Ok(value) = answer.get_i64(field) {
            return Some(value);
        }
    }
    None
}

fn summarize(document: &Document) -> String {
    let text = bson_to_json_text(&Bson::Document(document.clone()), false);
    if text.chars().count() > 200 {
        format!("{}…", text.chars().take(200).collect::<String>())
    } else {
        text
    }
}

fn human_bytes(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

// ---------------------------------------------------------------------------
// JSON rendering
// ---------------------------------------------------------------------------

/// BSON as JSON *text*, in document order.
///
/// Hand-written rather than `into_relaxed_extjson()` because that returns a `serde_json::Value`,
/// whose object map sorts its keys — which would reorder `_id` to wherever the alphabet puts it and
/// silently break any command document round-tripped through it.
pub fn bson_to_json_text(value: &Bson, pretty: bool) -> String {
    let mut out = String::new();
    write_json(value, pretty, 0, &mut out);
    out
}

fn write_json(value: &Bson, pretty: bool, depth: usize, out: &mut String) {
    let (open_gap, indent, closing_indent) = if pretty {
        ("\n", "  ".repeat(depth + 1), "  ".repeat(depth))
    } else {
        ("", String::new(), String::new())
    };
    match value {
        Bson::Document(document) => {
            if document.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, entry)) in document.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                    if !pretty {
                        out.push(' ');
                    }
                }
                out.push_str(open_gap);
                out.push_str(&indent);
                out.push_str(&json_string(key));
                out.push_str(": ");
                write_json(entry, pretty, depth + 1, out);
            }
            out.push_str(open_gap);
            out.push_str(&closing_indent);
            out.push('}');
        }
        Bson::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, entry) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                    if !pretty {
                        out.push(' ');
                    }
                }
                out.push_str(open_gap);
                out.push_str(&indent);
                write_json(entry, pretty, depth + 1, out);
            }
            out.push_str(open_gap);
            out.push_str(&closing_indent);
            out.push(']');
        }
        Bson::String(s) => out.push_str(&json_string(s)),
        Bson::Boolean(v) => out.push_str(if *v { "true" } else { "false" }),
        Bson::Null => out.push_str("null"),
        Bson::Int32(v) => out.push_str(&v.to_string()),
        Bson::Int64(v) => out.push_str(&v.to_string()),
        Bson::Double(v) => {
            // JSON has no infinity or NaN; extended JSON spells them as strings.
            if v.is_finite() {
                out.push_str(&v.to_string());
            } else {
                out.push_str(&json_string(&v.to_string()));
            }
        }
        // The shell forms, so a value copied out of the grid can be pasted back into a query.
        Bson::ObjectId(id) => out.push_str(&format!("ObjectId(\"{}\")", id.to_hex())),
        Bson::DateTime(dt) => out.push_str(&format!(
            "ISODate(\"{}\")",
            dt.try_to_rfc3339_string().unwrap_or_else(|_| dt.to_string())
        )),
        Bson::Decimal128(v) => out.push_str(&format!("NumberDecimal(\"{v}\")")),
        Bson::Binary(binary) => out.push_str(&format!(
            "{{\"$binary\": {{\"base64\": {}, \"subType\": \"{:02x}\"}}}}",
            json_string(&base64_encode(&binary.bytes)),
            u8::from(binary.subtype)
        )),
        Bson::RegularExpression(regex) => out.push_str(&format!(
            "{{\"$regularExpression\": {{\"pattern\": {}, \"options\": {}}}}}",
            json_string(&regex.pattern),
            json_string(&regex.options)
        )),
        Bson::Timestamp(ts) => out.push_str(&format!(
            "{{\"$timestamp\": {{\"t\": {}, \"i\": {}}}}}",
            ts.time, ts.increment
        )),
        other => out.push_str(&json_string(&other.to_string())),
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

struct Plan {
    command: Document,
    /// The answer is a cursor, so it needs the `getMore` loop.
    cursor: bool,
    /// The command modifies data — checked against the connection's read-only flag.
    writes: bool,
}

/// Splits a console buffer into expressions.
///
/// On `;` where one is written, and otherwise on a blank line: a Mongo console has no statement
/// terminator, so two commands in a scratch buffer are separated by exactly the blank line people
/// already put between them.
fn split_mongo_statements(input: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for block in input.split("\n\n") {
        for statement in super::split_statements(block, None) {
            if !statement.trim().is_empty() {
                out.push(statement.trim().to_string());
            }
        }
    }
    out
}

/// A shell expression, translated into the command document it means.
fn plan_command(statement: &str, limit: Option<usize>) -> Result<Plan, String> {
    let trimmed = statement.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("There is no command here.".to_string());
    }

    // A bare document is a `runCommand` — the escape hatch for anything the shell subset below
    // doesn't cover, which is why it exists at all.
    if trimmed.starts_with('{') {
        let command = parse_relaxed_document(trimmed)?;
        let name = command.keys().next().cloned().unwrap_or_default();
        return Ok(Plan {
            cursor: command.contains_key("cursor")
                || matches!(name.as_str(), "find" | "aggregate" | "listCollections" | "listIndexes"),
            writes: is_write_command(&name),
            command,
        });
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower == "show dbs" || lower == "show databases" {
        return Ok(Plan { command: doc! { "listDatabases": 1 }, cursor: false, writes: false });
    }
    if lower == "show collections" || lower == "show tables" {
        return Ok(Plan { command: doc! { "listCollections": 1 }, cursor: true, writes: false });
    }

    let chain = parse_chain(trimmed)?;
    let (operation, arguments) = chain
        .calls
        .first()
        .ok_or_else(|| shell_help(trimmed))?
        .clone();
    let modifiers = &chain.calls[1..];
    let collection = chain.collection.clone();

    // `db.runCommand({…})` and `db.getCollectionNames()` act on the database, not a collection.
    if collection.is_empty() {
        return match operation.as_str() {
            "runCommand" => {
                let command = parse_relaxed_document(first_argument(&arguments)?)?;
                let name = command.keys().next().cloned().unwrap_or_default();
                Ok(Plan {
                    cursor: command.contains_key("cursor")
                        || matches!(name.as_str(), "find" | "aggregate" | "listIndexes"),
                    writes: is_write_command(&name),
                    command,
                })
            }
            "getCollectionNames" | "getCollectionInfos" => Ok(Plan {
                command: doc! { "listCollections": 1 },
                cursor: true,
                writes: false,
            }),
            "stats" => Ok(Plan { command: doc! { "dbStats": 1 }, cursor: false, writes: false }),
            _ => Err(shell_help(trimmed)),
        };
    }

    let arguments = split_arguments(&arguments);
    let argument = |index: usize| -> Result<Document, String> {
        match arguments.get(index) {
            Some(text) if !text.trim().is_empty() => parse_relaxed_document(text),
            _ => Ok(Document::new()),
        }
    };

    match operation.as_str() {
        "find" | "findOne" => {
            let mut command = doc! { "find": &collection, "filter": argument(0)? };
            if let Ok(projection) = argument(1) {
                if !projection.is_empty() {
                    command.insert("projection", projection);
                }
            }
            let mut page = if operation == "findOne" { Some(1i64) } else { limit.map(|l| l as i64) };
            for (name, value) in modifiers {
                match name.as_str() {
                    "sort" => {
                        command.insert("sort", parse_relaxed_document(value)?);
                    }
                    "limit" => page = Some(parse_number(value)?),
                    "skip" => {
                        command.insert("skip", parse_number(value)?);
                    }
                    "projection" => {
                        command.insert("projection", parse_relaxed_document(value)?);
                    }
                    "count" => {
                        return Ok(Plan {
                            command: doc! { "count": &collection, "query": argument(0)? },
                            cursor: false,
                            writes: false,
                        })
                    }
                    other => return Err(format!("`.{other}()` isn't supported after `find()`.")),
                }
            }
            if let Some(page) = page {
                command.insert("limit", page);
                command.insert("batchSize", page);
            }
            Ok(Plan { command, cursor: true, writes: false })
        }
        "aggregate" => {
            let pipeline = parse_relaxed_array(first_argument(&arguments.join(","))?)?;
            Ok(Plan {
                command: doc! {
                    "aggregate": &collection,
                    "pipeline": pipeline,
                    "cursor": { "batchSize": limit.unwrap_or(1000) as i64 },
                },
                cursor: true,
                writes: false,
            })
        }
        "countDocuments" | "count" => Ok(Plan {
            command: doc! { "count": &collection, "query": argument(0)? },
            cursor: false,
            writes: false,
        }),
        "estimatedDocumentCount" => Ok(Plan {
            command: doc! { "count": &collection },
            cursor: false,
            writes: false,
        }),
        "distinct" => {
            let key = unquote(arguments.first().map(String::as_str).unwrap_or_default());
            Ok(Plan {
                command: doc! { "distinct": &collection, "key": key, "query": argument(1)? },
                cursor: false,
                writes: false,
            })
        }
        "insertOne" => Ok(Plan {
            command: doc! { "insert": &collection, "documents": [argument(0)?] },
            cursor: false,
            writes: true,
        }),
        "insertMany" => {
            let documents = parse_relaxed_array(arguments.first().map(String::as_str).unwrap_or("[]"))?;
            Ok(Plan {
                command: doc! { "insert": &collection, "documents": documents },
                cursor: false,
                writes: true,
            })
        }
        "updateOne" | "updateMany" | "replaceOne" => Ok(Plan {
            command: doc! {
                "update": &collection,
                "updates": [doc! {
                    "q": argument(0)?,
                    "u": argument(1)?,
                    "multi": operation == "updateMany",
                    "upsert": argument(2)?.get_bool("upsert").unwrap_or(false),
                }],
            },
            cursor: false,
            writes: true,
        }),
        "deleteOne" | "deleteMany" | "remove" => Ok(Plan {
            command: doc! {
                "delete": &collection,
                "deletes": [doc! {
                    "q": argument(0)?,
                    "limit": if operation == "deleteMany" { 0 } else { 1 },
                }],
            },
            cursor: false,
            writes: true,
        }),
        "drop" => Ok(Plan { command: doc! { "drop": &collection }, cursor: false, writes: true }),
        "getIndexes" | "listIndexes" => Ok(Plan {
            command: doc! { "listIndexes": &collection },
            cursor: true,
            writes: false,
        }),
        "createIndex" => Ok(Plan {
            command: doc! {
                "createIndexes": &collection,
                "indexes": [doc! { "key": argument(0)?, "name": index_name(&argument(0)?) }],
            },
            cursor: false,
            writes: true,
        }),
        "stats" => Ok(Plan {
            command: doc! { "collStats": &collection },
            cursor: false,
            writes: false,
        }),
        other => Err(format!(
            "`.{other}()` isn't one of the operations this console understands. You can always run \
             the command directly — paste the command document, e.g. `{{\"{other}\": \
             \"{collection}\"}}`."
        )),
    }
}

fn shell_help(statement: &str) -> String {
    format!(
        "`{statement}` isn't something this console recognizes. Write `db.<collection>.<op>(…)`, or \
         paste a command document like `{{find: \"users\", filter: {{}}}}` to run it directly."
    )
}

fn is_write_command(name: &str) -> bool {
    matches!(
        name,
        "insert"
            | "update"
            | "delete"
            | "findAndModify"
            | "drop"
            | "dropDatabase"
            | "create"
            | "createIndexes"
            | "dropIndexes"
            | "renameCollection"
            | "bulkWrite"
    )
}

fn index_name(keys: &Document) -> String {
    keys.iter()
        .map(|(key, value)| format!("{key}_{}", render_cell(value)))
        .collect::<Vec<_>>()
        .join("_")
}

struct Chain {
    /// Empty when the expression acts on the database (`db.runCommand(…)`).
    collection: String,
    /// `(method, raw argument text)` in call order. The first is the operation; the rest are
    /// modifiers like `.sort()` / `.limit()`.
    calls: Vec<(String, String)>,
}

/// Walks `db.users.find({…}).sort({…}).limit(10)` into its parts.
///
/// A hand-written scan rather than a regex: the arguments contain braces, brackets, quotes and
/// nested parentheses, and matching those with a regex is the kind of thing that works on the
/// examples and fails on the query someone actually has.
fn parse_chain(input: &str) -> Result<Chain, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let mut segments: Vec<String> = Vec::new();
    let mut calls: Vec<(String, String)> = Vec::new();

    // Every expression starts at `db`.
    let head = read_identifier(&chars, &mut i);
    if head != "db" {
        return Err(shell_help(input));
    }

    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        if chars[i] != '.' {
            return Err(shell_help(input));
        }
        i += 1;
        let name = read_identifier(&chars, &mut i);
        if name.is_empty() {
            return Err(shell_help(input));
        }
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if chars.get(i) == Some(&'(') {
            let arguments = read_group(&chars, &mut i)?;
            // `db.getCollection('name')` names a collection whose name isn't an identifier.
            if name == "getCollection" && calls.is_empty() && segments.is_empty() {
                segments.push(unquote(arguments.trim()));
            } else {
                calls.push((name, arguments));
            }
        } else {
            segments.push(name);
        }
    }

    Ok(Chain { collection: segments.join("."), calls })
}

fn read_identifier(chars: &[char], i: &mut usize) -> String {
    let mut out = String::new();
    while let Some(&c) = chars.get(*i) {
        if c.is_alphanumeric() || c == '_' || c == '$' || c == '-' {
            out.push(c);
            *i += 1;
        } else {
            break;
        }
    }
    out
}

/// Reads a balanced `( … )` starting at `chars[*i]`, returning what is inside it.
fn read_group(chars: &[char], i: &mut usize) -> Result<String, String> {
    let mut depth = 0usize;
    let mut out = String::new();
    let mut quote: Option<char> = None;
    while let Some(&c) = chars.get(*i) {
        *i += 1;
        if let Some(active) = quote {
            out.push(c);
            if c == '\\' {
                if let Some(&next) = chars.get(*i) {
                    out.push(next);
                    *i += 1;
                }
            } else if c == active {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                out.push(c);
            }
            '(' => {
                depth += 1;
                if depth > 1 {
                    out.push(c);
                }
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(out);
                }
                out.push(c);
            }
            c => out.push(c),
        }
    }
    Err("This expression has an unclosed `(`.".to_string())
}

/// Splits `{…}, {…}` into its top-level arguments, respecting nesting and quotes.
fn split_arguments(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(active) = quote {
            current.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else if c == active {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                current.push(c);
            }
            '{' | '[' | '(' => {
                depth += 1;
                current.push(c);
            }
            '}' | ']' | ')' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                out.push(current.trim().to_string());
                current.clear();
            }
            c => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

fn first_argument(arguments: &str) -> Result<&str, String> {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        Err("This command needs an argument.".to_string())
    } else {
        Ok(trimmed)
    }
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    let bytes: Vec<char> = trimmed.chars().collect();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == '\'' || first == '"') && first == last {
            return bytes[1..bytes.len() - 1].iter().collect();
        }
    }
    trimmed.to_string()
}

fn parse_number(value: &str) -> Result<i64, String> {
    value
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("`{value}` isn't a number."))
}

/// Shell-flavoured JSON → a BSON document, key order intact.
pub fn parse_relaxed_document(source: &str) -> Result<Document, String> {
    match parse_relaxed_bson(source)? {
        Bson::Document(document) => Ok(document),
        other => Err(format!(
            "Expected a document like `{{…}}`, got {}.",
            bson_type_name(&other)
        )),
    }
}

fn parse_relaxed_array(source: &str) -> Result<Vec<Document>, String> {
    match parse_relaxed_bson(source)? {
        Bson::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Bson::Document(document) => Ok(document),
                other => Err(format!(
                    "A pipeline or document list can only hold documents, found {}.",
                    bson_type_name(&other)
                )),
            })
            .collect(),
        Bson::Document(document) => Ok(vec![document]),
        other => Err(format!("Expected `[…]`, got {}.", bson_type_name(&other))),
    }
}

/// The two-step parse: [`relax_to_json`] makes the text strict JSON, serde builds a `Document`
/// (which preserves key order, unlike a `serde_json::Value`), and [`to_extended`] promotes the
/// `$oid`/`$date` markers left behind into real BSON types.
pub fn parse_relaxed_bson(source: &str) -> Result<Bson, String> {
    let strict = relax_to_json(source);
    let mut deserializer = serde_json::Deserializer::from_str(&strict);
    let value = Bson::deserialize(&mut deserializer).map_err(|e| {
        format!("That isn't valid JSON: {e}. What was parsed was:\n{strict}")
    })?;
    Ok(to_extended(value))
}

/// Rewrites the Mongo shell's JSON into strict JSON.
///
/// Handles what people actually paste: unquoted keys, single-quoted strings, trailing commas, and
/// the `ObjectId(…)` / `ISODate(…)` / `Number*(…)` constructors — turned into their extended-JSON
/// markers, which [`to_extended`] then converts. Left unsupported on purpose: regex *literals*
/// (`/^a/i`), because distinguishing one from a division in a text scan is guesswork — `{$regex:
/// "^a", $options: "i"}` says the same thing unambiguously.
fn relax_to_json(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    // Which container we are in, and whether the next token is a key.
    let mut stack: Vec<char> = Vec::new();
    let mut expect_key = false;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        match c {
            '{' => {
                stack.push('{');
                expect_key = true;
                out.push(c);
                i += 1;
            }
            '[' => {
                stack.push('[');
                expect_key = false;
                out.push(c);
                i += 1;
            }
            '}' | ']' => {
                // A trailing comma before the closer is legal in the shell and not in JSON.
                trim_trailing_comma(&mut out);
                stack.pop();
                expect_key = false;
                out.push(c);
                i += 1;
            }
            ',' => {
                expect_key = stack.last() == Some(&'{');
                out.push(c);
                i += 1;
            }
            ':' => {
                expect_key = false;
                out.push(c);
                i += 1;
            }
            '\'' | '"' => {
                let (text, next) = read_quoted(&chars, i);
                out.push_str(&json_string(&text));
                i = next;
            }
            c if c.is_whitespace() => {
                out.push(c);
                i += 1;
            }
            c if c.is_alphanumeric() || c == '_' || c == '$' || c == '-' || c == '+' || c == '.' => {
                let start = i;
                let word = read_word(&chars, &mut i);
                if expect_key {
                    out.push_str(&json_string(&word));
                    continue;
                }
                // A number, `true`, `false` and `null` pass straight through.
                if word.parse::<f64>().is_ok() || matches!(word.as_str(), "true" | "false" | "null")
                {
                    out.push_str(&word);
                    continue;
                }
                match constructor(&word, &chars, &mut i) {
                    Some(replacement) => out.push_str(&replacement),
                    None => {
                        // Not something we understand — emit it verbatim so the JSON parser
                        // reports it with its position, rather than silently turning it into a
                        // string that would quietly change the query's meaning.
                        i = start;
                        out.push(chars[i]);
                        i += 1;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn trim_trailing_comma(out: &mut String) {
    let trimmed = out.trim_end();
    if trimmed.ends_with(',') {
        let keep = trimmed.len() - 1;
        out.truncate(keep);
    }
}

fn read_word(chars: &[char], i: &mut usize) -> String {
    let mut out = String::new();
    while let Some(&c) = chars.get(*i) {
        if c.is_alphanumeric() || c == '_' || c == '$' || c == '-' || c == '+' || c == '.' {
            out.push(c);
            *i += 1;
        } else {
            break;
        }
    }
    out
}

fn read_quoted(chars: &[char], start: usize) -> (String, usize) {
    let quote = chars[start];
    let mut out = String::new();
    let mut i = start + 1;
    while let Some(&c) = chars.get(i) {
        i += 1;
        if c == '\\' {
            if let Some(&escaped) = chars.get(i) {
                i += 1;
                out.push(match escaped {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    other => other,
                });
            }
            continue;
        }
        if c == quote {
            break;
        }
        out.push(c);
    }
    (out, i)
}

/// `ObjectId("…")` and friends → the extended-JSON marker for the same value.
fn constructor(word: &str, chars: &[char], i: &mut usize) -> Option<String> {
    // `new Date(…)` — the `new` is noise.
    if word == "new" {
        let mut probe = *i;
        while chars.get(probe).is_some_and(|c| c.is_whitespace()) {
            probe += 1;
        }
        let mut after = probe;
        let next = read_word(chars, &mut after);
        if next == "Date" || next == "ISODate" || next == "ObjectId" {
            *i = after;
            return constructor(&next, chars, i);
        }
        return None;
    }

    let mut probe = *i;
    while chars.get(probe).is_some_and(|c| c.is_whitespace()) {
        probe += 1;
    }
    if chars.get(probe) != Some(&'(') {
        return None;
    }
    let mut cursor = probe;
    let inner = read_group(chars, &mut cursor).ok()?;
    let argument = unquote(&inner);
    let replacement = match word {
        "ObjectId" => format!("{{\"$oid\": {}}}", json_string(&argument)),
        "ISODate" | "Date" => format!("{{\"$date\": {}}}", json_string(&argument)),
        "NumberLong" => format!("{{\"$numberLong\": {}}}", json_string(&argument)),
        "NumberDecimal" => format!("{{\"$numberDecimal\": {}}}", json_string(&argument)),
        "NumberInt" => argument,
        "UUID" | "BinData" => return None,
        _ => return None,
    };
    *i = cursor;
    Some(replacement)
}

/// Promotes the extended-JSON markers a strict parse leaves as plain sub-documents into the BSON
/// types they stand for. Without this, `{_id: ObjectId("…")}` would query for a *document* equal to
/// `{$oid: "…"}` and match nothing — the failure mode being that it looks like the row isn't there.
fn to_extended(value: Bson) -> Bson {
    match value {
        Bson::Array(items) => Bson::Array(items.into_iter().map(to_extended).collect()),
        Bson::Document(document) => {
            if document.len() == 1 {
                if let Some((key, entry)) = document.iter().next() {
                    if let Some(promoted) = promote(key, entry) {
                        return promoted;
                    }
                }
            }
            let mut out = Document::new();
            for (key, entry) in document {
                out.insert(key, to_extended(entry));
            }
            Bson::Document(out)
        }
        other => other,
    }
}

fn promote(key: &str, value: &Bson) -> Option<Bson> {
    let text = value.as_str();
    match key {
        "$oid" => mongodb::bson::oid::ObjectId::parse_str(text?).ok().map(Bson::ObjectId),
        "$date" => {
            let text = text?;
            mongodb::bson::DateTime::parse_rfc3339_str(text).ok().map(Bson::DateTime)
        }
        "$numberLong" => text?.parse::<i64>().ok().map(Bson::Int64),
        "$numberDecimal" => text?
            .parse::<mongodb::bson::Decimal128>()
            .ok()
            .map(Bson::Decimal128),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Data editor
// ---------------------------------------------------------------------------

/// One grid edit → the command that applies it.
///
/// Cell values arrive as text. Each is parsed as shell JSON first (so a nested document edited in
/// the grid stays a document, and `ObjectId("…")` stays an id) and falls back to a plain string —
/// which is the right default, because a field holding `"42"` as a string must not silently become
/// the number 42 on the next save.
fn edit_command(collection: &str, edit: &DbRowEdit) -> Result<Document, String> {
    let identity = |cells: &[super::DbCell]| -> Result<Document, String> {
        if cells.is_empty() {
            return Err(
                "This document can't be identified — it has no `_id` in the result. Edit it with a \
                 command in the console instead."
                    .to_string(),
            );
        }
        let mut filter = Document::new();
        for cell in cells {
            filter.insert(
                cell.column.clone(),
                cell_to_bson(cell.value.as_deref(), &cell.type_name),
            );
        }
        Ok(filter)
    };

    // A whole document was edited as a document — see `DbRowEdit::document`. It replaces the cell
    // list entirely rather than being merged with it: the two describe the same write, and a
    // `$set` layered on top of a replacement would apply changes the user already made by hand.
    if let Some(text) = edit.document.as_deref() {
        let document = parse_relaxed_document(text)?;
        return match edit.kind {
            DbRowEditKind::Insert => Ok(doc! { "insert": collection, "documents": [document] }),
            DbRowEditKind::Update => {
                // A replacement, not an update: no `$set`, so a field the user deleted in the
                // editor is deleted in the collection. That is what editing a document *as* a
                // document means, and it is why the panel shows the command before running it.
                if document.keys().any(|key| key.starts_with('$')) {
                    return Err(
                        "A replacement document can't start its fields with `$` — that would be \
                         read as update operators. Use the console for an operator update."
                            .to_string(),
                    );
                }
                Ok(doc! {
                    "update": collection,
                    "updates": [doc! { "q": identity(&edit.keys)?, "u": document, "multi": false }],
                })
            }
            // Nothing to send: a delete is identified by its keys, and the document text would only
            // be the same information twice.
            DbRowEditKind::Delete => Ok(doc! {
                "delete": collection,
                "deletes": [doc! { "q": identity(&edit.keys)?, "limit": 1 }],
            }),
        };
    }

    match edit.kind {
        DbRowEditKind::Insert => {
            let mut document = Document::new();
            for cell in &edit.values {
                document.insert(
                    cell.column.clone(),
                    cell_to_bson(cell.value.as_deref(), &cell.type_name),
                );
            }
            Ok(doc! { "insert": collection, "documents": [document] })
        }
        DbRowEditKind::Update => {
            let mut set = Document::new();
            let mut unset = Document::new();
            for cell in &edit.values {
                match cell.value.as_deref() {
                    // Clearing a cell removes the field rather than storing null: that is what
                    // "empty" means in a document database, and `$unset` is how you say it.
                    None => unset.insert(cell.column.clone(), ""),
                    Some(text) => set.insert(
                        cell.column.clone(),
                        cell_to_bson(Some(text), &cell.type_name),
                    ),
                };
            }
            let mut update = Document::new();
            if !set.is_empty() {
                update.insert("$set", set);
            }
            if !unset.is_empty() {
                update.insert("$unset", unset);
            }
            if update.is_empty() {
                return Err("There is nothing to update — no field was changed.".to_string());
            }
            Ok(doc! {
                "update": collection,
                "updates": [doc! { "q": identity(&edit.keys)?, "u": update, "multi": false }],
            })
        }
        DbRowEditKind::Delete => Ok(doc! {
            "delete": collection,
            "deletes": [doc! { "q": identity(&edit.keys)?, "limit": 1 }],
        }),
    }
}

fn cell_to_bson(value: Option<&str>, type_name: &str) -> Bson {
    let Some(text) = value else { return Bson::Null };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Bson::String(text.to_string());
    }

    // The type the field held when it was read, from `bson_type_name` via the grid's column. This
    // is what makes a filter on `_id` match: the grid renders an ObjectId as bare hex (readable, and
    // what Compass shows), and without the type there is no way to tell it from a collection whose
    // ids genuinely *are* 24-character strings — guessing either way would silently match nothing.
    match type_name {
        "objectId" => {
            if let Ok(id) = mongodb::bson::oid::ObjectId::parse_str(trimmed) {
                return Bson::ObjectId(id);
            }
        }
        "date" => {
            if let Ok(date) = mongodb::bson::DateTime::parse_rfc3339_str(trimmed) {
                return Bson::DateTime(date);
            }
        }
        "int" => {
            if let Ok(number) = trimmed.parse::<i32>() {
                return Bson::Int32(number);
            }
        }
        "long" => {
            if let Ok(number) = trimmed.parse::<i64>() {
                return Bson::Int64(number);
            }
        }
        "double" => {
            if let Ok(number) = trimmed.parse::<f64>() {
                return Bson::Double(number);
            }
        }
        "bool" => {
            if let Ok(flag) = trimmed.parse::<bool>() {
                return Bson::Boolean(flag);
            }
        }
        // A string field stays a string even when it looks like a number: `{"zip": "01234"}` must
        // not become 1234 on the next save.
        "string" => return Bson::String(text.to_string()),
        _ => {}
    }

    // No usable type — a new row, or a field the sample never saw. Fall back to reading the text as
    // shell JSON when it *looks* structured, and to a string otherwise.
    let structured = trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with("ObjectId(")
        || trimmed.starts_with("ISODate(")
        || trimmed.starts_with("NumberLong(")
        || trimmed.starts_with("NumberDecimal(")
        || matches!(trimmed, "true" | "false" | "null");
    if structured {
        if let Ok(parsed) = parse_relaxed_bson(trimmed) {
            return parsed;
        }
    }
    if let Ok(number) = trimmed.parse::<i64>() {
        if trimmed.len() < 19 {
            return Bson::Int64(number);
        }
    }
    if trimmed.contains('.') || trimmed.contains('e') || trimmed.contains('E') {
        if let Ok(number) = trimmed.parse::<f64>() {
            return Bson::Double(number);
        }
    }
    Bson::String(text.to_string())
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

fn database_node(name: &str, detail: String) -> DbNode {
    DbNode {
        id: format!("db:{name}"),
        kind: DbNodeKind::Database,
        name: name.to_string(),
        detail,
        database: Some(name.to_string()),
        schema: None,
        table: None,
        has_children: true,
        column: None,
    }
}

fn collection_folders(node: &DbNodeRef) -> Vec<DbNode> {
    let database = node.db().map(str::to_string);
    let collection = node.name.clone().unwrap_or_default();
    [(DbNodeKind::ColumnFolder, "Fields"), (DbNodeKind::IndexFolder, "Indexes")]
        .into_iter()
        .map(|(kind, name)| DbNode {
            id: format!("folder:{}:{collection}:{name}", database.clone().unwrap_or_default()),
            kind,
            name: name.to_string(),
            detail: String::new(),
            database: database.clone(),
            schema: None,
            table: Some(collection.clone()),
            has_children: true,
            column: None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Connection plumbing
// ---------------------------------------------------------------------------

fn default_database(config: &DbConnectionConfig) -> String {
    if !config.database.is_empty() {
        return config.database.clone();
    }
    // The database in the URI's path, when there is one — `mongodb://host/shop` means `shop`.
    config
        .url
        .rsplit_once('/')
        .map(|(_, tail)| tail.split('?').next().unwrap_or_default().to_string())
        .filter(|name| !name.is_empty() && !name.contains(':'))
        .unwrap_or_else(|| "admin".to_string())
}

/// Attaches the connection's CA and client certificate to Mongo's TLS options.
///
/// The Mongo driver wants *paths*, not parsed material, and it wants the client certificate and its
/// key in **one** PEM file — which is worth saying out loud, because every other engine here takes
/// them as two and a user who has two files needs to know to concatenate them.
fn with_certificates(
    mut tls: TlsOptions,
    config: &DbConnectionConfig,
) -> Result<TlsOptions, String> {
    let exists = |path: &str, what: &str| -> Result<std::path::PathBuf, String> {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            Ok(path)
        } else {
            Err(format!("There is no {what} at {}.", path.display()))
        }
    };

    let ca = config.ssl_ca_file.trim();
    if !ca.is_empty() {
        tls.ca_file_path = Some(exists(ca, "CA file")?);
    }
    let certificate = config.ssl_cert_file.trim();
    if !certificate.is_empty() {
        tls.cert_key_file_path = Some(exists(certificate, "client certificate")?);
    }
    if !config.ssl_key_file.trim().is_empty() && certificate.is_empty() {
        return Err(
            "MongoDB reads the client certificate and its key from a single PEM file. Put both in \
             one file and name it in the certificate box, leaving the key box empty."
                .to_string(),
        );
    }
    Ok(tls)
}

async fn client_options(config: &DbConnectionConfig) -> Result<ClientOptions, String> {
    let mut options = if config.url.trim().is_empty() {
        let mut options = ClientOptions::default();
        options.hosts = vec![ServerAddress::Tcp {
            host: config.host.clone(),
            port: Some(config.effective_port()),
        }];
        if !config.user.is_empty() {
            let mut credential = Credential::default();
            credential.username = Some(config.user.clone());
            credential.password = Some(config.password.clone());
            // Users are per-database in Mongo; `authSource` says which one holds this one, and it
            // is `admin` far more often than it is the database being queried.
            credential.source = Some(
                config
                    .option("authSource")
                    .unwrap_or("admin")
                    .to_string(),
            );
            options.credential = Some(credential);
        }
        options
    } else {
        // `mongodb+srv://` is the only form Atlas gives out, and it carries the replica set, the
        // TLS requirement and the auth source in one string — parsing beats re-deriving.
        let url = config.url.trim();
        match ClientOptions::parse(url).await {
            Ok(options) => options,
            // The driver's own resolver could not read this machine's DNS configuration — which on
            // macOS is the ordinary case, not an exotic one. Expanding the `+srv` here, with the
            // nameservers that *are* usable, is the difference between Atlas working and not; see
            // `super::srv`. Anything else keeps the driver's message, because anything else is a
            // real failure that a second attempt would only restate.
            Err(error) if super::srv::is_unreadable_resolver_config(&error.to_string()) => {
                let expanded = super::srv::expand(url).await.map_err(|reason| {
                    format!(
                        "That connection URL couldn't be resolved. This machine's DNS list has an \
                         entry the driver can't read, so CodeFlow tried to look the cluster up \
                         itself and that failed too: {reason}"
                    )
                })?;
                ClientOptions::parse(&expanded)
                    .await
                    .map_err(|e| format!("That connection URL couldn't be parsed: {e}"))?
            }
            Err(error) => {
                return Err(format!("That connection URL couldn't be parsed: {error}"))
            }
        }
    };

    // A URL with a user and no password still needs the keychain's, exactly as the Postgres driver
    // does it (`pg_config`). Without this the field was read, stored and then silently dropped:
    // the URL's credential is what `parse` produced, and an empty password in it stayed empty. The
    // guard is deliberate on both halves — a URL that *does* carry a password keeps it, and a URL
    // with no user at all gets nothing, since a password with nobody to authenticate as is not a
    // credential this can complete.
    if !config.password.is_empty() {
        if let Some(credential) = options.credential.as_mut() {
            if credential.password.is_none() && credential.username.is_some() {
                credential.password = Some(config.password.clone());
            }
        }
    }

    match config.ssl {
        DbSslMode::Disable => {}
        DbSslMode::Require => {
            let mut tls = TlsOptions::default();
            tls.allow_invalid_certificates = Some(true);
            options.tls = Some(Tls::Enabled(with_certificates(tls, config)?));
        }
        DbSslMode::VerifyFull => {
            options.tls = Some(Tls::Enabled(with_certificates(TlsOptions::default(), config)?));
        }
    }
    options.app_name = Some(
        config.option("application_name").unwrap_or("CodeFlow").to_string(),
    );
    options.connect_timeout = Some(config.connect_timeout());
    // Bounded so a wrong host fails in seconds rather than hanging on server selection for the
    // driver's 30-second default.
    options.server_selection_timeout = Some(config.connect_timeout());
    Ok(options)
}

fn mongo_error(error: &mongodb::error::Error) -> String {
    match crate::api::root_cause(error) {
        Some(cause) if cause != error.to_string() => format!("{error} ({cause})"),
        _ => error.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Inferred references
// ---------------------------------------------------------------------------

/// Guesses which sampled fields are references to another collection.
///
/// One rule, deliberately: a field whose name ends in `id`/`ids` and whose stem names a collection
/// in the same database — `userId` → `users`, `order_ids` → `orders`. That is the convention every
/// Mongo ODM writes and the only one common enough to be worth drawing.
///
/// What it will not do is match on the *value*: an `ObjectId` field called `owner` could point
/// anywhere, and a line drawn from a hunch is indistinguishable on screen from a line read out of a
/// catalog. Every edge from here is marked `inferred` so the panel can keep the two apart.
///
/// `_id` is skipped — it is the collection's own key, not a pointer at anything.
fn infer_references(tables: &[DbDiagramTable]) -> Vec<DbDiagramEdge> {
    let targets: Vec<(&str, String)> = tables
        .iter()
        .map(|table| (table.name.as_str(), name_key(&table.name)))
        .collect();

    let mut edges = Vec::new();
    for table in tables {
        for column in &table.columns {
            let Some(stem) = reference_stem(&column.name) else {
                continue;
            };
            let forms = plural_forms(&stem);
            let Some((target, _)) = targets
                .iter()
                .find(|(name, key)| forms.iter().any(|form| form == key) && *name != table.name)
            else {
                continue;
            };
            edges.push(DbDiagramEdge {
                constraint: format!("{}.{} (inferred)", table.name, column.name),
                from_schema: None,
                from_table: table.name.clone(),
                from_column: column.name.clone(),
                to_schema: None,
                to_table: (*target).to_string(),
                to_column: "_id".to_string(),
                inferred: true,
            });
        }
    }
    edges
}

/// What a field name is a reference *to*: `userId`, `user_id` and `userIds` all stem to `user`.
/// `None` when the name isn't a reference at all.
fn reference_stem(field: &str) -> Option<String> {
    if field == "_id" {
        return None;
    }
    let key = name_key(field);
    let stem = key.strip_suffix("ids").or_else(|| key.strip_suffix("id"))?;
    (!stem.is_empty()).then(|| stem.to_string())
}

/// A name with the spellings that don't carry meaning removed: case, and the `_`/`-`/space a field
/// uses where a collection name might not.
fn name_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// The collection names a singular stem could plausibly be stored under.
///
/// Generating candidates *forward* rather than stripping plurals off both sides, because
/// de-pluralizing doesn't converge: `address` and `addresses` reduce to `addres` and `address`,
/// which never meet. Adding suffixes to the stem does.
fn plural_forms(stem: &str) -> Vec<String> {
    let mut forms = vec![stem.to_string(), format!("{stem}s"), format!("{stem}es")];
    if let Some(root) = stem.strip_suffix('y') {
        forms.push(format!("{root}ies"));
    }
    forms
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection(name: &str, fields: &[&str]) -> DbDiagramTable {
        DbDiagramTable {
            schema: None,
            name: name.to_string(),
            kind: DbNodeKind::Collection,
            columns: fields
                .iter()
                .map(|field| DbDiagramColumn {
                    name: (*field).to_string(),
                    data_type: "objectId".to_string(),
                    nullable: false,
                    primary_key: *field == "_id",
                    foreign_key: false,
                })
                .collect(),
            row_estimate: None,
        }
    }

    /// The naming conventions an ODM actually writes, including the plurals that don't survive
    /// being stripped from both ends (`address` / `addresses`).
    #[test]
    fn reference_fields_find_their_collection() {
        let tables = vec![
            collection("users", &["_id", "name"]),
            collection("addresses", &["_id"]),
            collection("categories", &["_id"]),
            collection("orders", &["_id", "userId", "address_id", "categoryId", "total"]),
        ];
        let edges = infer_references(&tables);
        let pairs: Vec<(&str, &str)> = edges
            .iter()
            .map(|edge| (edge.from_column.as_str(), edge.to_table.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![("userId", "users"), ("address_id", "addresses"), ("categoryId", "categories")]
        );
        assert!(edges.iter().all(|edge| edge.inferred && edge.to_column == "_id"));
    }

    /// The collection's own key is not a pointer at anything, and a stem naming no collection is
    /// left alone rather than drawn as a link to nowhere.
    #[test]
    fn unmatched_and_own_keys_produce_no_edge() {
        let tables = vec![collection("orders", &["_id", "shippingId", "total"])];
        assert!(infer_references(&tables).is_empty());
    }

    /// The shell dialect people actually paste: unquoted keys, single quotes, `ObjectId(…)`.
    #[test]
    fn shell_json_becomes_real_bson() {
        let document =
            parse_relaxed_document("{_id: ObjectId('507f1f77bcf86cd799439011'), name: 'Ana'}")
                .unwrap();
        assert!(matches!(document.get("_id"), Some(Bson::ObjectId(_))), "{document:?}");
        assert_eq!(document.get_str("name").unwrap(), "Ana");
    }

    /// The whole reason documents don't route through `serde_json::Value`: a command's first key is
    /// its name, and sorting the keys would make `{find: …, filter: …}` an invalid command.
    #[test]
    fn key_order_survives_the_parse() {
        let document = parse_relaxed_document("{find: 'users', filter: {}, limit: 10}").unwrap();
        let keys: Vec<&String> = document.keys().collect();
        assert_eq!(keys, vec!["find", "filter", "limit"]);
    }

    #[test]
    fn trailing_commas_and_nesting_are_tolerated() {
        let document =
            parse_relaxed_document("{ a: { b: [1, 2, 3,], }, c: 'x, y', }").unwrap();
        assert_eq!(document.get_document("a").unwrap().get_array("b").unwrap().len(), 3);
        assert_eq!(document.get_str("c").unwrap(), "x, y");
    }

    #[test]
    fn a_find_chain_becomes_a_find_command() {
        let plan = plan_command("db.users.find({age: {$gt: 21}}).sort({name: 1}).limit(5)", Some(100))
            .unwrap();
        assert!(plan.cursor);
        assert!(!plan.writes);
        assert_eq!(plan.command.get_str("find").unwrap(), "users");
        assert_eq!(plan.command.get_i64("limit").unwrap(), 5);
        assert!(plan.command.get_document("sort").is_ok());
        // The command name has to come first or the server rejects the document.
        assert_eq!(plan.command.keys().next().unwrap(), "find");
    }

    /// A write has to be recognized as one, or the read-only flag would let it through.
    #[test]
    fn writes_are_recognized_through_every_form() {
        for statement in [
            "db.users.insertOne({a: 1})",
            "db.users.updateMany({}, {$set: {a: 1}})",
            "db.users.deleteOne({a: 1})",
            "db.users.drop()",
            "{insert: 'users', documents: [{a: 1}]}",
        ] {
            assert!(plan_command(statement, None).unwrap().writes, "{statement}");
        }
        for statement in ["db.users.find({})", "db.users.countDocuments({})", "show collections"] {
            assert!(!plan_command(statement, None).unwrap().writes, "{statement}");
        }
    }

    #[test]
    fn a_collection_with_a_dot_still_resolves() {
        let plan = plan_command("db.system.profile.find({})", None).unwrap();
        assert_eq!(plan.command.get_str("find").unwrap(), "system.profile");
        let quoted = plan_command("db.getCollection('odd name').find({})", None).unwrap();
        assert_eq!(quoted.command.get_str("find").unwrap(), "odd name");
    }

    /// Clearing a cell has to remove the field, not store a null — those are different documents,
    /// and `$set: {x: null}` is not what "I deleted the value" means.
    #[test]
    fn clearing_a_field_unsets_it() {
        let edit = DbRowEdit {
            kind: DbRowEditKind::Update,
            values: vec![super::super::DbCell {
                column: "nickname".into(),
                value: None,
                type_name: String::new(),
            }],
            keys: vec![super::super::DbCell {
                column: "_id".into(),
                value: Some("507f1f77bcf86cd799439011".into()),
                type_name: "objectId".into(),
            }],
            document: None,
        };
        let command = edit_command("users", &edit).unwrap();
        let update = command.get_array("updates").unwrap()[0].as_document().unwrap();
        assert!(update.get_document("u").unwrap().contains_key("$unset"));
        // The key parsed back into a real ObjectId, or the filter would match nothing.
        assert!(matches!(
            update.get_document("q").unwrap().get("_id"),
            Some(Bson::ObjectId(_))
        ));
    }

    /// A field holding the text "01234" must stay text: silently turning it into a number would
    /// rewrite the document's schema on save, and lose the leading zero doing it.
    #[test]
    fn typed_text_is_never_coerced_into_a_number() {
        assert!(matches!(cell_to_bson(Some("01234"), "string"), Bson::String(_)));
        assert!(matches!(cell_to_bson(Some("42"), "long"), Bson::Int64(42)));
        assert!(matches!(cell_to_bson(Some("42"), "int"), Bson::Int32(42)));
        assert!(matches!(cell_to_bson(Some("hello"), ""), Bson::String(_)));
        assert!(matches!(cell_to_bson(Some("{a: 1}"), ""), Bson::Document(_)));
        assert!(matches!(cell_to_bson(Some("true"), ""), Bson::Boolean(true)));
        assert!(matches!(cell_to_bson(None, "string"), Bson::Null));
    }

    /// The grid shows an ObjectId as bare hex, so without the column's type a filter on `_id` would
    /// be built from a *string* and match nothing — the failure mode being "the row isn't there".
    #[test]
    fn the_column_type_is_what_makes_an_id_filter_match() {
        assert!(matches!(
            cell_to_bson(Some("507f1f77bcf86cd799439011"), "objectId"),
            Bson::ObjectId(_)
        ));
        // The same text in a genuinely string-keyed collection stays a string.
        assert!(matches!(
            cell_to_bson(Some("507f1f77bcf86cd799439011"), "string"),
            Bson::String(_)
        ));
    }

    /// `_id` first is what makes a Mongo grid readable; it falls out of first-seen ordering rather
    /// than a special case, so a projection that drops `_id` still reads naturally.
    #[test]
    fn grid_columns_follow_first_seen_order() {
        let mut result = DbStatementResult::empty("x");
        fill_from_documents(
            &mut result,
            vec![doc! { "_id": 1, "name": "a" }, doc! { "_id": 2, "extra": true }],
        );
        let names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["_id", "name", "extra"]);
        assert_eq!(result.rows[1][1], None, "a missing field is NULL, not empty text");
        assert_eq!(result.documents.len(), 2);
    }
}
