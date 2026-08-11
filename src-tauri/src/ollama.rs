//! The local Ollama engine — talks to a locally-running Ollama server over HTTP instead of
//! spawning a CLI like the other engines.
//!
//! Why it's shaped differently: every other engine is a headless CLI subprocess driven through
//! [`crate::ai::run`]. Ollama is an HTTP server (`http://localhost:11434` by default), so it
//! declares [`Transport::Http`] and `run`/`list_models` hand off to the functions here instead of
//! building a `Command`. The engine's `binary` slot (the Settings "endpoint" field) carries the
//! base URL rather than a path.
//!
//! What it's good for: the one-shot text operations — commit messages, PR descriptions, pre-commit
//! analysis, PR review, conflict resolution. What it can't do: agentic tool loops ("fix with AI")
//! because a plain completion model has no write tools — [`agentic`] returns false so the
//! UI hides those features rather than offering something that wouldn't work.

use serde::Deserialize;
use tokio::process::Command;

use crate::ai::{AiEngine, AiInvocation, AiRun, AiUsage, Transport};

/// Where Ollama listens out of the box. Shown as the default in Settings; the user can point it at
/// a remote/alternate host by editing the endpoint field.
pub const DEFAULT_ENDPOINT: &str = "http://localhost:11434";

/// One client for the process, cloned per call.
///
/// Every request here used to build its own `Client::new()`, which with rustls means constructing a
/// fresh `ClientConfig` and root certificate store — and, worse, a fresh empty connection pool, so
/// nothing was ever reused between the probe, the model list and the completion. Cloning is free
/// (a `reqwest::Client` is an `Arc` around the inner state) and the clone shares the pool.
///
/// One shared client is safe here because nothing varies the transport per request: no timeout
/// override (a local model can legitimately think for minutes, so there deliberately isn't one),
/// no proxy, no certificate trust toggle.
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

pub struct OllamaEngine;

impl AiEngine for OllamaEngine {
    fn id(&self) -> &'static str {
        "ollama"
    }

    fn label(&self) -> &'static str {
        "Ollama"
    }

    fn default_binary(&self) -> &'static str {
        DEFAULT_ENDPOINT
    }

    fn commit_message_model(&self) -> &'static str {
        // No dedicated fast model — the caller falls back to the configured base model (Ollama
        // requires an explicit model on every request, so there's no "let the server pick").
        ""
    }

    fn fix_tools(&self) -> Vec<String> {
        Vec::new()
    }

    fn transport(&self) -> Transport {
        Transport::Ollama
    }

    fn agentic(&self) -> bool {
        false
    }

    fn resumes_sessions(&self) -> bool {
        false
    }

    // Never called: `Transport::Http` short-circuits before `run` reaches `build_command`, and
    // `list_models` branches to the HTTP path. Present only to satisfy the trait.
    fn build_command(&self, _binary: &str, _inv: &AiInvocation) -> Command {
        Command::new("ollama-http-transport-unused")
    }

    fn interpret(&self, _success: bool, _status_label: &str, _stdout: &str, _stderr: &str) -> Result<AiRun, String> {
        Err("ollama uses the HTTP transport, not stdout interpretation".to_string())
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    message: ChatMessage,
    /// Tokens of the prompt Ollama actually evaluated — cache hits excluded, since a local server
    /// re-reads the whole context every turn and has no provider cache to hit.
    #[serde(default)]
    prompt_eval_count: i64,
    #[serde(default)]
    eval_count: i64,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

/// Runs one completion against Ollama's `/api/chat`. Composes the invocation's system prompt, ask
/// and stdin payload into chat messages. Unlike the CLIs, Ollama requires an explicit model — an
/// empty one is a clear, actionable error rather than a confusing server rejection.
pub async fn complete(base_url: &str, inv: &AiInvocation<'_>) -> Result<AiRun, String> {
    let model = inv.model.trim();
    if model.is_empty() {
        return Err(
            "Selecciona un modelo de Ollama en Ajustes (por ejemplo qwen2.5-coder o llama3.1).".to_string(),
        );
    }

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(system) = inv.system_prompt {
        if !system.trim().is_empty() {
            messages.push(serde_json::json!({ "role": "system", "content": system }));
        }
    }
    let mut user = String::from(inv.prompt);
    if !inv.stdin_content.trim().is_empty() || !inv.skills_note.is_empty() {
        user.push_str("\n\n");
        user.push_str(&inv.skills_note);
        user.push_str(inv.stdin_content);
    }
    messages.push(serde_json::json!({ "role": "user", "content": user }));

    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": false });
    // The one thing a local server can do that a CLI cannot: `format: "json"` constrains decoding
    // to a valid JSON document, so the stages that parse the answer get one. Without it, the usual
    // failure with a small local model is not malformed JSON — it is prose ("Hola, ¿en qué puedo
    // ayudarte?"), which no repair pass can rescue because there is nothing in it to repair.
    //
    // Only sent when the caller says the answer must be JSON: forcing it on a commit message or a
    // chat turn would turn a sentence into an object nobody reads.
    if inv.expects_json {
        body["format"] = serde_json::json!("json");
    }

    let res = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!("No se pudo conectar a Ollama en {base_url}: {e}. ¿Está corriendo `ollama serve`?")
        })?;

    let status = res.status();
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        if status.as_u16() == 404 {
            return Err(format!(
                "El modelo '{model}' no está disponible en Ollama. Descárgalo con `ollama pull {model}`."
            ));
        }
        return Err(format!("Ollama devolvió {status}: {detail}"));
    }

    let parsed: ChatResponse =
        res.json().await.map_err(|e| format!("respuesta inesperada de Ollama: {e}"))?;
    let text = parsed.message.content.trim().to_string();
    if text.is_empty() {
        return Err("Ollama no devolvió contenido".to_string());
    }
    // Ollama holds no server-side conversation, but the app still needs an id: it's what groups a
    // conversation's turns in the activity log (entries without one are dropped there). Reuse the
    // caller's so every turn of one chat shares an id; mint one when starting a new conversation.
    let session_id = inv
        .resume_session_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("ollama-{}", uuid::Uuid::new_v4()));
    // Local inference reports tokens and, of course, no price. `None` rather than `Some(0.0)`:
    // the meter's distinction is "reported" against "not reported", and a zero here would put
    // Ollama in the same column as a paid engine that happened to bill nothing.
    let usage = AiUsage {
        input_tokens: parsed.prompt_eval_count,
        output_tokens: parsed.eval_count,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: None,
    };
    Ok(AiRun {
        text,
        session_id: Some(session_id),
        model: Some(model.to_string()),
        usage: Some(usage).filter(|u| !u.is_empty()),
    })
}

#[derive(Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    name: String,
}

/// The models installed in the local Ollama instance, via `/api/tags`. Errors are propagated, so
/// this is also the reachability check behind [`crate::ai::probe`].
pub async fn fetch_tags(base_url: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let res = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("{base_url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{base_url}: HTTP {}", res.status()));
    }
    let parsed = res.json::<TagsResponse>().await.map_err(|e| e.to_string())?;
    Ok(parsed.models.into_iter().map(|m| m.name).collect())
}

/// Model list for the Settings picker. Degrades to empty (the UI then shows its curated fallback)
/// rather than erroring when Ollama isn't reachable — the picker shouldn't hard-fail just because
/// the server is down; the status badge is what reports that.
pub async fn list_models(base_url: &str) -> Result<Vec<String>, String> {
    Ok(fetch_tags(base_url).await.unwrap_or_default())
}
