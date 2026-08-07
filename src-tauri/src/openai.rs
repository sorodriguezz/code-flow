//! The OpenAI-compatible engine — talks to any endpoint implementing OpenAI's
//! `/v1/chat/completions`, authenticated with an API key rather than a CLI login.
//!
//! Deliberately not "the OpenAI engine": that same API shape is what Azure OpenAI, OpenRouter,
//! Groq, DeepSeek, Together, Fireworks and a local vLLM all expose, so leaving the base URL
//! editable turns one implementation into a door onto most of the hosted-model world. The default
//! endpoint is OpenAI's.
//!
//! `/v1/chat/completions` is used rather than OpenAI's newer Responses API precisely because it's
//! the one every other provider implements — compatibility beats access to OpenAI-only extras here.
//!
//! Shape-wise this is Ollama's sibling: [`Transport::OpenAiCompatible`] instead of a subprocess,
//! and non-agentic (a plain completion endpoint has no tool loop), so "fix with AI" is
//! hidden for it in the UI. Unlike Ollama, the key is a real credential and lives in the OS
//! keyring — `crate::ai::engine_for` reads it and hands it over via the transport.

use serde::Deserialize;
use tokio::process::Command;

use crate::ai::{AiEngine, AiInvocation, AiRun, AiUsage, Transport};

/// OpenAI's own endpoint. The Settings field is free text, so pointing it at a compatible provider
/// is the whole configuration step.
pub const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1";

pub struct OpenAiEngine {
    /// Read from the OS keyring when the engine is constructed. Empty means "not configured yet",
    /// which [`complete`] turns into an actionable message instead of a 401.
    pub api_key: String,
}

impl AiEngine for OpenAiEngine {
    fn id(&self) -> &'static str {
        "openai"
    }

    fn label(&self) -> &'static str {
        "OpenAI"
    }

    fn default_binary(&self) -> &'static str {
        DEFAULT_ENDPOINT
    }

    fn commit_message_model(&self) -> &'static str {
        // No dedicated fast model — which one is cheap depends entirely on the endpoint this is
        // pointed at, so the caller falls back to the configured base model.
        ""
    }

    fn fix_tools(&self) -> Vec<String> {
        Vec::new()
    }

    fn transport(&self) -> Transport {
        Transport::OpenAiCompatible { api_key: self.api_key.clone() }
    }

    fn agentic(&self) -> bool {
        false
    }

    fn resumes_sessions(&self) -> bool {
        false
    }

    // Never called: the transport short-circuits before `run` reaches `build_command`, and
    // `list_models` branches to the HTTP path. Present only to satisfy the trait.
    fn build_command(&self, _binary: &str, _inv: &AiInvocation) -> Command {
        Command::new("openai-http-transport-unused")
    }

    fn interpret(&self, _success: bool, _status_label: &str, _stdout: &str, _stderr: &str) -> Result<AiRun, String> {
        Err("openai uses the HTTP transport, not stdout interpretation".to_string())
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<Choice>,
    /// Echoed back by the API — the resolved id, which can differ from what was asked for when an
    /// alias was used, so it's worth reporting over the configured value.
    #[serde(default)]
    model: Option<String>,
    /// The standard OpenAI usage block. Optional because this engine also drives *OpenAI-compatible*
    /// endpoints, and not every one of them fills it in.
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Default, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: i64,
    #[serde(default)]
    completion_tokens: i64,
    /// Cached prompt tokens, when the endpoint reports the newer nested breakdown.
    #[serde(default)]
    prompt_tokens_details: Option<OpenAiPromptDetails>,
}

#[derive(Default, Deserialize)]
struct OpenAiPromptDetails {
    #[serde(default)]
    cached_tokens: i64,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Extracts the human-readable reason from an OpenAI-style `{"error": {"message": …}}` body,
/// falling back to the raw text for endpoints that don't follow the convention.
fn error_detail(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string())
}

