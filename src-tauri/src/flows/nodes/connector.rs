//! The "Conector" node: one call to a service described in `flows::connectors`.
//!
//! Building the request ([`request_for`]) and reading the answer ([`answer_items`]) are plain
//! functions of the definition, so every shipped connector is tested without its service.
//!
//! **No error shows the credential.** A transport error names the URL it went to and a refusal quotes
//! what the service said; Telegram's token is part of its URL, a webhook *is* one. Everything a call
//! fails with or logs goes through [`redact`] first — in a run, and outside one (a trigger's card, a
//! field's lookup), where nothing else would.

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::http::loggable;
use super::{number, text, NodeCtx, NodeError};
use crate::api::{HttpResponse, HttpSendRequest, NetworkOptions};
use crate::flows::connectors::{self, Choice, Connector, Field, Lookup, Operation};
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
        // A call that writes (a message, a charge, an issue) has happened once it answered.
        if params.get("call").and_then(|call| chosen(call).ok()).is_some_and(|(_, operation)| !operation.method.eq_ignore_ascii_case("GET")) {
            ctx.mark_sent();
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

/// A value sent even when it comes out empty: `{"$keep": "{{path}}"}` in a body or a query. An
/// optional field left empty takes its key out of the request (`connectors::render`), which is what
/// nearly every service wants — but Dropbox names its root folder `"path": ""`, and a body without
/// the key is a 400.
const KEEP: &str = "$keep";

/// `rendered` with each `{"$keep": …}` of `template` unwrapped: to its value, or to `""` when the
/// value was empty and `render` left it out.
fn unwrap_kept(template: &Value, rendered: &mut Value, values: &Map<String, Value>) {
    let (Value::Object(template), Value::Object(out)) = (template, rendered) else { return };
    for (key, entry) in template {
        // A key can be a placeholder too (Notion's title property): found under the name it took.
        let Some(slot) = out.get_mut(&connectors::splice(key, values)) else { continue };
        match entry {
            Value::Object(inner) if inner.len() == 1 && inner.contains_key(KEEP) => {
                *slot = slot.get(KEEP).cloned().unwrap_or_else(|| Value::String(String::new()));
            }
            Value::Object(_) => unwrap_kept(entry, slot, values),
            _ => {}
        }
    }
}

/// What a credential reads as where it was taken out — the run's own redaction writes the same.
const HIDDEN: &str = "••••••";

/// Every way a credential can appear in the text of an error or a log line: as stored and trimmed, as
/// a URL writes it in a path or a query, the encoded pair `basic` sends, and — a webhook — the URL as
/// `url` prints it back. Shorter than four characters a "secret" would take ordinary words out of
/// every message, as the run's own rule says too.
fn secret_forms(credential: Option<&Credential>) -> Vec<String> {
    let Some(credential) = credential else { return Vec::new() };
    let mut forms = Vec::new();
    for secret in [credential.secret.as_str(), credential.secret.trim()] {
        forms.push(secret.to_string());
        forms.push(url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>());
        forms.push(crate::oauth::urlencode(secret));
        if let Ok(path) = url::Url::parse(&format!("http://x/{secret}")) {
            forms.push(path.path().trim_start_matches('/').to_string());
        }
        if let Ok(address) = url::Url::parse(secret) {
            forms.push(address.to_string());
            forms.push(address.to_string().trim_end_matches('/').to_string());
        }
    }
    if let Some(user) = credential.meta.get("user").and_then(Value::as_str) {
        forms.push(base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", credential.secret)));
    }
    forms.retain(|form| form.chars().count() >= 4);
    // Longest first, so a form that holds another is replaced whole.
    forms.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    forms.dedup();
    forms
}

/// `text` with every form of the credential replaced.
fn redact(text: &str, forms: &[String]) -> String {
    forms.iter().fold(text.to_string(), |out, form| if out.contains(form.as_str()) { out.replace(form.as_str(), HIDDEN) } else { out })
}

fn hidden(error: NodeError, forms: &[String]) -> NodeError {
    match error {
        NodeError::Failed(text) => NodeError::Failed(redact(&text, forms)),
        other => other,
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
    let forms = secret_forms(credential.as_ref());
    let (request, _) = request_for(connector, operation, values, credential.as_ref(), timeout_ms).map_err(|e| hidden(e, &forms))?;
    if let Some(Credential { kind, .. }) = &credential {
        if kind == "basic" || connector.auth == "basic" {
            // The encoded pair is as much the password as the password.
            if let Some((_, value)) = request.headers.iter().find(|(name, _)| name == "Authorization") {
                ctx.run.host.secret_used(value.trim_start_matches("Basic "));
            }
        }
    }
    // A bearer token is what an OAuth sign-in resolves to: the one kind of credential a 401 can be answered with a new token.
    let token = credential.as_ref().filter(|_| connector.auth == "bearer").map(|credential| credential.secret.clone());
    let mut sender = Sender { ctx, connector, operation, credential_id: id.trim().to_string(), token, renewed: false, forms };
    let response = sender.page(request.clone()).await?;
    let first = answer_items(connector, operation, response.status, &response.body_text).map_err(|e| hidden(e, &sender.forms))?;
    match (operation.paginate.as_ref(), pages_wanted(&call)) {
        (Some(paginate), Some(max)) => {
            let forms = sender.forms.clone();
            every_page(&mut sender, connector, operation, paginate, request, response, first, max).await.map_err(|e| hidden(e, &forms))
        }
        _ => Ok(first),
    }
}

// ------------------------------------------------------------------------------------------ pages

/// How many entries a call that asks for every page stops at, unless the node says another number — and the most it may.
const DEFAULT_MAX_ITEMS: usize = 1_000;
const MOST_ITEMS: usize = 100_000;
/// Past this many pages a list is a service that never says «last»: stopped, and said.
const MAX_PAGES: usize = 500;
/// How many times a request answered «too many requests» is sent again, and the longest wait asked for.
const TOO_MANY_TRIES: usize = 2;
const TOO_MANY_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// The node's «every page» choice (`call.allPages`) with its limit (`call.maxItems`): `None` for the first page only.
fn pages_wanted(call: &Value) -> Option<usize> {
    let on = match call.get("allPages") {
        Some(Value::Bool(on)) => *on,
        Some(Value::String(text)) => text.trim() == "true",
        _ => false,
    };
    if !on {
        return None;
    }
    let limit = match call.get("maxItems") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    Some(limit.filter(|n| *n >= 1.0).map_or(DEFAULT_MAX_ITEMS, |n| n as usize).min(MOST_ITEMS))
}

/// What sends one request of a call: in a run (waiting out a 429, renewing an OAuth sign-in after a 401) or outside one.
trait Pager {
    fn page(&mut self, request: HttpSendRequest) -> impl std::future::Future<Output = Result<HttpResponse, NodeError>>;
    fn note(&self, text: &str);
}

/// The wait a `Retry-After` header asks for, when it is a number of seconds.
fn retry_after(headers: &[(String, String)]) -> Option<std::time::Duration> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("retry-after"))
        .and_then(|(_, value)| value.trim().parse::<u64>().ok())
        .map(std::time::Duration::from_secs)
}

/// A run's requests for one call. A 429 is waited out as the service asks (twice at most: it means the request was not
/// processed, so sending it again is safe). A 401 to an OAuth sign-in's token is answered once with a renewed token —
/// revoked, or replaced by a sign-in elsewhere before its expiry — and every request after that carries the new one.
struct Sender<'a> {
    ctx: &'a NodeCtx,
    connector: &'a Connector,
    operation: &'a Operation,
    credential_id: String,
    token: Option<String>,
    renewed: bool,
    forms: Vec<String>,
}

