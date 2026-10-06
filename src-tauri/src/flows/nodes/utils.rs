//! Hito 8's utilities: a web page read as fields or Markdown, a site checked, waiting until
//! something holds, only what changed since the last run, a template, JSON (validate, query, diff)
//! and SQL over the items.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::{flag, number, strings, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};
use crate::flows::value::{get_path, set_path, to_text};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "net.webPage" => web_page(ctx).await,
        "net.check" => site_check(ctx).await,
        "logic.until" => until(ctx).await,
        "transform.changes" => changes(ctx).await,
        "transform.template" => template(ctx).await,
        "transform.json" => json_tool(ctx).await,
        "transform.sql" => sql(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

fn item_json(ctx: &NodeCtx, index: usize) -> Value {
    ctx.items().get(index).map(|item| item.json.clone()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn out_item(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, NodeError> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; CodeFlow Flujos)")
        .timeout(timeout)
        .build()
        .map_err(|e| NodeError::failed(e.to_string()))
}

// ------------------------------------------------------------------------------------- web page

/// The tags a page's reading never wants: what runs, what navigates, what is chrome.
const NOISE: &str = "script, style, noscript, template, iframe, svg, nav, header, footer, aside, form";

/// What a page holds, read the way a person reads it: as Markdown (the main part, the chrome taken
/// out — what a model is best fed), as plain text, as fields picked by CSS selector, or as its links.
async fn web_page(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let (html, url) = if text(params, "source") == "html" {
            (text(params, "pageHtml"), None)
        } else {
            let address = text(params, "url");
            if address.trim().is_empty() {
                return Err(NodeError::failed("Write the page's URL"));
            }
            let timeout = Duration::from_millis(number(params, "timeoutMs").unwrap_or(20_000.0).clamp(1_000.0, 120_000.0) as u64);
            let fetch = async {
                let response = http_client(timeout)?.get(address.trim()).send().await.map_err(|e| NodeError::failed(e.to_string()))?;
                let status = response.status();
                let final_url = response.url().clone();
                if !status.is_success() {
                    return Err(NodeError::failed(format!("{} answered {status}", final_url)));
                }
                let body = response.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
                Ok::<_, NodeError>((body, Some(final_url)))
            };
            tokio::select! {
                fetched = fetch => fetched?,
                _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
            }
        };
        let page = read_page(&html, url.as_ref(), params)?;
        match page {
            Read::One(json) => out.push(out_item(ctx, index, json)),
            Read::Many(list) => out.extend(list.into_iter().map(|json| out_item(ctx, index, json))),
        }
    }
    Ok(vec![out])
}

enum Read {
    One(Value),
    Many(Vec<Value>),
}

fn collapse_space(text: &str) -> String {
    let mut out = String::new();
    let mut blank_lines = 0;
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank_lines += 1;
            if blank_lines == 1 && !out.is_empty() {
                out.push('\n');
            }
        } else {
            blank_lines = 0;
            out.push_str(&line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn read_page(html: &str, url: Option<&url::Url>, params: &Value) -> Result<Read, NodeError> {
    let document = dom_query::Document::from(html);
    let title = document.select("title").text().trim().to_string();
    let address = url.map(|u| u.to_string());
    match text(params, "mode").as_str() {
        "extract" => {
            let mut fields = Map::new();
            for rule in params.get("fieldsToExtract").and_then(Value::as_array).into_iter().flatten() {
                let name = rule.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_string();
                let selector = rule.get("selector").and_then(Value::as_str).unwrap_or_default().trim().to_string();
                if name.is_empty() || selector.is_empty() {
                    continue;
                }
                let attribute = rule.get("attribute").and_then(Value::as_str).unwrap_or_default().trim().to_string();
                let all = rule.get("all").and_then(Value::as_bool).unwrap_or(false);
                let selection = document.try_select(&selector).ok_or_else(|| NodeError::failed(format!("\"{selector}\" is not a CSS selector this node reads")))?;
                let values: Vec<Value> = selection
                    .nodes()
                    .iter()
                    .map(|node| match attribute.as_str() {
                        "" | "text" => Value::String(collapse_space(&node.text())),
                        "html" => Value::String(node.inner_html().to_string()),
                        name => node
                            .attr(name)
                            .map(|value| {
                                let value = value.to_string();
                                // An address read from the page is made absolute against the page.
                                match (matches!(name, "href" | "src"), url) {
                                    (true, Some(base)) => base.join(&value).map(|u| u.to_string()).unwrap_or(value),
                                    _ => value,
                                }
                            })
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    })
                    .collect();
                fields.insert(name, if all { Value::Array(values) } else { values.into_iter().next().unwrap_or(Value::Null) });
            }
            Ok(Read::One(Value::Object(fields)))
        }
        "links" => {
            let mut seen = std::collections::HashSet::new();
            let links: Vec<Value> = document
                .select("a[href]")
                .nodes()
                .iter()
                .filter_map(|node| {
                    let raw = node.attr("href")?.to_string();
                    if raw.starts_with('#') || raw.starts_with("javascript:") || raw.starts_with("mailto:") {
                        return None;
                    }
                    let href = match url {
                        Some(base) => base.join(&raw).map(|u| u.to_string()).unwrap_or(raw),
                        None => raw,
                    };
                    seen.insert(href.clone()).then(|| json!({"text": collapse_space(&node.text()), "href": href}))
                })
                .collect();
            Ok(Read::Many(links))
        }
        mode => {
            let main_only = params.get("mainOnly").is_none() || flag(params, "mainOnly");
            if main_only {
                document.select(NOISE).remove();
            } else {
                document.select("script, style, noscript, template").remove();
            }
            let root = ["main", "article", "[role=main]", "body"]
                .iter()
                .map(|selector| document.select(selector))
                .find(|selection| main_only && selection.exists() || (!main_only && selection.is("body")))
                .unwrap_or_else(|| document.select("body"));
            let mut out = json!({"title": title, "url": address});
            if mode == "pageText" {
                out["text"] = json!(collapse_space(&root.text()));
            } else {
                let markdown = match root.nodes().first() {
                    Some(node) => node.md(None).to_string(),
                    None => document.md(None).to_string(),
                };
                out["markdown"] = json!(markdown.trim());
            }
            Ok(Read::One(out))
        }
    }
}

// ------------------------------------------------------------------------------------ site check

/// `200-399`, `200`, `200,204,301-302` — which statuses count as up.
fn status_allowed(spec: &str, status: u16) -> bool {
    let spec = if spec.trim().is_empty() { "200-399" } else { spec };
    spec.split(',').map(str::trim).filter(|part| !part.is_empty()).any(|part| match part.split_once('-') {
        Some((low, high)) => {
            let (low, high) = (low.trim().parse::<u16>().unwrap_or(0), high.trim().parse::<u16>().unwrap_or(0));
            (low..=high).contains(&status)
        }
        None => part.parse::<u16>().ok() == Some(status),
    })
}

fn host_of(target: &str) -> String {
    let target = target.trim();
    match url::Url::parse(target) {
        Ok(parsed) if parsed.host_str().is_some() => parsed.host_str().unwrap_or_default().to_string(),
        _ => target.trim_start_matches("//").split(['/', ':']).next().unwrap_or_default().to_string(),
    }
}

/// Whether a site answers and how fast, how long its certificate has left, what its DNS says, or
/// whether a port takes a connection — one item per input item, never failing on a bad answer:
/// `ok: false` is the finding, for an If after it to act on.
async fn site_check(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let target = text(params, "siteTarget");
        if target.trim().is_empty() {
            return Err(NodeError::failed("Write what to check"));
        }
        let timeout = Duration::from_millis(number(params, "timeoutMs").unwrap_or(10_000.0).clamp(500.0, 120_000.0) as u64);
        let check = async {
            match text(params, "check").as_str() {
                "tlsCheck" => tls_check(&target, params, timeout).await,
                "dnsCheck" => dns_check(&target, params).await,
                "portCheck" => port_check(&target, params, timeout).await,
                _ => http_check(&target, params, timeout).await,
            }
        };
        let result = tokio::select! {
            result = check => result,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        out.push(out_item(ctx, index, result));
    }
    Ok(vec![out])
}

async fn http_check(target: &str, params: &Value, timeout: Duration) -> Value {
    let address = if target.contains("://") { target.trim().to_string() } else { format!("https://{}", target.trim()) };
    let started = Instant::now();
    let client = match http_client(timeout) {
        Ok(client) => client,
        Err(NodeError::Failed(error)) => return json!({"target": address, "ok": false, "error": error}),
        Err(_) => return json!({"target": address, "ok": false}),
    };
    match client.get(&address).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let final_url = response.url().to_string();
            let ok = status_allowed(&text(params, "expectStatus"), status);
            json!({
                "target": address,
                "ok": ok,
                "status": status,
                "latencyMs": started.elapsed().as_millis() as u64,
                "finalUrl": final_url,
                "redirected": final_url.trim_end_matches('/') != address.trim_end_matches('/'),
            })
        }
        Err(error) => json!({"target": address, "ok": false, "latencyMs": started.elapsed().as_millis() as u64, "error": error.to_string()}),
    }
}

async fn port_check(target: &str, params: &Value, timeout: Duration) -> Value {
    let host = host_of(target);
    let port = number(params, "port").unwrap_or(443.0) as u16;
    let started = Instant::now();
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(_)) => json!({"target": host, "port": port, "ok": true, "open": true, "latencyMs": started.elapsed().as_millis() as u64}),
        Ok(Err(error)) => json!({"target": host, "port": port, "ok": false, "open": false, "error": error.to_string()}),
        Err(_) => json!({"target": host, "port": port, "ok": false, "open": false, "error": format!("No answer in {} ms", timeout.as_millis())}),
    }
}

