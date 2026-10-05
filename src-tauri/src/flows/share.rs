//! Flows shared through the user's own Supabase project — the API collections' sharing
//! (`crate::supabase`), one document at a time.
//!
//! **A share is one flow, and one item.** The share's id is the flow's id on every machine that
//! holds it, and its single `cf_items` row (kind `flow`) carries the document with the name and
//! description — never whether the flow is active, never its trust, never the folder it is filed
//! in: those are each machine's own.
//!
//! **Three clocks decide a round** ([`decide`]): the flow's own `updated_at` here, the remote item's,
//! and the `base` both last agreed on. Moved here only → push; moved there only → apply; both → a
//! conflict, frozen (the remote version kept aside, neither applied nor overwritten) until the user
//! picks a side — unless both sides hold the same document, which is agreement, not a conflict.
//! Pull first, then decide, then push: for a single document that order means a round never sends
//! over a change it has not seen.
//!
//! **A teammate's version never carries trust.** It is applied like an import: what it runs is not
//! what this user reviewed, so a flow whose commands changed that way goes back to "not reviewed"
//! (and an active one is switched off by the caller when it can no longer be armed).

use serde::Serialize;
use serde_json::{json, Value};

use super::spec;
use crate::db::api_sync::same_instant;
use crate::db::flow_queries::{self, FlowMeta, FlowRow};
use crate::db::flow_share_queries::{self as shares, FlowShareRow};
use crate::db::Db;
use crate::supabase::{self, SharedItem};

/// The `cf_items.kind` of a shared flow.
pub const ITEM_KIND: &str = "flow";

/// What travels.
pub fn payload_of(row: &FlowRow) -> Value {
    json!({
        "name": row.meta.name,
        "description": row.meta.description,
        "spec": serde_json::from_str::<Value>(&row.spec).unwrap_or(Value::Null),
    })
}

fn item_of(row: &FlowRow) -> SharedItem {
    SharedItem {
        id: row.meta.id.clone(),
        share_id: row.meta.id.clone(),
        kind: ITEM_KIND.to_string(),
        payload: payload_of(row),
        updated_at: row.meta.updated_at.clone(),
        synced_at: String::new(),
        deleted: false,
    }
}

/// What one round does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Nothing,
    Push,
    Apply,
    /// Both moved to the same document.
    Agree,
    Conflict,
}

/// The merge, from the three clocks. Pure, so it is tested without a project.
pub fn decide(local_at: &str, base: &str, remote_at: Option<&str>, same_document: bool) -> Step {
    let local_moved = !same_instant(local_at, base);
    let remote_moved = remote_at.is_some_and(|at| !same_instant(at, base));
    match (local_moved, remote_moved) {
        (false, false) => Step::Nothing,
        (true, false) => Step::Push,
        (false, true) => Step::Apply,
        (true, true) if same_document => Step::Agree,
        (true, true) => Step::Conflict,
    }
}

/// How a round ended, for the poller and the editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Round {
    /// `synced` or `conflict`.
    pub state: &'static str,
    /// A teammate's version was written here: the open editor reloads it.
    pub applied: bool,
    pub pushed: bool,
    /// The flow after an applied version — the caller re-arms or disarms an active one.
    pub meta: Option<FlowMeta>,
}

fn lock(db: &Db) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

/// The newest of the pulled items' server clocks — where the next pull starts.
fn cursor_after(items: &[SharedItem], before: &str) -> String {
    items
        .iter()
        .map(|item| item.synced_at.as_str())
        .chain(std::iter::once(before))
        .filter(|at| !at.is_empty())
        .max_by_key(|at| chrono::DateTime::parse_from_rfc3339(at).map(|t| t.timestamp_micros()).unwrap_or(i64::MIN))
        .unwrap_or_default()
        .to_string()
}

