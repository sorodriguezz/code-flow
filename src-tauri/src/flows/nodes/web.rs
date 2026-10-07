//! The web, beyond one HTTP request: a search engine's results («Buscar en internet»), a SOAP
//! service from its WSDL («SOAP»), any AWS API signed with SigV4 («AWS») and a computer woken over the
//! network («Encender un equipo»).

use std::time::Duration;

use serde_json::{json, Map, Value};

use super::{number, pairs, text, NodeCtx, NodeError};
use crate::flows::engine::{Credential, LogStream};
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "net.search" => search(ctx).await,
        "net.soap" => soap(ctx).await,
        "net.aws" => aws(ctx).await,
        "net.wol" => wol(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, NodeError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) CodeFlow/Flujos")
        .build()
        .map_err(|e| NodeError::failed(e.to_string()))
}

async fn resolved(ctx: &NodeCtx) -> Result<Vec<(Value, Option<usize>)>, NodeError> {
    let each = ctx.param_str("runFor") != "once" && !ctx.items().is_empty();
    if each {
        Ok(ctx.resolve_each().await?.into_iter().enumerate().map(|(i, p)| (p, Some(i))).collect())
    } else {
        Ok(vec![(ctx.resolve_once().await?, if ctx.items().is_empty() { None } else { Some(0) })])
    }
}

fn item(json: Value, index: Option<usize>) -> Item {
    match index {
        Some(i) => Item::paired(json, i),
        None => Item::new(json),
    }
}

async fn send(ctx: &NodeCtx, request: reqwest::RequestBuilder) -> Result<reqwest::Response, NodeError> {
    tokio::select! {
        response = request.send() => response.map_err(|e| NodeError::failed(e.to_string())),
        _ = ctx.cancel.cancelled() => Err(NodeError::Cancelled),
    }
}

async fn secret_of(ctx: &NodeCtx, params: &Value) -> Result<Option<Credential>, NodeError> {
    let id = text(params, "credential");
    if id.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(ctx.credential(id.trim()).await?))
}

// --------------------------------------------------------------------------------------- search

/// DuckDuckGo's HTML results link through a redirect (`//duckduckgo.com/l/?uddg=<url>`).
fn ddg_target(href: &str) -> String {
    let absolute = if href.starts_with("//") { format!("https:{href}") } else { href.to_string() };
    url::Url::parse(&absolute)
        .ok()
        .and_then(|u| u.query_pairs().find(|(k, _)| k == "uddg").map(|(_, v)| v.into_owned()))
        .unwrap_or(absolute)
}

pub fn parse_duckduckgo(html: &str, max: usize) -> Vec<Value> {
    let document = dom_query::Document::from(html);
    document
        .select(".result")
        .iter()
        .filter(|result| !result.has_class("result--ad"))
        .filter_map(|result| {
            let link = result.select(".result__a");
            let href = link.attr("href")?.to_string();
            let title = link.text().trim().to_string();
            (!title.is_empty()).then(|| json!({"title": title, "url": ddg_target(&href), "snippet": result.select(".result__snippet").text().trim()}))
        })
        .take(max)
        .collect()
}

/// A search API's answer as JSON, or its refusal as the node's error. A wrong key (401) or a spent
/// quota (429) comes back as a JSON body with no results in it: read as an answer it was "0 results",
/// which reads as a quiet day rather than as a key that stopped working.
async fn search_json(ctx: &NodeCtx, provider: &str, request: reqwest::RequestBuilder) -> Result<Value, NodeError> {
    let response = send(ctx, request).await?;
    let status = response.status();
    let body = response.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
    search_answer(provider, status, &body)
}

fn search_answer(provider: &str, status: reqwest::StatusCode, body: &str) -> Result<Value, NodeError> {
    if !status.is_success() {
        return Err(refusal(provider, status, body));
    }
    serde_json::from_str(body).map_err(|e| NodeError::failed(format!("{provider} did not answer JSON: {e}")))
}

/// A search service's "no", with its status and the start of what it said.
fn refusal(provider: &str, status: reqwest::StatusCode, body: &str) -> NodeError {
    let hint = match status.as_u16() {
        401 | 403 => " (is the key right?)",
        429 => " (too many searches: the plan's limit or its rate)",
        _ => "",
    };
    let detail: String = body.trim().chars().take(300).collect();
    NodeError::failed(if detail.is_empty() { format!("{provider} answered {status}{hint}") } else { format!("{provider} answered {status}{hint}: {detail}") })
}

