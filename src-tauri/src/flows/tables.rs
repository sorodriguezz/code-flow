//! «Tablas»: small tables a workspace's flows keep — rows by key, JSON values, columns in the order
//! they were first written. The node «Tabla de datos» reads and writes them; Flujos shows them as a
//! grid to look at and fix by hand.
//!
//! **In the app's database** (`flow_data_tables`, `flow_data_rows`), so the backup carries them and
//! a workspace deleted takes its tables along. A flow names its table by **name**, never by id: an
//! exported flow finds the same-named table in the workspace it is imported into — and a write
//! creates it when there is none yet, the way a first `INSERT` would wish it could.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value};

/// A table's name: what a flow writes, kept to something that reads as a name.
pub const MAX_NAME: usize = 64;
/// Rows a table may hold — a flow's working set, not a database.
pub const MAX_ROWS: i64 = 100_000;
/// One row's JSON, written.
pub const MAX_ROW_BYTES: usize = 1024 * 1024;
/// The fields `RowView::item` adds to a row's own; never stored as data.
const META_FIELDS: [&str; 3] = ["_key", "_createdAt", "_updatedAt"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub columns: Vec<String>,
    pub rows: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowView {
    pub key: String,
    pub data: Value,
    pub created_at: String,
    pub updated_at: String,
}

impl RowView {
    /// The row as a node's item: its fields, then `_key` and its times.
    pub fn item(&self) -> Value {
        let mut json = match &self.data {
            Value::Object(map) => map.clone(),
            other => {
                let mut map = Map::new();
                map.insert("value".into(), other.clone());
                map
            }
        };
        json.insert("_key".into(), Value::String(self.key.clone()));
        json.insert("_createdAt".into(), Value::String(self.created_at.clone()));
        json.insert("_updatedAt".into(), Value::String(self.updated_at.clone()));
        Value::Object(json)
    }
}

fn now() -> String {
    crate::flows::engine::now_text()
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A table needs a name".into());
    }
    if name.chars().count() > MAX_NAME {
        return Err(format!("A table's name is at most {MAX_NAME} characters"));
    }
    Ok(name.to_string())
}