/// Writes a remote version over the local flow, as `apply_shared` does: history kept, trust not
/// carried, the remote's clock taken.
fn apply(conn: &rusqlite::Connection, flow_id: &str, payload: &Value, updated_at: &str) -> Result<Option<FlowMeta>, String> {
    let text = serde_json::to_string(payload.get("spec").unwrap_or(&Value::Null)).map_err(|e| e.to_string())?;
    let parsed = spec::parse(&text).map_err(|e| format!("The shared version cannot be read here: {e}"))?;
    let derived = spec::derive(&parsed);
    let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let current = flow_queries::get_meta(conn, flow_id).map_err(|e| e.to_string())?.ok_or("The shared flow is no longer here")?;
    let name = Some(field("name")).filter(|name| !name.is_empty()).unwrap_or(current.name);
    flow_queries::apply_shared(conn, flow_id, &name, &field("description"), &text, &derived, updated_at).map_err(|e| e.to_string())
}

/// One round: pull what changed there, decide, push what changed here.
pub async fn sync(db: &Db, flow_id: &str) -> Result<Round, String> {
    let (share, row) = {
        let conn = lock(db)?;
        let share = shares::get(&conn, flow_id).map_err(|e| e.to_string())?.ok_or("This flow is not shared")?;
        let row = flow_queries::get_flow(&conn, flow_id).map_err(|e| e.to_string())?.ok_or("The shared flow is no longer here")?;
        (share, row)
    };
    if share.conflict.is_some() {
        return Ok(Round { state: "conflict", applied: false, pushed: false, meta: None });
    }
    let url = share.project_url.clone();
    let pulled = match supabase::pull(url.clone(), flow_id.to_string(), share.cursor.clone()).await {
        Ok(items) => items,
        Err(error) => {
            let _ = shares::record_error(&*lock(db)?, flow_id, &error);
            return Err(error);
        }
    };
    let cursor = cursor_after(&pulled, &share.cursor);
    let remote = pulled.iter().rev().find(|item| item.kind == ITEM_KIND && item.id == flow_id && !item.deleted);
    let same = remote.is_some_and(|item| item.payload == payload_of(&row));
    let step = decide(&row.meta.updated_at, &share.base, remote.map(|item| item.updated_at.as_str()), same);
    let stamp = crate::db::queries::now();
    let mut round = Round { state: "synced", applied: false, pushed: false, meta: None };
    match step {
        Step::Nothing => shares::record_round(&*lock(db)?, flow_id, &cursor, &share.base, &stamp).map_err(|e| e.to_string())?,
        Step::Push => {
            if let Err(error) = supabase::push(url, flow_id.to_string(), vec![item_of(&row)]).await {
                let _ = shares::record_error(&*lock(db)?, flow_id, &error);
                return Err(error);
            }
            // The base moves the instant the push is acknowledged: otherwise its own echo would
            // look like a teammate's change on the next pull.
            shares::record_round(&*lock(db)?, flow_id, &cursor, &row.meta.updated_at, &stamp).map_err(|e| e.to_string())?;
            round.pushed = true;
        }
        Step::Apply => {
            let remote = remote.expect("an apply has a remote version");
            let conn = lock(db)?;
            round.meta = apply(&conn, flow_id, &remote.payload, &remote.updated_at)?;
            shares::record_round(&conn, flow_id, &cursor, &remote.updated_at, &stamp).map_err(|e| e.to_string())?;
            round.applied = true;
        }
        Step::Agree => {
            let remote = remote.expect("an agreement has a remote version");
            let conn = lock(db)?;
            flow_queries::set_updated_at(&conn, flow_id, &remote.updated_at).map_err(|e| e.to_string())?;
            shares::record_round(&conn, flow_id, &cursor, &remote.updated_at, &stamp).map_err(|e| e.to_string())?;
        }
        Step::Conflict => {
            let remote = remote.expect("a conflict has a remote version");
            shares::freeze(&*lock(db)?, flow_id, &cursor, &remote.payload.to_string(), &remote.updated_at).map_err(|e| e.to_string())?;
            round.state = "conflict";
        }
    }
    Ok(round)
}

