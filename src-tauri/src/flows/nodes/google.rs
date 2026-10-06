//! The Google node: Gmail, Sheets, Calendar and Drive through the person's own OAuth 2 credential
//! (`flows::oauth`) — one node with a service picker where n8n has four.
//!
//! **Shapes over raw answers.** Each operation hands back what an automation reads — a message's
//! sender, subject and text rather than Gmail's MIME tree, a sheet's rows keyed by their header
//! rather than arrays of cells — and the pure halves of that are plain functions, tested without
//! Google.
//!
//! **Sheets writes go in one call.** Appending or updating rows gathers every item's row first, so a
//! hundred items are one request, not a hundred against a quota of sixty a minute.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use chrono::{DateTime, Duration as Span, FixedOffset, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use reqwest::Method;
use serde_json::{json, Map, Value};

use super::files::expand;
use super::{flag, number, pairs, strings, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

const GMAIL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const SHEETS: &str = "https://sheets.googleapis.com/v4/spreadsheets";
const CALENDAR: &str = "https://www.googleapis.com/calendar/v3/calendars";
const DRIVE: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
/// A file Drive takes in one multipart request; past this, a resumable upload would be needed.
const UPLOAD_LIMIT: u64 = 100 * 1024 * 1024;

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let once = ctx.param_str("runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let google = Google::connect(ctx).await?;
    let service = ctx.param_str("service");
    let items = ctx.items();
    // A row per item, written together.
    if service == "sheets" && matches!(ctx.param_str("sheetsOp").as_str(), "sheetsAppend" | "sheetsUpdate") {
        let rows: Vec<(usize, Value, Map<String, Value>)> = resolved
            .iter()
            .enumerate()
            .map(|(index, params)| (index, params.clone(), row_of(params, items.get(index).map(|item| &item.json))))
            .collect();
        let written = if ctx.param_str("sheetsOp") == "sheetsAppend" { sheets_append(&google, &rows).await? } else { sheets_update(&google, &rows).await? };
        let paired = !items.is_empty();
        return Ok(vec![written.into_iter().map(|(index, json)| if paired { Item::paired(json, index) } else { Item::new(json) }).collect()]);
    }
    let paired = !items.is_empty();
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let answers = match service.as_str() {
            "gmail" => gmail(&google, params).await?,
            "sheets" => sheets_read(&google, params).await?,
            "calendar" => calendar(&google, params).await?,
            "drive" => drive(&google, params).await?,
            other => return Err(NodeError::failed(format!("Unknown Google service {other}"))),
        };
        for json in answers {
            out.push(if paired { Item::paired(json, index) } else { Item::new(json) });
        }
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------- transport

struct Google<'a> {
    ctx: &'a NodeCtx,
    token: String,
    /// The signed-in address, when the credential knows it — Gmail's sender.
    account: String,
    zone: Tz,
    client: reqwest::Client,
}

impl<'a> Google<'a> {
    async fn connect(ctx: &'a NodeCtx) -> Result<Google<'a>, NodeError> {
        let id = ctx.param_str("credential");
        if id.trim().is_empty() {
            return Err(NodeError::failed("Pick the Google credential (an OAuth 2 one, connected)"));
        }
        let credential = ctx.credential(id.trim()).await?;
        if credential.meta.get("provider").and_then(Value::as_str) != Some("google") {
            return Err(NodeError::failed("The credential is not a Google OAuth 2 one"));
        }
        let account = credential.meta.get("account").and_then(Value::as_str).unwrap_or_default().to_string();
        let zone = crate::flows::schedule::zone_of(&json!({}), ctx.run.timezone.as_deref()).unwrap_or(chrono_tz::UTC);
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|e| NodeError::failed(e.to_string()))?;
        Ok(Google { ctx, token: credential.secret, account, zone, client })
    }

    async fn send(&self, what: &str, request: reqwest::RequestBuilder) -> Result<reqwest::Response, NodeError> {
        let started = std::time::Instant::now();
        let response = tokio::select! {
            response = request.bearer_auth(&self.token).send() => response.map_err(|e| NodeError::failed(format!("Google could not be reached: {e}")))?,
            _ = self.ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        let status = response.status();
        self.ctx.log(LogStream::Info, &format!("{what} → {} ({} ms)", status.as_u16(), started.elapsed().as_millis()));
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        Err(NodeError::failed(format!("Google answered {}: {}", status.as_u16(), crate::oauth::describe(status, &body))))
    }

    async fn json(&self, what: &str, method: Method, url: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, NodeError> {
        let mut request = self.client.request(method, url).query(query);
        if let Some(body) = body {
            request = request.json(body);
        }
        let text = self.send(what, request).await?.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| NodeError::failed(format!("Google did not answer JSON: {}", text.chars().take(200).collect::<String>())))
    }

    async fn bytes(&self, what: &str, url: &str, query: &[(&str, String)]) -> Result<Vec<u8>, NodeError> {
        let response = self.send(what, self.client.get(url).query(query)).await?;
        Ok(response.bytes().await.map_err(|e| NodeError::failed(e.to_string()))?.to_vec())
    }
}

/// An id where a person may paste the whole link: `/d/<id>/` (Sheets, Docs, Drive files),
/// `?id=<id>` (older Drive links), or the id itself.
pub fn doc_id(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(rest) = raw.split("/d/").nth(1) {
        return rest.split(['/', '?', '#']).next().unwrap_or_default().to_string();
    }
    if let Some(rest) = raw.split("/folders/").nth(1) {
        return rest.split(['/', '?', '#']).next().unwrap_or_default().to_string();
    }
    if let Ok(url) = url::Url::parse(raw) {
        if let Some((_, id)) = url.query_pairs().find(|(key, _)| key == "id") {
            return id.into_owned();
        }
    }
    raw.to_string()
}

fn required(params: &Value, name: &str, what: &str) -> Result<String, NodeError> {
    let value = text(params, name);
    if value.trim().is_empty() {
        return Err(NodeError::failed(format!("Write {what}")));
    }
    Ok(value.trim().to_string())
}

fn limit_of(params: &Value, name: &str, fallback: usize) -> usize {
    number(params, name).map(|n| n.max(0.0) as usize).filter(|n| *n > 0).unwrap_or(fallback)
}

fn decode_b64url(data: &str) -> Vec<u8> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).unwrap_or_default()
}

