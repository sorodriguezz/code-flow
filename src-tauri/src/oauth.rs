//! The loopback authorization flow both cloud destinations share.
//!
//! Google Drive and OneDrive are different APIs with the same front door: the flow RFC 8252
//! specifies for native applications — bind an ephemeral port on the loopback interface, open the
//! system browser, and serve exactly one request, the redirect carrying the authorization code.
//! PKCE (RFC 7636) is what makes that safe without a client secret: the verifier proves, at the
//! token call, that the code is being redeemed by whoever started the flow.
//!
//! This module is the half that is genuinely identical. What stays with each provider is what
//! actually differs — the endpoints, the scopes, whether a client secret is involved, and how the
//! refresh token behaves afterwards.
//!
//! Two things are parameterised because the providers disagree about them:
//!
//! - **The loopback host.** Google registers `127.0.0.1`; Microsoft's portal refuses to accept an
//!   `http://127.0.0.1` redirect URI through its UI at all, and documents `http://localhost`
//!   instead. Both are the same interface — only the spelling in the registration differs.
//! - **The service's name**, which is all the browser tab the user is left looking at ever says.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// How long the loopback listener waits for the browser round trip before giving up. Long enough
/// to sign in and pick an account, short enough that an abandoned attempt doesn't hold a port and
/// a task for the rest of the session.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/// A verifier and its S256 challenge. The verifier is what proves, at the token call, that the
/// code was redeemed by whoever started the flow — without it, anything able to observe the
/// loopback redirect could exchange the code itself.
pub fn pkce_pair() -> (String, String) {
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

pub fn urlencode(value: &str) -> String {
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

/// What the browser lands on once the provider redirects back. Plain text in the page, because the
/// user is looking at a tab they now have to close — anything more elaborate would still be a dead
/// end.
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
pub fn query_param(target: &str, key: &str) -> Option<String> {
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
async fn await_code(
    listener: TcpListener,
    service: &str,
    expected_state: &str,
) -> Result<String, String> {
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
            // The provider's own `error_description` is the useful half, and it is optional.
            let detail = query_param(&target, "error_description")
                .map(|d| format!(" — {d}"))
                .unwrap_or_default();
            return Err(format!("{service} returned: {error}{detail}"));
        }

        let Some(code) = query_param(&target, "code") else {
            // Not the redirect — answer and keep waiting.
            let _ = stream
                .write_all(consent_page(&format!("Waiting for {service}…")).as_bytes())
                .await;
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
            .write_all(consent_page(&format!("CodeFlow is connected to {service}.")).as_bytes())
            .await;
        let _ = stream.shutdown().await;
        return Ok(code);
    }
}

/// An authorization code, with the two values the token call has to send back unchanged.
pub struct Grant {
    pub code: String,
    /// Must be byte-identical to the one the authorization request carried, or the exchange fails.
    pub redirect_uri: String,
    pub verifier: String,
}

/// Runs the consent flow end to end and returns the code the token call needs.
///
/// `build_url` receives the redirect URI, the PKCE challenge and the state, and returns the
/// provider's authorization URL — the one part of this that is genuinely per-provider.
pub async fn consent<F>(service: &str, loopback_host: &str, build_url: F) -> Result<Grant, String>
where
    F: FnOnce(&str, &str, &str) -> String,
{
    // Bound to the IPv4 loopback whatever the redirect is spelled as: Microsoft does not support
    // the IPv6 loopback (`[::1]`) for redirect URIs at all, and browsers resolving `localhost`
    // fall back to 127.0.0.1 on their own.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not open a loopback port for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://{loopback_host}:{port}");

    let (verifier, challenge) = pkce_pair();
    let state = uuid::Uuid::new_v4().to_string();
    let url = build_url(&redirect_uri, &challenge, &state);

    open::that(&url).map_err(|e| format!("could not open the browser: {e}"))?;

    let code = tokio::time::timeout(CONSENT_TIMEOUT, await_code(listener, service, &state))
        .await
        .map_err(|_| format!("timed out waiting for the {service} sign-in to finish"))??;

    Ok(Grant { code, redirect_uri, verifier })
}

// ---------------------------------------------------------------------------
// Talking to the provider
// ---------------------------------------------------------------------------

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Turns a provider's error body into the sentence the UI shows.
///
/// Google and Microsoft happen to agree on both shapes that matter: OAuth's
/// `{error, error_description}` from the token endpoint, and `{error: {message}}` from the storage
/// API. Either is more useful than a bare status code.
pub fn describe(status: reqwest::StatusCode, body: &str) -> String {
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

pub async fn post_form(url: &str, form: &[(&str, &str)]) -> Result<serde_json::Value, String> {
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

/// One string field out of a token response. Absent and present-but-not-a-string are the same
/// thing to every caller here, and both mean "the provider did not send it".
pub fn field(payload: &serde_json::Value, name: &str) -> Option<String> {
    payload.get(name).and_then(|v| v.as_str()).map(str::to_string)
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

    /// Microsoft's redirect URIs without a path segment come back with a trailing slash, and its
    /// codes are long and full of characters that have to survive percent-decoding.
    #[test]
    fn the_callback_target_is_parsed_the_way_microsoft_sends_it() {
        let target = "/?code=M.C107_BAY.2.U.abc-def_gh%2Ei&state=9f8e&session_state=1a2b";
        assert_eq!(query_param(target, "code").as_deref(), Some("M.C107_BAY.2.U.abc-def_gh.i"));
        assert_eq!(query_param(target, "state").as_deref(), Some("9f8e"));
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
    fn provider_errors_become_sentences() {
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
        // Graph nests its code and message the same way Drive does.
        assert_eq!(
            describe(
                reqwest::StatusCode::NOT_FOUND,
                r#"{"error":{"code":"itemNotFound","message":"The resource could not be found."}}"#
            ),
            "The resource could not be found."
        );
    }
}
