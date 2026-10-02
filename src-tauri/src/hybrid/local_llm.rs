//! One client for whatever runs the local model — the executor's "mini-LiteLLM".
//!
//! Three backends, one request shape:
//!
//! * **Bundled** — the second `llama-server` this app ships (see [`crate::localai::executor`]),
//!   spoken to through its OpenAI-compatible chat endpoint. Nothing to install.
//! * **Ollama**, through its **native** API. Not through `/v1`: Ollama's OpenAI-compatible endpoint
//!   has no way to set the context, so a prompt longer than the server's default window is cut —
//!   silently — and the model answers the stub. Measured on Ollama 0.35.0: 6,982 tokens arrived as
//!   2,050 and the answer named a value that was not in the file. `/api/chat` with
//!   `options.num_ctx` processed all of them and answered correctly.
//! * **OpenAI-compatible** — LM Studio, llama.cpp's own server, vLLM, LocalAI, or a LiteLLM proxy
//!   in front of anything. The context there is the server's; [`model_details`] reads it where the
//!   server publishes it.
//!
//! Whatever the backend, every answer goes through [`super::budget::truncated`]: a server that
//! reports far fewer prompt tokens than were sent cut the prompt, and an answer to a cut prompt is
//! not an answer.

use std::future::Future;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::api::stream::{SseParser, Utf8Stream};

/// Which kind of server the executor talks to.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    Bundled,
    Ollama,
    Openai,
}

impl BackendKind {
    pub fn from_setting(raw: &str) -> Option<Self> {
        match raw.trim() {
            "bundled" => Some(Self::Bundled),
            "ollama" => Some(Self::Ollama),
            "openai" => Some(Self::Openai),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bundled => "bundled",
            Self::Ollama => "ollama",
            Self::Openai => "openai",
        }
    }

    /// Where each server listens out of the box. LM Studio's port for the OpenAI-compatible one,
    /// because that is the one people have running without having configured anything.
    pub fn default_url(self) -> &'static str {
        match self {
            Self::Bundled => "",
            Self::Ollama => "http://127.0.0.1:11434",
            Self::Openai => "http://127.0.0.1:1234",
        }
    }
}

/// Where a request goes.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub kind: BackendKind,
    /// Without a trailing slash and without a trailing `/v1` — see [`normalize_url`].
    pub base_url: String,
    /// Bearer token for an OpenAI-compatible server that wants one (a LiteLLM proxy with a master
    /// key, a vLLM started with `--api-key`). Read from the keychain, never stored in a row.
    pub api_key: Option<String>,
}

impl Endpoint {
    pub fn new(kind: BackendKind, url: &str, api_key: Option<String>) -> Self {
        Self { kind, base_url: normalize_url(url), api_key }
    }
}

/// `http://localhost:1234/v1/` → `http://localhost:1234`. People paste the URL their server's docs
/// show, which for OpenAI-compatible servers usually ends in `/v1`; the paths below add it back.
pub fn normalize_url(raw: &str) -> String {
    let mut url = raw.trim().trim_end_matches('/').to_string();
    if url.ends_with("/v1") {
        url.truncate(url.len() - 3);
    }
    url.trim_end_matches('/').to_string()
}

/// Whether `url` points at this machine.
///
/// Decides two things: whether the request may bypass a configured HTTP proxy (it must, for
/// loopback — a corporate proxy would otherwise see every line of the user's source on its way to
/// 127.0.0.1), and whether the settings pane warns that code is leaving the machine.
pub fn is_loopback(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(name)) => {
            let name = name.to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        None => false,
    }
}

fn client_for(url: &str) -> &'static reqwest::Client {
    static LOOPBACK: OnceLock<reqwest::Client> = OnceLock::new();
    static REMOTE: OnceLock<reqwest::Client> = OnceLock::new();
    if is_loopback(url) {
        LOOPBACK.get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .build()
                .unwrap_or_default()
        })
    } else {
        REMOTE.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default()
        })
    }
}

fn with_auth(request: reqwest::RequestBuilder, endpoint: &Endpoint) -> reqwest::RequestBuilder {
    match endpoint.api_key.as_deref().filter(|key| !key.trim().is_empty()) {
        Some(key) => request.bearer_auth(key.trim()),
        None => request,
    }
}

/// What went wrong talking to the local model, in the terms the executor acts on.
#[derive(Clone, Debug, PartialEq)]
pub enum LocalError {
    /// Nothing answered at all — the server is not running, or the URL is wrong. The one failure
    /// that pauses a run instead of spending an attempt: retrying cannot fix it, starting the
    /// server can.
    Unreachable(String),
    /// The server answered with an error of its own: an unknown model, a context it refused.
    Server { status: u16, message: String },
    /// The user pressed Stop.
    Cancelled,
    /// Connected, then went silent past the stall limit.
    Stalled(String),
    /// The server answered in a shape this client does not read.
    Malformed(String),
}

