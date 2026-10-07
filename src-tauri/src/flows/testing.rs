//! A flow's tests («Pruebas»): an input to start it with, and what its output must hold.
//!
//! A test runs the flow for real — as a trigger would, so pins do not stand in and nothing is
//! skipped — from the trigger it names (or the flow's first one) with the test's input as that
//! trigger's item, and waits for it to end (ten minutes at most: then the run is stopped). Then it
//! compares the first item of what the run answered with — the main output of the last node to
//! finish, what an Execute flow node receives — with what was expected:
//!
//! * **contains** (the default): every field written in the expectation is there with that value —
//!   nested objects compared the same way, so `{"cliente": {"plan": "pro"}}` ignores the rest;
//! * **equals**: the item is exactly the expectation, no field more or less;
//! * **runs**: only that the run succeeded — for a flow whose checks are its own «Comprobar» nodes.
//!
//! Numbers compare by value either way: `30` and `30.0` are the same answer.
//!
//! An expectation of `{"$error": "texto"}` turns it around: the run must fail, with that text in
//! its error.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long a test's run may take before it is stopped and the test counted as failed.
const TIME_LIMIT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowTest {
    pub id: String,
    pub flow_id: String,
    pub name: String,
    /// The trigger's item — an object, or a list of them.
    pub input: Value,
    /// The trigger it starts from; empty for the flow's first.
    #[serde(default)]
    pub node_id: String,
    pub expected: Value,
    /// `contains` | `equals` | `runs`.
    pub match_mode: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub last_status: String,
    #[serde(default)]
    pub last_detail: String,
    #[serde(default)]
    pub last_run_at: String,
}

fn row_of(row: &rusqlite::Row) -> rusqlite::Result<FlowTest> {
    let input: String = row.get(3)?;
    let expected: String = row.get(5)?;
    Ok(FlowTest {
        id: row.get(0)?,
        flow_id: row.get(1)?,
        name: row.get(2)?,
        input: serde_json::from_str(&input).unwrap_or(Value::Null),
        node_id: row.get(4)?,
        expected: serde_json::from_str(&expected).unwrap_or(Value::Null),
        match_mode: row.get(6)?,
        sort_order: row.get(7)?,
        last_status: row.get(8)?,
        last_detail: row.get(9)?,
        last_run_at: row.get(10)?,
    })
}

const COLUMNS: &str = "id, flow_id, name, input, node_id, expected, match_mode, sort_order, last_status, last_detail, last_run_at";

pub fn list(conn: &Connection, flow_id: &str) -> rusqlite::Result<Vec<FlowTest>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM flow_tests WHERE flow_id = ?1 ORDER BY sort_order, created_at"))?;
    let rows = stmt.query_map([flow_id], row_of)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<FlowTest>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM flow_tests WHERE id = ?1"), [id], row_of).optional()
}

/// Saves a test — a new one when its id is empty.
pub fn save(conn: &Connection, test: &FlowTest) -> Result<FlowTest, String> {
    let name = test.name.trim();
    if name.is_empty() {
        return Err("A test needs a name".into());
    }
    if !matches!(test.match_mode.as_str(), "contains" | "equals" | "runs") {
        return Err("Unknown way to compare".into());
    }
    let now = crate::flows::engine::now_text();
    let input = test.input.to_string();
    let expected = test.expected.to_string();
    let id = if test.id.trim().is_empty() {
        let id = uuid::Uuid::new_v4().to_string();
        let order: i64 = conn
            .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM flow_tests WHERE flow_id = ?1", [&test.flow_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO flow_tests (id, flow_id, name, input, node_id, expected, match_mode, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![id, test.flow_id, name, input, test.node_id, expected, test.match_mode, order, now],
        )
        .map_err(|e| e.to_string())?;
        id
    } else {
        conn.execute(
            "UPDATE flow_tests SET name = ?2, input = ?3, node_id = ?4, expected = ?5, match_mode = ?6, updated_at = ?7 WHERE id = ?1",
            params![test.id, name, input, test.node_id, expected, test.match_mode, now],
        )
        .map_err(|e| e.to_string())?;
        test.id.clone()
    };
    get(conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "The test was not saved".into())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_tests WHERE id = ?1", [id]).map(|_| ())
}