/// The poller's call: a full round only when something moved — here (the flow's clock left the
/// base) or there (the share's watermark passed the cursor). A watermark is one indexed row, cheap
/// enough to ask every few seconds; it is also how a revoked invitation is noticed.
pub async fn tick(db: &Db, flow_id: &str) -> Result<Option<Round>, String> {
    let (share, local_at) = {
        let conn = lock(db)?;
        let Some(share) = shares::get(&conn, flow_id).map_err(|e| e.to_string())? else { return Ok(None) };
        let local_at = flow_queries::get_meta(&conn, flow_id).map_err(|e| e.to_string())?.map(|meta| meta.updated_at);
        (share, local_at)
    };
    if share.conflict.is_some() {
        return Ok(None);
    }
    let Some(local_at) = local_at else { return Ok(None) };
    if !same_instant(&local_at, &share.base) {
        return sync(db, flow_id).await.map(Some);
    }
    let mark = match supabase::watermark(share.project_url.clone(), flow_id.to_string()).await {
        Ok(mark) => mark,
        Err(error) => {
            let _ = shares::record_error(&*lock(db)?, flow_id, &error);
            return Err(error);
        }
    };
    if mark.is_empty() || same_instant(&mark, &share.cursor) {
        return Ok(None);
    }
    sync(db, flow_id).await.map(Some)
}

/// Starts sharing a flow from this machine, and sends it straight away so a guest finds it.
pub async fn share(db: &Db, url: &str, flow_id: &str) -> Result<supabase::SharedCollection, String> {
    let row = flow_queries::get_flow(&*lock(db)?, flow_id).map_err(|e| e.to_string())?.ok_or("This flow no longer exists")?;
    let shared = supabase::share(url.to_string(), flow_id.to_string(), row.meta.name.clone()).await?;
    shares::insert(&*lock(db)?, flow_id, url, &row.meta.name, "owner").map_err(|e| e.to_string())?;
    supabase::push(url.to_string(), flow_id.to_string(), vec![item_of(&row)]).await?;
    shares::record_round(&*lock(db)?, flow_id, "", &row.meta.updated_at, &crate::db::queries::now()).map_err(|e| e.to_string())?;
    Ok(shared)
}

/// Accepts an invitation: the shared flow lands in `workspace_id` (and `folder_id`), not reviewed,
/// under the share's id.
pub async fn join(db: &Db, url: &str, token: &str, workspace_id: &str, folder_id: Option<&str>) -> Result<FlowMeta, String> {
    let shared = supabase::join(url.to_string(), token.to_string()).await?;
    let id = shared.id.clone();
    let already = {
        let conn = lock(db)?;
        let here = flow_queries::get_meta(&conn, &id).map_err(|e| e.to_string())?.is_some();
        let shared_here = shares::get(&conn, &id).map_err(|e| e.to_string())?.is_some();
        (here, shared_here)
    };
    if already.0 {
        if !already.1 {
            let _ = supabase::leave(&id);
        }
        return Err("That flow is already on this computer".into());
    }
    let items = supabase::pull(url.to_string(), id.clone(), String::new()).await?;
    let Some(item) = items.iter().rev().find(|item| item.kind == ITEM_KIND && item.id == id && !item.deleted) else {
        let _ = supabase::leave(&id);
        return Err(if items.is_empty() {
            "That shared flow has nothing in it yet — ask its host to open it once".into()
        } else {
            "That invitation is for an API collection, not a flow".into()
        });
    };
    let text = serde_json::to_string(item.payload.get("spec").unwrap_or(&Value::Null)).map_err(|e| e.to_string())?;
    let parsed = spec::parse(&text).map_err(|e| format!("The shared flow cannot be read here: {e}"))?;
    let derived = spec::derive(&parsed);
    let name = item.payload.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&shared.name).to_string();
    let description = item.payload.get("description").and_then(Value::as_str).unwrap_or_default().to_string();
    let conn = lock(db)?;
    flow_queries::create_flow_as(&conn, &id, workspace_id, folder_id, &name, &text, &derived, false).map_err(|e| e.to_string())?;
    if !description.is_empty() {
        flow_queries::set_description(&conn, &id, &description).map_err(|e| e.to_string())?;
    }
    flow_queries::set_updated_at(&conn, &id, &item.updated_at).map_err(|e| e.to_string())?;
    shares::insert(&conn, &id, url, &name, "member").map_err(|e| e.to_string())?;
    shares::record_round(&conn, &id, &cursor_after(&items, ""), &item.updated_at, &crate::db::queries::now()).map_err(|e| e.to_string())?;
    flow_queries::get_meta(&conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "The flow was not written".into())
}