async fn search(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (params, index) in resolved(ctx).await? {
        let query = text(&params, "searchQuery");
        if query.trim().is_empty() {
            return Err(NodeError::failed("Write what to search for"));
        }
        let max = number(&params, "maxResults").unwrap_or(5.0).clamp(1.0, 50.0) as usize;
        let freshness = text(&params, "searchFreshness");
        let language = text(&params, "searchLanguage");
        let provider = text(&params, "searchProvider");
        let http = client(Duration::from_secs(30))?;
        let credential = secret_of(ctx, &params).await?;
        let key = || credential.as_ref().map(|c| c.secret.clone()).filter(|s| !s.is_empty()).ok_or_else(|| NodeError::failed("Choose the credential with the search API's key"));
        let mut answer: Option<String> = None;
        let results: Vec<Value> = match provider.as_str() {
            "brave" => {
                let mut request = http
                    .get("https://api.search.brave.com/res/v1/web/search")
                    .header("X-Subscription-Token", key()?)
                    .header("Accept", "application/json")
                    .query(&[("q", query.as_str()), ("count", &max.to_string())]);
                if let Some(f) = match freshness.as_str() { "pastDay" => Some("pd"), "pastWeek" => Some("pw"), "pastMonth" => Some("pm"), _ => None } {
                    request = request.query(&[("freshness", f)]);
                }
                if !language.trim().is_empty() {
                    request = request.query(&[("search_lang", language.trim())]);
                }
                let doc = search_json(ctx, "Brave", request).await?;
                doc.pointer("/web/results")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().map(|r| json!({"title": r.get("title"), "url": r.get("url"), "snippet": r.get("description"), "age": r.get("age")})).collect())
                    .unwrap_or_default()
            }
            "tavily" => {
                let mut body = json!({"query": query, "max_results": max, "include_answer": true});
                if let Some(range) = match freshness.as_str() { "pastDay" => Some("day"), "pastWeek" => Some("week"), "pastMonth" => Some("month"), _ => None } {
                    body["time_range"] = json!(range);
                }
                let doc = search_json(ctx, "Tavily", http.post("https://api.tavily.com/search").bearer_auth(key()?).json(&body)).await?;
                answer = doc.get("answer").and_then(Value::as_str).map(str::to_string);
                doc.get("results")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().map(|r| json!({"title": r.get("title"), "url": r.get("url"), "snippet": r.get("content"), "score": r.get("score")})).collect())
                    .unwrap_or_default()
            }
            "searxng" => {
                let base = text(&params, "searxUrl");
                if base.trim().is_empty() {
                    return Err(NodeError::failed("Write the SearXNG address"));
                }
                let mut request = http.get(format!("{}/search", base.trim().trim_end_matches('/'))).query(&[("q", query.as_str()), ("format", "json")]);
                if let Some(range) = match freshness.as_str() { "pastDay" => Some("day"), "pastWeek" => Some("week"), "pastMonth" => Some("month"), _ => None } {
                    request = request.query(&[("time_range", range)]);
                }
                if !language.trim().is_empty() {
                    request = request.query(&[("language", language.trim())]);
                }
                let response = send(ctx, request).await?;
                if !response.status().is_success() {
                    return Err(NodeError::failed(format!("SearXNG answered {} — is the JSON format enabled on it?", response.status())));
                }
                let doc: Value = response.json().await.map_err(|e| NodeError::failed(e.to_string()))?;
                doc.get("results")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().take(max).map(|r| json!({"title": r.get("title"), "url": r.get("url"), "snippet": r.get("content"), "engine": r.get("engine")})).collect())
                    .unwrap_or_default()
            }
            "serper" => {
                let mut body = json!({"q": query, "num": max});
                if !language.trim().is_empty() {
                    body["hl"] = json!(language.trim());
                }
                if let Some(t) = match freshness.as_str() { "pastDay" => Some("qdr:d"), "pastWeek" => Some("qdr:w"), "pastMonth" => Some("qdr:m"), _ => None } {
                    body["tbs"] = json!(t);
                }
                let doc = search_json(ctx, "Serper", http.post("https://google.serper.dev/search").header("X-API-KEY", key()?).json(&body)).await?;
                answer = doc.pointer("/answerBox/answer").or_else(|| doc.pointer("/answerBox/snippet")).and_then(Value::as_str).map(str::to_string);
                doc.get("organic")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().map(|r| json!({"title": r.get("title"), "url": r.get("link"), "snippet": r.get("snippet"), "date": r.get("date")})).collect())
                    .unwrap_or_default()
            }
            _ => {
                // DuckDuckGo's plain HTML page: no key, no JavaScript.
                let mut form = vec![("q", query.clone())];
                if let Some(f) = match freshness.as_str() { "pastDay" => Some("d"), "pastWeek" => Some("w"), "pastMonth" => Some("m"), _ => None } {
                    form.push(("df", f.to_string()));
                }
                let mut request = http.post("https://html.duckduckgo.com/html/").form(&form);
                if !language.trim().is_empty() {
                    request = request.header("Accept-Language", language.trim());
                }
                let response = send(ctx, request).await?;
                let status = response.status();
                let html = response.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
                if !status.is_success() {
                    // Asked too often, DuckDuckGo answers with a page that has no results on it.
                    return Err(refusal("DuckDuckGo", status, ""));
                }
                parse_duckduckgo(&html, max)
            }
        };
        ctx.log(LogStream::Info, &format!("{} result(s) for \"{}\"", results.len(), query.trim()));
        let fetch = number(&params, "fetchPages").unwrap_or(0.0).clamp(0.0, 10.0) as usize;
        for (position, mut result) in results.into_iter().enumerate() {
            result["position"] = json!(position + 1);
            result["query"] = json!(query.trim());
            if let Some(a) = &answer {
                result["answer"] = json!(a);
            }
            if position < fetch {
                if let Some(address) = result.get("url").and_then(Value::as_str).map(str::to_string) {
                    if let Ok(response) = send(ctx, http.get(&address)).await {
                        if let Ok(html) = response.text().await {
                            let page = super::utils::page_markdown(&html, url::Url::parse(&address).ok().as_ref());
                            result["content"] = page.get("markdown").cloned().unwrap_or(Value::Null);
                        }
                    }
                }
            }
            out.push(item(result, index));
        }
    }
    Ok(vec![out])
}