/// The server's certificate: read even when it is invalid (that is what a check is for), then
/// judged — trusted by this machine's roots, and how many days it has left.
async fn tls_check(target: &str, params: &Value, timeout: Duration) -> Value {
    use x509_cert::der::Decode;
    let host = host_of(target);
    let port = number(params, "port").unwrap_or(443.0) as u16;
    let warn_days = number(params, "warnDays").unwrap_or(14.0) as i64;
    let fail = |error: String| json!({"target": host, "port": port, "ok": false, "error": error});
    let lenient = match crate::api::tls::rustls_config(&crate::api::NetworkOptions { verify_ssl: false, ..Default::default() }) {
        Ok(Some(config)) => config,
        Ok(None) => return fail("Could not prepare a TLS check".into()),
        Err(error) => return fail(error),
    };
    let Ok(server_name) = rustls::pki_types::ServerName::try_from(host.clone()) else { return fail(format!("\"{host}\" is not a host name")) };
    let handshake = async {
        let stream = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| e.to_string())?;
        let tls = tokio_rustls::TlsConnector::from(lenient).connect(server_name.clone(), stream).await.map_err(|e| e.to_string())?;
        let (_, session) = tls.get_ref();
        session.peer_certificates().and_then(|certs| certs.first()).map(|cert| cert.as_ref().to_vec()).ok_or_else(|| "The server sent no certificate".to_string())
    };
    let der = match tokio::time::timeout(timeout, handshake).await {
        Ok(Ok(der)) => der,
        Ok(Err(error)) => return fail(error),
        Err(_) => return fail(format!("No answer in {} ms", timeout.as_millis())),
    };
    let certificate = match x509_cert::Certificate::from_der(&der) {
        Ok(certificate) => certificate,
        Err(error) => return fail(format!("The certificate could not be read: {error}")),
    };
    let validity = &certificate.tbs_certificate.validity;
    let not_after = validity.not_after.to_unix_duration().as_secs() as i64;
    let not_before = validity.not_before.to_unix_duration().as_secs() as i64;
    let now = chrono::Utc::now().timestamp();
    let days_left = (not_after - now).div_euclid(86_400);
    let at = |secs: i64| chrono::DateTime::from_timestamp(secs, 0).map(|t| t.to_rfc3339()).unwrap_or_default();
    // A second, verified handshake answers "would a browser accept it".
    let trusted = {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        let config = std::sync::Arc::new(rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth());
        let attempt = async {
            let stream = tokio::net::TcpStream::connect((host.as_str(), port)).await.ok()?;
            tokio_rustls::TlsConnector::from(config).connect(server_name, stream).await.ok()
        };
        matches!(tokio::time::timeout(timeout, attempt).await, Ok(Some(_)))
    };
    json!({
        "target": host,
        "port": port,
        "ok": trusted && days_left > 0,
        "trusted": trusted,
        "daysLeft": days_left,
        "expiringSoon": days_left <= warn_days,
        "notBefore": at(not_before),
        "notAfter": at(not_after),
        "subject": certificate.tbs_certificate.subject.to_string(),
        "issuer": certificate.tbs_certificate.issuer.to_string(),
    })
}

