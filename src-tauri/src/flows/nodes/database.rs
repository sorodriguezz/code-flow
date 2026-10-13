//! «Base de datos» (`data.database`): one table of a saved connection, without writing SQL — its
//! tables and columns listed, rows read by conditions and counted, and rows inserted, updated,
//! upserted or deleted from the items.
//!
//! **The data editor's paths, not new ones.** Reads go through `Session::table_data` and
//! `row_count`, the grid's paging, and writes through `Session::apply_edits`, the grid's Apply — so
//! the literals are the grid's, a read-only connection refuses here too, a run's writes are one
//! transaction on the SQL engines, and an update or a delete that would touch anything but exactly
//! one row rolls the whole batch back. What this module adds is the translation: conditions into a
//! `WHERE` fragment or a filter document, and an item's fields into cells.
//!
//! **Fields that are not columns are left out, and said so.** An item usually carries more than its
//! row (`$json` after an HTTP call, say); writing every field would make the statement fail on the
//! first one the table lacks. MongoDB has no columns to check against, so there every field goes.

use std::future::Future;

use serde_json::{json, Map, Value};

use super::data::{literal_for, retype, rows_of};
use super::{number, text, NodeCtx, NodeError};
use crate::datasource::{
    sqlgen, DbCell, DbKind, DbNodeKind, DbNodeRef, DbQueryOptions, DbRowEdit, DbRowEditKind, DbSortKey, DbTableDataRequest, Session,
    SqlDialect,
};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

/// Rows one read returns at most, whatever "Row limit" says — `0` means this.
const READ_CAP: u32 = 100_000;

/// A column as the catalogue describes it.
#[derive(Debug, Clone)]
struct Column {
    name: String,
    type_name: String,
    nullable: bool,
    primary_key: bool,
    default: Option<String>,
}

/// The table a run works on, and how to speak to its engine.
struct Target {
    /// `None` on MongoDB.
    dialect: Option<SqlDialect>,
    database: Option<String>,
    schema: Option<String>,
    table: String,
}

impl Target {
    fn mongo(&self) -> bool {
        self.dialect.is_none()
    }

    fn node(&self, kind: DbNodeKind) -> DbNodeRef {
        DbNodeRef { kind, database: self.database.clone(), schema: self.schema.clone(), name: Some(self.table.clone()) }
    }

