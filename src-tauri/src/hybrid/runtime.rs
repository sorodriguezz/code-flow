//! Turning the stored choices into "this server, this model, this window" — the one resolution
//! the settings pane, **Probar** and the executor all share, so the three can never disagree about
//! which model a task will reach.

use std::sync::Arc;

use super::budget::{self, Budget, Delegate, Fit, Machine};
use super::config::{self, Settings};
use super::local_llm::{self, BackendKind, Endpoint, LocalModel, ModelDetails};
use crate::localai::{catalogue, engine, exec_catalogue, executor, models};

/// Which servers answer on their default ports right now.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct Detected {
    pub ollama: bool,
    pub ollama_version: Option<String>,
    pub lmstudio: bool,
}

/// Asks both well-known servers at once. Two short timeouts, run concurrently, so a machine with
/// neither costs one timeout rather than two.
pub async fn detect(settings: &Settings) -> Detected {
    let ollama = Endpoint::new(BackendKind::Ollama, &settings.url_for(BackendKind::Ollama), None);
    let lmstudio = Endpoint::new(BackendKind::Openai, &settings.url_for(BackendKind::Openai), config::api_key());
    let (ollama, lmstudio) = tokio::join!(local_llm::ping(&ollama), local_llm::ping(&lmstudio));
    Detected {
        ollama: ollama.is_ok(),
        ollama_version: ollama.ok().flatten(),
        lmstudio: lmstudio.is_ok(),
    }
}

/// The backend to use: the user's choice, or — never having chosen — the first server that is
/// already running, and the bundled engine when none is. Someone who has Ollama open with models
/// in it should not have to download five gigabytes to try this.
pub fn pick_backend(settings: &Settings, detected: &Detected) -> BackendKind {
    if let Some(kind) = settings.backend {
        return kind;
    }
    if detected.ollama {
        BackendKind::Ollama
    } else if detected.lmstudio {
        BackendKind::Openai
    } else {
        BackendKind::Bundled
    }
}

/// The model to use from `available`: the stored choice when it is still there, else the first
/// coding model, else the first one.
pub fn pick_model(chosen: Option<&str>, available: &[LocalModel]) -> Option<String> {
    if let Some(chosen) = chosen {
        if available.iter().any(|m| m.id == chosen) || available.is_empty() {
            return Some(chosen.to_string());
        }
    }
    let usable: Vec<&LocalModel> = available.iter().filter(|m| !m.id.to_ascii_lowercase().contains("embed")).collect();
    usable
        .iter()
        .find(|m| m.id.to_ascii_lowercase().contains("coder"))
        .or_else(|| usable.first())
        .map(|m| m.id.clone())
}

/// Everything resolved for the current settings. `model` is `None` when there is nothing to run.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub kind: BackendKind,
    pub url: String,
    pub reachable: bool,
    pub server_version: Option<String>,
    /// English, for logs and tooltips.
    pub error: Option<String>,
    /// What `error` is, for the UI to say in the reader's language: a `LocalError::code`, or
    /// `engine-missing` | `not-downloaded` | `no-models`.
    pub error_code: Option<&'static str>,
    pub available: Vec<LocalModel>,
    pub model: Option<String>,
    pub details: ModelDetails,
    pub ctx: u32,
    pub ctx_options: Vec<u32>,
    pub budget: Budget,
    pub machine: Machine,
    pub need_bytes: Option<u64>,
    pub also_resident: u64,
    pub fit: Fit,
    pub delegate: Delegate,
    pub delegate_suggested: Delegate,
}