impl LocalError {
    pub fn sentence(&self) -> String {
        match self {
            Self::Unreachable(detail) => format!("The local model server isn't answering ({detail})."),
            Self::Server { status, message } => format!("The local model server refused the request ({status}): {message}"),
            Self::Cancelled => "Stopped.".to_string(),
            Self::Stalled(detail) => format!("The local model stopped responding ({detail})."),
            Self::Malformed(detail) => format!("The local model server answered in an unexpected format: {detail}"),
        }
    }

    /// The kind, for the UI to say in the reader's language; `sentence` is the English detail.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreachable(_) => "unreachable",
            Self::Server { .. } => "refused",
            Self::Cancelled => "cancelled",
            Self::Stalled(_) => "stalled",
            Self::Malformed(_) => "malformed",
        }
    }

    pub fn is_unreachable(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }
}

fn transport_error(error: reqwest::Error) -> LocalError {
    if error.is_connect() || error.is_timeout() && !error.is_body() {
        LocalError::Unreachable(error.to_string())
    } else if error.is_timeout() {
        LocalError::Stalled(error.to_string())
    } else {
        LocalError::Unreachable(error.to_string())
    }
}

async fn error_body(response: reqwest::Response) -> LocalError {
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|body| {
            body.get("error")
                .and_then(|error| error.get("message").and_then(Value::as_str).or_else(|| error.as_str()))
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.chars().take(300).collect());
    LocalError::Server { status, message }
}

// ------------------------------------------------------------------ discovery

/// Whether a server answers at `endpoint`, and its version when it says one.
pub async fn ping(endpoint: &Endpoint) -> Result<Option<String>, LocalError> {
    let client = client_for(&endpoint.base_url);
    match endpoint.kind {
        BackendKind::Ollama => {
            let url = format!("{}/api/version", endpoint.base_url);
            let response = client.get(&url).timeout(Duration::from_secs(2)).send().await.map_err(transport_error)?;
            if !response.status().is_success() {
                return Err(error_body(response).await);
            }
            let body: Value = response.json().await.map_err(|e| LocalError::Malformed(e.to_string()))?;
            Ok(body.get("version").and_then(Value::as_str).map(str::to_string))
        }
        BackendKind::Openai | BackendKind::Bundled => {
            let url = format!("{}/v1/models", endpoint.base_url);
            let response = with_auth(client.get(&url), endpoint)
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .map_err(transport_error)?;
            if !response.status().is_success() {
                return Err(error_body(response).await);
            }
            Ok(None)
        }
    }
}

/// One model a server offers.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct LocalModel {
    /// Exactly what goes in the request's `model` field.
    pub id: String,
    pub size_bytes: Option<u64>,
    /// As the server spells it, e.g. "7.6B".
    pub params: Option<String>,
    /// e.g. "Q4_K_M".
    pub quant: Option<String>,
}

