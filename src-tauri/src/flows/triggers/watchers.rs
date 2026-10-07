//! The triggers that watch something outside by looking at it again and again: a feed, a database,
//! a folder on another machine, a Google calendar or sheet — and this computer itself.
//!
//! Each remembers what it saw in the flow's state (`flow_state`), so a restart neither replays what
//! was already handled nor misses what arrived while the app was closed; and each **first look only
//! seeds** that memory: switching a flow on does not run it once for every entry a feed ever had.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use super::TriggerView;
use crate::db::{flow_run_queries, Db};
use crate::flows::run::Item;

pub(super) fn text(params: &Value, name: &str) -> String {
    params.get(name).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

pub(super) fn seconds(params: &Value, name: &str, floor: u64, fallback: u64) -> Duration {
    Duration::from_secs(params.get(name).and_then(Value::as_f64).map(|n| n.max(0.0) as u64).unwrap_or(fallback).max(floor))
}

pub(super) fn state_get(app: &AppHandle, flow_id: &str, key: &str) -> Option<Value> {
    let db = app.state::<Db>();
    let conn = db.0.lock().ok()?;
    flow_run_queries::state_get(&conn, flow_id, key).ok().flatten()
}

pub(super) fn state_set(app: &AppHandle, flow_id: &str, key: &str, value: &Value) {
    let db = app.state::<Db>();
    let conn = db.0.lock();
    if let Ok(conn) = conn {
        let _ = flow_run_queries::state_set(&conn, flow_id, key, value, &crate::flows::engine::now_text());
    }
}

/// A poller's memory, tied to what it watches: the stored value carries a print of the watched
/// parameters, and once the query, the folder or the sheet is edited the old memory no longer
/// applies — the next look is a first look again, seeded and never fired. Kept under the node's id
/// alone, it was read against the new query and fired everything that query listed.
pub(super) fn memory_get(app: &AppHandle, flow_id: &str, key: &str, watched: &Value) -> Option<Value> {
    let stored = state_get(app, flow_id, key)?;
    if stored.get("watch").and_then(Value::as_str) != Some(watch_print(watched).as_str()) {
        return None;
    }
    stored.get("value").cloned()
}

pub(super) fn memory_set(app: &AppHandle, flow_id: &str, key: &str, watched: &Value, value: &Value) {
    state_set(app, flow_id, key, &json!({"watch": watch_print(watched), "value": value}));
}

fn watch_print(watched: &Value) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(watched.to_string().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// The meetings an «about to start» trigger already announced, kept on disk (a save re-arms the
/// trigger, and a memory that lived in the task announced the same meeting again): `id|start` →
/// start, pruned once a meeting is a day past.
pub(super) fn announced_once(app: &AppHandle, flow_id: &str, key: &str, watched: &Value, id: &str, start: chrono::DateTime<chrono::Utc>) -> bool {
    let mut announced = memory_get(app, flow_id, key, watched).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    if announced.contains_key(id) {
        return false;
    }
    let horizon = chrono::Utc::now() - chrono::Duration::days(1);
    announced.retain(|_, at| at.as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).is_some_and(|t| t > horizon));
    announced.insert(id.to_string(), json!(start.to_rfc3339()));
    memory_set(app, flow_id, key, watched, &Value::Object(announced));
    true
}

pub(super) fn fire(app: &AppHandle, flow_id: &str, node_id: &str, view: &Arc<Mutex<TriggerView>>, item: Value) {
    if let Err(error) = super::fire(app, flow_id, node_id, vec![Item::new(item)]) {
        super::note_problem(view, Some(error));
    }
}

/// A loop that looks every `interval` until cancelled, `look` saying what went wrong (if anything).
pub(super) fn every<F, Fut>(interval: Duration, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken, mut look: F)
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send,
{
    tauri::async_runtime::spawn(async move {
        loop {
            match look().await {
                Ok(()) => super::note_problem(&view, None),
                Err(error) => super::note_problem(&view, Some(error)),
            }
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = cancel.cancelled() => return,
            }
        }
    });
}

// ------------------------------------------------------------------------------------------- feed

