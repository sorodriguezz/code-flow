//! The Microsoft 365 node: Outlook mail, Outlook Calendar, OneDrive and Excel through the person's
//! own OAuth 2 credential (provider `microsoft`, `flows::oauth`) — Microsoft Graph, the Google
//! node's twin.
//!
//! **The Google node's shapes.** A message reads `from`, `subject`, `text`; an event `start`, `end`,
//! `allDay`; a file `name`, `size`, `webViewLink`; a worksheet's rows are keyed by its header row —
//! so a flow can trade one suite for the other and keep the nodes after it. The pure halves are
//! plain functions, tested without Microsoft.
//!
//! **Excel writes keep formulas.** An updated row is written with `null` in every column the item
//! does not name, which Excel leaves as it was — a whole row of values would flatten the formulas
//! beside the cells that changed.

use base64::Engine as _;
use chrono::{DateTime, Duration as Span, FixedOffset};
use chrono_tz::Tz;
use reqwest::Method;
use serde_json::{json, Map, Value};

use super::files::expand;
use super::google::{cells_for, column_letters, free_path, headers_of, limit_of, mime_of, moment, required, row_of, rows_to_items, safe_name, to_cell};
use super::{flag, number, strings, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};
use crate::oauth::urlencode;

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
/// What one `sendMail` carries per attachment; past it Graph wants an upload session.
const MAIL_ATTACHMENT_LIMIT: u64 = 3 * 1024 * 1024;
/// What OneDrive takes in one simple upload.
const UPLOAD_LIMIT: u64 = 250 * 1024 * 1024;
const MESSAGE_FIELDS: &str = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,body,webLink,categories,importance";
const EVENT_FIELDS: &str = "id,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,webLink,onlineMeeting,isCancelled";
const ITEM_FIELDS: &str = "id,name,size,file,folder,lastModifiedDateTime,webUrl,parentReference";

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let once = ctx.param_str("runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let graph = Graph::connect(ctx).await?;
    let service = ctx.param_str("service");
    let items = ctx.items();
    let paired = !items.is_empty();
    // A row per item, written together.
    if service == "excel" && matches!(ctx.param_str("excelOp").as_str(), "excelAppend" | "excelUpdate") {
        let rows: Vec<(usize, Value, Map<String, Value>)> = resolved
            .iter()
            .enumerate()
            .map(|(index, params)| (index, params.clone(), row_of(params, items.get(index).map(|item| &item.json))))
            .collect();
        let written = if ctx.param_str("excelOp") == "excelAppend" { excel_append(&graph, &rows).await? } else { excel_update(&graph, &rows).await? };
        return Ok(vec![written.into_iter().map(|(index, json)| if paired { Item::paired(json, index) } else { Item::new(json) }).collect()]);
    }
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let answers = match service.as_str() {
            "outlook" | "" => outlook(&graph, params).await?,
            "calendar" => calendar(&graph, params).await?,
            "onedrive" => onedrive(&graph, params).await?,
            "excel" => excel_read(&graph, params).await?,
            other => return Err(NodeError::failed(format!("Unknown Microsoft service {other}"))),
        };
        for json in answers {
            out.push(if paired { Item::paired(json, index) } else { Item::new(json) });
        }
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------- transport

struct Graph<'a> {
    ctx: &'a NodeCtx,
    token: String,
    zone: Tz,
    client: reqwest::Client,
}

impl<'a> Graph<'a> {
    async fn connect(ctx: &'a NodeCtx) -> Result<Graph<'a>, NodeError> {
        let id = ctx.param_str("credential");
        if id.trim().is_empty() {
            return Err(NodeError::failed("Pick the Microsoft credential (an OAuth 2 one, connected)"));
        }
        let credential = ctx.credential(id.trim()).await?;
        if credential.meta.get("provider").and_then(Value::as_str) != Some("microsoft") {
            return Err(NodeError::failed("The credential is not a Microsoft OAuth 2 one"));
        }
        let zone = crate::flows::schedule::zone_of(&json!({}), ctx.run.timezone.as_deref()).unwrap_or(chrono_tz::UTC);
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|e| NodeError::failed(e.to_string()))?;
        Ok(Graph { ctx, token: credential.secret, zone, client })
    }