/// The user picked a side of a conflict. Theirs is applied now; mine goes out on this round.
pub async fn resolve(db: &Db, flow_id: &str, keep_mine: bool) -> Result<Round, String> {
    let share: FlowShareRow = shares::get(&*lock(db)?, flow_id).map_err(|e| e.to_string())?.ok_or("This flow is not shared")?;
    let (Some(payload), Some(at)) = (share.conflict.clone(), share.conflict_at.clone()) else {
        return sync(db, flow_id).await;
    };
    if keep_mine {
        // Agreed on theirs as the base, so this flow's own clock reads as "moved here": it is sent.
        shares::thaw(&*lock(db)?, flow_id, &at).map_err(|e| e.to_string())?;
        return sync(db, flow_id).await;
    }
    let payload: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let meta = {
        let conn = lock(db)?;
        let meta = apply(&conn, flow_id, &payload, &at)?;
        shares::thaw(&conn, flow_id, &at).map_err(|e| e.to_string())?;
        meta
    };
    Ok(Round { state: "synced", applied: true, pushed: false, meta })
}

/// Stops sharing here: the flow stays, its token and the row go. The remote copy is the host's to
/// end (by issuing a new code).
pub fn leave(db: &Db, flow_id: &str) -> Result<(), String> {
    supabase::leave(flow_id)?;
    shares::forget(&*lock(db)?, flow_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_clocks_decide_a_round() {
        let base = "2026-10-05T10:00:00.123450+00:00";
        // Postgres prints the same instant its own way: not a change.
        assert_eq!(decide(base, base, Some("2026-10-05T10:00:00.12345+00:00"), false), Step::Nothing);
        assert_eq!(decide(base, base, None, false), Step::Nothing);
        assert_eq!(decide("2026-10-05T11:00:00+00:00", base, None, false), Step::Push);
        assert_eq!(decide("2026-10-05T11:00:00+00:00", base, Some(base), false), Step::Push);
        assert_eq!(decide(base, base, Some("2026-10-05T12:00:00+00:00"), false), Step::Apply);
        assert_eq!(decide("2026-10-05T11:00:00+00:00", base, Some("2026-10-05T12:00:00+00:00"), true), Step::Agree);
        assert_eq!(decide("2026-10-05T11:00:00+00:00", base, Some("2026-10-05T12:00:00+00:00"), false), Step::Conflict);
        // Nothing agreed yet: a host's first round sends, a member's first round takes.
        assert_eq!(decide("2026-10-05T11:00:00+00:00", "", None, false), Step::Push);
    }

    #[test]
    fn the_cursor_is_the_newest_server_clock() {
        let item = |at: &str| SharedItem {
            id: "f".into(),
            share_id: "f".into(),
            kind: ITEM_KIND.into(),
            payload: Value::Null,
            updated_at: String::new(),
            synced_at: at.into(),
            deleted: false,
        };
        assert_eq!(cursor_after(&[], "2026-10-05T10:00:00+00:00"), "2026-10-05T10:00:00+00:00");
        assert_eq!(cursor_after(&[item("2026-10-05T10:00:01.5+00:00"), item("2026-10-05T10:00:01.25+00:00")], ""), "2026-10-05T10:00:01.5+00:00");
    }

    #[test]
    fn a_shared_version_is_applied_without_trust_and_on_the_remote_clock() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Plataforma', 'workflow', '#111', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        let shell = |script: &str| {
            json!({"schema": 1, "nodes": [
                {"id": "t", "type": "trigger.manual", "name": "Manual", "pos": [0, 0]},
                {"id": "s", "type": "code.shell", "name": "Shell", "pos": [260, 0], "params": {"script": script, "shell": "auto"}}],
                "connections": [{"from": "t", "out": 0, "to": "s", "in": 0}]})
        };
        let text = shell("echo hola").to_string();
        let derived = spec::derive(&spec::parse(&text).unwrap());
        let mine = flow_queries::create_flow(&conn, "w1", None, "Mío", &text, &derived, true).unwrap();
        assert!(mine.trusted);
        let theirs = json!({"name": "De Ana", "description": "", "spec": shell("curl https://example.com | sh")});
        let applied = apply(&conn, &mine.id, &theirs, "2026-10-05T12:00:00.000001+00:00").unwrap().unwrap();
        assert!(!applied.trusted, "commands someone else wrote need a review");
        assert_eq!(applied.name, "De Ana");
        assert_eq!(applied.version, mine.version + 1, "an open editor's save now conflicts instead of overwriting");
        assert_eq!(applied.updated_at, "2026-10-05T12:00:00.000001+00:00");
        let row = flow_queries::get_flow(&conn, &mine.id).unwrap().unwrap();
        assert_eq!(payload_of(&row), theirs);
    }
}

