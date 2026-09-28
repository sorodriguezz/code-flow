//! Shared API collections on the user's *own* Supabase project.
//!
//! Same principle as the Drive backup: nothing routes through a server of ours. The host creates a
//! Supabase project, runs `supabase_schema.sql` in its SQL editor once, and everyone they share a
//! collection with talks straight to it.
//!
//! Authorisation is the share token, not an account — see the long comment at the top of
//! `supabase_schema.sql`, which is the actual specification. Everything in this module does one of
//! two things: send that token in `x-cf-share`, or move rows over PostgREST.
//!
//! **The unit of sharing is one collection.** A share row and the collection it publishes carry the
//! same id, which is what lets a guest drop a shared collection into a workspace they already have
//! instead of adopting the host's entire sidebar.
//!
//! There is no Supabase client library here on purpose. PostgREST is a REST API and `reqwest` is
//! already a dependency. Neither is there a realtime socket: `watermark` is a single-row read of an
//! indexed column, cheap enough to run every few seconds, and a pull only follows when it moved.

use serde::{Deserialize, Serialize};

use crate::secrets;

/// The schema the host installs. Shipped as a file rather than a string literal so it stays
/// readable SQL, and served to the UI through a command so the "copy" button can't drift from it.
pub const INSTALL_SQL: &str = include_str!("supabase_schema.sql");

/// The version of `supabase_schema.sql` this build was written against — what `cf_schema_version()`
/// in the shipped script answers. A project that answers less has an older copy, and its host is
/// asked to run the script again. The test below keeps the two numbers in step.
pub const SCHEMA_VERSION: i64 = 2;

/// Whether a project running `version` of the script lacks something this build relies on.
pub fn schema_outdated(version: i64) -> bool {
    version < SCHEMA_VERSION
}

/// The hash `cf_shares.owner_hash` holds for a host secret — the same digest the script computes
/// with `encode(sha256(convert_to(key, 'UTF8')), 'hex')`: SHA-256 over the UTF-8 bytes, lowercase hex.
pub fn owner_hash(secret: &str) -> String {
    use sha2::{Digest as _, Sha256};
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// The install script as this host should run it on one project: the shipped script, then one line
/// per collection they already share there recording them as its owner.
///
/// That line is what closes the gap an upgrade opens. A share created before owners existed has
/// none, and the first claim wins — so recording the host in the very script that introduces the
/// rule leaves no moment in which a guest could claim it first. Only the hash is written into the
/// script; the secret stays in this machine's credential store. `and owner_hash is null` makes the
/// line a no-op on a share that already has an owner, so running the script twice changes nothing.
pub fn install_sql_for(owned: &[String]) -> Result<String, String> {
    let mut sql = INSTALL_SQL.to_string();
    let mut lines = Vec::new();
    for collection_id in owned {
        // Ids come from this machine's own database, but they are spliced into SQL: only a uuid's
        // alphabet gets through.
        if collection_id.is_empty() || !collection_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            continue;
        }
        let hash = owner_hash(&owner_secret(collection_id)?);
        lines.push(format!(
            "update cf_shares set owner_hash = '{hash}' where id = '{collection_id}' and owner_hash is null;"
        ));
    }
    if !lines.is_empty() {
        sql.push_str(
            "\n-- ---------------------------------------------------------------------------\n\
             -- The collections you already share on this project\n\
             -- ---------------------------------------------------------------------------\n\n\
             -- Records you as their host — a hash of a secret only your app holds.\n",
        );
        sql.push_str(&lines.join("\n"));
        sql.push('\n');
    }
    Ok(sql)
}

const SHARE_HEADER: &str = "x-cf-share";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedItem {
    pub id: String,
    /// The shared collection's id — the same value for the collection row itself and every folder
    /// and request beneath it.
    pub share_id: String,
    /// `collection` | `folder` | `request`
    pub kind: String,
    /// The record exactly as the client stores it.
    pub payload: serde_json::Value,
    /// The client's own clock, and what the three-way merge compares.
    pub updated_at: String,
    /// The *server's* clock, set by a trigger. Never sent — it is assigned on write and only read
    /// back, because paging on a client clock loses the changes of anyone whose machine is behind.
    #[serde(default, skip_serializing)]
    pub synced_at: String,
    #[serde(default)]
    pub deleted: bool,
}