async fn dns_check(target: &str, params: &Value) -> Value {
    use hickory_resolver::proto::rr::RecordType;
    let host = host_of(target);
    let kind = Some(text(params, "recordType")).filter(|kind| !kind.is_empty()).unwrap_or_else(|| "A".into());
    let record_type = match kind.as_str() {
        "AAAA" => RecordType::AAAA,
        "CNAME" => RecordType::CNAME,
        "MX" => RecordType::MX,
        "TXT" => RecordType::TXT,
        "NS" => RecordType::NS,
        _ => RecordType::A,
    };
    let resolver = match crate::datasource::srv::system_resolver() {
        Ok(resolver) => resolver,
        Err(error) => return json!({"target": host, "type": kind, "ok": false, "error": error}),
    };
    match resolver.lookup(host.as_str(), record_type).await {
        Ok(lookup) => {
            let records: Vec<String> = lookup.answers().iter().map(|record| record.data.to_string()).collect();
            json!({"target": host, "type": kind, "ok": !records.is_empty(), "records": records})
        }
        Err(error) => json!({"target": host, "type": kind, "ok": false, "records": [], "error": error.to_string()}),
    }
}

// ----------------------------------------------------------------------------------- wait until

/// Asks again and again — an address until it answers as expected, or a command until it succeeds
/// — every `intervalSec`, for at most `timeoutSec`: "until the deploy is healthy", "until the port
/// is open". The items pass through, each with what the last attempt saw.
async fn until(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let interval = Duration::from_secs_f64(number(&params, "intervalSec").unwrap_or(5.0).clamp(1.0, 3600.0));
    let limit = Duration::from_secs_f64(number(&params, "timeoutSec").unwrap_or(300.0).clamp(1.0, 24.0 * 3600.0));
    let started = Instant::now();
    let mut attempts = 0u32;
    let by_command = text(&params, "check") == "commandUntil";
    if by_command && text(&params, "command").trim().is_empty() {
        return Err(NodeError::failed("Write the command to run"));
    }
    if !by_command && text(&params, "url").trim().is_empty() {
        return Err(NodeError::failed("Write the address to ask"));
    }
    let report = loop {
        attempts += 1;
        let remaining = limit.saturating_sub(started.elapsed());
        let attempt = if by_command { command_attempt(&params, remaining.min(Duration::from_secs(120))).await } else { http_attempt(&params, remaining.min(Duration::from_secs(60))).await };
        let (ok, mut seen) = attempt;
        if ok {
            seen["ok"] = json!(true);
            break seen;
        }
        if started.elapsed() + interval >= limit {
            seen["ok"] = json!(false);
            if params.get("failOnTimeout").is_none() || flag(&params, "failOnTimeout") {
                return Err(NodeError::failed(format!(
                    "Still not there after {} attempts in {} s{}",
                    attempts,
                    started.elapsed().as_secs(),
                    seen.get("error").and_then(Value::as_str).map(|e| format!(": {e}")).unwrap_or_default()
                )));
            }
            break seen;
        }
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        }
    };
    ctx.log(LogStream::Info, &format!("{attempts} attempt(s) in {} s", started.elapsed().as_secs()));
    let mut until = report;
    until["attempts"] = json!(attempts);
    until["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
    let items = ctx.items();
    if items.is_empty() {
        return Ok(vec![vec![Item::new(json!({"until": until}))]]);
    }
    Ok(vec![items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut json = if item.json.is_object() { item.json.clone() } else { json!({}) };
            json["until"] = until.clone();
            Item::paired(json, index)
        })
        .collect()])
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let tail: String = text.chars().rev().take(max).collect::<Vec<_>>().into_iter().rev().collect();
        format!("…{tail}")
    }
}