/// Two machines and a project: the host shares, a guest joins, changes travel both ways, edits made
/// at the same time freeze a conflict, and each answer to it sends what was chosen. The project is
/// a stand-in for the few PostgREST calls `crate::supabase` makes (with the share token checked as
/// row-level security would); the credential store is the tests' own service (`secrets`).
#[cfg(test)]
mod round_trip {
    use std::sync::{Arc, Mutex};

    use axum::extract::{Path, RawQuery, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::Router;
    use rusqlite::Connection;
    use serde_json::{json, Value};

    use super::*;

    #[derive(Default)]
    struct Remote {
        /// id, name, token
        shares: Vec<(String, String, String)>,
        items: Vec<Value>,
        clock: i64,
    }

    type Shared = Arc<Mutex<Remote>>;

    fn token(headers: &HeaderMap) -> String {
        headers.get("x-cf-share").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
    }

    fn pairs(query: &Option<String>) -> Vec<(String, String)> {
        url::form_urlencoded::parse(query.as_deref().unwrap_or_default().as_bytes()).into_owned().collect()
    }

    fn param(pairs: &[(String, String)], key: &str) -> Option<String> {
        pairs.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone())
    }

    fn owns(remote: &Remote, share_id: &str, token: &str) -> bool {
        !token.is_empty() && remote.shares.iter().any(|(id, _, t)| id == share_id && t == token)
    }

    async fn create_share(State(remote): State<Shared>, headers: HeaderMap, body: String) -> (StatusCode, String) {
        let row: Value = serde_json::from_str(&body).unwrap();
        let (id, name, given) = (row["id"].as_str().unwrap().to_string(), row["name"].as_str().unwrap().to_string(), row["share_token"].as_str().unwrap().to_string());
        if token(&headers) != given {
            return (StatusCode::UNAUTHORIZED, json!({"message": "row-level security"}).to_string());
        }
        let mut remote = remote.lock().unwrap();
        remote.shares.retain(|(existing, _, _)| existing != &id);
        remote.shares.push((id, name, given));
        (StatusCode::CREATED, json!([row]).to_string())
    }

    async fn read_shares(State(remote): State<Shared>, headers: HeaderMap) -> String {
        let remote = remote.lock().unwrap();
        let mine = token(&headers);
        Value::Array(remote.shares.iter().filter(|(_, _, t)| !mine.is_empty() && t == &mine).map(|(id, name, _)| json!({"id": id, "name": name})).collect())
            .to_string()
    }

    async fn rpc(State(remote): State<Shared>, Path(function): Path<String>, headers: HeaderMap, body: String) -> (StatusCode, String) {
        let mut remote = remote.lock().unwrap();
        let current = token(&headers);
        match function.as_str() {
            "cf_claim_owner" => (StatusCode::OK, "true".into()),
            "cf_rotate_token" => {
                let next = serde_json::from_str::<Value>(&body).unwrap()["new_token"].as_str().unwrap().to_string();
                for share in remote.shares.iter_mut().filter(|(_, _, t)| t == &current) {
                    share.2 = next.clone();
                }
                (StatusCode::NO_CONTENT, String::new())
            }
            _ => (StatusCode::NOT_FOUND, String::new()),
        }
    }