// ----------------------------------------------------------------------------------------- Gmail

async fn gmail(google: &Google<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    match text(params, "gmailOp").as_str() {
        "gmailSearch" => {
            let limit = limit_of(params, "maxResults", 10);
            let mut ids = Vec::new();
            let mut page = String::new();
            while ids.len() < limit {
                let mut query = vec![("q", text(params, "gmailQuery")), ("maxResults", (limit - ids.len()).min(500).to_string())];
                if !page.is_empty() {
                    query.push(("pageToken", page.clone()));
                }
                let answer = google.json("Gmail search", Method::GET, &format!("{GMAIL}/messages"), &query, None).await?;
                ids.extend(answer["messages"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string)));
                match answer["nextPageToken"].as_str() {
                    Some(next) if !next.is_empty() => page = next.to_string(),
                    _ => break,
                }
            }
            ids.truncate(limit);
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                out.push(gmail_message(google, params, &id).await?);
            }
            Ok(out)
        }
        "gmailGet" => Ok(vec![gmail_message(google, params, &required(params, "messageId", "the message id")?).await?]),
        "gmailMarkRead" => {
            let id = required(params, "messageId", "the message id")?;
            let answer = google
                .json("Gmail mark read", Method::POST, &format!("{GMAIL}/messages/{}/modify", crate::oauth::urlencode(&id)), &[], Some(&json!({"removeLabelIds": ["UNREAD"]})))
                .await?;
            Ok(vec![json!({"id": answer["id"], "threadId": answer["threadId"], "labelIds": answer["labelIds"], "unread": false})])
        }
        _ => {
            let raw = gmail_raw(params, &google.account).await?;
            let answer = google.json("Gmail send", Method::POST, &format!("{GMAIL}/messages/send"), &[], Some(&json!({"raw": raw}))).await?;
            Ok(vec![json!({"sent": true, "id": answer["id"], "threadId": answer["threadId"], "labelIds": answer["labelIds"]})])
        }
    }
}

/// The RFC 822 message Gmail sends, base64url — built by `lettre` the way the SMTP node builds one.
async fn gmail_raw(params: &Value, account: &str) -> Result<String, NodeError> {
    use lettre::message::header::ContentType;
    use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
    let written = text(params, "from");
    let from_text = if written.trim().is_empty() { account.to_string() } else { written };
    if from_text.trim().is_empty() {
        return Err(NodeError::failed("Write the sender (\"From\") — this credential does not say which account it is"));
    }
    let from = from_text.trim().parse::<Mailbox>().map_err(|e| NodeError::failed(format!("\"{from_text}\" is not a sender address: {e}")))?;
    let to = super::net::mailboxes(&text(params, "to"))?;
    if to.is_empty() {
        return Err(NodeError::failed("Write who the email goes to"));
    }
    let mut builder = lettre::Message::builder().from(from).subject(text(params, "subject"));
    for mailbox in to {
        builder = builder.to(mailbox);
    }
    for mailbox in super::net::mailboxes(&text(params, "cc"))? {
        builder = builder.cc(mailbox);
    }
    for mailbox in super::net::mailboxes(&text(params, "bcc"))? {
        builder = builder.bcc(mailbox);
    }
    let body = text(params, "body");
    let body_part = if flag(params, "html") { SinglePart::html(body) } else { SinglePart::plain(body) };
    let attachments = strings(params, "attachments");
    let message = if attachments.is_empty() {
        builder.singlepart(body_part)
    } else {
        let mut multipart = MultiPart::mixed().singlepart(body_part);
        for path in &attachments {
            let path = expand(path);
            let bytes = tokio::fs::read(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "attachment".into());
            let kind = ContentType::parse(mime_of(&path)).unwrap_or(ContentType::TEXT_PLAIN);
            multipart = multipart.singlepart(Attachment::new(name).body(bytes, kind));
        }
        builder.multipart(multipart)
    }
    .map_err(|e| NodeError::failed(format!("The email could not be built: {e}")))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(message.formatted()))
}