    /// The table itself — a collection on MongoDB.
    fn relation(&self) -> DbNodeRef {
        self.node(if self.mongo() { DbNodeKind::Collection } else { DbNodeKind::Table })
    }
}

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let connection = ctx.param_str("connection");
    if connection.trim().is_empty() {
        return Err(NodeError::failed("Pick the database connection"));
    }
    let config = ctx.run.host.db_connection(connection.trim()).map_err(NodeError::Failed)?;
    if config.kind == DbKind::Redis {
        return Err(NodeError::failed("Redis keeps keys, not tables — use the Redis node"));
    }
    let database = Some(ctx.param_str("database").trim().to_string()).filter(|d| !d.is_empty());
    let tag = format!("flow-{}-{}", ctx.run.run_id, ctx.node.id);
    let session = tokio::select! {
        session = Session::open_tagged(&config, database.as_deref(), &tag) => session.map_err(NodeError::Failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let dialect = session.dialect();
    // A Mongo node names its database: the tree's nodes carry it, and the connection's is the one
    // meant when the field is left blank.
    let database = match (&database, dialect) {
        (None, None) => Some(config.database.trim().to_string()).filter(|d| !d.is_empty()),
        _ => database,
    };
    let (schema, table) = split_table(&ctx.param_str("schema"), &ctx.param_str("dbTable"), dialect.is_none());
    let target = Target { dialect, database, schema, table };
    let op = ctx.param_str("dbOp");
    if op == "dbTables" {
        return tables(ctx, &session, &target).await;
    }
    if target.table.is_empty() {
        return Err(NodeError::failed("Choose the table"));
    }
    match op.as_str() {
        "dbColumns" => {
            let columns = load_columns(ctx, &session, &target).await?;
            Ok(vec![columns.into_iter().map(|column| Item::new(column_json(&column))).collect()])
        }
        "dbRead" | "" => read(ctx, &session, &target).await,
        "dbCount" => count(ctx, &session, &target).await,
        "dbInsert" | "dbUpdate" | "dbUpsert" | "dbDelete" => write(ctx, &session, &target, &op).await,
        other => Err(NodeError::failed(format!("«{other}» is not something this node does"))),
    }
}

/// A session call that the run's Stop interrupts — on the server too, where the engine can.
async fn guarded<T>(ctx: &NodeCtx, session: &Session, work: impl Future<Output = Result<T, String>>) -> Result<T, NodeError> {
    tokio::select! {
        result = work => result.map_err(NodeError::Failed),
        _ = ctx.cancel.cancelled() => {
            session.cancel_running().await;
            Err(NodeError::Cancelled)
        }
    }
}

/// `schema.table` written in the table field, with the schema field blank, is the two of them —
/// on the SQL engines. A Mongo collection's name may hold a dot (`system.users`), so it never splits.
fn split_table(schema: &str, table: &str, mongo: bool) -> (Option<String>, String) {
    let (schema, table) = (schema.trim(), table.trim());
    if !schema.is_empty() {
        return (Some(schema.to_string()), table.to_string());
    }
    match table.split_once('.') {
        Some((owner, name)) if !mongo && !owner.is_empty() && !name.is_empty() => (Some(owner.to_string()), name.to_string()),
        _ => (None, table.to_string()),
    }
}

fn paired(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

// ---------------------------------------------------------------------------------- the catalogue

async fn tables(ctx: &NodeCtx, session: &Session, target: &Target) -> Result<Ports, NodeError> {
    let at = |kind| DbNodeRef { kind, database: target.database.clone(), schema: target.schema.clone(), name: None };
    let mut found = Vec::new();
    if target.mongo() {
        for node in guarded(ctx, session, session.children(&at(DbNodeKind::Database))).await? {
            found.push(json!({"name": node.name, "kind": "collection", "database": node.database}));
        }
    } else {
        for (folder, kind) in [(DbNodeKind::TableFolder, "table"), (DbNodeKind::ViewFolder, "view")] {
            let listed = guarded(ctx, session, session.children(&at(folder))).await;
            // Views are a courtesy: an engine or an account that cannot list them still has tables.
            let nodes = match (listed, kind) {
                (Ok(nodes), _) => nodes,
                (Err(NodeError::Cancelled), _) => return Err(NodeError::Cancelled),
                (Err(error), "table") => return Err(error),
                (Err(_), _) => Vec::new(),
            };
            for node in nodes {
                found.push(json!({"name": node.name, "kind": kind, "schema": node.schema, "database": node.database}));
            }
        }
    }
    Ok(vec![found.into_iter().map(Item::new).collect()])
}

async fn load_columns(ctx: &NodeCtx, session: &Session, target: &Target) -> Result<Vec<Column>, NodeError> {
    let nodes = guarded(ctx, session, session.children(&target.node(DbNodeKind::ColumnFolder))).await?;
    let columns: Vec<Column> = nodes
        .into_iter()
        .filter(|node| node.kind == DbNodeKind::Column)
        .map(|node| {
            let info = node.column;
            Column {
                type_name: info.as_ref().map(|c| c.data_type.clone()).unwrap_or_else(|| node.detail.clone()),
                nullable: info.as_ref().is_none_or(|c| c.nullable),
                primary_key: info.as_ref().is_some_and(|c| c.primary_key) || (target.mongo() && node.name == "_id"),
                default: info.and_then(|c| c.default_value),
                name: node.name,
            }
        })
        .collect();
    if columns.is_empty() && !target.mongo() {
        return Err(NodeError::failed(format!("«{}» has no columns here — check the table, schema and database", target.table)));
    }
    Ok(columns)
}

fn column_json(column: &Column) -> Value {
    json!({
        "name": column.name,
        "type": column.type_name,
        "nullable": column.nullable,
        "primaryKey": column.primary_key,
        "default": column.default,
    })
}

// ------------------------------------------------------------------------------------------ reading

/// The run's parameters: once per item, or once for the run.
async fn resolved(ctx: &NodeCtx) -> Result<Vec<Value>, NodeError> {
    if ctx.param_str("runFor") == "once" {
        Ok(vec![ctx.resolve_once().await?])
    } else {
        ctx.resolve_each().await
    }
}

async fn read(ctx: &NodeCtx, session: &Session, target: &Target) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (index, params) in resolved(ctx).await?.iter().enumerate() {
        let limit = match number(params, "maxRows").unwrap_or(100.0) {
            n if n <= 0.0 => READ_CAP,
            n => (n as u32).min(READ_CAP),
        };
        let request = DbTableDataRequest {
            node: target.relation(),
            offset: number(params, "dbOffset").unwrap_or(0.0).max(0.0) as u32,
            limit,
            sort: sort_keys(params),
            filter: filter_for(params, target).map_err(NodeError::Failed)?,
            options: DbQueryOptions::default(),
        };
        let mut result = guarded(ctx, session, session.table_data(&request)).await?;
        if let Some(error) = &result.error {
            return Err(NodeError::failed(error.clone()));
        }
        retype(session, &mut result).await;
        if result.truncated {
            ctx.log(LogStream::Info, &format!("Only the first {limit} rows were read (Row limit)"));
        }
        out.extend(rows_of(&result).into_iter().map(|row| paired(ctx, index, row)));
    }
    Ok(vec![out])
}

async fn count(ctx: &NodeCtx, session: &Session, target: &Target) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (index, params) in resolved(ctx).await?.iter().enumerate() {
        let filter = filter_for(params, target).map_err(NodeError::Failed)?;
        let counted = guarded(ctx, session, session.row_count(&target.relation(), &filter, &DbQueryOptions::default())).await?;
        out.push(paired(ctx, index, json!({ "table": target.table, "count": counted })));
    }
    Ok(vec![out])
}