    async fn write_items(State(remote): State<Shared>, headers: HeaderMap, body: String) -> StatusCode {
        let items: Vec<Value> = serde_json::from_str(&body).unwrap();
        let mut remote = remote.lock().unwrap();
        let given = token(&headers);
        for mut item in items {
            if !owns(&remote, item["share_id"].as_str().unwrap(), &given) {
                return StatusCode::UNAUTHORIZED;
            }
            remote.clock += 1;
            let at = chrono::DateTime::from_timestamp_micros(1_790_000_000_000_000 + remote.clock).unwrap();
            item["synced_at"] = json!(at.to_rfc3339_opts(chrono::SecondsFormat::Micros, false));
            let id = item["id"].clone();
            remote.items.retain(|existing| existing["id"] != id);
            remote.items.push(item);
        }
        StatusCode::CREATED
    }

    async fn read_items(State(remote): State<Shared>, headers: HeaderMap, RawQuery(query): RawQuery) -> String {
        let remote = remote.lock().unwrap();
        let pairs = pairs(&query);
        let share_id = param(&pairs, "share_id").unwrap().trim_start_matches("eq.").to_string();
        if !owns(&remote, &share_id, &token(&headers)) {
            return "[]".into();
        }
        let since = param(&pairs, "synced_at").map(|value| value.trim_start_matches("gt.").to_string());
        let instant = |text: &str| chrono::DateTime::parse_from_rfc3339(text).unwrap();
        let mut rows: Vec<Value> = remote
            .items
            .iter()
            .filter(|item| item["share_id"] == share_id.as_str())
            .filter(|item| since.as_deref().is_none_or(|since| instant(item["synced_at"].as_str().unwrap()) > instant(since)))
            .cloned()
            .collect();
        rows.sort_by_key(|item| instant(item["synced_at"].as_str().unwrap()));
        if param(&pairs, "order").as_deref() == Some("synced_at.desc") {
            rows.reverse();
        }
        if let Some(limit) = param(&pairs, "limit").and_then(|limit| limit.parse::<usize>().ok()) {
            rows.truncate(limit);
        }
        if param(&pairs, "select").as_deref() == Some("synced_at") {
            rows = rows.into_iter().map(|item| json!({"synced_at": item["synced_at"]})).collect();
        }
        Value::Array(rows).to_string()
    }

    async fn project() -> String {
        let remote: Shared = Arc::default();
        let app = Router::new()
            .route("/rest/v1/cf_shares", post(create_share).get(read_shares))
            .route("/rest/v1/rpc/{function}", post(rpc))
            .route("/rest/v1/cf_items", post(write_items).get(read_items))
            .with_state(remote);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }

    fn machine() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Plataforma', 'workflow', '#111', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        Db(std::sync::Mutex::new(conn))
    }

    fn document(script: &str) -> String {
        json!({"schema": 1, "nodes": [
            {"id": "t", "type": "trigger.manual", "name": "Manual", "pos": [0, 0]},
            {"id": "s", "type": "code.shell", "name": "Shell", "pos": [260, 0], "params": {"script": script, "shell": "auto"}}],
            "connections": [{"from": "t", "out": 0, "to": "s", "in": 0}]})
        .to_string()
    }

    fn edit(db: &Db, id: &str, script: &str) {
        let text = document(script);
        let derived = spec::derive(&spec::parse(&text).unwrap());
        flow_queries::save_spec(&db.0.lock().unwrap(), id, &text, &derived, None, true).unwrap();
    }

    fn script_of(db: &Db, id: &str) -> String {
        let row = flow_queries::get_flow(&db.0.lock().unwrap(), id).unwrap().unwrap();
        serde_json::from_str::<Value>(&row.spec).unwrap()["nodes"][1]["params"]["script"].as_str().unwrap().to_string()
    }

    async fn later() {
        // Clocks with microseconds: two edits never share one.
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }

    #[tokio::test]
    async fn a_shared_flow_travels_both_ways_and_a_simultaneous_edit_waits_for_an_answer() {
        // Tokens and the project key go through the real credential store (the tests' own service).
        let _store = crate::secrets::test_store();
        let url = project().await;
        supabase::set_credentials(&url, "anon-key-for-tests").unwrap();
        let (host, guest) = (machine(), machine());
        let text = document("echo uno");
        let derived = spec::derive(&spec::parse(&text).unwrap());
        let flow = flow_queries::create_flow(&host.0.lock().unwrap(), "w1", None, "Pedidos", &text, &derived, true).unwrap();
        let id = flow.id.clone();

        let shared = share(&host, &url, &id).await.unwrap();
        let joined = join(&guest, &url, &shared.share_token, "w1", None).await.unwrap();
        assert_eq!((joined.id.as_str(), joined.name.as_str()), (id.as_str(), "Pedidos"));
        assert!(!joined.trusted, "commands from someone else arrive not reviewed");
        assert!(join(&guest, &url, &shared.share_token, "w1", None).await.unwrap_err().contains("already"));
        assert!(tick(&guest, &id).await.unwrap().is_none(), "nothing moved since the join");

        // Host → guest.
        later().await;
        edit(&host, &id, "echo dos");
        assert!(tick(&host, &id).await.unwrap().unwrap().pushed);
        let round = tick(&guest, &id).await.unwrap().unwrap();
        assert!(round.applied && !round.pushed);
        assert_eq!(script_of(&guest, &id), "echo dos");
        // The host's own echo comes back once (the watermark passed its cursor): read, not applied.
        let echo = tick(&host, &id).await.unwrap().unwrap();
        assert!(!echo.applied && !echo.pushed, "the host's own echo is not a change");
        assert!(tick(&host, &id).await.unwrap().is_none());

        // Guest → host: the host trusted its flow, but not this command.
        later().await;
        edit(&guest, &id, "echo tres");
        assert!(tick(&guest, &id).await.unwrap().unwrap().pushed);
        let round = tick(&host, &id).await.unwrap().unwrap();
        assert!(round.applied);
        assert!(!round.meta.unwrap().trusted);
        assert_eq!(script_of(&host, &id), "echo tres");

        // Both at once: the second to sync gets a conflict, and nothing is overwritten.
        later().await;
        edit(&host, &id, "echo host");
        assert!(tick(&host, &id).await.unwrap().unwrap().pushed);
        edit(&guest, &id, "echo invitado");
        assert_eq!(tick(&guest, &id).await.unwrap().unwrap().state, "conflict");
        assert_eq!(script_of(&guest, &id), "echo invitado");
        assert!(tick(&guest, &id).await.unwrap().is_none(), "a frozen share waits for its answer");
        // Keep mine: it goes out, and the host takes it.
        assert!(resolve(&guest, &id, true).await.unwrap().pushed);
        assert!(tick(&host, &id).await.unwrap().unwrap().applied);
        assert_eq!(script_of(&host, &id), "echo invitado");

        // Again, answered the other way: theirs replaces mine, and nothing goes back out.
        later().await;
        edit(&host, &id, "echo segundo host");
        tick(&host, &id).await.unwrap();
        edit(&guest, &id, "echo segundo invitado");
        assert_eq!(tick(&guest, &id).await.unwrap().unwrap().state, "conflict");
        assert!(resolve(&guest, &id, false).await.unwrap().applied);
        assert_eq!(script_of(&guest, &id), "echo segundo host");
        assert!(tick(&guest, &id).await.unwrap().is_none());

        // A new code locks the old one out; leaving keeps the flow.
        let next = supabase::rotate(url.clone(), id.clone()).await.unwrap();
        assert_ne!(next, shared.share_token);
        leave(&guest, &id).unwrap();
        assert!(flow_queries::get_meta(&guest.0.lock().unwrap(), &id).unwrap().is_some());
        leave(&host, &id).unwrap();
    }
}