/// «Nuevo en un feed»: an entry whose id the trigger has not seen. The last 2,000 ids are kept.
pub fn feed(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let url = text(params, "feedUrl");
    if url.is_empty() {
        return Err("write the feed's address".into());
    }
    let interval = Duration::from_secs(60 * params.get("intervalMin").and_then(Value::as_f64).map(|n| n.max(5.0) as u64).unwrap_or(15));
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    let key = format!("feed:{node_id}:seen");
    let fire_view = view.clone();
    every(interval, view, cancel, move || {
        let (app, flow_id, node_id, url, key, view) = (app.clone(), flow_id.clone(), node_id.clone(), url.clone(), key.clone(), fire_view.clone());
        async move {
            let (meta, entries) = crate::flows::nodes::feed::fetch(&url).await?;
            let stored = state_get(&app, &flow_id, &key);
            let first = stored.is_none();
            let mut seen: Vec<String> = stored.and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
            let known: HashSet<String> = seen.iter().cloned().collect();
            // Oldest first, so a burst of new entries runs in the order they were published.
            for entry in entries.iter().rev() {
                let id = entry.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                if id.is_empty() || known.contains(&id) {
                    continue;
                }
                seen.push(id);
                if !first {
                    let mut item = entry.clone();
                    item["feed"] = meta.clone();
                    fire(&app, &flow_id, &node_id, &view, item);
                }
            }
            if seen.len() > 2000 {
                let cut = seen.len() - 2000;
                seen.drain(..cut);
            }
            state_set(&app, &flow_id, &key, &json!(seen));
            Ok(())
        }
    });
    Ok(())
}

// --------------------------------------------------------------------------------------- database

fn db_config(app: &AppHandle, connection_id: &str) -> Result<crate::datasource::DbConnectionConfig, String> {
    let row = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::datasource_queries::get_connection(&conn, connection_id).map_err(|e| e.to_string())?.ok_or("That database connection no longer exists")?
    };
    let mut config: crate::datasource::DbConnectionConfig = serde_json::from_str(&row.spec).map_err(|e| format!("The connection's settings could not be read ({e})"))?;
    config.id = row.id;
    config.kind = serde_json::from_value(Value::String(row.kind.clone())).map_err(|_| format!("`{}` is not a database engine this build knows", row.kind))?;
    config.resolve_password();
    Ok(config)
}