/// Resolves `settings` against what is actually running. Network calls are short and bounded; a
/// server that does not answer is a field (`reachable`, `error`), never an `Err`.
pub async fn resolve(settings: &Settings, detected: &Detected) -> Resolved {
    let kind = pick_backend(settings, detected);
    let url = settings.url_for(kind);
    let machine = budget::machine();
    let also_resident = completion_engine_bytes();

    let (reachable, server_version, error, available, model, details) = match kind {
        BackendKind::Bundled => {
            let available: Vec<LocalModel> = exec_catalogue::EXEC_CATALOGUE
                .iter()
                .map(|entry| LocalModel {
                    id: entry.spec.id.to_string(),
                    size_bytes: Some(entry.spec.size_bytes),
                    params: Some(entry.spec.params.to_string()),
                    quant: None,
                })
                .collect();
            let model = settings
                .model_for(kind)
                .filter(|id| exec_catalogue::find(id).is_some())
                .unwrap_or_else(|| exec_catalogue::DEFAULT_EXEC_MODEL_ID.to_string());
            let entry = exec_catalogue::find(&model);
            let installed = entry.is_some_and(|e| models::is_installed(&e.spec));
            let error = if !engine::is_available() {
                Some(("engine-missing", "This install is missing its local model engine (llama-server).".to_string()))
            } else if !installed {
                Some(("not-downloaded", format!("{} isn't downloaded yet.", entry.map(|e| e.spec.label).unwrap_or("The model"))))
            } else {
                None
            };
            let details = entry
                .map(|e| ModelDetails {
                    max_ctx: Some(e.max_ctx),
                    ctx_fixed_by_server: false,
                    kv_bytes_per_token: Some(e.kv_bytes_per_token),
                    params_b: Some(e.params_b),
                    size_bytes: Some(e.spec.size_bytes),
                    thinking: false,
                })
                .unwrap_or_default();
            (error.is_none(), None, error, available, Some(model), details)
        }
        BackendKind::Ollama | BackendKind::Openai => {
            let endpoint = Endpoint::new(kind, &url, if kind == BackendKind::Openai { config::api_key() } else { None });
            match local_llm::ping(&endpoint).await {
                Err(failure) => (
                    false,
                    None,
                    Some((failure.code(), failure.sentence())),
                    Vec::new(),
                    settings.model_for(kind),
                    ModelDetails::default(),
                ),
                Ok(version) => {
                    let (available, list_error) = match local_llm::list_models(&endpoint).await {
                        Ok(list) => (list, None),
                        Err(failure) => (Vec::new(), Some((failure.code(), failure.sentence()))),
                    };
                    let model = pick_model(settings.model_for(kind).as_deref(), &available);
                    let error = list_error.or_else(|| {
                        if available.is_empty() {
                            Some(("no-models", "The server answers but lists no models.".to_string()))
                        } else {
                            None
                        }
                    });
                    let mut details = match &model {
                        Some(model) => local_llm::model_details(&endpoint, model).await,
                        None => ModelDetails::default(),
                    };
                    if details.size_bytes.is_none() {
                        details.size_bytes = model.as_ref().and_then(|m| available.iter().find(|a| &a.id == m)).and_then(|a| a.size_bytes);
                    }
                    if details.params_b.is_none() {
                        details.params_b = model
                            .as_ref()
                            .and_then(|m| available.iter().find(|a| &a.id == m))
                            .and_then(|a| a.params.as_deref())
                            .and_then(local_llm::parse_params_b);
                    }
                    (true, version, error, available, model, details)
                }
            }
        }
    };

    let ctx_options = if details.ctx_fixed_by_server {
        details.max_ctx.map(|ctx| vec![ctx]).unwrap_or_else(|| budget::ctx_options(None))
    } else {
        budget::ctx_options(details.max_ctx)
    };
    let suggested = if details.ctx_fixed_by_server {
        details.max_ctx.unwrap_or(8_192)
    } else {
        budget::suggest_ctx(details.size_bytes, details.kv_bytes_per_token, details.max_ctx, also_resident, &machine)
    };
    let ctx = match settings.ctx {
        // A server that fixes its own window wins over a stored choice: asking for more than it
        // loaded is how prompts get cut.
        _ if details.ctx_fixed_by_server => suggested,
        Some(chosen) => details.max_ctx.map_or(chosen, |max| chosen.min(max)),
        None => suggested,
    };
    let need_bytes = match (details.size_bytes, details.kv_bytes_per_token) {
        (Some(size), Some(kv)) => Some(budget::memory_need(size, kv, ctx)),
        _ => None,
    };
    let fit = need_bytes.map_or(Fit::Unknown, |need| budget::fit(need, also_resident, &machine));
    let delegate_suggested = budget::suggest_delegate(details.params_b);
    let (error_code, error) = match error {
        Some((code, sentence)) => (Some(code), Some(sentence)),
        None => (None, None),
    };
    Resolved {
        kind,
        url,
        reachable,
        server_version,
        error,
        error_code,
        available,
        model,
        ctx,
        ctx_options,
        budget: budget::budget_for(ctx),
        machine,
        need_bytes,
        also_resident,
        fit,
        delegate: settings.delegate.unwrap_or(delegate_suggested),
        delegate_suggested,
        details,
    }
}

