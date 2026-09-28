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
                // Read as bytes, not by slicing the `&str`: `%` followed by a multi-byte character
                // would put the slice mid-character and panic — on input any local page can send.
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|pair| u8::from_str_radix(pair, 16).ok());
                match hex {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    None => {
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

// ---------------------------------------------------------------------------
// The API client's redirect grants
// ---------------------------------------------------------------------------
//
// Same RFC 8252 idea as `consent` above, with one difference that decides the whole shape: the
// redirect URI is not ours to choose. Drive and OneDrive accept any loopback port, so `consent` binds
// an ephemeral one; an arbitrary OAuth provider only redirects to the URI registered with it, so
// this binds **exactly** the registered port and serves **exactly** its path — anything else would
// be a redirect the provider refuses to make.
//
// Only the capture lives here. The frontend builds the authorization URL (it holds the form and the
// PKCE verifier) and redeems the code through the ordinary HTTP transport, so this stays a
// transport too: it hands back the parameters the provider sent, after checking `state`.

/// The redirect a provider has on file, reduced to what the listener binds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackRedirect {
    pub port: u16,
    /// Always starts with `/`.
    pub path: String,
    /// `localhost` is both loopbacks: some browsers try `::1` first and do not fall back quickly.
    pub addrs: Vec<std::net::IpAddr>,
}

/// Parses a registered redirect URI, refusing anything that is not plain `http` on the loopback
/// interface — the only kind a desktop app can receive without a server of its own on the internet.
pub fn loopback_redirect(uri: &str) -> Result<LoopbackRedirect, String> {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    let parsed = url::Url::parse(uri.trim()).map_err(|e| format!("'{uri}' is not a valid redirect URI: {e}"))?;
    let not_loopback = || {
        format!(
            "'{uri}' is not a loopback redirect. Register one like http://localhost:8976/callback with \
             the provider — CodeFlow listens on that exact port and path while you sign in."
        )
    };
    if parsed.scheme() != "http" {
        return Err(not_loopback());
    }
    let addrs: Vec<IpAddr> = match parsed.host() {
        Some(url::Host::Domain(name)) if name.eq_ignore_ascii_case("localhost") => {
            vec![IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)]
        }
        Some(url::Host::Ipv4(ip)) if ip.is_loopback() => vec![IpAddr::V4(ip)],
        Some(url::Host::Ipv6(ip)) if ip.is_loopback() => vec![IpAddr::V6(ip)],
        _ => return Err(not_loopback()),
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let path = if parsed.path().is_empty() { "/".to_string() } else { parsed.path().to_string() };
    Ok(LoopbackRedirect { port, path, addrs })
}

/// What the provider puts on the redirect: a code in the query, or — for the implicit grant — a
/// token in the fragment, which a browser never sends to a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedirectMode {
    Code,
    Token,
}

/// Bytes read of one callback request before it is refused; a real redirect is a few hundred.
const CALLBACK_REQUEST_LIMIT: usize = 64 * 1024;

