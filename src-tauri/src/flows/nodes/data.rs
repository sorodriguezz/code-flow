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
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
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

fn rows_of(result: &DbStatementResult) -> Vec<Value> {
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

fn read_xlsx(path: &std::path::Path, sheet: &str, header: bool) -> Result<Vec<Value>, String> {
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
}