/// One share, as the remote knows it.
#[derive(Debug, Clone, Serialize)]
pub struct SharedCollection {
    pub id: String,
    pub name: String,
    pub share_token: String,
}

/// What a connection test found, in the order the UI has to explain it. Deliberately about the
/// *project* only: which collections are shared is a per-collection question, answered by `probe`.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConnectionCheck {
    /// The project answered at all — URL and anon key are right.
    pub reachable: bool,
    /// `cf_ping` exists, so the schema script has been run.
    pub schema_installed: bool,
    /// Which copy of the script the project runs: `cf_schema_version()`, or 1 for a copy from before
    /// that function existed. 0 when the schema is not installed at all.
    pub schema_version: i64,
    /// The project's copy is older than this build expects — the host should run it again.
    pub schema_outdated: bool,
}

fn trimmed_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Two URLs naming the same project, compared the way the credential store files a key per project.
pub fn same_project(a: &str, b: &str) -> bool {
    let host = |url: &str| {
        trimmed_url(url)
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .to_ascii_lowercase()
    };
    !host(a).is_empty() && host(a) == host(b)
}

/// A PostgREST answer meaning "there is no such function" — an older copy of the script, not an
/// error worth failing over.
fn function_missing(status: reqwest::StatusCode, body: &str, function: &str) -> bool {
    status == reqwest::StatusCode::NOT_FOUND || (!status.is_success() && body.contains(function))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// The anon key goes in both `apikey` and `Authorization`: PostgREST reads the role from the JWT in
/// the second, and Supabase's gateway requires the first.
fn request(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    anon_key: &str,
    share_token: &str,
) -> reqwest::RequestBuilder {
    http.request(method, url)
        .header("apikey", anon_key)
        .bearer_auth(anon_key)
        .header(SHARE_HEADER, share_token)
}

/// PostgREST errors are `{message, hint, details}`; surfacing `message` is the difference between
/// "400 Bad Request" and "relation cf_items does not exist".
fn describe(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value.get("message").and_then(|m| m.as_str()) {
            let hint = value.get("hint").and_then(|h| h.as_str()).unwrap_or("");
            return if hint.is_empty() {
                message.to_string()
            } else {
                format!("{message} ({hint})")
            };
        }
    }
    let excerpt: String = body.chars().take(300).collect();
    format!("{status}: {excerpt}")
}

async fn read_body(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(describe(status, &body))
    }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// The anon key is public by design, but it is still the identifier of *a* project, and the share
/// token very much is a credential — both live in the OS credential store rather than in settings.
///
/// Stored per project. Accepting an invitation to a collection on someone else's project must not
/// disturb the key for the project the user hosts their own shares on.
pub fn set_credentials(project_url: &str, anon_key: &str) -> Result<(), String> {
    if anon_key.trim().is_empty() {
        return secrets::delete_secret(&secrets::supabase_anon_key(project_url));
    }
    secrets::set_secret(&secrets::supabase_anon_key(project_url), anon_key)
}

pub fn has_credentials(project_url: &str) -> Result<bool, String> {
    Ok(public_anon_key(project_url)?.is_some())
}

/// The stored anon key for one project, for building an invitation.
///
/// Handing it back to the UI is safe and deliberate: the anon key is public by design — it names
/// the project, it authorises nothing, and the row-level-security policies ignore it entirely. It
/// lives in the credential store because it belongs beside the share tokens, not because it is a
/// secret. Not reading it back is what used to make "copy invitation" fail until the key was typed
/// in again from the dashboard.
///
/// Falls back to the single pre-multi-project entry, so an existing setup keeps working untouched.
pub fn public_anon_key(project_url: &str) -> Result<Option<String>, String> {
    if let Some(key) = secrets::get_secret(&secrets::supabase_anon_key(project_url))?
        .filter(|k| !k.trim().is_empty())
    {
        return Ok(Some(key));
    }
    Ok(secrets::get_secret(&secrets::supabase_legacy_anon_key())?.filter(|k| !k.trim().is_empty()))
}

