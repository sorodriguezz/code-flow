//! Shared API workspaces on the user's *own* Supabase project.
//!
//! Same principle as the Drive backup: nothing routes through a server of ours. The host creates a
//! Supabase project, runs `supabase_schema.sql` in its SQL editor once, and everyone they share a
//! workspace with talks straight to it.
//!
//! Authorisation is the share token, not an account — see the long comment at the top of
//! `supabase_schema.sql`, which is the actual specification. Everything in this module does one of
//! two things: send that token in `x-cf-share`, or move rows over PostgREST.
//!
//! There is no Supabase client library here on purpose. PostgREST is a REST API and `reqwest` is
//! already a dependency; the realtime channel is the one part a library would genuinely help with,
//! and this module doesn't open one — it syncs on demand and on a timer instead.

use serde::{Deserialize, Serialize};

use crate::secrets;

/// The schema the host installs. Shipped as a file rather than a string literal so it stays
/// readable SQL, and served to the UI through a command so the "copy" button can't drift from it.
pub const INSTALL_SQL: &str = include_str!("supabase_schema.sql");

const SHARE_HEADER: &str = "x-cf-share";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedItem {
    pub id: String,
    pub workspace_id: String,
    /// `collection` | `folder` | `request` | `environment`
    pub kind: String,
    /// The record exactly as the client stores it.
    pub payload: serde_json::Value,
    /// The client's own clock, and what last-write-wins compares.
    pub updated_at: String,
    /// The *server's* clock, set by a trigger. Never sent — it is assigned on write and only read
    /// back, because paging on a client clock loses the changes of anyone whose machine is behind.
    #[serde(default, skip_serializing)]
    pub synced_at: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SharedWorkspace {
    pub id: String,
    pub name: String,
    pub share_token: String,
}

/// What a connection test found, in the order the UI has to explain it.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConnectionCheck {
    /// The project answered at all — URL and anon key are right.
    pub reachable: bool,
    /// `cf_ping` exists, so the schema script has been run.
    pub schema_installed: bool,
    /// The stored share token resolves to a workspace (empty when there is no token yet).
    pub workspace_name: String,
}

fn trimmed_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
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

/// The anon key is public by design, but it is still the user's project identifier, and the share
/// token very much is a credential — both live in the OS credential store rather than in settings.
pub fn set_credentials(anon_key: &str) -> Result<(), String> {
    if anon_key.trim().is_empty() {
        return secrets::delete_secret(&secrets::supabase_anon_key());
    }
    secrets::set_secret(&secrets::supabase_anon_key(), anon_key)
}

pub fn has_credentials() -> Result<bool, String> {
    Ok(secrets::get_secret(&secrets::supabase_anon_key())?
        .filter(|k| !k.trim().is_empty())
        .is_some())
}

fn anon_key() -> Result<String, String> {
    secrets::get_secret(&secrets::supabase_anon_key())?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "no Supabase anon key is configured".to_string())
}

/// The share token for one local workspace. Keyed per workspace so a user can host one shared
/// workspace and be a guest in another at the same time.
pub fn set_share_token(workspace_id: &str, token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return secrets::delete_secret(&secrets::supabase_share_token(workspace_id));
    }
    secrets::set_secret(&secrets::supabase_share_token(workspace_id), token)
}

pub fn share_token(workspace_id: &str) -> Result<Option<String>, String> {
    Ok(secrets::get_secret(&secrets::supabase_share_token(workspace_id))?
        .filter(|t| !t.trim().is_empty()))
}