fn sort_keys(params: &Value) -> Vec<DbSortKey> {
    params
        .get("dbSort")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let column = text(row, "field").trim().to_string();
                    (!column.is_empty()).then(|| DbSortKey { column, descending: text(row, "order") == "desc" })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One condition of the filter, as written: blank columns are rows still being typed.
struct Condition {
    column: String,
    op: String,
    value: Value,
}

fn conditions(params: &Value) -> (bool, Vec<Condition>) {
    let spec = params.get("dbFilters").cloned().unwrap_or(Value::Null);
    let any = text(&spec, "combinator") == "or";
    let list = spec
        .get("conditions")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let column = text(row, "column").trim().to_string();
                    (!column.is_empty()).then(|| Condition {
                        column,
                        op: Some(text(row, "op")).filter(|op| !op.is_empty()).unwrap_or_else(|| "equals".to_string()),
                        value: row.get("value").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (any, list)
}

/// The filter in the engine's own terms: a `WHERE` fragment, or a filter document for MongoDB.
/// Empty when there are no conditions.
fn filter_for(params: &Value, target: &Target) -> Result<String, String> {
    let (any, list) = conditions(params);
    if list.is_empty() {
        return Ok(String::new());
    }
    match target.dialect {
        Some(dialect) => sql_where(&list, any, dialect),
        None => Ok(mongo_filter(&list, any).to_string()),
    }
}

fn sql_where(list: &[Condition], any: bool, dialect: SqlDialect) -> Result<String, String> {
    let parts = list.iter().map(|condition| sql_condition(condition, dialect)).collect::<Result<Vec<_>, _>>()?;
    if parts.len() == 1 {
        return Ok(parts.into_iter().next().unwrap_or_default());
    }
    Ok(parts.iter().map(|part| format!("({part})")).collect::<Vec<_>>().join(if any { " OR " } else { " AND " }))
}

/// A value as words, for the patterns: a string as it is, anything else as JSON.
fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A list condition's values: a JSON array, or text split on commas.
fn list_values(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with('[') {
                if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(trimmed) {
                    return items;
                }
            }
            trimmed.split(',').map(str::trim).filter(|part| !part.is_empty()).map(|part| Value::String(part.to_string())).collect()
        }
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    }
}

/// `%`, `_` and the escape itself, escaped with `!` — the one escape character every engine here
/// reads the same way under `ESCAPE '!'`. A backslash would be doubled again by MySQL's literals.
fn escape_like(text: &str) -> String {
    text.replace('!', "!!").replace('%', "!%").replace('_', "!_")
}

fn sql_condition(condition: &Condition, dialect: SqlDialect) -> Result<String, String> {
    let column = sqlgen::quote_ident(&condition.column, dialect);
    let value = &condition.value;
    let compare = |operator: &str| -> Result<String, String> { Ok(format!("{column} {operator} {}", literal_for(value, dialect)?)) };
    Ok(match condition.op.as_str() {
        "isNull" => format!("{column} IS NULL"),
        "notNull" => format!("{column} IS NOT NULL"),
        "equals" if value.is_null() => format!("{column} IS NULL"),
        "notEquals" if value.is_null() => format!("{column} IS NOT NULL"),
        "equals" => compare("=")?,
        "notEquals" => compare("<>")?,
        "gt" => compare(">")?,
        "gte" => compare(">=")?,
        "lt" => compare("<")?,
        "lte" => compare("<=")?,
        op @ ("contains" | "notContains" | "startsWith" | "endsWith") => {
            let escaped = escape_like(&value_text(value));
            let pattern = match op {
                "startsWith" => format!("{escaped}%"),
                "endsWith" => format!("%{escaped}"),
                _ => format!("%{escaped}%"),
            };
            let not = if op == "notContains" { "NOT " } else { "" };
            format!("{column} {not}LIKE {} ESCAPE '!'", literal_for(&Value::String(pattern), dialect)?)
        }
        "inList" => {
            let values = list_values(value);
            if values.is_empty() {
                // Nothing is in an empty list — and `IN ()` is a syntax error everywhere.
                "1 = 0".to_string()
            } else {
                let literals = values.iter().map(|v| literal_for(v, dialect)).collect::<Result<Vec<_>, _>>()?;
                format!("{column} IN ({})", literals.join(", "))
            }
        }
        other => return Err(format!("«{other}» is not a condition this node knows")),
    })
}

/// A 24-digit hex string: how an ObjectId reads once it is in an item.
fn looks_like_object_id(text: &str) -> bool {
    text.len() == 24 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// The values an equality on MongoDB should match. Typed text loses its type on the way into an
/// item — an `_id` read back is its hex, a number typed in a field is text — so such a value
/// matches either reading: `{"$in": [text, ObjectId]}`, `{"$in": ["18", 18]}`.
fn mongo_candidates(column: &str, value: &Value) -> Vec<Value> {
    let mut candidates = vec![mongo_plain(value)];
    if let Value::String(text) = value {
        if column == "_id" && looks_like_object_id(text) {
            candidates.push(json!({ "$oid": text }));
        } else if let Some(number) = numeric(text) {
            candidates.push(number);
        }
    }
    candidates
}

/// A value as a value. An object in a filter is an *operator* to MongoDB — `{"$ne": null}` in a
/// webhook's body, taken as the user to look for, would match every document — so what an item carries
/// goes in as the text of it, as the SQL side does. (The `{"$oid": …}` conversions below are ours.)
fn mongo_plain(value: &Value) -> Value {
    match value {
        Value::Object(_) => Value::String(value.to_string()),
        other => other.clone(),
    }
}

/// Text that is a number, as one — never a string with leading zeros (`"01234"` is a postcode).
fn numeric(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() || (trimmed.len() > 1 && trimmed.starts_with('0') && !trimmed.starts_with("0.")) {
        return None;
    }
    if let Ok(n) = trimmed.parse::<i64>() {
        return Some(json!(n));
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite()).and_then(serde_json::Number::from_f64).map(Value::Number)
}

/// `value` as one BSON value for an operator that takes one: an ObjectId's hex on `_id` becomes the
/// ObjectId, numeric text the number.
fn mongo_scalar(column: &str, value: &Value) -> Value {
    match value {
        Value::String(text) if column == "_id" && looks_like_object_id(text) => json!({ "$oid": text }),
        Value::String(text) => numeric(text).unwrap_or_else(|| value.clone()),
        _ => mongo_plain(value),
    }
}

/// Regex metacharacters escaped, so a value is matched as the text it is.
fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if "\\^$.|?*+()[]{}/-".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn mongo_condition(condition: &Condition) -> Value {
    let column = condition.column.as_str();
    let value = &condition.value;
    let equality = |value: &Value| -> Value {
        let candidates = mongo_candidates(column, value);
        if candidates.len() == 1 {
            candidates.into_iter().next().unwrap_or(Value::Null)
        } else {
            json!({ "$in": candidates })
        }
    };
    let test = match condition.op.as_str() {
        "isNull" => Value::Null,
        "notNull" => json!({ "$ne": null }),
        "equals" => equality(value),
        "notEquals" => json!({ "$nin": mongo_candidates(column, value) }),
        "gt" => json!({ "$gt": mongo_scalar(column, value) }),
        "gte" => json!({ "$gte": mongo_scalar(column, value) }),
        "lt" => json!({ "$lt": mongo_scalar(column, value) }),
        "lte" => json!({ "$lte": mongo_scalar(column, value) }),
        "contains" => json!({ "$regex": regex_escape(&value_text(value)) }),
        "notContains" => json!({ "$not": { "$regex": regex_escape(&value_text(value)) } }),
        "startsWith" => json!({ "$regex": format!("^{}", regex_escape(&value_text(value))) }),
        "endsWith" => json!({ "$regex": format!("{}$", regex_escape(&value_text(value))) }),
        "inList" => {
            let values: Vec<Value> = list_values(value).iter().flat_map(|v| mongo_candidates(column, v)).collect();
            json!({ "$in": values })
        }
        _ => equality(value),
    };
    let mut one = Map::new();
    one.insert(column.to_string(), test);
    Value::Object(one)
}

fn mongo_filter(list: &[Condition], any: bool) -> Value {
    let parts: Vec<Value> = list.iter().map(mongo_condition).collect();
    if parts.len() == 1 {
        return parts.into_iter().next().unwrap_or_else(|| json!({}));
    }
    let mut joined = Map::new();
    joined.insert(if any { "$or" } else { "$and" }.to_string(), Value::Array(parts));
    Value::Object(joined)
}

// ------------------------------------------------------------------------------------------ writing

/// The row's fields from `rowData`: an object, or JSON text of one.
fn row_data(params: &Value) -> Result<Map<String, Value>, String> {
    match params.get("rowData") {
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(Value::String(written)) if written.trim().starts_with('{') => match serde_json::from_str::<Value>(written) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err("«Row» is not a JSON object".to_string()),
        },
        Some(Value::Null) | None => Ok(Map::new()),
        Some(Value::String(written)) if written.trim().is_empty() => Ok(Map::new()),
        _ => Err("«Row» must be an object of fields — for the whole item: {{ $json }}".to_string()),
    }
}

fn strings(params: &Value, name: &str) -> Vec<String> {
    params
        .get(name)
        .and_then(Value::as_array)
        .map(|list| list.iter().map(value_text).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

/// A value as a cell's text: `None` is NULL. Booleans as the engine spells them — `1`/`0` wherever a
/// boolean is a number (SQLite, MySQL's `TINYINT(1)`, SQL Server's `bit`, Oracle, IRIS). Cells are
/// written quoted, and SQLite keeps a quoted `'false'` as the text `false`.
fn cell_text(value: &Value, dialect: Option<SqlDialect>) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Bool(flag) => Some(match dialect {
            None | Some(SqlDialect::Postgres) => flag.to_string(),
            Some(_) => if *flag { "1" } else { "0" }.to_string(),
        }),
        other => Some(other.to_string()),
    }
}

/// The BSON type a JSON value is kept as — the names `cell_to_bson` reads.
fn mongo_type(column: &str, value: &Value) -> &'static str {
    match value {
        Value::String(text) if column == "_id" && looks_like_object_id(text) => "objectId",
        Value::String(_) => "string",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_i64() || n.is_u64() => "long",
        Value::Number(_) => "double",
        _ => "",
    }
}