async fn http_attempt(params: &Value, timeout: Duration) -> (bool, Value) {
    let client = match http_client(timeout.max(Duration::from_secs(1))) {
        Ok(client) => client,
        Err(_) => return (false, json!({"error": "Could not prepare the request"})),
    };
    match client.get(text(params, "url").trim()).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let wanted = text(params, "bodyContains");
            let ok = status_allowed(&text(params, "expectStatus"), status) && (wanted.is_empty() || body.contains(&wanted));
            (ok, json!({"status": status, "body": clip(&body, 2000)}))
        }
        Err(error) => (false, json!({"error": error.to_string()})),
    }
}

async fn command_attempt(params: &Value, timeout: Duration) -> (bool, Value) {
    let (program, args) = crate::services::supervisor::shell_invocation(&text(params, "command"));
    let mut command = tokio::process::Command::new(program);
    command.args(args).kill_on_drop(true).stdin(std::process::Stdio::null());
    let run = command.output();
    match tokio::time::timeout(timeout.max(Duration::from_secs(1)), run).await {
        Ok(Ok(output)) => {
            let text_out = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            let wanted = text(params, "outputContains");
            let ok = output.status.success() && (wanted.is_empty() || text_out.contains(&wanted));
            (ok, json!({"exitCode": output.status.code(), "output": clip(&text_out, 2000)}))
        }
        Ok(Err(error)) => (false, json!({"error": error.to_string()})),
        Err(_) => (false, json!({"error": "The command did not finish in time"})),
    }
}

// --------------------------------------------------------------------------------- only if changed

/// JSON with every object's keys in order, so the same value always hashes the same.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), canonical(v))).collect::<BTreeMap<_, _>>().into_iter().collect()),
        Value::Array(list) => Value::Array(list.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn fingerprint(value: &Value) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(canonical(value).to_string().as_bytes()))
}

/// What this node has seen in earlier runs, key → fingerprint, oldest first.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Seen {
    entries: Vec<(String, String)>,
}