fn require_token(workspace_id: &str) -> Result<String, String> {
    share_token(workspace_id)?.ok_or_else(|| "this workspace is not shared".to_string())
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

/// Answers the three questions the settings panel asks in order: can we reach the project, has the
/// schema been installed, and does our token resolve.
pub async fn check(url: String, workspace_id: String) -> Result<ConnectionCheck, String> {
    let key = anon_key()?;
    let token = share_token(&workspace_id)?.unwrap_or_default();
    let http = client()?;

    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/rpc/cf_ping", trimmed_url(&url)),
        &key,
        &token,
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

    if status == reqwest::StatusCode::NOT_FOUND || body.contains("cf_ping") && !status.is_success() {
        return Ok(ConnectionCheck {
            reachable: true,
            schema_installed: false,
            workspace_name: String::new(),
        });
    }
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    // `cf_ping` returns the workspace name, or "" when the token matches nothing.
    let name = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();

    Ok(ConnectionCheck {
        reachable: true,
        schema_installed: true,
        workspace_name: name,
    })
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/// Mints a token, creates the remote workspace row, and stores the token locally. Returns what the
/// host hands to the people they are inviting.
pub async fn share(url: String, workspace_id: String, name: String) -> Result<SharedWorkspace, String> {
    let key = anon_key()?;
    let token = mint_token();
    let http = client()?;

    let row = serde_json::json!({
        "id": workspace_id,
        "name": name,
        "share_token": token,
    });

    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/cf_workspaces", trimmed_url(&url)),
        &key,
        // The insert is checked against the header, so the token has to travel with the request
        // that creates the row it authorises.
        &token,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    // `merge-duplicates` makes re-sharing a workspace that already exists remotely a rename plus a
    // token rotation rather than a primary-key violation.
    .header("Prefer", "resolution=merge-duplicates,return=representation")
    .body(row.to_string())
    .send()
    .await
    .map_err(|e| e.to_string())?;

    read_body(response).await?;
    set_share_token(&workspace_id, &token)?;

    Ok(SharedWorkspace {
        id: workspace_id,
        name,
        share_token: token,
    })
}

/// Adopts an invitation: resolves the token to its workspace and remembers it locally.
pub async fn join(url: String, token: String) -> Result<SharedWorkspace, String> {
    let key = anon_key()?;
    let http = client()?;

    let response = request(
        &http,
        reqwest::Method::GET,
        format!(
            "{}/rest/v1/cf_workspaces?select=id,name&limit=1",
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
        .ok_or("that invitation code does not match a shared workspace")?;

    let id = row
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("the shared workspace has no id")?
        .to_string();
    let name = row
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    set_share_token(&id, &token)?;
    Ok(SharedWorkspace {
        id,
        name,
        share_token: token,
    })
}

/// Replaces the token, which is how access is taken back: anyone still holding the old one stops
/// matching every policy on their next request.
pub async fn rotate(url: String, workspace_id: String) -> Result<String, String> {
    let key = anon_key()?;
    let current = require_token(&workspace_id)?;
    let next = mint_token();
    let http = client()?;

    let response = request(
        &http,
        reqwest::Method::POST,
        format!("{}/rest/v1/rpc/cf_rotate_token", trimmed_url(&url)),
        &key,
        &current,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .body(serde_json::json!({ "new_token": next }).to_string())
    .send()
    .await
    .map_err(|e| e.to_string())?;

    read_body(response).await?;
    set_share_token(&workspace_id, &next)?;
    Ok(next)
}

/// Stops syncing this workspace here. Deliberately local-only: the remote copy and everyone else's
/// access are the host's to end, with `rotate`.
pub fn leave(workspace_id: &str) -> Result<(), String> {
    set_share_token(workspace_id, "")
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/// Upserts a batch of items. Chunked because PostgREST takes the whole batch in one statement and a
/// workspace with a few thousand requests would otherwise be one enormous request.
pub async fn push(url: String, workspace_id: String, items: Vec<SharedItem>) -> Result<usize, String> {
    if items.is_empty() {
        return Ok(0);
    }
    let key = anon_key()?;
    let token = require_token(&workspace_id)?;
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
pub async fn pull(url: String, workspace_id: String, since: String) -> Result<Vec<SharedItem>, String> {
    let key = anon_key()?;
    let token = require_token(&workspace_id)?;
    let http = client()?;

    let mut query = format!(
        "{}/rest/v1/cf_items?workspace_id=eq.{}&select=*&order=synced_at.asc",
        trimmed_url(&url),
        workspace_id
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

    #[test]
    fn a_pushed_item_never_carries_a_synced_at() {
        // Sending it would let a client with a skewed clock write the column the cursor pages on.
        let item = SharedItem {
            id: "r1".into(),
            workspace_id: "w1".into(),
            kind: "request".into(),
            payload: serde_json::json!({}),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
            synced_at: "2020-01-01T00:00:00+00:00".into(),
            deleted: false,
        };
        let body = serde_json::to_string(&item).unwrap();
        assert!(!body.contains("synced_at"), "synced_at must not be sent: {body}");
        assert!(body.contains("updated_at"));
    }

    #[test]
    fn the_shipped_schema_locks_both_tables_down() {
        // The empty-token guard is what stops a client with only the anon key from reading
        // everything; a refactor that drops it must fail here rather than in production.
        // Two policies, each with a `using` and a `with check` branch. Every one of the four has to
        // carry the guard: a read branch without it leaks, a write branch without it lets anyone
        // holding the anon key insert.
        assert_eq!(
            INSTALL_SQL.matches("cf_token() <> ''").count(),
            4,
            "every policy branch must reject an absent share token"
        );
        for table in ["cf_workspaces", "cf_items"] {
            assert!(INSTALL_SQL.contains(&format!("alter table {table} enable row level security")));
            assert!(INSTALL_SQL.contains(&format!("alter table {table} force row level security")));
        }
    }
}