    async fn send(&self, what: &str, request: reqwest::RequestBuilder) -> Result<reqwest::Response, NodeError> {
        let started = std::time::Instant::now();
        let response = tokio::select! {
            response = request.bearer_auth(&self.token).send() => response.map_err(|e| NodeError::failed(format!("Microsoft could not be reached: {e}")))?,
            _ = self.ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        let status = response.status();
        self.ctx.log(LogStream::Info, &format!("{what} → {} ({} ms)", status.as_u16(), started.elapsed().as_millis()));
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        Err(NodeError::failed(format!("Microsoft answered {}: {}", status.as_u16(), crate::oauth::describe(status, &body))))
    }

    /// A Graph call answered in JSON (`Null` for a 202 or 204). `prefer` is Graph's `Prefer` header:
    /// the body as text, the times in the flow's zone.
    async fn json(&self, what: &str, method: Method, url: &str, query: &[(&str, String)], body: Option<&Value>, prefer: Option<&str>) -> Result<Value, NodeError> {
        let mut request = self.client.request(method, url).query(query);
        if let Some(prefer) = prefer {
            request = request.header("Prefer", prefer);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let text = self.send(what, request).await?.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| NodeError::failed(format!("Microsoft did not answer JSON: {}", text.chars().take(200).collect::<String>())))
    }

    /// Every page of a collection, up to `limit` entries that `keep` accepts.
    async fn pages(
        &self,
        what: &str,
        url: &str,
        query: Vec<(&str, String)>,
        prefer: Option<&str>,
        limit: usize,
        keep: impl Fn(&Value) -> bool,
    ) -> Result<Vec<Value>, NodeError> {
        let mut out = Vec::new();
        let mut next = Some((url.to_string(), query));
        while let Some((url, query)) = next.take() {
            let answer = self.json(what, Method::GET, &url, &query, None, prefer).await?;
            out.extend(answer["value"].as_array().into_iter().flatten().filter(|entry| keep(entry)).cloned());
            if out.len() >= limit {
                break;
            }
            // The next link carries the query already.
            if let Some(link) = answer["@odata.nextLink"].as_str() {
                next = Some((link.to_string(), Vec::new()));
            }
        }
        out.truncate(limit);
        Ok(out)
    }
}

/// `Documentos/Informes/q3.xlsx` as a Graph path — every segment percent-encoded on its own.
fn drive_path(raw: &str) -> String {
    raw.trim().trim_matches('/').split('/').filter(|segment| !segment.is_empty()).map(urlencode).collect::<Vec<_>>().join("/")
}

/// A OneDrive item a person names: a path (it has a `/` or an extension) or an item id.
pub fn item_url(raw: &str) -> String {
    let raw = raw.trim();
    if raw.contains('/') || raw.contains('.') {
        format!("{GRAPH}/me/drive/root:/{}:", drive_path(raw))
    } else {
        format!("{GRAPH}/me/drive/items/{}", urlencode(raw))
    }
}

fn address_of(entry: &Value) -> String {
    entry["emailAddress"]["address"].as_str().unwrap_or_default().to_string()
}

/// `a@example.com, Ana <b@example.com>` as Graph recipients.
fn recipients(raw: &str) -> Result<Vec<Value>, NodeError> {
    Ok(super::net::mailboxes(raw)?
        .into_iter()
        .map(|mailbox| {
            let mut address = json!({"address": mailbox.email.to_string()});
            if let Some(name) = mailbox.name.filter(|n| !n.trim().is_empty()) {
                address["name"] = json!(name);
            }
            json!({"emailAddress": address})
        })
        .collect())
}

// --------------------------------------------------------------------------------------- Outlook

/// An Outlook message as the Google node hands a Gmail one: the headers people mean, the body as
/// text (asked for as text) or HTML, and the attachments once listed.
pub fn read_message(message: &Value) -> Value {
    let list = |key: &str| message[key].as_array().map(|l| l.iter().map(address_of).filter(|a| !a.is_empty()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let is_html = message["body"]["contentType"].as_str().is_some_and(|kind| kind.eq_ignore_ascii_case("html"));
    let content = message["body"]["content"].as_str().unwrap_or_default();
    json!({
        "id": message["id"],
        "threadId": message["conversationId"],
        "from": address_of(&message["from"]),
        "fromName": message["from"]["emailAddress"]["name"],
        "to": list("toRecipients"),
        "cc": list("ccRecipients"),
        "subject": message["subject"],
        "date": message["receivedDateTime"],
        "snippet": message["bodyPreview"],
        "unread": message["isRead"] == Value::Bool(false),
        "categories": message["categories"].as_array().cloned().unwrap_or_default(),
        "importance": message["importance"],
        "text": if is_html { "" } else { content },
        "html": if is_html { content } else { "" },
        "webLink": message["webLink"],
        "attachments": [],
    })
}

const PREFER_TEXT: &str = "outlook.body-content-type=\"text\"";

async fn outlook(graph: &Graph<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    match text(params, "outlookOp").as_str() {
        "outlookSearch" => {
            let limit = limit_of(params, "maxResults", 10);
            let folder = match text(params, "outlookFolder") {
                name if name.trim().is_empty() => "inbox".to_string(),
                name => name.trim().to_string(),
            };
            let url = format!("{GRAPH}/me/mailFolders/{}/messages", urlencode(&folder));
            let search = text(params, "outlookQuery");
            let unread_only = flag(params, "unreadOnly");
            let mut query = vec![("$top", limit.min(100).to_string()), ("$select", MESSAGE_FIELDS.to_string())];
            if search.trim().is_empty() {
                query.push(("$orderby", "receivedDateTime desc".into()));
                if unread_only {
                    query.push(("$filter", "isRead eq false".into()));
                }
            } else {
                // A search is ordered by relevance and takes no `$filter`: unread is checked here.
                query.push(("$search", format!("\"{}\"", search.trim().replace('"', "\\\""))));
            }
            let messages = graph.pages("Outlook search", &url, query, Some(PREFER_TEXT), limit, |m| !unread_only || m["isRead"] != Value::Bool(true)).await?;
            let mut out = Vec::with_capacity(messages.len());
            for message in &messages {
                out.push(with_attachments(graph, params, message).await?);
            }
            Ok(out)
        }
        "outlookGet" => {
            let id = required(params, "messageId", "the message id")?;
            let url = format!("{GRAPH}/me/messages/{}", urlencode(&id));
            let message = graph.json("Outlook read", Method::GET, &url, &[("$select", MESSAGE_FIELDS.into())], None, Some(PREFER_TEXT)).await?;
            Ok(vec![with_attachments(graph, params, &message).await?])
        }
        "outlookMarkRead" => {
            let id = required(params, "messageId", "the message id")?;
            let url = format!("{GRAPH}/me/messages/{}", urlencode(&id));
            graph.json("Outlook mark read", Method::PATCH, &url, &[("$select", "id".into())], Some(&json!({"isRead": true})), None).await?;
            Ok(vec![json!({"id": id, "unread": false})])
        }
        "outlookMove" => {
            let id = required(params, "messageId", "the message id")?;
            let folder = required(params, "targetMailbox", "the folder to move it to (archive, or a folder's id)")?;
            let url = format!("{GRAPH}/me/messages/{}/move", urlencode(&id));
            let moved = graph.json("Outlook move", Method::POST, &url, &[], Some(&json!({"destinationId": folder})), None).await?;
            // A moved message has a new id: the one the next node must use.
            Ok(vec![json!({"id": moved["id"], "previousId": id, "folder": folder})])
        }
        _ => {
            let to = recipients(&text(params, "to"))?;
            if to.is_empty() {
                return Err(NodeError::failed("Write who the email goes to"));
            }
            let mut message = json!({
                "subject": text(params, "subject"),
                "body": {"contentType": if flag(params, "html") { "HTML" } else { "Text" }, "content": text(params, "body")},
                "toRecipients": to,
            });
            for (param, field) in [("cc", "ccRecipients"), ("bcc", "bccRecipients")] {
                let list = recipients(&text(params, param))?;
                if !list.is_empty() {
                    message[field] = json!(list);
                }
            }
            let mut attachments = Vec::new();
            for path in strings(params, "attachments").iter().filter(|p| !p.trim().is_empty()) {
                let path = expand(path);
                let size = tokio::fs::metadata(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?.len();
                if size > MAIL_ATTACHMENT_LIMIT {
                    return Err(NodeError::failed(format!("{} is over 3 MB, more than an Outlook attachment sent in one call takes — upload it to OneDrive and send the link", path.display())));
                }
                let bytes = tokio::fs::read(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
                attachments.push(json!({
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "attachment".into()),
                    "contentType": mime_of(&path),
                    "contentBytes": base64::engine::general_purpose::STANDARD.encode(bytes),
                }));
            }
            if !attachments.is_empty() {
                message["attachments"] = json!(attachments);
            }
            graph.json("Outlook send", Method::POST, &format!("{GRAPH}/me/sendMail"), &[], Some(&json!({"message": message, "saveToSentItems": true})), None).await?;
            Ok(vec![json!({"sent": true, "to": text(params, "to"), "subject": text(params, "subject")})])
        }
    }
}

/// A message shaped, its attachments listed — and saved, when the node names a folder.
async fn with_attachments(graph: &Graph<'_>, params: &Value, message: &Value) -> Result<Value, NodeError> {
    let mut shaped = read_message(message);
    if message["hasAttachments"] != Value::Bool(true) {
        return Ok(shaped);
    }
    let folder = text(params, "attachmentsFolder");
    let saving = !folder.trim().is_empty();
    let url = format!("{GRAPH}/me/messages/{}/attachments", urlencode(message["id"].as_str().unwrap_or_default()));
    // Listing only: the metadata, not every attachment's bytes.
    let query: Vec<(&str, String)> = if saving { Vec::new() } else { vec![("$select", "id,name,contentType,size,isInline".into())] };
    let answer = graph.json("Outlook attachments", Method::GET, &url, &query, None, None).await?;
    let folder = expand(&folder);
    if saving {
        tokio::fs::create_dir_all(&folder).await.map_err(|e| NodeError::failed(format!("Could not create {}: {e}", folder.display())))?;
    }
    let mut list = Vec::new();
    for attachment in answer["value"].as_array().into_iter().flatten() {
        let name = attachment["name"].as_str().unwrap_or("attachment").to_string();
        let mut entry = json!({"name": name, "mimeType": attachment["contentType"], "size": attachment["size"], "attachmentId": attachment["id"]});
        if let (true, Some(data)) = (saving, attachment["contentBytes"].as_str()) {
            let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default();
            let path = free_path(&folder, &safe_name(&name), false);
            tokio::fs::write(&path, &bytes).await.map_err(|e| NodeError::failed(format!("Could not write {}: {e}", path.display())))?;
            entry["path"] = json!(path.to_string_lossy());
        }
        list.push(entry);
    }
    shaped["attachments"] = json!(list);
    Ok(shaped)
}

// -------------------------------------------------------------------------------------- Calendar

/// An Outlook event in the Google node's shape. Times come in the zone the request asked for.
pub fn event_json(event: &Value) -> Value {
    json!({
        "id": event["id"],
        "summary": event["subject"],
        "description": event["bodyPreview"],
        "location": event["location"]["displayName"],
        "start": event["start"]["dateTime"],
        "end": event["end"]["dateTime"],
        "timeZone": event["start"]["timeZone"],
        "allDay": event["isAllDay"] == Value::Bool(true),
        "status": if event["isCancelled"] == Value::Bool(true) { "cancelled" } else { "confirmed" },
        "organizer": address_of(&event["organizer"]),
        "attendees": event["attendees"].as_array().map(|list| list.iter().map(address_of).filter(|a| !a.is_empty()).map(Value::from).collect::<Vec<_>>()).unwrap_or_default(),
        "htmlLink": event["webLink"],
        "meetLink": event["onlineMeeting"]["joinUrl"],
    })
}

/// A moment as Graph's `dateTimeTimeZone` wants it: the wall-clock time in `zone`, no offset.
fn wall_clock(at: DateTime<FixedOffset>, zone: Tz) -> String {
    at.with_timezone(&zone).format("%Y-%m-%dT%H:%M:%S").to_string()
}

async fn calendar(graph: &Graph<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    let base = match text(params, "calendarId") {
        id if id.trim().is_empty() => format!("{GRAPH}/me"),
        id => format!("{GRAPH}/me/calendars/{}", urlencode(id.trim())),
    };
    let zone = graph.zone.name();
    let prefer = format!("outlook.timezone=\"{zone}\"");
    if text(params, "calendarOp") == "calendarCreate" {
        let summary = required(params, "eventTitle", "the event's title")?;
        let start_raw = required(params, "startTime", "when the event starts")?;
        let start = moment(&start_raw, graph.zone).ok_or_else(|| NodeError::failed(format!("\"{start_raw}\" is not a date")))?;
        let end = match text(params, "endTime") {
            raw if raw.trim().is_empty() => None,
            raw => Some(moment(&raw, graph.zone).ok_or_else(|| NodeError::failed(format!("\"{raw}\" is not a date")))?),
        };
        let all_day = flag(params, "allDay");
        let (start_at, end_at) = if all_day {
            // All day: midnight to midnight, in the event's own zone.
            let first = start.with_timezone(&graph.zone).date_naive();
            let last = end.map(|e| e.with_timezone(&graph.zone).date_naive()).filter(|d| *d > first).unwrap_or(first + Span::days(1));
            (format!("{first}T00:00:00"), format!("{last}T00:00:00"))
        } else {
            (wall_clock(start, graph.zone), wall_clock(end.unwrap_or(start + Span::hours(1)), graph.zone))
        };
        let mut body = json!({
            "subject": summary,
            "start": {"dateTime": start_at, "timeZone": zone},
            "end": {"dateTime": end_at, "timeZone": zone},
            "isAllDay": all_day,
        });
        let description = text(params, "description");
        if !description.trim().is_empty() {
            body["body"] = json!({"contentType": "Text", "content": description});
        }
        let location = text(params, "eventLocation");
        if !location.trim().is_empty() {
            body["location"] = json!({"displayName": location});
        }
        let attendees: Vec<Value> =
            strings(params, "attendees").into_iter().filter(|a| !a.trim().is_empty()).map(|a| json!({"emailAddress": {"address": a.trim()}, "type": "required"})).collect();
        if !attendees.is_empty() {
            body["attendees"] = json!(attendees);
        }
        if flag(params, "onlineMeeting") {
            body["isOnlineMeeting"] = json!(true);
            body["onlineMeetingProvider"] = json!("teamsForBusiness");
        }
        let event = graph.json("Calendar create", Method::POST, &format!("{base}/events"), &[], Some(&body), Some(&prefer)).await?;
        return Ok(vec![event_json(&event)]);
    }

    let now = chrono::Utc::now().with_timezone(&graph.zone).fixed_offset();
    let from = match text(params, "rangeStart") {
        raw if raw.trim().is_empty() => now,
        raw => moment(&raw, graph.zone).ok_or_else(|| NodeError::failed(format!("\"{raw}\" is not a date")))?,
    };
    let to = match text(params, "rangeEnd") {
        raw if raw.trim().is_empty() => from + Span::days(7),
        raw => moment(&raw, graph.zone).ok_or_else(|| NodeError::failed(format!("\"{raw}\" is not a date")))?,
    };
    let limit = limit_of(params, "eventLimit", 50);
    let query = vec![
        ("startDateTime", from.to_rfc3339()),
        ("endDateTime", to.to_rfc3339()),
        ("$orderby", "start/dateTime".into()),
        ("$top", limit.min(100).to_string()),
        ("$select", EVENT_FIELDS.into()),
    ];
    // The calendar view takes no search: the words are looked for here, in the title and the text.
    let search = text(params, "eventSearch").trim().to_lowercase();
    let matches = |event: &Value| {
        search.is_empty()
            || [&event["subject"], &event["bodyPreview"]].iter().any(|field| field.as_str().is_some_and(|text| text.to_lowercase().contains(&search)))
    };
    let events = graph.pages("Calendar list", &format!("{base}/calendarView"), query, Some(&prefer), limit, matches).await?;
    Ok(events.iter().map(event_json).collect())
}

// -------------------------------------------------------------------------------------- OneDrive

/// A OneDrive item in the Google node's file shape.
pub fn file_json(item: &Value) -> Value {
    let folder = item.get("folder").is_some_and(|f| !f.is_null());
    json!({
        "id": item["id"],
        "name": item["name"],
        "mimeType": if folder { json!("folder") } else { item["file"]["mimeType"].clone() },
        "size": item["size"],
        "modifiedTime": item["lastModifiedDateTime"],
        "webViewLink": item["webUrl"],
        "parents": item["parentReference"]["path"].as_str().map(|p| json!([p.trim_start_matches("/drive/root:")])).unwrap_or(json!([])),
        "folder": folder,
    })
}

async fn onedrive(graph: &Graph<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    match text(params, "onedriveOp").as_str() {
        "driveUpload" => {
            let path = expand(&required(params, "filePath", "the file to upload")?);
            let size = tokio::fs::metadata(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?.len();
            if size > UPLOAD_LIMIT {
                return Err(NodeError::failed(format!("{} is over 250 MB, more than one OneDrive upload takes", path.display())));
            }
            let bytes = tokio::fs::read(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
            let name = match text(params, "fileName") {
                given if !given.trim().is_empty() => given.trim().to_string(),
                _ => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
            };
            let folder = drive_path(&text(params, "onedriveFolder"));
            let target = if folder.is_empty() { urlencode(&name) } else { format!("{folder}/{}", urlencode(&name)) };
            let conflict = if flag(params, "overwrite") { "replace" } else { "rename" };
            let request = graph
                .client
                .put(format!("{GRAPH}/me/drive/root:/{target}:/content"))
                .query(&[("@microsoft.graph.conflictBehavior", conflict)])
                .header("Content-Type", mime_of(&path))
                .body(bytes);
            let text = graph.send("OneDrive upload", request).await?.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
            let item: Value = serde_json::from_str(&text).map_err(|_| NodeError::failed("OneDrive did not answer JSON"))?;
            Ok(vec![file_json(&item)])
        }
        "driveDownload" => {
            let file = required(params, "onedriveFile", "the file (its path or id)")?;
            let folder = expand(&required(params, "folder", "the folder to save into")?);
            let url = item_url(&file);
            let item = graph.json("OneDrive file", Method::GET, &url, &[("$select", ITEM_FIELDS.into())], None, None).await?;
            let name = match text(params, "fileName") {
                given if !given.trim().is_empty() => given.trim().to_string(),
                _ => item["name"].as_str().unwrap_or("file").to_string(),
            };
            // `/content` answers with a redirect to a link that needs no token.
            let bytes = graph.send("OneDrive download", graph.client.get(format!("{url}/content"))).await?.bytes().await.map_err(|e| NodeError::failed(e.to_string()))?;
            tokio::fs::create_dir_all(&folder).await.map_err(|e| NodeError::failed(format!("Could not create {}: {e}", folder.display())))?;
            let path = free_path(&folder, &safe_name(&name), flag(params, "overwrite"));
            tokio::fs::write(&path, &bytes).await.map_err(|e| NodeError::failed(format!("Could not write {}: {e}", path.display())))?;
            let mut json = file_json(&item);
            json["path"] = json!(path.to_string_lossy());
            json["size"] = json!(bytes.len());
            Ok(vec![json])
        }
        _ => {
            let limit = limit_of(params, "fileLimit", 50);
            let folder = drive_path(&text(params, "onedriveFolder"));
            let search = text(params, "onedriveSearch");
            let url = match (search.trim().is_empty(), folder.is_empty()) {
                (false, _) => format!("{GRAPH}/me/drive/root/search(q='{}')", urlencode(&search.trim().replace('\'', "''"))),
                (true, true) => format!("{GRAPH}/me/drive/root/children"),
                (true, false) => format!("{GRAPH}/me/drive/root:/{folder}:/children"),
            };
            let query = vec![("$top", limit.min(200).to_string()), ("$select", ITEM_FIELDS.into())];
            let items = graph.pages("OneDrive list", &url, query, None, limit, |_| true).await?;
            Ok(items.iter().map(file_json).collect())
        }
    }
}

// ----------------------------------------------------------------------------------------- Excel

/// Where a used range starts: `Hoja1!B3:F20` → row 3, column 1 (B). An empty sheet answers `A1`.
pub fn range_start(address: &str) -> (usize, usize) {
    let cell = address.rsplit('!').next().unwrap_or(address).split(':').next().unwrap_or("A1");
    let letters: String = cell.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits: String = cell.chars().skip_while(|c| c.is_ascii_alphabetic()).take_while(|c| c.is_ascii_digit()).collect();
    let column = letters.to_ascii_uppercase().bytes().fold(0usize, |acc, b| acc * 26 + (b - b'A' + 1) as usize).saturating_sub(1);
    (digits.parse().unwrap_or(1).max(1), column)
}

/// A rectangle in A1 notation: from (row, column) over `rows` × `columns` cells.
pub fn a1(row: usize, column: usize, rows: usize, columns: usize) -> String {
    format!("{}{row}:{}{}", column_letters(column), column_letters(column + columns.max(1) - 1), row + rows.max(1) - 1)
}

struct Sheet {
    /// `…/workbook/worksheets/<name>`.
    url: String,
    values: Vec<Value>,
    /// The used range's first row (1-based) and column (0-based).
    row: usize,
    column: usize,
}

impl Sheet {
    /// The sheet holds nothing — Excel still answers one empty cell.
    fn is_empty(&self) -> bool {
        self.values.iter().all(|row| row.as_array().is_none_or(|cells| cells.iter().all(|c| c.is_null() || c.as_str() == Some(""))))
    }
}

async fn sheet(graph: &Graph<'_>, params: &Value) -> Result<Sheet, NodeError> {
    let workbook = required(params, "workbook", "the workbook (its OneDrive path or id)")?;
    let worksheet = required(params, "worksheet", "the worksheet's name")?;
    let url = format!("{}/workbook/worksheets/{}", item_url(&workbook), urlencode(&worksheet));
    let answer = graph.json("Excel read", Method::GET, &format!("{url}/usedRange(valuesOnly=true)"), &[("$select", "address,values".into())], None, None).await?;
    let (row, column) = range_start(answer["address"].as_str().unwrap_or("A1"));
    Ok(Sheet { url, values: answer["values"].as_array().cloned().unwrap_or_default(), row, column })
}

async fn write_range(graph: &Graph<'_>, sheet: &Sheet, row: usize, values: &[Vec<Value>]) -> Result<(), NodeError> {
    let columns = values.iter().map(Vec::len).max().unwrap_or(0);
    if values.is_empty() || columns == 0 {
        return Ok(());
    }
    let address = a1(row, sheet.column, values.len(), columns);
    let url = format!("{}/range(address='{address}')", sheet.url);
    graph.json("Excel write", Method::PATCH, &url, &[("$select", "address".into())], Some(&json!({"values": values})), None).await?;
    Ok(())
}

async fn excel_read(graph: &Graph<'_>, params: &Value) -> Result<Vec<Value>, NodeError> {
    let sheet = sheet(graph, params).await?;
    if sheet.is_empty() {
        return Ok(Vec::new());
    }
    Ok(rows_to_items(&sheet.values, flag(params, "header"), number(params, "rowLimit").map(|n| n.max(0.0) as usize).unwrap_or(0)))
}

async fn excel_append(graph: &Graph<'_>, rows: &[(usize, Value, Map<String, Value>)]) -> Result<Vec<(usize, Value)>, NodeError> {
    let Some((_, params, _)) = rows.first() else { return Ok(Vec::new()) };
    let sheet = sheet(graph, params).await?;
    let mut values: Vec<Vec<Value>> = Vec::new();
    let (mut headers, first_row) = if sheet.is_empty() {
        // An empty sheet: its header row is the rows' fields, in the order they first appear.
        let mut headers: Vec<String> = Vec::new();
        for (_, _, row) in rows {
            for key in row.keys() {
                if !headers.contains(key) {
                    headers.push(key.clone());
                }
            }
        }
        values.push(headers.iter().map(|h| json!(h)).collect());
        (headers, sheet.row)
    } else {
        (headers_of(&sheet.values), sheet.row + sheet.values.len())
    };
    headers.truncate(headers.iter().rposition(|h| !h.trim().is_empty()).map_or(0, |last| last + 1));
    let mut skipped: Vec<String> = Vec::new();
    for (_, _, row) in rows {
        let (cells, left_out) = cells_for(&headers, row);
        values.push(cells);
        skipped.extend(left_out.into_iter().filter(|key| !skipped.contains(key)).collect::<Vec<_>>());
    }
    if !skipped.is_empty() {
        graph.ctx.log(LogStream::Info, &format!("Not in the sheet's header, so not written: {}", skipped.join(", ")));
    }
    write_range(graph, &sheet, first_row, &values).await?;
    let header_rows = if sheet.is_empty() { 1 } else { 0 };
    Ok(rows
        .iter()
        .enumerate()
        .map(|(n, (index, _, row))| {
            let mut json = Value::Object(row.clone());
            json["_row"] = json!(first_row + header_rows + n);
            (*index, json)
        })
        .collect())
}

/// The cells an update writes to one row: the item's value under each header it names, `null`
/// (left as it is) under the rest.
pub fn update_cells(headers: &[String], row: &Map<String, Value>) -> Vec<Value> {
    headers.iter().map(|header| row.get(header).map(to_cell).unwrap_or(Value::Null)).collect()
}

async fn excel_update(graph: &Graph<'_>, rows: &[(usize, Value, Map<String, Value>)]) -> Result<Vec<(usize, Value)>, NodeError> {
    let Some((_, first, _)) = rows.first() else { return Ok(Vec::new()) };
    let match_column = required(first, "matchColumn", "the column that finds the row")?;
    let sheet = sheet(graph, first).await?;
    let headers = headers_of(&sheet.values);
    let key_index = headers
        .iter()
        .position(|h| h == &match_column)
        .ok_or_else(|| NodeError::failed(format!("The sheet has no \"{match_column}\" column")))?;
    let append_missing = text(first, "ifMissing") == "appendRow";
    let cell = |cells: &Value, index: usize| match cells.as_array().and_then(|c| c.get(index)) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let mut appended = Vec::new();
    let mut out = Vec::new();
    for (index, params, row) in rows {
        let wanted = match text(params, "matchValue") {
            value if !value.trim().is_empty() => value,
            _ => match row.get(&match_column) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            },
        };
        let found = sheet.values.iter().skip(1).position(|cells| cell(cells, key_index) == wanted);
        let mut json = Value::Object(row.clone());
        match found {
            Some(position) => {
                let sheet_row = sheet.row + 1 + position;
                write_range(graph, &sheet, sheet_row, &[update_cells(&headers, row)]).await?;
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
    write_range(graph, &sheet, sheet.row + sheet.values.len(), &appended).await?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_outlook_message_reads_like_a_gmail_one() {
        let message = json!({
            "id": "AAMk1", "conversationId": "c1", "subject": "Factura 42", "isRead": false, "hasAttachments": true,
            "from": {"emailAddress": {"name": "Ana", "address": "ana@example.com"}},
            "toRecipients": [{"emailAddress": {"address": "yo@example.com"}}, {"emailAddress": {"address": "b@example.com"}}],
            "receivedDateTime": "2026-10-06T10:00:00Z", "bodyPreview": "Hola", "body": {"contentType": "text", "content": "Hola, adjunto."},
        });
        let shaped = read_message(&message);
        assert_eq!(shaped["from"], "ana@example.com");
        assert_eq!(shaped["fromName"], "Ana");
        assert_eq!(shaped["to"], "yo@example.com, b@example.com");
        assert_eq!(shaped["unread"], true);
        assert_eq!(shaped["text"], "Hola, adjunto.");
        assert_eq!(shaped["html"], "");
        assert_eq!(shaped["threadId"], "c1");
    }

    #[test]
    fn events_and_files_take_the_google_shapes() {
        let event = json!({
            "id": "e1", "subject": "Deploy", "isAllDay": false, "isCancelled": false,
            "start": {"dateTime": "2026-10-06T09:30:00.0000000", "timeZone": "America/Santiago"},
            "end": {"dateTime": "2026-10-06T10:30:00.0000000", "timeZone": "America/Santiago"},
            "organizer": {"emailAddress": {"address": "ana@example.com"}},
            "attendees": [{"emailAddress": {"address": "bo@example.com"}, "type": "required"}],
            "onlineMeeting": {"joinUrl": "https://teams.example.com/l/1"},
        });
        let shaped = event_json(&event);
        assert_eq!(shaped["summary"], "Deploy");
        assert_eq!(shaped["attendees"], json!(["bo@example.com"]));
        assert_eq!(shaped["meetLink"], "https://teams.example.com/l/1");
        assert_eq!(shaped["status"], "confirmed");

        let file = json!({"id": "01AB", "name": "q3.xlsx", "size": 2048, "file": {"mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
                          "webUrl": "https://example-my.sharepoint.com/q3.xlsx", "parentReference": {"path": "/drive/root:/Informes"}});
        let shaped = file_json(&file);
        assert_eq!(shaped["parents"], json!(["/Informes"]));
        assert_eq!(shaped["folder"], false);
        assert_eq!(file_json(&json!({"id": "f", "name": "Informes", "folder": {"childCount": 3}}))["mimeType"], "folder");
    }

    #[test]
    fn items_are_named_by_path_or_id_and_ranges_in_a1() {
        assert_eq!(item_url("01BYE5RZ6QN3"), format!("{GRAPH}/me/drive/items/01BYE5RZ6QN3"));
        assert_eq!(item_url("/Documentos/Ventas 2026.xlsx"), format!("{GRAPH}/me/drive/root:/Documentos/Ventas%202026.xlsx:"));
        assert_eq!(item_url("informe.pdf"), format!("{GRAPH}/me/drive/root:/informe.pdf:"));
        assert_eq!(range_start("Hoja1!B3:F20"), (3, 1));
        assert_eq!(range_start("'Hoja 1'!A1"), (1, 0));
        assert_eq!(range_start("Sheet1!AA10:AC12"), (10, 26));
        assert_eq!(a1(5, 1, 2, 3), "B5:D6");
        assert_eq!(a1(1, 0, 1, 1), "A1:A1");
    }

    #[test]
    fn an_update_leaves_the_columns_it_does_not_name_alone() {
        let headers = vec!["id".to_string(), "estado".to_string(), "total".to_string()];
        let row: Map<String, Value> = serde_json::from_value(json!({"id": 7, "estado": "pagado"})).unwrap();
        assert_eq!(update_cells(&headers, &row), vec![json!(7), json!("pagado"), Value::Null]);
    }
}
