//! The "Conector" node: one call to a service described in `flows::connectors`.
//!
//! Building the request ([`request_for`]) and reading the answer ([`answer_items`]) are plain
//! functions of the definition, so every shipped connector is tested without its service.

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::http::loggable;
use super::{number, text, NodeCtx, NodeError};
use crate::api::{HttpSendRequest, NetworkOptions};
use crate::flows::connectors::{self, Connector, Operation};
use crate::flows::engine::{Credential, LogStream};
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let once = ctx.param_str("runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let paired = !ctx.items().is_empty();
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        for json in call(ctx, params).await? {
            out.push(if paired { Item::paired(json, index) } else { Item::new(json) });
        }
    }
    Ok(vec![out])
}

fn chosen(call: &Value) -> Result<(&'static Connector, &'static Operation), NodeError> {
    let connector_id = call.get("connector").and_then(Value::as_str).unwrap_or_default();
    let connector = connectors::find(connector_id).ok_or_else(|| NodeError::failed("Pick the service"))?;
    let operation_id = call.get("operation").and_then(Value::as_str).unwrap_or_default();
    let operation = connector.operation(operation_id).ok_or_else(|| NodeError::failed("Pick what to do"))?;
    Ok((connector, operation))
}

fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        _ => false,
    }
}

async fn call(ctx: &NodeCtx, params: &Value) -> Result<Vec<Value>, NodeError> {
    let call = params.get("call").cloned().unwrap_or(Value::Null);
    let (connector, operation) = chosen(&call)?;
    let values: Map<String, Value> = call.get("fields").and_then(Value::as_object).cloned().unwrap_or_default();
    let id = text(params, "credential");
    let credential = if connector.auth == "none" || (connector.auth_optional && id.trim().is_empty()) {
        None
    } else {
        if id.trim().is_empty() {
            return Err(NodeError::failed(format!("Pick the credential for {}", connector.name)));
        }
        Some(ctx.credential(id.trim()).await?)
    };
    let timeout_ms = number(params, "timeoutMs").map(|n| n.max(0.0) as u64).filter(|n| *n > 0).unwrap_or(30_000);
    let (request, url) = request_for(connector, operation, values, credential.as_ref(), timeout_ms)?;
    if let Some(Credential { kind, .. }) = &credential {
        if kind == "basic" || connector.auth == "basic" {
            // The encoded pair is as much the password as the password.
            if let Some((_, value)) = request.headers.iter().find(|(name, _)| name == "Authorization") {
                ctx.run.host.secret_used(value.trim_start_matches("Basic "));
            }
        }
    }
    let response = tokio::select! {
        response = crate::api::http::send(request, None, None) => response.map_err(NodeError::failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    ctx.log(
        LogStream::Info,
        &format!("{} {} {} → {} ({} ms)", connector.name, operation.method, loggable(&url), response.status, response.duration_ms),
    );
    answer_items(connector, operation, response.status, &response.body_text)
}

/// The HTTP request a call makes. Required fields are checked here; the credential signs it the way
/// the connector says (a header, or — Telegram — the token as part of the URL).
pub(super) fn request_for(
    connector: &Connector,
    operation: &Operation,
    mut values: Map<String, Value>,
    credential: Option<&Credential>,
    timeout_ms: u64,
) -> Result<(HttpSendRequest, url::Url), NodeError> {
    for field in connector.fields_of(operation) {
        if !field.default.is_empty() && is_blank(values.get(&field.name).unwrap_or(&Value::Null)) {
            values.insert(field.name.clone(), Value::String(field.default.clone()));
        }
        if field.required && is_blank(values.get(&field.name).unwrap_or(&Value::Null)) {
            return Err(NodeError::failed(format!("Fill in “{}”", field.label.en)));
        }
    }
    if let Some(credential) = credential {
        let kinds = connector.credential_kinds();
        if !kinds.contains(&credential.kind.as_str()) {
            return Err(NodeError::failed(format!("{} signs in with a {} credential, not a {} one", connector.name, kinds.join("/"), credential.kind)));
        }
    }
    match (connector.auth.as_str(), credential) {
        ("none", _) => {}
        (_, None) if connector.auth_optional => {}
        (_, None) => return Err(NodeError::failed(format!("Pick the credential for {}", connector.name))),
        // Signed below, with the rest of the headers.
        ("bearer", Some(_)) => {}
        // The user is no secret (an email, Twilio's account SID): templates may place it.
        ("basic", Some(credential)) => {
            let user = credential.meta.get("user").and_then(Value::as_str).unwrap_or_default();
            values.insert("user".into(), Value::String(user.trim().to_string()));
        }
        ("path" | "url" | "headers", Some(credential)) => {
            values.insert("secret".into(), Value::String(credential.secret.trim().to_string()));
        }
        // `query`: placed by `authQuery`; `body`: placed by the body template (Pushover's token and
        // user key travel in the message itself).
        ("query" | "body", Some(credential)) => {
            let user = credential.meta.get("user").and_then(Value::as_str).unwrap_or_default();
            values.insert("user".into(), Value::String(user.trim().to_string()));
            values.insert("secret".into(), Value::String(credential.secret.trim().to_string()));
        }
        (other, _) => {
            return Err(NodeError::failed(format!("{} signs in with “{other}”, which this build does not know", connector.name)))
        }
    }

    // The connector's headers, then the operation's — `{{secret}}` and the fields placed in them.
    let mut headers: Vec<(String, String)> = Vec::new();
    match (connector.auth.as_str(), credential) {
        ("bearer", Some(credential)) => headers.push(("Authorization".into(), format!("Bearer {}", credential.secret))),
        ("basic", Some(credential)) => {
            let user = credential.meta.get("user").and_then(Value::as_str).unwrap_or_default();
            let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", credential.secret));
            headers.push(("Authorization".into(), format!("Basic {token}")));
        }
        _ => {}
    }
    for (name, value) in connector.headers.iter().chain(operation.headers.iter()) {
        headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
        headers.push((name.clone(), connectors::splice(value.as_str().unwrap_or_default(), &values)));
    }

    // A field marked `encode` is percent-encoded in the URL only — the body keeps it as written.
    let mut path_values = values.clone();
    for field in connector.fields_of(operation).into_iter().filter(|f| f.encode) {
        if let Some(Value::String(raw)) = values.get(&field.name) {
            // One segment: a space as `%20` (never the form's `+`), a `/` as `%2F`.
            path_values.insert(field.name.clone(), Value::String(crate::oauth::urlencode(raw.trim())));
        }
    }
    let text = if operation.url.is_empty() {
        // A server written with its trailing slash (`https://ntfy.example.com/`) still takes the path.
        let base = connectors::splice(&connector.base_url, &path_values);
        let path = connectors::splice(&operation.path, &path_values);
        let base = if path.starts_with('/') { base.trim_end_matches('/') } else { base.as_str() };
        format!("{base}{path}")
    } else {
        connectors::splice(&operation.url, &path_values)
    };
    // What the error shows of a URL that does not parse: never the query, never a secret in it.
    let shown = || if matches!(connector.auth.as_str(), "path" | "url") { connector.name.clone() } else { text.split('?').next().unwrap_or_default().to_string() };
    let mut url = url::Url::parse(text.trim()).map_err(|_| NodeError::failed(format!("{} is not a URL", shown())))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(NodeError::failed(format!("{} is not an http or https address", shown())));
    }
    let json_fields: Vec<&str> = connector.fields_of(operation).into_iter().filter(|f| f.json).map(|f| f.name.as_str()).collect();
    let mut query_template = operation.query.clone();
    if connector.auth == "query" {
        query_template.extend(connector.auth_query.clone());
    }
    if let Some(Value::Object(query)) = connectors::render(&Value::Object(query_template), &values, &json_fields).map_err(NodeError::Failed)? {
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (name, value) in query {
                let value = value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string());
                if name == "$raw" {
                    // A query written as text — PostgREST's `status=eq.active&order=id.desc`.
                    for (key, raw) in url::form_urlencoded::parse(value.trim_start_matches('?').as_bytes()) {
                        pairs.append_pair(&key, &raw);
                    }
                } else {
                    pairs.append_pair(&name, &value);
                }
            }
        }
    }
    let rendered = match &operation.body {
        Some(template) => connectors::render(template, &values, &json_fields).map_err(NodeError::Failed)?,
        None => None,
    };
    // A form body: the rendered object's fields as pairs, strings as they are, the rest as JSON text.
    let urlencoded = if operation.form {
        rendered.as_ref().and_then(Value::as_object).map(|fields| {
            fields
                .iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(name, value)| (name.clone(), value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())))
                .collect::<Vec<_>>()
        })
    } else {
        None
    };
    let body = if operation.form { None } else { rendered.map(|v| v.to_string()) };
    if body.is_some() && !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")) {
        headers.push(("Content-Type".into(), "application/json".into()));
    }
    if !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("accept")) {
        headers.push(("Accept".into(), "application/json".into()));
    }
    let request = HttpSendRequest {
        method: operation.method.clone(),
        url: url.to_string(),
        headers,
        body_text: body,
        body_base64: None,
        body_file: None,
        form_data: None,
        urlencoded,
        auth: None,
        options: NetworkOptions { timeout_ms, max_response_bytes: 64 * 1024 * 1024, ..NetworkOptions::default() },
    };
    Ok((request, url))
}