/// Lets through only what is new or different since the last run — "tell me about new orders",
/// "warn when the price moves". Items are told apart by `key` and compared whole or by some fields;
/// the rest go out of "same". What was seen is kept in the flow's memory, `memory` keys at most.
async fn changes(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let state_key = format!("changes:{}", ctx.node.id);
    let stored = ctx.run.host.state_get(&state_key).map_err(NodeError::Failed)?;
    let first_run = stored.is_none();
    let mut seen: Seen = stored.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default();
    let mut index_of: std::collections::HashMap<String, usize> = seen.entries.iter().enumerate().map(|(i, (k, _))| (k.clone(), i)).collect();
    let emit_first = text(&ctx.params, "firstRun") != "emitNone";
    let fields = strings(&ctx.params, "fields");
    let by_fields = text(&ctx.params, "compare") == "someFields" && !fields.is_empty();
    let (mut changed, mut same) = (Vec::new(), Vec::new());
    let items = ctx.items();
    for (index, item) in items.iter().enumerate() {
        let params = &resolved[index.min(resolved.len() - 1)];
        let compared = if by_fields {
            Value::Object(fields.iter().map(|field| (field.clone(), get_path(&item.json, field).cloned().unwrap_or(Value::Null))).collect())
        } else {
            item.json.clone()
        };
        let print = fingerprint(&compared);
        let key = Some(to_text(params.get("key").unwrap_or(&Value::Null))).filter(|k| !k.trim().is_empty()).unwrap_or_else(|| print.clone());
        let is_new = match index_of.get(&key) {
            Some(&at) => {
                let differs = seen.entries[at].1 != print;
                seen.entries[at].1 = print;
                differs
            }
            None => {
                index_of.insert(key.clone(), seen.entries.len());
                seen.entries.push((key, print));
                true
            }
        };
        let out = Item::paired(item.json.clone(), index);
        if is_new && (!first_run || emit_first) {
            changed.push(out);
        } else {
            same.push(out);
        }
    }
    let memory = number(&ctx.params, "memory").unwrap_or(10_000.0).clamp(10.0, 1_000_000.0) as usize;
    if seen.entries.len() > memory {
        let drop = seen.entries.len() - memory;
        seen.entries.drain(..drop);
    }
    let value = serde_json::to_value(&seen).map_err(|e| NodeError::failed(e.to_string()))?;
    ctx.run.host.state_set(&state_key, Some(&value)).map_err(NodeError::Failed)?;
    Ok(vec![changed, same])
}

// --------------------------------------------------------------------------------------- template

/// A Jinja template (`{{ $json.name }}`, `{% for item in $items %}`) written into a field of each
/// item — or, once, over all of them. `json` is the item, `items` every item's JSON, `vars` the
/// run's variables, `now` the moment; each also with the `$` the rest of Flujos writes them with.
async fn template(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let written = ctx.param_str("template");
    let source = jinja_source(&written);
    let mut env = minijinja::Environment::new();
    env.set_undefined_behavior(minijinja::UndefinedBehavior::Chainable);
    env.add_template("t", &source).map_err(|e| NodeError::failed(format!("The template does not read: {e}")))?;
    let template = env.get_template("t").map_err(|e| NodeError::failed(e.to_string()))?;
    let field = Some(ctx.param_str("target")).filter(|f| !f.trim().is_empty()).unwrap_or_else(|| "text".into());
    let items: Vec<Value> = ctx.items().iter().map(|item| item.json.clone()).collect();
    let vars = Value::Object(ctx.run.vars.clone());
    let now = chrono::Utc::now().to_rfc3339();
    let render = |json: &Value| {
        template
            .render(minijinja::context! { json => json, items => items, vars => vars, now => now })
            .map_err(|e| NodeError::failed(format!("The template failed: {e}")))
    };
    if ctx.param_str("runFor") == "once" || items.is_empty() {
        let first = items.first().cloned().unwrap_or_else(|| json!({}));
        let mut out = json!({});
        set_path(&mut out, &field, Value::String(render(&first)?));
        return Ok(vec![vec![Item::new(out)]]);
    }
    let mut out = Vec::with_capacity(items.len());
    for (index, json) in items.iter().enumerate() {
        let rendered = render(json)?;
        let mut next = item_json(ctx, index);
        set_path(&mut next, &field, Value::String(rendered));
        out.push(Item::paired(next, index));
    }
    Ok(vec![out])
}

/// The names a template is given. Everywhere else in Flujos they are written `$json`, `$vars`… and a
/// field dragged in from the input arrives as `{{ $json.campo }}`, so a template takes both.
const TEMPLATE_NAMES: [&str; 4] = ["json", "items", "vars", "now"];

/// `source` with the `$` dropped from [`TEMPLATE_NAMES`] inside its tags.
///
/// Jinja has no `$` in a name: outside a string, `$json` in a `{{ }}` or `{% %}` can only be a syntax
/// error, so reading it as `json` changes no template that worked. Text, strings, comments and
/// `{% raw %}` blocks stay as written, and so does any other `$name` — an error, as it was.
fn jinja_source(source: &str) -> std::borrow::Cow<'_, str> {
    if !source.contains('$') {
        return std::borrow::Cow::Borrowed(source);
    }
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut copied = 0;
    let mut raw = false;
    let mut i = 0;
    while i + 1 < bytes.len() {
        let kind = bytes[i + 1];
        if bytes[i] != b'{' || !matches!(kind, b'{' | b'%' | b'#') || (raw && kind != b'%') {
            i += 1;
            continue;
        }
        let body = i + 2;
        // Inside a raw block only `{% endraw %}` ends it, quotes and all; a comment ends at its `#}`.
        let Some(end) = tag_end(bytes, body, kind, !raw && kind != b'#') else { break };
        let inner = &source[body..end];
        let word = inner.trim_start_matches(['-', '+']).trim_start();
        let word = word.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').next().unwrap_or("");
        if kind == b'%' && word == if raw { "endraw" } else { "raw" } {
            raw = !raw;
        } else if !raw && kind != b'#' {
            out.push_str(&source[copied..body]);
            unsigil(inner, &mut out);
            copied = end;
        }
        i = end + 2;
    }
    out.push_str(&source[copied..]);
    std::borrow::Cow::Owned(out)
}