impl Sender<'_> {
    fn sign(&self, request: &mut HttpSendRequest) {
        let Some(token) = &self.token else { return };
        for (name, value) in request.headers.iter_mut() {
            if name.eq_ignore_ascii_case("authorization") && value.starts_with("Bearer ") {
                *value = format!("Bearer {token}");
            }
        }
    }
}

impl Pager for Sender<'_> {
    async fn page(&mut self, mut request: HttpSendRequest) -> Result<HttpResponse, NodeError> {
        let mut waited = 0;
        loop {
            self.sign(&mut request);
            let shown = url::Url::parse(&request.url).map(|url| loggable(&url)).unwrap_or_default();
            let response = tokio::select! {
                response = crate::api::http::send(request.clone(), None, None) => response.map_err(|e| NodeError::failed(redact(&e, &self.forms)))?,
                _ = self.ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
            };
            self.ctx.log(
                LogStream::Info,
                &redact(&format!("{} {} {} → {} ({} ms)", self.connector.name, self.operation.method, shown, response.status, response.duration_ms), &self.forms),
            );
            if response.status == 429 && waited < TOO_MANY_TRIES {
                let wait = retry_after(&response.headers).unwrap_or(std::time::Duration::from_secs(2 << waited)).min(TOO_MANY_WAIT);
                self.ctx.log(LogStream::Info, &format!("{} asked to slow down — waiting {} s", self.connector.name, wait.as_secs()));
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = self.ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
                }
                waited += 1;
                continue;
            }
            if response.status == 401 && !self.renewed {
                if let Some(refused) = self.token.clone() {
                    self.renewed = true;
                    if let Some(fresh) = self.ctx.renewed_credential(&self.credential_id, &refused).await? {
                        self.forms.extend(secret_forms(Some(&fresh)));
                        self.forms.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
                        self.forms.dedup();
                        self.token = Some(fresh.secret);
                        self.ctx.log(LogStream::Info, &format!("{} refused the sign-in's token — renewed it, asking again", self.connector.name));
                        continue;
                    }
                }
            }
            return Ok(response);
        }
    }

    fn note(&self, text: &str) {
        self.ctx.log(LogStream::Info, text);
    }
}

/// Requests made outside a run — the «Cambios en un servicio» trigger's look.
struct Outside {
    forms: Vec<String>,
}

impl Pager for Outside {
    async fn page(&mut self, request: HttpSendRequest) -> Result<HttpResponse, NodeError> {
        crate::api::http::send(request, None, None).await.map_err(|e| NodeError::failed(redact(&e, &self.forms)))
    }

    fn note(&self, _text: &str) {}
}

/// The entries of every page of a list, from the first (already read), until the service says there are no more, `max`
/// entries are in hand, or [`MAX_PAGES`] were read.
#[allow(clippy::too_many_arguments)]
async fn every_page<P: Pager>(
    pager: &mut P,
    connector: &Connector,
    operation: &Operation,
    paginate: &connectors::Paginate,
    mut request: HttpSendRequest,
    mut response: HttpResponse,
    mut items: Vec<Value>,
    max: usize,
) -> Result<Vec<Value>, NodeError> {
    let mut on_page = items.len();
    let mut asked: std::collections::HashSet<String> = std::collections::HashSet::from([request_print(&request)]);
    let mut pages = 1;
    while items.len() < max && listed(operation, &response.body_text) {
        if pages >= MAX_PAGES {
            pager.note(&format!("{} still had more after {MAX_PAGES} pages — stopped there", connector.name));
            break;
        }
        let answer = parse_answer(&response.body_text);
        let page = Page { request: &request, headers: &response.headers, answer: &answer, items: &items[items.len() - on_page..], number: pages - 1, read: items.len() };
        let Some(next) = next_page(paginate, operation, &page).map_err(NodeError::Failed)? else { break };
        // A service that hands back the page it just gave would be asked for it for ever.
        if !asked.insert(request_print(&next)) {
            pager.note(&format!("{} named a page it had already given — stopped there", connector.name));
            break;
        }
        response = pager.page(next.clone()).await?;
        let got = if listed(operation, &response.body_text) { answer_items(connector, operation, response.status, &response.body_text)? } else { Vec::new() };
        on_page = got.len();
        request = next;
        pages += 1;
        if got.is_empty() {
            break;
        }
        items.extend(got);
    }
    if items.len() > max {
        pager.note(&format!("Kept the first {max} entries (the node's limit); the list goes on"));
        items.truncate(max);
    } else if items.len() == max {
        pager.note(&format!("Stopped at {max} entries (the node's limit)"));
    }
    Ok(items)
}

/// Whether an answer holds a list where the operation says (an empty last page may leave the key out).
fn listed(operation: &Operation, body: &str) -> bool {
    operation.result.is_empty() || answer_at(&parse_answer(body), &operation.result).is_some_and(|found| !found.is_null())
}

fn request_print(request: &HttpSendRequest) -> String {
    format!("{} {} {}", request.method, request.url, request.body_text.as_deref().unwrap_or_default())
}