/// «Evento de base de datos»: a Postgres `NOTIFY`, a Redis channel message, or a row with a higher
/// value in an ever-growing column (an id, a `created_at`) than the last one seen.
pub fn database(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let connection = text(params, "connection");
    if connection.is_empty() {
        return Err("pick the database connection".into());
    }
    let event = text(params, "dbEvent");
    let channels: Vec<String> = text(params, "channels").split([',', ' ']).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect();
    if matches!(event.as_str(), "pgNotify" | "redisChannel") && channels.is_empty() {
        return Err("write the channel to listen to".into());
    }
    let (app, flow_id, node_id, params) = (app.clone(), flow_id.to_string(), node_id.to_string(), params.clone());
    if event == "newRow" {
        let table = text(&params, "table");
        let column = text(&params, "watermark");
        if table.is_empty() || column.is_empty() {
            return Err("write the table and the column that only grows".into());
        }
        let interval = seconds(&params, "intervalSec", 10, 30);
        let key = format!("db:{node_id}:watermark");
        let fire_view = view.clone();
        every(interval, view, cancel, move || {
            let (app, flow_id, node_id, connection, table, column, key, view) =
                (app.clone(), flow_id.clone(), node_id.clone(), connection.clone(), table.clone(), column.clone(), key.clone(), fire_view.clone());
            async move { new_rows(&app, &flow_id, &node_id, &connection, &table, &column, &key, &view).await }
        });
        return Ok(());
    }
    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(1);
        loop {
            let started = Instant::now();
            let outcome = match db_config(&app, &connection) {
                Err(error) => Err(error),
                Ok(config) => {
                    super::note_problem(&view, None);
                    let on = {
                        let (app, flow_id, node_id, view) = (app.clone(), flow_id.clone(), node_id.clone(), view.clone());
                        move |channel: String, payload: String| {
                            let body = serde_json::from_str::<Value>(&payload).unwrap_or(Value::String(payload));
                            fire(&app, &flow_id, &node_id, &view, json!({"channel": channel, "payload": body, "at": chrono::Utc::now().to_rfc3339()}));
                        }
                    };
                    if event == "redisChannel" {
                        crate::datasource::redis::subscribe(&config, &channels, on, cancel.clone()).await
                    } else {
                        crate::datasource::postgres::listen(&config, &channels, on, cancel.clone()).await
                    }
                }
            };
            if cancel.is_cancelled() {
                return;
            }
            super::note_problem(&view, Some(outcome.err().unwrap_or_else(|| "The connection was closed — reconnecting".to_string())));
            if started.elapsed() > Duration::from_secs(60) {
                wait = Duration::from_secs(1);
            }
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => return,
            }
            wait = (wait * 2).min(Duration::from_secs(60));
        }
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn new_rows(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    connection: &str,
    table: &str,
    column: &str,
    key: &str,
    view: &Arc<Mutex<TriggerView>>,
) -> Result<(), String> {
    use crate::datasource::{DbExecContext, Session};
    let config = db_config(app, connection)?;
    let dialect = crate::datasource::console_dialect(config.kind).ok_or("Rows that only grow are for SQL connections")?;
    let quote_path = |path: &str| path.split('.').map(|part| crate::datasource::sqlgen::quote_ident(part, dialect)).collect::<Vec<_>>().join(".");
    let (table_sql, column_sql) = (quote_path(table), crate::datasource::sqlgen::quote_ident(column, dialect));
    let session = Session::open_tagged(&config, None, &format!("flow-trigger-{node_id}")).await?;
    let exec = DbExecContext { database: None, schema: None, max_rows: 500 };
    let stored = state_get(app, flow_id, key);
    let rows = |sql: String| {
        let session = &session;
        let exec = &exec;
        async move {
            let result = session.execute(&sql, exec).await?;
            let first = result.results.into_iter().next().ok_or("The query gave nothing back")?;
            if let Some(error) = &first.error {
                return Err(error.clone());
            }
            Ok::<Vec<Value>, String>(crate::flows::nodes::data::rows_of(&first))
        }
    };
    let Some(mark) = stored.filter(|v| !v.is_null()) else {
        // First look: remember where the table is now, run nothing.
        let found = rows(format!("SELECT MAX({column_sql}) AS mark FROM {table_sql}")).await?;
        let mark = found.first().and_then(|row| row.get("mark")).cloned().unwrap_or(Value::Null);
        state_set(app, flow_id, key, &if mark.is_null() { json!(0) } else { mark });
        return Ok(());
    };
    let statement = crate::flows::nodes::data::bind(
        &format!("SELECT * FROM {table_sql} WHERE {column_sql} > $1 ORDER BY {column_sql} ASC"),
        &[mark],
        dialect,
    )?;
    let found = rows(statement).await?;
    let mut last: Option<Value> = None;
    for row in found {
        last = row.get(column).cloned().or(last);
        fire(app, flow_id, node_id, view, row);
    }
    if let Some(last) = last {
        state_set(app, flow_id, key, &last);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------- remote folder

/// «Archivo remoto»: a file that appeared (or changed) in a folder of a Remote host — SFTP, FTP,
/// SMB, S3, Azure. What the folder held is kept between looks, by name with size and date.
pub fn remote_file(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let host_id = text(params, "host");
    if host_id.is_empty() {
        return Err("pick the host".into());
    }
    let folder = text(params, "remotePath");
    let pattern = text(params, "pattern");
    let matcher = if pattern.is_empty() { None } else { Some(globset::Glob::new(&pattern).map_err(|e| format!("{pattern}: {e}"))?.compile_matcher()) };
    let changed_too = params.get("events").and_then(Value::as_array).is_some_and(|list| list.iter().any(|v| v == "modified"));
    let interval = seconds(params, "intervalSec", 30, 60);
    let key = format!("remote:{node_id}:snapshot");
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    let fire_view = view.clone();
    every(interval, view, cancel, move || {
        let (app, flow_id, node_id, host_id, folder, key, view, matcher) =
            (app.clone(), flow_id.clone(), node_id.clone(), host_id.clone(), folder.clone(), key.clone(), fire_view.clone(), matcher.clone());
        async move {
            let row = {
                let db = app.state::<Db>();
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                crate::db::remote_queries::get_host(&conn, &host_id).map_err(|e| e.to_string())?.ok_or("That host no longer exists in Remote")?
            };
            let spec: crate::remotes::RemoteHostSpec = serde_json::from_str(&row.spec).map_err(|e| e.to_string())?;
            let page = crate::remotes::files::ListPage { prefix: String::new(), marker: String::new() };
            let listing = crate::remotes::files::list(&host_id, &spec, &folder, &page).await?;
            let stored = state_get(&app, &flow_id, &key);
            let first = stored.is_none();
            let before: Map<String, Value> = stored.and_then(|v| v.as_object().cloned()).unwrap_or_default();
            let mut now = Map::new();
            for entry in listing.entries.iter().filter(|e| !e.is_dir) {
                if matcher.as_ref().is_some_and(|m| !m.is_match(&entry.name)) {
                    continue;
                }
                let stamp = json!([entry.size, entry.modified]);
                let event = match before.get(&entry.path) {
                    None => Some("created"),
                    Some(old) if changed_too && old != &stamp => Some("modified"),
                    _ => None,
                };
                now.insert(entry.path.clone(), stamp);
                if let (false, Some(event)) = (first, event) {
                    let modified = (entry.modified > 0).then(|| chrono::DateTime::from_timestamp(entry.modified as i64, 0).map(|t| t.to_rfc3339())).flatten();
                    fire(&app, &flow_id, &node_id, &view, json!({"event": event, "name": entry.name, "path": entry.path, "size": entry.size, "modifiedAt": modified, "host": row.name}));
                }
            }
            state_set(&app, &flow_id, &key, &Value::Object(now));
            Ok(())
        }
    });
    Ok(())
}

// ----------------------------------------------------------------------------------------- Google

/// «Evento de Google»: a Calendar event about to start (once per event), or a row added to a sheet
/// (by row count — rows are appended, and a sheet's first row is its header).
pub fn google(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let credential = text(params, "credential");
    if credential.is_empty() {
        return Err("choose the Google sign-in".into());
    }
    let event = text(params, "googleEvent");
    if event == "sheetsNewRow" && text(params, "spreadsheetId").is_empty() {
        return Err("write the spreadsheet's id".into());
    }
    let interval = seconds(params, "intervalSec", 60, 120);
    let (app, flow_id, node_id, params) = (app.clone(), flow_id.to_string(), node_id.to_string(), params.clone());
    let fire_view = view.clone();
    every(interval, view, cancel, move || {
        let (app, flow_id, node_id, params, credential, event, view) =
            (app.clone(), flow_id.clone(), node_id.clone(), params.clone(), credential.clone(), event.clone(), fire_view.clone());
        async move {
            let meta = {
                let db = app.state::<Db>();
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                flow_run_queries::get_credential(&conn, &credential).map_err(|e| e.to_string())?.ok_or("The sign-in no longer exists")?.meta
            };
            let token = crate::flows::oauth::access_token(&credential, &meta).await?;
            let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
            let get = |url: String| {
                let (http, token) = (http.clone(), token.clone());
                async move {
                    let response = http.get(&url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
                    let status = response.status();
                    let body: Value = response.json().await.map_err(|e| e.to_string())?;
                    if !status.is_success() {
                        return Err(format!("Google answered {}: {}", status.as_u16(), body.pointer("/error/message").and_then(Value::as_str).unwrap_or("")));
                    }
                    Ok::<Value, String>(body)
                }
            };
            if event == "sheetsNewRow" {
                // An id, or the sheet's link (…/spreadsheets/d/<id>/edit), as the label allows.
                let given = text(&params, "spreadsheetId");
                let id = given.split("/d/").nth(1).map(|rest| rest.split('/').next().unwrap_or_default().to_string()).unwrap_or(given);
                let range = { let r = text(&params, "sheetRange"); if r.is_empty() { "A:ZZ".to_string() } else { r } };
                let encoded: String = url::form_urlencoded::byte_serialize(range.as_bytes()).collect();
                let body = get(format!("https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{encoded}")).await?;
                let rows: Vec<Vec<Value>> = body.get("values").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|r| r.as_array().cloned().unwrap_or_default()).collect();
                let key = format!("google:{node_id}:rows");
                let watched = json!({"spreadsheet": id, "range": range});
                let count = rows.len() as i64;
                let before = memory_get(&app, &flow_id, &key, &watched).and_then(|v| v.as_i64());
                memory_set(&app, &flow_id, &key, &watched, &json!(count));
                let Some(before) = before else { return Ok(()) };
                let header: Vec<String> = rows.first().map(|h| h.iter().map(|c| c.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default();
                for (index, row) in rows.iter().enumerate().skip(before.max(1) as usize) {
                    let mut item = Map::new();
                    for (column, cell) in row.iter().enumerate() {
                        let name = header.get(column).filter(|h| !h.is_empty()).cloned().unwrap_or_else(|| format!("col{}", column + 1));
                        item.insert(name, cell.clone());
                    }
                    item.insert("rowNumber".into(), json!(index + 1));
                    fire(&app, &flow_id, &node_id, &view, Value::Object(item));
                }
                return Ok(());
            }
            if event == "gmailNew" || event == "driveNew" {
                let encode = |text: &str| url::form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>();
                let entries: Vec<Value> = if event == "gmailNew" {
                    let query = text(&params, "gmailQuery");
                    let mut url = "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25".to_string();
                    if !query.is_empty() {
                        url.push_str(&format!("&q={}", encode(&query)));
                    }
                    get(url).await?.get("messages").and_then(Value::as_array).cloned().unwrap_or_default()
                } else {
                    // A folder by its id or its link (…/folders/<id>).
                    let given = text(&params, "driveFolder");
                    let folder = given.split("/folders/").nth(1).map(|rest| rest.split(['/', '?']).next().unwrap_or_default().to_string()).unwrap_or(given);
                    let mut q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'".to_string();
                    if !folder.is_empty() {
                        q.push_str(&format!(" and '{}' in parents", folder.replace('\'', "")));
                    }
                    let query = text(&params, "driveQuery");
                    if !query.is_empty() {
                        q.push_str(&format!(" and ({query})"));
                    }
                    let url = format!(
                        "https://www.googleapis.com/drive/v3/files?q={}&orderBy=createdTime%20desc&pageSize=50&fields=files(id,name,mimeType,createdTime,modifiedTime,webViewLink,size,owners(displayName,emailAddress))",
                        encode(&q)
                    );
                    get(url).await?.get("files").and_then(Value::as_array).cloned().unwrap_or_default()
                };
                let key = format!("google:{node_id}:seen");
                let watched = json!({
                    "event": event,
                    "gmailQuery": text(&params, "gmailQuery"),
                    "driveFolder": text(&params, "driveFolder"),
                    "driveQuery": text(&params, "driveQuery"),
                });
                let stored = memory_get(&app, &flow_id, &key, &watched);
                let first = stored.is_none();
                let mut seen: Vec<String> = stored.and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
                let known: HashSet<String> = seen.iter().cloned().collect();
                // A message that could not be read is left for the next look — and what was fired
                // before it is still saved, rather than fired again because one read failed.
                let mut problem = None;
                for entry in entries.iter().rev() {
                    let id = entry.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    if id.is_empty() || known.contains(&id) {
                        continue;
                    }
                    seen.push(id.clone());
                    if first {
                        continue;
                    }
                    let item = if event == "gmailNew" {
                        let message = match get(format!(
                            "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date"
                        ))
                        .await
                        {
                            Ok(message) => message,
                            Err(error) => {
                                seen.pop();
                                problem = Some(error);
                                continue;
                            }
                        };
                        let header = |name: &str| {
                            message
                                .pointer("/payload/headers")
                                .and_then(Value::as_array)
                                .and_then(|list| list.iter().find(|h| h.get("name").and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(name))))
                                .and_then(|h| h.get("value").cloned())
                                .unwrap_or(Value::Null)
                        };
                        json!({
                            "id": id,
                            "threadId": message.get("threadId"),
                            "from": header("From"),
                            "to": header("To"),
                            "subject": header("Subject"),
                            "date": header("Date"),
                            "snippet": message.get("snippet"),
                            "labels": message.get("labelIds"),
                            "link": format!("https://mail.google.com/mail/u/0/#all/{id}"),
                        })
                    } else {
                        entry.clone()
                    };
                    fire(&app, &flow_id, &node_id, &view, item);
                }
                if seen.len() > 2000 {
                    let cut = seen.len() - 2000;
                    seen.drain(..cut);
                }
                memory_set(&app, &flow_id, &key, &watched, &json!(seen));
                return problem.map_or(Ok(()), Err);
            }
            let calendar = { let c = text(&params, "calendarId"); if c.is_empty() { "primary".to_string() } else { c } };
            let lead = params.get("leadMinutes").and_then(Value::as_f64).unwrap_or(10.0).clamp(1.0, 24.0 * 60.0);
            let now = chrono::Utc::now();
            let until = now + chrono::Duration::minutes(lead as i64);
            let encoded: String = url::form_urlencoded::byte_serialize(calendar.as_bytes()).collect();
            let body = get(format!(
                "https://www.googleapis.com/calendar/v3/calendars/{encoded}/events?singleEvents=true&orderBy=startTime&timeMin={}&timeMax={}",
                url::form_urlencoded::byte_serialize(now.to_rfc3339().as_bytes()).collect::<String>(),
                url::form_urlencoded::byte_serialize(until.to_rfc3339().as_bytes()).collect::<String>(),
            ))
            .await?;
            for event in body.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
                let start = event.pointer("/start/dateTime").and_then(Value::as_str).unwrap_or_default().to_string();
                let id = format!("{}|{start}", event.get("id").and_then(Value::as_str).unwrap_or_default());
                // An event already under way when the window opened is not "about to start".
                let begins = chrono::DateTime::parse_from_rfc3339(&start).map(|t| t.with_timezone(&chrono::Utc)).ok();
                if start.is_empty() || begins.is_some_and(|b| b < now) {
                    continue;
                }
                if begins.is_some_and(|b| announced_once(&app, &flow_id, &format!("google:{node_id}:announced"), &json!({"calendar": calendar}), &id, b)) {
                    fire(&app, &flow_id, &node_id, &view, json!({
                        "id": event.get("id"),
                        "summary": event.get("summary"),
                        "start": start,
                        "end": event.pointer("/end/dateTime"),
                        "location": event.get("location"),
                        "meetLink": event.get("hangoutLink"),
                        "attendees": event.get("attendees"),
                        "link": event.get("htmlLink"),
                    }));
                }
            }
            Ok(())
        }
    });
    Ok(())
}

// ----------------------------------------------------------------------------------------- system

/// The address this machine reaches the internet from, or `None` offline — read by asking the OS
/// which local address a route out would use (no packet is sent).
fn local_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:53").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

/// «Evento del sistema»: waking from sleep (the wall clock jumped ahead of the monotonic one), a
/// network change, the power cable plugged in or out, the battery falling under a threshold.
pub fn system(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let event = text(params, "systemEvent");
    let below = params.get("batteryBelow").and_then(Value::as_f64).unwrap_or(20.0);
    let disk_path = { let p = text(params, "diskPath"); if p.is_empty() { "/".to_string() } else { p } };
    let disk_below = params.get("diskBelowGb").and_then(Value::as_f64).unwrap_or(10.0).max(0.1);
    let idle_after = params.get("idleMinutes").and_then(Value::as_f64).unwrap_or(10.0).max(1.0) * 60.0;
    let wifi_wanted = text(params, "wifiName");
    if event == "diskLow" && !super::desk::disk_path_ok(&disk_path) {
        return Err(format!("{disk_path} does not exist"));
    }
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    // The desk is read by starting small programs (ioreg, loginctl, networksetup, nmcli…): off the
    // async threads, which a five-second tick of blocking spawns would otherwise keep busy.
    async fn desk<T: Send + 'static>(read: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        tokio::task::spawn_blocking(read).await.ok()
    }
    tauri::async_runtime::spawn(async move {
        let mut last_tick = (Instant::now(), SystemTime::now());
        let mut network = local_address();
        let mut power = crate::power::status();
        // The desk's state when the flow was switched on: a change from it is what fires — a disk
        // or a battery already low then is the state seeded, not news.
        let mut warned = match event.as_str() {
            "diskLow" => {
                let path = disk_path.clone();
                desk(move || super::desk::disk_free_gb(&path)).await.flatten().is_some_and(|free| free < disk_below)
            }
            "batteryLow" => power.as_ref().is_some_and(|now| !now.plugged_in && now.percent <= below),
            _ => false,
        };
        let mut locked = if matches!(event.as_str(), "screenLocked" | "screenUnlocked") { desk(super::desk::screen_locked).await.flatten() } else { None };
        let mut wifi = if event == "wifiChanged" { desk(super::desk::wifi_name).await.and_then(Result::ok).flatten() } else { None };
        // When the person went away, by the wall clock — which keeps counting while the machine sleeps.
        let mut away_from: Option<SystemTime> = None;
        let tick = if matches!(event.as_str(), "screenLocked" | "screenUnlocked" | "userBack") { Duration::from_secs(5) } else { Duration::from_secs(15) };
        loop {
            tokio::select! {
                _ = tokio::time::sleep(tick) => {}
                _ = cancel.cancelled() => return,
            }
            let now = (Instant::now(), SystemTime::now());
            let wall = now.1.duration_since(last_tick.1).unwrap_or_default();
            let mono = now.0.duration_since(last_tick.0);
            last_tick = now;
            let stamp = chrono::Utc::now().to_rfc3339();
            match event.as_str() {
                "diskLow" => match desk({ let path = disk_path.clone(); move || super::desk::disk_free_gb(&path) }).await.flatten() {
                    Some(free) => {
                        super::note_problem(&view, None);
                        if free < disk_below && !warned {
                            warned = true;
                            fire(&app, &flow_id, &node_id, &view, json!({"event": "diskLow", "path": disk_path, "freeGb": (free * 10.0).round() / 10.0, "belowGb": disk_below, "at": stamp}));
                        } else if free > disk_below + 1.0 {
                            warned = false;
                        }
                    }
                    None => super::note_problem(&view, Some(format!("the disk of {disk_path} could not be read"))),
                },
                "screenLocked" | "screenUnlocked" => match desk(super::desk::screen_locked).await.flatten() {
                    Some(current) => {
                        super::note_problem(&view, None);
                        if let Some(before) = locked {
                            if current != before && current == (event == "screenLocked") {
                                fire(&app, &flow_id, &node_id, &view, json!({"event": event, "locked": current, "at": stamp}));
                            }
                        }
                        locked = Some(current);
                    }
                    None => super::note_problem(&view, Some("this system does not say whether the screen is locked".into())),
                },
                "wifiChanged" => match desk(super::desk::wifi_name).await.unwrap_or_else(|| Err("the Wi-Fi network could not be read".into())) {
                    Ok(current) => {
                        super::note_problem(&view, None);
                        if current != wifi {
                            let involved = wifi_wanted.is_empty()
                                || current.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(&wifi_wanted))
                                || wifi.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(&wifi_wanted));
                            if involved {
                                fire(&app, &flow_id, &node_id, &view, json!({"event": "wifiChanged", "network": current, "previous": wifi, "connected": current.is_some(), "at": stamp}));
                            }
                            wifi = current;
                        }
                    }
                    Err(problem) => super::note_problem(&view, Some(problem)),
                },
                "userIdle" | "userBack" => match desk(super::desk::idle_seconds).await.flatten() {
                    Some(idle) => {
                        super::note_problem(&view, None);
                        if idle >= idle_after {
                            if away_from.is_none() {
                                away_from = Some(SystemTime::now() - Duration::from_secs_f64(idle));
                                if event == "userIdle" {
                                    fire(&app, &flow_id, &node_id, &view, json!({"event": "userIdle", "idleSeconds": idle.round(), "at": stamp}));
                                }
                            }
                        } else if idle < 60.0 {
                            if let Some(from) = away_from.take() {
                                if event == "userBack" {
                                    // From the last input before going away to now — not the idle
                                    // threshold, which is all the earlier reading measured.
                                    let seconds = SystemTime::now().duration_since(from).unwrap_or(wall).as_secs_f64() - idle;
                                    fire(&app, &flow_id, &node_id, &view, json!({"event": "userBack", "awaySeconds": seconds.max(0.0).round(), "at": stamp}));
                                }
                            }
                        }
                    }
                    None => super::note_problem(&view, Some("this system does not say how long it has been idle".into())),
                },
                "wake" => {
                    // A sleep stops the monotonic clock and not the wall clock.
                    if wall > mono + Duration::from_secs(60) {
                        fire(&app, &flow_id, &node_id, &view, json!({"event": "wake", "sleptSeconds": (wall - mono).as_secs(), "at": chrono::Utc::now().to_rfc3339()}));
                    }
                }
                "networkChange" => {
                    let current = local_address();
                    if current != network {
                        fire(&app, &flow_id, &node_id, &view, json!({"event": "networkChange", "online": current.is_some(), "address": current, "previous": network}));
                        network = current;
                    }
                }
                _ => {
                    let current = crate::power::status();
                    if let (Some(before), Some(now)) = (&power, &current) {
                        let item = json!({"event": event, "percent": now.percent, "pluggedIn": now.plugged_in, "charging": now.charging, "minutesLeft": now.minutes_left});
                        match event.as_str() {
                            "powerPlugged" if now.plugged_in && !before.plugged_in => fire(&app, &flow_id, &node_id, &view, item),
                            "powerUnplugged" if !now.plugged_in && before.plugged_in => fire(&app, &flow_id, &node_id, &view, item),
                            "batteryLow" => {
                                if !now.plugged_in && now.percent <= below && !warned {
                                    warned = true;
                                    fire(&app, &flow_id, &node_id, &view, item);
                                } else if now.plugged_in || now.percent > below + 5.0 {
                                    warned = false;
                                }
                            }
                            _ => {}
                        }
                    } else if current.is_none() && event != "wake" {
                        super::note_problem(&view, Some("This computer has no battery".into()));
                    }
                    power = current;
                }
            }
        }
    });
    Ok(())
}