/// The models `endpoint` offers. Not for [`BackendKind::Bundled`], whose list is the catalogue.
pub async fn list_models(endpoint: &Endpoint) -> Result<Vec<LocalModel>, LocalError> {
    let client = client_for(&endpoint.base_url);
    let url = match endpoint.kind {
        BackendKind::Ollama => format!("{}/api/tags", endpoint.base_url),
        _ => format!("{}/v1/models", endpoint.base_url),
    };
    let response = with_auth(client.get(&url), endpoint)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(transport_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let body: Value = response.json().await.map_err(|e| LocalError::Malformed(e.to_string()))?;
    Ok(parse_model_list(&body))
}

/// Reads both listing shapes: Ollama's `{models:[{name, size, details}]}` and OpenAI's
/// `{data:[{id}]}`. Anything else is an empty list rather than an error — the pane then says the
/// server lists no models, which is the actionable reading.
pub fn parse_model_list(body: &Value) -> Vec<LocalModel> {
    if let Some(models) = body.get("models").and_then(Value::as_array) {
        return models
            .iter()
            .filter_map(|model| {
                let id = model.get("name").or_else(|| model.get("model")).and_then(Value::as_str)?;
                let details = model.get("details");
                Some(LocalModel {
                    id: id.to_string(),
                    size_bytes: model.get("size").and_then(Value::as_u64),
                    params: details.and_then(|d| d.get("parameter_size")).and_then(Value::as_str).map(str::to_string),
                    quant: details.and_then(|d| d.get("quantization_level")).and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect();
    }
    if let Some(data) = body.get("data").and_then(Value::as_array) {
        return data
            .iter()
            .filter_map(|model| model.get("id").and_then(Value::as_str))
            .map(|id| LocalModel { id: id.to_string(), ..Default::default() })
            .collect();
    }
    Vec::new()
}

/// What a model's own metadata says about its size, its window and its memory appetite.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct ModelDetails {
    /// The context it was trained for (Ollama, llama-server, vLLM, LM Studio each publish it in a
    /// different place) — or the context the server was *started* with, which on a server whose
    /// window this app cannot set is the number that matters.
    pub max_ctx: Option<u32>,
    /// `true` when `max_ctx` is the server's loaded window rather than the model's ceiling. The
    /// settings pane then offers nothing above it.
    pub ctx_fixed_by_server: bool,
    pub kv_bytes_per_token: Option<u64>,
    pub params_b: Option<f32>,
    pub size_bytes: Option<u64>,
    /// The model has a thinking phase that can be switched off (Ollama's `thinking` capability).
    pub thinking: bool,
}

/// Reads [`ModelDetails`] for `model`. Never fails: missing metadata is `None` fields, and the
/// caller falls back to asking the user.
pub async fn model_details(endpoint: &Endpoint, model: &str) -> ModelDetails {
    let client = client_for(&endpoint.base_url);
    match endpoint.kind {
        BackendKind::Ollama => {
            let url = format!("{}/api/show", endpoint.base_url);
            let Ok(response) = client.post(&url).json(&json!({ "model": model })).timeout(Duration::from_secs(5)).send().await else {
                return ModelDetails::default();
            };
            let Ok(body) = response.json::<Value>().await else { return ModelDetails::default() };
            parse_ollama_show(&body)
        }
        BackendKind::Openai | BackendKind::Bundled => {
            // llama.cpp's server: the window it was started with.
            if let Ok(response) = with_auth(client.get(format!("{}/props", endpoint.base_url)), endpoint)
                .timeout(Duration::from_secs(3))
                .send()
                .await
            {
                if response.status().is_success() {
                    if let Ok(body) = response.json::<Value>().await {
                        let n_ctx = body
                            .pointer("/default_generation_settings/n_ctx")
                            .or_else(|| body.get("n_ctx"))
                            .and_then(Value::as_u64);
                        if let Some(n_ctx) = n_ctx {
                            return ModelDetails { max_ctx: Some(n_ctx as u32), ctx_fixed_by_server: true, ..Default::default() };
                        }
                    }
                }
            }
            // LM Studio's own REST API lists what each model was loaded with.
            if let Ok(response) = with_auth(client.get(format!("{}/api/v0/models", endpoint.base_url)), endpoint)
                .timeout(Duration::from_secs(3))
                .send()
                .await
            {
                if response.status().is_success() {
                    if let Ok(body) = response.json::<Value>().await {
                        if let Some(details) = lmstudio_details(&body, model) {
                            return details;
                        }
                    }
                }
            }
            // vLLM puts the window on the model listing itself.
            if let Ok(response) = with_auth(client.get(format!("{}/v1/models", endpoint.base_url)), endpoint)
                .timeout(Duration::from_secs(3))
                .send()
                .await
            {
                if let Ok(body) = response.json::<Value>().await {
                    let window = body
                        .get("data")
                        .and_then(Value::as_array)
                        .and_then(|data| data.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(model)))
                        .and_then(|m| m.get("max_model_len"))
                        .and_then(Value::as_u64);
                    if let Some(window) = window {
                        return ModelDetails { max_ctx: Some(window as u32), ctx_fixed_by_server: true, ..Default::default() };
                    }
                }
            }
            ModelDetails::default()
        }
    }
}

fn lmstudio_details(body: &Value, model: &str) -> Option<ModelDetails> {
    let entry = body.get("data")?.as_array()?.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(model))?;
    let loaded = entry.get("loaded_context_length").and_then(Value::as_u64);
    let max = entry.get("max_context_length").and_then(Value::as_u64);
    Some(ModelDetails {
        max_ctx: loaded.or(max).map(|n| n as u32),
        ctx_fixed_by_server: loaded.is_some(),
        ..Default::default()
    })
}

/// Reads Ollama's `/api/show`: the trained context and the architecture behind the KV cache.
///
/// The keys are prefixed with the architecture (`qwen2.context_length`, `qwen3moe.block_count`),
/// so they are found by suffix. `attention.key_length` is the head size where the architecture
/// states it; otherwise it is the embedding width over the head count.
pub fn parse_ollama_show(body: &Value) -> ModelDetails {
    let info = body.get("model_info").and_then(Value::as_object);
    let find = |suffix: &str| -> Option<&Value> {
        info?.iter().find(|(key, _)| key.ends_with(suffix)).map(|(_, value)| value)
    };
    let number = |value: Option<&Value>| -> Option<u64> {
        match value? {
            Value::Number(n) => n.as_u64(),
            // Some architectures give a per-layer array; the largest entry bounds the cache.
            Value::Array(items) => items.iter().filter_map(Value::as_u64).max(),
            _ => None,
        }
    };
    let max_ctx = number(find(".context_length")).map(|n| n as u32);
    let layers = number(find(".block_count"));
    let kv_heads = number(find(".attention.head_count_kv"));
    let heads = number(find(".attention.head_count"));
    let width = number(find(".embedding_length"));
    let head_dim = number(find(".attention.key_length")).or_else(|| match (width, heads) {
        (Some(width), Some(heads)) if heads > 0 => Some(width / heads),
        _ => None,
    });
    let kv_bytes_per_token = match (layers, kv_heads, head_dim) {
        (Some(layers), Some(kv_heads), Some(head_dim)) => Some(2 * layers * kv_heads * head_dim * 2),
        _ => None,
    };
    let params_b = body
        .pointer("/details/parameter_size")
        .and_then(Value::as_str)
        .and_then(parse_params_b);
    let thinking = body
        .get("capabilities")
        .and_then(Value::as_array)
        .is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some("thinking")));
    ModelDetails { max_ctx, ctx_fixed_by_server: false, kv_bytes_per_token, params_b, size_bytes: None, thinking }
}