/// Where the tag opened by `{` + `kind` just before `from` closes: the index of its `}}`, `%}` or
/// `#}`. Strings are stepped over when `strings`, and braces nest, as Jinja's own reader does.
fn tag_end(bytes: &[u8], from: usize, kind: u8, strings: bool) -> Option<usize> {
    let close = match kind {
        b'{' => b'}',
        b'%' => b'%',
        _ => b'#',
    };
    let mut depth = 0usize;
    let mut i = from;
    while i + 1 < bytes.len() {
        match bytes[i] {
            quote @ (b'"' | b'\'') if strings => {
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
                continue;
            }
            b'{' if strings => depth += 1,
            b'}' if depth > 0 => depth -= 1,
            c if c == close && bytes[i + 1] == b'}' => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

/// One tag's code, copied with the `$` of the template's own names left out (strings untouched).
fn unsigil(code: &str, out: &mut String) {
    let bytes = code.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            quote @ (b'"' | b'\'') => {
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'$' if i == 0 || !word(bytes[i - 1]) => {
                let end = (i + 1..bytes.len()).find(|&j| !word(bytes[j])).unwrap_or(bytes.len());
                if TEMPLATE_NAMES.contains(&&code[i + 1..end]) {
                    out.push_str(&code[copied..i]);
                    copied = i + 1;
                }
                i = end;
            }
            _ => i += 1,
        }
    }
    out.push_str(&code[copied..]);
}

// ------------------------------------------------------------------------------------------- JSON

/// A parameter that holds JSON: a value an expression produced, or text to parse.
fn json_param(params: &Value, name: &str) -> Value {
    match params.get(name) {
        Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.clone())),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}

fn diff_into(path: String, left: &Value, right: &Value, out: &mut Vec<Value>) {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                let at = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                match b.get(key) {
                    Some(other) => diff_into(at, value, other, out),
                    None => out.push(json!({"path": at, "op": "removed", "from": value})),
                }
            }
            for (key, value) in b {
                if !a.contains_key(key) {
                    let at = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                    out.push(json!({"path": at, "op": "added", "to": value}));
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for i in 0..a.len().max(b.len()) {
                let at = format!("{path}[{i}]");
                match (a.get(i), b.get(i)) {
                    (Some(x), Some(y)) => diff_into(at, x, y, out),
                    (Some(x), None) => out.push(json!({"path": at, "op": "removed", "from": x})),
                    (None, Some(y)) => out.push(json!({"path": at, "op": "added", "to": y})),
                    (None, None) => {}
                }
            }
        }
        _ if left != right => out.push(json!({"path": if path.is_empty() { "$".to_string() } else { path }, "op": "changed", "from": left, "to": right})),
        _ => {}
    }
}

/// What two JSON values differ in, path by path.
pub(crate) fn json_diff(left: &Value, right: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    diff_into(String::new(), left, right, &mut out);
    out
}