fn anon_key(project_url: &str) -> Result<String, String> {
    public_anon_key(project_url)?
        .ok_or_else(|| format!("no Supabase anon key is stored for {}", trimmed_url(project_url)))
}

/// The share token for one local collection. Keyed per collection so a user can host one shared
/// collection and be a guest in another at the same time.
pub fn set_share_token(collection_id: &str, token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return secrets::delete_secret(&secrets::supabase_share_token(collection_id));
    }
    secrets::set_secret(&secrets::supabase_share_token(collection_id), token)
}

pub fn share_token(collection_id: &str) -> Result<Option<String>, String> {
    Ok(secrets::get_secret(&secrets::supabase_share_token(collection_id))?
        .filter(|t| !t.trim().is_empty()))
}

fn require_token(collection_id: &str) -> Result<String, String> {
    share_token(collection_id)?.ok_or_else(|| "this collection is not shared".to_string())
}

/// The host's own secret for one shared collection, minted on first use. See
/// `secrets::supabase_owner_key` for why it is not the share token.
fn owner_secret(collection_id: &str) -> Result<String, String> {
    let key = secrets::supabase_owner_key(collection_id);
    if let Some(existing) = secrets::get_secret(&key)?.filter(|value| !value.trim().is_empty()) {
        return Ok(existing);
    }
    let minted = mint_token();
    secrets::set_secret(&key, &minted)?;
    Ok(minted)
}

/// 32 bytes of entropy, URL-safe. Two v4 UUIDs because `uuid` is already the crate backed by the
/// OS random source, and a share token is only ever compared for equality.
fn mint_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/// Answers the two questions the settings panel asks in order: can we reach the project, and has
/// the schema been installed.
///
/// Runs with an empty share token on purpose. The check is about the project, and pinging with one
/// collection's token would make "connected" mean something different depending on which row of the
/// sidebar happened to be selected.
pub async fn check(url: String) -> Result<ConnectionCheck, String> {
    let key = anon_key(&url)?;
    match ping(&url, &key, "").await? {
        Some(_) => {
            let version = schema_version(&url, &key).await?;
            Ok(ConnectionCheck {
                reachable: true,
                schema_installed: true,
                schema_version: version,
                schema_outdated: schema_outdated(version),
            })
        }
        None => Ok(ConnectionCheck {
            reachable: true,
            schema_installed: false,
            schema_version: 0,
            schema_outdated: false,
        }),
    }
}