/// An answer as JSON: one document, or — ntfy's poll — one per line (NDJSON) read as a list.
fn parse_answer(body: &str) -> Value {
    if body.trim().is_empty() {
        return Value::Null;
    }
    if let Ok(value) = serde_json::from_str(body) {
        return value;
    }
    let lines: Option<Vec<Value>> = body.lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).ok()).collect();
    match lines {
        Some(list) if !list.is_empty() => Value::Array(list),
        _ => json!({"text": body}),
    }
}

/// What a call hands on: the answer's useful part (`result`), one item per entry of a list. A
/// failure is the service's own message — from `errorField`, or Slack's `ok: false`.
pub(super) fn answer_items(connector: &Connector, operation: &Operation, status: u16, body: &str) -> Result<Vec<Value>, NodeError> {
    let answer = parse_answer(body);
    let error_text = || {
        let found = (!connector.error_field.is_empty()).then(|| crate::flows::value::get_path(&answer, &connector.error_field)).flatten();
        // A message, wherever the service keeps it: a string, a list of them, or objects with one.
        let message = |value: &Value| match value {
            Value::String(text) => text.clone(),
            Value::Object(map) => map.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| value.to_string()),
            other => other.to_string(),
        };
        match found {
            Some(Value::Array(list)) => list.iter().map(message).collect::<Vec<_>>().join("; "),
            Some(other) => message(other),
            None => body.chars().take(300).collect(),
        }
    };
    if status >= 400 {
        return Err(NodeError::failed(format!("{} answered {status}: {}", connector.name, error_text())));
    }
    if !connector.ok_field.is_empty() && answer.get(&connector.ok_field) == Some(&Value::Bool(false)) {
        return Err(NodeError::failed(format!("{}: {}", connector.name, error_text())));
    }
    let failed = (!connector.fail_on.is_empty()).then(|| answer.get(&connector.fail_on)).flatten();
    if failed.is_some_and(|value| !value.is_null() && value.as_array().is_none_or(|list| !list.is_empty())) {
        return Err(NodeError::failed(format!("{}: {}", connector.name, error_text())));
    }
    let result = if operation.result.is_empty() { Some(&answer) } else { crate::flows::value::get_path(&answer, &operation.result) };
    Ok(match result {
        Some(Value::Array(list)) => list.iter().map(|v| if v.is_object() { v.clone() } else { json!({"value": v}) }).collect(),
        Some(Value::Object(map)) => vec![Value::Object(map.clone())],
        Some(Value::Null) | None => vec![json!({"ok": true, "status": status})],
        Some(other) => vec![json!({"value": other})],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(value: Value) -> Map<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    fn op(connector: &str, operation: &str) -> (&'static Connector, &'static Operation) {
        chosen(&json!({"connector": connector, "operation": operation})).unwrap()
    }

    fn header<'a>(request: &'a HttpSendRequest, name: &str) -> Option<&'a str> {
        request.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    fn body(request: &HttpSendRequest) -> Value {
        serde_json::from_str(request.body_text.as_deref().unwrap()).unwrap()
    }

    fn token(secret: &str, meta: Value) -> Credential {
        Credential { kind: "bearer".into(), meta, secret: secret.into() }
    }

    fn webhook(url: &str) -> Credential {
        Credential { kind: "webhook".into(), meta: json!({}), secret: url.into() }
    }

    #[test]
    fn slack_posts_with_a_bearer_and_leaves_empty_optionals_out() {
        let (connector, operation) = op("slack", "postMessage");
        let (request, _) =
            request_for(connector, operation, values(json!({"channel": "#ventas", "text": "Hola", "thread_ts": ""})), Some(&token("xoxb-1", json!({}))), 30_000)
                .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://slack.com/api/chat.postMessage");
        assert_eq!(header(&request, "Authorization"), Some("Bearer xoxb-1"));
        assert_eq!(body(&request), json!({"channel": "#ventas", "text": "Hola"}));

        let error = request_for(connector, operation, values(json!({"channel": "#ventas"})), Some(&token("xoxb-1", json!({}))), 30_000).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("Message")), "{error:?}");
        let error = request_for(connector, operation, values(json!({"channel": "#v", "text": "x"})), None, 30_000).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("credential")), "{error:?}");
    }

    #[test]
    fn telegram_carries_its_token_in_the_path_and_jira_signs_in_as_a_user_of_a_site() {
        let (connector, operation) = op("telegram", "sendMessage");
        let (request, _) = request_for(connector, operation, values(json!({"chat_id": "-100123", "text": "Listo"})), Some(&token("123:ABC", json!({}))), 30_000)
            .unwrap();
        assert_eq!(request.url, "https://api.telegram.org/bot123:ABC/sendMessage");
        assert_eq!(header(&request, "Authorization"), None);
        assert_eq!(body(&request)["chat_id"], "-100123");

        let (connector, operation) = op("jira", "search");
        let credential = Credential { kind: "basic".into(), meta: json!({"user": "ana@example.com"}), secret: "tok".into() };
        let (request, url) =
            request_for(connector, operation, values(json!({"site": "acme", "jql": "project = OPS"})), Some(&credential), 30_000).unwrap();
        assert_eq!(url.host_str(), Some("acme.atlassian.net"));
        assert_eq!(url.query_pairs().find(|(k, _)| k == "jql").map(|(_, v)| v.into_owned()).as_deref(), Some("project = OPS"));
        let expected = base64::engine::general_purpose::STANDARD.encode("ana@example.com:tok");
        assert_eq!(header(&request, "Authorization"), Some(format!("Basic {expected}").as_str()));
        let error = request_for(connector, operation, values(json!({"jql": "x"})), Some(&credential), 30_000).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("Site")), "{error:?}");
    }

    #[test]
    fn notion_names_its_title_property_and_parses_its_filter() {
        let (connector, operation) = op("notion", "createPage");
        let (request, _) = request_for(
            connector,
            operation,
            values(json!({"databaseId": "db1", "titleProperty": "Nombre", "title": "Pedido 7"})),
            Some(&token("secret_x", json!({}))),
            30_000,
        )
        .unwrap();
        assert_eq!(header(&request, "Notion-Version"), Some("2022-06-28"));
        let sent = body(&request);
        assert_eq!(sent["parent"]["database_id"], "db1");
        assert_eq!(sent["properties"]["Nombre"]["title"][0]["text"]["content"], "Pedido 7");
        assert!(sent.get("children").is_none(), "no page text, no empty block: {sent}");

        let (connector, operation) = op("notion", "queryDatabase");
        let (request, url) = request_for(
            connector,
            operation,
            values(json!({"databaseId": "db1", "filter": "{\"property\":\"Hecho\",\"checkbox\":{\"equals\":false}}"})),
            Some(&token("secret_x", json!({}))),
            30_000,
        )
        .unwrap();
        assert!(url.path().ends_with("/databases/db1/query"), "{url}");
        assert_eq!(body(&request)["filter"]["checkbox"]["equals"], false);
        let error = request_for(connector, operation, values(json!({"databaseId": "db1", "filter": "{nope"})), Some(&token("s", json!({}))), 30_000)
            .unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("JSON")), "{error:?}");
    }

    #[test]
    fn a_discord_webhook_is_a_credential_and_answers_are_read_per_service() {
        let (connector, operation) = op("discord", "webhookMessage");
        let hook = webhook(" https://discord.example.com/api/webhooks/1/x ");
        let (request, _) = request_for(connector, operation, values(json!({"content": "Hola"})), Some(&hook), 30_000).unwrap();
        assert_eq!(request.url, "https://discord.example.com/api/webhooks/1/x");
        assert_eq!(body(&request), json!({"content": "Hola"}));
        // A webhook answers 204 with nothing: the call still hands one item on.
        assert_eq!(answer_items(connector, operation, 204, "").unwrap(), vec![json!({"ok": true, "status": 204})]);
        let error = request_for(connector, operation, values(json!({"content": "x"})), Some(&webhook("file:///etc/hosts")), 30_000).unwrap_err();
        assert_eq!(error, NodeError::Failed("Discord is not an http or https address".into()), "the URL itself is never shown");
        let error = request_for(connector, operation, values(json!({"content": "x"})), Some(&token("t0ken", json!({}))), 30_000).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("webhook credential")), "{error:?}");

        let (connector, operation) = op("slack", "history");
        let items = answer_items(connector, operation, 200, r#"{"ok":true,"messages":[{"text":"a"},{"text":"b"}]}"#).unwrap();
        assert_eq!(items, vec![json!({"text": "a"}), json!({"text": "b"})]);
        let error = answer_items(connector, operation, 200, r#"{"ok":false,"error":"channel_not_found"}"#).unwrap_err();
        assert_eq!(error, NodeError::Failed("Slack: channel_not_found".into()));

        let (connector, operation) = op("jira", "createIssue");
        let error = answer_items(connector, operation, 400, r#"{"errorMessages":["Project is required"],"errors":{}}"#).unwrap_err();
        assert_eq!(error, NodeError::Failed("Jira answered 400: Project is required".into()));
    }

    fn query_of(url: &url::Url, name: &str) -> Option<String> {
        url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned())
    }

    #[test]
    fn trello_signs_in_with_its_key_and_token_in_the_query() {
        let (connector, operation) = op("trello", "createCard");
        let credential = Credential { kind: "basic".into(), meta: json!({"user": "key-1"}), secret: "token-2".into() };
        let (request, url) = request_for(connector, operation, values(json!({"listId": "L1", "name": "Pedido 9"})), Some(&credential), 30_000).unwrap();
        assert_eq!((query_of(&url, "key").as_deref(), query_of(&url, "token").as_deref()), (Some("key-1"), Some("token-2")));
        assert_eq!(header(&request, "Authorization"), None);
        assert_eq!(body(&request), json!({"idList": "L1", "name": "Pedido 9"}));
        let wrong = request_for(connector, operation, values(json!({"listId": "L1", "name": "x"})), Some(&token("t", json!({}))), 30_000).unwrap_err();
        assert!(matches!(wrong, NodeError::Failed(ref text) if text.contains("basic")), "{wrong:?}");
    }

    #[test]
    fn linear_sends_its_bare_key_and_a_graphql_error_fails_the_call() {
        let (connector, operation) = op("linear", "createIssue");
        let (request, url) =
            request_for(connector, operation, values(json!({"teamId": "T1", "title": "Bug", "priority": "2"})), Some(&token("lin_api_x", json!({}))), 30_000)
                .unwrap();
        assert_eq!(url.as_str(), "https://api.linear.app/graphql");
        assert_eq!(header(&request, "Authorization"), Some("lin_api_x"), "no Bearer: Linear refuses it for a personal key");
        let sent = body(&request);
        assert_eq!(sent["variables"]["input"], json!({"teamId": "T1", "title": "Bug", "priority": 2}));
        let ok = r#"{"data":{"issueCreate":{"success":true,"issue":{"identifier":"ENG-7"}}}}"#;
        assert_eq!(answer_items(connector, operation, 200, ok).unwrap()[0]["identifier"], "ENG-7");
        let failed = r#"{"data":null,"errors":[{"message":"Entity not found: Team"}]}"#;
        let error = answer_items(connector, operation, 200, failed).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("Entity not found: Team")), "{error:?}");
    }

    #[test]
    fn supabase_carries_its_key_twice_and_its_filters_as_written() {
        let (connector, operation) = op("supabase", "updateRows");
        let (request, url) = request_for(
            connector,
            operation,
            values(json!({"project": "abcd", "table": "pedidos", "filter": "id=eq.42&estado=neq.listo", "values": "{\"estado\": \"listo\"}"})),
            Some(&token("anon-key", json!({}))),
            30_000,
        )
        .unwrap();
        assert_eq!(url.host_str(), Some("abcd.supabase.co"));
        assert_eq!((query_of(&url, "id").as_deref(), query_of(&url, "estado").as_deref()), (Some("eq.42"), Some("neq.listo")));
        assert_eq!(header(&request, "apikey"), Some("anon-key"));
        assert_eq!(header(&request, "Authorization"), Some("Bearer anon-key"));
        assert_eq!(header(&request, "Prefer"), Some("return=representation"));
        assert_eq!(body(&request), json!({"estado": "listo"}));
    }

    fn basic(user: &str, secret: &str) -> Credential {
        Credential { kind: "basic".into(), meta: json!({"user": user}), secret: secret.into() }
    }

    #[test]
    fn ntfy_needs_no_credential_takes_its_default_server_and_reads_ndjson() {
        let (connector, operation) = op("ntfy", "publish");
        let (request, _) = request_for(connector, operation, values(json!({"topic": "deploys", "message": "Listo", "priority": "4", "server": ""})), None, 30_000).unwrap();
        assert_eq!(request.url, "https://ntfy.sh/");
        assert_eq!(header(&request, "Authorization"), None);
        assert_eq!(body(&request), json!({"topic": "deploys", "message": "Listo", "priority": 4}));
        // A protected server: the token signs it, and its trailing slash does not double the path's.
        let (request, _) = request_for(
            connector,
            operation,
            values(json!({"topic": "t", "message": "m", "server": "https://ntfy.example.com/"})),
            Some(&token("tk_1", json!({}))),
            30_000,
        )
        .unwrap();
        assert_eq!(request.url, "https://ntfy.example.com/");
        assert_eq!(header(&request, "Authorization"), Some("Bearer tk_1"));

        let (connector, operation) = op("ntfy", "poll");
        let (_, url) = request_for(connector, operation, values(json!({"topic": "mis avisos", "since": "1h"})), None, 30_000).unwrap();
        assert_eq!(url.path(), "/mis%20avisos/json");
        assert_eq!(query_of(&url, "poll").as_deref(), Some("1"));
        let ndjson = "{\"id\":\"a\",\"event\":\"message\",\"message\":\"uno\"}\n{\"id\":\"b\",\"event\":\"message\",\"message\":\"dos\"}\n";
        let items = answer_items(connector, operation, 200, ndjson).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["message"], "dos");
    }

    #[test]
    fn pushover_and_twilio_post_forms_and_place_their_credential_where_each_wants_it() {
        let (connector, operation) = op("pushover", "send");
        let (request, _) =
            request_for(connector, operation, values(json!({"message": "Build roto", "priority": "1", "title": ""})), Some(&basic("uKEY", "aTOKEN")), 30_000).unwrap();
        assert_eq!(request.url, "https://api.pushover.net/1/messages.json");
        assert_eq!(header(&request, "Authorization"), None, "the token travels in the body");
        assert_eq!(request.body_text, None);
        let pairs = request.urlencoded.clone().unwrap();
        assert!(pairs.contains(&("token".into(), "aTOKEN".into())) && pairs.contains(&("user".into(), "uKEY".into())), "{pairs:?}");
        assert!(pairs.contains(&("priority".into(), "1".into())));
        assert!(!pairs.iter().any(|(name, _)| name == "title"), "an empty optional is left out");
        let error = answer_items(connector, operation, 400, r#"{"user":"invalid","errors":["user identifier is invalid"],"status":0}"#).unwrap_err();
        assert_eq!(error, NodeError::Failed("Pushover answered 400: user identifier is invalid".into()));

        let (connector, operation) = op("twilio", "sendWhatsApp");
        let (request, _) =
            request_for(connector, operation, values(json!({"to": "+56912345678", "from": "+14155238886", "body": "Hola"})), Some(&basic("AC123", "secret")), 30_000)
                .unwrap();
        assert_eq!(request.url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
        assert!(header(&request, "Authorization").unwrap().starts_with("Basic "));
        let pairs = request.urlencoded.clone().unwrap();
        assert!(pairs.contains(&("To".into(), "whatsapp:+56912345678".into())), "{pairs:?}");
        assert!(pairs.contains(&("Body".into(), "Hola".into())));
    }

    #[test]
    fn gitlab_azure_devops_and_bitbucket_build_their_paths_and_bodies() {
        let (connector, operation) = op("gitlab", "createIssue");
        let (request, _) =
            request_for(connector, operation, values(json!({"project": "acme/app", "title": "Falla el login", "labels": "bug"})), Some(&token("glpat-1", json!({}))), 30_000)
                .unwrap();
        assert_eq!(request.url, "https://gitlab.com/api/v4/projects/acme%2Fapp/issues", "an empty host is gitlab.com, the project one segment");
        assert_eq!(body(&request), json!({"title": "Falla el login", "labels": "bug"}));
        let (request, _) = request_for(connector, operation, values(json!({"host": "git.example.com", "project": "7", "title": "x"})), Some(&token("t", json!({}))), 30_000)
            .unwrap();
        assert_eq!(request.url, "https://git.example.com/api/v4/projects/7/issues");

        let (connector, operation) = op("azuredevops", "createWorkItem");
        let (request, _) = request_for(
            connector,
            operation,
            values(json!({"organization": "acme", "project": "Web App", "type": "User Story", "title": "Login", "tags": ""})),
            Some(&basic("", "pat")),
            30_000,
        )
        .unwrap();
        assert_eq!(request.url, "https://dev.azure.com/acme/Web%20App/_apis/wit/workitems/$User%20Story?api-version=7.1");
        assert_eq!(header(&request, "Content-Type"), Some("application/json-patch+json"));
        assert_eq!(body(&request), json!([{"op": "add", "path": "/fields/System.Title", "value": "Login"}]), "empty fields add no patch operation");
        let expected = base64::engine::general_purpose::STANDARD.encode(":pat");
        assert_eq!(header(&request, "Authorization"), Some(format!("Basic {expected}").as_str()));

        let (connector, operation) = op("bitbucket", "createPullRequest");
        let (request, _) = request_for(
            connector,
            operation,
            values(json!({"workspace": "acme", "repo": "app", "title": "Login", "source": "feature/login"})),
            Some(&basic("ana@example.com", "token")),
            30_000,
        )
        .unwrap();
        assert_eq!(request.url, "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests");
        assert_eq!(body(&request), json!({"title": "Login", "source": {"branch": {"name": "feature/login"}}}));
        let error = answer_items(connector, operation, 400, r#"{"type":"error","error":{"message":"Bad request"}}"#).unwrap_err();
        assert_eq!(error, NodeError::Failed("Bitbucket answered 400: Bad request".into()));
    }

    #[test]
    fn whatsapp_names_the_media_key_after_its_kind() {
        let (connector, operation) = op("whatsapp", "sendMedia");
        let (request, _) = request_for(
            connector,
            operation,
            values(json!({"phoneNumberId": "1065", "to": "56912345678", "kind": "document", "link": "https://example.com/a.pdf"})),
            Some(&token("EAAG", json!({}))),
            30_000,
        )
        .unwrap();
        assert_eq!(request.url, "https://graph.facebook.com/v23.0/1065/messages");
        assert_eq!(
            body(&request),
            json!({"messaging_product": "whatsapp", "to": "56912345678", "type": "document", "document": {"link": "https://example.com/a.pdf"}})
        );
        let error = answer_items(connector, operation, 400, r#"{"error":{"message":"(#131030) Recipient phone number not in allowed list","code":131030}}"#).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("allowed list")), "{error:?}");
    }

    #[test]
    fn every_shipped_connector_reads_and_fits_a_credential_kind() {
        for connector in connectors::CONNECTORS.iter() {
            assert!(!connector.operations.is_empty(), "{} has no operations", connector.id);
            assert!(!connector.credential_kinds().is_empty() || connector.auth == "none", "{} signs in with nothing it knows", connector.id);
        }
        assert_eq!(connectors::CONNECTORS.len(), 24);
    }
}