fn info_of(row: &rusqlite::Row) -> rusqlite::Result<TableInfo> {
    let columns: String = row.get(3)?;
    Ok(TableInfo {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        columns: serde_json::from_str(&columns).unwrap_or_default(),
        rows: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const INFO: &str = "SELECT t.id, t.workspace_id, t.name, t.columns, \
                    (SELECT COUNT(*) FROM flow_data_rows r WHERE r.table_id = t.id), t.created_at, t.updated_at \
                    FROM flow_data_tables t";

pub fn list(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<TableInfo>> {
    let mut stmt = conn.prepare(&format!("{INFO} WHERE t.workspace_id = ?1 ORDER BY t.name COLLATE NOCASE"))?;
    let rows = stmt.query_map([workspace_id], info_of)?;
    rows.collect()
}

pub fn get(conn: &Connection, table_id: &str) -> rusqlite::Result<Option<TableInfo>> {
    conn.query_row(&format!("{INFO} WHERE t.id = ?1"), [table_id], info_of).optional()
}

pub fn by_name(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<Option<TableInfo>> {
    conn.query_row(&format!("{INFO} WHERE t.workspace_id = ?1 AND t.name = ?2"), params![workspace_id, name.trim()], info_of).optional()
}

pub fn create(conn: &Connection, workspace_id: &str, name: &str) -> Result<TableInfo, String> {
    let name = clean_name(name)?;
    if by_name(conn, workspace_id, &name).map_err(|e| e.to_string())?.is_some() {
        return Err(format!("There is already a table called “{name}”"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let at = now();
    conn.execute(
        "INSERT INTO flow_data_tables (id, workspace_id, name, columns, created_at, updated_at) VALUES (?1, ?2, ?3, '[]', ?4, ?4)",
        params![id, workspace_id, name, at],
    )
    .map_err(|e| e.to_string())?;
    get(conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "The table was not created".into())
}

/// The table called `name`, made when there is none.
pub fn ensure(conn: &Connection, workspace_id: &str, name: &str) -> Result<TableInfo, String> {
    match by_name(conn, workspace_id, name).map_err(|e| e.to_string())? {
        Some(table) => Ok(table),
        None => create(conn, workspace_id, name),
    }
}

pub fn rename(conn: &Connection, table_id: &str, name: &str) -> Result<TableInfo, String> {
    let name = clean_name(name)?;
    let table = get(conn, table_id).map_err(|e| e.to_string())?.ok_or("This table no longer exists")?;
    if let Some(other) = by_name(conn, &table.workspace_id, &name).map_err(|e| e.to_string())? {
        if other.id != table.id {
            return Err(format!("There is already a table called “{name}”"));
        }
    }
    conn.execute("UPDATE flow_data_tables SET name = ?2, updated_at = ?3 WHERE id = ?1", params![table_id, name, now()])
        .map_err(|e| e.to_string())?;
    get(conn, table_id).map_err(|e| e.to_string())?.ok_or_else(|| "This table no longer exists".into())
}

pub fn delete(conn: &Connection, table_id: &str) -> rusqlite::Result<()> {
    // The rows go with it (ON DELETE CASCADE) — said here too, for a connection without the pragma.
    conn.execute("DELETE FROM flow_data_rows WHERE table_id = ?1", [table_id])?;
    conn.execute("DELETE FROM flow_data_tables WHERE id = ?1", [table_id])?;
    Ok(())
}

/// Sets the column order a person arranged in the grid; unknown names are dropped, missing ones
/// kept at the end.
pub fn set_columns(conn: &Connection, table_id: &str, order: &[String]) -> Result<(), String> {
    let table = get(conn, table_id).map_err(|e| e.to_string())?.ok_or("This table no longer exists")?;
    let mut columns: Vec<String> = order.iter().filter(|c| table.columns.contains(c)).cloned().collect();
    let rest: Vec<String> = table.columns.iter().filter(|c| !columns.contains(c)).cloned().collect();
    columns.extend(rest);
    write_columns(conn, table_id, &columns).map_err(|e| e.to_string())
}

fn write_columns(conn: &Connection, table_id: &str, columns: &[String]) -> rusqlite::Result<()> {
    let text = serde_json::to_string(columns).unwrap_or_else(|_| "[]".into());
    conn.execute("UPDATE flow_data_tables SET columns = ?2, updated_at = ?3 WHERE id = ?1", params![table_id, text, now()])?;
    Ok(())
}

fn row_of(row: &rusqlite::Row) -> rusqlite::Result<RowView> {
    let data: String = row.get(1)?;
    Ok(RowView { key: row.get(0)?, data: serde_json::from_str(&data).unwrap_or(Value::Null), created_at: row.get(2)?, updated_at: row.get(3)? })
}

pub fn row(conn: &Connection, table_id: &str, key: &str) -> rusqlite::Result<Option<RowView>> {
    conn.query_row(
        "SELECT row_key, data, created_at, updated_at FROM flow_data_rows WHERE table_id = ?1 AND row_key = ?2",
        params![table_id, key],
        row_of,
    )
    .optional()
}

/// Rows in the order they were first written; `search` finds text anywhere in a row.
pub fn rows(conn: &Connection, table_id: &str, offset: i64, limit: i64, search: Option<&str>) -> rusqlite::Result<(Vec<RowView>, i64)> {
    let pattern = search.map(str::trim).filter(|s| !s.is_empty()).map(|s| format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    let filter = if pattern.is_some() { " AND (row_key LIKE ?2 ESCAPE '\\' OR data LIKE ?2 ESCAPE '\\')" } else { "" };
    let total: i64 = match &pattern {
        Some(p) => conn.query_row(&format!("SELECT COUNT(*) FROM flow_data_rows WHERE table_id = ?1{filter}"), params![table_id, p], |r| r.get(0))?,
        None => conn.query_row("SELECT COUNT(*) FROM flow_data_rows WHERE table_id = ?1", [table_id], |r| r.get(0))?,
    };
    let sql = format!(
        "SELECT row_key, data, created_at, updated_at FROM flow_data_rows WHERE table_id = ?1{filter} ORDER BY seq LIMIT {} OFFSET {}",
        limit.clamp(1, 10_000),
        offset.max(0)
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = match &pattern {
        Some(p) => stmt.query_map(params![table_id, p], row_of)?.collect::<rusqlite::Result<Vec<_>>>()?,
        None => stmt.query_map([table_id], row_of)?.collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok((list, total))
}

/// How a write treats a row that is (or is not) there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Write {
    /// A new row; its key must be free.
    Insert,
    /// The row's fields merged with the given ones; made when missing.
    Upsert,
    /// The row's fields merged with the given ones; nothing when it is missing.
    Update,
    /// The row's data replaced whole (the grid's edit); made when missing.
    Replace,
}

/// Writes one row. `None` when an update found no row to change.
pub fn put(conn: &Connection, table_id: &str, key: Option<&str>, data: &Value, how: Write) -> Result<Option<RowView>, String> {
    let mut given = match data {
        Value::Object(map) => map.clone(),
        Value::Null => Map::new(),
        _ => return Err("A row is an object of fields".into()),
    };
    // What `item()` adds on the way out. A row read and written back whole (`{{ $json }}`) would
    // otherwise grow three columns that only ever repeat the row's own key and dates.
    for meta in META_FIELDS {
        given.remove(meta);
    }
    let key = match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => key.to_string(),
        None if how == Write::Insert => uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
        None => return Err("The row's key is empty".into()),
    };
    if key.chars().count() > 512 {
        return Err("A row's key is at most 512 characters".into());
    }
    let existing = row(conn, table_id, &key).map_err(|e| e.to_string())?;
    let merged = match (&existing, how) {
        (Some(_), Write::Insert) => return Err(format!("There is already a row with the key “{key}”")),
        (None, Write::Update) => return Ok(None),
        (Some(old), Write::Upsert | Write::Update) => {
            let mut fields = old.data.as_object().cloned().unwrap_or_default();
            for (name, value) in given {
                fields.insert(name, value);
            }
            fields
        }
        _ => given,
    };
    let text = serde_json::to_string(&Value::Object(merged.clone())).map_err(|e| e.to_string())?;
    if text.len() > MAX_ROW_BYTES {
        return Err(format!("A row is at most {} KB of JSON", MAX_ROW_BYTES / 1024));
    }
    let at = now();
    if existing.is_some() {
        conn.execute(
            "UPDATE flow_data_rows SET data = ?3, updated_at = ?4 WHERE table_id = ?1 AND row_key = ?2",
            params![table_id, key, text, at],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM flow_data_rows WHERE table_id = ?1", [table_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if count >= MAX_ROWS {
            return Err(format!("A table holds at most {MAX_ROWS} rows — clear old ones, or keep this data in a database"));
        }
        let seq: i64 = conn
            .query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM flow_data_rows WHERE table_id = ?1", [table_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO flow_data_rows (table_id, row_key, data, seq, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![table_id, key, text, seq, at],
        )
        .map_err(|e| e.to_string())?;
    }
    // New field names join the columns, in the order they were first seen.
    let table = get(conn, table_id).map_err(|e| e.to_string())?.ok_or("This table no longer exists")?;
    let mut columns = table.columns.clone();
    for name in merged.keys() {
        if !columns.contains(name) {
            columns.push(name.clone());
        }
    }
    if columns != table.columns {
        write_columns(conn, table_id, &columns).map_err(|e| e.to_string())?;
    } else {
        conn.execute("UPDATE flow_data_tables SET updated_at = ?2 WHERE id = ?1", params![table_id, at]).map_err(|e| e.to_string())?;
    }
    row(conn, table_id, &key).map_err(|e| e.to_string())
}

/// Moves a row to a new key, keeping its place in the table and its creation date. The new key must
/// be free. Run it with the write that follows in one transaction (`flows_table_put_row`), so a write
/// refused afterwards leaves the row under its old key rather than nowhere.
pub fn rename_row(conn: &Connection, table_id: &str, from: &str, to: &str) -> Result<(), String> {
    let to = to.trim();
    if to.is_empty() {
        return Err("The row's key is empty".into());
    }
    if to.chars().count() > 512 {
        return Err("A row's key is at most 512 characters".into());
    }
    if row(conn, table_id, to).map_err(|e| e.to_string())?.is_some() {
        return Err(format!("There is already a row with the key “{to}”"));
    }
    let moved = conn
        .execute("UPDATE flow_data_rows SET row_key = ?3 WHERE table_id = ?1 AND row_key = ?2", params![table_id, from, to])
        .map_err(|e| e.to_string())?;
    if moved == 0 {
        return Err("This row no longer exists".into());
    }
    Ok(())
}

pub fn delete_row(conn: &Connection, table_id: &str, key: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM flow_data_rows WHERE table_id = ?1 AND row_key = ?2", params![table_id, key])? > 0)
}

pub fn clear(conn: &Connection, table_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM flow_data_rows WHERE table_id = ?1", [table_id])
}

/// Removes a column: the field goes from every row and from the column list.
pub fn drop_column(conn: &Connection, table_id: &str, column: &str) -> Result<(), String> {
    let table = get(conn, table_id).map_err(|e| e.to_string())?.ok_or("This table no longer exists")?;
    let (all, _) = rows(conn, table_id, 0, 10_000, None).map_err(|e| e.to_string())?;
    let mut offset = 0;
    let mut batch = all;
    loop {
        for row in &batch {
            if let Value::Object(mut fields) = row.data.clone() {
                if fields.remove(column).is_some() {
                    let text = serde_json::to_string(&Value::Object(fields)).map_err(|e| e.to_string())?;
                    conn.execute("UPDATE flow_data_rows SET data = ?3 WHERE table_id = ?1 AND row_key = ?2", params![table_id, row.key, text])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        if batch.len() < 10_000 {
            break;
        }
        offset += 10_000;
        batch = rows(conn, table_id, offset, 10_000, None).map_err(|e| e.to_string())?.0;
    }
    let columns: Vec<String> = table.columns.into_iter().filter(|c| c != column).collect();
    write_columns(conn, table_id, &columns).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('w1'), ('w2');").unwrap();
        crate::db::migrations::add_flow_tables_store(&conn).unwrap();
        conn
    }

    #[test]
    fn tables_are_per_workspace_and_named_once() {
        let conn = db();
        let a = create(&conn, "w1", "Clientes").unwrap();
        assert!(create(&conn, "w1", " Clientes ").is_err());
        create(&conn, "w2", "Clientes").unwrap();
        assert_eq!(list(&conn, "w1").unwrap().len(), 1);
        assert_eq!(ensure(&conn, "w1", "Clientes").unwrap().id, a.id);
        let b = ensure(&conn, "w1", "Pedidos").unwrap();
        assert!(rename(&conn, &b.id, "Clientes").is_err());
        assert_eq!(rename(&conn, &b.id, "Órdenes").unwrap().name, "Órdenes");
    }

    #[test]
    fn writes_insert_merge_update_and_keep_columns_in_order() {
        let conn = db();
        let t = create(&conn, "w1", "Clientes").unwrap();
        let first = put(&conn, &t.id, None, &json!({"nombre": "Ana", "plan": "pro"}), Write::Insert).unwrap().unwrap();
        assert_eq!(first.key.len(), 12);
        assert!(put(&conn, &t.id, Some(&first.key), &json!({}), Write::Insert).is_err(), "a key is not taken twice");
        put(&conn, &t.id, Some("c-2"), &json!({"nombre": "Luis", "correo": "l@example.com"}), Write::Upsert).unwrap();
        let merged = put(&conn, &t.id, Some("c-2"), &json!({"plan": "básico"}), Write::Upsert).unwrap().unwrap();
        assert_eq!(merged.data, json!({"nombre": "Luis", "correo": "l@example.com", "plan": "básico"}));
        assert_eq!(put(&conn, &t.id, Some("nadie"), &json!({"x": 1}), Write::Update).unwrap(), None);
        let replaced = put(&conn, &t.id, Some("c-2"), &json!({"nombre": "Luis P."}), Write::Replace).unwrap().unwrap();
        assert_eq!(replaced.data, json!({"nombre": "Luis P."}));
        let table = get(&conn, &t.id).unwrap().unwrap();
        assert_eq!(table.columns, vec!["nombre", "plan", "correo"]);
        assert_eq!(table.rows, 2);
        let (listed, total) = rows(&conn, &t.id, 0, 50, None).unwrap();
        assert_eq!(total, 2);
        assert_eq!(listed[0].key, first.key, "rows keep the order they were first written");
        let (found, total) = rows(&conn, &t.id, 0, 50, Some("luis")).unwrap();
        assert_eq!((found.len(), total), (1, 1));
        let item = listed[1].item();
        assert_eq!(item["_key"], "c-2");
        assert_eq!(item["nombre"], "Luis P.");
        // Written back whole, the item's own key and dates are not taken for columns.
        let again = put(&conn, &t.id, Some("c-2"), &item, Write::Replace).unwrap().unwrap();
        assert_eq!(again.data, json!({"nombre": "Luis P."}));
    }

    #[test]
    fn a_rename_keeps_the_row_in_place_and_refuses_a_taken_key() {
        let conn = db();
        let t = create(&conn, "w1", "T").unwrap();
        put(&conn, &t.id, Some("a"), &json!({"n": 1}), Write::Insert).unwrap();
        put(&conn, &t.id, Some("b"), &json!({"n": 2}), Write::Insert).unwrap();
        assert!(rename_row(&conn, &t.id, "a", "b").is_err(), "b is taken");
        assert!(rename_row(&conn, &t.id, "zz", "c").is_err(), "nothing to move");
        rename_row(&conn, &t.id, "a", "a2").unwrap();
        let (listed, _) = rows(&conn, &t.id, 0, 50, None).unwrap();
        assert_eq!(listed.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), vec!["a2", "b"]);
        assert_eq!(listed[0].data, json!({"n": 1}));
    }

    #[test]
    fn columns_are_dropped_from_every_row() {
        let conn = db();
        let t = create(&conn, "w1", "T").unwrap();
        put(&conn, &t.id, Some("a"), &json!({"x": 1, "y": 2}), Write::Upsert).unwrap();
        drop_column(&conn, &t.id, "x").unwrap();
        assert_eq!(row(&conn, &t.id, "a").unwrap().unwrap().data, json!({"y": 2}));
        assert_eq!(get(&conn, &t.id).unwrap().unwrap().columns, vec!["y"]);
        assert_eq!(clear(&conn, &t.id).unwrap(), 1);
        delete(&conn, &t.id).unwrap();
        assert!(get(&conn, &t.id).unwrap().is_none());
    }
}