pub fn record(conn: &Connection, id: &str, status: &str, detail: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_tests SET last_status = ?2, last_detail = ?3, last_run_at = ?4 WHERE id = ?1",
        params![id, status, detail, crate::flows::engine::now_text()],
    )
    .map(|_| ())
}

/// Where `actual` differs from `expected` — the first difference, as a path. Read as a subset
/// («contiene») what `actual` has beyond the expectation is fine; `exact` («es igual») counts a field
/// more, or a list's extra entries, as a difference too.
fn first_difference(expected: &Value, actual: &Value, path: &str, exact: bool) -> Option<String> {
    let at = |key: &str| if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
    match (expected, actual) {
        (Value::Object(wanted), Value::Object(got)) => wanted
            .iter()
            .find_map(|(key, value)| match got.get(key) {
                None => Some(format!("{} is missing", at(key))),
                Some(found) => first_difference(value, found, &at(key), exact),
            })
            .or_else(|| {
                if !exact {
                    return None;
                }
                let (key, extra) = got.iter().find(|(key, _)| !wanted.contains_key(*key))?;
                Some(format!("{} is {}, which was not expected", at(key), short(extra)))
            }),
        (Value::Array(wanted), Value::Array(got)) => {
            if wanted.len() > got.len() || (exact && wanted.len() != got.len()) {
                return Some(format!("{} has {} entries, {} expected", if path.is_empty() { "the list" } else { path }, got.len(), wanted.len()));
            }
            wanted.iter().zip(got).enumerate().find_map(|(i, (w, g))| first_difference(w, g, &format!("{path}[{i}]"), exact))
        }
        (Value::Number(a), Value::Number(b)) if same_number(a, b) => None,
        (a, b) if a == b => None,
        (a, b) => Some(format!("{} is {}, {} expected", if path.is_empty() { "the item" } else { path }, short(b), short(a))),
    }
}

/// Numbers are the same answer when they are the same value: `30` and `30.0` are. Whole numbers are
/// compared exactly — an id past 2^53 is not rounded into its neighbour — anything else as `f64`.
fn same_number(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    match (a.as_i64(), b.as_i64(), a.as_u64(), b.as_u64()) {
        (Some(x), Some(y), _, _) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => a.as_f64() == b.as_f64(),
    }
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 80 {
        format!("{}…", text.chars().take(80).collect::<String>())
    } else {
        text
    }
}

/// The verdict on a finished run: `Ok(detail)` passed, `Err(detail)` failed.
pub fn verdict(test: &FlowTest, status: &str, error: &str, output: &[Value]) -> Result<String, String> {
    if let Some(wanted) = test.expected.get("$error").and_then(Value::as_str) {
        return if status == "error" && error.to_lowercase().contains(&wanted.to_lowercase()) {
            Ok(format!("failed as expected: {error}"))
        } else if status == "error" {
            Err(format!("failed, but with “{error}”"))
        } else {
            Err("succeeded, but a failure was expected".into())
        };
    }
    if status != "success" {
        return Err(if error.is_empty() { format!("the run ended as {status}") } else { error.to_string() });
    }
    if test.match_mode == "runs" {
        return Ok(format!("{} items out", output.len()));
    }
    // An IF whose items all went the other way, a filter that kept nothing: the run answered with no
    // item at all — clearer said so than as "the item is null".
    let Some(first) = output.first() else {
        return Err("the last node to finish put out no items".into());
    };
    let exact = test.match_mode == "equals";
    match first_difference(&test.expected, first, "", exact) {
        None if exact => Ok("the output is the expected one".into()),
        None => Ok("the output holds what was expected".into()),
        Some(difference) => Err(difference),
    }
}