/// JSON, three ways: checked against a JSON Schema (valid, and why not), queried with JSONPath,
/// or compared with another value.
async fn json_tool(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let operation = ctx.param_str("operation");
    let schema = if operation == "validate" {
        let raw = ctx.param_str("schema");
        let schema: Value = serde_json::from_str(&raw).map_err(|e| NodeError::failed(format!("The schema is not JSON: {e}")))?;
        Some(jsonschema::validator_for(&schema).map_err(|e| NodeError::failed(format!("The schema is not a valid JSON Schema: {e}")))?)
    } else {
        None
    };
    let resolved = ctx.resolve_each().await?;
    let count = ctx.items().len().max(1);
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let params = &resolved[index.min(resolved.len() - 1)];
        let mut item = item_json(ctx, index);
        let target = Some(text(params, "target")).filter(|t| !t.trim().is_empty());
        let (default_field, result) = match operation.as_str() {
            "jsonPath" => {
                let path = serde_json_path::JsonPath::parse(text(params, "jsonPathExpr").trim()).map_err(|e| NodeError::failed(format!("Not a JSONPath: {e}")))?;
                let value = json_param(params, "value");
                let found: Vec<Value> = path.query(&value).all().into_iter().cloned().collect();
                ("result", Value::Array(found))
            }
            "jsonDiff" => ("diff", Value::Array(json_diff(&json_param(params, "left"), &json_param(params, "right")))),
            _ => {
                let value = json_param(params, "value");
                let validator = schema.as_ref().expect("built above");
                let errors: Vec<Value> = validator
                    .iter_errors(&value)
                    .map(|error| json!({"path": error.instance_path().to_string(), "message": error.to_string()}))
                    .collect();
                ("validation", json!({"valid": errors.is_empty(), "errors": errors}))
            }
        };
        set_path(&mut item, &target.unwrap_or_else(|| default_field.to_string()), result);
        out.push(out_item(ctx, index, item));
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------ SQL on items

fn to_sql(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        Value::Null => Sql::Null,
        Value::Bool(flag) => Sql::Integer(i64::from(*flag)),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(text) => Sql::Text(text.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn from_sql(value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::String(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)),
    }
}

/// The items as a table, `items`, one column per top-level field (nested values as JSON text, for
/// `json_extract`), and a query over it — grouping, joining with itself, windows, whatever SQLite
/// does. Its rows are the output.
pub(crate) fn query_items(items: &[Value], query: &str) -> Result<Vec<Value>, String> {
    let conn = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
    let mut columns: Vec<String> = Vec::new();
    for item in items {
        if let Value::Object(map) = item {
            for key in map.keys() {
                if !columns.contains(key) {
                    columns.push(key.clone());
                }
            }
        }
    }
    let quoted: Vec<String> = columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect();
    let create = if quoted.is_empty() { "CREATE TABLE items (_empty)".to_string() } else { format!("CREATE TABLE items ({})", quoted.join(", ")) };
    conn.execute(&create, []).map_err(|e| e.to_string())?;
    if !columns.is_empty() {
        let placeholders = vec!["?"; columns.len()].join(", ");
        let insert = format!("INSERT INTO items ({}) VALUES ({placeholders})", quoted.join(", "));
        let mut statement = conn.prepare(&insert).map_err(|e| e.to_string())?;
        for item in items {
            let values: Vec<rusqlite::types::Value> = columns.iter().map(|c| to_sql(item.get(c).unwrap_or(&Value::Null))).collect();
            statement.execute(rusqlite::params_from_iter(values)).map_err(|e| e.to_string())?;
        }
    }
    let mut statement = conn.prepare(query).map_err(|e| e.to_string())?;
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_string).collect();
    let mut rows = statement.query([]).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut map = Map::new();
        for (i, name) in names.iter().enumerate() {
            map.insert(name.clone(), from_sql(row.get_ref(i).map_err(|e| e.to_string())?));
        }
        out.push(Value::Object(map));
        if out.len() >= 100_000 {
            break;
        }
    }
    Ok(out)
}

