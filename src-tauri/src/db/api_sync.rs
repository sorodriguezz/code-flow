//! Translating one **collection** between the local tables and the shared `cf_items` rows.
//!
//! Both directions go through the backup module's shapes rather than a second serialisation of the
//! same records: a shared item's payload *is* an `ApiCollection`, `ApiFolder` or `ApiRequestRow`,
//! so applying a pull is the merge import that already exists and is tested.
//!
//! ## Why a base, and not last-write-wins
//!
//! The earlier design resolved every collision by comparing the two `updated_at`s and keeping the
//! newer one. That is not a merge, it is a coin toss with a timestamp for a referee: the losing
//! edit is deleted without anyone being told it existed. It also cannot tell "they changed this and
//! I didn't" from "we both did", which are the two cases that need different answers.
//!
//! So every record carries a **base**: the `updated_at` it had the last time this machine and the
//! server agreed about it (`api_sync_base`). That turns each incoming item into one of four states:
//!
//! | remote moved | local moved | outcome                                        |
//! |--------------|-------------|------------------------------------------------|
//! | no           | –           | nothing to do; the cursor still advances        |
//! | yes          | no          | apply it, and move the base to the new agreement|
//! | no           | yes         | ours is the only change; the push carries it    |
//! | yes          | yes         | **conflict** — freeze the record, ask the user  |
//!
//! A frozen record is neither applied nor pushed until someone picks a side (`resolve`), so nothing
//! is ever overwritten silently in either direction. Everything else in the collection keeps
//! syncing normally while one request waits for a decision — which is the whole point of resolving
//! per record rather than per collection.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::api_backup::{self, ApiBackup, BackupWorkspace, ImportOptions, ImportSummary};
use super::api_queries;
use super::api_secrets;
use super::api_trust;
use super::models::{ApiCollection, ApiFolder, ApiRequestRow};
use super::queries::now;
use crate::supabase::SharedItem;

/// What a sync round did. Split because the parts fail differently: an import that applied nothing
/// is a no-op, a deletion sweep that removed a hundred rows is not, and a conflict is neither.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncResult {
    pub applied: ImportSummary,
    pub deleted: i64,
    /// Records frozen this round, waiting for the user to pick a side.
    pub conflicts: i64,
    /// The newest server `synced_at` seen, so the next pull can ask for changes after it.
    pub cursor: String,
    /// `(kind, id)` of every record this round wrote, so the caller can seal a credential that
    /// arrived in the clear (an older peer's MQTT password) — which needs the credential store, and
    /// so cannot happen in here.
    #[serde(skip)]
    pub touched: Vec<(String, String)>,
}

/// One frozen record, with both sides attached so the UI can show the choice without a round trip.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncConflict {
    pub collection_id: String,
    pub collection_name: String,
    pub kind: String,
    pub id: String,
    /// What to call it: the local name, falling back to the incoming one when the record was
    /// deleted here.
    pub name: String,
    pub remote_name: String,
    /// The incoming record verbatim, as JSON — `{}` when the incoming change is a deletion.
    pub remote_payload: String,
    /// The local record verbatim, as JSON — `{}` when it was deleted here.
    pub local_payload: String,
    pub remote_updated_at: String,
    pub local_updated_at: String,
    pub remote_deleted: bool,
    pub local_deleted: bool,
    pub detected_at: String,
}

/// Which side of a conflict to keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    /// Keep the local record and let the next push overwrite theirs.
    Mine,
    /// Take the incoming record and drop the local edit.
    Theirs,
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Blanks a credential slot unless it only points at variables.
///
/// A `{{token}}` reference is how a team shares a request *without* sharing the token — the value
/// lives in each member's own environment — so it has to travel. Blanking it too, as this used to,
/// broke exactly that pattern: every teammate's request came back with an empty field where the
/// reference had been. A literal, and a sealed slot's marker, are credentials and never leave.
fn blank_unless_reference(slot: &mut serde_json::Value) {
    if slot.as_str().is_some_and(|text| !api_secrets::is_reference(text)) {
        *slot = serde_json::Value::String(String::new());
    }
}

/// Blanks the credential fields of a JSON `AuthConfig` string, leaving its shape intact.
pub(crate) fn redact_auth(raw: &str) -> String {
    if raw.trim().is_empty() {
        return raw.to_string();
    }
    let Ok(mut auth) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    api_secrets::auth_secret_slots(&mut auth, &mut |_, slot| blank_unless_reference(slot));
    forget_token_expiry(&mut auth);
    auth.to_string()
}

/// When this machine's OAuth 2 token expires is as local as the token itself: a teammate's copy would
/// describe a token nobody else holds, and send the next refresh at the wrong moment. Without this,
/// every automatic refresh rewrote a shared field, stamped the row and pushed it.
fn forget_token_expiry(auth: &mut serde_json::Value) {
    if let Some(slot) = auth.get_mut("oauth2").and_then(|oauth2| oauth2.get_mut("expiresAt")) {
        *slot = serde_json::Value::from(0);
    }
}

/// Shares only what Postman shares: the **initial** value of every variable, blanked too when the
/// variable is marked secret. The **current** value never travels — it is this machine's session
/// state, the slot a script writes a freshly minted token into, and publishing it is how a
/// `pm.collectionVariables.set('token', …)` in a login script used to hand that token to every
/// member of the collection on the next push.
pub(crate) fn redact_variables(raw: &str) -> String {
    let Ok(mut variables) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    let Some(list) = variables.as_array_mut() else {
        return raw.to_string();
    };
    for variable in list.iter_mut() {
        if let Some(slot) = variable.get_mut("currentValue") {
            *slot = serde_json::Value::String(String::new());
        }
        if variable.get("secret").and_then(|s| s.as_bool()) == Some(true) {
            if let Some(slot) = variable.get_mut("initialValue") {
                blank_unless_reference(slot);
            }
        }
    }
    variables.to_string()
}

/// Whether two versions of a column say the same thing once a push has redacted them — compared as
/// JSON, so key order and whitespace are not an edit. What `api_queries` asks before stamping a
/// write: a change a push would not carry (a credential, a current value) is not one to announce.
pub(crate) fn same_when_shared(before: &str, after: &str, redact: fn(&str) -> String) -> bool {
    let (before, after) = (redact(before), redact(after));
    match (
        serde_json::from_str::<serde_json::Value>(&before),
        serde_json::from_str::<serde_json::Value>(&after),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => before == after,
    }
}

// ---------------------------------------------------------------------------
// Initial and current values
// ---------------------------------------------------------------------------

/// Set once [`migrate_variable_split`] has run over this database.
const VARIABLE_SPLIT_FLAG: &str = "api_variables_split";

/// Empties every current value that merely repeats its initial value — "current empty" already
/// means "use the initial", so nothing resolves differently. Returns the new list, or `None` when
/// nothing changed.
///
/// It matters because only the initial value travels now. A current value is a local override, and
/// a stale copy of the initial is the worst kind: when a teammate changes the shared value, the copy
/// keeps winning on every machine that has one — which, for variables that came in through an
/// import (importers fill both fields), is every machine. A current value that differs from its
/// initial, or that is the only value (a script's token, a quick edit), is a real local override and
/// is left alone; promoting it to the initial would publish exactly what a script captured.
pub fn split_current_values(raw: &str) -> Option<String> {
    let mut variables = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let mut changed = false;
    for variable in variables.as_array_mut()? {
        let initial = variable.get("initialValue").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let Some(slot) = variable.get_mut("currentValue") else { continue };
        if slot.as_str().is_some_and(|current| !current.is_empty() && current == initial) {
            *slot = serde_json::Value::String(String::new());
            changed = true;
        }
    }
    changed.then(|| variables.to_string())
}

/// [`split_current_values`] over the given rows of `api_collections` or `api_environments`, without
/// touching `updated_at` — a current value is not something a push carries. Used after an import.
pub fn split_variables_of(conn: &Connection, table: &str, ids: &[String]) -> rusqlite::Result<usize> {
    let table = match table {
        "api_collections" => "api_collections",
        "api_environments" => "api_environments",
        _ => return Ok(0),
    };
    let mut changed = 0;
    for id in ids {
        let raw: Option<String> = conn
            .query_row(&format!("SELECT variables FROM {table} WHERE id = ?1"), params![id], |row| row.get(0))
            .optional()?;
        if let Some(next) = raw.as_deref().and_then(split_current_values) {
            changed += conn.execute(
                &format!("UPDATE {table} SET variables = ?2 WHERE id = ?1"),
                params![id, next],
            )?;
        }
    }
    Ok(changed)
}