/// One item's fields as cells: on a SQL engine only the table's columns, matched by name (exactly,
/// else ignoring case), and only `only` when it names any. Returns the cells and the fields left out.
fn cells_of(row: &Map<String, Value>, columns: &[Column], only: &[String], dialect: Option<SqlDialect>) -> (Vec<DbCell>, Vec<String>) {
    let mut cells = Vec::new();
    let mut skipped = Vec::new();
    for (field, value) in row {
        if !only.is_empty() && !only.iter().any(|name| name.eq_ignore_ascii_case(field)) {
            continue;
        }
        let (column, type_name) = if dialect.is_none() {
            (field.clone(), mongo_type(field, value).to_string())
        } else {
            match columns.iter().find(|c| c.name == *field).or_else(|| columns.iter().find(|c| c.name.eq_ignore_ascii_case(field))) {
                Some(column) => (column.name.clone(), column.type_name.clone()),
                None => {
                    skipped.push(field.clone());
                    continue;
                }
            }
        };
        cells.push(DbCell { column, value: cell_text(value, dialect), type_name });
    }
    (cells, skipped)
}

/// The cells that find an item's row again: one per key column, from the item.
fn key_cells(row: &Map<String, Value>, keys: &[String], columns: &[Column], dialect: Option<SqlDialect>, ordinal: usize) -> Result<Vec<DbCell>, String> {
    keys.iter()
        .map(|key| {
            let value = row
                .get(key)
                .or_else(|| row.iter().find(|(field, _)| field.eq_ignore_ascii_case(key)).map(|(_, value)| value))
                .ok_or_else(|| format!("Item {ordinal} has no «{key}» — the key that finds its row"))?;
            if value.is_null() {
                return Err(format!("Item {ordinal} has «{key}» empty — a key has to have a value"));
            }
            let type_name = match dialect {
                None => mongo_type(key, value).to_string(),
                Some(_) => columns.iter().find(|c| c.name.eq_ignore_ascii_case(key)).map(|c| c.type_name.clone()).unwrap_or_default(),
            };
            let column = columns.iter().find(|c| c.name.eq_ignore_ascii_case(key)).map(|c| c.name.clone()).unwrap_or_else(|| key.clone());
            Ok(DbCell { column, value: cell_text(value, dialect), type_name })
        })
        .collect()
}

