//! HTTP Request — one request per input item, through the API client's transport (`api::http`), so
//! TLS, redirects, proxies and decoding behave the way they do in the API tab.
//!
//! Credentials are referenced, never typed in: the node names a `flow_credentials` row, and the
//! secret comes out of the keychain at the moment the request is built. It is never logged — the
//! log line is the method, the URL without its query string, the status and the time.

use std::collections::BTreeMap;

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::{flag, number, pairs, text, NodeCtx, NodeError};
use crate::api::{HttpSendRequest, NetworkOptions};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

/// A response a flow keeps in memory at most. Larger than the API tab's default, because a flow is
/// often a bulk download; past it the body is cut and the item says so.
const MAX_RESPONSE: u64 = 64 * 1024 * 1024;

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let items = ctx.items();
    let count = items.len().max(1);
    let mut out = Vec::new();
    for index in 0..count {
        let params = &resolved[index.min(resolved.len() - 1)];
        let produced = request(ctx, params).await?;
        out.extend(produced.into_iter().map(|json| if items.is_empty() { Item::new(json) } else { Item::paired(json, index) }));
    }
    Ok(vec![out])
}

pub(super) fn build_url(raw: &str, query: &[(String, String)]) -> Result<url::Url, NodeError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(NodeError::failed("The URL is empty"));
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let mut url = url::Url::parse(&with_scheme).map_err(|e| NodeError::failed(format!("{trimmed} is not a URL: {e}")))?;
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
    }
    Ok(url)
}

/// What the log shows of a URL: no query string, no user info — the two places a secret travels.
pub(super) fn loggable(url: &url::Url) -> String {
    let mut shown = url.clone();
    shown.set_query(None);
    let _ = shown.set_username("");
    let _ = shown.set_password(None);
    shown.to_string()
}

/// Signs a request with a flow credential — a header or a query parameter, never the URL's user
/// info. Shared by every node that speaks HTTP (and WebSocket, whose upgrade is one).
pub(super) fn apply_credential(
    ctx: &NodeCtx,
    credential_id: &str,
    headers: &mut Vec<(String, String)>,
    query: &mut Vec<(String, String)>,
) -> Result<(), NodeError> {
    if credential_id.trim().is_empty() {
        return Ok(());
    }
    let credential = ctx.run.host.credential(credential_id.trim()).map_err(NodeError::failed)?;
    let meta_text = |key: &str| credential.meta.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    match credential.kind.as_str() {
        "bearer" => headers.push(("Authorization".into(), format!("Bearer {}", credential.secret))),
        "basic" => {
            let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", meta_text("user"), credential.secret));
            // The encoded pair is as much the password as the password: a server that echoes the
            // request must not put it in the run's stored data either.
            ctx.run.host.secret_used(&token);
            headers.push(("Authorization".into(), format!("Basic {token}")));
        }
        "header" => headers.push((meta_text("name"), credential.secret.clone())),
        "query" => query.push((meta_text("name"), credential.secret.clone())),
        other => return Err(NodeError::failed(format!("A {other} credential cannot sign an HTTP request"))),
    }
    Ok(())
}

