//! Google Drive as a backup destination, using the *user's own* OAuth client.
//!
//! Nothing here belongs to CodeFlow's developer: the client id and secret come from a Google Cloud
//! project the user creates, so their backup never passes through anyone else's registration. The
//! cost of that is a one-time setup in the Google Cloud console; the benefit is that no credential
//! of ours is embedded in the binary and no account of ours is in the path of their data.
//!
//! The flow is the one Google specifies for installed apps: a loopback redirect on 127.0.0.1 with
//! PKCE (RFC 7636). We bind an ephemeral port, open the system browser, and serve exactly one
//! request — the redirect carrying the authorization code.
//!
//! Scope is `drive.file`: access limited to files this app created. It cannot read the rest of the
//! user's Drive, and it is the one Drive scope that needs no verification review from Google.
//! Because the grant is tied to the OAuth *client* rather than to an installation, a second machine
//! signing in with the same client id can see — and keep updating — the backup the first one wrote.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::secrets;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";

/// `drive.file` for the backup itself; `email` only so the UI can name the connected account
/// instead of showing "connected" and leaving the user to guess which of their logins it used.
const SCOPES: &str = "https://www.googleapis.com/auth/drive.file email";

/// How long the loopback listener waits for the browser round trip before giving up. Long enough
/// to sign in and pick an account, short enough that an abandoned attempt doesn't hold a port and
/// a task for the rest of the session.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
pub struct DriveAccount {
    pub email: String,
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/// A verifier and its S256 challenge. The verifier is what proves, at the token call, that the
/// code was redeemed by whoever started the flow — without it, anything able to observe the
/// loopback redirect could exchange the code itself.
fn pkce_pair() -> (String, String) {
    let mut raw = [0u8; 32];
    getrandom(&mut raw);
    let verifier = URL_SAFE_NO_PAD.encode(raw);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// 32 bytes of OS randomness. `uuid`'s v4 generator is already backed by `getrandom`, which makes
/// it the entropy source that is definitely present rather than a new dependency for 32 bytes.
fn getrandom(out: &mut [u8; 32]) {
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    out[..16].copy_from_slice(a.as_bytes());
    out[16..].copy_from_slice(b.as_bytes());
}

fn urlencode(value: &str) -> String {
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

// ---------------------------------------------------------------------------
// The loopback leg
// ---------------------------------------------------------------------------

/// What the browser lands on once Google redirects back. Plain text in the page, because the user
/// is looking at a tab they now have to close — anything more elaborate would still be a dead end.
fn consent_page(message: &str) -> String {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>CodeFlow</title>\
         <body style=\"font:14px system-ui;padding:3rem;text-align:center\">\
         <p>{message}</p><p style=\"color:#888\">You can close this tab.</p></body>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/// Pulls one query parameter out of a raw request target (`/?code=x&state=y`).
fn query_param(target: &str, key: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(&value[i + 1..i + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Serves requests on the loopback port until one carries the authorization code.
///
/// It loops rather than accepting once because browsers open connections the flow doesn't care
/// about — a speculative preconnect, or `/favicon.ico` right after the redirect renders — and
/// treating the first of those as the callback would abandon a flow that is about to succeed.
async fn await_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;

        let mut buf = vec![0u8; 8192];
        let read = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buf[..read]).into_owned();
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("")
            .to_string();

        if let Some(error) = query_param(&target, "error") {
            let _ = stream
                .write_all(consent_page("Authorization was declined.").as_bytes())
                .await;
            return Err(format!("Google returned: {error}"));
        }

        let Some(code) = query_param(&target, "code") else {
            // Not the redirect — answer and keep waiting.
            let _ = stream.write_all(consent_page("Waiting for Google…").as_bytes()).await;
            continue;
        };

        // The state check is what stops a request forged by something else on this machine from
        // injecting an authorization code into the flow.
        if query_param(&target, "state").as_deref() != Some(expected_state) {
            let _ = stream
                .write_all(consent_page("This response did not match the request.").as_bytes())
                .await;
            return Err("the callback's state did not match — the flow was interfered with".into());
        }

        let _ = stream
            .write_all(consent_page("CodeFlow is connected to Google Drive.").as_bytes())
            .await;
        let _ = stream.shutdown().await;
        return Ok(code);
    }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Turns a Google error body into the sentence the UI shows. Their errors are either OAuth's
/// `{error, error_description}` or Drive's `{error: {message}}`, and both are more useful than a
/// bare status code.
fn describe(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return message.to_string();
        }
        if let Some(code) = value.get("error").and_then(|e| e.as_str()) {
            let detail = value.get("error_description").and_then(|d| d.as_str());
            return match detail {
                Some(detail) => format!("{code} — {detail}"),
                None => code.to_string(),
            };
        }
    }
    let excerpt: String = body.chars().take(300).collect();
    format!("{status}: {excerpt}")
}

async fn post_form(url: &str, form: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let response = client()?
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(describe(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// Exchanges the stored refresh token for a short-lived access token. Every Drive call goes
/// through here rather than caching the access token: it is valid for an hour, the refresh costs
/// one request, and a cache would be one more piece of state to get wrong across app restarts.
async fn access_token(client_id: &str) -> Result<String, String> {
    let client_secret = secrets::get_secret(&secrets::gdrive_client_secret_key())?
        .ok_or("no Google client secret is configured")?;
    let refresh_token = secrets::get_secret(&secrets::gdrive_refresh_token_key())?
        .ok_or("Google Drive is not connected")?;

    let payload = post_form(
        TOKEN_ENDPOINT,
        &[
            ("client_id", client_id),
            ("client_secret", &client_secret),
            ("refresh_token", &refresh_token),
            ("grant_type", "refresh_token"),
        ],
    )
    .await?;

    payload
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
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

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not open a loopback port for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let (verifier, challenge) = pkce_pair();
    let state = uuid::Uuid::new_v4().to_string();

    // `access_type=offline` with `prompt=consent` is what makes Google return a refresh token:
    // without the prompt it only issues one on the *first* ever authorization, so a user who
    // reconnects after disconnecting would get an account that silently can't refresh.
    let url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencode(&client_id),
        urlencode(&redirect_uri),
        urlencode(SCOPES),
        urlencode(&challenge),
        urlencode(&state),
    );

    open::that(&url).map_err(|e| format!("could not open the browser: {e}"))?;

    let code = tokio::time::timeout(CONSENT_TIMEOUT, await_code(listener, &state))
        .await
        .map_err(|_| "timed out waiting for the Google sign-in to finish".to_string())??;

    let payload = post_form(
        TOKEN_ENDPOINT,
        &[
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("code", &code),
            ("code_verifier", &verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &redirect_uri),
        ],
    )
    .await?;

    let refresh_token = payload
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or("Google did not return a refresh token — remove the app's access under your Google account's third-party connections and connect again")?;
    secrets::set_secret(&secrets::gdrive_refresh_token_key(), refresh_token)?;

    let access = payload
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(DriveAccount {
        email: fetch_email(&access).await.unwrap_or_default(),
    })
}

async fn fetch_email(access_token: &str) -> Result<String, String> {
    let response = client()?
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("email").and_then(|e| e.as_str()).map(|s| s.to_string()))
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
    let response = client()?
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
        return Err(describe(status, &body));
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
pub async fn upload(
    client_id: String,
    file_id: Option<String>,
    name: String,
    contents: String,
) -> Result<String, String> {
    let token = access_token(&client_id).await?;
    let http = client()?;

    // Two different uploads, because they need different things. Creating has to carry the name —
    // that is how the *other* machine finds this file — so it goes as `multipart`: one part of
    // metadata, one of content. Updating changes nothing but the bytes, so it goes as `media`,
    // which is the same request without the envelope.
    let request = match &file_id {
        Some(id) => http
            .patch(format!("{UPLOAD_ENDPOINT}/{id}?uploadType=media&fields=id"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(contents),
        None => {
            let boundary = format!("codeflow-{}", uuid::Uuid::new_v4());
            let metadata = serde_json::json!({ "name": name }).to_string();
            let body = format!(
                "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
                 --{boundary}\r\nContent-Type: application/json\r\n\r\n{contents}\r\n--{boundary}--"
            );
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
        return Err(describe(status, &text));
    }
    let payload: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    payload
        .get("id")
        .and_then(|id| id.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Drive's response had no file id".to_string())
}

pub async fn download(client_id: String, file_id: String) -> Result<String, String> {
    let token = access_token(&client_id).await?;
    let response = client()?
        .get(format!("{FILES_ENDPOINT}/{file_id}"))
        .bearer_auth(&token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(describe(status, &body));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_sha256_of_the_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert_eq!(challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
        // RFC 7636 §4.1: 43–128 characters, and base64url of 32 bytes lands on 43.
        assert_eq!(verifier.len(), 43);
        assert!(!verifier.contains('='), "the verifier must be unpadded base64url");
    }

    #[test]
    fn two_flows_never_share_a_verifier() {
        assert_ne!(pkce_pair().0, pkce_pair().0);
    }

    #[test]
    fn the_callback_target_is_parsed_the_way_google_sends_it() {
        let target = "/?state=abc-123&code=4%2F0AX4Xf&scope=https%3A%2F%2Fwww.googleapis.com";
        assert_eq!(query_param(target, "code").as_deref(), Some("4/0AX4Xf"));
        assert_eq!(query_param(target, "state").as_deref(), Some("abc-123"));
        assert_eq!(
            query_param(target, "scope").as_deref(),
            Some("https://www.googleapis.com")
        );
        assert_eq!(query_param(target, "error"), None);
        // A bare favicon request must not read as a callback.
        assert_eq!(query_param("/favicon.ico", "code"), None);
    }

    #[test]
    fn a_denied_consent_is_recognised() {
        assert_eq!(
            query_param("/?error=access_denied&state=x", "error").as_deref(),
            Some("access_denied")
        );
    }

    #[test]
    fn redirect_uris_and_scopes_survive_encoding() {
        assert_eq!(urlencode("http://127.0.0.1:5173"), "http%3A%2F%2F127.0.0.1%3A5173");
        assert_eq!(
            urlencode("https://www.googleapis.com/auth/drive.file email"),
            "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20email"
        );
        // Unreserved characters (RFC 3986 §2.3) must pass through untouched.
        assert_eq!(urlencode("aZ0-_.~"), "aZ0-_.~");
    }

    #[test]
    fn google_errors_become_sentences() {
        assert_eq!(
            describe(
                reqwest::StatusCode::BAD_REQUEST,
                r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#
            ),
            "invalid_grant — Token has been expired or revoked."
        );
        assert_eq!(
            describe(
                reqwest::StatusCode::NOT_FOUND,
                r#"{"error":{"code":404,"message":"File not found: abc."}}"#
            ),
            "File not found: abc."
        );
    }
}