/// What a test run came to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOutcome {
    pub id: String,
    pub name: String,
    /// `passed` | `failed`.
    pub status: String,
    pub detail: String,
    pub run_id: Option<String>,
}

/// Runs one test and records its verdict.
pub async fn run(app: &tauri::AppHandle, test: &FlowTest) -> TestOutcome {
    let outcome = |status: &str, detail: String, run_id: Option<String>| TestOutcome { id: test.id.clone(), name: test.name.clone(), status: status.into(), detail, run_id };
    let result = async {
        let parsed = {
            use tauri::Manager;
            let db = app.state::<crate::db::Db>();
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let flow = crate::db::flow_queries::get_flow(&conn, &test.flow_id).map_err(|e| e.to_string())?.ok_or("The flow no longer exists")?;
            super::spec::parse(&flow.spec)?
        };
        let entry = if test.node_id.trim().is_empty() {
            parsed.nodes.iter().find(|n| n.type_id.starts_with("trigger.") && !n.disabled).map(|n| n.id.clone()).ok_or("The flow has no trigger to start from")?
        } else {
            parsed.nodes.iter().find(|n| n.id == test.node_id && !n.disabled).map(|n| n.id.clone()).ok_or("The test's trigger is no longer in the flow")?
        };
        let items: Vec<super::run::Item> = match &test.input {
            Value::Array(list) => list.iter().map(|v| super::run::Item::new(v.clone())).collect(),
            Value::Null => vec![super::run::Item::new(serde_json::json!({}))],
            other => vec![super::run::Item::new(other.clone())],
        };
        let mut request = super::runs::StartRequest::fired(&entry, items, super::runs::RunOrigin::Test);
        request.wait = true;
        let (row, done) = super::runs::start_with(app, &test.flow_id, request).map_err(|e| if e == "untrusted" { "The flow is not trusted yet".to_string() } else { e })?;
        let done = done.ok_or("The run did not start")?;
        let finished = match tokio::time::timeout(TIME_LIMIT, done).await {
            Ok(finished) => finished.map_err(|_| "The run ended without saying how".to_string())?,
            Err(_) => {
                // Stopped, not only given up on: a run stuck at a Wait or on a call that never answers
                // would go on doing real things in the background — one more with every «Run all».
                super::runs::cancel(&row.id);
                return Ok((Err("The run took longer than 10 minutes and was stopped".to_string()), row.id));
            }
        };
        let output: Vec<Value> = finished.last_output.iter().map(|item| item.json.clone()).collect();
        Ok::<(Result<String, String>, String), String>((verdict(test, &finished.status, &finished.error, &output), row.id))
    }
    .await;
    let done = match result {
        Ok((Ok(detail), run_id)) => outcome("passed", detail, Some(run_id)),
        Ok((Err(detail), run_id)) => outcome("failed", detail, Some(run_id)),
        Err(error) => outcome("failed", error, None),
    };
    {
        use tauri::Manager;
        let db = app.state::<crate::db::Db>();
        let locked = db.0.lock();
        if let Ok(conn) = locked {
            let _ = record(&conn, &test.id, &done.status, &done.detail);
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test(expected: Value, mode: &str) -> FlowTest {
        FlowTest {
            id: "t".into(),
            flow_id: "f".into(),
            name: "n".into(),
            input: json!({}),
            node_id: String::new(),
            expected,
            match_mode: mode.into(),
            sort_order: 0,
            last_status: String::new(),
            last_detail: String::new(),
            last_run_at: String::new(),
        }
    }

    #[test]
    fn contains_reads_the_expectation_as_a_subset() {
        let out = [json!({"total": 30.0, "cliente": {"plan": "pro", "id": 7}, "lineas": [1, 2, 3]})];
        assert!(verdict(&test(json!({"total": 30, "cliente": {"plan": "pro"}}), "contains"), "success", "", &out).is_ok());
        let failed = verdict(&test(json!({"cliente": {"plan": "básico"}}), "contains"), "success", "", &out).unwrap_err();
        assert_eq!(failed, "cliente.plan is \"pro\", \"básico\" expected");
        assert!(verdict(&test(json!({"falta": 1}), "contains"), "success", "", &out).unwrap_err().contains("falta is missing"));
        assert!(verdict(&test(json!({"total": 30}), "equals"), "success", "", &out).is_err());
        assert!(verdict(&test(json!({}), "runs"), "success", "", &out).is_ok());
    }

    #[test]
    fn equals_compares_numbers_by_value_and_names_the_first_real_difference() {
        let out = [json!({"total": 30.0, "cliente": {"plan": "pro"}, "lineas": [1, 2]})];
        let exact = |expected: Value| verdict(&test(expected, "equals"), "success", "", &out);
        assert!(exact(json!({"total": 30, "cliente": {"plan": "pro"}, "lineas": [1.0, 2]})).is_ok(), "30 is 30.0, as «contains» reads it");
        assert_eq!(exact(json!({"total": 30, "cliente": {"plan": "pro"}})).unwrap_err(), "lineas is [1,2], which was not expected");
        assert_eq!(exact(json!({"total": 30, "cliente": {}, "lineas": [1, 2]})).unwrap_err(), "cliente.plan is \"pro\", which was not expected");
        assert_eq!(exact(json!({"total": 30, "cliente": {"plan": "pro"}, "lineas": [1]})).unwrap_err(), "lineas has 2 entries, 1 expected");
        assert_eq!(exact(json!({"total": 31, "cliente": {"plan": "pro"}, "lineas": [1, 2]})).unwrap_err(), "total is 30.0, 31 expected");
        // «contains» still reads a longer list as holding the expected one.
        assert!(verdict(&test(json!({"lineas": [1]}), "contains"), "success", "", &out).is_ok());
        // Whole numbers are not rounded into each other on the way through f64.
        let ids = [json!({"id": 9_007_199_254_740_993_i64})];
        assert!(verdict(&test(json!({"id": 9_007_199_254_740_992_i64}), "equals"), "success", "", &ids).is_err());
        assert!(verdict(&test(json!({"id": 9_007_199_254_740_993_i64}), "equals"), "success", "", &ids).is_ok());
    }

    #[test]
    fn a_run_that_answered_with_nothing_says_so() {
        assert_eq!(verdict(&test(json!({"ok": true}), "contains"), "success", "", &[]).unwrap_err(), "the last node to finish put out no items");
        assert_eq!(verdict(&test(json!({}), "equals"), "success", "", &[]).unwrap_err(), "the last node to finish put out no items");
        assert!(verdict(&test(json!({}), "runs"), "success", "", &[]).is_ok());
    }

    #[test]
    fn a_failure_can_be_the_expectation() {
        let t = test(json!({"$error": "sin stock"}), "contains");
        assert!(verdict(&t, "error", "Comprobar: sin stock para SKU-1", &[]).is_ok());
        assert!(verdict(&t, "success", "", &[json!({})]).is_err());
        assert!(verdict(&test(json!({"a": 1}), "contains"), "error", "boom", &[]).unwrap_err().contains("boom"));
    }

    #[test]
    fn tests_are_stored_per_flow() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES ('w1', 'W', 'folder', '#111111', 0, '2026-01-01T00:00:00Z');
             INSERT INTO flows (id, workspace_id, name, spec, created_at, updated_at) VALUES ('f1', 'w1', 'Demo', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
        )
        .unwrap();
        let mut t = test(json!({"ok": true}), "contains");
        t.id = String::new();
        t.flow_id = "f1".into();
        let saved = save(&conn, &t).unwrap();
        assert_eq!(list(&conn, "f1").unwrap().len(), 1);
        record(&conn, &saved.id, "passed", "bien").unwrap();
        assert_eq!(get(&conn, &saved.id).unwrap().unwrap().last_status, "passed");
        delete(&conn, &saved.id).unwrap();
        assert!(list(&conn, "f1").unwrap().is_empty());
    }
}