/// Whether the row these keys find is there — for an upsert, before choosing update or insert.
async fn exists(ctx: &NodeCtx, session: &Session, target: &Target, row: &Map<String, Value>, keys: &[String]) -> Result<bool, NodeError> {
    let list: Vec<Condition> = keys
        .iter()
        .map(|key| Condition {
            column: key.clone(),
            op: "equals".to_string(),
            value: row.get(key).or_else(|| row.iter().find(|(f, _)| f.eq_ignore_ascii_case(key)).map(|(_, v)| v)).cloned().unwrap_or(Value::Null),
        })
        .collect();
    let filter = match target.dialect {
        Some(dialect) => sql_where(&list, false, dialect).map_err(NodeError::Failed)?,
        None => mongo_filter(&list, false).to_string(),
    };
    let request = DbTableDataRequest { node: target.relation(), offset: 0, limit: 1, sort: Vec::new(), filter, options: DbQueryOptions::default() };
    let found = guarded(ctx, session, session.table_data(&request)).await?;
    if let Some(error) = found.error {
        return Err(NodeError::Failed(error));
    }
    Ok(!found.rows.is_empty() || !found.documents.is_empty())
}

/// A key field of an item or a row, its name in any case.
fn key_value<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    row.get(key).or_else(|| row.iter().find(|(field, _)| field.eq_ignore_ascii_case(key)).map(|(_, value)| value))
}

/// A key value as text, exactly: `7` and `"7"` alike (the database answers in its column's type, the item in its own).
fn exact_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "\u{0}".to_string(),
        other => other.to_string(),
    }
}

/// A key value as the database might still call it equal: case and padding aside, `7.0` as `7`.
fn loose_text(value: &Value) -> String {
    let text = exact_text(value).trim().to_lowercase();
    match text.parse::<f64>() {
        Ok(number) if number.is_finite() => format!("{number}"),
        _ => text,
    }
}

/// The values that find a row, as one comparable text — two items with the same signature are the same row.
fn key_signature(row: &Map<String, Value>, keys: &[String]) -> String {
    keys.iter().map(|key| key_value(row, key).map_or_else(|| "\u{0}".to_string(), exact_text)).collect::<Vec<_>>().join("\u{1f}")
}

fn loose_signature(row: &Map<String, Value>, keys: &[String]) -> String {
    keys.iter().map(|key| key_value(row, key).map_or_else(|| "\u{0}".to_string(), loose_text)).collect::<Vec<_>>().join("\u{1f}")
}

/// How many items' keys one lookup asks about.
const LOOKUP_CHUNK: usize = 200;

/// What an upsert found already in the table for one set of key columns.
#[derive(Default)]
struct Found {
    /// The keys of the rows that are there, as [`key_signature`] writes them.
    exact: std::collections::HashSet<String>,
    /// The same, as [`loose_signature`] writes them: an item that matches only this way is asked about on its own — the
    /// database's collation or a CHAR column's padding decides, not this text.
    loose: std::collections::HashSet<String>,
    /// A lookup that hit its row limit (keys that are not unique): what it did not return is not known to be absent.
    unsure: bool,
}