/// Runs one completion. The system prompt, the ask and the stdin payload become chat messages, in
/// that order — same composition the CLI engines do internally.
pub async fn complete(base_url: &str, api_key: &str, inv: &AiInvocation<'_>) -> Result<AiRun, String> {
    if api_key.trim().is_empty() {
        return Err("Falta la API key. Añádela en Ajustes › Asistente de IA › Proveedores.".to_string());
    }
    let model = inv.model.trim();
    if model.is_empty() {
        return Err("Selecciona un modelo en Ajustes (por ejemplo gpt-5).".to_string());
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

    let res = reqwest::Client::new()
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .bearer_auth(api_key)
        .json(&serde_json::json!({ "model": model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con {base_url}: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let detail = error_detail(&res.text().await.unwrap_or_default());
        return Err(match status.as_u16() {
            401 | 403 => format!("La API key fue rechazada ({status}): {detail}"),
            // Rate limits and exhausted credit both land here; the wording is what
            // `crate::ai::quota_signal` matches on to show the friendly banner.
            429 => format!("Rate limit / quota exceeded: {detail}"),
            404 => format!("El modelo '{model}' no existe en este endpoint: {detail}"),
            _ => format!("{status}: {detail}"),
        });
    }

    let parsed: ChatResponse =
        res.json().await.map_err(|e| format!("respuesta inesperada de {base_url}: {e}"))?;
    let text = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("El proveedor no devolvió contenido".to_string());
    }
    // No session: each request stands alone (see `resumes_sessions`), so the caller re-sends the
    // context every turn and the id is only bookkeeping for the activity log.
    // Cached tokens are reported *inside* the prompt total, unlike Claude's, so they are taken back
    // out — otherwise one turn would be counted once as input and once again as cache.
    let usage = parsed.usage.as_ref().map(|u| {
        let cached = u.prompt_tokens_details.as_ref().map_or(0, |d| d.cached_tokens);
        AiUsage {
            input_tokens: (u.prompt_tokens - cached).max(0),
            output_tokens: u.completion_tokens,
            cache_read_tokens: cached,
            cache_write_tokens: 0,
            // The API prices nothing; only a bill does.
            cost_usd: None,
        }
    });
    Ok(AiRun {
        text,
        session_id: None,
        model: parsed.model.or_else(|| Some(model.to_string())),
        usage: usage.filter(|u| !u.is_empty()),
    })
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// `/v1/models` lists everything the key can reach — embeddings, speech, images, moderation — but
/// only chat models can be driven through `/v1/chat/completions`, and an unfiltered list buries
/// `gpt-5` under `dall-e-3` in the picker. Excluding known non-chat families (rather than
/// allow-listing chat ones) keeps new model names working the day they ship.
fn is_chat_model(id: &str) -> bool {
    const NON_CHAT: [&str; 16] = [
        "embedding",
        "tts",
        "whisper",
        "transcribe",
        "dall-e",
        "moderation",
        "audio",
        "realtime",
        "image",
        "sora",
        "similarity",
        "-search-",
        "-edit-",
        "davinci",
        "babbage",
        "curie",
    ];
    let lower = id.to_lowercase();
    !NON_CHAT.iter().any(|m| lower.contains(m))
}

/// Every chat model id the endpoint reports, via `GET /v1/models`. Errors propagate so this
/// doubles as the reachability + credential check behind [`crate::ai::probe`].
pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let res = reqwest::Client::new()
        .get(format!("{}/models", base_url.trim_end_matches('/')))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("{base_url}: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("{base_url}: {}", error_detail(&res.text().await.unwrap_or_default())));
    }
    let parsed = res.json::<ModelsResponse>().await.map_err(|e| e.to_string())?;
    let mut ids: Vec<String> =
        parsed.data.into_iter().map(|m| m.id).filter(|id| is_chat_model(id)).collect();
    // The API returns them unordered and the list is long; alphabetical keeps the picker navigable.
    ids.sort();
    Ok(ids)
}

/// Model list for the Settings picker. Degrades to empty (the UI falls back to its curated list)
/// rather than erroring — the status badge is what reports an unreachable or unauthorized endpoint.
pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(fetch_models(base_url, api_key).await.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulls_the_message_out_of_an_openai_error_body() {
        let body = r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}"#;
        assert_eq!(error_detail(body), "You exceeded your current quota");
    }

    #[test]
    fn falls_back_to_the_raw_body_when_it_is_not_openai_shaped() {
        assert_eq!(error_detail("  Bad Gateway  "), "Bad Gateway");
    }

    #[test]
    fn keeps_chat_models_including_ones_that_do_not_exist_yet() {
        for id in ["gpt-5", "gpt-5.6-sol", "o3", "chatgpt-4o-latest", "deepseek-chat"] {
            assert!(is_chat_model(id), "{id} should be offered");
        }
    }

    #[test]
    fn drops_models_that_cannot_run_a_chat_completion() {
        for id in [
            "text-embedding-3-large",
            "dall-e-3",
            "whisper-1",
            "tts-1-hd",
            "omni-moderation-latest",
            "gpt-4o-realtime-preview",
            "gpt-4o-audio-preview",
        ] {
            assert!(!is_chat_model(id), "{id} should be filtered out");
        }
    }
}
