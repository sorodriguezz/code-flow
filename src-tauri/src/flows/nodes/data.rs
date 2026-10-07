//! SQL, MongoDB and Redis over the Databases workspace's saved connections, and spreadsheets.
//!
//! **The console's drivers, not new ones.** A node opens the connection the way the database
//! console does (`datasource::Session`, SSH tunnel and startup script included), runs its statement
//! and closes it — so a read-only connection stays read-only here too, and every engine the console
//! speaks is one a flow speaks.
//!
//! **Values never travel inside the SQL text by hand.** A query names its values `$1`, `$2`… and
//! the node writes each one as the engine's own literal (`datasource::sqlgen::literal` — the same
//! escaping the grid's edits use, MySQL's backslashes included), skipping quoted strings, quoted
//! identifiers and comments, so a value from an item can never end a string early and become SQL.

use calamine::Reader as _;
use serde_json::{json, Map, Value};

use super::files::{expand, write_whole};
use super::formats::{cell_text, columns_of, parse_csv, rows_to_objects, write_csv};
use super::{flag, number, text, NodeCtx, NodeError};
use crate::datasource::{DbExecContext, DbKind, DbStatementResult, Session, SqlDialect};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "data.sql" | "data.mongo" | "data.redis" => query(ctx).await,
        "data.sheet" => sheet(ctx).await,
        "data.dbml" => dbml(ctx).await,
        "data.schemaDiff" => schema_diff(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

/// The rows of one statement on a saved connection — for the nodes that ask a database one question
/// (`logic.until`'s "until the query returns rows").
pub async fn query_rows(ctx: &NodeCtx, connection: &str, statement: &str) -> Result<Vec<Value>, NodeError> {
    if statement.trim().is_empty() {
        return Err(NodeError::failed("Write the query"));
    }
    let config = ctx.run.host.db_connection(connection.trim()).map_err(NodeError::Failed)?;
    let tag = format!("flow-{}-{}-check", ctx.run.run_id, ctx.node.id);
    let session = tokio::select! {
        session = Session::open_tagged(&config, None, &tag) => session.map_err(NodeError::Failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let exec = DbExecContext { database: None, schema: None, max_rows: 100 };
    let result = tokio::select! {
        result = session.execute(statement, &exec) => result.map_err(NodeError::Failed)?,
        _ = ctx.cancel.cancelled() => {
            session.cancel_running().await;
            return Err(NodeError::Cancelled);
        }
    };
    let mut rows = Vec::new();
    for statement_result in &result.results {
        if let Some(error) = &statement_result.error {
            return Err(NodeError::failed(error.clone()));
        }
        rows = rows_of(statement_result);
    }
    Ok(rows)
}

// -------------------------------------------------------------------------------- schema diff

/// One table of a schema as the diff reads it: its columns by name, its keys and its references.
struct TableShape {
    columns: Vec<(String, String, bool, bool)>,
    references: Vec<(String, String, String, String)>,
}

fn shapes(diagram: &Value) -> std::collections::BTreeMap<String, TableShape> {
    let mut out = std::collections::BTreeMap::new();
    for table in diagram.get("tables").and_then(Value::as_array).into_iter().flatten() {
        if table.get("kind").and_then(Value::as_str).is_some_and(|k| !k.eq_ignore_ascii_case("table")) {
            continue;
        }
        let name = table.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let columns = table
            .get("columns")
            .and_then(Value::as_array)
            .map(|cols| {
                cols.iter()
                    .map(|c| {
                        (
                            c.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                            c.get("data_type").and_then(Value::as_str).unwrap_or_default().to_string(),
                            c.get("nullable").and_then(Value::as_bool).unwrap_or(true),
                            c.get("primary_key").and_then(Value::as_bool).unwrap_or(false),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.insert(name, TableShape { columns, references: Vec::new() });
    }
    for edge in diagram.get("edges").and_then(Value::as_array).into_iter().flatten() {
        if edge.get("inferred").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let from = edge.get("from_table").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(shape) = out.get_mut(&from) {
            shape.references.push((
                edge.get("constraint").and_then(Value::as_str).unwrap_or_default().to_string(),
                edge.get("from_column").and_then(Value::as_str).unwrap_or_default().to_string(),
                edge.get("to_table").and_then(Value::as_str).unwrap_or_default().to_string(),
                edge.get("to_column").and_then(Value::as_str).unwrap_or_default().to_string(),
            ));
        }
    }
    out
}

fn quote_ident(name: &str, dialect: &str) -> String {
    match dialect {
        "dialectMysql" => format!("`{}`", name.replace('`', "``")),
        "dialectSqlserver" => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// A foreign key: its constraint's name (empty when it has none), its columns, and the table and the
/// columns it points at.
type ForeignKey = (String, Vec<String>, String, Vec<String>);

/// References grouped into the keys they belong to. A two-column key arrives as two edges sharing a
/// constraint name and is one `FOREIGN KEY (a, b)` — two statements naming it would fail on the
/// second. An edge without a name is a key of its own.
fn foreign_keys<'a>(references: impl IntoIterator<Item = &'a (String, String, String, String)>) -> Vec<ForeignKey> {
    let mut keys: Vec<ForeignKey> = Vec::new();
    for (name, column, to_table, to_column) in references {
        match keys.iter_mut().find(|key| !name.is_empty() && &key.0 == name && &key.2 == to_table) {
            Some(key) => {
                key.1.push(column.clone());
                key.3.push(to_column.clone());
            }
            None => keys.push((name.clone(), vec![column.clone()], to_table.clone(), vec![to_column.clone()])),
        }
    }
    keys
}

/// What turns schema B into schema A: each difference, and the DDL for it in `dialect`.
///
/// The statements come in an order that runs: foreign keys dropped first (MySQL will not drop a column
/// one uses), then tables made and columns changed, then foreign keys added — once every table they
/// point at exists, the new ones included — and the tables that go, last. What a dialect has no
/// statement for (SQLite changing a column, or adding a key to a table that exists) is a `--` comment
/// that says so, never SQL that fails half way through.
pub fn diff_schemas(a: &Value, b: &Value, dialect: &str) -> (Vec<Value>, Vec<String>) {
    let (left, right) = (shapes(a), shapes(b));
    let q = |n: &str| quote_ident(n, dialect);
    let sqlite = dialect == "dialectSqlite";
    let type_of = |kind: &str| if kind.is_empty() { "text".to_string() } else { kind.to_string() };
    let list = |names: &[String]| names.iter().map(|n| q(n)).collect::<Vec<_>>().join(", ");
    let key_clause = |(name, columns, to_table, to_columns): &ForeignKey| {
        let constraint = if name.is_empty() { String::new() } else { format!("CONSTRAINT {} ", q(name)) };
        format!("{constraint}FOREIGN KEY ({}) REFERENCES {} ({})", list(columns), q(to_table), list(to_columns))
    };
    let same = |x: &(String, String, String, String), y: &(String, String, String, String)| x.1 == y.1 && x.2 == y.2 && x.3 == y.3;
    let mut changes = Vec::new();
    let (mut keys_dropped, mut tables, mut keys_added, mut tables_dropped): (Vec<String>, Vec<String>, Vec<String>, Vec<String>) = Default::default();
    for (name, table) in &left {
        let Some(other) = right.get(name) else {
            changes.push(json!({"change": "tableAdded", "table": name, "columns": table.columns.len()}));
            let mut lines: Vec<String> = table
                .columns
                .iter()
                .map(|(c, t, nullable, _)| format!("  {} {}{}", q(c), type_of(t), if *nullable { "" } else { " NOT NULL" }))
                .collect();
            let primary: Vec<String> = table.columns.iter().filter(|c| c.3).map(|c| c.0.clone()).collect();
            if !primary.is_empty() {
                lines.push(format!("  PRIMARY KEY ({})", list(&primary)));
            }
            let keys = foreign_keys(&table.references);
            if sqlite {
                // SQLite takes a key only as part of its table, and minds no table it names not
                // existing yet.
                lines.extend(keys.iter().map(|key| format!("  {}", key_clause(key))));
            } else {
                keys_added.extend(keys.iter().map(|key| format!("ALTER TABLE {} ADD {};", q(name), key_clause(key))));
            }
            tables.push(format!("CREATE TABLE {} (\n{}\n);", q(name), lines.join(",\n")));
            continue;
        };
        for (column, kind, nullable, key) in &table.columns {
            match other.columns.iter().find(|c| &c.0 == column) {
                None => {
                    changes.push(json!({"change": "columnAdded", "table": name, "column": column, "type": kind}));
                    tables.push(if sqlite && (!*nullable || *key) {
                        format!("-- SQLite cannot add {column} to {name} as a NOT NULL or key column without a default: add it with one, or rebuild {name}")
                    } else {
                        // SQL Server's `ADD` takes no `COLUMN`.
                        let add = if dialect == "dialectSqlserver" { "ADD" } else { "ADD COLUMN" };
                        format!("ALTER TABLE {} {add} {} {}{};", q(name), q(column), type_of(kind), if *nullable { "" } else { " NOT NULL" })
                    });
                }
                Some((_, other_kind, other_nullable, other_key)) => {
                    let retyped = !kind.eq_ignore_ascii_case(other_kind);
                    let renulled = nullable != other_nullable;
                    if retyped {
                        changes.push(json!({"change": "typeChanged", "table": name, "column": column, "from": other_kind, "to": kind}));
                    }
                    if renulled {
                        changes.push(json!({"change": "nullabilityChanged", "table": name, "column": column, "nullable": nullable}));
                    }
                    if retyped || renulled {
                        let null = |nullable: bool| if nullable { "NULL" } else { "NOT NULL" };
                        match dialect {
                            // Both restate the whole column, so one statement carries its type and its nullability.
                            "dialectMysql" => tables.push(format!("ALTER TABLE {} MODIFY COLUMN {} {} {};", q(name), q(column), type_of(kind), null(*nullable))),
                            "dialectSqlserver" => tables.push(format!("ALTER TABLE {} ALTER COLUMN {} {} {};", q(name), q(column), type_of(kind), null(*nullable))),
                            "dialectSqlite" => tables.push(format!(
                                "-- SQLite cannot change a column: rebuild {name} to make {column} {} {} (it is {} {})",
                                type_of(kind),
                                null(*nullable),
                                type_of(other_kind),
                                null(*other_nullable)
                            )),
                            _ => {
                                if retyped {
                                    tables.push(format!("ALTER TABLE {} ALTER COLUMN {} TYPE {};", q(name), q(column), type_of(kind)));
                                }
                                if renulled {
                                    tables.push(format!("ALTER TABLE {} ALTER COLUMN {} {} NOT NULL;", q(name), q(column), if *nullable { "DROP" } else { "SET" }));
                                }
                            }
                        }
                    }
                    if key != other_key {
                        changes.push(json!({"change": "primaryKeyChanged", "table": name, "column": column, "primaryKey": key}));
                    }
                }
            }
        }
        for (column, kind, _, _) in &other.columns {
            if !table.columns.iter().any(|c| &c.0 == column) {
                changes.push(json!({"change": "columnRemoved", "table": name, "column": column, "type": kind}));
                tables.push(format!("ALTER TABLE {} DROP COLUMN {};", q(name), q(column)));
            }
        }
        let added: Vec<&(String, String, String, String)> = table.references.iter().filter(|r| !other.references.iter().any(|o| same(o, r))).collect();
        for reference in &added {
            changes.push(json!({"change": "referenceAdded", "table": name, "column": reference.1, "references": format!("{}.{}", reference.2, reference.3)}));
        }
        for key in foreign_keys(added.iter().copied()) {
            keys_added.push(if sqlite {
                format!("-- SQLite cannot add a foreign key to a table that exists: rebuild {name} with {}", key_clause(&key))
            } else {
                format!("ALTER TABLE {} ADD {};", q(name), key_clause(&key))
            });
        }
        let removed: Vec<&(String, String, String, String)> = other.references.iter().filter(|r| !table.references.iter().any(|t| same(t, r))).collect();
        for reference in &removed {
            changes.push(json!({"change": "referenceRemoved", "table": name, "column": reference.1, "references": format!("{}.{}", reference.2, reference.3)}));
        }
        for (constraint, columns, to_table, _) in foreign_keys(removed.iter().copied()) {
            keys_dropped.push(if sqlite {
                format!("-- SQLite cannot drop a foreign key: rebuild {name} without the one on ({}) to {to_table}", columns.join(", "))
            } else if constraint.is_empty() {
                format!("-- the foreign key of {name} on ({}) to {to_table} has no name to drop it by", columns.join(", "))
            } else if dialect == "dialectMysql" {
                format!("ALTER TABLE {} DROP FOREIGN KEY {};", q(name), q(&constraint))
            } else {
                format!("ALTER TABLE {} DROP CONSTRAINT {};", q(name), q(&constraint))
            });
        }
    }
    for name in right.keys() {
        if !left.contains_key(name) {
            changes.push(json!({"change": "tableRemoved", "table": name}));
            tables_dropped.push(format!("DROP TABLE {};", q(name)));
        }
    }
    let ddl = keys_dropped.into_iter().chain(tables).chain(keys_added).chain(tables_dropped).collect();
    (changes, ddl)
}

async fn schema_diff(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let read = |connection: String, database: String, schema: String| {
        let args = json!({"connectionId": connection, "database": database, "schema": schema});
        async move {
            if args["connectionId"].as_str().unwrap_or_default().trim().is_empty() {
                return Err(NodeError::failed("Choose both database connections"));
            }
            ctx.run.host.app_call("db.schema", args, ctx.cancel.clone()).await.map_err(|error| {
                if error.starts_with(crate::ai_runs::CANCELLED_MARKER) { NodeError::Cancelled } else { NodeError::Failed(error) }
            })
        }
    };
    let a = read(text(&params, "connection"), text(&params, "database"), text(&params, "schema")).await?;
    let b = read(text(&params, "connectionB"), text(&params, "databaseB"), text(&params, "schemaB")).await?;
    let dialect = text(&params, "sqlDialect");
    let (changes, ddl) = diff_schemas(&a, &b, &dialect);
    let same = changes.is_empty();
    match text(&params, "diffOutput").as_str() {
        "diffDdl" => Ok(vec![vec![Item::new(json!({"same": same, "ddl": ddl.join("\n\n"), "statements": ddl.len()}))]]),
        "diffSummary" => {
            let mut counts = std::collections::BTreeMap::new();
            for change in &changes {
                *counts.entry(change["change"].as_str().unwrap_or_default().to_string()).or_insert(0usize) += 1;
            }
            Ok(vec![vec![Item::new(json!({"same": same, "changes": changes.len(), "byKind": counts, "ddl": ddl.join("\n\n")}))]])
        }
        _ => Ok(vec![changes.into_iter().map(Item::new).collect()]),
    }
}

/// A connection's schema as DBML — see `app_ops::schema_dbml`.
async fn dbml(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let connection = text(&params, "connection");
    if connection.trim().is_empty() {
        return Err(NodeError::failed("Choose the database connection"));
    }
    let save_to = text(&params, "saveTo");
    if save_to == "dbmlFile" && text(&params, "path").trim().is_empty() {
        return Err(NodeError::failed("Say where to write the .dbml file"));
    }
    let args = serde_json::json!({
        "connectionId": connection.trim(),
        "database": text(&params, "database").trim(),
        "schema": text(&params, "schema").trim(),
        "saveTo": save_to,
        "title": text(&params, "title").trim(),
        "path": text(&params, "path").trim(),
    });
    let answer = ctx.run.host.app_call("db.dbml", args, ctx.cancel.clone()).await.map_err(|error| {
        if error.starts_with(crate::ai_runs::CANCELLED_MARKER) {
            NodeError::Cancelled
        } else {
            NodeError::Failed(error)
        }
    })?;
    Ok(vec![vec![crate::flows::run::Item::new(answer)]])
}

// ------------------------------------------------------------------------------- binding values

fn literal_for(value: &Value, dialect: SqlDialect) -> Result<String, String> {
    Ok(match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => match dialect {
            SqlDialect::TSql | SqlDialect::Oracle | SqlDialect::Iris => if *b { "1" } else { "0" }.to_string(),
            _ => if *b { "TRUE" } else { "FALSE" }.to_string(),
        },
        Value::Number(n) => n.to_string(),
        Value::String(text) => {
            let quoted = crate::datasource::sqlgen::literal(Some(text), dialect)?;
            if dialect == SqlDialect::TSql { format!("N{quoted}") } else { quoted }
        }
        other => crate::datasource::sqlgen::literal(Some(&other.to_string()), dialect)?,
    })
}

/// `$1…$n` in `sql`, outside strings, quoted identifiers, comments and Postgres dollar-quoted bodies,
/// replaced by `values` as literals.
pub fn bind(sql: &str, values: &[Value], dialect: SqlDialect) -> Result<String, String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    let mut used = vec![false; values.len()];
    while i < chars.len() {
        let c = chars[i];
        // Quoted things are copied whole.
        if c == '\'' || c == '"' || (c == '`' && matches!(dialect, SqlDialect::MySql { .. })) || (c == '[' && dialect == SqlDialect::TSql) {
            let close = if c == '[' { ']' } else { c };
            out.push(c);
            i += 1;
            while i < chars.len() {
                let d = chars[i];
                out.push(d);
                i += 1;
                if d == '\\' && c == '\'' && matches!(dialect, SqlDialect::MySql { backslash_escapes: true }) && i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                    continue;
                }
                if d == close {
                    // A doubled quote is a quote inside, not the end.
                    if i < chars.len() && chars[i] == close && close != ']' {
                        out.push(chars[i]);
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            out.push_str("/*");
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                out.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                out.push_str("*/");
                i += 2;
            }
            continue;
        }
        if c == '$' {
            let digits: String = chars[i + 1..].iter().take_while(|d| d.is_ascii_digit()).collect();
            if !digits.is_empty() {
                let index: usize = digits.parse().map_err(|_| format!("${digits} is not a parameter"))?;
                let value = index
                    .checked_sub(1)
                    .and_then(|slot| values.get(slot))
                    .ok_or_else(|| format!("The query uses ${index} but only {} value(s) were given", values.len()))?;
                used[index - 1] = true;
                out.push_str(&literal_for(value, dialect)?);
                i += 1 + digits.len();
                continue;
            }
            // `$tag$ … $tag$` (Postgres): copied whole.
            if dialect == SqlDialect::Postgres {
                let tag: String = chars[i + 1..].iter().take_while(|d| d.is_alphanumeric() || **d == '_').collect();
                if chars.get(i + 1 + tag.len()) == Some(&'$') {
                    let opener: String = format!("${tag}$");
                    let rest: String = chars[i + opener.chars().count()..].iter().collect();
                    match rest.find(&opener) {
                        Some(end) => {
                            out.push_str(&opener);
                            out.push_str(&rest[..end]);
                            out.push_str(&opener);
                            i += opener.chars().count() * 2 + rest[..end].chars().count();
                            continue;
                        }
                        None => {
                            out.push_str(&opener);
                            out.push_str(&rest);
                            break;
                        }
                    }
                }
            }
        }
        out.push(c);
        i += 1;
    }
    if let Some(unused) = used.iter().position(|u| !u) {
        return Err(format!("Value {} is never used — the query has no ${}", unused + 1, unused + 1));
    }
    Ok(out)
}

// ------------------------------------------------------------------------------------- reading

/// A cell's text as the type its column says: numbers as numbers, booleans as booleans, JSON as
/// JSON — text otherwise.
pub fn typed(cell: Option<&String>, type_name: &str) -> Value {
    let Some(raw) = cell else { return Value::Null };
    let t = type_name.to_ascii_lowercase();
    let numeric = ["int", "serial", "numeric", "decimal", "float", "double", "real", "number", "money"].iter().any(|k| t.contains(k));
    if numeric {
        if let Ok(n) = raw.trim().parse::<i64>() {
            return json!(n);
        }
        // A decimal with more digits than a double holds stays text rather than come back rounded.
        if significant_digits(raw.trim()) <= 15 {
            if let Some(n) = raw.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64) {
                return Value::Number(n);
            }
        }
    }
    if t.contains("bool") || t == "bit" {
        match raw.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "1" => return Value::Bool(true),
            "false" | "f" | "0" => return Value::Bool(false),
            _ => {}
        }
    }
    if t.contains("json") {
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            return value;
        }
    }
    Value::String(raw.clone())
}

/// The digits that carry a decimal's value: no sign, no leading zeros, no trailing zeros after the
/// point, no exponent.
fn significant_digits(raw: &str) -> usize {
    let mantissa = raw.split(['e', 'E']).next().unwrap_or(raw);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_start_matches('0');
    if mantissa.contains('.') { digits.trim_end_matches('0').len() } else { digits.len() }
}

/// A BSON value as plain JSON, the way a flow reads it: an ObjectId is its hex string, a date its
/// RFC 3339 text, a 64-bit integer a number. Extended JSON's `{"$oid": …}` wrappers would make every
/// `$json._id` an object.
fn plain_json(value: mongodb::bson::Bson) -> Value {
    use mongodb::bson::Bson;
    match value {
        Bson::ObjectId(id) => Value::String(id.to_hex()),
        Bson::DateTime(date) => Value::String(date.try_to_rfc3339_string().unwrap_or_else(|_| date.to_string())),
        Bson::Int32(n) => json!(n),
        Bson::Int64(n) => json!(n),
        Bson::Double(n) => serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number),
        Bson::Decimal128(n) => typed(Some(&n.to_string()), "decimal"),
        Bson::Document(document) => Value::Object(document.into_iter().map(|(key, value)| (key, plain_json(value))).collect()),
        Bson::Array(items) => Value::Array(items.into_iter().map(plain_json).collect()),
        other => other.into_relaxed_extjson(),
    }
}

pub(crate) fn rows_of(result: &DbStatementResult) -> Vec<Value> {
    if !result.documents.is_empty() {
        // Documents arrive in the shell's dialect (`ObjectId("…")`), which only Mongo's own reader takes.
        return result
            .documents
            .iter()
            .map(|doc| match crate::datasource::mongo::parse_relaxed_bson(doc) {
                Ok(bson) => plain_json(bson),
                Err(_) => serde_json::from_str(doc).unwrap_or_else(|_| Value::String(doc.clone())),
            })
            .collect();
    }
    result
        .rows
        .iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, column) in result.columns.iter().enumerate() {
                object.insert(column.name.clone(), typed(row.get(index).and_then(Option::as_ref), &column.type_name));
            }
            Value::Object(object)
        })
        .collect()
}

fn engine_matches(type_id: &str, kind: DbKind) -> bool {
    match type_id {
        "data.mongo" => kind == DbKind::Mongodb,
        "data.redis" => kind == DbKind::Redis,
        _ => !matches!(kind, DbKind::Mongodb | DbKind::Redis),
    }
}

async fn query(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let connection = ctx.param_str("connection");
    if connection.trim().is_empty() {
        return Err(NodeError::failed("Pick the database connection"));
    }
    let config = ctx.run.host.db_connection(connection.trim()).map_err(NodeError::Failed)?;
    if !engine_matches(&ctx.node.type_id, config.kind) {
        return Err(NodeError::failed(format!("That is a {} connection — not one this node runs", config.kind.label())));
    }
    let database = Some(ctx.param_str("database")).filter(|d| !d.trim().is_empty());
    let schema = Some(ctx.param_str("schema")).filter(|s| !s.trim().is_empty());
    let tag = format!("flow-{}-{}", ctx.run.run_id, ctx.node.id);
    let session = tokio::select! {
        session = Session::open_tagged(&config, database.as_deref(), &tag) => session.map_err(NodeError::Failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let exec = DbExecContext {
        database: database.clone(),
        schema,
        max_rows: number(&ctx.params, "maxRows").unwrap_or(10_000.0).clamp(0.0, 1_000_000.0) as u32,
    };
    let dialect = crate::datasource::console_dialect(config.kind);
    let once = ctx.param_str("runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let paired = !ctx.items().is_empty();
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let statement = text(params, "queryText");
        if statement.trim().is_empty() {
            return Err(NodeError::failed("Write the query"));
        }
        let values: Vec<Value> = params.get("queryParams").and_then(Value::as_array).cloned().unwrap_or_default();
        let statement = match (dialect, values.is_empty()) {
            (Some(dialect), false) => bind(&statement, &values, dialect).map_err(NodeError::Failed)?,
            (None, false) => return Err(NodeError::failed("Query values ($1, $2…) are for SQL connections")),
            _ => statement,
        };
        let mut result = tokio::select! {
            result = session.execute(&statement, &exec) => result.map_err(NodeError::Failed)?,
            _ = ctx.cancel.cancelled() => {
                session.cancel_running().await;
                return Err(NodeError::Cancelled);
            }
        };
        for statement_result in result.results.iter_mut() {
            let untyped = !statement_result.rows.is_empty() && statement_result.columns.iter().all(|c| c.type_name.is_empty());
            if untyped && statement_result.error.is_none() {
                if let Some(types) = session.column_types(&statement_result.statement).await {
                    if types.len() == statement_result.columns.len() {
                        for (column, type_name) in statement_result.columns.iter_mut().zip(types) {
                            column.type_name = type_name;
                        }
                    }
                }
            }
        }
        for statement_result in &result.results {
            if let Some(error) = &statement_result.error {
                return Err(NodeError::failed(format!("{error}\n— {}", statement_result.statement.chars().take(200).collect::<String>())));
            }
            for message in &statement_result.messages {
                ctx.log(LogStream::Info, message);
            }
            if statement_result.truncated {
                ctx.log(LogStream::Info, &format!("Only the first {} rows were read (Max rows)", exec.max_rows));
            }
            let rows = rows_of(statement_result);
            if rows.is_empty() && statement_result.columns.is_empty() {
                let summary = json!({"rowsAffected": statement_result.rows_affected, "statement": statement_result.statement});
                out.push(if paired { Item::paired(summary, index) } else { Item::new(summary) });
            }
            for row in rows {
                out.push(if paired { Item::paired(row, index) } else { Item::new(row) });
            }
        }
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------ spreadsheet

fn sheet_format(params: &Value, path: &std::path::Path) -> String {
    let chosen = text(params, "fileFormat");
    if chosen != "auto" && !chosen.is_empty() {
        return chosen;
    }
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).as_deref() {
        Some("xlsx" | "xlsm" | "xls" | "ods") => "xlsx".into(),
        Some("tsv") => "tsv".into(),
        _ => "csv".into(),
    }
}

fn cell_value(cell: &calamine::Data) -> Value {
    use calamine::Data;
    match cell {
        Data::Empty => Value::Null,
        Data::String(text) => Value::String(text.clone()),
        Data::Int(n) => json!(n),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                json!(*f as i64)
            } else {
                serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number)
            }
        }
        Data::Bool(b) => Value::Bool(*b),
        Data::DateTime(date) => date.as_datetime().map_or_else(|| json!(date.as_f64()), |dt| json!(dt.format("%Y-%m-%dT%H:%M:%S").to_string())),
        Data::DateTimeIso(text) | Data::DurationIso(text) => Value::String(text.clone()),
        Data::Error(error) => Value::String(format!("#{error:?}")),
    }
}

/// What a workbook may unpack to before it is read. An .xlsx (and .xlsm, .xlsb, .ods) is a zip, and
/// calamine holds the sheet it reads in memory: a few megabytes can declare — or simply inflate to —
/// gigabytes of XML. Generous for real spreadsheets (half a gigabyte of XML is millions of cells).
const WORKBOOK_MAX_PARTS: usize = 10_000;
const WORKBOOK_MAX_PART_BYTES: u64 = 512_000_000;
const WORKBOOK_MAX_UNPACKED_BYTES: u64 = 1_000_000_000;

/// Refuses a zip-based workbook that unpacks past the limits. Measured, not trusted: every part is
/// inflated once into nothing, counting, before calamine opens the file — a declared size can lie.
/// An old binary .xls does not inflate, and is left to calamine.
fn check_workbook(path: &std::path::Path) -> Result<(), String> {
    check_workbook_within(path, WORKBOOK_MAX_PARTS, WORKBOOK_MAX_PART_BYTES, WORKBOOK_MAX_UNPACKED_BYTES)
}

fn check_workbook_within(path: &std::path::Path, max_parts: usize, part_cap: u64, total_cap: u64) -> Result<(), String> {
    use std::io::{Read, Seek};
    let mut file = std::fs::File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).is_err() || &magic != b"PK\x03\x04" {
        return Ok(());
    }
    file.rewind().map_err(|e| e.to_string())?;
    // Not readable as a zip: calamine says why, in its own words.
    let Ok(mut archive) = zip::ZipArchive::new(file) else { return Ok(()) };
    if archive.len() > max_parts {
        return Err(format!("{} holds {} parts, more than a spreadsheet does — it is not read", path.display(), archive.len()));
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut part = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = part.name().to_string();
        let budget = part_cap.min(total_cap - total);
        let inflated = std::io::copy(&mut part.by_ref().take(budget + 1), &mut std::io::sink()).map_err(|e| format!("{name}: {e}"))?;
        if inflated > budget {
            let limit = if budget < part_cap { total_cap } else { part_cap };
            return Err(format!(
                "{} unpacks to more than {} (at {name}) — too big to read as a spreadsheet",
                path.display(),
                crate::containers::engine::human_bytes(limit)
            ));
        }
        total += inflated;
    }
    Ok(())
}

