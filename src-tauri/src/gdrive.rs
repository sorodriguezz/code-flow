//! Google Drive as a backup destination, using the *user's own* OAuth client.
//!
//! Nothing here belongs to CodeFlow's developer: the client id and secret come from a Google Cloud
//! project the user creates, so their backup never passes through anyone else's registration. The
//! cost of that is a one-time setup in the Google Cloud console; the benefit is that no credential
//! of ours is embedded in the binary and no account of ours is in the path of their data.
//!
//! The browser leg is the one every native app runs and lives in [`crate::oauth`]: a loopback
//! redirect on 127.0.0.1 with PKCE (RFC 7636). What is Google's own, and stays here, is the pair of
//! endpoints, the client secret their "Desktop app" client type insists on, and the fact that a
//! refresh token is only issued when it is asked for explicitly.
//!
//! Scope is `drive.file`: access limited to files this app created. It cannot read the rest of the
//! user's Drive, and it is the one Drive scope that needs no verification review from Google.
//! Because the grant is tied to the OAuth *client* rather than to an installation, a second machine
//! signing in with the same client id can see — and keep updating — the backup the first one wrote.

use serde::Serialize;

use crate::oauth::{self, urlencode};
use crate::secrets;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";

/// What the browser tab says, and what an error is attributed to.
const SERVICE: &str = "Google Drive";

/// Google registers the loopback redirect as `127.0.0.1`, which is also what its own installed-app
/// documentation uses.
const LOOPBACK_HOST: &str = "127.0.0.1";

/// `drive.file` for the backup itself; `email` only so the UI can name the connected account
/// instead of showing "connected" and leaving the user to guess which of their logins it used.
const SCOPES: &str = "https://www.googleapis.com/auth/drive.file email";

#[derive(Debug, Clone, Serialize)]
pub struct DriveAccount {
    pub email: String,
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Exchanges the stored refresh token for a short-lived access token. Every Drive call goes
/// through here rather than caching the access token: it is valid for an hour, the refresh costs
/// one request, and a cache would be one more piece of state to get wrong across app restarts.
async fn access_token(client_id: &str) -> Result<String, String> {
    let client_secret = secrets::get_secret(&secrets::gdrive_client_secret_key())?
        .ok_or("no Google client secret is configured")?;
    let refresh_token = secrets::get_secret(&secrets::gdrive_refresh_token_key())?
        .ok_or("Google Drive is not connected")?;

    let payload = oauth::post_form(
        TOKEN_ENDPOINT,
        &[
            ("client_id", client_id),
            ("client_secret", &client_secret),
            ("refresh_token", &refresh_token),
            ("grant_type", "refresh_token"),
        ],
    )
    .await?;

    oauth::field(&payload, "access_token")
        .ok_or_else(|| "Google's token response had no access_token".to_string())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Stores the OAuth client secret. Kept apart from `connect` so the credentials can be entered and
/// corrected without starting a browser flow each time.
pub fn set_client_secret(secret: &str) -> Result<(), String> {
    if secret.trim().is_empty() {
        return secrets::delete_secret(&secrets::gdrive_client_secret_key());
    }
    secrets::set_secret(&secrets::gdrive_client_secret_key(), secret)
}

pub fn has_client_secret() -> Result<bool, String> {
    Ok(secrets::get_secret(&secrets::gdrive_client_secret_key())?
        .filter(|s| !s.trim().is_empty())
        .is_some())
}

pub fn is_connected() -> Result<bool, String> {
    Ok(secrets::get_secret(&secrets::gdrive_refresh_token_key())?
        .filter(|s| !s.trim().is_empty())
        .is_some())
}

pub fn disconnect() -> Result<(), String> {
    secrets::delete_secret(&secrets::gdrive_refresh_token_key())
}

/// Runs the full consent flow and returns the account that granted it.
pub async fn connect(client_id: String) -> Result<DriveAccount, String> {
    if client_id.trim().is_empty() {
        return Err("no Google client id is configured".into());
    }
    let client_secret = secrets::get_secret(&secrets::gdrive_client_secret_key())?
        .ok_or("no Google client secret is configured")?;

    // `access_type=offline` with `prompt=consent` is what makes Google return a refresh token:
    // without the prompt it only issues one on the *first* ever authorization, so a user who
    // reconnects after disconnecting would get an account that silently can't refresh.
    let grant = oauth::consent(SERVICE, LOOPBACK_HOST, |redirect_uri, challenge, state| {
        format!(
            "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
            urlencode(&client_id),
            urlencode(redirect_uri),
            urlencode(SCOPES),
            urlencode(challenge),
            urlencode(state),
        )
    })
    .await?;

    let payload = oauth::post_form(
        TOKEN_ENDPOINT,
        &[
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("code", &grant.code),
            ("code_verifier", &grant.verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &grant.redirect_uri),
        ],
    )
    .await?;

    let refresh_token = oauth::field(&payload, "refresh_token")
        .ok_or("Google did not return a refresh token — remove the app's access under your Google account's third-party connections and connect again")?;
    secrets::set_secret(&secrets::gdrive_refresh_token_key(), &refresh_token)?;

    let access = oauth::field(&payload, "access_token").unwrap_or_default();

    Ok(DriveAccount {
        email: fetch_email(&access).await.unwrap_or_default(),
    })
}

async fn fetch_email(access_token: &str) -> Result<String, String> {
    let response = oauth::client()?
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| oauth::field(&v, "email"))
        .unwrap_or_default())
}