async fn gmail_message(google: &Google<'_>, params: &Value, id: &str) -> Result<Value, NodeError> {
    let url = format!("{GMAIL}/messages/{}", crate::oauth::urlencode(id));
    let message = google.json("Gmail read", Method::GET, &url, &[("format", "full".into())], None).await?;
    let mut shaped = read_message(&message);
    let folder = text(params, "attachmentsFolder");
    if folder.trim().is_empty() {
        return Ok(shaped);
    }
    let folder = expand(&folder);
    tokio::fs::create_dir_all(&folder).await.map_err(|e| NodeError::failed(format!("Could not create {}: {e}", folder.display())))?;
    if let Some(list) = shaped["attachments"].as_array_mut() {
        for attachment in list.iter_mut() {
            let Some(attachment_id) = attachment["attachmentId"].as_str().map(str::to_string) else { continue };
            let answer = google
                .json("Gmail attachment", Method::GET, &format!("{url}/attachments/{}", crate::oauth::urlencode(&attachment_id)), &[], None)
                .await?;
            let bytes = decode_b64url(answer["data"].as_str().unwrap_or_default());
            let name = attachment["name"].as_str().unwrap_or("attachment").to_string();
            let path = free_path(&folder, &safe_name(&name), false);
            tokio::fs::write(&path, &bytes).await.map_err(|e| NodeError::failed(format!("Could not write {}: {e}", path.display())))?;
            attachment["path"] = json!(path.to_string_lossy());
        }
    }
    Ok(shaped)
}

/// A Gmail message as an automation reads it: the headers people mean, the first plain and HTML
/// bodies, and the attachments (their ids, to download).
pub fn read_message(message: &Value) -> Value {
    let payload = &message["payload"];
    let header = |name: &str| {
        payload["headers"]
            .as_array()
            .and_then(|headers| headers.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))))
            .and_then(|h| h["value"].as_str())
            .unwrap_or_default()
            .to_string()
    };
    let (mut plain, mut html, mut attachments) = (String::new(), String::new(), Vec::new());
    walk_parts(payload, &mut plain, &mut html, &mut attachments);
    let labels: Vec<Value> = message["labelIds"].as_array().cloned().unwrap_or_default();
    json!({
        "id": message["id"],
        "threadId": message["threadId"],
        "from": header("From"),
        "to": header("To"),
        "cc": header("Cc"),
        "subject": header("Subject"),
        "date": header("Date"),
        "snippet": message["snippet"],
        "unread": labels.iter().any(|label| label == "UNREAD"),
        "labelIds": labels,
        "text": plain,
        "html": html,
        "attachments": attachments,
    })
}

fn walk_parts(part: &Value, plain: &mut String, html: &mut String, attachments: &mut Vec<Value>) {
    let mime = part["mimeType"].as_str().unwrap_or_default();
    let filename = part["filename"].as_str().unwrap_or_default();
    if !filename.is_empty() {
        attachments.push(json!({
            "name": filename,
            "mimeType": mime,
            "size": part["body"]["size"],
            "attachmentId": part["body"]["attachmentId"],
        }));
        return;
    }
    if let Some(data) = part["body"]["data"].as_str() {
        let decoded = String::from_utf8_lossy(&decode_b64url(data)).into_owned();
        if mime == "text/plain" && plain.is_empty() {
            *plain = decoded;
        } else if mime == "text/html" && html.is_empty() {
            *html = decoded;
        }
    }
    for child in part["parts"].as_array().into_iter().flatten() {
        walk_parts(child, plain, html, attachments);
    }
}

// ---------------------------------------------------------------------------------------- Sheets

/// `Hoja 1!A1:D` → `'Hoja 1'`: the sheet a range is on, quoted the way A1 notation wants it.
pub fn sheet_of(range: &str) -> String {
    let sheet = match range.rsplit_once('!') {
        Some((sheet, _)) => sheet,
        None => range,
    }
    .trim();
    if sheet.starts_with('\'') || sheet.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        sheet.to_string()
    } else {
        format!("'{}'", sheet.replace('\'', "''"))
    }
}