/// Binds the registered port, calls `ready` (which opens the browser), and serves until the
/// provider's redirect arrives. Returns every parameter it carried, `state` already checked.
///
/// Binding happens *before* `ready`: a browser that comes back faster than a late bind would find
/// nothing listening. At least one address must bind; for `localhost` the IPv6 half is best-effort.
pub async fn capture_redirect(
    redirect: &LoopbackRedirect,
    expected_state: &str,
    mode: RedirectMode,
    ready: impl FnOnce() -> Result<(), String>,
) -> Result<Vec<(String, String)>, String> {
    let mut listeners = Vec::new();
    let mut first_error = None;
    for addr in &redirect.addrs {
        match TcpListener::bind((*addr, redirect.port)).await {
            Ok(listener) => listeners.push(listener),
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    if listeners.is_empty() {
        let reason = first_error.map(|e| e.to_string()).unwrap_or_default();
        return Err(format!(
            "could not listen on port {} for the sign-in redirect: {reason}. Is another app using it?",
            redirect.port
        ));
    }

    ready()?;

    tokio::time::timeout(CONSENT_TIMEOUT, serve_redirect(&listeners, redirect, expected_state, mode))
        .await
        .map_err(|_| "timed out waiting for the sign-in to finish in the browser".to_string())?
}

async fn accept_any(listeners: &[TcpListener]) -> std::io::Result<tokio::net::TcpStream> {
    let accepts = listeners.iter().map(|listener| Box::pin(listener.accept()));
    let (result, _, _) = futures_util::future::select_all(accepts).await;
    result.map(|(stream, _)| stream)
}

async fn serve_redirect(
    listeners: &[TcpListener],
    redirect: &LoopbackRedirect,
    expected_state: &str,
    mode: RedirectMode,
) -> Result<Vec<(String, String)>, String> {
    loop {
        let mut stream = accept_any(listeners).await.map_err(|e| e.to_string())?;
        let Some(request) = read_callback_request(&mut stream).await else {
            continue;
        };
        let (path, query) = match request.target.split_once('?') {
            Some((path, query)) => (path.to_string(), query.to_string()),
            None => (request.target.clone(), String::new()),
        };
        if path != redirect.path {
            // `/favicon.ico` right after the redirect renders, a speculative preconnect: not ours.
            let _ = stream.write_all(&plain(404, "Not found")).await;
            continue;
        }

        let params = match (request.method.as_str(), mode) {
            ("POST", RedirectMode::Token) => form_pairs(&String::from_utf8_lossy(&request.body)),
            ("GET", _) => form_pairs(&query),
            _ => {
                let _ = stream.write_all(&plain(405, "Method not allowed")).await;
                continue;
            }
        };
        let get = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let answered = get("error").is_some()
            || match mode {
                RedirectMode::Code => get("code").is_some(),
                RedirectMode::Token => get("access_token").is_some(),
            };

        if !answered {
            // The implicit grant's token is in the fragment; this page is what carries it back.
            let body = if mode == RedirectMode::Token && request.method == "GET" {
                relay_page()
            } else {
                consent_page("Waiting for the sign-in…")
            };
            let _ = stream.write_all(body.as_bytes()).await;
            continue;
        }

        // Checked before anything is believed — an error included — because the state is what
        // proves the response belongs to the request this app made.
        if get("state").as_deref() != Some(expected_state) {
            let _ = stream
                .write_all(consent_page("This response did not match the request.").as_bytes())
                .await;
            return Err("the redirect's state did not match — the sign-in was interfered with".into());
        }

        if let Some(error) = get("error") {
            let _ = stream.write_all(consent_page("Authorization was declined.").as_bytes()).await;
            let detail = get("error_description").map(|d| format!(" — {d}")).unwrap_or_default();
            return Err(format!("the provider returned: {error}{detail}"));
        }

        let reply = if request.method == "POST" {
            plain(200, "ok")
        } else {
            consent_page("CodeFlow received the authorization.").into_bytes()
        };
        let _ = stream.write_all(&reply).await;
        let _ = stream.shutdown().await;
        return Ok(params);
    }
}

struct CallbackRequest {
    method: String,
    target: String,
    body: Vec<u8>,
}

/// Reads one request: the head, and for a POST the body its `Content-Length` announces. `None` for
/// anything malformed or oversized, which is answered by closing the connection.
async fn read_callback_request(stream: &mut tokio::net::TcpStream) -> Option<CallbackRequest> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if buf.len() > CALLBACK_REQUEST_LIMIT {
            return None;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_ascii_uppercase();
    let target = request_line.next()?.to_string();
    let length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if length > CALLBACK_REQUEST_LIMIT {
        return None;
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Some(CallbackRequest { method, target, body })
}

/// `a=1&b=two%20words` → pairs, percent- and `+`-decoded. Keys without `=` keep an empty value.
fn form_pairs(text: &str) -> Vec<(String, String)> {
    text.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (percent_decode(key), percent_decode(value)),
            None => (percent_decode(pair), String::new()),
        })
        .collect()
}

fn plain(status: u16, text: &str) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )
    .into_bytes()
}