/// The completion engine's model, when it is loaded: it shares the same memory as the executor.
pub fn completion_engine_bytes() -> u64 {
    match engine::status() {
        engine::Status::Ready { model_id } | engine::Status::Starting { model_id } => {
            catalogue::find(&model_id).map_or(0, |spec| spec.size_bytes)
        }
        _ => 0,
    }
}

/// A live connection to the chosen model: the endpoint, plus the bundled engine's handle when the
/// bundled engine is what serves it (held so the engine is counted as in use).
pub struct Live {
    pub endpoint: Endpoint,
    pub model: String,
    pub engine: Option<Arc<executor::ExecEngine>>,
}

/// Opens `kind`/`url`/`model` for requests, starting the bundled engine (and waiting for it) when
/// that is the backend.
pub async fn connect(kind: BackendKind, url: &str, model: &str, ctx: u32) -> Result<Live, String> {
    match kind {
        BackendKind::Bundled => {
            let entry = exec_catalogue::find(model).ok_or_else(|| format!("Unknown local model: {model}"))?;
            let launch = executor::Launch { model_id: model.to_string(), ctx, no_reasoning: true };
            let engine = executor::ensure_ready(entry, models::path_of(&entry.spec), launch).await?;
            Ok(Live {
                endpoint: Endpoint::new(BackendKind::Bundled, &engine.base_url(), None),
                model: model.to_string(),
                engine: Some(engine),
            })
        }
        BackendKind::Ollama => Ok(Live { endpoint: Endpoint::new(kind, url, None), model: model.to_string(), engine: None }),
        BackendKind::Openai => Ok(Live { endpoint: Endpoint::new(kind, url, config::api_key()), model: model.to_string(), engine: None }),
    }
}

/// Against real servers, so ignored by default. Run with
/// `CODEFLOW_LIVE_OLLAMA=1 cargo test --lib -- --ignored hybrid::runtime::live` while Ollama serves
/// `qwen2.5-coder:7b`; set `CODEFLOW_LIVE_GGUF` to a GGUF path to exercise the bundled engine too.
#[cfg(test)]
mod live {
    use super::*;
    use crate::hybrid::local_llm::ChatRequest;

    fn long_prompt() -> String {
        let mut prompt = String::from("```ts\n");
        let mut i = 0;
        while budget::estimate_tokens(&prompt) < 6_000 {
            prompt.push_str(&format!("export const value{i} = normalize(\"entry-{i}\", {i});\n"));
            i += 1;
        }
        prompt.push_str("```\nWhat is the name of the last constant declared above? Answer with the name only.");
        prompt
    }

