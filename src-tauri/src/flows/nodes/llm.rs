//! AI over the providers' own APIs — OpenAI, Anthropic, Gemini or any OpenAI-compatible server —
//! and what retrieval needs around it: embeddings, and a vector store (CodeFlow's own, Qdrant or
//! pgvector).
//!
//! **Not the subscription CLIs.** The other AI nodes run the engines a person signed in to; these
//! pay per token with an API key (a `bearer` credential): a server-side model, a provider the CLIs
//! do not cover, or embeddings, which no CLI gives.
//!
//! **Retrieval in two nodes.** "Base vectorial" embeds what it stores and what it is asked with
//! the same model, so a flow is *read → store* once and *ask → answer* after; its query hands back
//! the matches and a `context` with their texts joined, ready for the prompt of an AI node.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use sha2::Digest;

use super::{flag, number, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};
use crate::flows::schema;

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "ai.embed" => embed_node(ctx).await,
        "ai.vectors" => vectors(ctx).await,
        _ => chat(ctx).await,
    }
}

/// A provider as the code names it. The parameter says `openaiApi` — `openai` is the local model
/// node's "OpenAI-compatible server", and option labels are shared by value.
pub fn provider_id(raw: &str) -> String {
    match raw.trim() {
        "" | "openaiApi" => "openai".into(),
        other => other.into(),
    }
}

pub(super) fn client() -> Result<reqwest::Client, NodeError> {
    reqwest::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| NodeError::failed(e.to_string()))
}

/// Where a provider's API is, unless the node names another address.
pub fn base_of(provider: &str, written: &str) -> Result<String, String> {
    let written = written.trim().trim_end_matches('/');
    if !written.is_empty() {
        return Ok(written.to_string());
    }
    Ok(match provider {
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta",
        "ollama" => "http://127.0.0.1:11434",
        _ => return Err("An OpenAI-compatible server needs its address (…/v1)".into()),
    }
    .to_string())
}

/// A request with the provider's way of sending a key.
pub(super) fn signed(request: reqwest::RequestBuilder, provider: &str, key: Option<&str>) -> reqwest::RequestBuilder {
    let Some(key) = key.filter(|k| !k.is_empty()) else { return request };
    match provider {
        "anthropic" => request.header("x-api-key", key).header("anthropic-version", "2023-06-01"),
        "gemini" => request.header("x-goog-api-key", key),
        _ => request.bearer_auth(key),
    }
}