/// The script that carries an implicit grant's fragment back to the listener. It POSTs rather than
/// re-navigating with a query string, so the token never becomes a URL of its own, and it scrubs the
/// fragment from the address bar and the history entry first.
const RELAY_SCRIPT: &str = "(function(){var h=location.hash.slice(1),m=document.getElementById('m');\
if(!h){m.textContent='No authorization data arrived.';return;}\
history.replaceState(null,'',location.pathname);\
fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:h})\
.then(function(r){m.textContent=r.ok?'CodeFlow received the authorization.':'CodeFlow could not use this response.';})\
.catch(function(){m.textContent='CodeFlow is no longer waiting for this sign-in.';});})();";

fn relay_page() -> String {
    use base64::engine::general_purpose::STANDARD;
    // The page's only script, pinned by hash: nothing else can run on the listener's origin.
    let script_hash = STANDARD.encode(Sha256::digest(RELAY_SCRIPT.as_bytes()));
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>CodeFlow</title>\
         <body style=\"font:14px system-ui;padding:3rem;text-align:center\">\
         <p id=\"m\">Finishing the sign-in…</p><p style=\"color:#888\">You can close this tab.</p>\
         <script>{RELAY_SCRIPT}</script></body>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Content-Security-Policy: default-src 'none'; script-src 'sha256-{script_hash}'; connect-src 'self'; style-src 'unsafe-inline'\r\n\
         Referrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
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
    fn a_percent_before_a_multibyte_character_does_not_panic() {
        assert_eq!(percent_decode("%aé"), "%aé");
        assert_eq!(query_param("/?code=%zz%41", "code").as_deref(), Some("%zzA"));
    }

    #[test]
    fn only_a_plain_http_loopback_redirect_is_accepted() {
        let redirect = loopback_redirect("http://localhost:8976/callback").unwrap();
        assert_eq!(redirect.port, 8976);
        assert_eq!(redirect.path, "/callback");
        assert_eq!(redirect.addrs.len(), 2, "localhost listens on both loopbacks");

        let bare = loopback_redirect("http://127.0.0.1:5000").unwrap();
        assert_eq!((bare.port, bare.path.as_str()), (5000, "/"));
        assert_eq!(loopback_redirect("http://[::1]:7000/cb").unwrap().addrs.len(), 1);
        // No port written means the scheme's default, which is what the provider will redirect to.
        assert_eq!(loopback_redirect("http://localhost/cb").unwrap().port, 80);

        for rejected in [
            "https://localhost:8976/callback",
            "http://app.example.test/callback",
            "http://10.0.0.5:8976/callback",
            "com.example.app:/oauth2redirect",
            "not a url",
        ] {
            assert!(loopback_redirect(rejected).is_err(), "{rejected} must be refused");
        }
    }

    /// A free port, released for `capture_redirect` to bind. Racy in principle; fine for a test.
    async fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port()
    }

    async fn exchange(port: u16, raw: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    fn redirect_on(port: u16) -> LoopbackRedirect {
        LoopbackRedirect {
            port,
            path: "/cb".into(),
            addrs: vec![std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)],
        }
    }

    #[tokio::test]
    async fn the_code_is_captured_on_the_registered_path_only() {
        let port = free_port().await;
        let redirect = redirect_on(port);
        let (opened_tx, opened_rx) = tokio::sync::oneshot::channel();
        let flow = tokio::spawn(async move {
            capture_redirect(&redirect, "s-123", RedirectMode::Code, move || {
                let _ = opened_tx.send(());
                Ok(())
            })
            .await
        });
        opened_rx.await.unwrap();

        let stray = exchange(port, "GET /favicon.ico HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
        assert!(stray.starts_with("HTTP/1.1 404"), "{stray}");
        let done = exchange(port, "GET /cb?code=4%2F0Ab&state=s-123 HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
        assert!(done.starts_with("HTTP/1.1 200"), "{done}");

        let params = flow.await.unwrap().unwrap();
        assert!(params.contains(&("code".to_string(), "4/0Ab".to_string())));
    }

    #[tokio::test]
    async fn a_mismatched_state_ends_the_flow_without_a_code() {
        let port = free_port().await;
        let redirect = redirect_on(port);
        let flow = tokio::spawn(async move {
            capture_redirect(&redirect, "expected", RedirectMode::Code, || Ok(())).await
        });
        tokio::task::yield_now().await;
        // Retry until the listener is up: the spawned task binds asynchronously.
        let mut response = String::new();
        for _ in 0..50 {
            if let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                stream
                    .write_all(b"GET /cb?code=injected&state=forged HTTP/1.1\r\n\r\n")
                    .await
                    .unwrap();
                stream.read_to_string(&mut response).await.unwrap();
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(response.contains("did not match"), "{response}");
        let error = flow.await.unwrap().unwrap_err();
        assert!(error.contains("state"), "{error}");
    }

    #[tokio::test]
    async fn the_implicit_grant_relays_the_fragment_by_post() {
        let port = free_port().await;
        let redirect = redirect_on(port);
        let (opened_tx, opened_rx) = tokio::sync::oneshot::channel();
        let flow = tokio::spawn(async move {
            capture_redirect(&redirect, "s-9", RedirectMode::Token, move || {
                let _ = opened_tx.send(());
                Ok(())
            })
            .await
        });
        opened_rx.await.unwrap();

        // First hit: the fragment stayed in the browser, so the page that carries it back is served,
        // with its one script pinned by hash.
        let page = exchange(port, "GET /cb HTTP/1.1\r\n\r\n").await;
        assert!(page.contains("history.replaceState"), "{page}");
        let expected = {
            use base64::engine::general_purpose::STANDARD;
            STANDARD.encode(Sha256::digest(RELAY_SCRIPT.as_bytes()))
        };
        assert!(page.contains(&format!("script-src 'sha256-{expected}'")), "{page}");

        let body = "access_token=tok%2Ben&token_type=Bearer&expires_in=3600&state=s-9";
        let posted = exchange(
            port,
            &format!(
                "POST /cb HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        assert!(posted.starts_with("HTTP/1.1 200"), "{posted}");

        let params = flow.await.unwrap().unwrap();
        assert!(params.contains(&("access_token".to_string(), "tok+en".to_string())));
        assert!(params.contains(&("expires_in".to_string(), "3600".to_string())));
    }

    #[tokio::test]
    async fn a_declined_consent_with_the_right_state_is_an_error() {
        let port = free_port().await;
        let redirect = redirect_on(port);
        let (opened_tx, opened_rx) = tokio::sync::oneshot::channel();
        let flow = tokio::spawn(async move {
            capture_redirect(&redirect, "s", RedirectMode::Code, move || {
                let _ = opened_tx.send(());
                Ok(())
            })
            .await
        });
        opened_rx.await.unwrap();
        exchange(port, "GET /cb?error=access_denied&error_description=No+thanks&state=s HTTP/1.1\r\n\r\n").await;
        assert_eq!(
            flow.await.unwrap().unwrap_err(),
            "the provider returned: access_denied — No thanks"
        );
    }

    #[tokio::test]
    async fn a_port_already_in_use_is_reported_before_the_browser_opens() {
        let busy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect = redirect_on(busy.local_addr().unwrap().port());
        let mut opened = false;
        let error = capture_redirect(&redirect, "s", RedirectMode::Code, || {
            opened = true;
            Ok(())
        })
        .await
        .unwrap_err();
        assert!(!opened, "the browser must not be sent to a redirect nobody can receive");
        assert!(error.contains("could not listen"), "{error}");
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