async fn request(ctx: &NodeCtx, params: &Value) -> Result<Vec<Value>, NodeError> {
    let method = text(params, "method").to_uppercase();
    let method = if method.is_empty() { "GET".to_string() } else { method };
    let mut query = pairs(params, "query");
    let mut headers = pairs(params, "headers");

    apply_credential(ctx, &text(params, "credential"), &mut headers, &mut query)?;

    let url = build_url(&text(params, "url"), &query)?;
    let has = |name: &str| headers.iter().any(|(key, _)| key.eq_ignore_ascii_case(name));
    let mut body_text = None;
    let mut urlencoded = None;
    match text(params, "body").as_str() {
        "json" => {
            let body = match params.get("bodyJson") {
                Some(Value::String(raw)) => {
                    let raw = raw.trim();
                    if raw.is_empty() {
                        String::new()
                    } else {
                        let parsed: Value =
                            serde_json::from_str(raw).map_err(|e| NodeError::failed(format!("The JSON body is not valid JSON: {e}")))?;
                        parsed.to_string()
                    }
                }
                Some(other) => other.to_string(),
                None => String::new(),
            };
            if !has("content-type") {
                headers.push(("Content-Type".into(), "application/json".into()));
            }
            body_text = Some(body);
        }
        "form" => urlencoded = Some(pairs(params, "bodyForm")),
        "text" => {
            if !has("content-type") {
                let kind = text(params, "contentType");
                headers.push(("Content-Type".into(), if kind.trim().is_empty() { "text/plain".into() } else { kind }));
            }
            body_text = Some(text(params, "bodyText"));
        }
        _ => {}
    }

    let options = NetworkOptions {
        timeout_ms: number(params, "timeoutMs").map(|n| n.max(0.0) as u64).filter(|n| *n > 0).unwrap_or(30_000),
        follow_redirects: params.get("followRedirects").is_none() || flag(params, "followRedirects"),
        verify_ssl: params.get("verifySsl").is_none() || flag(params, "verifySsl"),
        max_response_bytes: MAX_RESPONSE,
        ..NetworkOptions::default()
    };
    let shown = loggable(&url);
    let request = HttpSendRequest {
        method: method.clone(),
        url: url.to_string(),
        headers,
        body_text,
        body_base64: None,
        body_file: None,
        form_data: None,
        urlencoded,
        auth: None,
        options,
    };
    let response = tokio::select! {
        response = crate::api::http::send(request, None, None) => response.map_err(NodeError::failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    ctx.log(LogStream::Info, &format!("{method} {shown} → {} ({} ms)", response.status, response.duration_ms));

    let content_type = response
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.to_ascii_lowercase())
        .unwrap_or_default();
    let body: Value = if let Some(encoded) = &response.body_base64 {
        json!({"data": encoded, "binary": true, "mimeType": content_type, "size": response.size_bytes})
    } else {
        let wants = text(params, "response");
        let looks_json = content_type.contains("json")
            || matches!(response.body_text.trim_start().chars().next(), Some('{') | Some('['));
        match wants.as_str() {
            "text" => Value::String(response.body_text.clone()),
            "json" => serde_json::from_str(&response.body_text)
                .map_err(|e| NodeError::failed(format!("The response is not JSON: {e}")))?,
            _ if looks_json => serde_json::from_str(&response.body_text).unwrap_or_else(|_| Value::String(response.body_text.clone())),
            _ => Value::String(response.body_text.clone()),
        }
    };

    if response.status >= 400 && !flag(params, "neverError") {
        let detail = match &body {
            Value::String(text) => text.chars().take(400).collect::<String>(),
            other => other.to_string().chars().take(400).collect(),
        };
        return Err(NodeError::failed(format!(
            "{method} {shown} answered {} {}{}",
            response.status,
            response.status_text,
            if detail.trim().is_empty() { String::new() } else { format!(": {detail}") }
        )));
    }
    if response.truncated {
        ctx.log(LogStream::Info, "The response was larger than 64 MB and was cut");
    }

    if flag(params, "fullResponse") {
        let mut header_map: BTreeMap<String, Value> = BTreeMap::new();
        for (name, value) in &response.headers {
            let key = name.to_ascii_lowercase();
            match header_map.get_mut(&key) {
                Some(Value::String(existing)) => {
                    let joined = format!("{existing}, {value}");
                    *existing = joined;
                }
                _ => {
                    header_map.insert(key, Value::String(value.clone()));
                }
            }
        }
        return Ok(vec![json!({
            "statusCode": response.status,
            "statusMessage": response.status_text,
            "headers": header_map,
            "body": body,
            "truncated": response.truncated,
        })]);
    }
    let split = params.get("splitArrays").is_none() || flag(params, "splitArrays");
    Ok(match body {
        Value::Array(list) if split => list
            .into_iter()
            .map(|entry| if entry.is_object() { entry } else { json!({"value": entry}) })
            .collect(),
        Value::Object(map) => vec![Value::Object(map)],
        Value::String(text) => vec![Value::Object(Map::from_iter([("data".to_string(), Value::String(text))]))],
        other => vec![json!({"data": other})],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_gain_a_scheme_and_their_query() {
        let url = build_url("example.com/api", &[("q".into(), "a b".into())]).unwrap();
        assert_eq!(url.as_str(), "https://example.com/api?q=a+b");
        assert!(build_url("  ", &[]).is_err());
    }

    #[test]
    fn the_log_never_shows_the_query_or_a_password() {
        let url = url::Url::parse("https://user:secret@example.com/v1/items?token=abc").unwrap();
        assert_eq!(loggable(&url), "https://example.com/v1/items");
    }
}