fn read_xlsx(path: &std::path::Path, sheet: &str, header: bool) -> Result<Vec<Value>, String> {
    check_workbook(path)?;
    let mut workbook = calamine::open_workbook_auto(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let name = if sheet.trim().is_empty() {
        workbook.sheet_names().first().cloned().ok_or_else(|| "The workbook has no sheets".to_string())?
    } else {
        sheet.trim().to_string()
    };
    let range = workbook.worksheet_range(&name).map_err(|e| format!("Could not read the sheet “{name}”: {e}"))?;
    let mut rows = range.rows();
    let names: Vec<String> = if header {
        rows.next().map(|row| row.iter().map(|cell| cell_text(Some(&cell_value(cell)))).collect()).unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(rows
        .filter(|row| row.iter().any(|cell| !matches!(cell, calamine::Data::Empty)))
        .map(|row| {
            let mut object = Map::new();
            for (index, cell) in row.iter().enumerate() {
                let key = names.get(index).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| format!("column{}", index + 1));
                object.insert(key, cell_value(cell));
            }
            Value::Object(object)
        })
        .collect())
}

fn write_xlsx(objects: &[&Value], sheet: &str, header: bool) -> Result<Vec<u8>, String> {
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let worksheet = workbook.add_worksheet();
    if !sheet.trim().is_empty() {
        worksheet.set_name(sheet.trim()).map_err(|e| e.to_string())?;
    }
    let columns = columns_of(objects);
    let bold = rust_xlsxwriter::Format::new().set_bold();
    let mut row: u32 = 0;
    if header {
        for (col, name) in columns.iter().enumerate() {
            worksheet.write_string_with_format(0, col as u16, name, &bold).map_err(|e| e.to_string())?;
        }
        row = 1;
    }
    for object in objects {
        for (col, name) in columns.iter().enumerate() {
            let col = col as u16;
            match object.get(name) {
                None | Some(Value::Null) => {}
                Some(Value::Number(n)) => {
                    worksheet.write_number(row, col, n.as_f64().unwrap_or_default()).map_err(|e| e.to_string())?;
                }
                Some(Value::Bool(b)) => {
                    worksheet.write_boolean(row, col, *b).map_err(|e| e.to_string())?;
                }
                Some(other) => {
                    worksheet.write_string(row, col, cell_text(Some(other))).map_err(|e| e.to_string())?;
                }
            }
        }
        row += 1;
    }
    workbook.save_to_buffer().map_err(|e| e.to_string())
}

async fn sheet(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let path = expand(&text(&params, "path"));
    if text(&params, "path").trim().is_empty() || !path.is_absolute() {
        return Err(NodeError::failed("Write the spreadsheet's absolute path"));
    }
    let format = sheet_format(&params, &path);
    let header = flag(&params, "header");
    let sheet_name = text(&params, "sheet");
    let delimiter = if format == "tsv" { '\t' } else { text(&params, "delimiter").chars().next().unwrap_or(',') };
    if text(&params, "operation") == "write" {
        let items = ctx.items();
        let objects: Vec<&Value> = items.iter().map(|item| &item.json).collect();
        let bytes = if format == "xlsx" {
            write_xlsx(&objects, &sheet_name, header).map_err(NodeError::Failed)?
        } else {
            let columns = columns_of(&objects);
            let mut rows = Vec::new();
            if header {
                rows.push(columns.clone());
            }
            for object in &objects {
                rows.push(columns.iter().map(|column| cell_text(object.get(column))).collect());
            }
            write_csv(&rows, delimiter).into_bytes()
        };
        write_whole(&path, &bytes, flag(&params, "createFolders"))?;
        let summary = json!({"file": super::files::describe(&path), "rows": objects.len()});
        return Ok(vec![vec![Item::new(summary)]]);
    }
    let path_for_read = path.clone();
    let rows = if format == "xlsx" {
        tokio::task::spawn_blocking(move || read_xlsx(&path_for_read, &sheet_name, header))
            .await
            .map_err(|e| NodeError::failed(e.to_string()))?
            .map_err(NodeError::Failed)?
    } else {
        let text = tokio::fs::read_to_string(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
        rows_to_objects(parse_csv(&text, delimiter), header)
    };
    let limit = number(&params, "limit").unwrap_or(0.0).max(0.0) as usize;
    let rows = if limit > 0 { rows.into_iter().take(limit).collect() } else { rows };
    Ok(vec![rows.into_iter().map(Item::new).collect()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_bind_as_literals_and_quotes_stay_closed() {
        let postgres = SqlDialect::Postgres;
        let sql = bind(
            "SELECT * FROM t WHERE name = $1 AND n > $2 AND note = '$1 stays' AND ok = $3 -- $9 in a comment",
            &[json!("O'Brien"), json!(5), json!(true)],
            postgres,
        )
        .unwrap();
        assert_eq!(sql, "SELECT * FROM t WHERE name = 'O''Brien' AND n > 5 AND note = '$1 stays' AND ok = TRUE -- $9 in a comment");
        let mysql = bind("INSERT INTO t VALUES ($1)", &[json!("a\\' OR 1=1 -- ")], SqlDialect::MySql { backslash_escapes: true }).unwrap();
        assert_eq!(mysql, "INSERT INTO t VALUES ('a\\\\'' OR 1=1 -- ')");
        let tsql = bind("SELECT [$1], $1", &[json!("ñ")], SqlDialect::TSql).unwrap();
        assert_eq!(tsql, "SELECT [$1], N'ñ'");
        assert_eq!(bind("SELECT $$ a $1 $$, $1", &[json!(null)], postgres).unwrap(), "SELECT $$ a $1 $$, NULL");
        assert!(bind("SELECT $2", &[json!(1)], postgres).is_err());
        assert!(bind("SELECT 1", &[json!(1)], postgres).is_err(), "an unused value is a mistake");
    }

    #[test]
    fn cells_take_their_column_type() {
        assert_eq!(typed(Some(&"42".to_string()), "int4"), json!(42));
        assert_eq!(typed(Some(&"4.5".to_string()), "numeric"), json!(4.5));
        assert_eq!(typed(Some(&"t".to_string()), "bool"), json!(true));
        assert_eq!(typed(Some(&"{\"a\":1}".to_string()), "jsonb"), json!({"a": 1}));
        assert_eq!(typed(Some(&"007".to_string()), "varchar"), json!("007"));
        assert_eq!(typed(None, "int4"), Value::Null);
        // More digits than a double holds: text, not a rounded number.
        assert_eq!(typed(Some(&"12345678901234567890.12".to_string()), "numeric"), json!("12345678901234567890.12"));
        assert_eq!(typed(Some(&"0.000000000000000000125".to_string()), "numeric"), json!(1.25e-19));
        assert_eq!(typed(Some(&"10.50".to_string()), "numeric"), json!(10.5));
    }

    #[test]
    fn mongo_documents_read_as_plain_json() {
        let bson = crate::datasource::mongo::parse_relaxed_bson(
            r#"{"_id": ObjectId("6ac3e5c9f6ba91f4bd56ea53"), "n": NumberLong(5), "at": ISODate("2026-10-05T12:00:00Z"), "tags": ["a"]}"#,
        )
        .unwrap();
        assert_eq!(plain_json(bson), json!({"_id": "6ac3e5c9f6ba91f4bd56ea53", "n": 5, "at": "2026-10-05T12:00:00Z", "tags": ["a"]}));
    }

    #[test]
    fn xlsx_round_trips() {
        let dir = std::env::temp_dir().join(format!("cf-sheet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pedidos.xlsx");
        let rows = [json!({"id": 1, "cliente": "Ana", "pagado": true}), json!({"id": 2, "cliente": "Bruno", "total": 1200.5})];
        let refs: Vec<&Value> = rows.iter().collect();
        std::fs::write(&path, write_xlsx(&refs, "Pedidos", true).unwrap()).unwrap();
        let back = read_xlsx(&path, "", true).unwrap();
        assert_eq!(back[0], json!({"id": 1, "cliente": "Ana", "pagado": true, "total": null}));
        assert_eq!(back[1]["total"], json!(1200.5));
        assert!(read_xlsx(&path, "Nope", true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workbook_that_unpacks_too_far_is_refused_before_it_is_read() {
        use std::io::Write as _;
        let dir = std::env::temp_dir().join(format!("cf-sheet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.xlsx");
        let rows = [json!({"id": 1, "cliente": "Ana"})];
        let refs: Vec<&Value> = rows.iter().collect();
        std::fs::write(&real, write_xlsx(&refs, "", true).unwrap()).unwrap();
        assert_eq!(check_workbook(&real), Ok(()), "a real workbook passes the default limits");
        assert!(check_workbook_within(&real, 10_000, 100, 1_000_000).unwrap_err().contains("too big"), "a part over its own limit");
        assert!(check_workbook_within(&real, 10_000, 1_000_000, 1_000).unwrap_err().contains("too big"), "the whole over its limit");
        assert!(check_workbook_within(&real, 2, 1_000_000, 1_000_000).unwrap_err().contains("parts"));
        // A bomb's shape: a few kilobytes of zip, twenty megabytes of sheet.
        let bomb = dir.join("bomb.xlsx");
        {
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&bomb).unwrap());
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("xl/worksheets/sheet1.xml", options).unwrap();
            let zeros = vec![b'0'; 1 << 20];
            for _ in 0..20 {
                writer.write_all(&zeros).unwrap();
            }
            writer.finish().unwrap();
        }
        assert!(std::fs::metadata(&bomb).unwrap().len() < 1_000_000);
        assert!(check_workbook_within(&bomb, 10_000, 10_000_000, 1_000_000_000).unwrap_err().contains("too big"));
        assert!(read_xlsx(&bomb, "", true).is_err());
        // An old .xls (or anything not a zip) is calamine's to judge.
        let old = dir.join("old.xls");
        std::fs::write(&old, b"not a zip").unwrap();
        assert_eq!(check_workbook(&old), Ok(()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schemas_diff_into_ddl() {
        let a = json!({"tables": [
            {"name": "users", "kind": "Table", "columns": [
                {"name": "id", "data_type": "integer", "nullable": false, "primary_key": true},
                {"name": "email", "data_type": "varchar(200)", "nullable": false, "primary_key": false}
            ]},
            {"name": "orders", "kind": "Table", "columns": [
                {"name": "id", "data_type": "integer", "nullable": false, "primary_key": true},
                {"name": "user_id", "data_type": "integer", "nullable": true, "primary_key": false}
            ]}
        ], "edges": [{"constraint": "orders_user_fk", "from_table": "orders", "from_column": "user_id", "to_table": "users", "to_column": "id", "inferred": false}]});
        let b = json!({"tables": [
            {"name": "users", "kind": "Table", "columns": [
                {"name": "id", "data_type": "integer", "nullable": false, "primary_key": true},
                {"name": "email", "data_type": "varchar(100)", "nullable": true, "primary_key": false},
                {"name": "legacy", "data_type": "text", "nullable": true, "primary_key": false}
            ]}
        ], "edges": []});
        let (changes, ddl) = super::diff_schemas(&a, &b, "dialectPostgres");
        let kinds: Vec<&str> = changes.iter().map(|c| c["change"].as_str().unwrap()).collect();
        assert!(kinds.contains(&"tableAdded") && kinds.contains(&"typeChanged") && kinds.contains(&"nullabilityChanged") && kinds.contains(&"columnRemoved"), "{kinds:?}");
        assert!(ddl.iter().any(|d| d.starts_with("CREATE TABLE \"orders\"")), "{ddl:?}");
        assert!(ddl.iter().any(|d| d == "ALTER TABLE \"users\" ALTER COLUMN \"email\" TYPE varchar(200);"), "{ddl:?}");
        assert!(ddl.iter().any(|d| d == "ALTER TABLE \"users\" DROP COLUMN \"legacy\";"), "{ddl:?}");
        let (same, _) = super::diff_schemas(&a, &a, "dialectMysql");
        assert!(same.is_empty());
    }

    #[test]
    fn schema_ddl_runs_in_order_and_speaks_each_dialect() {
        let column = |name: &str, kind: &str, nullable: bool, key: bool| json!({"name": name, "data_type": kind, "nullable": nullable, "primary_key": key});
        let edge = |constraint: &str, from: &str, column: &str, to: &str, to_column: &str| {
            json!({"constraint": constraint, "from_table": from, "from_column": column, "to_table": to, "to_column": to_column, "inferred": false})
        };
        let a = json!({"tables": [
            {"name": "users", "kind": "Table", "columns": [column("id", "integer", false, true), column("email", "varchar(200)", false, false), column("code", "varchar(10)", false, false), column("manager_id", "integer", true, false)]},
            {"name": "orders", "kind": "Table", "columns": [column("id", "integer", false, true), column("version", "integer", false, true), column("user_id", "integer", true, false)]},
            {"name": "lines", "kind": "Table", "columns": [column("order_id", "integer", false, false), column("order_version", "integer", false, false)]}
        ], "edges": [
            edge("orders_user_fk", "orders", "user_id", "users", "id"),
            edge("lines_order_fk", "lines", "order_id", "orders", "id"),
            edge("lines_order_fk", "lines", "order_version", "orders", "version"),
            edge("users_manager_fk", "users", "manager_id", "users", "id")
        ]});
        let b = json!({"tables": [
            {"name": "users", "kind": "Table", "columns": [column("id", "integer", false, true), column("email", "varchar(100)", true, false), column("legacy", "integer", true, false)]},
            {"name": "audit", "kind": "Table", "columns": [column("id", "integer", false, true)]}
        ], "edges": [edge("users_audit_fk", "users", "legacy", "audit", "id")]});

        // Keys dropped first, then tables and columns, then keys — `lines` points at `orders`, made
        // after it — and the table that goes, last. The two-column key is one statement.
        let (_, ddl) = super::diff_schemas(&a, &b, "dialectPostgres");
        assert_eq!(
            ddl,
            [
                "ALTER TABLE \"users\" DROP CONSTRAINT \"users_audit_fk\";",
                "CREATE TABLE \"lines\" (\n  \"order_id\" integer NOT NULL,\n  \"order_version\" integer NOT NULL\n);",
                "CREATE TABLE \"orders\" (\n  \"id\" integer NOT NULL,\n  \"version\" integer NOT NULL,\n  \"user_id\" integer,\n  PRIMARY KEY (\"id\", \"version\")\n);",
                "ALTER TABLE \"users\" ALTER COLUMN \"email\" TYPE varchar(200);",
                "ALTER TABLE \"users\" ALTER COLUMN \"email\" SET NOT NULL;",
                "ALTER TABLE \"users\" ADD COLUMN \"code\" varchar(10) NOT NULL;",
                "ALTER TABLE \"users\" ADD COLUMN \"manager_id\" integer;",
                "ALTER TABLE \"users\" DROP COLUMN \"legacy\";",
                "ALTER TABLE \"lines\" ADD CONSTRAINT \"lines_order_fk\" FOREIGN KEY (\"order_id\", \"order_version\") REFERENCES \"orders\" (\"id\", \"version\");",
                "ALTER TABLE \"orders\" ADD CONSTRAINT \"orders_user_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\");",
                "ALTER TABLE \"users\" ADD CONSTRAINT \"users_manager_fk\" FOREIGN KEY (\"manager_id\") REFERENCES \"users\" (\"id\");",
                "DROP TABLE \"audit\";",
            ]
        );

        // SQL Server: `ADD` without `COLUMN`, and a changed column restated whole.
        let (_, ddl) = super::diff_schemas(&a, &b, "dialectSqlserver");
        assert!(ddl.contains(&"ALTER TABLE [users] ADD [code] varchar(10) NOT NULL;".to_string()), "{ddl:#?}");
        assert!(ddl.contains(&"ALTER TABLE [users] ALTER COLUMN [email] varchar(200) NOT NULL;".to_string()), "{ddl:#?}");
        assert!(ddl.iter().all(|d| !d.contains("ADD COLUMN")), "{ddl:#?}");

        // MySQL: its own words for a key and for a column.
        let (_, ddl) = super::diff_schemas(&a, &b, "dialectMysql");
        assert_eq!(ddl[0], "ALTER TABLE `users` DROP FOREIGN KEY `users_audit_fk`;");
        assert!(ddl.contains(&"ALTER TABLE `users` MODIFY COLUMN `email` varchar(200) NOT NULL;".to_string()), "{ddl:#?}");

        // SQLite: keys inside CREATE TABLE; what it cannot do, said in a comment and never attempted.
        let (_, ddl) = super::diff_schemas(&a, &b, "dialectSqlite");
        let lines = ddl.iter().find(|d| d.starts_with("CREATE TABLE \"lines\"")).unwrap();
        assert!(lines.contains("  CONSTRAINT \"lines_order_fk\" FOREIGN KEY (\"order_id\", \"order_version\") REFERENCES \"orders\" (\"id\", \"version\")\n);"), "{lines}");
        for statement in ddl.iter().filter(|d| d.starts_with("ALTER TABLE")) {
            assert!(statement.contains(" ADD COLUMN ") || statement.contains(" DROP COLUMN "), "SQLite has no {statement}");
        }
        let comments: Vec<&String> = ddl.iter().filter(|d| d.starts_with("--")).collect();
        assert_eq!(comments.len(), 4, "a key dropped, a column changed, a NOT NULL column added, a key added: {ddl:#?}");
        assert!(ddl.contains(&"ALTER TABLE \"users\" ADD COLUMN \"manager_id\" integer;".to_string()), "a nullable column is added as anywhere else");
    }
}