async fn sql(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let query = ctx.param_str("itemsQuery");
    if query.trim().is_empty() {
        return Err(NodeError::failed("Write the query — the items are the table \"items\""));
    }
    let items: Vec<Value> = ctx.items().iter().map(|item| item.json.clone()).collect();
    let rows = query_items(&items, &query).map_err(|e| NodeError::failed(format!("The query failed: {e}")))?;
    Ok(vec![rows.into_iter().map(Item::new).collect()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_template_takes_its_names_with_or_without_the_dollar() {
        assert_eq!(jinja_source("Hola {{ json.nombre }}"), "Hola {{ json.nombre }}");
        assert_eq!(
            jinja_source("=== #{{ $json.id }} ===\n{% for s in $json.stats %}{{ s.stat.name }}: {{ s.base_stat }}\n{% endfor %}"),
            "=== #{{ json.id }} ===\n{% for s in json.stats %}{{ s.stat.name }}: {{ s.base_stat }}\n{% endfor %}"
        );
        assert_eq!(jinja_source("{{- $items|length -}} {{ $now }} {% set a = {'x': $vars.k} %}"), "{{- items|length -}} {{ now }} {% set a = {'x': vars.k} %}");
        // Text, strings, comments and raw blocks are as written.
        assert_eq!(jinja_source("$json {{ '$json' ~ \"}}$json\" }} {# $json #}"), "$json {{ '$json' ~ \"}}$json\" }} {# $json #}");
        assert_eq!(jinja_source("{% raw %}{{ $json }} {% if %}{%- endraw %}{{ $json }}"), "{% raw %}{{ $json }} {% if %}{%- endraw %}{{ json }}");
        // Only the template's own names: `$input` stays the error it always was.
        assert_eq!(jinja_source("{{ $input.all() }} {{ a$json }} {{ $jsonx }}"), "{{ $input.all() }} {{ a$json }} {{ $jsonx }}");
        assert_eq!(jinja_source("{{ $json"), "{{ $json", "an unclosed tag is left to Jinja to report");
    }

    #[test]
    fn statuses_and_hosts_are_read_the_way_people_write_them() {
        assert!(status_allowed("", 301) && !status_allowed("", 404));
        assert!(status_allowed("200,204,500-503", 502) && !status_allowed("200", 201));
        assert_eq!(host_of("https://example.com:8443/x"), "example.com");
        assert_eq!(host_of("example.com/path"), "example.com");
    }

    #[test]
    fn a_page_reads_as_markdown_without_its_chrome_as_fields_and_as_links() {
        let html = r#"<html><head><title>Blog</title><script>var x=1</script></head><body>
            <nav><a href="/menu">Menu</a></nav>
            <main><h1>Hola</h1><p>Un <b>post</b> corto.</p><a href="/posts/2">Siguiente</a></main>
            <footer>© 2026</footer></body></html>"#;
        let base = url::Url::parse("https://example.com/blog/").unwrap();
        let Read::One(page) = read_page(html, Some(&base), &json!({"mode": "markdown"})).unwrap() else { panic!() };
        let markdown = page["markdown"].as_str().unwrap();
        assert!(markdown.contains("# Hola") && markdown.contains("**post**"), "{markdown}");
        assert!(!markdown.contains("Menu") && !markdown.contains("2026") && !markdown.contains("var x"), "{markdown}");
        assert_eq!(page["title"], "Blog");

        let rules = json!({"mode": "extract", "fieldsToExtract": [
            {"name": "title", "selector": "h1"},
            {"name": "next", "selector": "main a", "attribute": "href"},
            {"name": "all", "selector": "a", "attribute": "text", "all": true},
        ]});
        let Read::One(fields) = read_page(html, Some(&base), &rules).unwrap() else { panic!() };
        assert_eq!(fields["title"], "Hola");
        assert_eq!(fields["next"], "https://example.com/posts/2", "made absolute against the page");
        assert_eq!(fields["all"], json!(["Menu", "Siguiente"]));

        let Read::Many(links) = read_page(html, Some(&base), &json!({"mode": "links"})).unwrap() else { panic!() };
        assert_eq!(links.len(), 2);
        assert_eq!(links[1]["href"], "https://example.com/posts/2");
    }

    #[test]
    fn json_diffs_say_where_and_how() {
        let diff = json_diff(&json!({"a": 1, "b": {"c": [1, 2]}, "gone": true}), &json!({"a": 2, "b": {"c": [1]}, "new": "x"}));
        let ops: Vec<(String, String)> = diff.iter().map(|d| (d["path"].as_str().unwrap().to_string(), d["op"].as_str().unwrap().to_string())).collect();
        assert!(ops.contains(&("a".into(), "changed".into())));
        assert!(ops.contains(&("b.c[1]".into(), "removed".into())));
        assert!(ops.contains(&("gone".into(), "removed".into())));
        assert!(ops.contains(&("new".into(), "added".into())));
        assert!(json_diff(&json!({"x": [1]}), &json!({"x": [1]})).is_empty());
    }

    #[test]
    fn items_are_a_table_sqlite_can_group() {
        let items = vec![
            json!({"region": "norte", "total": 10, "meta": {"vip": true}}),
            json!({"region": "sur", "total": 5.5}),
            json!({"region": "norte", "total": 2}),
        ];
        let rows = query_items(&items, "SELECT region, SUM(total) AS total, COUNT(*) AS n FROM items GROUP BY region ORDER BY region").unwrap();
        assert_eq!(rows, vec![json!({"region": "norte", "total": 12, "n": 2}), json!({"region": "sur", "total": 5.5, "n": 1})]);
        let vip = query_items(&items, "SELECT json_extract(meta, '$.vip') AS vip FROM items WHERE meta IS NOT NULL").unwrap();
        assert_eq!(vip, vec![json!({"vip": 1})]);
        assert!(query_items(&items, "SELEKT").is_err());
        assert_eq!(query_items(&[], "SELECT 1 AS one").unwrap(), vec![json!({"one": 1})]);
    }

    #[tokio::test]
    async fn a_certificate_is_read_even_when_nobody_trusts_it() {
        let key = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let certs = vec![key.cert.der().clone()];
        let private = rustls::pki_types::PrivateKeyDer::Pkcs8(key.signing_key.serialize_der().into());
        let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, private).unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else { break };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let _ = acceptor.accept(socket).await;
                });
            }
        });
        let found = tls_check("localhost", &json!({"port": port, "warnDays": 14}), Duration::from_secs(5)).await;
        assert_eq!(found["trusted"], false, "{found}");
        assert_eq!(found["ok"], false);
        let days = found["daysLeft"].as_i64().unwrap();
        assert!(days > 300, "rcgen's default validity is years, not {days} days");
        assert!(found["subject"].as_str().is_some_and(|s| !s.is_empty()), "{found}");
        assert!(found["notAfter"].as_str().is_some_and(|at| !at.is_empty()), "{found}");
    }

    #[test]
    fn the_same_value_always_has_the_same_fingerprint() {
        assert_eq!(fingerprint(&json!({"a": 1, "b": 2})), fingerprint(&json!({"b": 2, "a": 1})));
        assert_ne!(fingerprint(&json!({"a": 1})), fingerprint(&json!({"a": 2})));
    }
}