/// `cf_schema_version()`, or 1 when the project's copy of the script predates it.
async fn schema_version(url: &str, key: &str) -> Result<i64, String> {
    let http = client()?;
    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/rpc/cf_schema_version", trimmed_url(url)),
        key,
        "",
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .body("{}")
    .send()
    .await
    .map_err(|e| format!("could not reach the project: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if function_missing(status, &body, "cf_schema_version") {
        return Ok(1);
    }
    if !status.is_success() {
        return Err(describe(status, &body));
    }
    Ok(body.trim().parse::<i64>().unwrap_or(1))
}

/// The name the remote has for this collection's share, or `None` when the token resolves to
/// nothing — which is what a rotated or revoked token looks like from here.
pub async fn probe(url: String, collection_id: String) -> Result<Option<String>, String> {
    let key = anon_key(&url)?;
    let Some(token) = share_token(&collection_id)? else {
        return Ok(None);
    };
    match ping(&url, &key, &token).await? {
        // `cf_ping` answers with the empty string when the token matches no share.
        Some(name) if !name.is_empty() => Ok(Some(name)),
        _ => Ok(None),
    }
}

/// One `cf_ping` round trip. `Ok(None)` means the project answered but the function isn't there —
/// the schema has not been installed — which is a different problem from a project that is
/// unreachable and has to be reported differently.
async fn ping(url: &str, key: &str, token: &str) -> Result<Option<String>, String> {
    let http = client()?;
    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/rpc/cf_ping", trimmed_url(url)),
        key,
        token,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .body("{}")
    .send()
    .await;

    let response = match response {
        Ok(response) => response,
        // A transport failure is the "wrong URL / no network" case, and is worth distinguishing
        // from a project that answers with an error.
        Err(e) => return Err(format!("could not reach the project: {e}")),
    };

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;

    if status == reqwest::StatusCode::NOT_FOUND || (body.contains("cf_ping") && !status.is_success())
    {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    Ok(Some(
        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default(),
    ))
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/// Mints a token, creates the remote share row, and stores the token locally. Returns what the host
/// hands to the people they are inviting.
pub async fn share(
    url: String,
    collection_id: String,
    name: String,
) -> Result<SharedCollection, String> {
    let key = anon_key(&url)?;
    let token = mint_token();
    let http = client()?;

    let row = serde_json::json!({
        "id": collection_id,
        "name": name,
        "share_token": token,
    });

    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/cf_shares", trimmed_url(&url)),
        &key,
        // The insert is checked against the header, so the token has to travel with the request
        // that creates the row it authorises.
        &token,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    // `merge-duplicates` makes re-sharing a collection that already exists remotely a rename plus a
    // token rotation rather than a primary-key violation.
    .header("Prefer", "resolution=merge-duplicates,return=representation")
    .body(row.to_string())
    .send()
    .await
    .map_err(|e| e.to_string())?;

    read_body(response).await?;
    set_share_token(&collection_id, &token)?;
    // Recorded as the host straight away, while nobody else holds the token yet. Best-effort: on a
    // project still running an older copy of the script there is nothing to record it in, and the
    // share works regardless — the claim is retried on the next connection test.
    let _ = claim_owner(url, collection_id.clone()).await;

    Ok(SharedCollection {
        id: collection_id,
        name,
        share_token: token,
    })
}

/// What asking the project to record this machine as a share's host came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// Recorded — now, or already, with this machine's secret.
    Owner,
    /// Somebody else's secret is recorded for it.
    Taken,
    /// The project runs a copy of the script from before owners existed.
    Unsupported,
}

/// Records this machine as the host of one of its own shares, unless somebody already is.
///
/// Idempotent: a share already recorded with this machine's secret answers `Owner` again.
pub async fn claim_owner(url: String, collection_id: String) -> Result<Claim, String> {
    let key = anon_key(&url)?;
    let token = require_token(&collection_id)?;
    let owner = owner_secret(&collection_id)?;
    let http = client()?;
    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/rpc/cf_claim_owner", trimmed_url(&url)),
        &key,
        &token,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .body(serde_json::json!({ "owner_key": owner }).to_string())
    .send()
    .await
    .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if function_missing(status, &body, "cf_claim_owner") {
        return Ok(Claim::Unsupported);
    }
    if !status.is_success() {
        return Err(describe(status, &body));
    }
    Ok(if body.trim() == "true" { Claim::Owner } else { Claim::Taken })
}

/// Keeps the remote share's display name in step with a local rename. Best-effort by design: a
/// rename that can't reach the project is not worth failing the rename itself over.
pub async fn rename(url: String, collection_id: String, name: String) -> Result<(), String> {
    let key = anon_key(&url)?;
    let token = require_token(&collection_id)?;
    let http = client()?;

    let response = request(
        &http,
        reqwest::Method::PATCH,
        format!(
            "{}/rest/v1/cf_shares?id=eq.{}",
            trimmed_url(&url),
            collection_id
        ),
        &key,
        &token,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .header("Prefer", "return=minimal")
    .body(serde_json::json!({ "name": name }).to_string())
    .send()
    .await
    .map_err(|e| e.to_string())?;

    read_body(response).await?;
    Ok(())
}

/// Resolves an invitation token to the share it names, and remembers the token locally. Does not
/// touch the local database — the caller decides which workspace the collection lands in.
pub async fn join(url: String, token: String) -> Result<SharedCollection, String> {
    let key = anon_key(&url)?;
    let http = client()?;

    let response = request(
        &http,
        reqwest::Method::GET,
        format!(
            "{}/rest/v1/cf_shares?select=id,name&limit=1",
            trimmed_url(&url)
        ),
        &key,
        &token,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;

    let body = read_body(response).await?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let row = rows
        .first()
        .ok_or("that invitation code does not match a shared collection")?;

    let id = row
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("the shared collection has no id")?
        .to_string();
    let name = row
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    set_share_token(&id, &token)?;
    Ok(SharedCollection {
        id,
        name,
        share_token: token,
    })
}

/// Replaces the token, which is how access is taken back: anyone still holding the old one stops
/// matching every policy on their next request.
///
/// On a current schema the project checks the host's secret itself (`cf_rotate_token`), so a guest
/// calling it directly is refused whatever their app says. A project still running an older copy of
/// the script has no owner to check; there the old call is used and the collaboration settings ask
/// the host to run the script again.
pub async fn rotate(url: String, collection_id: String) -> Result<String, String> {
    let key = anon_key(&url)?;
    let current = require_token(&collection_id)?;
    let next = mint_token();
    let http = client()?;

    let body = match claim_owner(url.clone(), collection_id.clone()).await? {
        Claim::Owner => serde_json::json!({ "new_token": next, "owner_key": owner_secret(&collection_id)? }),
        Claim::Taken => {
            return Err("the project records someone else as the host of this collection".to_string())
        }
        Claim::Unsupported => serde_json::json!({ "new_token": next }),
    };

    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/rpc/cf_rotate_token", trimmed_url(&url)),
        &key,
        &current,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .body(body.to_string())
    .send()
    .await
    .map_err(|e| e.to_string())?;

    read_body(response).await?;
    set_share_token(&collection_id, &next)?;
    Ok(next)
}

/// Stops syncing this collection here. Deliberately local-only: the remote copy and everyone else's
/// access are the host's to end, with `rotate`. The host's own secret goes too — with no share left
/// here there is nothing it could still be used for.
pub fn leave(collection_id: &str) -> Result<(), String> {
    set_share_token(collection_id, "")?;
    secrets::delete_secret(&secrets::supabase_owner_key(collection_id))
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/// Upserts a batch of items. Chunked because PostgREST takes the whole batch in one statement and a
/// collection with a few thousand requests would otherwise be one enormous request.
pub async fn push(
    url: String,
    collection_id: String,
    items: Vec<SharedItem>,
) -> Result<usize, String> {
    if items.is_empty() {
        return Ok(0);
    }
    let key = anon_key(&url)?;
    let token = require_token(&collection_id)?;
    let http = client()?;

    const CHUNK: usize = 200;
    let mut written = 0;
    for chunk in items.chunks(CHUNK) {
        let response = request(
            &http,
            reqwest::Method::POST,
            format!("{}/rest/v1/cf_items", trimmed_url(&url)),
            &key,
            &token,
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("Prefer", "resolution=merge-duplicates,return=minimal")
        .body(serde_json::to_string(chunk).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| e.to_string())?;

        read_body(response).await?;
        written += chunk.len();
    }
    Ok(written)
}

/// Everything the server has seen since `since` (a `synced_at`, or empty for a full pull).
pub async fn pull(
    url: String,
    collection_id: String,
    since: String,
) -> Result<Vec<SharedItem>, String> {
    let key = anon_key(&url)?;
    let token = require_token(&collection_id)?;
    let http = client()?;

    let mut query = format!(
        "{}/rest/v1/cf_items?share_id=eq.{}&select=*&order=synced_at.asc",
        trimmed_url(&url),
        collection_id
    );
    if !since.trim().is_empty() {
        query.push_str(&format!("&synced_at=gt.{}", urlencoding(&since)));
    }

    let response = request(&http, reqwest::Method::GET, query, &key, &token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let body = read_body(response).await?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// The newest `synced_at` the server holds for this share, or `""` when it holds nothing yet.
///
/// This is the whole of the near-realtime path: one indexed row, no payload, small enough to run
/// every few seconds. A pull is only worth its bandwidth once this has moved past the cursor, and
/// asking a question this cheap is what makes a three-second poll reasonable on a free-tier project
/// where a realtime socket would be the only alternative.
pub async fn watermark(url: String, collection_id: String) -> Result<String, String> {
    let key = anon_key(&url)?;
    let token = require_token(&collection_id)?;
    let http = client()?;

    let query = format!(
        "{}/rest/v1/cf_items?share_id=eq.{}&select=synced_at&order=synced_at.desc&limit=1",
        trimmed_url(&url),
        collection_id
    );

    let response = request(&http, reqwest::Method::GET, query, &key, &token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let body = read_body(response).await?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(rows
        .first()
        .and_then(|row| row.get("synced_at"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string())
}

/// Timestamps carry `+` and `:`, which are not safe raw in a query value.
fn urlencoding(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_long_and_never_repeat() {
        let a = mint_token();
        assert_eq!(a.len(), 64, "two hyphen-less uuids");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, mint_token());
    }

    #[test]
    fn the_project_url_is_normalised_before_paths_are_appended() {
        assert_eq!(trimmed_url("https://x.supabase.co/"), "https://x.supabase.co");
        assert_eq!(trimmed_url("  https://x.supabase.co  "), "https://x.supabase.co");
        assert_eq!(trimmed_url("https://x.supabase.co"), "https://x.supabase.co");
    }

    #[test]
    fn timestamps_survive_the_query_string() {
        assert_eq!(
            urlencoding("2026-07-28T12:00:00+00:00"),
            "2026-07-28T12%3A00%3A00%2B00%3A00"
        );
    }

    #[test]
    fn postgrest_errors_become_sentences() {
        assert_eq!(
            describe(
                reqwest::StatusCode::NOT_FOUND,
                r#"{"message":"relation \"public.cf_items\" does not exist"}"#
            ),
            "relation \"public.cf_items\" does not exist"
        );
        assert_eq!(
            describe(
                reqwest::StatusCode::BAD_REQUEST,
                r#"{"message":"new row violates row-level security policy","hint":"check the share token"}"#
            ),
            "new row violates row-level security policy (check the share token)"
        );
    }

    #[test]
    fn the_cursor_column_is_maintained_by_the_server() {
        // A default alone would only fire on insert, and every write here is an upsert. Without the
        // trigger an edited row keeps its creation timestamp and no peer's cursor ever sees it.
        assert!(INSTALL_SQL.contains("synced_at    timestamptz not null default now()"));
        assert!(INSTALL_SQL.contains("create trigger cf_items_touch before insert or update"));
        assert!(INSTALL_SQL.contains("new.synced_at = now()"));
    }

    /// The watermark probe runs every few seconds; on a share with thousands of rows it is only
    /// affordable if the index it reads is ordered the way the query is.
    #[test]
    fn the_watermark_probe_has_an_index_to_read() {
        assert!(INSTALL_SQL.contains("create index if not exists cf_items_sync on cf_items (share_id, synced_at desc)"));
    }

    #[test]
    fn a_pushed_item_never_carries_a_synced_at() {
        // Sending it would let a client with a skewed clock write the column the cursor pages on.
        let item = SharedItem {
            id: "r1".into(),
            share_id: "c1".into(),
            kind: "request".into(),
            payload: serde_json::json!({}),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
            synced_at: "2020-01-01T00:00:00+00:00".into(),
            deleted: false,
        };
        let body = serde_json::to_string(&item).unwrap();
        assert!(!body.contains("synced_at"), "synced_at must not be sent: {body}");
        assert!(body.contains("updated_at"));
        assert!(body.contains("share_id"));
    }

    #[test]
    fn the_shipped_schema_locks_both_tables_down() {
        // The empty-token guard is what stops a client with only the anon key from reading
        // everything; a refactor that drops it must fail here rather than in production.
        // `cf_items` has one policy with a `using` and a `with check` branch; `cf_shares` has three
        // (read, create, change — the last with both branches). Every one of the six has to carry
        // the guard: a read branch without it leaks, a write branch without it lets anyone holding
        // the anon key insert.
        assert_eq!(
            INSTALL_SQL.matches("cf_token() <> ''").count(),
            6,
            "every policy branch must reject an absent share token"
        );
        for table in ["cf_shares", "cf_items"] {
            assert!(INSTALL_SQL.contains(&format!("alter table {table} enable row level security")));
            assert!(INSTALL_SQL.contains(&format!("alter table {table} force row level security")));
        }
    }

    /// The app-side half of the version check: the number the shipped script reports is the number
    /// this build compares against, so a host who re-runs the script stops being told to.
    #[test]
    fn the_script_reports_the_schema_version_this_build_expects() {
        let function = INSTALL_SQL
            .split("create or replace function cf_schema_version()")
            .nth(1)
            .expect("the script defines cf_schema_version");
        let body = function.split("$$").nth(1).expect("a function body");
        assert_eq!(body.trim(), format!("select {SCHEMA_VERSION}"));
    }

    #[test]
    fn an_older_copy_of_the_script_is_reported_as_outdated() {
        assert!(schema_outdated(1), "a project without cf_schema_version runs version 1");
        assert!(!schema_outdated(SCHEMA_VERSION));
        assert!(!schema_outdated(SCHEMA_VERSION + 1), "a newer script is not a reason to nag");
    }

    /// Rotation is the host's alone, in the script itself — the app's own role check cannot stop a
    /// guest who calls the function directly with the token every member holds.
    #[test]
    fn only_the_host_can_rotate_and_nobody_can_delete_a_share() {
        // The old one-argument function is removed, not left beside the new one as an overload.
        assert!(INSTALL_SQL.contains("drop function if exists cf_rotate_token(text);"));
        assert!(INSTALL_SQL.contains("create or replace function cf_rotate_token(new_token text, owner_key text)"));
        assert!(INSTALL_SQL.contains("and owner_hash = encode(sha256(convert_to(owner_key, 'UTF8')), 'hex')"));
        // A guest cannot write their own hash over the host's.
        assert!(INSTALL_SQL.contains("if old.owner_hash is not null and new.owner_hash is distinct from old.owner_hash"));
        assert!(INSTALL_SQL.contains("create trigger cf_shares_guard_owner before update on cf_shares"));
        // No delete policy on the parent of every item, and no catch-all that would imply one.
        let shares_policies: Vec<&str> = INSTALL_SQL
            .split("create policy")
            .skip(1)
            .filter(|policy| policy.trim_start().starts_with("cf_shares"))
            .collect();
        assert_eq!(shares_policies.len(), 3);
        assert!(shares_policies.iter().all(|policy| !policy.contains("for all") && !policy.contains("for delete")));
    }

    /// The owner line the copy button appends has to hash exactly as the script's own
    /// `encode(sha256(convert_to(key, 'UTF8')), 'hex')` does, or the host's claim would never
    /// match. Pinned to the FIPS 180-2 vector for "abc".
    #[test]
    fn the_owner_hash_is_the_one_postgres_computes() {
        assert_eq!(owner_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn the_install_script_for_nothing_owned_is_the_shipped_one() {
        assert_eq!(install_sql_for(&[]).unwrap(), INSTALL_SQL);
        // Anything that is not a uuid's alphabet is never spliced into the script.
        assert_eq!(install_sql_for(&["c1'; drop table cf_items; --".into()]).unwrap(), INSTALL_SQL);
    }

    #[test]
    fn two_spellings_of_one_project_are_the_same_project() {
        assert!(same_project("https://abc.supabase.co/", "https://ABC.supabase.co"));
        assert!(!same_project("https://abc.supabase.co", "https://abd.supabase.co"));
        assert!(!same_project("", ""));
    }

    /// `create table if not exists` silently leaves a workspace-shaped `cf_items` in place, and
    /// every write against it would then fail on a `workspace_id` that no client sends any more.
    #[test]
    fn the_schema_replaces_the_workspace_shaped_tables() {
        assert!(INSTALL_SQL.contains("drop table if exists cf_items cascade"));
        assert!(INSTALL_SQL.contains("drop table if exists cf_workspaces cascade"));
        assert!(INSTALL_SQL.contains("column_name = 'workspace_id'"));
    }
}