/// The same over every collection and environment, once per database: the upgrade to "only the
/// initial value is shared". Flagged in `app_settings` only once there is something to have looked
/// at, so a database with no API data yet stays exactly as empty as it was.
pub fn migrate_variable_split(conn: &Connection) -> rusqlite::Result<()> {
    if super::queries::get_setting(conn, VARIABLE_SPLIT_FLAG)?.as_deref() == Some("1") {
        return Ok(());
    }
    let mut seen = 0usize;
    for table in ["api_collections", "api_environments"] {
        let ids: Vec<String> = {
            let mut stmt = conn.prepare(&format!("SELECT id FROM {table}"))?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        seen += ids.len();
        split_variables_of(conn, table, &ids)?;
    }
    if seen > 0 {
        super::queries::set_setting(conn, VARIABLE_SPLIT_FLAG, "1")?;
    }
    Ok(())
}

/// A request's `spec` carries its own auth block inside the JSON blob, and an MQTT password.
pub(crate) fn redact_spec(raw: &str) -> String {
    let Ok(mut spec) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    api_secrets::spec_secret_slots(&mut spec, &mut |_, slot| blank_unless_reference(slot));
    if let Some(auth) = spec.get_mut("auth") {
        forget_token_expiry(auth);
    }
    spec.to_string()
}

fn redacted_collection(mut c: ApiCollection) -> ApiCollection {
    c.auth = redact_auth(&c.auth);
    c.variables = redact_variables(&c.variables);
    c
}

fn redacted_folder(mut f: ApiFolder) -> ApiFolder {
    f.auth = redact_auth(&f.auth);
    f
}

fn redacted_request(mut r: ApiRequestRow) -> ApiRequestRow {
    r.spec = redact_spec(&r.spec);
    r
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

fn item(kind: &str, id: &str, collection_id: &str, updated_at: &str, payload: serde_json::Value) -> SharedItem {
    SharedItem {
        id: id.to_string(),
        share_id: collection_id.to_string(),
        kind: kind.to_string(),
        payload,
        updated_at: updated_at.to_string(),
        synced_at: String::new(),
        deleted: false,
    }
}

/// Everything in this collection, as rows to upsert remotely — live records and the tombstones of
/// everything deleted from it.
///
/// **Nothing marked secret leaves this machine.** The invitation code is the only credential the
/// shared project has, so anyone who ends up holding it can read every record in the collection —
/// which makes a synced production token a token published to whoever the code reaches. Secret
/// variable values and the credential half of every auth block are blanked here, exactly as they
/// are in a plaintext backup; the keys travel so each member fills in their own.
///
/// Redacting on the way out and not locally is what keeps this safe in both directions: the sender
/// keeps its own values, and a peer pulling the redacted copy back cannot overwrite them, because
/// the base moves with the push and the redacted echo therefore reads as "no remote change".
///
/// Every timestamp is the record's own `updated_at`, never `now()`. A record re-stamped on each
/// push would look changed forever: every peer would pull it back every cycle, that pull would
/// count as a change, and the change would schedule another push. The loop is silent and endless.
///
/// Records frozen by a conflict are left out entirely. Pushing one would be exactly the silent
/// overwrite the freeze exists to prevent.
///
/// Only what has actually changed since the last agreement travels. Sending the whole collection
/// every round would work — the upsert is idempotent — but the `synced_at` trigger fires on every
/// write, so a full push would move every row's server clock and hand every peer the entire
/// collection to re-examine, every few seconds, forever. With an empty base (a brand-new share, or
/// the first push after joining) that filter matches everything, which is exactly the full upload
/// those two cases need.
pub fn local_items(conn: &Connection, collection_id: &str) -> rusqlite::Result<Vec<SharedItem>> {
    let frozen = frozen_keys(conn, collection_id)?;
    let bases = base_map(conn, collection_id)?;
    let mut items = Vec::new();
    // Every record that exists here right now, sent or not — see the tombstone loop below.
    let mut live: HashSet<(String, String)> = HashSet::new();

    let consider = |kind: &str, id: &str, updated_at: &str| -> bool {
        let key = (kind.to_string(), id.to_string());
        if frozen.contains(&key) {
            return false;
        }
        match bases.get(&key) {
            Some(base) => !same_instant(base, updated_at),
            None => true,
        }
    };

    if let Some((collection, folders, requests)) = api_queries::load_collection(conn, collection_id)? {
        live.insert(("collection".to_string(), collection.id.clone()));
        live.extend(folders.iter().map(|f| ("folder".to_string(), f.id.clone())));
        live.extend(requests.iter().map(|r| ("request".to_string(), r.id.clone())));
        if consider("collection", &collection.id, &collection.updated_at) {
            let updated_at = collection.updated_at.clone();
            let id = collection.id.clone();
            let payload = serde_json::to_value(redacted_collection(collection))
                .unwrap_or(serde_json::Value::Null);
            items.push(item("collection", &id, collection_id, &updated_at, payload));
        }
        for folder in folders {
            if !consider("folder", &folder.id, &folder.updated_at) {
                continue;
            }
            let (id, updated_at) = (folder.id.clone(), folder.updated_at.clone());
            let payload =
                serde_json::to_value(redacted_folder(folder)).unwrap_or(serde_json::Value::Null);
            items.push(item("folder", &id, collection_id, &updated_at, payload));
        }
        for request in requests {
            if !consider("request", &request.id, &request.updated_at) {
                continue;
            }
            let (id, updated_at) = (request.id.clone(), request.updated_at.clone());
            let payload =
                serde_json::to_value(redacted_request(request)).unwrap_or(serde_json::Value::Null);
            items.push(item("request", &id, collection_id, &updated_at, payload));
        }
    }

    // The deletions recorded by the delete paths, so a removal travels instead of being undone by
    // the next pull. A tombstone is only ever recorded once and dropped as soon as it has been
    // delivered, so it is a delta already.
    for (kind, id, deleted_at) in api_queries::list_tombstones(conn, collection_id)? {
        if frozen.contains(&(kind.clone(), id.clone())) {
            continue;
        }
        // Moved out and back in before the removal travelled: the record is here, and a tombstone
        // beside it in the same push would both contradict it and hand PostgREST one id twice in a
        // single upsert, which it refuses outright.
        if live.contains(&(kind.clone(), id.clone())) {
            continue;
        }
        items.push(SharedItem {
            id,
            share_id: collection_id.to_string(),
            kind,
            payload: serde_json::Value::Object(serde_json::Map::new()),
            updated_at: deleted_at,
            synced_at: String::new(),
            deleted: true,
        });
    }

    Ok(items)
}

/// A tombstone built by hand, for the tests that stand in for a peer's delete.
#[cfg(test)]
pub fn tombstone(collection_id: &str, kind: &str, id: &str) -> SharedItem {
    SharedItem {
        id: id.to_string(),
        share_id: collection_id.to_string(),
        kind: kind.to_string(),
        payload: serde_json::Value::Object(serde_json::Map::new()),
        updated_at: now(),
        synced_at: String::new(),
        deleted: true,
    }
}

/// Moves the base forward for everything a push just delivered.
///
/// This is what closes the loop: without it the pushed records stay "locally modified" forever, and
/// the very next pull — which returns our own writes — reads as a remote change on top of a local
/// one, i.e. every record we ever pushed turns into a conflict with itself.
pub fn record_base(conn: &Connection, collection_id: &str, items: &[SharedItem]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for item in items {
        if item.deleted {
            // Agreement on a deletion is the absence of a base, not a base of its own: the record
            // is gone on both sides and there is nothing left to compare.
            tx.execute(
                "DELETE FROM api_sync_base WHERE collection_id = ?1 AND kind = ?2 AND id = ?3",
                params![collection_id, item.kind, item.id],
            )?;
            continue;
        }
        set_base(&tx, collection_id, &item.kind, &item.id, &item.updated_at)?;
    }
    tx.commit()
}

fn set_base(
    conn: &Connection,
    collection_id: &str,
    kind: &str,
    id: &str,
    updated_at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_sync_base (collection_id, kind, id, base_updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(collection_id, kind, id) DO UPDATE SET base_updated_at = excluded.base_updated_at",
        params![collection_id, kind, id, updated_at],
    )?;
    Ok(())
}

fn clear_base(conn: &Connection, collection_id: &str, kind: &str, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM api_sync_base WHERE collection_id = ?1 AND kind = ?2 AND id = ?3",
        params![collection_id, kind, id],
    )?;
    Ok(())
}

/// Whether two RFC 3339 timestamps name the same moment.
///
/// Never `==` on the strings. One side of every comparison here has usually been through the shared
/// Postgres project, which prints a timestamp its own way: trailing zeros are stripped, so the
/// `.582390` this machine wrote comes back as `.58239`. Those are the same instant and a string
/// comparison says they are not — which marks the record as edited on both sides and freezes it as
/// a conflict nobody caused.
///
/// (The other half of that round trip — Postgres *rounding* away precision it cannot store — is
/// handled upstream, by `queries::now` stamping only microseconds. Parsing alone would not fix it,
/// because a rounded value really is a different instant.)
///
/// Anything unparseable falls back to string equality: it did not come from a CodeFlow client, and
/// guessing about it is worse than treating it as opaque.
pub(crate) fn same_instant(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (
        chrono::DateTime::parse_from_rfc3339(a),
        chrono::DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn base_map(conn: &Connection, collection_id: &str) -> rusqlite::Result<HashMap<(String, String), String>> {
    let mut stmt = conn.prepare(
        "SELECT kind, id, base_updated_at FROM api_sync_base WHERE collection_id = ?1",
    )?;
    let rows = stmt.query_map(params![collection_id], |row| {
        Ok(((row.get::<_, String>(0)?, row.get::<_, String>(1)?), row.get::<_, String>(2)?))
    })?;
    rows.collect()
}

fn frozen_keys(conn: &Connection, collection_id: &str) -> rusqlite::Result<HashSet<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT kind, id FROM api_sync_conflicts WHERE collection_id = ?1")?;
    let rows = stmt.query_map(params![collection_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/// The local side of one record: its `updated_at`, and its payload exactly as a push would send it.
struct LocalRecord {
    updated_at: String,
    payload: serde_json::Value,
}

fn local_records(
    conn: &Connection,
    collection_id: &str,
) -> rusqlite::Result<HashMap<(String, String), LocalRecord>> {
    let mut map = HashMap::new();
    let Some((collection, folders, requests)) = api_queries::load_collection(conn, collection_id)?
    else {
        return Ok(map);
    };
    let key = ("collection".to_string(), collection.id.clone());
    let updated_at = collection.updated_at.clone();
    map.insert(
        key,
        LocalRecord {
            updated_at,
            payload: serde_json::to_value(redacted_collection(collection))
                .unwrap_or(serde_json::Value::Null),
        },
    );
    for folder in folders {
        let key = ("folder".to_string(), folder.id.clone());
        let updated_at = folder.updated_at.clone();
        map.insert(
            key,
            LocalRecord {
                updated_at,
                payload: serde_json::to_value(redacted_folder(folder))
                    .unwrap_or(serde_json::Value::Null),
            },
        );
    }
    for request in requests {
        let key = ("request".to_string(), request.id.clone());
        let updated_at = request.updated_at.clone();
        map.insert(
            key,
            LocalRecord {
                updated_at,
                payload: serde_json::to_value(redacted_request(request))
                    .unwrap_or(serde_json::Value::Null),
            },
        );
    }
    Ok(map)
}

/// Drops the fields that are allowed to differ between two copies of the "same" record, so a
/// cosmetic difference never freezes a request.
///
/// `updated_at` is the clock itself. For a collection, `workspace_id`, `sort_order`, `pinned` and
/// `scope` are *local placement* — which workspace it was dropped into, where it sits in the
/// sidebar, whether this person pinned it, whether they keep it on every shelf — and none of that
/// is anyone else's business.
///
/// `scope` in particular has to be stripped rather than merely tolerated: two machines that
/// disagree about it would otherwise read as a simultaneous edit on every single sync round, and
/// freeze the collection as a conflict that no amount of resolving clears.
fn comparable(kind: &str, payload: &serde_json::Value) -> serde_json::Value {
    let mut value = payload.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("updated_at");
        object.remove("created_at");
        // Redacted again, whichever side this is: a peer on an older build still sends current
        // values and token expiries, which are nobody's business but its own, and a difference in
        // them is not an edit to freeze a record over.
        for (field, redact) in [
            ("auth", redact_auth as fn(&str) -> String),
            ("variables", redact_variables),
            ("spec", redact_spec),
        ] {
            if let Some(slot) = object.get_mut(field) {
                if let Some(raw) = slot.as_str() {
                    *slot = serde_json::Value::String(redact(raw));
                }
            }
        }
        if kind == "collection" {
            object.remove("workspace_id");
            object.remove("sort_order");
            object.remove("pinned");
            object.remove("scope");
        }
    }
    value
}

/// Rewrites an incoming collection so it lands where *this* machine keeps it: in the local
/// workspace, at the local position, with the local pin. Everything else is the shared record.
fn localise_collection(mut c: ApiCollection, workspace_id: &str, local: Option<&ApiCollection>) -> ApiCollection {
    c.workspace_id = workspace_id.to_string();
    if let Some(local) = local {
        c.sort_order = local.sort_order;
        c.pinned = local.pinned;
        // Local placement, like the two above it: whether *this* person keeps the collection on
        // every workspace's shelf is not the host's decision to push.
        c.scope = local.scope.clone();
    }
    c
}

fn table_for(kind: &str) -> Option<&'static str> {
    match kind {
        "collection" => Some("api_collections"),
        "folder" => Some("api_folders"),
        "request" => Some("api_requests"),
        _ => None,
    }
}

/// Applies a pulled batch against the base: see the table at the top of this module.
///
/// `workspace_id` is where a collection this machine has never seen should land — the guest's own
/// choice, which is what makes accepting an invitation "add a collection to my workspace" rather
/// than "adopt someone else's sidebar".
pub fn apply_items(
    conn: &mut Connection,
    collection_id: &str,
    workspace_id: &str,
    items: Vec<SharedItem>,
) -> rusqlite::Result<SyncResult> {
    let bases = base_map(conn, collection_id)?;
    let locals = local_records(conn, collection_id)?;
    let raw = raw_records(conn, collection_id)?;
    let existing_collection = api_queries::load_collection(conn, collection_id)?.map(|(c, _, _)| c);

    let mut cursor = String::new();
    let mut live = BackupWorkspace {
        id: workspace_id.to_string(),
        name: String::new(),
        icon: String::new(),
        color: String::new(),
        collections: Vec::new(),
        folders: Vec::new(),
        requests: Vec::new(),
        environments: Vec::new(),
    };
    let mut graves: Vec<(String, String)> = Vec::new();
    let mut agreed: Vec<(String, String, String)> = Vec::new();
    let mut conflicts: Vec<(SharedItem, String)> = Vec::new();

    for item in items {
        // The cursor advances on the server's clock, never the writer's — see `synced_at` in
        // `supabase_schema.sql`. Falling back to `updated_at` covers items built locally, which is
        // only ever the tests.
        let seen = if item.synced_at.is_empty() { &item.updated_at } else { &item.synced_at };
        if *seen > cursor {
            cursor = seen.clone();
        }
        if table_for(&item.kind).is_none() {
            continue;
        }

        let key = (item.kind.clone(), item.id.clone());
        let base = bases.get(&key);
        let local = locals.get(&key);

        // Nothing moved on their side since we last agreed — whatever state we are in is ours to
        // push, not theirs to impose. The cursor still advanced, so this costs nothing next round.
        if base.is_some_and(|b| same_instant(b, &item.updated_at)) {
            continue;
        }

        let local_moved = match (base, local) {
            (Some(base), Some(local)) => !same_instant(&local.updated_at, base),
            // Here but never agreed: created locally under an id the remote also uses. Rare, and
            // exactly the case that must not be silently overwritten.
            (None, Some(_)) => true,
            // Agreed once, gone now: deleted here. The tombstone carries that, so their edit is a
            // real disagreement.
            (Some(_), None) => true,
            (None, None) => false,
        };

        if !local_moved {
            if item.deleted {
                graves.push((item.kind.clone(), item.id.clone()));
                agreed.push((item.kind.clone(), item.id.clone(), String::new()));
            } else {
                push_live(&mut live, &item, workspace_id, existing_collection.as_ref(), raw.get(&key));
                agreed.push((item.kind.clone(), item.id.clone(), item.updated_at.clone()));
            }
            continue;
        }

        // Both sides moved. Two of those are not really disagreements:
        //   - both deleted it,
        //   - both ended up at the same content by different routes (a redacted echo, a rename
        //     typed identically on two machines).
        let both_deleted = item.deleted && local.is_none();
        let same_content = !item.deleted
            && local.is_some_and(|l| comparable(&item.kind, &l.payload) == comparable(&item.kind, &item.payload));
        if both_deleted || same_content {
            agreed.push((
                item.kind.clone(),
                item.id.clone(),
                if item.deleted { String::new() } else { item.updated_at.clone() },
            ));
            continue;
        }

        let local_updated_at = local.map(|l| l.updated_at.clone()).unwrap_or_default();
        conflicts.push((item, local_updated_at));
    }

    // A peer that deleted a collection tombstones its whole subtree, but the two can arrive in
    // either order and a pull can be cut short. Dropping children whose parent is neither in this
    // batch nor already here keeps a foreign-key failure from taking the entire sync down; the next
    // pull brings them back if the parent turns out to exist after all.
    let collection_present =
        existing_collection.is_some() || live.collections.iter().any(|c| c.id == collection_id);
    if !collection_present {
        live.folders.clear();
        live.requests.clear();
    }
    // Nothing outside this share may ride in on it.
    live.folders.retain(|f| f.collection_id == collection_id);
    live.requests.retain(|r| r.collection_id == collection_id);

    let touched: Vec<(String, String)> = live
        .collections
        .iter()
        .map(|c| ("collection".to_string(), c.id.clone()))
        .chain(live.folders.iter().map(|f| ("folder".to_string(), f.id.clone())))
        .chain(live.requests.iter().map(|r| ("request".to_string(), r.id.clone())))
        .collect();
    let scripts = incoming_scripts(&live);

    let applied = if live.collections.is_empty() && live.folders.is_empty() && live.requests.is_empty() {
        ImportSummary::default()
    } else {
        // The workspace has to exist for the import to resolve it; it always does here, because the
        // caller passes the workspace the share is filed under.
        live.name = workspace_name(conn, workspace_id)?;
        api_backup::import_all(
            conn,
            &ApiBackup { workspaces: vec![live] },
            // Never by name: adopting a local workspace that merely shares a name with the host's
            // would file the collection somewhere the user never chose.
            ImportOptions { replace: false, match_by_name: false },
        )?
    };

    let mut deleted = 0;
    let tx = conn.transaction()?;
    // Somebody else's code, so it runs only after the trust gate has shown it. Recorded as
    // untrusted with where it came from, which the gate's dialog says out loud; a text already
    // trusted here stays trusted — identical text is identical code (see `api_trust`).
    api_trust::record_scripts(&tx, scripts.iter().map(String::as_str), false, api_trust::ORIGIN_SHARED)?;
    for (kind, id) in graves {
        let Some(table) = table_for(&kind) else { continue };
        // Scoped to the collection so a tombstone from one share can never reach a row of another.
        // The collection row is its own scope — a collection tombstone's id *is* the share's id —
        // so the guard there is that the two must match.
        let sql = match table {
            "api_collections" => format!("DELETE FROM {table} WHERE id = ?1 AND id = ?2"),
            _ => format!("DELETE FROM {table} WHERE id = ?1 AND collection_id = ?2"),
        };
        deleted += tx.execute(&sql, params![id, collection_id])? as i64;
    }
    for (kind, id, updated_at) in &agreed {
        if updated_at.is_empty() {
            clear_base(&tx, collection_id, kind, id)?;
        } else {
            set_base(&tx, collection_id, kind, id, updated_at)?;
        }
    }
    let frozen = conflicts.len() as i64;
    for (item, local_updated_at) in &conflicts {
        tx.execute(
            "INSERT INTO api_sync_conflicts
                (collection_id, kind, id, remote_payload, remote_updated_at, local_updated_at, remote_deleted, detected_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(collection_id, kind, id) DO UPDATE SET
                remote_payload    = excluded.remote_payload,
                remote_updated_at = excluded.remote_updated_at,
                local_updated_at  = excluded.local_updated_at,
                remote_deleted    = excluded.remote_deleted",
            params![
                collection_id,
                item.kind,
                item.id,
                item.payload.to_string(),
                item.updated_at,
                local_updated_at,
                item.deleted,
                now()
            ],
        )?;
    }
    tx.commit()?;

    Ok(SyncResult { applied, deleted, conflicts: frozen, cursor, touched })
}

/// Every runnable script in a batch about to be applied.
fn incoming_scripts(live: &BackupWorkspace) -> Vec<String> {
    let mut scripts = Vec::new();
    for c in &live.collections {
        scripts.extend([c.pre_script.clone(), c.post_script.clone()]);
    }
    for f in &live.folders {
        scripts.extend([f.pre_script.clone(), f.post_script.clone()]);
    }
    for r in &live.requests {
        scripts.extend(api_trust::request_scripts(&r.spec));
    }
    scripts.retain(|code| api_trust::is_runnable(code));
    scripts
}

/// The local side of every record, **unredacted** — credentials, sealed markers and current values
/// included — for [`merge_local`] to carry into what a peer sends.
fn raw_records(
    conn: &Connection,
    collection_id: &str,
) -> rusqlite::Result<HashMap<(String, String), serde_json::Value>> {
    let mut map = HashMap::new();
    let Some((collection, folders, requests)) = api_queries::load_collection(conn, collection_id)?
    else {
        return Ok(map);
    };
    let value = |row: serde_json::Result<serde_json::Value>| row.unwrap_or(serde_json::Value::Null);
    map.insert(("collection".to_string(), collection.id.clone()), value(serde_json::to_value(&collection)));
    for folder in folders {
        map.insert(("folder".to_string(), folder.id.clone()), value(serde_json::to_value(&folder)));
    }
    for request in requests {
        map.insert(("request".to_string(), request.id.clone()), value(serde_json::to_value(&request)));
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Merging an incoming record with the local one
// ---------------------------------------------------------------------------

/// Carries this machine's own values into an incoming record before it lands.
///
/// A push never carries a credential or a current value, so every incoming record arrives with
/// those slots blank — and applying it verbatim, as this used to, replaced the whole auth block and
/// the whole variable list: a teammate renaming a request wiped the token everyone else had typed
/// into it, and a pull reset every variable a script had set. So:
///
/// - a credential slot that arrives blank keeps the local value — a literal, a sealed marker or a
///   `{{reference}}`, whichever is here;
/// - every variable keeps its local current value, matched by id and then by key;
///
/// and anything the peer actually sent — a changed initial value, a reference where a literal was —
/// wins exactly as before.
fn merge_local(kind: &str, payload: &mut serde_json::Value, local: &serde_json::Value) {
    match kind {
        "collection" => {
            merge_field(payload, local, "auth", merge_auth);
            merge_field(payload, local, "variables", merge_variables);
        }
        "folder" => merge_field(payload, local, "auth", merge_auth),
        "request" => merge_field(payload, local, "spec", merge_spec),
        _ => {}
    }
}

fn merge_field(
    payload: &mut serde_json::Value,
    local: &serde_json::Value,
    field: &str,
    merge: fn(&str, &str) -> String,
) {
    let Some(mine) = local.get(field).and_then(|v| v.as_str()) else { return };
    let Some(slot) = payload.get_mut(field) else { return };
    let Some(theirs) = slot.as_str() else { return };
    let merged = merge(theirs, mine);
    *slot = serde_json::Value::String(merged);
}

/// Fills the blank credential slots of `theirs` from the same slots of `mine`.
fn fill_blank_slots(
    theirs: &str,
    mine: &str,
    walk: fn(&mut serde_json::Value, &mut dyn FnMut(&str, &mut serde_json::Value)),
    oauth2: fn(&mut serde_json::Value) -> Option<&mut serde_json::Value>,
) -> String {
    // "" is how an unconfigured auth column is stored: they turned auth off, and that is theirs to do.
    if theirs.trim().is_empty() {
        return theirs.to_string();
    }
    let Ok(mut incoming) = serde_json::from_str::<serde_json::Value>(theirs) else {
        return theirs.to_string();
    };
    // Nothing here (a record this machine has never had) is an empty local side: no credential to
    // keep, and no token whose expiry could be anyone's but the sender's.
    let mut local = serde_json::from_str::<serde_json::Value>(mine).unwrap_or(serde_json::Value::Null);
    let mut kept: HashMap<String, serde_json::Value> = HashMap::new();
    walk(&mut local, &mut |path, slot| {
        if slot.as_str().is_some_and(|text| !text.is_empty()) {
            kept.insert(path.to_string(), slot.clone());
        }
    });
    let mut changed = false;
    walk(&mut incoming, &mut |path, slot| {
        if slot.as_str() == Some("") {
            if let Some(value) = kept.get(path) {
                *slot = value.clone();
                changed = true;
            }
        }
    });
    // The expiry of the token kept above belongs with it — see `forget_token_expiry`.
    let local_expiry = oauth2(&mut local)
        .and_then(|block| block.get("expiresAt").cloned())
        .unwrap_or_else(|| serde_json::Value::from(0));
    if let Some(block) = oauth2(&mut incoming) {
        let expiry = local_expiry;
        if let Some(slot) = block.get_mut("expiresAt") {
            if *slot != expiry {
                *slot = expiry;
                changed = true;
            }
        }
    }
    if changed {
        incoming.to_string()
    } else {
        theirs.to_string()
    }
}

fn merge_auth(theirs: &str, mine: &str) -> String {
    fill_blank_slots(
        theirs,
        mine,
        |value, visit| api_secrets::auth_secret_slots(value, visit),
        |auth| auth.get_mut("oauth2"),
    )
}

fn merge_spec(theirs: &str, mine: &str) -> String {
    fill_blank_slots(
        theirs,
        mine,
        |value, visit| api_secrets::spec_secret_slots(value, visit),
        |spec| spec.get_mut("auth").and_then(|auth| auth.get_mut("oauth2")),
    )
}

/// Their list — which variables exist, in which order, with which initial values — with this
/// machine's current values, and its own credential wherever theirs arrived blank.
fn merge_variables(theirs: &str, mine: &str) -> String {
    let Ok(mut incoming) = serde_json::from_str::<serde_json::Value>(theirs) else {
        return theirs.to_string();
    };
    let local: Vec<serde_json::Value> = serde_json::from_str::<serde_json::Value>(mine)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let Some(list) = incoming.as_array_mut() else { return theirs.to_string() };
    let text = |value: &serde_json::Value, field: &str| -> String {
        value.get(field).and_then(|v| v.as_str()).unwrap_or_default().to_string()
    };
    let mut changed = false;
    for variable in list.iter_mut() {
        let id = text(variable, "id");
        let key = text(variable, "key");
        let found = local
            .iter()
            .find(|candidate| !id.is_empty() && text(candidate, "id") == id)
            .or_else(|| local.iter().find(|candidate| text(candidate, "key") == key));
        // Always this machine's current value, empty included. A current build never sends one,
        // but a peer on an older build still pushes its own — a script's token among them — and
        // that must not land here as ours.
        let current = found.map(|local| text(local, "currentValue")).unwrap_or_default();
        if let Some(slot) = variable.get_mut("currentValue") {
            if slot.as_str() != Some(current.as_str()) {
                *slot = serde_json::Value::String(current);
                changed = true;
            }
        }
        let Some(found) = found else { continue };
        let secret = variable.get("secret").and_then(|v| v.as_bool()) == Some(true);
        let initial = text(found, "initialValue");
        if secret && !initial.is_empty() {
            if let Some(slot) = variable.get_mut("initialValue") {
                if slot.as_str() == Some("") {
                    *slot = serde_json::Value::String(initial);
                    changed = true;
                }
            }
        }
    }
    if changed {
        incoming.to_string()
    } else {
        theirs.to_string()
    }
}

fn push_live(
    live: &mut BackupWorkspace,
    item: &SharedItem,
    workspace_id: &str,
    existing: Option<&ApiCollection>,
    local: Option<&serde_json::Value>,
) {
    // **The column is the authority for the timestamp; the payload is the authority for the
    // content.** They are two spellings of the same instant — the payload's is whatever the writing
    // client formatted, the column's is what Postgres stored — and only the column's is what the
    // base will hold. Landing the payload's would leave the applied row and the agreement one
    // rendering apart, which reads as "edited here" on the very next round: an endless push/pull of
    // records nobody has touched, and a false conflict the moment anyone touches one for real.
    let stamp = |mut value: serde_json::Value| -> serde_json::Value {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "updated_at".into(),
                serde_json::Value::String(item.updated_at.clone()),
            );
        }
        value
    };

    let mut payload = item.payload.clone();
    // A record this machine has never had still goes through the merge, against an empty local
    // side: a peer on an older build sends its current values and token expiry, and those describe
    // its machine, not this one.
    let nothing = serde_json::json!({ "auth": "", "variables": "[]", "spec": "{}" });
    merge_local(&item.kind, &mut payload, local.unwrap_or(&nothing));

    // A payload this build can't read is skipped rather than fatal: a newer client may be sharing a
    // record with a field this one doesn't know, and dropping one request is a much better outcome
    // than refusing the whole sync.
    match item.kind.as_str() {
        "collection" => {
            if let Ok(row) = serde_json::from_value::<ApiCollection>(stamp(payload)) {
                live.collections.push(localise_collection(row, workspace_id, existing));
            }
        }
        "folder" => {
            if let Ok(row) = serde_json::from_value(stamp(payload)) {
                live.folders.push(row);
            }
        }
        "request" => {
            if let Ok(row) = serde_json::from_value(stamp(payload)) {
                live.requests.push(row);
            }
        }
        _ => {}
    }
}

fn workspace_name(conn: &Connection, workspace_id: &str) -> rusqlite::Result<String> {
    Ok(conn
        .query_row("SELECT name FROM workspaces WHERE id = ?1", params![workspace_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/// Every frozen record in one workspace, newest first, with both sides attached.
pub fn list_conflicts(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<SyncConflict>> {
    let mut stmt = conn.prepare(
        "SELECT k.collection_id, k.kind, k.id, k.remote_payload, k.remote_updated_at,
                k.local_updated_at, k.remote_deleted, k.detected_at, COALESCE(c.name, '')
           FROM api_sync_conflicts k
           JOIN api_shared_collections s ON s.collection_id = k.collection_id
           LEFT JOIN api_collections c ON c.id = k.collection_id
          WHERE s.workspace_id = ?1
          ORDER BY k.detected_at DESC",
    )?;
    let rows: Vec<(String, String, String, String, String, String, bool, String, String)> = stmt
        .query_map(params![workspace_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;

    // One subtree read per collection rather than one per conflict: `local_records` loads the whole
    // collection, and a share with fifty frozen records would otherwise load it fifty times.
    let mut cache: HashMap<String, HashMap<(String, String), LocalRecord>> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for (collection_id, kind, id, remote_payload, remote_updated_at, local_updated_at, remote_deleted, detected_at, collection_name) in
        rows
    {
        if !cache.contains_key(&collection_id) {
            cache.insert(collection_id.clone(), local_records(conn, &collection_id)?);
        }
        let local = cache
            .get(&collection_id)
            .and_then(|records| records.get(&(kind.clone(), id.clone())))
            .map(|record| record.payload.clone());
        let remote_value: serde_json::Value =
            serde_json::from_str(&remote_payload).unwrap_or(serde_json::Value::Null);
        let remote_name = remote_value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let name = local
            .as_ref()
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or(&remote_name)
            .to_string();
        out.push(SyncConflict {
            collection_id,
            collection_name,
            kind,
            id,
            name,
            remote_name,
            remote_payload,
            local_payload: local
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
            remote_updated_at,
            local_updated_at,
            remote_deleted,
            local_deleted: false,
            detected_at,
        });
    }
    // `local_deleted` is derivable from the payload being empty; setting it here keeps the UI from
    // having to know that.
    for conflict in &mut out {
        conflict.local_deleted = conflict.local_payload == "{}";
    }
    Ok(out)
}

/// Settles one frozen record.
///
/// **Theirs** writes the incoming record over the local one — or deletes it, when the incoming
/// change was a deletion — and the base moves to their timestamp, so the two sides now agree.
///
/// **Mine** keeps what is here and re-stamps it `now()`, which is what makes the next push newer
/// than their version and therefore the one that lands. The base still moves to *their* timestamp:
/// that is the point they last changed anything, and treating our record as "changed since then" is
/// exactly what has to be true for the push to be seen as intentional rather than as a fresh
/// conflict on the next pull.
pub fn resolve(
    conn: &mut Connection,
    collection_id: &str,
    kind: &str,
    id: &str,
    keep: Resolution,
) -> rusqlite::Result<()> {
    let Some((remote_payload, remote_updated_at, remote_deleted)) = conn
        .query_row(
            "SELECT remote_payload, remote_updated_at, remote_deleted FROM api_sync_conflicts
              WHERE collection_id = ?1 AND kind = ?2 AND id = ?3",
            params![collection_id, kind, id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(());
    };

    let workspace_id: String = conn
        .query_row(
            "SELECT workspace_id FROM api_shared_collections WHERE collection_id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_default();

    match keep {
        Resolution::Theirs => {
            if remote_deleted {
                delete_local(conn, collection_id, kind, id)?;
            } else {
                let value: serde_json::Value =
                    serde_json::from_str(&remote_payload).unwrap_or(serde_json::Value::Null);
                let existing = api_queries::load_collection(conn, collection_id)?.map(|(c, _, _)| c);
                let mut live = BackupWorkspace {
                    id: workspace_id.clone(),
                    name: workspace_name(conn, &workspace_id)?,
                    icon: String::new(),
                    color: String::new(),
                    collections: Vec::new(),
                    folders: Vec::new(),
                    requests: Vec::new(),
                    environments: Vec::new(),
                };
                let incoming = SharedItem {
                    id: id.to_string(),
                    share_id: collection_id.to_string(),
                    kind: kind.to_string(),
                    payload: value,
                    updated_at: remote_updated_at.clone(),
                    synced_at: String::new(),
                    deleted: false,
                };
                // "Theirs" is their version of the record, not their copy of your credentials:
                // the same merge a pull applies, so taking their rename does not cost the token.
                let local = raw_records(conn, collection_id)?.remove(&(kind.to_string(), id.to_string()));
                push_live(&mut live, &incoming, &workspace_id, existing.as_ref(), local.as_ref());
                let scripts = incoming_scripts(&live);
                // The upsert only writes when the incoming row is strictly newer, and a local edit
                // made *after* theirs would otherwise survive a "take theirs". Stamping the row
                // back to their timestamp first is what makes the choice actually take effect.
                rewind_local(conn, kind, id)?;
                api_backup::import_all(
                    conn,
                    &ApiBackup { workspaces: vec![live] },
                    ImportOptions { replace: false, match_by_name: false },
                )?;
                api_trust::record_scripts(conn, scripts.iter().map(String::as_str), false, api_trust::ORIGIN_SHARED)?;
            }
        }
        Resolution::Mine => {
            // Deleted here on purpose: the tombstone already carries `now()`, so there is nothing
            // to re-stamp — only the freeze to lift.
            touch_local(conn, kind, id, &remote_updated_at)?;
        }
    }

    let tx = conn.transaction()?;
    if remote_deleted && keep == Resolution::Theirs {
        clear_base(&tx, collection_id, kind, id)?;
    } else {
        set_base(&tx, collection_id, kind, id, &remote_updated_at)?;
    }
    tx.execute(
        "DELETE FROM api_sync_conflicts WHERE collection_id = ?1 AND kind = ?2 AND id = ?3",
        params![collection_id, kind, id],
    )?;
    tx.commit()
}

/// Re-stamps a local record so a push carries it as the newest version.
///
/// `now()` alone is not enough. Every peer's merge upsert only writes a strictly newer row, and
/// nothing keeps a teammate's clock behind ours — a machine running five minutes fast produces a
/// record that "keep mine" could never beat, and the decision would silently do nothing on their
/// side. Stamping just past whichever of the two clocks is ahead makes the choice actually take.
fn touch_local(conn: &Connection, kind: &str, id: &str, beat: &str) -> rusqlite::Result<()> {
    let Some(table) = table_for(kind) else { return Ok(()) };
    conn.execute(
        &format!("UPDATE {table} SET updated_at = ?2 WHERE id = ?1"),
        params![id, later_than(beat)],
    )?;
    Ok(())
}

/// `now()`, unless the timestamp to beat is already in the future — in which case, one millisecond
/// past it. RFC 3339 with a fixed offset sorts lexicographically, which is the ordering every
/// comparison in this module and in `api_backup` relies on.
fn later_than(other: &str) -> String {
    let stamp = now();
    if stamp.as_str() > other {
        return stamp;
    }
    match chrono::DateTime::parse_from_rfc3339(other) {
        Ok(parsed) => (parsed + chrono::Duration::milliseconds(1))
            .to_utc()
            .to_rfc3339(),
        // Unparseable means it did not come from a CodeFlow client; `now()` is the honest answer.
        Err(_) => stamp,
    }
}

/// Pushes a local record's clock back to the epoch so the merge upsert is free to overwrite it.
fn rewind_local(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<()> {
    let Some(table) = table_for(kind) else { return Ok(()) };
    conn.execute(
        &format!("UPDATE {table} SET updated_at = '' WHERE id = ?1"),
        params![id],
    )?;
    Ok(())
}

fn delete_local(conn: &Connection, collection_id: &str, kind: &str, id: &str) -> rusqlite::Result<()> {
    match kind {
        "collection" => api_queries::delete_collection(conn, id),
        "folder" => api_queries::delete_folder(conn, id),
        "request" => api_queries::delete_request(conn, id),
        _ => Ok(()),
    }?;
    // The local delete paths write a tombstone, which would then travel back out and delete the
    // record for everyone — but this deletion *is* theirs, already applied. Dropping the trace is
    // what keeps "take theirs" from echoing as a new instruction.
    conn.execute(
        "DELETE FROM api_tombstones WHERE collection_id = ?1 AND kind = ?2 AND id = ?3",
        params![collection_id, kind, id],
    )?;
    Ok(())
}

/// Drops the tombstones a push has just delivered, so the payload doesn't carry every deletion the
/// collection has ever seen for the rest of its life.
///
/// Scoped to the ids that were actually sent, never to the collection as a whole: a delete made
/// between building the payload and the server acknowledging it would otherwise be erased before it
/// had ever travelled, and the record would come straight back on the next pull.
pub fn clear_delivered_tombstones(
    conn: &Connection,
    collection_id: &str,
    delivered: &[SharedItem],
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for item in delivered.iter().filter(|i| i.deleted) {
        tx.execute(
            "DELETE FROM api_tombstones WHERE collection_id = ?1 AND kind = ?2 AND id = ?3",
            params![collection_id, item.kind, item.id],
        )?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', '', '', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                VALUES ('c1', 'w1', 'My API', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_folders (id, collection_id, parent_id, name, created_at, updated_at)
                VALUES ('f1', 'c1', NULL, 'Auth', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at)
                VALUES ('r1', 'c1', 'f1', 'Login', 'https://a', '{}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_shared_collections (collection_id, workspace_id, remote_name, role, created_at)
                VALUES ('c1', 'w1', 'My API', 'owner', '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        conn
    }

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn text(conn: &Connection, sql: &str) -> String {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// A second machine that has already agreed with the server about everything.
    fn synced_peer() -> (Connection, Vec<SharedItem>) {
        let source = seeded();
        let items = local_items(&source, "c1").unwrap();

        let mut peer = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&peer).unwrap();
        peer.execute_batch(
            r#"
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w2', 'Mine', '', '', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO api_shared_collections (collection_id, workspace_id, remote_name, role, created_at)
                VALUES ('c1', 'w2', 'My API', 'member', '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        apply_items(&mut peer, "c1", "w2", items.clone()).unwrap();
        (peer, items)
    }

    #[test]
    fn a_collection_becomes_items_of_every_kind_beneath_it() {
        let items = local_items(&seeded(), "c1").unwrap();
        let kinds: Vec<&str> = items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "collection").count(), 1);
        assert_eq!(kinds.iter().filter(|k| **k == "folder").count(), 1);
        assert_eq!(kinds.iter().filter(|k| **k == "request").count(), 1);
        assert!(items.iter().all(|i| i.share_id == "c1" && !i.deleted));
    }

    /// Accepting an invitation files the collection in the workspace the guest chose, not in the
    /// host's — the whole reason sharing moved off the workspace.
    #[test]
    fn a_pull_lands_the_collection_in_the_guests_own_workspace() {
        let (peer, _) = synced_peer();

        assert_eq!(
            scalar(&peer, "SELECT COUNT(*) FROM api_collections WHERE id = 'c1' AND workspace_id = 'w2'"),
            1
        );
        assert_eq!(scalar(&peer, "SELECT COUNT(*) FROM api_folders WHERE id = 'f1'"), 1);
        assert_eq!(scalar(&peer, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 1);
    }

    #[test]
    fn a_tombstone_removes_the_row_it_names() {
        let (mut peer, _) = synced_peer();

        let result = apply_items(&mut peer, "c1", "w2", vec![tombstone("c1", "request", "r1")]).unwrap();

        assert_eq!(result.deleted, 1);
        assert_eq!(result.conflicts, 0);
        assert_eq!(scalar(&peer, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 0);
    }

    #[test]
    fn a_tombstone_cannot_reach_into_another_collection() {
        let (mut peer, _) = synced_peer();
        peer.execute_batch(
            r#"
            INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                VALUES ('c2', 'w2', 'Theirs', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at)
                VALUES ('r9', 'c2', NULL, 'Untouched', 'https://b', '{}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();

        let result = apply_items(&mut peer, "c1", "w2", vec![tombstone("c1", "request", "r9")]).unwrap();

        assert_eq!(result.deleted, 0);
        assert_eq!(scalar(&peer, "SELECT COUNT(*) FROM api_requests WHERE id = 'r9'"), 1);
    }

    /// The guard against a sync that never settles: a pull whose records are all already agreed has
    /// to report zero changes, or the caller reloads the tree, that reload looks like a local edit,
    /// and the edit schedules another push.
    #[test]
    fn pulling_what_we_already_agreed_on_reports_no_changes() {
        let (mut peer, items) = synced_peer();

        let again = apply_items(&mut peer, "c1", "w2", items).unwrap();

        assert_eq!(again.applied.requests, 0);
        assert_eq!(again.applied.folders, 0);
        assert_eq!(again.applied.collections, 0);
        assert_eq!(again.deleted, 0);
        assert_eq!(again.conflicts, 0);
    }

    #[test]
    fn a_peers_edit_lands_when_nothing_changed_here() {
        let (mut peer, mut items) = synced_peer();
        for item in &mut items {
            if item.kind == "request" {
                item.payload["name"] = serde_json::Value::String("Login (theirs)".into());
                item.payload["updated_at"] = serde_json::Value::String("2027-01-01T00:00:00+00:00".into());
                item.updated_at = "2027-01-01T00:00:00+00:00".into();
            }
        }

        let result = apply_items(&mut peer, "c1", "w2", items).unwrap();

        assert_eq!(result.conflicts, 0);
        assert_eq!(result.applied.requests, 1);
        assert_eq!(text(&peer, "SELECT name FROM api_requests WHERE id = 'r1'"), "Login (theirs)");
    }

    /// The case the whole base table exists for: neither side may be dropped on the floor.
    #[test]
    fn two_edits_to_the_same_request_freeze_it_instead_of_overwriting_either() {
        let (mut peer, mut items) = synced_peer();
        peer.execute(
            "UPDATE api_requests SET name = 'Login (mine)', updated_at = '2027-06-01T00:00:00+00:00' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        for item in &mut items {
            if item.kind == "request" {
                item.payload["name"] = serde_json::Value::String("Login (theirs)".into());
                item.updated_at = "2027-01-01T00:00:00+00:00".into();
            }
        }

        let result = apply_items(&mut peer, "c1", "w2", items).unwrap();

        assert_eq!(result.conflicts, 1);
        // Neither side applied: ours is still here, theirs is parked in the conflict row.
        assert_eq!(text(&peer, "SELECT name FROM api_requests WHERE id = 'r1'"), "Login (mine)");
        let conflicts = list_conflicts(&peer, "w2").unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].id, "r1");
        assert_eq!(conflicts[0].remote_name, "Login (theirs)");
        assert_eq!(conflicts[0].name, "Login (mine)");

        // And a frozen record is not pushed — that would be the overwrite the freeze prevents.
        let outbound = local_items(&peer, "c1").unwrap();
        assert!(outbound.iter().all(|i| i.id != "r1"));
    }

    #[test]
    fn keeping_theirs_applies_their_version_and_unfreezes() {
        let (mut peer, mut items) = synced_peer();
        peer.execute(
            "UPDATE api_requests SET name = 'Login (mine)', updated_at = '2027-06-01T00:00:00+00:00' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        for item in &mut items {
            if item.kind == "request" {
                item.payload["name"] = serde_json::Value::String("Login (theirs)".into());
                item.updated_at = "2027-01-01T00:00:00+00:00".into();
            }
        }
        apply_items(&mut peer, "c1", "w2", items).unwrap();

        resolve(&mut peer, "c1", "request", "r1", Resolution::Theirs).unwrap();

        assert_eq!(text(&peer, "SELECT name FROM api_requests WHERE id = 'r1'"), "Login (theirs)");
        assert_eq!(list_conflicts(&peer, "w2").unwrap().len(), 0);
    }

    #[test]
    fn keeping_mine_re_stamps_the_local_record_so_the_next_push_wins() {
        let (mut peer, mut items) = synced_peer();
        peer.execute(
            "UPDATE api_requests SET name = 'Login (mine)', updated_at = '2027-06-01T00:00:00+00:00' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        for item in &mut items {
            if item.kind == "request" {
                item.payload["name"] = serde_json::Value::String("Login (theirs)".into());
                item.updated_at = "2028-01-01T00:00:00+00:00".into();
            }
        }
        apply_items(&mut peer, "c1", "w2", items).unwrap();

        resolve(&mut peer, "c1", "request", "r1", Resolution::Mine).unwrap();

        assert_eq!(text(&peer, "SELECT name FROM api_requests WHERE id = 'r1'"), "Login (mine)");
        assert_eq!(list_conflicts(&peer, "w2").unwrap().len(), 0);
        // Theirs was newer by the clock; ours has to be re-stamped past it or the push is ignored.
        let stamp = text(&peer, "SELECT updated_at FROM api_requests WHERE id = 'r1'");
        assert!(stamp.as_str() > "2028-01-01T00:00:00+00:00", "re-stamped to now(), got {stamp}");
        // And it is back in the push payload.
        let outbound = local_items(&peer, "c1").unwrap();
        assert!(outbound.iter().any(|i| i.id == "r1" && !i.deleted));
    }

    /// A push that is not followed by a base update turns every record into a conflict with its own
    /// echo on the very next pull.
    #[test]
    fn recording_the_base_after_a_push_keeps_our_own_echo_from_conflicting() {
        let mut conn = seeded();
        conn.execute(
            "UPDATE api_requests SET name = 'Edited here', updated_at = '2027-01-01T00:00:00+00:00' WHERE id = 'r1'",
            [],
        )
        .unwrap();

        let pushed = local_items(&conn, "c1").unwrap();
        record_base(&conn, "c1", &pushed).unwrap();
        // The server hands the same rows back with its own clock stamped on them.
        let echoed: Vec<SharedItem> = pushed
            .into_iter()
            .map(|mut i| {
                i.synced_at = "2030-01-01T00:00:00+00:00".into();
                i
            })
            .collect();

        let result = apply_items(&mut conn, "c1", "w1", echoed).unwrap();

        assert_eq!(result.conflicts, 0);
        assert_eq!(result.applied.requests, 0);
        assert_eq!(text(&conn, "SELECT name FROM api_requests WHERE id = 'r1'"), "Edited here");
    }

    /// Nothing marked secret may reach the shared project: the invitation code is its only
    /// credential, so a synced production token is a token published to whoever that code reaches.
    #[test]
    fn secrets_never_leave_this_machine() {
        let conn = seeded();
        conn.execute_batch(
            r#"
            UPDATE api_collections
               SET auth = '{"type":"bearer","bearer":{"token":"SUPER-SECRET"},"basic":{"username":"u","password":"pw"}}',
                   variables = '[{"key":"apiKey","initialValue":"AKIA-REAL","currentValue":"live-value","secret":true,"enabled":true},
                                 {"key":"baseUrl","initialValue":"https://api.example.com","currentValue":"","secret":false,"enabled":true}]'
             WHERE id = 'c1';
            UPDATE api_requests
               SET spec = '{"auth":{"type":"basic","basic":{"username":"u","password":"hunter2"},"oauth2":{"clientSecret":"cs-999","clientId":"keep-me"}}}'
             WHERE id = 'r1';
            "#,
        )
        .unwrap();

        let wire = serde_json::to_string(&local_items(&conn, "c1").unwrap()).unwrap();

        for secret in ["AKIA-REAL", "live-value", "SUPER-SECRET", "hunter2", "cs-999"] {
            assert!(!wire.contains(secret), "{secret} must not be pushed");
        }
        for kept in ["apiKey", "baseUrl", "https://api.example.com", "keep-me"] {
            assert!(wire.contains(kept), "{kept} must still be shared");
        }

        // And redaction is outbound only — the local copy is untouched.
        assert!(text(&conn, "SELECT variables FROM api_collections WHERE id = 'c1'").contains("AKIA-REAL"));
    }

    #[test]
    fn deleting_a_collection_tombstones_its_whole_subtree() {
        let conn = seeded();
        api_queries::delete_collection(&conn, "c1").unwrap();

        let items = local_items(&conn, "c1").unwrap();
        let graves: Vec<&str> = items.iter().filter(|i| i.deleted).map(|i| i.id.as_str()).collect();

        for id in ["c1", "f1", "r1"] {
            assert!(graves.contains(&id), "{id} must be tombstoned");
        }
    }

    /// How Postgres hands a timestamp back: `timestamptz` keeps microseconds and strips trailing
    /// zeros, so the string is not the one that was sent even when the instant is.
    fn as_postgres_returns_it(stamp: &str) -> String {
        let parsed = chrono::DateTime::parse_from_rfc3339(stamp).unwrap();
        let micros = parsed.to_utc().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
        format!("{}+00:00", micros.trim_end_matches('0').trim_end_matches('.'))
    }

    /// The bug this pair of guards exists for. A record that came back from the shared project had
    /// two spellings of one instant — the payload's and the column's — and comparing them as
    /// strings marked every pulled record as locally edited, forever. Pushes carried the whole
    /// collection every round, and every real incoming edit froze as a conflict nobody caused.
    #[test]
    fn a_timestamp_that_has_been_through_postgres_still_matches() {
        assert!(same_instant(
            "2026-07-28T13:47:12.582390+00:00",
            "2026-07-28T13:47:12.58239+00:00"
        ));
        assert!(same_instant(
            "2026-07-28T13:47:12.500000+00:00",
            "2026-07-28T13:47:12.5+00:00"
        ));
        // A fraction that is all zeros loses the point as well.
        assert!(same_instant(
            "2026-07-28T13:47:12.000000+00:00",
            "2026-07-28T13:47:12+00:00"
        ));
        // Same wall clock, different zone spelling.
        assert!(same_instant(
            "2026-07-28T13:47:12.582390+00:00",
            "2026-07-28T10:47:12.582390-03:00"
        ));
        // And a real edit is still a real edit.
        assert!(!same_instant(
            "2026-07-28T13:47:12.582390+00:00",
            "2026-07-28T13:47:12.582391+00:00"
        ));
    }

    /// End to end: a peer's edit arrives with the server's spelling of every timestamp, and must
    /// land instead of freezing.
    #[test]
    fn a_pull_whose_timestamps_came_back_from_postgres_is_not_a_conflict() {
        let (mut peer, mut items) = synced_peer();
        for item in &mut items {
            // Everything the server returns is re-spelled, including the records nobody touched.
            item.updated_at = as_postgres_returns_it(&item.updated_at);
            if item.kind == "request" {
                item.payload["name"] = serde_json::Value::String("Login (theirs)".into());
                item.updated_at = as_postgres_returns_it("2027-01-01T00:00:00.120000+00:00");
                item.payload["updated_at"] = serde_json::Value::String(item.updated_at.clone());
            }
        }

        let result = apply_items(&mut peer, "c1", "w2", items).unwrap();

        assert_eq!(result.conflicts, 0, "a re-spelled timestamp is not a second edit");
        assert_eq!(result.applied.requests, 1);
        assert_eq!(text(&peer, "SELECT name FROM api_requests WHERE id = 'r1'"), "Login (theirs)");
    }

    /// The invariant that stops the two spellings oscillating: an applied record is stamped with
    /// the *column's* timestamp, which is the one the base will hold — not the payload's, which is
    /// whatever the writing client formatted.
    ///
    /// Without it a pull leaves the row and the agreement one rendering apart, so the record reads
    /// as edited here on the very next round; the push re-records the base in the local spelling,
    /// the next pull disagrees again, and the collection ships back and forth forever.
    #[test]
    fn an_applied_record_is_stamped_with_the_timestamp_the_base_will_hold() {
        let (mut peer, mut items) = synced_peer();
        for item in &mut items {
            if item.kind != "request" {
                continue;
            }
            // The payload keeps the writer's nanosecond spelling; the column carries what the
            // server stored. They are the same instant rendered two ways.
            item.payload["name"] = serde_json::Value::String("Login (theirs)".into());
            item.payload["updated_at"] =
                serde_json::Value::String("2027-01-01T00:00:00.123456789+00:00".into());
            item.updated_at = "2027-01-01T00:00:00.123457+00:00".into();
        }

        apply_items(&mut peer, "c1", "w2", items).unwrap();

        let stored = text(&peer, "SELECT updated_at FROM api_requests WHERE id = 'r1'");
        assert_eq!(stored, "2027-01-01T00:00:00.123457+00:00");
        // And so the record is settled: not re-sent, and not a conflict next time round.
        assert!(local_items(&peer, "c1").unwrap().iter().all(|i| i.id != "r1"));
    }

    /// And the outbound half: a record whose base only differs in spelling has not changed, so it
    /// must not be re-sent — that re-send is what moved every peer's cursor every round.
    #[test]
    fn a_re_spelled_base_does_not_make_a_record_look_edited() {
        let conn = seeded();
        let mut pushed = local_items(&conn, "c1").unwrap();
        for item in &mut pushed {
            item.updated_at = as_postgres_returns_it(&item.updated_at);
        }
        record_base(&conn, "c1", &pushed).unwrap();

        assert!(
            local_items(&conn, "c1").unwrap().is_empty(),
            "nothing changed; the differing spelling must not count as an edit"
        );
    }

    /// The timestamps this app writes have to survive that round trip unchanged, or the guard above
    /// is comparing a rounded instant against the original and correctly reporting a difference.
    #[test]
    fn our_own_timestamps_survive_postgres_precision() {
        let stamp = now();
        assert!(
            same_instant(&stamp, &as_postgres_returns_it(&stamp)),
            "now() must not carry precision the server cannot store: {stamp}"
        );
    }

    /// A full push every round would move every row's `synced_at`, and every peer would then pull
    /// the whole collection every few seconds for the rest of its life.
    #[test]
    fn only_what_changed_since_the_last_agreement_is_pushed() {
        let conn = seeded();
        let first = local_items(&conn, "c1").unwrap();
        assert_eq!(first.len(), 3, "a share with no base uploads everything");
        record_base(&conn, "c1", &first).unwrap();

        assert!(local_items(&conn, "c1").unwrap().is_empty(), "a quiet round sends nothing");

        conn.execute(
            "UPDATE api_requests SET name = 'Renamed', updated_at = '2027-01-01T00:00:00+00:00' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        let delta = local_items(&conn, "c1").unwrap();
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].id, "r1");
    }

    /// A tombstone that has been delivered must not be sent again, and one recorded after the
    /// payload was built must not be dropped before it ever travels.
    #[test]
    fn only_delivered_tombstones_are_forgotten() {
        let conn = seeded();
        record_base(&conn, "c1", &local_items(&conn, "c1").unwrap()).unwrap();
        api_queries::delete_request(&conn, "r1").unwrap();

        let delivered = local_items(&conn, "c1").unwrap();
        assert_eq!(delivered.len(), 1);
        assert!(delivered[0].deleted);

        // A second deletion lands while the first push is still in flight.
        api_queries::delete_folder(&conn, "f1").unwrap();
        clear_delivered_tombstones(&conn, "c1", &delivered).unwrap();

        let remaining = local_items(&conn, "c1").unwrap();
        assert_eq!(remaining.len(), 1, "the late deletion survives");
        assert_eq!(remaining[0].id, "f1");
    }

    /// Two people deleting the same request is agreement, not a disagreement to interrupt anyone
    /// over.
    #[test]
    fn a_deletion_on_both_sides_is_not_a_conflict() {
        let (mut peer, _) = synced_peer();
        api_queries::delete_request(&peer, "r1").unwrap();

        let result = apply_items(&mut peer, "c1", "w2", vec![tombstone("c1", "request", "r1")]).unwrap();

        assert_eq!(result.conflicts, 0);
    }

    /// A local pin or a drag in the sidebar is placement, not content — it must not freeze the
    /// collection every time the host pushes.
    #[test]
    fn local_placement_of_a_collection_never_conflicts() {
        let (mut peer, mut items) = synced_peer();
        peer.execute(
            "UPDATE api_collections SET pinned = 1, sort_order = 7, updated_at = '2027-06-01T00:00:00+00:00' WHERE id = 'c1'",
            [],
        )
        .unwrap();
        for item in &mut items {
            if item.kind == "collection" {
                item.updated_at = "2027-01-01T00:00:00+00:00".into();
            }
        }

        let result = apply_items(&mut peer, "c1", "w2", items).unwrap();

        assert_eq!(result.conflicts, 0);
        assert_eq!(scalar(&peer, "SELECT pinned FROM api_collections WHERE id = 'c1'"), 1);
        assert_eq!(scalar(&peer, "SELECT sort_order FROM api_collections WHERE id = 'c1'"), 7);
    }

    /// `scope` is local placement, like `pinned` and `sort_order` beside it — and it is the one
    /// where getting this wrong is unrecoverable rather than merely wrong. Two machines that
    /// disagree about whether a shared collection sits on every workspace's shelf would otherwise
    /// read as a simultaneous edit on *every* sync round, freezing the collection as a conflict
    /// that resolving does not clear, because the next round recreates it.
    #[test]
    fn a_collection_being_global_here_and_not_there_is_not_a_conflict() {
        let (mut peer, mut items) = synced_peer();
        peer.execute(
            "UPDATE api_collections SET scope = 'global', \
             updated_at = '2027-06-01T00:00:00+00:00' WHERE id = 'c1'",
            [],
        )
        .unwrap();
        for item in &mut items {
            if item.kind == "collection" {
                item.updated_at = "2027-01-01T00:00:00+00:00".into();
            }
        }

        let result = apply_items(&mut peer, "c1", "w2", items).unwrap();

        assert_eq!(result.conflicts, 0);
        assert_eq!(
            text(&peer, "SELECT scope FROM api_collections WHERE id = 'c1'"),
            "global",
            "a pull must not re-scope the collection to the host's choice"
        );
    }

    /// The `#[serde(default)]` on `ApiCollection::scope`, from the direction that actually bites.
    ///
    /// `push_live` deserialises a peer's payload with `serde_json::from_value` and **silently
    /// skips** one it cannot read. Without the default, every collection shared by a machine on a
    /// build without this column would simply never arrive, and nothing anywhere would say so.
    #[test]
    fn a_payload_from_a_build_without_scope_still_deserialises() {
        let payload = serde_json::json!({
            "id": "c1",
            "workspace_id": "w1",
            "name": "Billing",
            "description": "",
            "auth": "",
            "pre_script": "",
            "post_script": "",
            "variables": "[]",
            "sort_order": 0,
            "pinned": false,
            "created_at": "t",
            "updated_at": "t"
        });
        let collection: ApiCollection =
            serde_json::from_value(payload).expect("an older peer's collection must still parse");
        assert_eq!(collection.scope, "workspace");
    }

    // -----------------------------------------------------------------------
    // Credentials, current values, moves, deletes
    // -----------------------------------------------------------------------

    const HOST_SPEC: &str = r#"{"auth":{"type":"bearer","bearer":{"token":"host-token-1111"},"basic":{"username":"u","password":"{{password}}"}},"mqtt":{"password":"host-mqtt-2222"}}"#;
    const HOST_AUTH: &str = r#"{"type":"apikey","apikey":{"key":"X-API-Key","value":"host-key-3333","addTo":"header"}}"#;
    const HOST_VARIABLES: &str = r#"[
        {"id":"v1","key":"baseUrl","initialValue":"https://api.example.com","currentValue":"http://localhost:8080","secret":false,"enabled":true},
        {"id":"v2","key":"token","initialValue":"","currentValue":"script-token-4444","secret":false,"enabled":true},
        {"id":"v3","key":"apiKey","initialValue":"host-secret-5555","currentValue":"","secret":true,"enabled":true}
    ]"#;

    /// A host whose collection carries credentials, and a guest that has pulled it once.
    fn host_and_guest() -> (Connection, Connection) {
        let host = seeded();
        host.execute(
            "UPDATE api_collections SET auth = ?1, variables = ?2 WHERE id = 'c1'",
            params![HOST_AUTH, HOST_VARIABLES],
        )
        .unwrap();
        host.execute("UPDATE api_requests SET spec = ?1 WHERE id = 'r1'", params![HOST_SPEC]).unwrap();
        let items = local_items(&host, "c1").unwrap();
        record_base(&host, "c1", &items).unwrap();

        let mut guest = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&guest).unwrap();
        guest
            .execute_batch(
                r#"
                INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                    VALUES ('w2', 'Mine', '', '', 0, '2026-01-01T00:00:00+00:00');
                INSERT INTO api_shared_collections (collection_id, workspace_id, remote_name, role, created_at)
                    VALUES ('c1', 'w2', 'My API', 'member', '2026-01-01T00:00:00+00:00');
                "#,
            )
            .unwrap();
        apply_items(&mut guest, "c1", "w2", items).unwrap();
        (host, guest)
    }

    /// The guest types their own credentials in — a write that changes nothing a push carries, so it
    /// is not stamped (see `api_queries::update_request`).
    fn guest_fills_in_their_own(guest: &Connection) {
        let edit = |raw: &str, change: &dyn Fn(&mut serde_json::Value)| -> String {
            let mut value: serde_json::Value = serde_json::from_str(raw).unwrap();
            change(&mut value);
            value.to_string()
        };
        let mut request = api_queries::load_collection(guest, "c1").unwrap().unwrap().2.remove(0);
        request.spec = edit(&request.spec, &|spec| spec["auth"]["bearer"]["token"] = "guest-token-6666".into());
        api_queries::update_request(guest, &request).unwrap();
        let mut collection = api_queries::load_collection(guest, "c1").unwrap().unwrap().0;
        collection.auth = edit(&collection.auth, &|auth| auth["apikey"]["value"] = "guest-key-7777".into());
        collection.variables =
            edit(&collection.variables, &|list| list[0]["currentValue"] = "http://guest.local".into());
        api_queries::update_collection(guest, &collection).unwrap();
    }

    #[test]
    fn nothing_but_initial_values_and_references_is_pushed() {
        let host = seeded();
        host.execute(
            "UPDATE api_collections SET auth = ?1, variables = ?2 WHERE id = 'c1'",
            params![HOST_AUTH, HOST_VARIABLES],
        )
        .unwrap();
        host.execute("UPDATE api_requests SET spec = ?1 WHERE id = 'r1'", params![HOST_SPEC]).unwrap();

        let wire = serde_json::to_string(&local_items(&host, "c1").unwrap()).unwrap();

        for secret in ["host-token-1111", "host-mqtt-2222", "host-key-3333", "host-secret-5555"] {
            assert!(!wire.contains(secret), "{secret} must not be pushed");
        }
        // Current values are this machine's own — a script's token above all.
        assert!(!wire.contains("script-token-4444"));
        assert!(!wire.contains("localhost:8080"));
        // What is shared still is: the initial value, the variable itself, and a reference.
        assert!(wire.contains("https://api.example.com"));
        assert!(wire.contains(r#"\"key\":\"token\""#) || wire.contains("\\\"token\\\""));
        assert!(wire.contains("{{password}}"), "a reference is not a credential and must travel");
    }

    /// A sealed slot's marker is a credential too — it names this machine's keychain entry.
    #[test]
    fn a_sealed_marker_is_never_pushed() {
        let host = seeded();
        host.execute(
            "UPDATE api_requests SET spec = ?1 WHERE id = 'r1'",
            params![r#"{"auth":{"type":"bearer","bearer":{"token":"cf-keychain:auth.bearer.token"}}}"#],
        )
        .unwrap();
        let wire = serde_json::to_string(&local_items(&host, "c1").unwrap()).unwrap();
        assert!(!wire.contains("cf-keychain"));
    }

    /// The bug: a teammate's rename arrived with every credential slot blank (a push never carries
    /// one) and the pull wrote it over the whole auth block and variable list.
    #[test]
    fn a_teammates_edit_keeps_my_credentials_and_current_values() {
        let (host, mut guest) = host_and_guest();
        guest_fills_in_their_own(&guest);

        host.execute_batch(
            "UPDATE api_requests SET name = 'Login (renamed)', updated_at = '2027-01-01T00:00:00+00:00' WHERE id = 'r1';
             UPDATE api_collections SET name = 'My API (renamed)', updated_at = '2027-01-01T00:00:00+00:00' WHERE id = 'c1';",
        )
        .unwrap();
        let result = apply_items(&mut guest, "c1", "w2", local_items(&host, "c1").unwrap()).unwrap();

        assert_eq!(result.conflicts, 0, "a credential typed here is not an edit that competes");
        assert_eq!(text(&guest, "SELECT name FROM api_requests WHERE id = 'r1'"), "Login (renamed)");
        assert_eq!(text(&guest, "SELECT name FROM api_collections WHERE id = 'c1'"), "My API (renamed)");
        let spec = text(&guest, "SELECT spec FROM api_requests WHERE id = 'r1'");
        assert!(spec.contains("guest-token-6666"), "the guest's token survived: {spec}");
        assert!(spec.contains("{{password}}"));
        let auth = text(&guest, "SELECT auth FROM api_collections WHERE id = 'c1'");
        assert!(auth.contains("guest-key-7777"), "the guest's API key survived: {auth}");
        let variables = text(&guest, "SELECT variables FROM api_collections WHERE id = 'c1'");
        assert!(variables.contains("http://guest.local"), "the guest's current value survived: {variables}");
    }

    /// Only the initial value is shared, so a teammate changing it reaches everyone — and a current
    /// value set here still wins here, as it does in Postman.
    #[test]
    fn a_changed_initial_value_arrives_under_the_local_current_value() {
        let (host, mut guest) = host_and_guest();
        guest_fills_in_their_own(&guest);

        let variables = HOST_VARIABLES.replace("https://api.example.com", "https://v2.api.example.com");
        host.execute(
            "UPDATE api_collections SET variables = ?1, updated_at = '2027-01-01T00:00:00+00:00' WHERE id = 'c1'",
            params![variables],
        )
        .unwrap();
        apply_items(&mut guest, "c1", "w2", local_items(&host, "c1").unwrap()).unwrap();

        let stored: serde_json::Value =
            serde_json::from_str(&text(&guest, "SELECT variables FROM api_collections WHERE id = 'c1'")).unwrap();
        assert_eq!(stored[0]["initialValue"], "https://v2.api.example.com");
        assert_eq!(stored[0]["currentValue"], "http://guest.local");
        // The host's script-set current value never reached the guest.
        assert_eq!(stored[1]["currentValue"], "");
    }

    /// "Take theirs" is their version of the record, not their copy of my credentials.
    #[test]
    fn taking_theirs_in_a_conflict_keeps_my_credentials() {
        let (host, mut guest) = host_and_guest();
        guest_fills_in_their_own(&guest);
        guest
            .execute(
                "UPDATE api_requests SET name = 'Login (mine)', updated_at = '2027-06-01T00:00:00+00:00' WHERE id = 'r1'",
                [],
            )
            .unwrap();
        host.execute(
            "UPDATE api_requests SET name = 'Login (theirs)', updated_at = '2027-01-01T00:00:00+00:00' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        let result = apply_items(&mut guest, "c1", "w2", local_items(&host, "c1").unwrap()).unwrap();
        assert_eq!(result.conflicts, 1);

        resolve(&mut guest, "c1", "request", "r1", Resolution::Theirs).unwrap();

        assert_eq!(text(&guest, "SELECT name FROM api_requests WHERE id = 'r1'"), "Login (theirs)");
        assert!(text(&guest, "SELECT spec FROM api_requests WHERE id = 'r1'").contains("guest-token-6666"));
    }

    /// A move used to leave `updated_at` alone, so the delta push never carried it and every other
    /// member kept the old parent and the old order for good.
    #[test]
    fn a_move_travels_to_the_other_members() {
        let (host, mut guest) = host_and_guest();
        let folder = api_queries::create_folder(&host, "c1", None, "Orders").unwrap();
        let first = local_items(&host, "c1").unwrap();
        record_base(&host, "c1", &first).unwrap();
        apply_items(&mut guest, "c1", "w2", first).unwrap();

        let moved = api_queries::move_node(&host, "request", "r1", "c1", Some(&folder.id), 0).unwrap();
        assert_eq!(moved.requests, vec!["r1".to_string()]);

        let delta = local_items(&host, "c1").unwrap();
        assert!(delta.iter().any(|item| item.id == "r1"), "the moved request is in the next push");
        let result = apply_items(&mut guest, "c1", "w2", delta).unwrap();

        assert_eq!(result.conflicts, 0);
        assert_eq!(text(&guest, "SELECT folder_id FROM api_requests WHERE id = 'r1'"), folder.id);
    }

    /// Out of one collection and into another is, for the first, a removal — and a removal travels
    /// as a tombstone, or that collection's members keep the request for ever.
    #[test]
    fn a_move_into_another_collection_tombstones_it_in_the_first() {
        let host = seeded();
        record_base(&host, "c1", &local_items(&host, "c1").unwrap()).unwrap();
        host.execute_batch(
            "INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                 VALUES ('c2', 'w1', 'Other', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();

        api_queries::move_node(&host, "request", "r1", "c2", None, 0).unwrap();

        let outbound = local_items(&host, "c1").unwrap();
        assert!(outbound.iter().any(|item| item.id == "r1" && item.deleted));
        // And moved back before that travelled, it is live there again with no tombstone beside it.
        api_queries::move_node(&host, "request", "r1", "c1", None, 0).unwrap();
        let outbound = local_items(&host, "c1").unwrap();
        assert!(outbound.iter().any(|item| item.id == "r1" && !item.deleted));
        assert!(!outbound.iter().any(|item| item.id == "r1" && item.deleted));
    }

    /// The fix for the P0: a guest's delete is theirs alone. No tombstone may be written, or the next
    /// push deletes the collection on every machine, the host's included.
    #[test]
    fn a_guests_delete_never_travels() {
        let (_host, guest) = host_and_guest();

        api_queries::delete_collection_locally(&guest, "c1").unwrap();

        assert_eq!(scalar(&guest, "SELECT COUNT(*) FROM api_collections WHERE id = 'c1'"), 0);
        assert_eq!(scalar(&guest, "SELECT COUNT(*) FROM api_tombstones WHERE collection_id = 'c1'"), 0);
        assert_eq!(scalar(&guest, "SELECT COUNT(*) FROM api_shared_collections WHERE collection_id = 'c1'"), 0);
        assert!(local_items(&guest, "c1").unwrap().is_empty(), "nothing left to push");
    }

    /// Changing only a credential or a current value is not an edit a push carries, so it must not
    /// be stamped: a stamp would send a record with nothing new in it, and freeze it as a conflict
    /// the moment a teammate edited it too.
    #[test]
    fn a_change_a_push_would_not_carry_is_not_stamped() {
        let (host, _guest) = host_and_guest();
        let before = text(&host, "SELECT updated_at FROM api_requests WHERE id = 'r1'");
        let mut request = api_queries::load_collection(&host, "c1").unwrap().unwrap().2.remove(0);
        request.spec = request.spec.replace("host-token-1111", "rotated-token");
        let stamp = api_queries::update_request(&host, &request).unwrap();
        assert_eq!(stamp, before);
        assert!(text(&host, "SELECT spec FROM api_requests WHERE id = 'r1'").contains("rotated-token"));

        let mut collection = api_queries::load_collection(&host, "c1").unwrap().unwrap().0;
        let collection_before = collection.updated_at.clone();
        collection.variables = collection.variables.replace("script-token-4444", "next-script-token");
        collection.pinned = true;
        api_queries::update_collection(&host, &collection).unwrap();
        assert_eq!(text(&host, "SELECT updated_at FROM api_collections WHERE id = 'c1'"), collection_before);
        assert!(local_items(&host, "c1").unwrap().is_empty());

        // A rename is an edit, and is stamped.
        collection.name = "Renamed".into();
        api_queries::update_collection(&host, &collection).unwrap();
        assert_ne!(text(&host, "SELECT updated_at FROM api_collections WHERE id = 'c1'"), collection_before);
    }

    /// An OAuth 2 refresh writes a new access token *and* its expiry. Both are this machine's: the
    /// refresh must not stamp the row (it would push and conflict on every refresh), and a pull must
    /// not replace the expiry of the token it keeps with a teammate's.
    #[test]
    fn a_token_refresh_stays_on_this_machine() {
        let host = seeded();
        let spec = |token: &str, expires: i64| {
            serde_json::json!({"auth": {"type": "oauth2", "oauth2": {"accessToken": token, "expiresAt": expires}}}).to_string()
        };
        host.execute("UPDATE api_requests SET spec = ?1 WHERE id = 'r1'", params![spec("first", 100)]).unwrap();
        record_base(&host, "c1", &local_items(&host, "c1").unwrap()).unwrap();

        let mut request = api_queries::load_collection(&host, "c1").unwrap().unwrap().2.remove(0);
        let before = request.updated_at.clone();
        request.spec = spec("refreshed", 200);
        assert_eq!(api_queries::update_request(&host, &request).unwrap(), before, "a refresh is not an edit");
        assert!(local_items(&host, "c1").unwrap().is_empty());

        // A teammate renames it; their payload says nothing about our token or when it expires.
        let mut items = local_items(&seeded(), "c1").unwrap();
        for item in &mut items {
            if item.kind == "request" {
                item.payload["name"] = "Renamed".into();
                item.payload["spec"] = spec("", 0).into();
                item.updated_at = "2027-01-01T00:00:00+00:00".into();
            }
        }
        let mut host = host;
        apply_items(&mut host, "c1", "w1", items).unwrap();
        let stored: serde_json::Value =
            serde_json::from_str(&text(&host, "SELECT spec FROM api_requests WHERE id = 'r1'")).unwrap();
        assert_eq!(stored["auth"]["oauth2"]["accessToken"], "refreshed");
        assert_eq!(stored["auth"]["oauth2"]["expiresAt"], 200);
    }

    /// A pulled script is somebody else's code: recorded as untrusted, labelled as shared, and never
    /// trusted by the sync — whatever the peer's app thought of it.
    #[test]
    fn pulled_scripts_are_recorded_untrusted() {
        let host = seeded();
        host.execute(
            "UPDATE api_requests SET spec = ?1 WHERE id = 'r1'",
            params![r#"{"preScript":"pm.environment.set('x', 1)","postScript":""}"#],
        )
        .unwrap();
        let (mut guest, items) = {
            let items = local_items(&host, "c1").unwrap();
            let guest = Connection::open_in_memory().unwrap();
            super::super::migrations::run(&guest).unwrap();
            guest
                .execute_batch(
                    "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                         VALUES ('w2', 'Mine', '', '', 0, '2026-01-01T00:00:00+00:00');
                     INSERT INTO api_shared_collections (collection_id, workspace_id, remote_name, role, created_at)
                         VALUES ('c1', 'w2', 'My API', 'member', '2026-01-01T00:00:00+00:00');",
                )
                .unwrap();
            (guest, items)
        };
        apply_items(&mut guest, "c1", "w2", items).unwrap();

        let found = api_trust::lookup(&guest, &[api_trust::script_hash("pm.environment.set('x', 1)")]).unwrap();
        assert_eq!(found.len(), 1);
        assert!(!found[0].trusted);
        assert_eq!(found[0].origin, api_trust::ORIGIN_SHARED);
    }

    /// The upgrade to "only the initial value is shared": a current value that merely repeats its
    /// initial is emptied (it would shadow a teammate's change to the initial), and a real local
    /// override — or a value that only ever lived in the current column — is left alone.
    #[test]
    fn a_current_value_repeating_the_initial_is_emptied_once() {
        let raw = r#"[{"key":"a","initialValue":"x","currentValue":"x"},
                      {"key":"b","initialValue":"x","currentValue":"y"},
                      {"key":"c","initialValue":"","currentValue":"z"}]"#;
        let split: serde_json::Value = serde_json::from_str(&split_current_values(raw).unwrap()).unwrap();
        assert_eq!(split[0]["currentValue"], "");
        assert_eq!(split[1]["currentValue"], "y");
        assert_eq!(split[2]["currentValue"], "z");
        assert!(split_current_values(&split.to_string()).is_none(), "nothing left to do the second time");

        let conn = seeded();
        conn.execute("UPDATE api_collections SET variables = ?1 WHERE id = 'c1'", params![raw]).unwrap();
        conn.execute("DELETE FROM app_settings WHERE key = 'api_variables_split'", []).unwrap();
        let before = text(&conn, "SELECT updated_at FROM api_collections WHERE id = 'c1'");
        migrate_variable_split(&conn).unwrap();
        assert!(text(&conn, "SELECT variables FROM api_collections WHERE id = 'c1'").contains(r#""currentValue":"""#));
        assert_eq!(text(&conn, "SELECT updated_at FROM api_collections WHERE id = 'c1'"), before);
    }
}