pub(super) async fn send(ctx: &NodeCtx, what: &str, request: reqwest::RequestBuilder) -> Result<Value, NodeError> {
    let started = Instant::now();
    let response = tokio::select! {
        response = request.send() => response.map_err(|e| NodeError::failed(format!("{what}: could not reach the provider: {e}")))?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let status = response.status();
    let body = response.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
    ctx.log(LogStream::Info, &format!("{what} → {} ({} ms)", status.as_u16(), started.elapsed().as_millis()));
    if !status.is_success() {
        return Err(NodeError::failed(format!("{what} answered {}: {}", status.as_u16(), crate::oauth::describe(status, &body))));
    }
    serde_json::from_str(&body).map_err(|_| NodeError::failed(format!("{what} did not answer JSON")))
}

pub(super) async fn api_key(ctx: &NodeCtx, provider: &str) -> Result<Option<String>, NodeError> {
    let id = ctx.param_str("credential");
    if id.trim().is_empty() {
        return match provider {
            "openai" | "anthropic" | "gemini" => Err(NodeError::failed("Pick the credential with the provider's API key")),
            _ => Ok(None),
        };
    }
    Ok(Some(ctx.credential(id.trim()).await?.secret))
}

// ------------------------------------------------------------------------------------------- chat

/// One answer of a chat model.
#[derive(Debug, Default, Clone)]
pub struct Answer {
    pub text: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cut: bool,
}

/// The request body for one question, per provider.
pub fn chat_body(provider: &str, model: &str, system: &str, prompt: &str, schema: Option<&Value>, temperature: Option<f64>, max_tokens: u32) -> Value {
    match provider {
        "anthropic" => {
            let mut body = json!({"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]});
            if !system.trim().is_empty() {
                body["system"] = json!(system);
            }
            if let Some(t) = temperature {
                body["temperature"] = json!(t.min(1.0));
            }
            body
        }
        "gemini" => {
            let mut config = json!({"maxOutputTokens": max_tokens});
            if let Some(t) = temperature {
                config["temperature"] = json!(t);
            }
            if schema.is_some() {
                config["responseMimeType"] = json!("application/json");
            }
            let mut body = json!({"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": config});
            if !system.trim().is_empty() {
                body["systemInstruction"] = json!({"parts": [{"text": system}]});
            }
            body
        }
        _ => {
            let mut messages = Vec::new();
            if !system.trim().is_empty() {
                messages.push(json!({"role": "system", "content": system}));
            }
            messages.push(json!({"role": "user", "content": prompt}));
            let mut body = json!({"model": model, "messages": messages});
            // OpenAI's own API takes the newer name (reasoning models refuse the old one); other
            // servers mostly know only the old one.
            body[if provider == "openai" { "max_completion_tokens" } else { "max_tokens" }] = json!(max_tokens);
            if let Some(t) = temperature {
                body["temperature"] = json!(t);
            }
            if let (Some(schema), "openai") = (schema, provider) {
                body["response_format"] = json!({"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}});
            }
            body
        }
    }
}

/// What a provider answered, read the same way for all of them.
pub fn read_answer(provider: &str, answer: &Value) -> Answer {
    let number = |v: &Value| v.as_u64().unwrap_or(0);
    match provider {
        "anthropic" => Answer {
            text: answer["content"].as_array().into_iter().flatten().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(""),
            model: answer["model"].as_str().unwrap_or_default().to_string(),
            input_tokens: number(&answer["usage"]["input_tokens"]),
            output_tokens: number(&answer["usage"]["output_tokens"]),
            cut: answer["stop_reason"] == "max_tokens",
        },
        "gemini" => {
            let candidate = &answer["candidates"][0];
            Answer {
                text: candidate["content"]["parts"].as_array().into_iter().flatten().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(""),
                model: answer["modelVersion"].as_str().unwrap_or_default().to_string(),
                input_tokens: number(&answer["usageMetadata"]["promptTokenCount"]),
                output_tokens: number(&answer["usageMetadata"]["candidatesTokenCount"]),
                cut: candidate["finishReason"] == "MAX_TOKENS",
            }
        }
        _ => {
            let choice = &answer["choices"][0];
            Answer {
                text: choice["message"]["content"].as_str().unwrap_or_default().to_string(),
                model: answer["model"].as_str().unwrap_or_default().to_string(),
                input_tokens: number(&answer["usage"]["prompt_tokens"]),
                output_tokens: number(&answer["usage"]["completion_tokens"]),
                cut: choice["finish_reason"] == "length",
            }
        }
    }
}

pub(super) fn chat_url(provider: &str, base: &str, model: &str) -> String {
    match provider {
        "anthropic" => format!("{base}/messages"),
        "gemini" => format!("{base}/models/{}:generateContent", model.trim_start_matches("models/")),
        _ => format!("{base}/chat/completions"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn complete(ctx: &NodeCtx, provider: &str, base: &str, key: Option<&str>, model: &str, system: &str, prompt: &str, schema: Option<&Value>, temperature: f64, max_tokens: u32) -> Result<Answer, NodeError> {
    let http = client()?;
    let url = chat_url(provider, base, model);
    let body = chat_body(provider, model, system, prompt, schema, Some(temperature), max_tokens);
    let first = send(ctx, provider, signed(http.post(&url).json(&body), provider, key)).await;
    let answer = match first {
        // Reasoning models take only their default temperature: asked again without one.
        Err(NodeError::Failed(error)) if error.contains("temperature") => {
            let body = chat_body(provider, model, system, prompt, schema, None, max_tokens);
            send(ctx, provider, signed(http.post(&url).json(&body), provider, key)).await?
        }
        other => other?,
    };
    Ok(read_answer(provider, &answer))
}

/// The schema the answer must follow, from the node's `output` setting.
fn output_schema(params: &Value) -> Result<Option<Value>, NodeError> {
    match params.get("output").and_then(Value::as_str).unwrap_or("text") {
        "json" => schema::from_fields(params.get("schemaFields").unwrap_or(&Value::Null)).map(Some).map_err(NodeError::Failed),
        "schema" => schema::from_text(&text(params, "schemaJson")).map(Some).map_err(NodeError::Failed),
        _ => Ok(None),
    }
}

fn schema_instruction(schema: &Value) -> String {
    format!(
        "\n\nResponde ÚNICAMENTE con un objeto JSON que cumpla este JSON Schema — sin texto antes ni después y sin bloque de código:\n{}",
        serde_json::to_string_pretty(schema).unwrap_or_default()
    )
}

fn conforming(text: &str, schema: &Value) -> Result<Value, Vec<String>> {
    match schema::answer_object(text) {
        None => Err(vec!["the answer is not a JSON object".to_string()]),
        Some(mut value) => {
            schema::prune(&mut value, schema);
            let problems = schema::validate(&value, schema);
            if problems.is_empty() { Ok(value) } else { Err(problems) }
        }
    }
}

/// The request body for a turn of a conversation: [`chat_body`] with the messages so far, and the
/// tools on offer (`no_more_tools`: declared, but the model must answer in words).
#[allow(clippy::too_many_arguments)]
pub fn conversation_body(
    provider: &str,
    model: &str,
    system: &str,
    messages: &[Value],
    tools: &[super::tools::FlowTool],
    no_more_tools: bool,
    schema: Option<&Value>,
    temperature: Option<f64>,
    max_tokens: u32,
) -> Value {
    let mut body = chat_body(provider, model, system, "", schema, temperature, max_tokens);
    let declared = (!tools.is_empty()).then(|| super::tools::declarations(provider, tools));
    match provider {
        "anthropic" => {
            body["messages"] = json!(messages);
            if let Some(declared) = declared {
                body["tools"] = declared;
                if no_more_tools {
                    body["tool_choice"] = json!({"type": "none"});
                }
            }
        }
        "gemini" => {
            body["contents"] = json!(messages);
            if let Some(declared) = declared {
                body["tools"] = declared;
                // Gemini refuses a JSON answer and function calling together: the schema is then
                // only the prompt's instruction, checked after.
                if let Some(config) = body.get_mut("generationConfig").and_then(Value::as_object_mut) {
                    config.remove("responseMimeType");
                }
                if no_more_tools {
                    body["toolConfig"] = json!({"functionCallingConfig": {"mode": "NONE"}});
                }
            }
        }
        _ => {
            let mut all = Vec::with_capacity(messages.len() + 1);
            if !system.trim().is_empty() {
                all.push(json!({"role": "system", "content": system}));
            }
            all.extend(messages.iter().cloned());
            body["messages"] = Value::Array(all);
            if let Some(declared) = declared {
                body["tools"] = declared;
                if no_more_tools {
                    body["tool_choice"] = json!("none");
                }
            }
        }
    }
    body
}

/// A question asked as a conversation: the remembered turns before it, other flows as tools, the
/// calls run until the model answers in words (or its budget is spent). Returns the answer with
/// every turn's tokens added up, and what was called.
#[allow(clippy::too_many_arguments)]
async fn converse(
    ctx: &NodeCtx,
    provider: &str,
    base: &str,
    key: Option<&str>,
    model: &str,
    system: &str,
    mut messages: Vec<Value>,
    tools: &[super::tools::FlowTool],
    max_calls: usize,
    schema: Option<&Value>,
    temperature: f64,
    max_tokens: u32,
) -> Result<(Answer, Vec<Value>), NodeError> {
    let http = client()?;
    let url = chat_url(provider, base, model);
    let mut calls_made = 0;
    let mut log = Vec::new();
    let mut total = Answer::default();
    let mut temperature = Some(temperature);
    loop {
        let no_more = calls_made >= max_calls;
        let body = conversation_body(provider, model, system, &messages, tools, no_more, schema, temperature, max_tokens);
        let answer = match send(ctx, provider, signed(http.post(&url).json(&body), provider, key)).await {
            // Reasoning models take only their default temperature: asked again without one.
            Err(NodeError::Failed(error)) if error.contains("temperature") && temperature.is_some() => {
                temperature = None;
                continue;
            }
            other => other?,
        };
        let read = read_answer(provider, &answer);
        total.input_tokens += read.input_tokens;
        total.output_tokens += read.output_tokens;
        total.model = read.model.clone();
        total.cut = read.cut;
        let (calls, said) = super::tools::calls_in(provider, &answer);
        if calls.is_empty() || no_more {
            if no_more && !calls.is_empty() && read.text.trim().is_empty() {
                return Err(NodeError::failed(format!("The model kept calling tools after {max_calls} calls — raise «Max tool calls»")));
            }
            total.text = read.text;
            return Ok((total, log));
        }
        messages.push(said);
        let mut results = Vec::with_capacity(calls.len());
        for call in calls {
            if ctx.cancel.is_cancelled() {
                return Err(NodeError::Cancelled);
            }
            calls_made += 1;
            if calls_made > max_calls {
                results.push(super::tools::over_budget(call));
                continue;
            }
            results.push(super::tools::run_call(ctx, tools, call, &mut log).await);
        }
        messages.extend(super::tools::result_messages(provider, &results));
    }
}

async fn chat(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let provider = provider_id(&ctx.param_str("apiProvider"));
    let key = api_key(ctx, &provider).await?;
    let schema = output_schema(&ctx.params)?;
    let tools = super::tools::flow_tools(ctx, &ctx.params).await?;
    let max_calls = super::tools::max_calls(&ctx.params);
    let resolved = if ctx.param_str("runFor") == "once" { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let base = base_of(&provider, &text(params, "baseUrl")).map_err(NodeError::Failed)?;
        let model = text(params, "apiModel");
        if model.is_empty() {
            return Err(NodeError::failed("Pick the model"));
        }
        let prompt = text(params, "prompt");
        if prompt.trim().is_empty() {
            return Err(NodeError::failed("Write what the model should do"));
        }
        let mut full = prompt.trim().to_string();
        if let Some(schema) = &schema {
            full.push_str(&schema_instruction(schema));
        }
        let system = text(params, "system");
        let temperature = number(params, "temperature").unwrap_or(0.2).clamp(0.0, 2.0);
        let max_tokens = number(params, "maxTokens").unwrap_or(1_024.0).clamp(16.0, 200_000.0) as u32;
        let started = Instant::now();
        let memory = super::tools::memory_key(ctx, params);
        let history = memory.as_deref().map(|key| super::tools::recall(ctx, key)).unwrap_or_default();
        let mut called = Vec::new();
        let mut answer = if tools.is_empty() && history.is_empty() {
            complete(ctx, &provider, &base, key.as_deref(), &model, &system, &full, schema.as_ref(), temperature, max_tokens).await?
        } else {
            let messages = super::tools::opening(&provider, &history, &full);
            let (answer, log) =
                converse(ctx, &provider, &base, key.as_deref(), &model, &system, messages, &tools, max_calls, schema.as_ref(), temperature, max_tokens).await?;
            called = log;
            answer
        };
        let mut data = None;
        if let Some(schema) = &schema {
            match conforming(&answer.text, schema) {
                Ok(object) => data = Some(object),
                Err(problems) => {
                    ctx.log(LogStream::Info, &format!("The answer did not follow the schema ({}) — asking once more", problems.join("; ")));
                    let previous: String = answer.text.chars().take(4_000).collect();
                    let retry = format!(
                        "{full}\n\nTu respuesta anterior no cumplió el esquema:\n- {}\n\nRespuesta anterior:\n{previous}\n\nResponde de nuevo SOLO con el objeto JSON corregido.",
                        problems.join("\n- ")
                    );
                    answer = complete(ctx, &provider, &base, key.as_deref(), &model, &system, &retry, Some(schema), temperature, max_tokens).await?;
                    data = Some(conforming(&answer.text, schema).map_err(|problems| {
                        NodeError::failed(format!("The answer did not follow the schema, even after a retry: {}", problems.join("; ")))
                    })?);
                }
            }
        }
        if answer.cut {
            ctx.log(LogStream::Info, "The answer reached the token limit and is cut — raise «Max tokens»");
        }
        if let Some(key) = &memory {
            super::tools::remember(ctx, key, history, prompt.trim(), answer.text.trim(), params);
        }
        let mut json = Map::new();
        json.insert("text".into(), json!(answer.text.trim()));
        if let Some(data) = data {
            json.insert("data".into(), data);
        }
        if !called.is_empty() {
            json.insert("toolCalls".into(), json!(called));
        }
        json.insert("provider".into(), json!(provider));
        json.insert("model".into(), json!(if answer.model.is_empty() { model } else { answer.model }));
        json.insert("usage".into(), json!({"inputTokens": answer.input_tokens, "outputTokens": answer.output_tokens}));
        json.insert("cut".into(), json!(answer.cut));
        json.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
        out.push(if ctx.items().is_empty() { Item::new(Value::Object(json)) } else { Item::paired(Value::Object(json), index) });
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------- embeddings

/// How a node embeds: the provider, its address, the model and the key.
struct Embedder {
    provider: String,
    base: String,
    model: String,
    key: Option<String>,
}

impl Embedder {
    async fn of(ctx: &NodeCtx, params: &Value) -> Result<Embedder, NodeError> {
        let provider = provider_id(&text(params, "embedProvider"));
        let base = base_of(&provider, &text(params, "embedUrl")).map_err(NodeError::Failed)?;
        let model = text(params, "embedModel");
        if model.is_empty() {
            return Err(NodeError::failed("Pick the embedding model"));
        }
        let key = if provider == "ollama" && ctx.param_str("credential").trim().is_empty() { None } else { api_key(ctx, &provider).await? };
        Ok(Embedder { provider, base, model, key })
    }

    /// One vector per text, in order; asked in batches.
    async fn embed(&self, ctx: &NodeCtx, texts: &[String]) -> Result<Vec<Vec<f32>>, NodeError> {
        let http = client()?;
        let mut vectors = Vec::with_capacity(texts.len());
        for batch in texts.chunks(96) {
            let (url, body) = embed_request(&self.provider, &self.base, &self.model, batch);
            let answer = send(ctx, "Embeddings", signed(http.post(&url).json(&body), &self.provider, self.key.as_deref())).await?;
            let got = read_vectors(&self.provider, &answer);
            if got.len() != batch.len() {
                return Err(NodeError::failed(format!("The provider gave {} vectors for {} texts", got.len(), batch.len())));
            }
            vectors.extend(got);
        }
        Ok(vectors)
    }
}

pub fn embed_request(provider: &str, base: &str, model: &str, texts: &[String]) -> (String, Value) {
    match provider {
        "gemini" => {
            let model = model.trim_start_matches("models/");
            let requests: Vec<Value> = texts.iter().map(|t| json!({"model": format!("models/{model}"), "content": {"parts": [{"text": t}]}})).collect();
            (format!("{base}/models/{model}:batchEmbedContents"), json!({"requests": requests}))
        }
        "ollama" => (format!("{base}/api/embed"), json!({"model": model, "input": texts})),
        _ => (format!("{base}/embeddings"), json!({"model": model, "input": texts})),
    }
}

pub fn read_vectors(provider: &str, answer: &Value) -> Vec<Vec<f32>> {
    let floats = |v: &Value| v.as_array().map(|list| list.iter().filter_map(Value::as_f64).map(|f| f as f32).collect::<Vec<f32>>());
    match provider {
        "gemini" => answer["embeddings"].as_array().into_iter().flatten().filter_map(|e| floats(&e["values"])).collect(),
        "ollama" => answer["embeddings"].as_array().into_iter().flatten().filter_map(floats).collect(),
        _ => {
            let mut data: Vec<&Value> = answer["data"].as_array().into_iter().flatten().collect();
            data.sort_by_key(|d| d["index"].as_u64().unwrap_or(0));
            data.into_iter().filter_map(|d| floats(&d["embedding"])).collect()
        }
    }
}

async fn embed_node(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let embedder = Embedder::of(ctx, resolved.first().unwrap_or(&ctx.params)).await?;
    let texts: Vec<String> = resolved.iter().map(|p| text(p, "embedText")).collect();
    if texts.iter().all(|t| t.trim().is_empty()) {
        return Err(NodeError::failed("Write the text to embed"));
    }
    let vectors = embedder.embed(ctx, &texts).await?;
    let target = match ctx.param_str("targetField") {
        field if field.trim().is_empty() => "embedding".to_string(),
        field => field.trim().to_string(),
    };
    let items = ctx.items();
    let out = vectors
        .into_iter()
        .enumerate()
        .map(|(index, vector)| {
            let mut json = items.get(index).map(|item| item.json.clone()).filter(Value::is_object).unwrap_or_else(|| json!({}));
            json["dimensions"] = json!(vector.len());
            crate::flows::value::set_path(&mut json, &target, json!(vector));
            if items.is_empty() { Item::new(json) } else { Item::paired(json, index) }
        })
        .collect();
    Ok(vec![out])
}

// ----------------------------------------------------------------------------------- vector store

/// Cosine similarity; 0 for vectors that cannot be compared.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na.sqrt() * nb.sqrt()) }
}

/// A text cut into pieces of about `size` characters, overlapping by `overlap`, each ending where a
/// paragraph, line, sentence or word does when one is near — what retrieval stores, one vector each.
pub fn chunks(text: &str, size: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if size == 0 || chars.len() <= size {
        return if text.trim().is_empty() { Vec::new() } else { vec![text.trim().to_string()] };
    }
    let overlap = overlap.min(size / 2);
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let hard_end = (start + size).min(chars.len());
        let mut end = hard_end;
        if hard_end < chars.len() {
            let window: String = chars[start..hard_end].iter().collect();
            let floor = size / 2;
            for breaker in ["\n\n", "\n", ". ", " "] {
                if let Some(at) = window.rfind(breaker) {
                    let at_chars = window[..at].chars().count() + breaker.chars().count();
                    if at_chars >= floor {
                        end = start + at_chars;
                        break;
                    }
                }
            }
        }
        let piece: String = chars[start..end].iter().collect();
        if !piece.trim().is_empty() {
            out.push(piece.trim().to_string());
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(overlap).max(start + 1);
    }
    out
}

/// An id for a text with none given: the same text is the same document, stored once.
fn id_of(text: &str) -> String {
    hex::encode(&sha2::Sha256::digest(text.as_bytes())[..8])
}

/// One stored piece.
#[derive(Debug, Clone)]
pub struct Doc {
    pub id: String,
    pub text: String,
    pub metadata: Value,
    pub vector: Vec<f32>,
}

/// One match of a query.
#[derive(Debug, Clone)]
pub struct Hit {
    pub id: String,
    pub text: String,
    pub metadata: Value,
    pub score: f32,
}

fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn from_blob(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

/// CodeFlow's own store: one SQLite file, rows per workspace and collection, searched exactly.
pub mod local {
    use super::*;
    use rusqlite::{params, Connection};

    pub fn open(path: &std::path::Path) -> Result<Connection, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS vectors (
                 workspace_id TEXT NOT NULL,
                 collection TEXT NOT NULL,
                 id TEXT NOT NULL,
                 text TEXT NOT NULL,
                 metadata TEXT NOT NULL,
                 dims INTEGER NOT NULL,
                 vector BLOB NOT NULL,
                 updated_at TEXT NOT NULL,
                 PRIMARY KEY (workspace_id, collection, id)
             );",
        )
        .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    pub fn upsert(conn: &mut Connection, workspace: &str, collection: &str, docs: &[Doc]) -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut statement = tx
                .prepare(
                    "INSERT INTO vectors (workspace_id, collection, id, text, metadata, dims, vector, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT (workspace_id, collection, id) DO UPDATE SET text = excluded.text, metadata = excluded.metadata, dims = excluded.dims, vector = excluded.vector, updated_at = excluded.updated_at",
                )
                .map_err(|e| e.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            for doc in docs {
                statement
                    .execute(params![workspace, collection, doc.id, doc.text, doc.metadata.to_string(), doc.vector.len() as i64, to_blob(&doc.vector), now])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn query(conn: &Connection, workspace: &str, collection: &str, vector: &[f32], top: usize, min_score: f32) -> Result<Vec<Hit>, String> {
        let mut statement = conn
            .prepare("SELECT id, text, metadata, vector FROM vectors WHERE workspace_id = ?1 AND collection = ?2 AND dims = ?3")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![workspace, collection, vector.len() as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Vec<u8>>(3)?))
            })
            .map_err(|e| e.to_string())?;
        let mut hits: Vec<Hit> = rows
            .filter_map(Result::ok)
            .map(|(id, text, metadata, blob)| Hit {
                score: cosine(vector, &from_blob(&blob)),
                id,
                text,
                metadata: serde_json::from_str(&metadata).unwrap_or(Value::Null),
            })
            .filter(|hit| hit.score >= min_score)
            .collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(top);
        Ok(hits)
    }

    pub fn delete(conn: &Connection, workspace: &str, collection: &str, ids: &[String]) -> Result<usize, String> {
        if ids.is_empty() {
            return conn.execute("DELETE FROM vectors WHERE workspace_id = ?1 AND collection = ?2", params![workspace, collection]).map_err(|e| e.to_string());
        }
        let mut removed = 0;
        for id in ids {
            // A document stored in pieces is `id#1`, `id#2`…: its id takes them all.
            removed += conn
                .execute(
                    "DELETE FROM vectors WHERE workspace_id = ?1 AND collection = ?2 AND (id = ?3 OR id LIKE ?4 ESCAPE '\\')",
                    params![workspace, collection, id, format!("{}#%", id.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(removed)
    }
}

/// Qdrant's point ids are UUIDs or integers: a document's id becomes a UUID derived from it, and the
/// id itself travels in the payload.
pub fn qdrant_point_id(collection: &str, id: &str) -> String {
    let digest = sha2::Sha256::digest(format!("{collection}\0{id}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Uuid::from_bytes(bytes).to_string()
}

async fn qdrant(ctx: &NodeCtx, params: &Value) -> Result<(reqwest::Client, String, Vec<(String, String)>), NodeError> {
    let base = match text(params, "qdrantUrl") {
        url if url.is_empty() => "http://localhost:6333".to_string(),
        url => url.trim_end_matches('/').to_string(),
    };
    let mut headers = Vec::new();
    let id = ctx.param_str("storeCredential");
    if !id.trim().is_empty() {
        let credential = ctx.credential(id.trim()).await?;
        match credential.kind.as_str() {
            "header" => headers.push((credential.meta.get("name").and_then(Value::as_str).unwrap_or("api-key").to_string(), credential.secret)),
            _ => headers.push(("api-key".to_string(), credential.secret)),
        }
    }
    Ok((client()?, base, headers))
}

fn with_headers(mut request: reqwest::RequestBuilder, headers: &[(String, String)]) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        request = request.header(name, value);
    }
    request
}

const PG_TABLE: &str = "codeflow_vectors";

async fn pg_session(ctx: &NodeCtx) -> Result<(crate::datasource::Session, crate::datasource::DbExecContext), NodeError> {
    use crate::datasource::{DbExecContext, DbKind, Session};
    let connection = ctx.param_str("connection");
    if connection.trim().is_empty() {
        return Err(NodeError::failed("Pick the PostgreSQL connection that has pgvector"));
    }
    let config = ctx.run.host.db_connection(connection.trim()).map_err(NodeError::Failed)?;
    if !matches!(config.kind, DbKind::Postgres | DbKind::Supabase) {
        return Err(NodeError::failed("pgvector needs a PostgreSQL or Supabase connection"));
    }
    let tag = format!("flow-{}-{}", ctx.run.run_id, ctx.node.id);
    let session = Session::open_tagged(&config, None, &tag).await.map_err(NodeError::Failed)?;
    Ok((session, DbExecContext { database: None, schema: None, max_rows: 1_000 }))
}

async fn pg_run(session: &crate::datasource::Session, exec: &crate::datasource::DbExecContext, sql: &str, values: &[Value]) -> Result<Vec<Value>, NodeError> {
    let statement = super::data::bind(sql, values, crate::datasource::SqlDialect::Postgres).map_err(NodeError::Failed)?;
    let result = session.execute(&statement, exec).await.map_err(NodeError::Failed)?;
    let mut rows = Vec::new();
    for part in &result.results {
        if let Some(error) = &part.error {
            return Err(NodeError::failed(error.clone()));
        }
        rows.extend(super::data::rows_of(part));
    }
    Ok(rows)
}

fn vector_literal(vector: &[f32]) -> String {
    format!("[{}]", vector.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(","))
}

async fn vectors(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let first = resolved.first().cloned().unwrap_or_else(|| ctx.params.clone());
    let collection = match text(&first, "collection") {
        name if name.trim().is_empty() => return Err(NodeError::failed("Name the collection")),
        name => name.trim().to_string(),
    };
    let store = ctx.param_str("vectorStore");
    let op = ctx.param_str("vectorOp");
    let items = ctx.items();
    let paired = !items.is_empty();
    let wrap = |index: usize, json: Value| if paired { Item::paired(json, index) } else { Item::new(json) };

    if op == "vectorDelete" {
        let written: Vec<String> = resolved.iter().flat_map(|p| text(p, "docIds").split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>()).filter(|s| !s.is_empty()).collect();
        if written.is_empty() {
            return Err(NodeError::failed("Write the ids to delete — * deletes the whole collection"));
        }
        // Empty below means "all of it", which only `*` asks for.
        let ids: Vec<String> = if written.iter().any(|id| id == "*") { Vec::new() } else { written };
        let removed = match store.as_str() {
            "qdrant" => {
                let (http, base, headers) = qdrant(ctx, &first).await?;
                let selector = if ids.is_empty() {
                    json!({"filter": {}})
                } else {
                    let mut points: Vec<Value> = Vec::new();
                    for id in &ids {
                        points.push(json!(qdrant_point_id(&collection, id)));
                    }
                    json!({"points": points})
                };
                send(ctx, "Qdrant delete", with_headers(http.post(format!("{base}/collections/{collection}/points/delete?wait=true")).json(&selector), &headers)).await?;
                ids.len()
            }
            "pgvector" => {
                let (session, exec) = pg_session(ctx).await?;
                if ids.is_empty() {
                    pg_run(&session, &exec, &format!("DELETE FROM {PG_TABLE} WHERE collection = $1"), &[json!(collection)]).await?;
                } else {
                    for id in &ids {
                        pg_run(&session, &exec, &format!("DELETE FROM {PG_TABLE} WHERE collection = $1 AND (id = $2 OR id LIKE $3)"), &[json!(collection), json!(id), json!(format!("{id}#%"))]).await?;
                    }
                }
                ids.len()
            }
            _ => {
                let (workspace, collection_name, ids_owned, path) = (ctx.run.workspace_id.clone(), collection.clone(), ids.clone(), ctx.run.host.vectors_path());
                tokio::task::spawn_blocking(move || {
                    let conn = local::open(&path)?;
                    local::delete(&conn, &workspace, &collection_name, &ids_owned)
                })
                .await
                .map_err(|e| NodeError::failed(e.to_string()))?
                .map_err(NodeError::Failed)?
            }
        };
        return Ok(vec![vec![Item::new(json!({"collection": collection, "deleted": removed, "all": ids.is_empty(), "ids": ids}))]]);
    }

    let embedder = Embedder::of(ctx, &first).await?;

    if op == "vectorQuery" {
        let questions: Vec<String> = resolved.iter().map(|p| text(p, "queryText")).collect();
        if questions.iter().all(|q| q.trim().is_empty()) {
            return Err(NodeError::failed("Write what to look for"));
        }
        let query_vectors = embedder.embed(ctx, &questions).await?;
        let mut out = Vec::new();
        for (index, (params, vector)) in resolved.iter().zip(query_vectors).enumerate() {
            let top = number(params, "topK").map(|n| n.max(1.0) as usize).unwrap_or(4);
            let min_score = number(params, "minScore").unwrap_or(0.0) as f32;
            let hits: Vec<Hit> = match store.as_str() {
                "qdrant" => {
                    let (http, base, headers) = qdrant(ctx, params).await?;
                    let body = json!({"vector": vector, "limit": top, "with_payload": true, "score_threshold": min_score});
                    let answer = send(ctx, "Qdrant search", with_headers(http.post(format!("{base}/collections/{collection}/points/search")).json(&body), &headers)).await?;
                    answer["result"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|point| Hit {
                            id: point["payload"]["id"].as_str().map(str::to_string).unwrap_or_else(|| point["id"].to_string()),
                            text: point["payload"]["text"].as_str().unwrap_or_default().to_string(),
                            metadata: point["payload"]["metadata"].clone(),
                            score: point["score"].as_f64().unwrap_or(0.0) as f32,
                        })
                        .collect()
                }
                "pgvector" => {
                    let (session, exec) = pg_session(ctx).await?;
                    let sql = format!(
                        "SELECT id, text, metadata::text AS metadata, 1 - (embedding <=> $1::vector) AS score FROM {PG_TABLE} WHERE collection = $2 ORDER BY embedding <=> $1::vector LIMIT {top}"
                    );
                    pg_run(&session, &exec, &sql, &[json!(vector_literal(&vector)), json!(collection)])
                        .await?
                        .into_iter()
                        .map(|row| Hit {
                            id: row["id"].as_str().unwrap_or_default().to_string(),
                            text: row["text"].as_str().unwrap_or_default().to_string(),
                            metadata: row["metadata"].as_str().and_then(|m| serde_json::from_str(m).ok()).unwrap_or(Value::Null),
                            score: row["score"].as_f64().or_else(|| row["score"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0) as f32,
                        })
                        .filter(|hit| hit.score >= min_score)
                        .collect()
                }
                _ => {
                    let (workspace, collection_name, path) = (ctx.run.workspace_id.clone(), collection.clone(), ctx.run.host.vectors_path());
                    tokio::task::spawn_blocking(move || {
                        let conn = local::open(&path)?;
                        local::query(&conn, &workspace, &collection_name, &vector, top, min_score)
                    })
                    .await
                    .map_err(|e| NodeError::failed(e.to_string()))?
                    .map_err(NodeError::Failed)?
                }
            };
            let context = hits.iter().map(|hit| hit.text.as_str()).collect::<Vec<_>>().join("\n\n---\n\n");
            let matches: Vec<Value> = hits.iter().map(|hit| json!({"id": hit.id, "text": hit.text, "score": hit.score, "metadata": hit.metadata})).collect();
            out.push(wrap(index, json!({"query": text(params, "queryText"), "collection": collection, "matches": matches, "context": context})));
        }
        return Ok(vec![out]);
    }

    // Store: each item's text, in pieces when asked, embedded in batches.
    let mut docs: Vec<(usize, Doc)> = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let body = text(params, "docText");
        if body.trim().is_empty() {
            continue;
        }
        let id = match text(params, "docId") {
            given if !given.trim().is_empty() => given.trim().to_string(),
            _ => id_of(&body),
        };
        let metadata = if flag(params, "keepItem") { items.get(index).map(|item| item.json.clone()).unwrap_or(Value::Null) } else { Value::Null };
        let size = number(params, "chunkSize").map(|n| n.max(0.0) as usize).unwrap_or(0);
        let overlap = number(params, "chunkOverlap").map(|n| n.max(0.0) as usize).unwrap_or(0);
        let pieces = chunks(&body, size, overlap);
        let many = pieces.len() > 1;
        for (n, piece) in pieces.into_iter().enumerate() {
            let piece_id = if many { format!("{id}#{}", n + 1) } else { id.clone() };
            docs.push((index, Doc { id: piece_id, text: piece, metadata: metadata.clone(), vector: Vec::new() }));
        }
    }
    if docs.is_empty() {
        return Err(NodeError::failed("Nothing to store — the text is empty"));
    }
    let texts: Vec<String> = docs.iter().map(|(_, doc)| doc.text.clone()).collect();
    for ((_, doc), vector) in docs.iter_mut().zip(embedder.embed(ctx, &texts).await?) {
        doc.vector = vector;
    }
    let dims = docs[0].1.vector.len();
    match store.as_str() {
        "qdrant" => {
            let (http, base, headers) = qdrant(ctx, &first).await?;
            let exists = with_headers(http.get(format!("{base}/collections/{collection}")), &headers).send().await.map(|r| r.status().is_success()).unwrap_or(false);
            if !exists {
                let body = json!({"vectors": {"size": dims, "distance": "Cosine"}});
                send(ctx, "Qdrant create collection", with_headers(http.put(format!("{base}/collections/{collection}")).json(&body), &headers)).await?;
            }
            let points: Vec<Value> = docs
                .iter()
                .map(|(_, doc)| json!({"id": qdrant_point_id(&collection, &doc.id), "vector": doc.vector, "payload": {"id": doc.id, "text": doc.text, "metadata": doc.metadata}}))
                .collect();
            for batch in points.chunks(256) {
                send(ctx, "Qdrant upsert", with_headers(http.put(format!("{base}/collections/{collection}/points?wait=true")).json(&json!({"points": batch})), &headers)).await?;
            }
        }
        "pgvector" => {
            let (session, exec) = pg_session(ctx).await?;
            pg_run(
                &session,
                &exec,
                &format!("CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE IF NOT EXISTS {PG_TABLE} (collection text NOT NULL, id text NOT NULL, text text NOT NULL, metadata jsonb, embedding vector NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection, id))"),
                &[],
            )
            .await?;
            for (_, doc) in &docs {
                pg_run(
                    &session,
                    &exec,
                    &format!("INSERT INTO {PG_TABLE} (collection, id, text, metadata, embedding) VALUES ($1, $2, $3, $4::jsonb, $5::vector) ON CONFLICT (collection, id) DO UPDATE SET text = EXCLUDED.text, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding, updated_at = now()"),
                    &[json!(collection), json!(doc.id), json!(doc.text), json!(doc.metadata.to_string()), json!(vector_literal(&doc.vector))],
                )
                .await?;
            }
        }
        _ => {
            let (workspace, collection_name, path) = (ctx.run.workspace_id.clone(), collection.clone(), ctx.run.host.vectors_path());
            let owned: Vec<Doc> = docs.iter().map(|(_, doc)| doc.clone()).collect();
            tokio::task::spawn_blocking(move || {
                let mut conn = local::open(&path)?;
                local::upsert(&mut conn, &workspace, &collection_name, &owned)
            })
            .await
            .map_err(|e| NodeError::failed(e.to_string()))?
            .map_err(NodeError::Failed)?;
        }
    }
    ctx.log(LogStream::Info, &format!("{} piece(s) stored in {collection} ({dims} dimensions)", docs.len()));
    let mut per_item: Vec<(usize, Vec<String>)> = Vec::new();
    for (index, doc) in &docs {
        match per_item.last_mut() {
            Some((last, ids)) if last == index => ids.push(doc.id.clone()),
            _ => per_item.push((*index, vec![doc.id.clone()])),
        }
    }
    Ok(vec![per_item.into_iter().map(|(index, ids)| wrap(index, json!({"collection": collection, "stored": ids.len(), "ids": ids, "dimensions": dims}))).collect()])
}

/// The models a provider offers, for the node's model picker: chat models, or embedding ones.
pub async fn list_models(provider: &str, base_url: &str, key: Option<&str>, purpose: &str) -> Result<Vec<String>, String> {
    let provider = provider_id(provider);
    let provider = provider.as_str();
    let base = base_of(provider, base_url)?;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let url = match provider {
        "gemini" => format!("{base}/models?pageSize=1000"),
        "anthropic" => format!("{base}/models?limit=1000"),
        "ollama" => format!("{base}/api/tags"),
        _ => format!("{base}/models"),
    };
    let response = signed(http.get(&url), provider, key).send().await.map_err(|e| format!("Could not reach the provider: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("The provider answered {}: {}", status.as_u16(), crate::oauth::describe(status, &body)));
    }
    let answer: Value = serde_json::from_str(&body).map_err(|_| "The provider did not answer JSON".to_string())?;
    Ok(models_in(provider, &answer, purpose))
}

pub fn models_in(provider: &str, answer: &Value, purpose: &str) -> Vec<String> {
    let embed = purpose == "embed";
    let mut names: Vec<String> = match provider {
        "gemini" => answer["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| {
                let methods: Vec<&str> = m["supportedGenerationMethods"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                if embed { methods.iter().any(|x| x.contains("mbed")) } else { methods.contains(&"generateContent") }
            })
            .filter_map(|m| m["name"].as_str().map(|n| n.trim_start_matches("models/").to_string()))
            .collect(),
        "ollama" => answer["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(str::to_string)).collect(),
        _ => {
            let ids = answer["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string));
            let skip = ["tts", "whisper", "dall-e", "moderation", "transcribe", "image", "audio", "realtime", "sora"];
            ids.filter(|id| {
                let lower = id.to_ascii_lowercase();
                if embed { lower.contains("embed") } else { provider == "anthropic" || (!lower.contains("embed") && !skip.iter().any(|s| lower.contains(s))) }
            })
            .collect()
        }
    };
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_provider_is_asked_its_own_way_and_read_back_the_same() {
        let openai = chat_body("openai", "gpt-x", "Sé breve", "Hola", Some(&json!({"type": "object"})), Some(0.2), 100);
        assert_eq!((openai["max_completion_tokens"].as_u64(), openai["messages"][0]["role"].as_str()), (Some(100), Some("system")));
        assert_eq!(openai["response_format"]["type"], "json_schema");
        let compatible = chat_body("compatible", "llama", "", "Hola", Some(&json!({})), None, 50);
        assert!(compatible.get("response_format").is_none() && compatible["max_tokens"] == 50 && compatible.get("temperature").is_none());
        let anthropic = chat_body("anthropic", "claude-sonnet-5-5", "Sé breve", "Hola", None, Some(1.5), 200);
        assert_eq!((anthropic["system"].as_str(), anthropic["temperature"].as_f64()), (Some("Sé breve"), Some(1.0)));
        let gemini = chat_body("gemini", "gemini-x", "", "Hola", Some(&json!({})), Some(0.0), 10);
        assert_eq!(gemini["generationConfig"]["responseMimeType"], "application/json");

        let read = read_answer("anthropic", &json!({"content": [{"type": "text", "text": "Ho"}, {"type": "text", "text": "la"}], "model": "m", "usage": {"input_tokens": 3, "output_tokens": 2}, "stop_reason": "max_tokens"}));
        assert_eq!((read.text.as_str(), read.input_tokens, read.cut), ("Hola", 3, true));
        let read = read_answer("gemini", &json!({"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 1}}));
        assert_eq!((read.text.as_str(), read.output_tokens, read.cut), ("ok", 1, false));
        let read = read_answer("openai", &json!({"choices": [{"message": {"content": "sí"}, "finish_reason": "length"}], "usage": {"prompt_tokens": 9, "completion_tokens": 5}}));
        assert_eq!((read.text.as_str(), read.cut), ("sí", true));
        assert_eq!(chat_url("gemini", "https://g/v1beta", "models/gemini-x"), "https://g/v1beta/models/gemini-x:generateContent");
        assert!(base_of("compatible", "").is_err());
        assert_eq!(base_of("openai", "").unwrap(), "https://api.openai.com/v1");
    }

    #[test]
    fn embeddings_are_asked_in_batches_and_read_in_order() {
        let (url, body) = embed_request("gemini", "https://g/v1beta", "text-embedding-x", &["a".into(), "b".into()]);
        assert!(url.ends_with("/models/text-embedding-x:batchEmbedContents"));
        assert_eq!(body["requests"][1]["content"]["parts"][0]["text"], "b");
        let vectors = read_vectors("openai", &json!({"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]}));
        assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
        assert_eq!(read_vectors("ollama", &json!({"embeddings": [[0.5, 0.5]]})), vec![vec![0.5, 0.5]]);
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert_eq!(cosine(&[1.0, 0.0], &[0.0, 1.0]), 0.0);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
    }

    #[test]
    fn text_is_cut_at_natural_breaks_with_overlap() {
        assert_eq!(chunks("corto", 100, 10), vec!["corto"]);
        assert!(chunks("   ", 0, 0).is_empty());
        let text = "Primer párrafo con algo de texto.\n\nSegundo párrafo, también con texto.\n\nTercero y último párrafo del documento.";
        let pieces = chunks(text, 50, 10);
        assert!(pieces.len() >= 3, "{pieces:?}");
        assert!(pieces.iter().all(|p| p.chars().count() <= 50));
        assert!(pieces[0].ends_with("texto."));
    }

    #[test]
    fn the_local_store_keeps_finds_and_forgets_by_workspace_and_collection() {
        let path = std::env::temp_dir().join(format!("cf-vectors-{}.sqlite", uuid::Uuid::new_v4()));
        let mut conn = local::open(&path).unwrap();
        let doc = |id: &str, vector: Vec<f32>| Doc { id: id.into(), text: format!("texto {id}"), metadata: json!({"id": id}), vector };
        local::upsert(&mut conn, "w1", "docs", &[doc("a#1", vec![1.0, 0.0]), doc("a#2", vec![0.9, 0.1]), doc("b", vec![0.0, 1.0])]).unwrap();
        local::upsert(&mut conn, "w2", "docs", &[doc("z", vec![1.0, 0.0])]).unwrap();
        let hits = local::query(&conn, "w1", "docs", &[1.0, 0.0], 2, 0.0).unwrap();
        assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), vec!["a#1", "a#2"]);
        assert_eq!(local::query(&conn, "w1", "docs", &[1.0, 0.0], 5, 0.5).unwrap().len(), 2);
        // Re-stored: replaced, not duplicated.
        local::upsert(&mut conn, "w1", "docs", &[doc("b", vec![1.0, 0.0])]).unwrap();
        assert_eq!(local::query(&conn, "w1", "docs", &[1.0, 0.0], 9, 0.0).unwrap().len(), 3);
        assert_eq!(local::delete(&conn, "w1", "docs", &["a".into()]).unwrap(), 2);
        assert_eq!(local::query(&conn, "w1", "docs", &[1.0, 0.0], 9, 0.0).unwrap().len(), 1);
        assert_eq!(local::query(&conn, "w2", "docs", &[1.0, 0.0], 9, 0.0).unwrap().len(), 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
        assert_ne!(qdrant_point_id("c", "a"), qdrant_point_id("c", "b"));
        assert_eq!(vector_literal(&[0.5, -1.0]), "[0.5,-1]");
    }

    #[test]
    fn model_lists_are_narrowed_to_what_the_node_asks_for() {
        let openai = json!({"data": [{"id": "gpt-x"}, {"id": "text-embedding-3-small"}, {"id": "whisper-1"}, {"id": "tts-1"}]});
        assert_eq!(models_in("openai", &openai, "chat"), vec!["gpt-x"]);
        assert_eq!(models_in("openai", &openai, "embed"), vec!["text-embedding-3-small"]);
        let gemini = json!({"models": [{"name": "models/gemini-x", "supportedGenerationMethods": ["generateContent"]}, {"name": "models/embed-x", "supportedGenerationMethods": ["embedContent"]}]});
        assert_eq!(models_in("gemini", &gemini, "chat"), vec!["gemini-x"]);
        assert_eq!(models_in("gemini", &gemini, "embed"), vec!["embed-x"]);
    }
}