/// The id of a backup this app already put in the user's Drive, if there is one.
///
/// This is what lets a second machine adopt the first one's file instead of creating a rival copy:
/// `drive.file` access follows the OAuth client, so the same client id sees the same file wherever
/// it signs in.
pub async fn find_file(client_id: String, name: String) -> Result<Option<String>, String> {
    let token = access_token(&client_id).await?;
    let query = format!("name = '{}' and trashed = false", name.replace('\'', "\\'"));
    let response = oauth::client()?
        .get(FILES_ENDPOINT)
        .bearer_auth(&token)
        .query(&[
            ("q", query.as_str()),
            ("spaces", "drive"),
            ("fields", "files(id,name,modifiedTime)"),
            ("orderBy", "modifiedTime desc"),
            ("pageSize", "1"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(oauth::describe(status, &body));
    }
    let payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(payload
        .get("files")
        .and_then(|f| f.as_array())
        .and_then(|files| files.first())
        .and_then(|file| file.get("id"))
        .and_then(|id| id.as_str())
        .map(|s| s.to_string()))
}

/// Creates the backup file or overwrites the existing one, returning its id.
///
/// Always the same file rather than a new one per run: a backup that accumulates a copy every ten
/// seconds isn't a backup, it's a mess the user has to clean up.
/// Bytes rather than a `String`, because what goes up is a sealed binary envelope: text would mean
/// either lossy UTF-8 or a base64 round trip inflating it by a third, for a file about to cross a
/// network.
pub async fn upload_bytes(
    client_id: String,
    file_id: Option<String>,
    name: String,
    mime: &str,
    contents: Vec<u8>,
) -> Result<String, String> {
    let token = access_token(&client_id).await?;
    let http = oauth::client()?;

    // Two different uploads, because they need different things. Creating has to carry the name —
    // that is how the *other* machine finds this file — so it goes as `multipart`: one part of
    // metadata, one of content. Updating changes nothing but the bytes, so it goes as `media`,
    // which is the same request without the envelope.
    let request = match &file_id {
        Some(id) => http
            .patch(format!("{UPLOAD_ENDPOINT}/{id}?uploadType=media&fields=id"))
            .header(reqwest::header::CONTENT_TYPE, mime)
            .body(contents),
        None => {
            let boundary = format!("codeflow-{}", uuid::Uuid::new_v4());
            let metadata = serde_json::json!({ "name": name }).to_string();
            // Assembled as bytes rather than through `format!`, because the content part is binary
            // and would not survive being treated as a `str`.
            let mut body = Vec::with_capacity(contents.len() + 512);
            body.extend_from_slice(
                format!(
                    "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
                     --{boundary}\r\nContent-Type: {mime}\r\n\r\n"
                )
                .as_bytes(),
            );
            body.extend_from_slice(&contents);
            body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
            http.post(format!("{UPLOAD_ENDPOINT}?uploadType=multipart&fields=id"))
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/related; boundary={boundary}"),
                )
                .body(body)
        }
    };

    let response = request
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(oauth::describe(status, &text));
    }
    let payload: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    oauth::field(&payload, "id").ok_or_else(|| "Drive's response had no file id".to_string())
}

/// The raw bytes of a file — the sealed backup, which is binary and must not be decoded.
pub async fn download_bytes(client_id: String, file_id: String) -> Result<Vec<u8>, String> {
    let token = access_token(&client_id).await?;
    let response = oauth::client()?
        .get(format!("{FILES_ENDPOINT}/{file_id}"))
        .bearer_auth(&token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(oauth::describe(status, &String::from_utf8_lossy(&body)));
    }
    Ok(body.to_vec())
}
