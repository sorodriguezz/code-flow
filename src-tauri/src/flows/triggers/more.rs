//! Triggers that look at something again and again, in the manner of `watchers`: a package's newest
//! release in its registry, a service called through a connector, the clipboard, and Microsoft 365
//! (Outlook, OneDrive, an Excel sheet, the calendar).
//!
//! Like the rest, each remembers what it saw in the flow's state and **its first look only seeds**
//! that memory: switching a flow on does not fire for the issues, mails or rows already there.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::watchers::{announced_once, every, fire, memory_get, memory_set, seconds, state_get, state_set, text};
use super::TriggerView;

// ------------------------------------------------------------------------------------------ package

/// Whether `new` is a later version than `old` — by semver when both read as one, else whenever
/// they differ (a registry's "latest" moving at all is the news).
pub fn is_newer(old: &str, new: &str) -> bool {
    let clean = |v: &str| v.trim().trim_start_matches('v').to_string();
    match (semver::Version::parse(&clean(old)), semver::Version::parse(&clean(new))) {
        (Ok(old), Ok(new)) => new > old,
        _ => clean(old) != clean(new),
    }
}

/// «Nueva versión de un paquete».
pub fn package(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let name = text(params, "packageName");
    if name.is_empty() {
        return Err("write the package's name".into());
    }
    let registry = text(params, "registry");
    let prereleases = params.get("includePrereleases").and_then(Value::as_bool).unwrap_or(false);
    let interval = Duration::from_secs(60 * params.get("intervalMin").and_then(Value::as_f64).map(|n| n.max(15.0) as u64).unwrap_or(60));
    let key = format!("package:{node_id}:{registry}:{name}");
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    let fire_view = view.clone();
    every(interval, view, cancel, move || {
        let (app, flow_id, node_id, registry, name, key, view) =
            (app.clone(), flow_id.clone(), node_id.clone(), registry.clone(), name.clone(), key.clone(), fire_view.clone());
        async move {
            let latest = crate::flows::nodes::devtools::registry_latest(&registry, &name, prereleases).await?;
            let version = latest.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
            if version.is_empty() {
                return Err("the registry answered without a version".into());
            }
            let before = state_get(&app, &flow_id, &key).and_then(|v| v.as_str().map(str::to_string));
            state_set(&app, &flow_id, &key, &json!(version));
            if let Some(before) = before {
                if is_newer(&before, &version) {
                    let mut item = latest.clone();
                    item["previous"] = json!(before);
                    fire(&app, &flow_id, &node_id, &view, item);
                }
            }
            Ok(())
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------- connector

/// What identifies an item, and what it looked like — the fields `watchFields` names, or all of it.
fn fingerprint(item: &Value, fields: &[String]) -> String {
    if fields.is_empty() {
        return item.to_string();
    }
    let picked: Map<String, Value> = fields.iter().map(|f| (f.clone(), crate::flows::value::get_path(item, f).cloned().unwrap_or(Value::Null))).collect();
    Value::Object(picked).to_string()
}

fn id_of(item: &Value, field: &str) -> Option<String> {
    match crate::flows::value::get_path(item, field)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

/// How long an id that left the list is still remembered, and how many are kept at most.
const SEEN_DAYS: i64 = 30;
const SEEN_MAX: usize = 5_000;

/// Which items of a look are news: new ids, or (with `changed`) ids whose fingerprint moved.
///
/// `seen` is updated in place: id → `[fingerprint, last listed (unix seconds)]`. An id that drops
/// off the list is kept for a while — a list sorted by «updated» lets an item fall off the page and
/// come back, and forgetting it at once announced it as new each time it did.
pub fn news(items: &[Value], seen: &mut Map<String, Value>, id_field: &str, changed: bool, fields: &[String], now: i64) -> Vec<Value> {
    let mut out = Vec::new();
    for item in items {
        let Some(id) = id_of(item, id_field) else { continue };
        let print = fingerprint(item, fields);
        // The older memory held the fingerprint alone.
        let old = seen.get(&id).and_then(|entry| entry.get(0).and_then(Value::as_str).or_else(|| entry.as_str())).map(str::to_string);
        match old {
            None => out.push(json!({"change": "new", "item": item})),
            Some(old) if changed && old != print => out.push(json!({"change": "changed", "item": item})),
            _ => {}
        }
        seen.insert(id, json!([print, now]));
    }
    let listed_at = |entry: &Value| entry.get(1).and_then(Value::as_i64).unwrap_or(now);
    seen.retain(|_, entry| now - listed_at(entry) <= SEEN_DAYS * 86_400);
    if seen.len() > SEEN_MAX {
        let mut ages: Vec<i64> = seen.values().map(listed_at).collect();
        ages.sort_unstable();
        let cutoff = ages[seen.len() - SEEN_MAX];
        seen.retain(|_, entry| listed_at(entry) >= cutoff);
    }
    out
}

/// What «Cambios en un servicio» may call again and again: an operation that only reads — a GET, or
/// one named for reading (Notion's database query and GraphQL lists go out as POSTs). The node's
/// picker offers only these (`readsOnly` in ParamFields.tsx, the same test); this is the guard behind
/// it, because a spec that names Slack's postMessage here would otherwise post every 30 seconds.
pub fn reads(operation: &crate::flows::connectors::Operation) -> bool {
    let id = operation.id.to_ascii_lowercase();
    operation.method.eq_ignore_ascii_case("GET") || ["list", "search", "query", "get", "history"].iter().any(|prefix| id.starts_with(prefix))
}

/// «Cambios en un servicio»: a connector's list operation, looked at again and again.
pub fn connector(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let call = params.get("call").cloned().unwrap_or(Value::Null);
    let connector_id = call.get("connector").and_then(Value::as_str).unwrap_or_default().to_string();
    let found = crate::flows::connectors::find(&connector_id).ok_or("pick the service")?;
    let operation_id = call.get("operation").and_then(Value::as_str).unwrap_or_default();
    match found.operation(operation_id) {
        None => return Err("pick what to look at".into()),
        Some(operation) if !reads(operation) => return Err(format!("“{operation_id}” changes things in {} — pick an operation that reads a list", found.name)),
        Some(_) => {}
    }
    let credential_id = text(params, "credential");
    if found.auth != "none" && !found.auth_optional && credential_id.is_empty() {
        return Err(format!("pick the credential for {}", found.name));
    }
    let id_field = { let f = text(params, "idField"); if f.is_empty() { "id".to_string() } else { f } };
    let changed = text(params, "changeMode") == "newOrChanged";
    let fields: Vec<String> = params.get("watchFields").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    let interval = seconds(params, "intervalSec", 30, 120);
    let key = format!("connector:{node_id}:seen");
    // What the memory is a memory of: another operation, channel or fingerprint starts it afresh.
    let watched = json!({"call": call, "idField": id_field, "fields": fields});
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    let fire_view = view.clone();
    every(interval, view, cancel, move || {
        let (app, flow_id, node_id, call, credential_id, id_field, fields, key, view, watched) = (
            app.clone(),
            flow_id.clone(),
            node_id.clone(),
            call.clone(),
            credential_id.clone(),
            id_field.clone(),
            fields.clone(),
            key.clone(),
            fire_view.clone(),
            watched.clone(),
        );
        async move {
            let credential = if credential_id.is_empty() {
                None
            } else {
                let (row, secret) = super::credential_row(&app, &flow_id, &credential_id, &["bearer", "basic", "webhook", "oauth2", "header", "query"])?;
                if row.kind == "oauth2" {
                    let token = crate::flows::oauth::access_token(&credential_id, &row.meta).await?;
                    Some(crate::flows::engine::Credential { kind: "bearer".into(), meta: row.meta, secret: token })
                } else {
                    Some(crate::flows::engine::Credential { kind: row.kind, meta: row.meta, secret })
                }
            };
            let items = crate::flows::nodes::connector::call_outside(&call, credential).await?;
            let stored = memory_get(&app, &flow_id, &key, &watched);
            let first = stored.is_none();
            let mut seen = stored.and_then(|v| v.as_object().cloned()).unwrap_or_default();
            let fresh = news(&items, &mut seen, &id_field, changed, &fields, chrono::Utc::now().timestamp());
            memory_set(&app, &flow_id, &key, &watched, &Value::Object(seen));
            if !first {
                for change in fresh {
                    let mut item = change["item"].clone();
                    if let Some(map) = item.as_object_mut() {
                        map.insert("_change".into(), change["change"].clone());
                    }
                    fire(&app, &flow_id, &node_id, &view, item);
                }
            }
            Ok(())
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------- clipboard

/// What is on the clipboard as text, or `None` when it holds none (or cannot be read).
fn read_clipboard() -> Option<String> {
    let candidates: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("pbpaste", &[])]
    } else if cfg!(windows) {
        &[("powershell", &["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])]
    } else {
        &[("wl-paste", &["--no-newline"]), ("xclip", &["-selection", "clipboard", "-o"]), ("xsel", &["--clipboard", "--output"])]
    };
    for (program, args) in candidates {
        let mut command = crate::proc::std_command(program);
        command.args(*args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if let Ok(output) = command.output() {
            if output.status.success() {
                return Some(String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string());
            }
        }
    }
    None
}

/// Windows says when the clipboard changed without anyone reading it.
#[cfg(windows)]
fn clipboard_generation() -> Option<u32> {
    // SAFETY: takes nothing; a counter the system bumps on every change.
    Some(unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() })
}

#[cfg(not(windows))]
fn clipboard_generation() -> Option<u32> {
    None
}

/// What kind of thing a copied text is.
pub fn clip_kind(text: &str) -> &'static str {
    let trimmed = text.trim();
    if url::Url::parse(trimmed).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "ftp" | "mailto")) && !trimmed.contains(char::is_whitespace) {
        return "url";
    }
    if (trimmed.starts_with('{') || trimmed.starts_with('[')) && serde_json::from_str::<Value>(trimmed).is_ok() {
        return "json";
    }
    let looks_path = !trimmed.contains('\n')
        && (trimmed.starts_with('/') || trimmed.starts_with("~/") || trimmed.get(1..3) == Some(":\\") || trimmed.starts_with("\\\\"));
    if looks_path && std::path::Path::new(&crate::flows::nodes::expand_path(trimmed)).exists() {
        return "path";
    }
    "text"
}

/// Whether a copied text is one this trigger wants. Something that reads as a secret never is: a
/// password manager's copy must not start a flow.
pub fn clip_wanted(text: &str, params: &Value, matcher: &super::infra::Matcher) -> Option<Value> {
    let min = params.get("minLength").and_then(Value::as_f64).unwrap_or(1.0).max(1.0) as usize;
    if text.trim().chars().count() < min {
        return None;
    }
    let kind = clip_kind(text);
    let wanted = match super::watchers::text(params, "clipKind").as_str() {
        "clipUrl" => kind == "url",
        "clipJson" => kind == "json",
        "clipPath" => kind == "path",
        _ => true,
    };
    if !wanted {
        return None;
    }
    let groups = matcher.check(text)?;
    if let Ok(detectors) = crate::flows::nodes::redact::detectors(&["secret".to_string()], &[]) {
        let mut found = std::collections::BTreeMap::new();
        crate::flows::nodes::redact::redact_text(text, &detectors, crate::flows::nodes::redact::Mode::Placeholder, "", &mut found);
        if !found.is_empty() {
            return None;
        }
    }
    let mut item = json!({"text": text, "kind": kind, "length": text.chars().count(), "groups": groups, "at": chrono::Utc::now().to_rfc3339()});
    if kind == "json" {
        item["json"] = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
    }
    Some(item)
}

/// «Al copiar algo».
pub fn clipboard(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let matcher = super::infra::Matcher::of(params)?;
    let (app, flow_id, node_id, params) = (app.clone(), flow_id.to_string(), node_id.to_string(), params.clone());
    tauri::async_runtime::spawn(async move {
        // What was there when the flow was switched on is not something copied for it.
        let mut last = tokio::task::spawn_blocking(read_clipboard).await.ok().flatten();
        let mut generation = clipboard_generation();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(1_500)) => {}
                _ = cancel.cancelled() => return,
            }
            if let Some(now) = clipboard_generation() {
                if Some(now) == generation {
                    continue;
                }
                generation = Some(now);
            }
            let Some(current) = tokio::task::spawn_blocking(read_clipboard).await.ok().flatten() else { continue };
            if Some(&current) == last.as_ref() {
                continue;
            }
            last = Some(current.clone());
            if let Some(item) = clip_wanted(&current, &params, &matcher) {
                fire(&app, &flow_id, &node_id, &view, item);
            }
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------- Microsoft

const GRAPH: &str = "https://graph.microsoft.com/v1.0";

fn encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// A OneDrive path as Graph addresses it: `root:/a/b:` — the root itself when empty.
fn drive_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() {
        "root".into()
    } else {
        format!("root:/{}:", trimmed.split('/').map(|part| encode(part).replace('+', "%20")).collect::<Vec<_>>().join("/"))
    }
}

/// «Microsoft 365»: a new mail, a new file, a new row of an Excel sheet, a meeting about to start.
pub fn microsoft(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let credential = text(params, "credential");
    if credential.is_empty() {
        return Err("choose the Microsoft sign-in".into());
    }
    let event = text(params, "msEvent");
    if event == "excelNewRow" && text(params, "workbook").is_empty() {
        return Err("write the workbook's path in OneDrive".into());
    }
    let interval = seconds(params, "intervalSec", 60, 120);
    let (app, flow_id, node_id, params) = (app.clone(), flow_id.to_string(), node_id.to_string(), params.clone());
    let fire_view = view.clone();
    every(interval, view, cancel, move || {
        let (app, flow_id, node_id, params, credential, event, view) =
            (app.clone(), flow_id.clone(), node_id.clone(), params.clone(), credential.clone(), event.clone(), fire_view.clone());
        async move {
            let (row, _) = super::credential_row(&app, &flow_id, &credential, &["oauth2"])?;
            let token = crate::flows::oauth::access_token(&credential, &row.meta).await?;
            let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
            let get = |url: String| {
                let (http, token) = (http.clone(), token.clone());
                async move {
                    let response = http
                        .get(&url)
                        .bearer_auth(&token)
                        .header("Prefer", "outlook.timezone=\"UTC\"")
                        .send()
                        .await
                        .map_err(|e| e.to_string())?;
                    let status = response.status();
                    let body: Value = response.json().await.unwrap_or(Value::Null);
                    if !status.is_success() {
                        return Err(format!("Microsoft answered {}: {}", status.as_u16(), body.pointer("/error/message").and_then(Value::as_str).unwrap_or("")));
                    }
                    Ok::<Value, String>(body)
                }
            };
            let seen_key = format!("microsoft:{node_id}:seen");
            match event.as_str() {
                "outlookNew" | "onedriveNew" => {
                    let url = if event == "outlookNew" {
                        let folder = { let f = text(&params, "outlookFolder"); if f.is_empty() { "inbox".to_string() } else { f } };
                        let mut url = format!(
                            "{GRAPH}/me/mailFolders/{}/messages?$top=25&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,webLink,isRead,hasAttachments,conversationId",
                            encode(&folder)
                        );
                        let query = text(&params, "outlookQuery");
                        if query.is_empty() {
                            url.push_str("&$orderby=receivedDateTime%20desc");
                            if params.get("unreadOnly").and_then(Value::as_bool).unwrap_or(true) {
                                // Graph refuses a filter on a property the sort does not lead with
                                // (InefficientFilter): the sort's property comes first, always true.
                                url.push_str("&$filter=receivedDateTime%20ge%201900-01-01T00:00:00Z%20and%20isRead%20eq%20false");
                            }
                        } else {
                            // `$search` takes no `$orderby`; Graph sorts it by relevance and date itself.
                            url.push_str(&format!("&$search=%22{}%22", encode(&query.replace('"', ""))));
                        }
                        url
                    } else {
                        format!(
                            "{GRAPH}/me/drive/{}/children?$top=200&$select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,folder,parentReference",
                            drive_path(&text(&params, "onedriveFolder"))
                        )
                    };
                    let body = get(url).await?;
                    let entries = body.get("value").and_then(Value::as_array).cloned().unwrap_or_default();
                    let watched = json!({
                        "event": event,
                        "outlookFolder": text(&params, "outlookFolder"),
                        "outlookQuery": text(&params, "outlookQuery"),
                        "unreadOnly": params.get("unreadOnly"),
                        "onedriveFolder": text(&params, "onedriveFolder"),
                    });
                    let stored = memory_get(&app, &flow_id, &seen_key, &watched);
                    let first = stored.is_none();
                    let mut seen: Vec<String> = stored.and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
                    let known: HashSet<String> = seen.iter().cloned().collect();
                    for entry in entries.iter().rev() {
                        let id = entry.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                        if id.is_empty() || known.contains(&id) || (event == "onedriveNew" && entry.get("folder").is_some()) {
                            continue;
                        }
                        seen.push(id);
                        if !first {
                            fire(&app, &flow_id, &node_id, &view, entry.clone());
                        }
                    }
                    if seen.len() > 2_000 {
                        let cut = seen.len() - 2_000;
                        seen.drain(..cut);
                    }
                    memory_set(&app, &flow_id, &seen_key, &watched, &json!(seen));
                }
                "excelNewRow" => {
                    let sheet = { let s = text(&params, "worksheet"); if s.is_empty() { "Hoja1".to_string() } else { s } };
                    let url = format!(
                        "{GRAPH}/me/drive/{}/workbook/worksheets('{}')/usedRange(valuesOnly=true)?$select=values,rowCount",
                        drive_path(&text(&params, "workbook")),
                        encode(&sheet.replace('\'', "''")).replace('+', "%20")
                    );
                    let body = get(url).await?;
                    let rows: Vec<Vec<Value>> = body.get("values").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|r| r.as_array().cloned().unwrap_or_default()).collect();
                    let key = format!("microsoft:{node_id}:rows");
                    let watched = json!({"workbook": text(&params, "workbook"), "worksheet": sheet});
                    let before = memory_get(&app, &flow_id, &key, &watched).and_then(|v| v.as_i64());
                    memory_set(&app, &flow_id, &key, &watched, &json!(rows.len()));
                    let Some(before) = before else { return Ok(()) };
                    let header: Vec<String> = rows.first().map(|h| h.iter().map(|c| c.as_str().map(str::to_string).unwrap_or_else(|| c.to_string())).collect()).unwrap_or_default();
                    for (index, row) in rows.iter().enumerate().skip(before.max(1) as usize) {
                        let mut item = Map::new();
                        for (column, cell) in row.iter().enumerate() {
                            let name = header.get(column).filter(|h| !h.is_empty()).cloned().unwrap_or_else(|| format!("col{}", column + 1));
                            item.insert(name, cell.clone());
                        }
                        item.insert("rowNumber".into(), json!(index + 1));
                        fire(&app, &flow_id, &node_id, &view, Value::Object(item));
                    }
                }
                _ => {
                    let lead = params.get("leadMinutes").and_then(Value::as_f64).unwrap_or(10.0).clamp(1.0, 24.0 * 60.0);
                    let now = chrono::Utc::now();
                    let until = now + chrono::Duration::minutes(lead as i64);
                    let calendar = text(&params, "calendarId");
                    let base = if calendar.is_empty() { format!("{GRAPH}/me/calendarView") } else { format!("{GRAPH}/me/calendars/{}/calendarView", encode(&calendar)) };
                    let body = get(format!(
                        "{base}?startDateTime={}&endDateTime={}&$select=id,subject,start,end,location,onlineMeeting,webLink,attendees,organizer",
                        encode(&now.to_rfc3339()),
                        encode(&until.to_rfc3339())
                    ))
                    .await?;
                    for meeting in body.get("value").and_then(Value::as_array).cloned().unwrap_or_default() {
                        let start = meeting.pointer("/start/dateTime").and_then(Value::as_str).unwrap_or_default().to_string();
                        let begins = chrono::NaiveDateTime::parse_from_str(start.split('.').next().unwrap_or_default(), "%Y-%m-%dT%H:%M:%S").ok().map(|t| t.and_utc());
                        if start.is_empty() || begins.is_some_and(|b| b < now) {
                            continue;
                        }
                        let id = format!("{}|{start}", meeting.get("id").and_then(Value::as_str).unwrap_or_default());
                        if begins.is_some_and(|b| announced_once(&app, &flow_id, &format!("microsoft:{node_id}:announced"), &json!({"calendar": calendar}), &id, b)) {
                            fire(&app, &flow_id, &node_id, &view, json!({
                                "id": meeting.get("id"),
                                "subject": meeting.get("subject"),
                                "start": begins.map(|b| b.to_rfc3339()).unwrap_or(start),
                                "end": meeting.pointer("/end/dateTime"),
                                "location": meeting.pointer("/location/displayName"),
                                "joinUrl": meeting.pointer("/onlineMeeting/joinUrl"),
                                "organizer": meeting.pointer("/organizer/emailAddress"),
                                "attendees": meeting.get("attendees"),
                                "link": meeting.get("webLink"),
                            }));
                        }
                    }
                }
            }
            Ok(())
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_move_forward() {
        assert!(is_newer("1.9.0", "1.10.0"));
        assert!(!is_newer("2.0.0", "1.10.0"));
        assert!(is_newer("v2.0.0-rc.1", "2.0.0"));
        assert!(is_newer("2024.1", "2024.2"), "not semver: any change");
        assert!(!is_newer("1.0.0", "1.0.0"));
    }

    #[test]
    fn a_look_finds_new_and_changed_items() {
        let mut seen = Map::new();
        let now = 1_000_000_000;
        let first = vec![json!({"id": 1, "state": "open"}), json!({"id": 2, "state": "open"})];
        assert_eq!(news(&first, &mut seen, "id", true, &["state".into()], now).len(), 2);
        let second = vec![json!({"id": 1, "state": "closed", "updated": "x"}), json!({"id": 2, "state": "open", "updated": "y"}), json!({"id": 3})];
        let found = news(&second, &mut seen, "id", true, &["state".into()], now);
        let changes: Vec<(&str, i64)> = found.iter().map(|c| (c["change"].as_str().unwrap(), c["item"]["id"].as_i64().unwrap())).collect();
        assert_eq!(changes, vec![("changed", 1), ("new", 3)], "only the watched field counts as a change");
        assert!(news(&second, &mut seen, "id", false, &[], now).is_empty());
        // An item that falls off the page and comes back a day later is not news…
        assert!(news(&[json!({"id": 3})], &mut seen, "id", false, &[], now).is_empty());
        assert!(news(&second, &mut seen, "id", false, &[], now + 86_400).is_empty());
        // …but one gone for longer than the memory lasts is.
        assert_eq!(news(&[json!({"id": 9})], &mut seen, "id", false, &[], now).len(), 1);
        assert_eq!(news(&[json!({"id": 9})], &mut seen, "id", false, &[], now + 40 * 86_400).len(), 0, "9 was just listed");
        assert_eq!(news(&[json!({"id": 1})], &mut seen, "id", false, &[], now + 40 * 86_400).len(), 1, "1 was forgotten");
        // The older memory (a bare fingerprint) still reads.
        let mut old = Map::new();
        old.insert("5".into(), json!("{\"id\":5}"));
        assert!(news(&[json!({"id": 5})], &mut old, "id", true, &[], now).is_empty());
    }

    #[test]
    fn copies_are_sorted_and_secrets_never_fire() {
        assert_eq!(clip_kind("https://example.com/a?b=1"), "url");
        assert_eq!(clip_kind("{\"a\": 1}"), "json");
        assert_eq!(clip_kind("hola mundo"), "text");
        let any = super::super::infra::Matcher::of(&json!({"pattern": ""})).unwrap();
        let params = json!({"clipKind": "clipAny", "minLength": 3});
        assert!(clip_wanted("ab", &params, &any).is_none(), "too short");
        assert!(clip_wanted("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", &params, &any).is_none(), "a token is not news");
        let ticket = super::super::infra::Matcher::of(&json!({"pattern": "[A-Z]+-\\d+", "regex": true})).unwrap();
        let item = clip_wanted("Revisar PAY-1234 hoy", &json!({"clipKind": "clipAny"}), &ticket).unwrap();
        assert_eq!(item["kind"], "text");
        assert!(clip_wanted("sin ticket", &json!({"clipKind": "clipAny"}), &ticket).is_none());
        assert!(clip_wanted("https://example.com", &json!({"clipKind": "clipJson"}), &any).is_none());
    }

    #[test]
    fn onedrive_paths_are_addressed_by_graph() {
        assert_eq!(drive_path(""), "root");
        assert_eq!(drive_path("/Documentos/Entrada/"), "root:/Documentos/Entrada:");
        assert_eq!(drive_path("Mis Archivos/Ventas 2026.xlsx"), "root:/Mis%20Archivos/Ventas%202026.xlsx:");
    }
}