// ----------------------------------------------------------------------------------------- SOAP

/// What a WSDL says an operation needs: the endpoint, the `SOAPAction`, the target namespace and
/// the operation's input element.
#[derive(Debug, Clone, PartialEq)]
pub struct SoapOperation {
    pub endpoint: String,
    pub action: String,
    pub namespace: String,
    pub element: String,
}

pub fn read_wsdl(wsdl: &str, operation: &str) -> Result<SoapOperation, String> {
    let document = dom_query::Document::from(wsdl);
    let namespace = regex::Regex::new(r#"targetNamespace\s*=\s*"([^"]+)""#).ok().and_then(|re| re.captures(wsdl)).map(|c| c[1].to_string()).unwrap_or_default();
    let endpoint = regex::Regex::new(r#"<(?:\w+:)?address[^>]*location\s*=\s*"([^"]+)""#).ok().and_then(|re| re.captures(wsdl)).map(|c| c[1].to_string()).unwrap_or_default();
    // `soapAction` of the binding's operation with that name, read inside that operation's own
    // element. The portType lists every operation first, with no action: searching on from the first
    // `name="…"` ran into the binding's first operation and took its action, so every operation but the
    // first was sent as the first.
    let element = regex::Regex::new(&format!(r#"(?s)<(?:\w+:)?operation\b[^>]*?\bname\s*=\s*"{}"[^>]*?(?:/>|>(.*?)</(?:\w+:)?operation\s*>)"#, regex::escape(operation)));
    let soap_action = regex::Regex::new(r#"soapAction\s*=\s*"([^"]*)""#);
    let action = match (element, soap_action) {
        (Ok(element), Ok(soap_action)) => element
            .captures_iter(wsdl)
            .find_map(|c| c.get(1).and_then(|body| soap_action.captures(body.as_str())).map(|found| found[1].to_string()))
            .unwrap_or_default(),
        _ => String::new(),
    };
    let known = regex::Regex::new(&format!(r#"name\s*=\s*"{}""#, regex::escape(operation))).ok().is_some_and(|re| re.is_match(wsdl));
    if !known {
        let names: Vec<String> = regex::Regex::new(r#"<(?:\w+:)?operation[^>]*name\s*=\s*"([^"]+)""#)
            .ok()
            .map(|re| re.captures_iter(wsdl).map(|c| c[1].to_string()).collect::<std::collections::BTreeSet<_>>().into_iter().collect())
            .unwrap_or_default();
        return Err(format!("The WSDL has no operation \"{operation}\". It has: {}", names.join(", ")));
    }
    let _ = document;
    Ok(SoapOperation { endpoint, action, namespace, element: operation.to_string() })
}

fn json_to_xml(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                match child {
                    Value::Array(list) => {
                        for entry in list {
                            out.push_str(&format!("<{key}>"));
                            json_to_xml(entry, out);
                            out.push_str(&format!("</{key}>"));
                        }
                    }
                    _ => {
                        out.push_str(&format!("<{key}>"));
                        json_to_xml(child, out);
                        out.push_str(&format!("</{key}>"));
                    }
                }
            }
        }
        Value::Null => {}
        Value::String(s) => out.push_str(&s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")),
        other => out.push_str(&other.to_string()),
    }
}

pub fn envelope(op: &SoapOperation, body: &str, version: &str) -> String {
    let ns = if version == "1.2" { "http://www.w3.org/2003/05/soap-envelope" } else { "http://schemas.xmlsoap.org/soap/envelope/" };
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="{ns}" xmlns:tns="{}"><soap:Body><tns:{el}>{body}</tns:{el}></soap:Body></soap:Envelope>"#,
        op.namespace,
        el = op.element
    )
}

async fn soap(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (params, index) in resolved(ctx).await? {
        let operation = text(&params, "soapOperation");
        if operation.trim().is_empty() {
            return Err(NodeError::failed("Write the SOAP operation"));
        }
        let timeout = Duration::from_millis(number(&params, "timeoutMs").unwrap_or(30_000.0).clamp(1000.0, 600_000.0) as u64);
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .danger_accept_invalid_certs(!super::flag(&params, "verifySsl") && params.get("verifySsl").is_some())
            .build()
            .map_err(|e| NodeError::failed(e.to_string()))?;
        let wsdl_source = text(&params, "wsdlUrl");
        let wsdl = if wsdl_source.trim().starts_with("http") {
            send(ctx, http.get(wsdl_source.trim())).await?.text().await.map_err(|e| NodeError::failed(e.to_string()))?
        } else if wsdl_source.trim().is_empty() {
            String::new()
        } else {
            std::fs::read_to_string(super::expand_path(wsdl_source.trim())).map_err(|e| NodeError::failed(e.to_string()))?
        };
        let mut op = if wsdl.is_empty() {
            SoapOperation { endpoint: String::new(), action: String::new(), namespace: String::new(), element: operation.trim().to_string() }
        } else {
            read_wsdl(&wsdl, operation.trim()).map_err(NodeError::Failed)?
        };
        let endpoint = text(&params, "endpoint");
        if !endpoint.trim().is_empty() {
            op.endpoint = endpoint.trim().to_string();
        }
        if op.endpoint.is_empty() {
            return Err(NodeError::failed("Give the WSDL or the endpoint"));
        }
        let version = text(&params, "soapVersion");
        let request_xml = if text(&params, "soapBodyMode") == "soapXml" {
            text(&params, "soapRaw")
        } else {
            let body_json = match params.get("soapBody") {
                Some(Value::String(s)) if !s.trim().is_empty() => serde_json::from_str(s).map_err(|e| NodeError::failed(format!("The parameters are not JSON: {e}")))?,
                Some(Value::Object(map)) => Value::Object(map.clone()),
                _ => json!({}),
            };
            let mut inner = String::new();
            json_to_xml(&body_json, &mut inner);
            envelope(&op, &inner, &version)
        };
        let content_type = if version == "1.2" { format!("application/soap+xml; charset=utf-8; action=\"{}\"", op.action) } else { "text/xml; charset=utf-8".to_string() };
        let mut request = http.post(&op.endpoint).header("Content-Type", content_type).body(request_xml);
        if version != "1.2" {
            request = request.header("SOAPAction", format!("\"{}\"", op.action));
        }
        for (name, value) in pairs(&params, "headers") {
            request = request.header(name, value);
        }
        if let Some(credential) = secret_of(ctx, &params).await? {
            request = match credential.kind.as_str() {
                "basic" => request.basic_auth(credential.meta.get("user").and_then(Value::as_str).unwrap_or_default(), Some(&credential.secret)),
                "header" => request.header(credential.meta.get("header").and_then(Value::as_str).unwrap_or("Authorization"), &credential.secret),
                "query" => request.query(&[(credential.meta.get("param").and_then(Value::as_str).unwrap_or("key"), credential.secret.as_str())]),
                _ => request.bearer_auth(&credential.secret),
            };
        }
        let response = send(ctx, request).await?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
        let parsed = super::formats::xml_to_json(&body).unwrap_or(Value::String(body.clone()));
        // The Body's first child is the answer; a Fault is an error with its own words.
        let envelope_body = ["Envelope", "soap:Envelope", "S:Envelope", "SOAP-ENV:Envelope", "soapenv:Envelope", "env:Envelope"]
            .iter()
            .find_map(|k| parsed.get(*k))
            .and_then(|env| env.as_object().and_then(|m| m.iter().find(|(k, _)| k.ends_with("Body")).map(|(_, v)| v.clone())))
            .unwrap_or(Value::Null);
        let fault = envelope_body.as_object().and_then(|m| m.iter().find(|(k, _)| k.ends_with("Fault")).map(|(_, v)| v.clone()));
        if let Some(fault) = fault {
            return Err(NodeError::failed(format!("SOAP fault: {}", fault.to_string().chars().take(400).collect::<String>())));
        }
        if status >= 400 {
            return Err(NodeError::failed(format!("The service answered {status}: {}", body.chars().take(400).collect::<String>())));
        }
        let result = envelope_body.as_object().and_then(|m| m.values().next().cloned()).unwrap_or(envelope_body.clone());
        out.push(item(json!({"status": status, "result": result, "operation": op.element}), index));
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------------ AWS

async fn aws(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (params, index) in resolved(ctx).await? {
        let credential = secret_of(ctx, &params).await?.ok_or_else(|| NodeError::failed("Choose the AWS credential"))?;
        if credential.kind != "aws" {
            return Err(NodeError::failed("The credential is not an AWS key"));
        }
        let service = text(&params, "awsService").trim().to_lowercase();
        let region = { let r = text(&params, "awsRegion"); if r.trim().is_empty() { "us-east-1".to_string() } else { r.trim().to_string() } };
        if service.is_empty() {
            return Err(NodeError::failed("Write the AWS service (lambda, ses, sns, dynamodb…)"));
        }
        let host = {
            let h = text(&params, "awsHost");
            if !h.trim().is_empty() {
                h.trim().to_string()
            } else if matches!(service.as_str(), "iam" | "route53" | "cloudfront") {
                format!("{service}.amazonaws.com")
            } else {
                format!("{service}.{region}.amazonaws.com")
            }
        };
        let path = { let p = text(&params, "awsPath"); if p.trim().is_empty() { "/".to_string() } else { p.trim().to_string() } };
        let mut url = url::Url::parse(&format!("https://{host}{}", if path.starts_with('/') { path.clone() } else { format!("/{path}") })).map_err(|e| NodeError::failed(e.to_string()))?;
        for (name, value) in pairs(&params, "query") {
            url.query_pairs_mut().append_pair(&name, &value);
        }
        let method = { let m = text(&params, "method"); if m.trim().is_empty() { "POST".to_string() } else { m.trim().to_uppercase() } };
        let body = text(&params, "body");
        let mut headers: Vec<(String, String)> = pairs(&params, "headers").into_iter().map(|(k, v)| (k.to_lowercase(), v)).collect();
        let target = text(&params, "awsTarget");
        if !target.trim().is_empty() {
            headers.push(("x-amz-target".into(), target.trim().to_string()));
            if !headers.iter().any(|(k, _)| k == "content-type") {
                headers.push(("content-type".into(), "application/x-amz-json-1.0".into()));
            }
        } else if !body.trim().is_empty() && !headers.iter().any(|(k, _)| k == "content-type") {
            headers.push(("content-type".into(), if body.trim_start().starts_with('{') { "application/json".into() } else { "application/x-www-form-urlencoded".into() }));
        }
        let access_key = credential.meta.get("user").and_then(Value::as_str).unwrap_or_default().to_string();
        let session = credential.meta.get("sessionToken").and_then(Value::as_str).unwrap_or_default().to_string();
        let signed = crate::sigv4::sigv4_headers(
            &method,
            &url,
            &headers,
            &crate::sigv4::hex_sha256(body.as_bytes()),
            &access_key,
            &credential.secret,
            &session,
            &region,
            &service,
            &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
        )
        .map_err(NodeError::Failed)?;
        let timeout = Duration::from_millis(number(&params, "timeoutMs").unwrap_or(30_000.0).clamp(1000.0, 900_000.0) as u64);
        let http = reqwest::Client::builder().timeout(timeout).build().map_err(|e| NodeError::failed(e.to_string()))?;
        let mut request = http.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| NodeError::failed(e.to_string()))?, url.as_str()).body(body);
        for (name, value) in headers.into_iter().chain(signed) {
            request = request.header(name, value);
        }
        let started = std::time::Instant::now();
        let response = send(ctx, request).await?;
        let status = response.status().as_u16();
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let raw = response.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
        ctx.log(LogStream::Info, &format!("{service} {method} {} → {status} ({} ms)", url.path(), started.elapsed().as_millis()));
        let parsed = if content_type.contains("json") || raw.trim_start().starts_with('{') {
            serde_json::from_str(&raw).unwrap_or(Value::String(raw.clone()))
        } else if content_type.contains("xml") || raw.trim_start().starts_with('<') {
            super::formats::xml_to_json(&raw).unwrap_or(Value::String(raw.clone()))
        } else {
            Value::String(raw.clone())
        };
        if status >= 400 {
            return Err(NodeError::failed(format!("{service} answered {status}: {}", raw.chars().take(500).collect::<String>())));
        }
        out.push(item(json!({"status": status, "body": parsed}), index));
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------- wake on LAN

/// `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff` or `aabb.ccdd.eeff` as six bytes.
pub fn mac_bytes(mac: &str) -> Result<[u8; 6], String> {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 {
        return Err(format!("\"{mac}\" is not a MAC address"));
    }
    let mut bytes = [0u8; 6];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}

/// Six `0xFF`, then the MAC sixteen times.
pub fn magic_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut packet = vec![0xFF; 6];
    for _ in 0..16 {
        packet.extend_from_slice(&mac);
    }
    packet
}

async fn wol(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (params, index) in resolved(ctx).await? {
        let mac = mac_bytes(&text(&params, "macAddress")).map_err(NodeError::Failed)?;
        let broadcast = { let b = text(&params, "broadcast"); if b.trim().is_empty() { "255.255.255.255".to_string() } else { b.trim().to_string() } };
        let port = number(&params, "wolPort").unwrap_or(9.0).clamp(1.0, 65535.0) as u16;
        let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.map_err(|e| NodeError::failed(e.to_string()))?;
        socket.set_broadcast(true).map_err(|e| NodeError::failed(e.to_string()))?;
        let packet = magic_packet(mac);
        // Three times: a dropped UDP packet is the usual reason a machine stays asleep.
        for _ in 0..3 {
            socket.send_to(&packet, (broadcast.as_str(), port)).await.map_err(|e| NodeError::failed(format!("Could not send to {broadcast}:{port}: {e}")))?;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut done = Map::new();
        done.insert("sent".into(), json!(true));
        done.insert("mac".into(), json!(mac.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")));
        done.insert("broadcast".into(), json!(broadcast));
        done.insert("port".into(), json!(port));
        out.push(item(Value::Object(done), index));
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_on_lan_packets() {
        let mac = mac_bytes("aa-bb-cc-dd-ee-ff").unwrap();
        assert_eq!(mac, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        let packet = magic_packet(mac);
        assert_eq!(packet.len(), 102);
        assert_eq!(&packet[..6], &[0xFF; 6]);
        assert_eq!(&packet[6..12], &mac);
        assert!(mac_bytes("nope").is_err());
    }

    #[test]
    fn duckduckgo_results_are_read() {
        let html = r#"<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1">Example A</a><a class="result__snippet">First snippet</a></div>
<div class="result result--ad"><a class="result__a" href="https://ads.example">Ad</a></div>
<div class="result"><a class="result__a" href="https://example.org/b">Example B</a><div class="result__snippet">Second</div></div>"#;
        let results = parse_duckduckgo(html, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["url"], "https://example.com/a");
        assert_eq!(results[0]["snippet"], "First snippet");
        assert_eq!(results[1]["title"], "Example B");
    }

    #[test]
    fn each_soap_operation_is_sent_with_its_own_action() {
        let wsdl = r#"<wsdl:definitions targetNamespace="urn:demo" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/">
<wsdl:portType name="P"><wsdl:operation name="Alta"><wsdl:input message="a"/></wsdl:operation><wsdl:operation name="Baja"><wsdl:input message="b"/></wsdl:operation><wsdl:operation name="Consulta"/></wsdl:portType>
<wsdl:binding name="B"><wsdl:operation name="Alta"><soap:operation soapAction="urn:demo/Alta"/></wsdl:operation><wsdl:operation name="Baja"><soap:operation soapAction="urn:demo/Baja" style="document"/></wsdl:operation><wsdl:operation name="Consulta"><soap:operation soapAction="urn:demo/Consulta"/></wsdl:operation></wsdl:binding>
<wsdl:service name="S"><wsdl:port name="X" binding="B"><soap:address location="https://ws.example.com/demo"/></wsdl:port></wsdl:service></wsdl:definitions>"#;
        for name in ["Alta", "Baja", "Consulta"] {
            assert_eq!(read_wsdl(wsdl, name).unwrap().action, format!("urn:demo/{name}"));
        }
    }

    #[test]
    fn a_search_service_that_refuses_is_an_error_not_zero_results() {
        let unauthorized = search_answer("Brave", reqwest::StatusCode::UNAUTHORIZED, r#"{"type":"ErrorResponse","error":{"detail":"The provided subscription token is invalid"}}"#).unwrap_err();
        assert!(matches!(unauthorized, NodeError::Failed(ref text) if text.contains("401") && text.contains("subscription token is invalid")), "{unauthorized:?}");
        let spent = search_answer("Tavily", reqwest::StatusCode::TOO_MANY_REQUESTS, "").unwrap_err();
        assert_eq!(spent, NodeError::Failed("Tavily answered 429 Too Many Requests (too many searches: the plan's limit or its rate)".into()));
        assert_eq!(search_answer("Serper", reqwest::StatusCode::OK, r#"{"organic":[]}"#).unwrap(), json!({"organic": []}));
    }

    #[test]
    fn wsdl_operations_are_found() {
        let wsdl = r#"<definitions targetNamespace="http://example.com/clientes" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/">
<portType name="P"><operation name="ObtenerCliente"/></portType>
<binding name="B"><operation name="ObtenerCliente"><soap:operation soapAction="http://example.com/clientes/Obtener"/></operation></binding>
<service name="S"><port name="X" binding="B"><soap:address location="https://ws.example.com/clientes"/></port></service></definitions>"#;
        let op = read_wsdl(wsdl, "ObtenerCliente").unwrap();
        assert_eq!(op.endpoint, "https://ws.example.com/clientes");
        assert_eq!(op.action, "http://example.com/clientes/Obtener");
        assert_eq!(op.namespace, "http://example.com/clientes");
        assert!(read_wsdl(wsdl, "Borrar").unwrap_err().contains("ObtenerCliente"));
        let mut xml = String::new();
        json_to_xml(&json!({"rut": "1-9", "items": [{"id": 1}, {"id": 2}]}), &mut xml);
        // In the order written: a SOAP schema's `sequence` makes element order matter.
        assert_eq!(xml, "<rut>1-9</rut><items><id>1</id></items><items><id>2</id></items>");
        assert!(envelope(&op, &xml, "1.1").contains("<tns:ObtenerCliente><rut>"));
    }
}