/// "7.6B" → 7.6, "494.03M" → 0.494.
pub fn parse_params_b(raw: &str) -> Option<f32> {
    let raw = raw.trim();
    let (number, scale) = if let Some(n) = raw.strip_suffix(['B', 'b']) {
        (n, 1.0)
    } else if let Some(n) = raw.strip_suffix(['M', 'm']) {
        (n, 0.001)
    } else {
        (raw, 1.0)
    };
    number.trim().parse::<f32>().ok().map(|n| n * scale)
}

/// How much of each loaded Ollama model sits in GPU memory: `(model, size, size_vram)`.
///
/// Read after a request, so the model is loaded. A model that does not fit is split between GPU
/// and CPU, and that split — not the model's size — is what makes it slow; this is the one place
/// any backend reports it, and it is vendor-neutral (Metal, CUDA, ROCm, Vulkan alike).
pub async fn ollama_residency(endpoint: &Endpoint) -> Vec<(String, u64, u64)> {
    if endpoint.kind != BackendKind::Ollama {
        return Vec::new();
    }
    let client = client_for(&endpoint.base_url);
    let Ok(response) = client.get(format!("{}/api/ps", endpoint.base_url)).timeout(Duration::from_secs(3)).send().await else {
        return Vec::new();
    };
    let Ok(body) = response.json::<Value>().await else { return Vec::new() };
    body.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let name = m.get("name").or_else(|| m.get("model"))?.as_str()?.to_string();
                    Some((name, m.get("size")?.as_u64()?, m.get("size_vram").and_then(Value::as_u64).unwrap_or(0)))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Asks Ollama to drop `model` from memory now (`keep_alive: 0`). Best effort.
pub async fn ollama_unload(endpoint: &Endpoint, model: &str) {
    if endpoint.kind != BackendKind::Ollama {
        return;
    }
    let client = client_for(&endpoint.base_url);
    let _ = client
        .post(format!("{}/api/generate", endpoint.base_url))
        .json(&json!({ "model": model, "keep_alive": 0 }))
        .timeout(Duration::from_secs(10))
        .send()
        .await;
}

/// Where an Ollama pull is: the status line it last sent, and the bytes summed over every layer it
/// has reported so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

/// Reads one line of `/api/pull`'s stream into the running totals. `Ok(None)` for a line with
/// nothing to say; an `error` line is the pull failing.
pub fn pull_line(line: &str, layers: &mut std::collections::BTreeMap<String, (u64, u64)>) -> Result<Option<PullProgress>, LocalError> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(line).map_err(|e| LocalError::Malformed(format!("{e}: {line}")))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(LocalError::Server { status: 0, message: error.to_string() });
    }
    let status = value.get("status").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(digest) = value.get("digest").and_then(Value::as_str) {
        let total = value.get("total").and_then(Value::as_u64).unwrap_or(0);
        let completed = value.get("completed").and_then(Value::as_u64).unwrap_or(0);
        let entry = layers.entry(digest.to_string()).or_insert((0, 0));
        entry.0 = entry.0.max(completed);
        entry.1 = entry.1.max(total);
    }
    let (completed, total) = layers.values().fold((0, 0), |(c, t), (lc, lt)| (c + lc, t + lt));
    Ok(Some(PullProgress { status, completed, total }))
}

/// Downloads `model` into Ollama (`/api/pull`), reporting progress as it streams. Ollama keeps what
/// it has already fetched, so a pull that is stopped picks up where it was the next time.
pub async fn ollama_pull(
    endpoint: &Endpoint,
    model: &str,
    mut on_progress: impl FnMut(PullProgress),
    cancel: impl std::future::Future<Output = ()>,
) -> Result<(), LocalError> {
    let client = client_for(&endpoint.base_url);
    let builder = client.post(format!("{}/api/pull", endpoint.base_url)).json(&json!({ "model": model, "stream": true }));
    tokio::pin!(cancel);
    let mut response = tokio::select! {
        biased;
        _ = &mut cancel => return Err(LocalError::Cancelled),
        sent = builder.send() => sent.map_err(transport_error)?,
    };
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let mut utf8 = Utf8Stream::default();
    let mut pending = String::new();
    let mut layers = std::collections::BTreeMap::new();
    loop {
        // A manifest pull can be silent for a while between layers, so the limit is generous —
        // what it guards against is a server that died with the connection open.
        let chunk = tokio::select! {
            biased;
            _ = &mut cancel => return Err(LocalError::Cancelled),
            next = tokio::time::timeout(Duration::from_secs(300), response.chunk()) => match next {
                Err(_) => return Err(LocalError::Stalled("nothing for 300 s".to_string())),
                Ok(Err(error)) => return Err(transport_error(error)),
                Ok(Ok(None)) => break,
                Ok(Ok(Some(bytes))) => bytes,
            },
        };
        pending.push_str(&utf8.push(&chunk));
        while let Some(at) = pending.find('\n') {
            let line: String = pending.drain(..=at).collect();
            if let Some(progress) = pull_line(&line, &mut layers)? {
                let finished = progress.status == "success";
                on_progress(progress);
                if finished {
                    return Ok(());
                }
            }
        }
    }
    match pull_line(&pending, &mut layers)? {
        Some(progress) if progress.status == "success" => Ok(()),
        _ => Err(LocalError::Malformed("the pull ended without saying it succeeded".to_string())),
    }
}