/// The flows started from outside — `codeflow --flow <name>` in a terminal, a git hook, Raycast —
/// by the name their «Enlace o terminal» trigger gives. `ask` is whether the window confirms first.
static LINKS: std::sync::LazyLock<Mutex<HashMap<String, (String, String, bool)>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn link_name(params: &Value, fallback: &str) -> String {
    let given = text(params, "linkName");
    let raw = if given.is_empty() { fallback.to_string() } else { given };
    raw.trim().to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect::<String>().trim_matches('-').to_string()
}

pub fn register_link(flow_id: &str, node_id: &str, name: &str, ask: bool) -> Result<(), String> {
    let mut links = LINKS.lock().map_err(|e| e.to_string())?;
    if let Some((other, _, _)) = links.get(name) {
        if other != flow_id {
            return Err(format!("another flow already answers to {name}"));
        }
    }
    links.insert(name.to_string(), (flow_id.to_string(), node_id.to_string(), ask));
    Ok(())
}

pub fn forget_links(flow_id: &str) {
    if let Ok(mut links) = LINKS.lock() {
        links.retain(|_, (flow, _, _)| flow != flow_id);
    }
}

/// Starts the flow a link names, with `input` as its item — or asks the window first.
pub fn open_link(app: &AppHandle, name: &str, input: Value) -> Result<(), String> {
    let wanted = name.trim().to_lowercase();
    let found = LINKS.lock().ok().and_then(|links| links.get(&wanted).cloned());
    let Some((flow_id, node_id, ask)) = found else {
        return Err(format!("no active flow answers to {name}"));
    };
    let item = json!({"source": "link", "name": wanted, "input": input, "at": chrono::Utc::now().to_rfc3339()});
    if ask {
        use tauri::Emitter;
        let _ = app.emit("flows:link-ask", json!({"flowId": flow_id, "nodeId": node_id, "name": wanted, "item": item}));
        return Ok(());
    }
    super::fire(app, &flow_id, &node_id, vec![Item::new(item)]).map(|_| ())
}

/// The window said yes to a link that asked first.
pub fn confirm_link(app: &AppHandle, flow_id: &str, node_id: &str, item: Value) -> Result<(), String> {
    let allowed = LINKS.lock().ok().is_some_and(|links| links.values().any(|(f, n, _)| f == flow_id && n == node_id));
    if !allowed {
        return Err("That flow is no longer active".into());
    }
    super::fire(app, flow_id, node_id, vec![Item::new(item)]).map(|_| ())
}

/// `codeflow --flow <name> [--input <json>]`, from a launch or a second launch: the flow it names.
pub fn handle_args(app: &AppHandle, argv: &[String]) {
    let Some(at) = argv.iter().position(|arg| arg == "--flow") else { return };
    let Some(name) = argv.get(at + 1) else { return };
    let input = argv
        .iter()
        .position(|arg| arg == "--input")
        .and_then(|i| argv.get(i + 1))
        .map(|raw| serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.clone())))
        .unwrap_or(Value::Null);
    if let Err(error) = open_link(app, name, input) {
        crate::applog::warn(&format!("flows: --flow {name}: {error}"));
    }
}