/// A column's letters: 0 → A, 25 → Z, 26 → AA.
pub fn column_letters(mut index: usize) -> String {
    let mut letters = Vec::new();
    loop {
        letters.push((b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    letters.iter().rev().collect()
}

/// A sheet's rows as items: keyed by the header row, or by column letter without one.
pub fn rows_to_items(values: &[Value], header: bool, limit: usize) -> Vec<Value> {
    let cells = |row: &Value| row.as_array().cloned().unwrap_or_default();
    let (keys, body): (Vec<String>, &[Value]) = if header && !values.is_empty() {
        let names = cells(&values[0])
            .iter()
            .enumerate()
            .map(|(i, cell)| match cell_text(cell) {
                name if name.trim().is_empty() => column_letters(i),
                name => name,
            })
            .collect();
        (names, &values[1..])
    } else {
        (Vec::new(), values)
    };
    body.iter()
        .take(if limit == 0 { usize::MAX } else { limit })
        .map(|row| {
            let row = cells(row);
            let width = keys.len().max(row.len());
            let mut object = Map::new();
            for i in 0..width {
                let key = keys.get(i).cloned().unwrap_or_else(|| column_letters(i));
                object.insert(key, row.get(i).cloned().unwrap_or(json!("")));
            }
            Value::Object(object)
        })
        .collect()
}

fn cell_text(cell: &Value) -> String {
    match cell {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A value as a cell takes it: numbers and booleans as they are, lists and objects as JSON.
fn to_cell(value: &Value) -> Value {
    match value {
        Value::Null => json!(""),
        Value::String(_) | Value::Number(_) | Value::Bool(_) => value.clone(),
        other => json!(other.to_string()),
    }
}

/// One item's row: the node's columns when it names any, else the item's own fields.
fn row_of(params: &Value, item: Option<&Value>) -> Map<String, Value> {
    let columns = pairs(params, "columns");
    if !columns.is_empty() {
        return columns.into_iter().map(|(key, value)| (key, json!(value))).collect();
    }
    item.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// The cells of `row` in the order of `headers`; what has no column is left out (and reported).
pub fn cells_for(headers: &[String], row: &Map<String, Value>) -> (Vec<Value>, Vec<String>) {
    let cells = headers.iter().map(|header| row.get(header).map(to_cell).unwrap_or(json!(""))).collect();
    let skipped = row.keys().filter(|key| !headers.contains(key)).cloned().collect();
    (cells, skipped)
}

fn values_url(spreadsheet: &str, range: &str) -> String {
    format!("{SHEETS}/{}/values/{}", crate::oauth::urlencode(spreadsheet), crate::oauth::urlencode(range))
}

async fn sheet_values(google: &Google<'_>, spreadsheet: &str, range: &str) -> Result<Vec<Value>, NodeError> {
    let query = [("valueRenderOption", "UNFORMATTED_VALUE".to_string()), ("dateTimeRenderOption", "FORMATTED_STRING".to_string())];
    let answer = google.json("Sheets read", Method::GET, &values_url(spreadsheet, range), &query, None).await?;
    Ok(answer["values"].as_array().cloned().unwrap_or_default())
}

async fn sheets_read(google: &Google<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    let spreadsheet = doc_id(&required(params, "spreadsheetId", "the spreadsheet (its link or id)")?);
    let range = required(params, "sheetRange", "the sheet or range, like Hoja1 or Hoja1!A1:D")?;
    let values = sheet_values(google, &spreadsheet, &range).await?;
    Ok(rows_to_items(&values, flag(params, "header"), number(params, "rowLimit").map(|n| n.max(0.0) as usize).unwrap_or(0)))
}

fn headers_of(values: &[Value]) -> Vec<String> {
    values.first().and_then(Value::as_array).map(|row| row.iter().map(cell_text).collect()).unwrap_or_default()
}

async fn sheets_append(google: &Google<'_>, rows: &[(usize, Value, Map<String, Value>)]) -> Result<Vec<(usize, Value)>, NodeError> {
    let Some((_, params, _)) = rows.first() else { return Ok(Vec::new()) };
    let spreadsheet = doc_id(&required(params, "spreadsheetId", "the spreadsheet (its link or id)")?);
    let range = required(params, "sheetRange", "the sheet or range, like Hoja1 or Hoja1!A1:D")?;
    let sheet = sheet_of(&range);
    let mut headers = headers_of(&sheet_values(google, &spreadsheet, &format!("{sheet}!1:1")).await?);
    let mut values = Vec::new();
    if headers.iter().all(|h| h.trim().is_empty()) {
        // An empty sheet: its header row is the rows' fields, in the order they first appear.
        headers.clear();
        for (_, _, row) in rows {
            for key in row.keys() {
                if !headers.contains(key) {
                    headers.push(key.clone());
                }
            }
        }
        values.push(headers.iter().map(|h| json!(h)).collect::<Vec<_>>());
    }
    let mut skipped: Vec<String> = Vec::new();
    for (_, _, row) in rows {
        let (cells, left_out) = cells_for(&headers, row);
        values.push(cells);
        skipped.extend(left_out.into_iter().filter(|key| !skipped.contains(key)).collect::<Vec<_>>());
    }
    if !skipped.is_empty() {
        google.ctx.log(LogStream::Info, &format!("Not in the sheet's header, so not written: {}", skipped.join(", ")));
    }
    let query = [("valueInputOption", "USER_ENTERED".to_string()), ("insertDataOption", "INSERT_ROWS".to_string())];
    let answer = google
        .json("Sheets append", Method::POST, &format!("{}:append", values_url(&spreadsheet, &sheet)), &query, Some(&json!({"values": values})))
        .await?;
    let updated = answer["updates"]["updatedRange"].as_str().unwrap_or_default().to_string();
    Ok(rows
        .iter()
        .map(|(index, _, row)| {
            let mut json = Value::Object(row.clone());
            json["_range"] = json!(updated);
            (*index, json)
        })
        .collect())
}

async fn sheets_update(google: &Google<'_>, rows: &[(usize, Value, Map<String, Value>)]) -> Result<Vec<(usize, Value)>, NodeError> {
    let Some((_, first, _)) = rows.first() else { return Ok(Vec::new()) };
    let spreadsheet = doc_id(&required(first, "spreadsheetId", "the spreadsheet (its link or id)")?);
    let range = required(first, "sheetRange", "the sheet or range, like Hoja1 or Hoja1!A1:D")?;
    let match_column = required(first, "matchColumn", "the column that finds the row")?;
    let sheet = sheet_of(&range);
    let values = sheet_values(google, &spreadsheet, &sheet).await?;
    let headers = headers_of(&values);
    let key_index = headers
        .iter()
        .position(|h| h == &match_column)
        .ok_or_else(|| NodeError::failed(format!("The sheet has no \"{match_column}\" column")))?;
    let append_missing = text(first, "ifMissing") == "appendRow";

    let mut data = Vec::new();
    let mut appended = Vec::new();
    let mut out = Vec::new();
    for (index, params, row) in rows {
        let wanted = match text(params, "matchValue") {
            value if !value.trim().is_empty() => value,
            _ => row.get(&match_column).map(cell_text).unwrap_or_default(),
        };
        let found = values.iter().skip(1).position(|cells| cells.as_array().and_then(|c| c.get(key_index)).map(cell_text).unwrap_or_default() == wanted);
        let mut json = Value::Object(row.clone());
        match found {
            Some(position) => {
                let sheet_row = position + 2;
                for (column, header) in headers.iter().enumerate() {
                    if let Some(value) = row.get(header) {
                        data.push(json!({"range": format!("{sheet}!{}{sheet_row}", column_letters(column)), "values": [[to_cell(value)]]}));
                    }
                }
                json["_row"] = json!(sheet_row);
                json["_updated"] = json!(true);
            }
            None if append_missing => {
                let mut with_key = row.clone();
                with_key.entry(match_column.clone()).or_insert(json!(wanted));
                appended.push(cells_for(&headers, &with_key).0);
                json["_updated"] = json!(false);
                json["_appended"] = json!(true);
            }
            None => json["_updated"] = json!(false),
        }
        out.push((*index, json));
    }
    if !data.is_empty() {
        let body = json!({"valueInputOption": "USER_ENTERED", "data": data});
        google.json("Sheets update", Method::POST, &format!("{SHEETS}/{}/values:batchUpdate", crate::oauth::urlencode(&spreadsheet)), &[], Some(&body)).await?;
    }
    if !appended.is_empty() {
        let query = [("valueInputOption", "USER_ENTERED".to_string()), ("insertDataOption", "INSERT_ROWS".to_string())];
        google
            .json("Sheets append", Method::POST, &format!("{}:append", values_url(&spreadsheet, &sheet)), &query, Some(&json!({"values": appended})))
            .await?;
    }
    Ok(out)
}

// -------------------------------------------------------------------------------------- Calendar

/// A moment as written in a flow — RFC 3339, `2026-10-05 09:30`, `2026-10-05T09:30` or a bare date
/// (its midnight) — in `zone` when it names none.
pub fn moment(raw: &str, zone: Tz) -> Option<DateTime<FixedOffset>> {
    let raw = raw.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(raw) {
        return Some(at);
    }
    let local = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"]
        .iter()
        .find_map(|format| NaiveDateTime::parse_from_str(raw, format).ok())
        .or_else(|| NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)))?;
    zone.from_local_datetime(&local).earliest().map(|at| at.fixed_offset())
}

fn event_json(event: &Value) -> Value {
    let all_day = event["start"].get("date").is_some();
    let when = |side: &str| event[side].get("dateTime").or_else(|| event[side].get("date")).cloned().unwrap_or(Value::Null);
    json!({
        "id": event["id"],
        "summary": event["summary"],
        "description": event["description"],
        "location": event["location"],
        "start": when("start"),
        "end": when("end"),
        "allDay": all_day,
        "status": event["status"],
        "organizer": event["organizer"]["email"],
        "attendees": event["attendees"].as_array().map(|list| list.iter().filter_map(|a| a["email"].as_str()).map(|e| json!(e)).collect::<Vec<_>>()).unwrap_or_default(),
        "htmlLink": event["htmlLink"],
        "meetLink": event["hangoutLink"],
    })
}

async fn calendar(google: &Google<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    let calendar = match text(params, "calendarId") {
        id if id.trim().is_empty() => "primary".to_string(),
        id => id.trim().to_string(),
    };
    let url = format!("{CALENDAR}/{}/events", crate::oauth::urlencode(&calendar));
    if text(params, "calendarOp") == "calendarCreate" {
        let summary = required(params, "eventTitle", "the event's title")?;
        let start_raw = required(params, "startTime", "when the event starts")?;
        let start = moment(&start_raw, google.zone).ok_or_else(|| NodeError::failed(format!("\"{start_raw}\" is not a date")))?;
        let end = match text(params, "endTime") {
            raw if raw.trim().is_empty() => None,
            raw => Some(moment(&raw, google.zone).ok_or_else(|| NodeError::failed(format!("\"{raw}\" is not a date")))?),
        };
        let (start_json, end_json) = if flag(params, "allDay") {
            let first = start.date_naive();
            let last = end.map(|e| e.date_naive()).filter(|d| *d > first).unwrap_or(first + Span::days(1));
            (json!({"date": first.to_string()}), json!({"date": last.to_string()}))
        } else {
            let end = end.unwrap_or(start + Span::hours(1));
            let zone = google.zone.name();
            (json!({"dateTime": start.to_rfc3339(), "timeZone": zone}), json!({"dateTime": end.to_rfc3339(), "timeZone": zone}))
        };
        let mut body = json!({"summary": summary, "start": start_json, "end": end_json});
        for (param, field) in [("description", "description"), ("eventLocation", "location")] {
            let value = text(params, param);
            if !value.trim().is_empty() {
                body[field] = json!(value);
            }
        }
        let attendees: Vec<Value> = strings(params, "attendees").into_iter().filter(|a| !a.trim().is_empty()).map(|a| json!({"email": a.trim()})).collect();
        if !attendees.is_empty() {
            body["attendees"] = json!(attendees);
        }
        let notify = if flag(params, "notifyAttendees") { "all" } else { "none" };
        let event = google.json("Calendar create", Method::POST, &url, &[("sendUpdates", notify.into())], Some(&body)).await?;
        return Ok(vec![event_json(&event)]);
    }

    let now = chrono::Utc::now().with_timezone(&google.zone).fixed_offset();
    let from = match text(params, "rangeStart") {
        raw if raw.trim().is_empty() => now,
        raw => moment(&raw, google.zone).ok_or_else(|| NodeError::failed(format!("\"{raw}\" is not a date")))?,
    };
    let to = match text(params, "rangeEnd") {
        raw if raw.trim().is_empty() => from + Span::days(7),
        raw => moment(&raw, google.zone).ok_or_else(|| NodeError::failed(format!("\"{raw}\" is not a date")))?,
    };
    let limit = limit_of(params, "eventLimit", 50);
    let mut query = vec![
        ("timeMin", from.to_rfc3339()),
        ("timeMax", to.to_rfc3339()),
        ("singleEvents", "true".into()),
        ("orderBy", "startTime".into()),
        ("maxResults", limit.min(2500).to_string()),
    ];
    let search = text(params, "eventSearch");
    if !search.trim().is_empty() {
        query.push(("q", search));
    }
    let answer = google.json("Calendar list", Method::GET, &url, &query, None).await?;
    Ok(answer["items"].as_array().into_iter().flatten().take(limit).map(event_json).collect())
}

// ----------------------------------------------------------------------------------------- Drive

const FILE_FIELDS: &str = "id,name,mimeType,size,modifiedTime,webViewLink,parents";

fn file_json(file: &Value) -> Value {
    json!({
        "id": file["id"],
        "name": file["name"],
        "mimeType": file["mimeType"],
        "size": file["size"].as_str().and_then(|s| s.parse::<u64>().ok()).map(Value::from).unwrap_or(Value::Null),
        "modifiedTime": file["modifiedTime"],
        "webViewLink": file["webViewLink"],
        "parents": file["parents"],
    })
}

/// What a Google-native file is exported as, and the extension it is saved with.
pub fn export_format(native: &str, wanted: &str) -> Result<(&'static str, &'static str), String> {
    let kind = native.trim_start_matches("application/vnd.google-apps.");
    let format = match (kind, wanted) {
        (_, "pdf") => ("application/pdf", "pdf"),
        ("document", "docx") => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
        ("document", "txt") => ("text/plain", "txt"),
        ("document", "md") => ("text/markdown", "md"),
        ("spreadsheet", "xlsx") => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
        ("spreadsheet", "csv") => ("text/csv", "csv"),
        ("presentation", "pptx") => ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
        ("drawing", "png") => ("image/png", "png"),
        _ => return Err(format!("A Google {kind} cannot be exported as {wanted}")),
    };
    Ok(format)
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("txt" | "log") => "text/plain",
        Some("md") => "text/markdown",
        Some("csv") => "text/csv",
        Some("html" | "htm") => "text/html",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("zip") => "application/zip",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() { "file".into() } else { trimmed }
}

/// `folder/name`, or with ` (2)`, ` (3)`… before the extension while that is taken.
fn free_path(folder: &Path, name: &str, overwrite: bool) -> PathBuf {
    let first = folder.join(name);
    if overwrite || !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.to_string());
    let extension = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| folder.join(format!("{stem} ({n}){extension}"))).find(|candidate| !candidate.exists()).unwrap_or(first)
}

async fn drive(google: &Google<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    match text(params, "driveOp").as_str() {
        "driveUpload" => {
            let path = expand(&required(params, "filePath", "the file to upload")?);
            let size = tokio::fs::metadata(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?.len();
            if size > UPLOAD_LIMIT {
                return Err(NodeError::failed(format!("{} is over 100 MB, more than one upload takes", path.display())));
            }
            let bytes = tokio::fs::read(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
            let name = match text(params, "fileName") {
                given if !given.trim().is_empty() => given.trim().to_string(),
                _ => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
            };
            let mut metadata = json!({"name": name});
            let folder = doc_id(&text(params, "driveFolder"));
            if !folder.is_empty() {
                metadata["parents"] = json!([folder]);
            }
            let boundary = format!("cf-{}", uuid::Uuid::new_v4().simple());
            let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: {}\r\n\r\n", mime_of(&path)).into_bytes();
            body.extend_from_slice(&bytes);
            body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
            let request = google
                .client
                .post(DRIVE_UPLOAD)
                .query(&[("uploadType", "multipart"), ("fields", FILE_FIELDS), ("supportsAllDrives", "true")])
                .header("Content-Type", format!("multipart/related; boundary={boundary}"))
                .body(body);
            let text = google.send("Drive upload", request).await?.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
            let file: Value = serde_json::from_str(&text).map_err(|_| NodeError::failed("Drive did not answer JSON"))?;
            Ok(vec![file_json(&file)])
        }
        "driveDownload" => {
            let id = doc_id(&required(params, "fileId", "the file (its link or id)")?);
            let folder = expand(&required(params, "folder", "the folder to save into")?);
            let url = format!("{DRIVE}/{}", crate::oauth::urlencode(&id));
            let file = google.json("Drive file", Method::GET, &url, &[("fields", FILE_FIELDS.into()), ("supportsAllDrives", "true".into())], None).await?;
            let mime = file["mimeType"].as_str().unwrap_or_default().to_string();
            let mut name = match text(params, "fileName") {
                given if !given.trim().is_empty() => given.trim().to_string(),
                _ => file["name"].as_str().unwrap_or("file").to_string(),
            };
            let bytes = if mime.starts_with("application/vnd.google-apps.") {
                let (export_mime, extension) = export_format(&mime, &text(params, "exportAs")).map_err(NodeError::Failed)?;
                if !name.to_ascii_lowercase().ends_with(&format!(".{extension}")) {
                    name = format!("{name}.{extension}");
                }
                google.bytes("Drive export", &format!("{url}/export"), &[("mimeType", export_mime.into())]).await?
            } else {
                google.bytes("Drive download", &url, &[("alt", "media".into()), ("supportsAllDrives", "true".into())]).await?
            };
            tokio::fs::create_dir_all(&folder).await.map_err(|e| NodeError::failed(format!("Could not create {}: {e}", folder.display())))?;
            let path = free_path(&folder, &safe_name(&name), flag(params, "overwrite"));
            tokio::fs::write(&path, &bytes).await.map_err(|e| NodeError::failed(format!("Could not write {}: {e}", path.display())))?;
            let mut json = file_json(&file);
            json["path"] = json!(path.to_string_lossy());
            json["size"] = json!(bytes.len());
            Ok(vec![json])
        }
        _ => {
            let mut filters = vec!["trashed = false".to_string()];
            let folder = doc_id(&text(params, "driveFolder"));
            if !folder.is_empty() {
                filters.push(format!("'{}' in parents", folder.replace('\'', "\\'")));
            }
            let query = text(params, "driveQuery");
            if !query.trim().is_empty() {
                filters.push(format!("({})", query.trim()));
            }
            let limit = limit_of(params, "fileLimit", 50);
            let mut out = Vec::new();
            let mut page = String::new();
            while out.len() < limit {
                let mut query = vec![
                    ("q", filters.join(" and ")),
                    ("pageSize", (limit - out.len()).min(1000).to_string()),
                    ("fields", format!("nextPageToken,files({FILE_FIELDS})")),
                    ("orderBy", "modifiedTime desc".into()),
                    ("supportsAllDrives", "true".into()),
                    ("includeItemsFromAllDrives", "true".into()),
                ];
                if !page.is_empty() {
                    query.push(("pageToken", page.clone()));
                }
                let answer = google.json("Drive list", Method::GET, DRIVE, &query, None).await?;
                out.extend(answer["files"].as_array().into_iter().flatten().map(file_json));
                match answer["nextPageToken"].as_str() {
                    Some(next) if !next.is_empty() => page = next.to_string(),
                    _ => break,
                }
            }
            out.truncate(limit);
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_read_down_to_their_ids() {
        assert_eq!(doc_id("https://docs.google.com/spreadsheets/d/1AbC-xyz_09/edit#gid=0"), "1AbC-xyz_09");
        assert_eq!(doc_id("https://drive.google.com/file/d/0B123/view?usp=sharing"), "0B123");
        assert_eq!(doc_id("https://drive.google.com/drive/folders/1Folder"), "1Folder");
        assert_eq!(doc_id("https://drive.google.com/open?id=XYZ"), "XYZ");
        assert_eq!(doc_id("  plain-id "), "plain-id");
    }

    #[test]
    fn a_gmail_message_reads_as_its_headers_bodies_and_attachments() {
        let encode = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        let message = json!({
            "id": "m1", "threadId": "t1", "snippet": "Hola", "labelIds": ["INBOX", "UNREAD"],
            "payload": {
                "mimeType": "multipart/mixed",
                "headers": [{"name": "From", "value": "Ana <ana@example.com>"}, {"name": "subject", "value": "Factura"}],
                "parts": [
                    {"mimeType": "multipart/alternative", "parts": [
                        {"mimeType": "text/plain", "body": {"data": encode("Hola, adjunto la factura.")}},
                        {"mimeType": "text/html", "body": {"data": encode("<p>Hola</p>")}}
                    ]},
                    {"mimeType": "application/pdf", "filename": "factura.pdf", "body": {"attachmentId": "a1", "size": 1234}}
                ]
            }
        });
        let shaped = read_message(&message);
        assert_eq!(shaped["from"], "Ana <ana@example.com>");
        assert_eq!(shaped["subject"], "Factura");
        assert_eq!(shaped["text"], "Hola, adjunto la factura.");
        assert_eq!(shaped["html"], "<p>Hola</p>");
        assert_eq!(shaped["unread"], true);
        assert_eq!(shaped["attachments"][0]["name"], "factura.pdf");
        assert_eq!(shaped["attachments"][0]["attachmentId"], "a1");
    }

    #[test]
    fn sheet_rows_read_by_their_header_and_write_in_its_order() {
        let values = vec![json!(["nombre", "total", ""]), json!(["Ana", 12.5]), json!(["Bruno", 7, "x", "y"])];
        let items = rows_to_items(&values, true, 0);
        assert_eq!(items[0], json!({"nombre": "Ana", "total": 12.5, "C": ""}));
        assert_eq!(items[1]["D"], "y");
        assert_eq!(rows_to_items(&values, false, 1), vec![json!({"A": "nombre", "B": "total", "C": ""})]);

        let headers = vec!["nombre".to_string(), "total".to_string()];
        let row: Map<String, Value> = serde_json::from_value(json!({"total": 3, "nombre": "Ana", "extra": {"a": 1}})).unwrap();
        let (cells, skipped) = cells_for(&headers, &row);
        assert_eq!(cells, vec![json!("Ana"), json!(3)]);
        assert_eq!(skipped, vec!["extra".to_string()]);

        assert_eq!(sheet_of("Hoja1!A1:D"), "Hoja1");
        assert_eq!(sheet_of("Mis pedidos!A:B"), "'Mis pedidos'");
        assert_eq!(sheet_of("'Ya citada'!A1"), "'Ya citada'");
        assert_eq!((column_letters(0), column_letters(25), column_letters(26), column_letters(701)), ("A".into(), "Z".into(), "AA".into(), "ZZ".into()));
    }

    #[test]
    fn moments_are_read_in_the_flows_zone() {
        let zone: Tz = "America/Santiago".parse().unwrap();
        assert_eq!(moment("2026-10-05T09:30:00Z", zone).unwrap().to_rfc3339(), "2026-10-05T09:30:00+00:00");
        assert_eq!(moment("2026-10-05 09:30", zone).unwrap().to_rfc3339(), "2026-10-05T09:30:00-03:00");
        assert_eq!(moment("2026-01-15", zone).unwrap().to_rfc3339(), "2026-01-15T00:00:00-03:00");
        assert!(moment("mañana", zone).is_none());
    }

    #[test]
    fn native_files_export_only_as_what_they_can_be() {
        assert_eq!(export_format("application/vnd.google-apps.spreadsheet", "csv").unwrap().1, "csv");
        assert_eq!(export_format("application/vnd.google-apps.document", "pdf").unwrap().0, "application/pdf");
        assert!(export_format("application/vnd.google-apps.document", "xlsx").is_err());
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
    }
}