/// What a page left behind for the next one to be asked from.
pub(super) struct Page<'a> {
    pub request: &'a HttpSendRequest,
    pub headers: &'a [(String, String)],
    pub answer: &'a Value,
    /// The entries this page gave.
    pub items: &'a [Value],
    /// This page's place, from 0.
    pub number: usize,
    /// The entries read so far, this page's included.
    pub read: usize,
}

/// A value of the answer at `path` — a key with dots in it (`@odata.nextLink`) taken whole first.
fn answer_at<'a>(answer: &'a Value, path: &str) -> Option<&'a Value> {
    answer.get(path).or_else(|| crate::flows::value::get_path(answer, path))
}

fn answer_text(answer: &Value, path: &str) -> Option<String> {
    match answer_at(answer, path)? {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The `rel="next"` address of a `Link` header — none when the service marks it empty (Sentry's `results="false"`).
fn link_next(headers: &[(String, String)]) -> Option<String> {
    for (_, value) in headers.iter().filter(|(name, _)| name.eq_ignore_ascii_case("link")) {
        let mut rest = value.as_str();
        while let Some(start) = rest.find('<') {
            let Some(length) = rest[start..].find('>') else { break };
            let address = &rest[start + 1..start + length];
            let after = &rest[start + length + 1..];
            let end = after.find('<').unwrap_or(after.len());
            let params: Vec<(String, String)> = after[..end]
                .split([';', ','])
                .filter_map(|param| param.split_once('='))
                .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().trim_matches('"').to_ascii_lowercase()))
                .collect();
            if params.iter().any(|(key, value)| key == "rel" && value.split_whitespace().any(|rel| rel == "next")) {
                let empty = params.iter().any(|(key, value)| key == "results" && value == "false");
                return (!empty).then(|| address.to_string());
            }
            rest = &after[end..];
        }
    }
    None
}

/// Whether two addresses are the same server — scheme, host and port: a page's address goes with the credential.
fn same_server(a: &url::Url, b: &url::Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn with_query(url: &url::Url, name: &str, value: &str) -> url::Url {
    let kept: Vec<(String, String)> = url.query_pairs().filter(|(key, _)| key != name).map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
    let mut next = url.clone();
    next.set_query(None);
    {
        let mut pairs = next.query_pairs_mut();
        for (key, value) in &kept {
            pairs.append_pair(key, value);
        }
        pairs.append_pair(name, value);
    }
    next
}

/// The request for the page after `page`, or `None` when that was the last one.
pub(super) fn next_page(paginate: &connectors::Paginate, operation: &Operation, page: &Page) -> Result<Option<HttpSendRequest>, String> {
    if !paginate.more.is_empty() && answer_at(page.answer, &paginate.more) != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    if !paginate.last.is_empty() && answer_at(page.answer, &paginate.last) == Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let current = url::Url::parse(&page.request.url).map_err(|e| e.to_string())?;
    let mut next = page.request.clone();
    let address = |written: &str, base: Option<String>| -> Result<url::Url, String> {
        let found = match base {
            Some(base) => url::Url::parse(&format!("{}{}", base.trim_end_matches('/'), written)),
            None => current.join(written),
        }
        .map_err(|_| "The service named a next page that is not an address".to_string())?;
        if !same_server(&current, &found) {
            return Err(format!("The service named a next page on another server ({}) — not followed: the credential would go with it", found.host_str().unwrap_or_default()));
        }
        Ok(found)
    };
    match paginate.style.as_str() {
        "link" => {
            let Some(written) = link_next(page.headers) else { return Ok(None) };
            next.url = address(&written, None)?.to_string();
        }
        "url" => {
            let Some(written) = answer_text(page.answer, &paginate.next) else { return Ok(None) };
            let base = (!paginate.base.is_empty()).then(|| answer_text(page.answer, &paginate.base)).flatten();
            let resolved = if base.is_some() && !written.contains("://") { address(&written, base)? } else { address(&written, None)? };
            next.url = resolved.to_string();
        }
        "cursor" | "lastId" => {
            let token = if paginate.style == "lastId" { page.items.last().and_then(|entry| answer_text(entry, &paginate.next)) } else { answer_text(page.answer, &paginate.next) };
            let Some(token) = token else { return Ok(None) };
            if paginate.place == "body" {
                if paginate.continue_path.is_empty() {
                    let mut body: Value = page.request.body_text.as_deref().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_else(|| json!({}));
                    crate::flows::value::set_path(&mut body, &paginate.param, Value::String(token));
                    next.body_text = Some(body.to_string());
                } else {
                    // The pages after the first are asked at their own endpoint, with the cursor alone.
                    let path = current.path().to_string();
                    let root = if path.ends_with(&paginate.continue_path) {
                        path[..path.len() - paginate.continue_path.len()].to_string()
                    } else if let Some(root) = path.strip_suffix(operation.path.as_str()) {
                        root.to_string()
                    } else {
                        return Err("The next page's address could not be worked out".into());
                    };
                    let mut continued = current.clone();
                    continued.set_path(&format!("{}{}", root.trim_end_matches('/'), paginate.continue_path));
                    continued.set_query(None);
                    next.url = continued.to_string();
                    let mut body = json!({});
                    crate::flows::value::set_path(&mut body, &paginate.param, Value::String(token));
                    next.body_text = Some(body.to_string());
                }
            } else {
                next.url = with_query(&current, &paginate.param, &token).to_string();
            }
        }
        "page" => {
            if page.items.is_empty() {
                return Ok(None);
            }
            let first = paginate.first.unwrap_or(1);
            let number = first + page.number as i64 + 1;
            let total = (!paginate.total.is_empty()).then(|| answer_at(page.answer, &paginate.total).and_then(Value::as_i64)).flatten();
            if total.is_some_and(|total| number > first + total - 1) {
                return Ok(None);
            }
            next.url = with_query(&current, &paginate.param, &number.to_string()).to_string();
        }
        "offset" => {
            if page.items.is_empty() {
                return Ok(None);
            }
            next.url = with_query(&current, &paginate.param, &page.read.to_string()).to_string();
        }
        other => return Err(format!("“{other}” is not a way of paging this build knows")),
    }
    Ok(Some(next))
}

/// One call outside a run — what the «Cambios en un servicio» trigger looks with. The credential is
/// already resolved (an OAuth sign-in as its access token).
pub(crate) async fn call_outside(call: &Value, credential: Option<Credential>) -> Result<Vec<Value>, String> {
    let (connector, operation) = chosen(call).map_err(|e| e.to_string())?;
    let values: Map<String, Value> = call.get("fields").and_then(Value::as_object).cloned().unwrap_or_default();
    let credential = if connector.auth == "none" { None } else { credential };
    // No run here to redact anything: the trigger's card shows this error as it is returned.
    let forms = secret_forms(credential.as_ref());
    let hide = |error: String| redact(&error, &forms);
    let (request, _) = request_for(connector, operation, values, credential.as_ref(), 30_000).map_err(|e| hide(e.to_string()))?;
    let response = crate::api::http::send(request.clone(), None, None).await.map_err(hide)?;
    let first = answer_items(connector, operation, response.status, &response.body_text).map_err(|e| hide(e.to_string()))?;
    match (operation.paginate.as_ref(), pages_wanted(call)) {
        (Some(paginate), Some(max)) => {
            let mut pager = Outside { forms: forms.clone() };
            every_page(&mut pager, connector, operation, paginate, request, response, first, max).await.map_err(|e| hide(e.to_string()))
        }
        _ => Ok(first),
    }
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
    // Where the request goes is part of what the credential is trusted with: a host written in a
    // field is held to what a host looks like before anything is built from it.
    for host in connector.host_fields() {
        let written = crate::flows::value::to_text(values.get(host.name()).unwrap_or(&Value::Null));
        if !written.trim().is_empty() && !host.accepts(&written) {
            let label = connector.fields_of(operation).into_iter().find(|f| f.name == host.name()).map_or(host.name().to_string(), |f| f.label.en.clone());
            return Err(NodeError::failed(format!("“{label}” is not a valid address for {} — write only the server, nothing around it", connector.name)));
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

    // A field written into the path as it is (no `encode`: it may hold slashes, a repository's file path) must not be able
    // to end the path or climb out of it — `?`, `#`, a backslash or a `..` segment in it are a different address.
    for field in connector.fields_of(operation).into_iter().filter(|f| !f.encode) {
        if !operation.path.contains(&format!("{{{{{}}}}}", field.name)) {
            continue;
        }
        if let Some(Value::String(raw)) = values.get(&field.name) {
            if raw.contains(['?', '#', '\\']) || raw.split('/').any(|segment| segment == "..") {
                return Err(NodeError::failed(format!("“{}” becomes part of the address, so it cannot contain ? # \\ or ..", field.name)));
            }
        }
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
    let query_template = Value::Object(query_template);
    let mut query = connectors::render(&query_template, &values, &json_fields).map_err(NodeError::Failed)?;
    if let Some(query) = query.as_mut() {
        unwrap_kept(&query_template, query, &values);
    }
    if let Some(Value::Object(query)) = query {
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
        Some(template) => {
            let mut rendered = connectors::render(template, &values, &json_fields).map_err(NodeError::Failed)?;
            if let Some(body) = rendered.as_mut() {
                unwrap_kept(template, body, &values);
            }
            rendered
        }
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
        options: NetworkOptions { timeout_ms, max_response_bytes: 64 * 1024 * 1024, guard_credentials: true, ..NetworkOptions::default() },
    };
    Ok((request, url))
}

/// What a lookup answers, signed with `credential`: the choices a field can take or — a connector's
/// `test` — who the credential signs in as. `values` are the node's fields, for the ones the lookup
/// `needs` (a team's states need the team). A failure is the service's own message, as a call's is.
pub(crate) async fn lookup(connector: &Connector, lookup: &Lookup, values: Map<String, Value>, credential: Option<&Credential>) -> Result<Vec<Choice>, String> {
    let operation = lookup_operation(connector, lookup);
    let forms = secret_forms(credential);
    let hide = |error: String| redact(&error, &forms);
    let (request, _) = request_for(connector, &operation, values, credential, 20_000).map_err(|e| hide(e.to_string()))?;
    let response = crate::api::http::send(request, None, None).await.map_err(hide)?;
    // The call's own checks — a 4xx, Slack's `ok: false`, a GraphQL `errors` — and then the list.
    answer_items(connector, &operation, response.status, &response.body_text).map_err(|e| hide(e.to_string()))?;
    Ok(lookup.choices(&parse_answer(&response.body_text)))
}

/// A lookup as the operation it is sent as: the fields it `needs`, required — the connector's own
/// definitions of them, so `encode` still applies and a missing one is named as the form names it.
fn lookup_operation(connector: &Connector, lookup: &Lookup) -> Operation {
    let named: Vec<&Field> = connector.operations.iter().flat_map(|op| op.fields.iter()).collect();
    let needs = lookup
        .needs
        .iter()
        .map(|name| {
            let mut field = named.iter().find(|field| field.name == *name).map(|field| (*field).clone()).unwrap_or_else(|| Field {
                name: name.clone(),
                label: connectors::Label { es: name.clone(), en: name.clone() },
                placeholder: String::new(),
                required: true,
                multiline: false,
                json: false,
                encode: false,
                default: String::new(),
                lookup: None,
            });
            field.required = true;
            field.lookup = None;
            field
        })
        .collect();
    lookup.operation(needs)
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
        let said = match found {
            Some(Value::Array(list)) => list.iter().map(message).collect::<Vec<_>>().join("; "),
            Some(other) => message(other),
            None => String::new(),
        };
        // The field that should hold the message can be there and empty (Jira's `errorMessages: []` beside the `errors`
        // that say what is wrong): then the answer itself is the message.
        if said.trim().is_empty() { body.chars().take(300).collect() } else { said }
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

    fn field_lookup(connector: &str, operation: &str, field: &str) -> (&'static Connector, Operation) {
        let (connector, op) = op(connector, operation);
        let lookup = connector.fields_of(op).into_iter().find(|f| f.name == field).and_then(|f| f.lookup.as_ref()).unwrap();
        (connector, lookup_operation(connector, lookup))
    }

    fn request(url: &str, body: Option<Value>) -> HttpSendRequest {
        HttpSendRequest {
            method: if body.is_some() { "POST".into() } else { "GET".into() },
            url: url.into(),
            headers: vec![("Authorization".into(), "Bearer t".into())],
            body_text: body.map(|b| b.to_string()),
            body_base64: None,
            body_file: None,
            form_data: None,
            urlencoded: None,
            auth: None,
            options: NetworkOptions::default(),
        }
    }

    fn paginate_of(connector: &str, operation: &str) -> (&'static Operation, connectors::Paginate) {
        let (_, op) = op(connector, operation);
        (op, op.paginate.clone().expect("this operation pages"))
    }

    fn next(connector: &str, operation: &str, request: &HttpSendRequest, headers: &[(&str, &str)], answer: Value, items: Vec<Value>, number: usize) -> Option<HttpSendRequest> {
        let (op, paginate) = paginate_of(connector, operation);
        let headers: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let read = items.len() * (number + 1);
        next_page(&paginate, op, &Page { request, headers: &headers, answer: &answer, items: &items, number, read }).unwrap()
    }

    #[test]
    fn a_link_header_names_the_next_page_and_an_empty_one_ends_the_list() {
        let first = request("https://api.github.com/repos/o/r/issues?state=open", None);
        let link = r#"<https://api.github.com/repositories/1/issues?state=open&page=2>; rel="next", <https://api.github.com/repositories/1/issues?state=open&page=5>; rel="last""#;
        let second = next("github", "listIssues", &first, &[("Link", link)], json!([{"id": 1}]), vec![json!({"id": 1})], 0).unwrap();
        assert_eq!(second.url, "https://api.github.com/repositories/1/issues?state=open&page=2");
        assert_eq!(second.headers, first.headers, "signed the same way");
        assert!(next("github", "listIssues", &first, &[("Link", r#"<https://api.github.com/x?page=1>; rel="prev""#)], json!([]), vec![], 0).is_none());
        // Sentry says the next page is empty rather than leaving it out.
        let sentry = request("https://sentry.io/api/0/projects/o/p/issues/", None);
        let empty = r#"<https://sentry.io/api/0/projects/o/p/issues/?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0""#;
        assert!(next("sentry", "listIssues", &sentry, &[("link", empty)], json!([]), vec![json!({})], 0).is_none());
        let more = empty.replace("results=\"false\"", "results=\"true\"");
        assert!(next("sentry", "listIssues", &sentry, &[("link", &more)], json!([]), vec![json!({})], 0).is_some());
    }

    #[test]
    fn a_next_page_on_another_server_is_not_followed() {
        let first = request("https://api.github.com/repos/o/r/issues", None);
        let (op, paginate) = paginate_of("github", "listIssues");
        let headers = vec![("Link".to_string(), r#"<https://collector.example/steal?page=2>; rel="next""#.to_string())];
        let refused = next_page(&paginate, op, &Page { request: &first, headers: &headers, answer: &json!([]), items: &[json!({})], number: 0, read: 1 });
        assert!(refused.unwrap_err().contains("another server"));
    }

    #[test]
    fn an_address_in_the_answer_is_read_against_its_base_or_the_request() {
        let bitbucket = request("https://api.bitbucket.org/2.0/repositories/w/r/pullrequests", None);
        let second = next("bitbucket", "listPullRequests", &bitbucket, &[], json!({"next": "https://api.bitbucket.org/2.0/repositories/w/r/pullrequests?page=2"}), vec![json!({})], 0).unwrap();
        assert!(second.url.ends_with("pullrequests?page=2"));
        assert!(next("bitbucket", "listPullRequests", &bitbucket, &[], json!({"values": []}), vec![], 0).is_none(), "no next: the last page");
        // Confluence: relative to its `_links.base` (the site's /wiki).
        let confluence = request("https://acme.atlassian.net/wiki/rest/api/content/search?cql=x", None);
        let answer = json!({"_links": {"base": "https://acme.atlassian.net/wiki", "next": "/rest/api/content/search?cql=x&start=25"}});
        let second = next("confluence", "searchPages", &confluence, &[], answer, vec![json!({})], 0).unwrap();
        assert_eq!(second.url, "https://acme.atlassian.net/wiki/rest/api/content/search?cql=x&start=25");
        // Graph's key has dots in it.
        let graph = request("https://graph.microsoft.com/v1.0/me/joinedTeams", None);
        let second = next("teamsgraph", "listTeams", &graph, &[], json!({"@odata.nextLink": "https://graph.microsoft.com/v1.0/me/joinedTeams?$skiptoken=X"}), vec![json!({})], 0).unwrap();
        assert!(second.url.contains("skiptoken=X"));
        // Twilio's is a path on its own server.
        let twilio = request("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json?PageSize=50", None);
        let second = next("twilio", "listMessages", &twilio, &[], json!({"next_page_uri": "/2010-04-01/Accounts/AC1/Messages.json?Page=1&PageToken=PA"}), vec![json!({})], 0).unwrap();
        assert_eq!(second.url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json?Page=1&PageToken=PA");
    }

    #[test]
    fn a_cursor_goes_back_in_the_query_or_in_the_body() {
        let slack = request("https://slack.com/api/conversations.list?limit=200&cursor=old", None);
        let second = next("slack", "listChannels", &slack, &[], json!({"response_metadata": {"next_cursor": "dXNlcjpV"}}), vec![json!({})], 0).unwrap();
        assert_eq!(second.url, "https://slack.com/api/conversations.list?limit=200&cursor=dXNlcjpV", "replaced, not added twice");
        assert!(next("slack", "listChannels", &slack, &[], json!({"response_metadata": {"next_cursor": ""}}), vec![json!({})], 0).is_none());
        // Notion: in the body, while `has_more`.
        let notion = request("https://api.notion.com/v1/databases/d/query", Some(json!({"filter": {"x": 1}})));
        let second = next("notion", "queryDatabase", &notion, &[], json!({"has_more": true, "next_cursor": "c2"}), vec![json!({})], 0).unwrap();
        assert_eq!(serde_json::from_str::<Value>(second.body_text.as_deref().unwrap()).unwrap(), json!({"filter": {"x": 1}, "start_cursor": "c2"}));
        assert!(next("notion", "queryDatabase", &notion, &[], json!({"has_more": false, "next_cursor": "c2"}), vec![json!({})], 0).is_none());
        // Linear: a GraphQL variable.
        let linear = request("https://api.linear.app/graphql", Some(json!({"query": "q", "variables": {"text": "bug"}})));
        let answer = json!({"data": {"issues": {"pageInfo": {"hasNextPage": true, "endCursor": "e1"}}}});
        let second = next("linear", "searchIssues", &linear, &[], answer, vec![json!({})], 0).unwrap();
        assert_eq!(serde_json::from_str::<Value>(second.body_text.as_deref().unwrap()).unwrap()["variables"], json!({"text": "bug", "after": "e1"}));
        // Jira ends with `isLast`.
        let jira = request("https://acme.atlassian.net/rest/api/3/search/jql?jql=x", None);
        assert!(next("jira", "search", &jira, &[], json!({"isLast": true, "nextPageToken": "n"}), vec![json!({})], 0).is_none());
        assert!(next("jira", "search", &jira, &[], json!({"isLast": false, "nextPageToken": "n"}), vec![json!({})], 0).unwrap().url.ends_with("nextPageToken=n"));
    }

    #[test]
    fn dropbox_asks_for_the_rest_at_its_own_endpoint() {
        let first = request("https://api.dropboxapi.com/2/files/list_folder", Some(json!({"path": "", "limit": 200})));
        let second = next("dropbox", "listFolder", &first, &[], json!({"has_more": true, "cursor": "AAA"}), vec![json!({})], 0).unwrap();
        assert_eq!(second.url, "https://api.dropboxapi.com/2/files/list_folder/continue");
        assert_eq!(second.body_text.as_deref(), Some(r#"{"cursor":"AAA"}"#));
        let third = next("dropbox", "listFolder", &second, &[], json!({"has_more": true, "cursor": "BBB"}), vec![json!({})], 1).unwrap();
        assert_eq!((third.url.as_str(), third.body_text.as_deref()), ("https://api.dropboxapi.com/2/files/list_folder/continue", Some(r#"{"cursor":"BBB"}"#)));
    }

    #[test]
    fn stripe_pages_after_its_last_entry_and_counters_count() {
        let stripe = request("https://api.stripe.com/v1/customers?limit=100", None);
        let second = next("stripe", "listCustomers", &stripe, &[], json!({"has_more": true}), vec![json!({"id": "cus_1"}), json!({"id": "cus_2"})], 0).unwrap();
        assert_eq!(second.url, "https://api.stripe.com/v1/customers?limit=100&starting_after=cus_2");
        // Cloudflare counts pages up to what it says the total is.
        let cloudflare = request("https://api.cloudflare.com/client/v4/zones", None);
        let second = next("cloudflare", "listZones", &cloudflare, &[], json!({"result_info": {"total_pages": 3}}), vec![json!({})], 0).unwrap();
        assert!(second.url.ends_with("zones?page=2"));
        assert!(next("cloudflare", "listZones", &second, &[], json!({"result_info": {"total_pages": 3}}), vec![json!({})], 1).unwrap().url.ends_with("page=3"));
        assert!(next("cloudflare", "listZones", &second, &[], json!({"result_info": {"total_pages": 3}}), vec![json!({})], 2).is_none());
        // ClickUp counts from 0 and says `last_page`.
        let clickup = request("https://api.clickup.com/api/v2/list/1/task", None);
        assert!(next("clickup", "listTasks", &clickup, &[], json!({"last_page": false}), vec![json!({})], 0).unwrap().url.ends_with("page=1"));
        assert!(next("clickup", "listTasks", &clickup, &[], json!({"last_page": true}), vec![json!({})], 0).is_none());
        // PagerDuty: an offset of what was read, while `more`.
        let pagerduty = request("https://api.pagerduty.com/incidents?limit=25", None);
        let second = next("pagerduty", "listIncidents", &pagerduty, &[], json!({"more": true}), vec![json!({}); 25], 0).unwrap();
        assert!(second.url.ends_with("offset=25"));
        assert!(next("pagerduty", "listIncidents", &pagerduty, &[], json!({"more": false}), vec![json!({}); 25], 0).is_none());
    }

    /// A loopback server answering `/items?page=N` with two entries a page and a `Link` to the next, up to page 3.
    async fn paged_server() -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 8192];
                    let n = socket.read(&mut buffer).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let page: usize = head.split("page=").nth(1).and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next()).and_then(|n| n.parse().ok()).unwrap_or(1);
                    let body = json!([{"id": page * 10 + 1}, {"id": page * 10 + 2}]).to_string();
                    let link = if page < 3 { format!("Link: <http://127.0.0.1:{port}/items?page={}>; rel=\"next\"\r\n", page + 1) } else { String::new() };
                    let answer = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{link}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = socket.write_all(answer.as_bytes()).await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn every_page_is_read_until_the_last_or_the_limit() {
        let port = paged_server().await;
        let (connector, operation) = op("github", "listIssues");
        let paginate = operation.paginate.clone().unwrap();
        let first = request(&format!("http://127.0.0.1:{port}/items?page=1"), None);
        let read = |max: usize| {
            let first = first.clone();
            let paginate = paginate.clone();
            async move {
                let response = crate::api::http::send(first.clone(), None, None).await.unwrap();
                let items = answer_items(connector, operation, response.status, &response.body_text).unwrap();
                let mut pager = Outside { forms: Vec::new() };
                every_page(&mut pager, connector, operation, &paginate, first, response, items, max).await.unwrap()
            }
        };
        let all: Vec<i64> = read(1_000).await.iter().map(|item| item["id"].as_i64().unwrap()).collect();
        assert_eq!(all, vec![11, 12, 21, 22, 31, 32], "three pages, in order");
        let some: Vec<i64> = read(3).await.iter().map(|item| item["id"].as_i64().unwrap()).collect();
        assert_eq!(some, vec![11, 12, 21], "stopped at the limit");
    }

    #[test]
    fn every_way_of_paging_a_connector_declares_is_one_this_build_reads() {
        for connector in connectors::all() {
            for operation in &connector.operations {
                let Some(paginate) = &operation.paginate else { continue };
                let place = format!("{}.{}", connector.id, operation.id);
                assert!(["link", "url", "cursor", "lastId", "page", "offset"].contains(&paginate.style.as_str()), "{place}: {}", paginate.style);
                if matches!(paginate.style.as_str(), "url" | "cursor" | "lastId") {
                    assert!(!paginate.next.is_empty(), "{place} says where the next page is");
                }
                if matches!(paginate.style.as_str(), "cursor" | "lastId" | "page" | "offset") {
                    assert!(!paginate.param.is_empty(), "{place} says how it is asked for");
                }
                assert!(paginate.place.is_empty() || paginate.place == "query" || paginate.place == "body", "{place}");
                // Asked again and again: only an operation that reads may (the same rule as the «changes» trigger's).
                let id = operation.id.to_ascii_lowercase();
                let reads = operation.method == "GET" || ["list", "search", "query", "get", "history"].iter().any(|p| id.starts_with(p));
                assert!(reads, "{place} pages, so it must only read");
            }
        }
    }

    #[test]
    fn the_node_asks_for_every_page_only_when_told_and_never_without_a_limit() {
        assert_eq!(pages_wanted(&json!({})), None);
        assert_eq!(pages_wanted(&json!({"allPages": false, "maxItems": 50})), None);
        assert_eq!(pages_wanted(&json!({"allPages": true})), Some(DEFAULT_MAX_ITEMS));
        assert_eq!(pages_wanted(&json!({"allPages": true, "maxItems": 250})), Some(250));
        assert_eq!(pages_wanted(&json!({"allPages": true, "maxItems": 10_000_000})), Some(MOST_ITEMS));
    }

    #[test]
    fn a_field_in_the_path_cannot_leave_it() {
        let (connector, operation) = op("github", "createIssue");
        let call = |repo: &str| {
            request_for(connector, operation, values(json!({"owner": "acme", "repo": repo, "title": "t"})), Some(&token("ghp_1", json!({}))), 20_000)
        };
        assert!(call("app").is_ok());
        for bad in ["../../orgs/acme", "app?x=1", "app#frag", "a\\b"] {
            let error = call(bad).map(|_| ()).unwrap_err().to_string();
            assert!(error.contains("cannot contain"), "{bad}: {error}");
        }
    }

    #[test]
    fn an_error_message_that_is_empty_falls_back_to_the_answer() {
        let (connector, operation) = op("jira", "createIssue");
        let body = r#"{"errorMessages":[],"errors":{"summary":"You must specify a summary of the issue."}}"#;
        let error = answer_items(connector, operation, 400, body).unwrap_err().to_string();
        assert!(error.contains("You must specify a summary"), "{error}");
    }

    #[test]
    fn lookups_are_sent_and_signed_the_way_calls_are() {
        // Linear: a GraphQL POST with the bare key in its header.
        let (connector, operation) = field_lookup("linear", "createIssue", "teamId");
        let (request, _) = request_for(connector, &operation, Map::new(), Some(&token("lin_api_1", json!({}))), 20_000).unwrap();
        assert_eq!((request.method.as_str(), request.url.as_str()), ("POST", "https://api.linear.app/graphql"));
        assert_eq!(header(&request, "Authorization"), Some("lin_api_1"));
        assert!(body(&request)["query"].as_str().unwrap().contains("teams"));

        // Trello: the key and token in the query, as every Trello call carries them.
        let (connector, operation) = field_lookup("trello", "createCard", "listId");
        let basic = Credential { kind: "basic".into(), meta: json!({"user": "k1"}), secret: "t1".into() };
        let (request, _) = request_for(connector, &operation, Map::new(), Some(&basic), 20_000).unwrap();
        let url = url::Url::parse(&request.url).unwrap();
        let query: Map<String, Value> = url.query_pairs().map(|(k, v)| (k.into_owned(), Value::String(v.into_owned()))).collect();
        assert_eq!(url.path(), "/1/members/me/boards");
        assert_eq!((query["key"].as_str(), query["token"].as_str(), query["lists"].as_str()), (Some("k1"), Some("t1"), Some("open")));

        // Jira: a project's issue types need the project — named, not a broken URL.
        let (connector, operation) = field_lookup("jira", "createIssue", "issueType");
        let jira = Credential { kind: "basic".into(), meta: json!({"user": "ana@example.com"}), secret: "t".into() };
        let error = request_for(connector, &operation, values(json!({"site": "acme"})), Some(&jira), 20_000).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("Project")), "{error:?}");
        let (request, _) = request_for(connector, &operation, values(json!({"site": "acme", "projectKey": "OPS"})), Some(&jira), 20_000).unwrap();
        assert_eq!(request.url, "https://acme.atlassian.net/rest/api/3/project/OPS");

        // Teams, signed in: a team's channels through Graph, with the account's token.
        let (connector, operation) = field_lookup("teamsgraph", "channelMessage", "channelId");
        let (request, _) = request_for(connector, &operation, values(json!({"teamId": "t-1"})), Some(&token("graph-token", json!({}))), 20_000).unwrap();
        assert_eq!(request.url, "https://graph.microsoft.com/v1.0/teams/t-1/channels");
        assert_eq!(header(&request, "Authorization"), Some("Bearer graph-token"));

        // A GitLab project is percent-encoded in a lookup's path as in a call's.
        let (connector, operation) = field_lookup("gitlab", "commentIssue", "iid");
        let (request, _) = request_for(connector, &operation, values(json!({"project": "grupo/web"})), Some(&token("glpat", json!({}))), 20_000).unwrap();
        assert!(request.url.starts_with("https://gitlab.com/api/v4/projects/grupo%2Fweb/issues?"), "{}", request.url);
    }

    #[test]
    fn a_host_field_cannot_carry_the_request_somewhere_else() {
        let jira = Credential { kind: "basic".into(), meta: json!({"user": "ana@example.com"}), secret: "t".into() };
        let (connector, operation) = op("jira", "createIssue");
        for hostile in ["evil.example/#", "evil.example/", "a.b", "acme?x", "acme@evil.example", "-acme", "acme:80"] {
            let error = request_for(connector, operation, values(json!({"site": hostile, "projectKey": "OPS", "summary": "x", "issueType": "Task"})), Some(&jira), 20_000).unwrap_err();
            assert!(matches!(error, NodeError::Failed(ref text) if text.contains("valid address")), "{hostile}: {error:?}");
        }
        let (request, _) = request_for(connector, operation, values(json!({"site": "acme-2", "projectKey": "OPS", "summary": "x", "issueType": "Task"})), Some(&jira), 20_000).unwrap();
        assert!(request.url.starts_with("https://acme-2.atlassian.net/"), "{}", request.url);

        // A whole host: a name or an address with a port, never a path or a login.
        let (gitlab, operation) = op("gitlab", "commentIssue");
        for hostile in ["evil.example/api", "user@evil.example", "evil.example#", "evil example"] {
            let error = request_for(gitlab, operation, values(json!({"host": hostile, "project": "g/r", "iid": "1", "body": "x"})), Some(&token("glpat", json!({}))), 20_000).unwrap_err();
            assert!(matches!(error, NodeError::Failed(ref text) if text.contains("valid address")), "{hostile}: {error:?}");
        }
        let (request, _) = request_for(gitlab, operation, values(json!({"host": "git.corp.example:8443", "project": "g/r", "iid": "1", "body": "x"})), Some(&token("glpat", json!({}))), 20_000).unwrap();
        assert!(request.url.starts_with("https://git.corp.example:8443/api/v4/"), "{}", request.url);

        // A whole address: http(s) only, no login in it.
        let (ntfy, operation) = op("ntfy", "publish");
        let error = request_for(ntfy, operation, values(json!({"server": "https://user:pw@evil.example", "topic": "t", "message": "m"})), None, 20_000).unwrap_err();
        assert!(matches!(error, NodeError::Failed(ref text) if text.contains("valid address")), "{error:?}");
    }

    #[test]
    fn a_test_says_who_the_credential_is() {
        let connector = connectors::find("telegram").unwrap();
        let operation = lookup_operation(connector, connector.test.as_ref().unwrap());
        let (request, _) = request_for(connector, &operation, Map::new(), Some(&token("123:ABC", json!({}))), 20_000).unwrap();
        assert_eq!(request.url, "https://api.telegram.org/bot123:ABC/getMe");
        let answer = r#"{"ok": true, "result": {"id": 1, "is_bot": true, "username": "avisos_bot"}}"#;
        answer_items(connector, &operation, 200, answer).unwrap();
        assert_eq!(connector.test.as_ref().unwrap().choices(&parse_answer(answer))[0].label, "@avisos_bot");
        // The service's own refusal is the error, as a call's would be.
        let refused = answer_items(connector, &operation, 401, r#"{"ok": false, "description": "Unauthorized"}"#).unwrap_err();
        assert!(matches!(refused, NodeError::Failed(ref text) if text.contains("Unauthorized")), "{refused:?}");
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
    fn dropbox_lists_its_root_as_an_empty_path() {
        let (connector, operation) = op("dropbox", "listFolder");
        let sl = token("sl.u.token", json!({}));
        let (request, _) = request_for(connector, operation, values(json!({"path": "", "recursive": ""})), Some(&sl), 30_000).unwrap();
        assert_eq!(body(&request), json!({"path": "", "limit": 200}), "the root is `\"path\": \"\"`, not a missing key");
        let (request, _) = request_for(connector, operation, Map::new(), Some(&sl), 30_000).unwrap();
        assert_eq!(body(&request), json!({"path": "", "limit": 200}));
        let (request, _) = request_for(connector, operation, values(json!({"path": "/Facturas", "recursive": "true"})), Some(&sl), 30_000).unwrap();
        assert_eq!(body(&request), json!({"path": "/Facturas", "recursive": true, "limit": 200}));
        // Everywhere else an empty optional still leaves its key out.
        let (connector, operation) = op("slack", "postMessage");
        let (request, _) = request_for(connector, operation, values(json!({"channel": "#v", "text": "x", "thread_ts": ""})), Some(&token("xoxb-1", json!({}))), 30_000).unwrap();
        assert_eq!(body(&request), json!({"channel": "#v", "text": "x"}));
    }

    #[test]
    fn a_credential_never_reads_in_an_error_or_a_log_line() {
        // Telegram: the token is a segment of every URL it calls.
        let forms = secret_forms(Some(&token("123456:AAH-secret_tok", json!({}))));
        let error = "POST https://api.telegram.org/bot123456:AAH-secret_tok/sendMessage timed out after 30000 ms with no response";
        assert_eq!(redact(error, &forms), "POST https://api.telegram.org/bot••••••/sendMessage timed out after 30000 ms with no response");
        assert_eq!(hidden(NodeError::failed(error), &forms), NodeError::Failed(redact(error, &forms)));
        assert_eq!(hidden(NodeError::Cancelled, &forms), NodeError::Cancelled);
        // Trello: key and token in the query, escaped the way the URL writes them; the key is no secret.
        let (connector, operation) = op("trello", "createCard");
        let credential = basic("key-1", "t0k en/+=");
        let (request, _) = request_for(connector, operation, values(json!({"listId": "L1", "name": "x"})), Some(&credential), 30_000).unwrap();
        let shown = redact(&format!("POST {} could not connect", request.url), &secret_forms(Some(&credential)));
        assert!(!shown.contains("t0k"), "{shown}");
        assert!(shown.contains("key=key-1"), "{shown}");
        // Basic auth: the encoded pair is as much the password as the password.
        let pair = base64::engine::general_purpose::STANDARD.encode("ana@example.com:pw-1234");
        let shown = redact(&format!("echoed Authorization: Basic {pair}"), &secret_forms(Some(&basic("ana@example.com", "pw-1234"))));
        assert_eq!(shown, "echoed Authorization: Basic ••••••");
        // Three letters would take ordinary words out of every message.
        assert_eq!(redact("a bad request", &secret_forms(Some(&token("bad", json!({}))))), "a bad request");
    }

    /// Outside a run — a trigger looking, a field's lookup — nothing else redacts the error.
    #[tokio::test]
    async fn a_failed_call_outside_a_run_does_not_show_its_webhook() {
        // A port nothing listens on: the send fails, and the transport error names the URL.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let hook = webhook(&format!("http://127.0.0.1:{port}/api/webhooks/1/s3cr3t-hook-token"));
        let error = call_outside(&json!({"connector": "discord", "operation": "webhookMessage", "fields": {"content": "x"}}), Some(hook)).await.unwrap_err();
        assert!(!error.contains("s3cr3t-hook-token") && error.contains(HIDDEN), "{error}");
    }

    #[test]
    fn every_shipped_connector_reads_and_fits_a_credential_kind() {
        for connector in connectors::CONNECTORS.iter() {
            assert!(!connector.operations.is_empty(), "{} has no operations", connector.id);
            assert!(!connector.credential_kinds().is_empty() || connector.auth == "none", "{} signs in with nothing it knows", connector.id);
        }
        assert_eq!(connectors::CONNECTORS.len(), 34);
    }
}