/// The rows of the table whose keys the batch carries, read [`LOOKUP_CHUNK`] items at a time — `key IN (…)` for one key
/// column, `(a = … AND b = …) OR …` for several. What an upsert decides insert-or-update by, instead of one SELECT per
/// item.
async fn existing(ctx: &NodeCtx, session: &Session, target: &Target, dialect: SqlDialect, rows: &[&Map<String, Value>], keys: &[String]) -> Result<Found, NodeError> {
    let mut found = Found::default();
    for chunk in rows.chunks(LOOKUP_CHUNK) {
        let filter = if keys.len() == 1 {
            let values: Vec<Value> = chunk.iter().filter_map(|row| key_value(row, &keys[0]).cloned()).filter(|v| !v.is_null()).collect();
            sql_where(&[Condition { column: keys[0].clone(), op: "inList".into(), value: Value::Array(values) }], false, dialect)
        } else {
            chunk
                .iter()
                .map(|row| {
                    let list: Vec<Condition> =
                        keys.iter().map(|key| Condition { column: key.clone(), op: "equals".into(), value: key_value(row, key).cloned().unwrap_or(Value::Null) }).collect();
                    sql_where(&list, false, dialect).map(|part| format!("({part})"))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|parts| parts.join(" OR "))
        }
        .map_err(NodeError::Failed)?;
        let limit = (chunk.len() * 10).min(10_000) as u32;
        let request = DbTableDataRequest { node: target.relation(), offset: 0, limit, sort: Vec::new(), filter, options: DbQueryOptions::default() };
        let mut answer = guarded(ctx, session, session.table_data(&request)).await?;
        if let Some(error) = answer.error.take() {
            return Err(NodeError::Failed(error));
        }
        retype(session, &mut answer).await;
        found.unsure |= answer.truncated;
        for row in rows_of(&answer) {
            if let Value::Object(map) = row {
                found.exact.insert(key_signature(&map, keys));
                found.loose.insert(loose_signature(&map, keys));
            }
        }
    }
    Ok(found)
}

/// The columns that find an item's row: the ones the node names, `_id` for a collection, the table's primary key otherwise.
fn keys_for(params: &Value, target: &Target, columns: &[Column]) -> Vec<String> {
    match strings(params, "dbKeys") {
        named if !named.is_empty() => named,
        _ if target.mongo() => vec!["_id".to_string()],
        _ => columns.iter().filter(|c| c.primary_key).map(|c| c.name.clone()).collect(),
    }
}

async fn write(ctx: &NodeCtx, session: &Session, target: &Target, op: &str) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let columns = if target.mongo() { Vec::new() } else { load_columns(ctx, session, target).await? };
    let mut edits = Vec::with_capacity(resolved.len());
    let mut skipped: Vec<String> = Vec::new();
    let (mut inserts, mut updates) = (0usize, 0usize);
    // What an upsert finds already there, asked for the whole batch at once (per set of key columns) — Mongo's `_id`
    // forms are many, so a collection is still asked item by item.
    let mut found: std::collections::HashMap<Vec<String>, Found> = std::collections::HashMap::new();
    if let (true, Some(dialect)) = (op == "dbUpsert", target.dialect) {
        let rows: Vec<(Map<String, Value>, Vec<String>)> =
            resolved.iter().filter_map(|params| row_data(params).ok().map(|row| (row, keys_for(params, target, &columns)))).filter(|(_, keys)| !keys.is_empty()).collect();
        let mut groups: Vec<(Vec<String>, Vec<&Map<String, Value>>)> = Vec::new();
        for (row, keys) in &rows {
            match groups.iter_mut().find(|(known, _)| known == keys) {
                Some((_, members)) => members.push(row),
                None => groups.push((keys.clone(), vec![row])),
            }
        }
        for (keys, members) in &groups {
            found.insert(keys.clone(), existing(ctx, session, target, dialect, members, keys).await?);
        }
        let asked = groups.iter().map(|(_, members)| members.len().div_ceil(LOOKUP_CHUNK)).sum::<usize>();
        ctx.log(LogStream::Info, &format!("«{}»: {} key(s) looked up in {asked} query(ies)", target.table, rows.len()));
    }
    // The rows this batch inserts. `exists` looks at the table, which does not have them yet: a second item with
    // the same key would be inserted again (a duplicate-key error, or a duplicated row where nothing is unique)
    // instead of updating the first.
    let mut inserted: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (index, params) in resolved.iter().enumerate() {
        let ordinal = index + 1;
        let row = row_data(params).map_err(|e| NodeError::failed(format!("Item {ordinal}: {e}")))?;
        let keys = keys_for(params, target, &columns);
        if op != "dbInsert" && keys.is_empty() {
            return Err(NodeError::failed(format!(
                "«{}» has no primary key — name the columns that find a row in «Key columns»",
                target.table
            )));
        }
        let only = strings(params, "dbFields");
        let (cells, left_out) = cells_of(&row, &columns, &only, target.dialect);
        for field in left_out {
            if !skipped.contains(&field) {
                skipped.push(field);
            }
        }
        let is_key = |cell: &DbCell| keys.iter().any(|key| key.eq_ignore_ascii_case(&cell.column));
        let insert = |cells: Vec<DbCell>| -> Result<DbRowEdit, NodeError> {
            if cells.is_empty() {
                return Err(NodeError::failed(format!("Item {ordinal} has no field that is a column of «{}»", target.table)));
            }
            // A document keeps its types and nesting whole; cells would make every value a string.
            let document = target.mongo().then(|| {
                let kept: Map<String, Value> = row
                    .iter()
                    .filter(|(field, _)| only.is_empty() || only.iter().any(|name| name.eq_ignore_ascii_case(field)))
                    .map(|(field, value)| (field.clone(), value.clone()))
                    .collect();
                Value::Object(kept).to_string()
            });
            Ok(DbRowEdit { kind: DbRowEditKind::Insert, values: if document.is_some() { Vec::new() } else { cells }, keys: Vec::new(), document })
        };
        let update = |cells: Vec<DbCell>| -> Result<DbRowEdit, NodeError> {
            let values: Vec<DbCell> = cells.into_iter().filter(|cell| !is_key(cell)).collect();
            if values.is_empty() {
                return Err(NodeError::failed(format!("Item {ordinal} has nothing to change besides its key")));
            }
            Ok(DbRowEdit {
                kind: DbRowEditKind::Update,
                values,
                keys: key_cells(&row, &keys, &columns, target.dialect, ordinal).map_err(NodeError::Failed)?,
                document: None,
            })
        };
        let edit = match op {
            "dbInsert" => {
                inserts += 1;
                insert(cells)?
            }
            "dbUpdate" => {
                updates += 1;
                update(cells)?
            }
            "dbDelete" => DbRowEdit {
                kind: DbRowEditKind::Delete,
                values: Vec::new(),
                keys: key_cells(&row, &keys, &columns, target.dialect, ordinal).map_err(NodeError::Failed)?,
                document: None,
            },
            _ => {
                key_cells(&row, &keys, &columns, target.dialect, ordinal).map_err(NodeError::Failed)?;
                let signature = key_signature(&row, &keys);
                let present = if inserted.contains(&signature) {
                    true
                } else {
                    match found.get(&keys) {
                        Some(found) if found.exact.contains(&signature) => true,
                        // Equal only loosely (another case, a padded CHAR, 7 against 7.0), or a lookup that could not list
                        // every row: the database says, for this item alone.
                        Some(found) if found.unsure || found.loose.contains(&loose_signature(&row, &keys)) => exists(ctx, session, target, &row, &keys).await?,
                        Some(_) => false,
                        None => exists(ctx, session, target, &row, &keys).await?,
                    }
                };
                if present {
                    // Found, and nothing to set besides the key: the row already says it.
                    if cells.iter().all(|cell| is_key(cell)) {
                        continue;
                    }
                    updates += 1;
                    update(cells)?
                } else {
                    inserts += 1;
                    inserted.insert(signature);
                    insert(cells)?
                }
            }
        };
        edits.push(edit);
    }
    if !skipped.is_empty() {
        ctx.log(LogStream::Info, &format!("Not columns of «{}», left out: {}", target.table, skipped.join(", ")));
    }
    if !edits.is_empty() {
        let result = guarded(ctx, session, session.apply_edits(&target.relation(), &edits)).await?;
        if let Some(error) = result.error {
            return Err(NodeError::Failed(error));
        }
        let what = match op {
            "dbDelete" => format!("{} deleted", result.applied),
            "dbUpsert" => format!("{inserts} inserted, {updates} updated"),
            _ => format!("{} written", result.applied),
        };
        ctx.log(LogStream::Info, &format!("«{}»: {what}{}", target.table, if target.mongo() { "" } else { " — one transaction" }));
    }
    // The items go on as they came: what was written is what they said.
    Ok(vec![ctx.passthrough()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn condition(column: &str, op: &str, value: Value) -> Condition {
        Condition { column: column.to_string(), op: op.to_string(), value }
    }

    #[test]
    fn a_key_is_equal_exactly_or_only_loosely() {
        let row = |value: Value| json!({"k": value}).as_object().cloned().unwrap();
        let keys = vec!["k".to_string()];
        assert_eq!(key_signature(&row(json!(7)), &keys), key_signature(&row(json!("7")), &keys), "the database answers in its column's type");
        assert_ne!(key_signature(&row(json!("ana")), &keys), key_signature(&row(json!("ANA ")), &keys));
        assert_eq!(loose_signature(&row(json!("ana")), &keys), loose_signature(&row(json!("ANA ")), &keys), "a collation or a CHAR column may still call them one");
        assert_eq!(loose_signature(&row(json!(7.0)), &keys), loose_signature(&row(json!(7)), &keys));
    }

    #[test]
    fn two_items_with_one_key_have_one_signature_however_the_field_is_cased() {
        let a = json!({"ID": 7, "name": "a"});
        let b = json!({"id": 7, "name": "b"});
        let c = json!({"id": 8});
        let keys = vec!["id".to_string()];
        let sig = |v: &Value| key_signature(v.as_object().unwrap(), &keys);
        assert_eq!(sig(&a), sig(&b));
        assert_ne!(sig(&a), sig(&c));
    }

    #[test]
    fn a_dotted_table_is_a_schema_and_a_table_on_sql_only() {
        assert_eq!(split_table("", "shop.orders", false), (Some("shop".to_string()), "orders".to_string()));
        assert_eq!(split_table("", "system.users", true), (None, "system.users".to_string()));
        assert_eq!(split_table("public", "a.b", false), (Some("public".to_string()), "a.b".to_string()));
        assert_eq!(split_table(" ", " users ", false), (None, "users".to_string()));
    }

    #[test]
    fn conditions_become_a_where_fragment_in_each_dialect() {
        let list = vec![
            condition("status", "equals", json!("O'Brien")),
            condition("total", "gte", json!(10.5)),
            condition("deleted_at", "isNull", Value::Null),
        ];
        assert_eq!(
            sql_where(&list, false, SqlDialect::Postgres).unwrap(),
            r#"("status" = 'O''Brien') AND ("total" >= 10.5) AND ("deleted_at" IS NULL)"#
        );
        assert_eq!(sql_where(&list[..1], true, SqlDialect::TSql).unwrap(), "[status] = N'O''Brien'");
        assert_eq!(
            sql_where(&[condition("name", "contains", json!("50%_off!"))], false, SqlDialect::MySql { backslash_escapes: true }).unwrap(),
            "`name` LIKE '%50!%!_off!!%' ESCAPE '!'"
        );
        assert_eq!(sql_where(&[condition("id", "inList", json!("1, 2,3"))], false, SqlDialect::Sqlite).unwrap(), r#""id" IN ('1', '2', '3')"#);
        assert_eq!(sql_where(&[condition("id", "inList", json!([]))], false, SqlDialect::Sqlite).unwrap(), "1 = 0");
        assert_eq!(sql_where(&[condition("x", "equals", Value::Null)], false, SqlDialect::Oracle).unwrap(), r#""x" IS NULL"#);
        assert!(sql_where(&[condition("x", "regex", json!("a"))], false, SqlDialect::Postgres).is_err());
    }

    #[test]
    fn a_value_cannot_end_its_literal_early() {
        // MySQL reads a backslash as an escape: doubled, the quote stays inside the string.
        let fragment = sql_where(&[condition("name", "equals", json!(r"\' OR 1=1 --"))], false, SqlDialect::MySql { backslash_escapes: true }).unwrap();
        assert_eq!(fragment, r"`name` = '\\'' OR 1=1 --'");
        // A column name is an identifier, quoted with its closer doubled.
        assert_eq!(sql_where(&[condition(r#"a"b"#, "isNull", Value::Null)], false, SqlDialect::Postgres).unwrap(), r#""a""b" IS NULL"#);
    }

    #[test]
    fn mongo_conditions_match_what_an_item_carries() {
        let id = "65f1c2a9e4b0a1b2c3d4e5f6";
        assert_eq!(mongo_filter(&[condition("_id", "equals", json!(id))], false), json!({"_id": {"$in": [id, {"$oid": id}]}}));
        assert_eq!(mongo_filter(&[condition("age", "equals", json!("18"))], false), json!({"age": {"$in": ["18", 18]}}));
        assert_eq!(mongo_filter(&[condition("zip", "equals", json!("01234"))], false), json!({"zip": "01234"}));
        assert_eq!(
            mongo_filter(&[condition("age", "gt", json!("18")), condition("name", "startsWith", json!("a.b"))], true),
            json!({"$or": [{"age": {"$gt": 18}}, {"name": {"$regex": "^a\\.b"}}]})
        );
        assert_eq!(mongo_filter(&[condition("x", "notNull", Value::Null)], false), json!({"x": {"$ne": null}}));
    }

    #[test]
    fn an_object_an_item_carries_is_never_an_operator() {
        let hostile = json!({"$ne": null});
        let text = hostile.to_string();
        for op in ["equals", "notEquals", "gt", "lte", "inList"] {
            let filter = mongo_filter(&[condition("user", op, hostile.clone())], false);
            assert!(!filter.to_string().contains("\"$ne\":null}"), "{op}: {filter}");
        }
        assert_eq!(mongo_filter(&[condition("user", "equals", hostile)], false), json!({"user": text}));
        let listed = mongo_filter(&[condition("user", "inList", json!([{"$gt": ""}, "ana"]))], false);
        assert!(listed["user"]["$in"].as_array().unwrap().iter().all(Value::is_string), "{listed}");
    }

    #[test]
    fn only_columns_become_cells_and_booleans_take_the_engines_spelling() {
        let columns = vec![
            Column { name: "id".into(), type_name: "integer".into(), nullable: false, primary_key: true, default: None },
            Column { name: "Paid".into(), type_name: "boolean".into(), nullable: true, primary_key: false, default: None },
        ];
        let row = json!({"id": 7, "paid": true, "extra": "x"}).as_object().cloned().unwrap();
        let (cells, skipped) = cells_of(&row, &columns, &[], Some(SqlDialect::Postgres));
        assert_eq!(skipped, vec!["extra".to_string()]);
        let pairs: Vec<(String, Option<String>)> = cells.iter().map(|c| (c.column.clone(), c.value.clone())).collect();
        assert_eq!(pairs, vec![("id".to_string(), Some("7".to_string())), ("Paid".to_string(), Some("true".to_string()))]);
        let (cells, _) = cells_of(&row, &columns, &[], Some(SqlDialect::TSql));
        assert_eq!(cells[1].value.as_deref(), Some("1"));
        let (cells, _) = cells_of(&row, &columns, &["paid".to_string()], Some(SqlDialect::Postgres));
        assert_eq!(cells.len(), 1);
        assert!(key_cells(&row, &["missing".to_string()], &columns, Some(SqlDialect::Postgres), 3).unwrap_err().contains("Item 3"));
    }
}