    fn request<'a>(prompt: &'a str, num_ctx: Option<u32>) -> ChatRequest<'a> {
        ChatRequest {
            model: "qwen2.5-coder:7b",
            system: "Answer briefly.",
            user: prompt,
            num_ctx,
            max_tokens: 32,
            temperature: 0.0,
            think: None,
            keep_alive: None,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn ollama_native_keeps_the_prompt_and_v1_is_caught_cutting_it() {
        if std::env::var("CODEFLOW_LIVE_OLLAMA").is_err() {
            return;
        }
        let prompt = long_prompt();
        let sent = budget::estimate_tokens(&prompt);

        let native = Endpoint::new(BackendKind::Ollama, "http://127.0.0.1:11434", None);
        let outcome = local_llm::chat(&native, &request(&prompt, Some(16_384)), |_| {}, std::future::pending::<()>())
            .await
            .expect("native chat");
        eprintln!("native: sent≈{sent} processed={:?} answer={:?}", outcome.prompt_tokens, outcome.text.trim());
        assert!(!budget::truncated(sent, outcome.prompt_tokens), "num_ctx must keep the whole prompt");

        let compat = Endpoint::new(BackendKind::Openai, "http://127.0.0.1:11434/v1", None);
        let outcome = local_llm::chat(&compat, &request(&prompt, None), |_| {}, std::future::pending::<()>())
            .await
            .expect("compat chat");
        eprintln!("/v1: sent≈{sent} processed={:?} answer={:?}", outcome.prompt_tokens, outcome.text.trim());
        assert!(budget::truncated(sent, outcome.prompt_tokens), "Ollama's /v1 cuts to its default window");

        let details = local_llm::model_details(&native, "qwen2.5-coder:7b").await;
        assert_eq!(details.kv_bytes_per_token, Some(57_344));
        assert_eq!(details.max_ctx, Some(32_768));
    }

    #[tokio::test]
    #[ignore]
    async fn the_bundled_executor_serves_chat_with_an_exact_window() {
        let Ok(gguf) = std::env::var("CODEFLOW_LIVE_GGUF") else { return };
        let entry = exec_catalogue::find("qwen2.5-coder-7b-instruct").unwrap();
        let launch = executor::Launch { model_id: entry.spec.id.to_string(), ctx: 16_384, no_reasoning: true };
        let engine = executor::ensure_ready(entry, std::path::PathBuf::from(gguf), launch).await.expect("engine");
        let endpoint = Endpoint::new(BackendKind::Bundled, &engine.base_url(), None);

        let details = local_llm::model_details(&endpoint, entry.spec.id).await;
        assert_eq!(details.max_ctx, Some(16_384), "/props reports the window it was launched with");
        assert!(details.ctx_fixed_by_server);

        let prompt = long_prompt();
        let exact = local_llm::count_tokens(&endpoint, &prompt).await.expect("/tokenize");
        let _guard = engine.begin();
        let outcome = local_llm::chat(
            &endpoint,
            &ChatRequest { model: entry.spec.id, ..request(&prompt, None) },
            |_| {},
            std::future::pending::<()>(),
        )
        .await
        .expect("bundled chat");
        eprintln!("bundled: tokenized={exact} processed={:?} answer={:?}", outcome.prompt_tokens, outcome.text.trim());
        assert!(!budget::truncated(exact, outcome.prompt_tokens));
        drop(_guard);
        executor::shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            backend: None,
            url_ollama: None,
            url_openai: None,
            model_bundled: None,
            model_ollama: None,
            model_openai: None,
            ctx: None,
            delegate: None,
            on_fail: config::OnFail::Review,
            unload: true,
            review_mode: config::ReviewMode::Fix,
        }
    }

    #[test]
    fn a_running_server_is_preferred_over_downloading() {
        let mut detected = Detected::default();
        assert_eq!(pick_backend(&settings(), &detected), BackendKind::Bundled);
        detected.lmstudio = true;
        assert_eq!(pick_backend(&settings(), &detected), BackendKind::Openai);
        detected.ollama = true;
        assert_eq!(pick_backend(&settings(), &detected), BackendKind::Ollama);
        let chosen = Settings { backend: Some(BackendKind::Bundled), ..settings() };
        assert_eq!(pick_backend(&chosen, &detected), BackendKind::Bundled, "a choice beats detection");
    }

    #[test]
    fn the_first_coding_model_is_picked_and_embeddings_never_are() {
        let available = [
            LocalModel { id: "nomic-embed-text:latest".into(), ..Default::default() },
            LocalModel { id: "qwen2.5:7b-instruct".into(), ..Default::default() },
            LocalModel { id: "qwen2.5-coder:7b".into(), ..Default::default() },
            LocalModel { id: "qwen3:8b".into(), ..Default::default() },
        ];
        assert_eq!(pick_model(None, &available).as_deref(), Some("qwen2.5-coder:7b"));
        assert_eq!(pick_model(Some("qwen3:8b"), &available).as_deref(), Some("qwen3:8b"));
        assert_eq!(pick_model(Some("gone:1b"), &available).as_deref(), Some("qwen2.5-coder:7b"));
        assert_eq!(pick_model(Some("kept"), &[]).as_deref(), Some("kept"), "an unreachable list keeps the choice");
        assert_eq!(pick_model(None, &[]), None);
    }
}