/// Removes `model` from Ollama (`DELETE /api/delete`).
pub async fn ollama_delete(endpoint: &Endpoint, model: &str) -> Result<(), LocalError> {
    let client = client_for(&endpoint.base_url);
    let response = client
        .delete(format!("{}/api/delete", endpoint.base_url))
        .json(&json!({ "model": model }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(transport_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    Ok(())
}

/// Exact token count from a llama.cpp server's `/tokenize`, or `None` when it does not have one.
pub async fn count_tokens(endpoint: &Endpoint, text: &str) -> Option<u64> {
    if endpoint.kind == BackendKind::Ollama {
        return None;
    }
    let client = client_for(&endpoint.base_url);
    let response = with_auth(client.post(format!("{}/tokenize", endpoint.base_url)), endpoint)
        .json(&json!({ "content": text }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    body.get("tokens").and_then(Value::as_array).map(|tokens| tokens.len() as u64)
}

// ------------------------------------------------------------------ chat

/// One stateless request. There is no history parameter on purpose: every executor task is a fresh
/// conversation, which is what keeps a small model's window from filling up over a run.
pub struct ChatRequest<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
    /// Ollama only: the window to load the model with. Always set by the executor — leaving it to
    /// the server is exactly the silent-truncation case this module exists to avoid.
    pub num_ctx: Option<u32>,
    pub max_tokens: u32,
    pub temperature: f32,
    /// Ollama only, and only for a model with a thinking phase: `Some(false)` switches it off.
    /// `None` sends nothing, which is what a model without one needs.
    pub think: Option<bool>,
    /// Ollama only: how long the model stays loaded after this request.
    pub keep_alive: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Finish {
    /// The model ended its answer.
    Stop,
    /// It ran into the output limit — the answer is cut.
    Length,
    /// The stream ended without saying why.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ChatOutcome {
    pub text: String,
    /// As counted by the server. `None` when it reports nothing (rare: the executor asks for usage).
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub finish: Finish,
    /// Prompt evaluation time, when the server reports it (Ollama, llama.cpp).
    pub prompt_ms: Option<u64>,
    /// Generation time, when the server reports it.
    pub gen_ms: Option<u64>,
    /// Wall time of the whole request.
    pub total_ms: u64,
    /// Wall time until the first answer token — the prompt-evaluation stand-in when the server
    /// does not report its own timings.
    pub first_token_ms: Option<u64>,
}

/// How long a request may wait for its first token. Prompt evaluation sends nothing, and a long
/// prompt on a CPU-only machine can legitimately take minutes; the user's Stop is the real limit.
const FIRST_TOKEN_LIMIT: Duration = Duration::from_secs(15 * 60);
/// How long a stream may go quiet once tokens are flowing.
const BETWEEN_TOKENS_LIMIT: Duration = Duration::from_secs(120);

/// Streams one answer. `on_text` gets each piece of answer text as it arrives (thinking text is
/// not answer text and never reaches it); `cancel` resolving stops the request — dropping the
/// connection is what makes llama.cpp and Ollama stop generating.
pub async fn chat<F, C>(endpoint: &Endpoint, request: &ChatRequest<'_>, mut on_text: F, cancel: C) -> Result<ChatOutcome, LocalError>
where
    F: FnMut(&str),
    C: Future<Output = ()>,
{
    let started = Instant::now();
    let client = client_for(&endpoint.base_url);
    let messages = json!([
        { "role": "system", "content": request.system },
        { "role": "user", "content": request.user },
    ]);
    let builder = match endpoint.kind {
        BackendKind::Ollama => {
            let mut options = json!({ "num_predict": request.max_tokens, "temperature": request.temperature });
            if let Some(num_ctx) = request.num_ctx {
                options["num_ctx"] = json!(num_ctx);
            }
            let mut body = json!({ "model": request.model, "messages": messages, "stream": true, "options": options });
            if let Some(think) = request.think {
                body["think"] = json!(think);
            }
            if let Some(keep_alive) = request.keep_alive {
                body["keep_alive"] = json!(keep_alive);
            }
            client.post(format!("{}/api/chat", endpoint.base_url)).json(&body)
        }
        BackendKind::Openai | BackendKind::Bundled => {
            let body = json!({
                "model": request.model,
                "messages": messages,
                "stream": true,
                "stream_options": { "include_usage": true },
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
            });
            with_auth(client.post(format!("{}/v1/chat/completions", endpoint.base_url)), endpoint).json(&body)
        }
    };

    tokio::pin!(cancel);
    let mut response = tokio::select! {
        biased;
        _ = &mut cancel => return Err(LocalError::Cancelled),
        sent = builder.send() => sent.map_err(transport_error)?,
    };
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }

    let mut reader = StreamReader::new(endpoint.kind);
    let mut first_token: Option<Duration> = None;
    loop {
        let limit = if first_token.is_some() { BETWEEN_TOKENS_LIMIT } else { FIRST_TOKEN_LIMIT };
        let chunk = tokio::select! {
            biased;
            _ = &mut cancel => return Err(LocalError::Cancelled),
            next = tokio::time::timeout(limit, response.chunk()) => match next {
                Err(_) => return Err(LocalError::Stalled(format!("nothing for {} s", limit.as_secs()))),
                Ok(Err(error)) => return Err(transport_error(error)),
                Ok(Ok(None)) => break,
                Ok(Ok(Some(bytes))) => bytes,
            },
        };
        for piece in reader.feed(&chunk)? {
            if first_token.is_none() {
                first_token = Some(started.elapsed());
            }
            on_text(&piece);
        }
        if reader.done {
            break;
        }
    }
    let mut outcome = reader.finish();
    outcome.total_ms = started.elapsed().as_millis() as u64;
    outcome.first_token_ms = first_token.map(|d| d.as_millis() as u64);
    Ok(outcome)
}

/// Turns the response body, as it arrives, into answer text and final counts. Separate from
/// [`chat`] so both wire formats can be tested without a server.
pub struct StreamReader {
    kind: BackendKind,
    utf8: Utf8Stream,
    line: String,
    sse: SseParser,
    text: String,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    prompt_ms: Option<u64>,
    gen_ms: Option<u64>,
    finish: Finish,
    pub done: bool,
}

impl StreamReader {
    pub fn new(kind: BackendKind) -> Self {
        Self {
            kind,
            utf8: Utf8Stream::default(),
            line: String::new(),
            sse: SseParser::default(),
            text: String::new(),
            prompt_tokens: None,
            completion_tokens: None,
            prompt_ms: None,
            gen_ms: None,
            finish: Finish::Unknown,
            done: false,
        }
    }

    /// Feeds raw bytes; returns the answer text they completed.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, LocalError> {
        let text = self.utf8.push(bytes);
        let mut pieces = Vec::new();
        match self.kind {
            BackendKind::Ollama => {
                self.line.push_str(&text);
                while let Some(at) = self.line.find('\n') {
                    let line: String = self.line.drain(..=at).collect();
                    if let Some(piece) = self.ollama_line(line.trim())? {
                        pieces.push(piece);
                    }
                }
            }
            BackendKind::Openai | BackendKind::Bundled => {
                for event in self.sse.push(&text) {
                    if let Some(piece) = self.openai_event(&event.data)? {
                        pieces.push(piece);
                    }
                }
            }
        }
        Ok(pieces)
    }

    fn ollama_line(&mut self, line: &str) -> Result<Option<String>, LocalError> {
        if line.is_empty() {
            return Ok(None);
        }
        let value: Value = serde_json::from_str(line).map_err(|e| LocalError::Malformed(format!("{e}: {line:.120}")))?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(LocalError::Server { status: 200, message: error.to_string() });
        }
        let piece = value
            .pointer("/message/content")
            .and_then(Value::as_str)
            .filter(|piece| !piece.is_empty())
            .map(str::to_string);
        if let Some(piece) = &piece {
            self.text.push_str(piece);
        }
        if value.get("done").and_then(Value::as_bool) == Some(true) {
            self.done = true;
            self.prompt_tokens = value.get("prompt_eval_count").and_then(Value::as_u64);
            self.completion_tokens = value.get("eval_count").and_then(Value::as_u64);
            self.prompt_ms = value.get("prompt_eval_duration").and_then(Value::as_u64).map(|ns| ns / 1_000_000);
            self.gen_ms = value.get("eval_duration").and_then(Value::as_u64).map(|ns| ns / 1_000_000);
            self.finish = match value.get("done_reason").and_then(Value::as_str) {
                Some("stop") => Finish::Stop,
                Some("length") => Finish::Length,
                _ => Finish::Unknown,
            };
        }
        Ok(piece)
    }

    fn openai_event(&mut self, data: &str) -> Result<Option<String>, LocalError> {
        let data = data.trim();
        if data.is_empty() {
            return Ok(None);
        }
        if data == "[DONE]" {
            self.done = true;
            return Ok(None);
        }
        let value: Value = serde_json::from_str(data).map_err(|e| LocalError::Malformed(format!("{e}: {data:.120}")))?;
        if let Some(error) = value.get("error") {
            let message = error.get("message").and_then(Value::as_str).or_else(|| error.as_str()).unwrap_or("error");
            return Err(LocalError::Server { status: 200, message: message.to_string() });
        }
        let choice = value.get("choices").and_then(Value::as_array).and_then(|choices| choices.first());
        let piece = choice
            .and_then(|c| c.pointer("/delta/content"))
            .and_then(Value::as_str)
            .filter(|piece| !piece.is_empty())
            .map(str::to_string);
        if let Some(piece) = &piece {
            self.text.push_str(piece);
        }
        match choice.and_then(|c| c.get("finish_reason")).and_then(Value::as_str) {
            Some("stop") => self.finish = Finish::Stop,
            Some("length") => self.finish = Finish::Length,
            _ => {}
        }
        if let Some(usage) = value.get("usage").filter(|u| u.is_object()) {
            self.prompt_tokens = usage.get("prompt_tokens").and_then(Value::as_u64).or(self.prompt_tokens);
            self.completion_tokens = usage.get("completion_tokens").and_then(Value::as_u64).or(self.completion_tokens);
        }
        // llama.cpp's server adds its own timings to the last chunk.
        if let Some(timings) = value.get("timings") {
            self.prompt_ms = timings.get("prompt_ms").and_then(Value::as_f64).map(|ms| ms as u64).or(self.prompt_ms);
            self.gen_ms = timings.get("predicted_ms").and_then(Value::as_f64).map(|ms| ms as u64).or(self.gen_ms);
            if self.prompt_tokens.is_none() {
                self.prompt_tokens = timings.get("prompt_n").and_then(Value::as_u64);
            }
        }
        Ok(piece)
    }

    pub fn finish(self) -> ChatOutcome {
        ChatOutcome {
            text: self.text,
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            finish: self.finish,
            prompt_ms: self.prompt_ms,
            gen_ms: self.gen_ms,
            total_ms: 0,
            first_token_ms: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_lose_their_trailing_v1() {
        assert_eq!(normalize_url("http://localhost:1234/v1/"), "http://localhost:1234");
        assert_eq!(normalize_url(" http://127.0.0.1:11434 "), "http://127.0.0.1:11434");
        assert_eq!(normalize_url("https://proxy.example.com/litellm/v1"), "https://proxy.example.com/litellm");
    }

    #[test]
    fn loopback_is_recognised_and_remote_is_not() {
        assert!(is_loopback("http://127.0.0.1:11434"));
        assert!(is_loopback("http://localhost:1234"));
        assert!(is_loopback("http://[::1]:8080"));
        assert!(is_loopback("http://models.localhost:4000"));
        assert!(!is_loopback("http://192.168.1.20:11434"));
        assert!(!is_loopback("https://proxy.example.com"));
        assert!(!is_loopback("not a url"));
    }

    #[test]
    fn both_listing_shapes_are_read() {
        let ollama = json!({ "models": [
            { "name": "qwen2.5-coder:7b", "size": 4_683_087_332u64,
              "details": { "parameter_size": "7.6B", "quantization_level": "Q4_K_M" } }
        ]});
        let models = parse_model_list(&ollama);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5-coder:7b");
        assert_eq!(models[0].params.as_deref(), Some("7.6B"));
        assert_eq!(models[0].quant.as_deref(), Some("Q4_K_M"));

        let openai = json!({ "object": "list", "data": [{ "id": "qwen2.5-coder-7b-instruct" }, { "id": "other" }] });
        let models = parse_model_list(&openai);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["qwen2.5-coder-7b-instruct", "other"]);

        assert!(parse_model_list(&json!({ "unexpected": true })).is_empty());
    }

    /// The real `/api/show` answer for qwen2.5-coder:7b on Ollama 0.35.0, trimmed to what is read.
    #[test]
    fn ollama_show_gives_the_window_and_the_kv_cache() {
        let body = json!({
            "details": { "parameter_size": "7.6B", "quantization_level": "Q4_K_M" },
            "model_info": {
                "qwen2.attention.head_count": 28,
                "qwen2.attention.head_count_kv": 4,
                "qwen2.block_count": 28,
                "qwen2.context_length": 32768,
                "qwen2.embedding_length": 3584
            },
            "capabilities": ["completion", "tools", "insert"]
        });
        let details = parse_ollama_show(&body);
        assert_eq!(details.max_ctx, Some(32_768));
        assert_eq!(details.kv_bytes_per_token, Some(57_344));
        assert_eq!(details.params_b, Some(7.6));
        assert!(!details.thinking);
    }

    #[test]
    fn an_explicit_key_length_beats_the_derived_head_size() {
        let body = json!({
            "model_info": {
                "qwen3moe.attention.head_count": 32,
                "qwen3moe.attention.head_count_kv": 4,
                "qwen3moe.attention.key_length": 128,
                "qwen3moe.block_count": 48,
                "qwen3moe.context_length": 262144,
                "qwen3moe.embedding_length": 2048
            },
            "capabilities": ["completion", "thinking"]
        });
        let details = parse_ollama_show(&body);
        // 2048 / 32 would say 64 — the architecture states 128.
        assert_eq!(details.kv_bytes_per_token, Some(2 * 48 * 4 * 128 * 2));
        assert!(details.thinking);
    }

    #[test]
    fn parameter_sizes_parse() {
        assert_eq!(parse_params_b("7.6B"), Some(7.6));
        assert_eq!(parse_params_b("30.5B"), Some(30.5));
        assert!((parse_params_b("494.03M").unwrap() - 0.494).abs() < 0.001);
        assert_eq!(parse_params_b("unknown"), None);
    }

    #[test]
    fn ollama_ndjson_is_read_across_chunk_boundaries() {
        let mut reader = StreamReader::new(BackendKind::Ollama);
        let stream = concat!(
            r#"{"message":{"role":"assistant","content":"fn "},"done":false}"#, "\n",
            r#"{"message":{"role":"assistant","content":"main() {}"},"done":false}"#, "\n",
            r#"{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":6982,"prompt_eval_duration":39600000000,"eval_count":16,"eval_duration":765000000}"#, "\n",
        );
        let bytes = stream.as_bytes();
        let mut pieces = Vec::new();
        // Deliberately split mid-line and mid-UTF-8-free JSON.
        for chunk in bytes.chunks(17) {
            pieces.extend(reader.feed(chunk).expect("valid stream"));
        }
        assert_eq!(pieces.concat(), "fn main() {}");
        assert!(reader.done);
        let outcome = reader.finish();
        assert_eq!(outcome.text, "fn main() {}");
        assert_eq!(outcome.prompt_tokens, Some(6982));
        assert_eq!(outcome.completion_tokens, Some(16));
        assert_eq!(outcome.prompt_ms, Some(39_600));
        assert_eq!(outcome.finish, Finish::Stop);
    }

    #[test]
    fn an_ollama_error_line_is_an_error() {
        let mut reader = StreamReader::new(BackendKind::Ollama);
        let error = reader.feed(b"{\"error\":\"model 'nope' not found\"}\n").err().expect("error");
        assert!(matches!(error, LocalError::Server { .. }));
    }

    #[test]
    fn openai_sse_reads_text_finish_usage_and_llamacpp_timings() {
        let mut reader = StreamReader::new(BackendKind::Openai);
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"```ts\\nexport\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" const a = 1;\\n```\"},\"finish_reason\":\"length\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1500,\"completion_tokens\":12},\"timings\":{\"prompt_ms\":820.5,\"predicted_ms\":410.2}}\n\n",
            "data: [DONE]\n\n",
        );
        let mut pieces = Vec::new();
        for chunk in stream.as_bytes().chunks(23) {
            pieces.extend(reader.feed(chunk).expect("valid stream"));
        }
        assert_eq!(pieces.concat(), "```ts\nexport const a = 1;\n```", "thinking text is not answer text");
        assert!(reader.done);
        let outcome = reader.finish();
        assert_eq!(outcome.finish, Finish::Length);
        assert_eq!(outcome.prompt_tokens, Some(1500));
        assert_eq!(outcome.completion_tokens, Some(12));
        assert_eq!(outcome.prompt_ms, Some(820));
        assert_eq!(outcome.gen_ms, Some(410));
    }

    #[test]
    fn lmstudio_reports_the_loaded_window() {
        let body = json!({ "data": [
            { "id": "qwen2.5-coder-7b-instruct", "max_context_length": 32768, "loaded_context_length": 8192 }
        ]});
        let details = lmstudio_details(&body, "qwen2.5-coder-7b-instruct").expect("entry");
        assert_eq!(details.max_ctx, Some(8192));
        assert!(details.ctx_fixed_by_server);
    }

    /// The lines of a real `ollama pull` (0.35), summed over its layers.
    #[test]
    fn a_pull_is_summed_over_its_layers() {
        let mut layers = std::collections::BTreeMap::new();
        assert_eq!(pull_line(r#"{"status":"pulling manifest"}"#, &mut layers).unwrap().unwrap().total, 0);
        pull_line(r#"{"status":"pulling 60e05f210007","digest":"sha256:60e0","total":4683073184,"completed":1048576}"#, &mut layers).unwrap();
        let progress = pull_line(r#"{"status":"pulling 66b9ea09bd5b","digest":"sha256:66b9","total":68,"completed":68}"#, &mut layers)
            .unwrap()
            .unwrap();
        assert_eq!((progress.completed, progress.total), (1_048_644, 4_683_073_252));
        // A layer never goes backwards, whatever order the lines come in.
        pull_line(r#"{"status":"pulling 60e05f210007","digest":"sha256:60e0","total":4683073184,"completed":512}"#, &mut layers).unwrap();
        assert_eq!(layers["sha256:60e0"].0, 1_048_576);
        assert_eq!(pull_line(r#"{"status":"success"}"#, &mut layers).unwrap().unwrap().status, "success");
        assert!(pull_line("", &mut layers).unwrap().is_none());
        let failed = pull_line(r#"{"error":"pull model manifest: file does not exist"}"#, &mut layers).unwrap_err();
        assert!(failed.sentence().contains("file does not exist"));
    }
}
