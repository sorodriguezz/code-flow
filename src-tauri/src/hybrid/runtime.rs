//! Turning the stored choices into "this server, this model, this window" — the one resolution
//! the settings pane, **Probar** and the executor all share, so the three can never disagree about
//! which model a task will reach.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::budget::{self, Budget, Delegate, Fit, Machine};
use super::config::{self, Settings};
use super::hardware;
use super::local_llm::{self, BackendKind, Endpoint, LocalError, LocalModel, ModelDetails};
use crate::localai::{catalogue, engine, exec_catalogue, executor, models};

/// How old a server's answer may be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    /// Ask now: the pane opening, a server or URL just chosen, a run about to start.
    Now,
    /// An answer from the last few seconds will do — everything else the pane re-resolves after (a
    /// window, a model, a checkbox) changes nothing about what a server is running.
    Recent,
}

/// A server's answer, kept for a moment.
///
/// The settings pane re-resolves after every click, and the new-task dialog every time the objective
/// settles; neither changes what any server runs. Asking again each time made every click wait on
/// two pings, a listing and `/api/show` — and on Windows, on two seconds for each port nobody
/// listens on (see `local_llm::LOOPBACK_DISCOVERY_CONNECT`).
struct Remembered<T> {
    at: Instant,
    value: T,
}

type Memo<T> = Mutex<HashMap<String, Remembered<T>>>;

/// How long an answer stands. A server's silence stands for less: someone who has just started
/// Ollama should not wait half a minute for the pane to notice.
const ANSWER_FOR: Duration = Duration::from_secs(30);
const SILENCE_FOR: Duration = Duration::from_secs(5);

fn pings() -> &'static Memo<Result<Option<String>, LocalError>> {
    static MEMO: OnceLock<Memo<Result<Option<String>, LocalError>>> = OnceLock::new();
    MEMO.get_or_init(Default::default)
}

fn listings() -> &'static Memo<Result<Vec<LocalModel>, LocalError>> {
    static MEMO: OnceLock<Memo<Result<Vec<LocalModel>, LocalError>>> = OnceLock::new();
    MEMO.get_or_init(Default::default)
}

fn descriptions() -> &'static Memo<ModelDetails> {
    static MEMO: OnceLock<Memo<ModelDetails>> = OnceLock::new();
    MEMO.get_or_init(Default::default)
}

fn recall<T: Clone>(memo: &Memo<T>, key: &str, lasts: impl Fn(&T) -> Duration) -> Option<T> {
    let memo = memo.lock().ok()?;
    let known = memo.get(key)?;
    (known.at.elapsed() < lasts(&known.value)).then(|| known.value.clone())
}

fn remember<T>(memo: &Memo<T>, key: String, value: T) {
    if let Ok(mut memo) = memo.lock() {
        memo.insert(key, Remembered { at: Instant::now(), value });
    }
}

fn lasts<T>(answer: &Result<T, LocalError>) -> Duration {
    if answer.is_ok() {
        ANSWER_FOR
    } else {
        SILENCE_FOR
    }
}

/// What a request to `endpoint` is: its kind, its URL, and the key it carries — a different key can
/// be the difference between a 401 and a listing. The key itself is hashed, never kept.
fn endpoint_key(endpoint: &Endpoint) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    endpoint.api_key.hash(&mut hasher);
    format!("{}|{}|{:x}", endpoint.kind.as_str(), endpoint.base_url, hasher.finish())
}

async fn ping(endpoint: &Endpoint, freshness: Freshness) -> Result<Option<String>, LocalError> {
    let key = endpoint_key(endpoint);
    if freshness == Freshness::Recent {
        if let Some(known) = recall(pings(), &key, lasts) {
            return known;
        }
    }
    let answer = local_llm::ping(endpoint).await;
    remember(pings(), key, answer.clone());
    answer
}

async fn list_models(endpoint: &Endpoint, freshness: Freshness) -> Result<Vec<LocalModel>, LocalError> {
    let key = endpoint_key(endpoint);
    if freshness == Freshness::Recent {
        if let Some(known) = recall(listings(), &key, lasts) {
            return known;
        }
    }
    let answer = local_llm::list_models(endpoint).await;
    remember(listings(), key, answer.clone());
    answer
}

async fn model_details(endpoint: &Endpoint, model: &str, freshness: Freshness) -> ModelDetails {
    let key = format!("{}|{model}", endpoint_key(endpoint));
    if freshness == Freshness::Recent {
        if let Some(known) = recall(descriptions(), &key, |_| ANSWER_FOR) {
            return known;
        }
    }
    let details = local_llm::model_details(endpoint, model).await;
    remember(descriptions(), key, details.clone());
    details
}

/// Forgets what every server said: after this app changed what one holds (a pull, a delete) or how
/// it is asked (a key).
pub fn forget_servers() {
    if let Ok(mut memo) = pings().lock() {
        memo.clear();
    }
    if let Ok(mut memo) = listings().lock() {
        memo.clear();
    }
    if let Ok(mut memo) = descriptions().lock() {
        memo.clear();
    }
}

/// Which servers answer on their default ports right now.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct Detected {
    pub ollama: bool,
    pub ollama_version: Option<String>,
    pub lmstudio: bool,
}

/// Asks both well-known servers at once. Two short timeouts, run concurrently, so a machine with
/// neither costs one timeout rather than two.
pub async fn detect(settings: &Settings, freshness: Freshness) -> Detected {
    let ollama = Endpoint::new(BackendKind::Ollama, &settings.url_for(BackendKind::Ollama), None);
    let lmstudio = Endpoint::new(BackendKind::Openai, &settings.url_for(BackendKind::Openai), config::api_key());
    let (ollama, lmstudio) = tokio::join!(ping(&ollama, freshness), ping(&lmstudio, freshness));
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
    /// Which servers answer on their own: asked when no server was chosen (it decides which), and
    /// when the chosen one is silent (to say whether another one is there). Empty otherwise.
    pub detected: Detected,
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
    /// Tokens a second the model is estimated to write here, at `ctx`.
    pub write_tps: Option<f64>,
    pub delegate: Delegate,
    pub delegate_suggested: Delegate,
}

/// Resolves `settings` against what is actually running. Network calls are short and bounded; a
/// server that does not answer is a field (`reachable`, `error`), never an `Err`.
pub async fn resolve(settings: &Settings, freshness: Freshness) -> Resolved {
    let mut detected =
        if settings.backend.is_none() { detect(settings, freshness).await } else { Detected::default() };
    let kind = pick_backend(settings, &detected);
    let url = settings.url_for(kind);
    let machine = hardware::machine().await;

    let (reachable, server_version, error, available, model, details) = match kind {
        BackendKind::Bundled => {
            let available: Vec<LocalModel> = exec_catalogue::EXEC_CATALOGUE
                .iter()
                .map(|entry| LocalModel {
                    id: entry.spec.id.to_string(),
                    size_bytes: Some(entry.spec.size_bytes),
                    params: Some(entry.spec.params.to_string()),
                    quant: None,
                    digest: Some(entry.spec.sha256.to_string()),
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
            } else if entry.is_some_and(|e| e.cuda_only) {
                // The bundled engine is Metal/Vulkan; these weights load only on a CUDA build.
                Some(("needs-cuda", format!("{} runs only on an NVIDIA card, through Ollama.", entry.map(|e| e.spec.label).unwrap_or("This model"))))
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
                    active_share: Some(e.active_share() as f32),
                    thinking: e.thinking,
                    capabilities: std::iter::once("completion")
                        .chain(e.tools.then_some("tools"))
                        .chain(e.thinking.then_some("thinking"))
                        .map(str::to_string)
                        .collect(),
                })
                .unwrap_or_default();
            (error.is_none(), None, error, available, Some(model), details)
        }
        // A server on the internet is not asked anything, not even whether it is there: "local" is
        // this machine or the user's own network (`local_llm::cloud_refusal`), and a pane that went
        // on to list a public server's models would be one click from sending it code.
        BackendKind::Ollama | BackendKind::Openai if local_llm::cloud_refusal(&url, "").is_some() => (
            false,
            None,
            local_llm::cloud_refusal(&url, "").map(|why| ("not-local", format!("{why}."))),
            Vec::new(),
            settings.model_for(kind),
            ModelDetails::default(),
        ),
        BackendKind::Ollama | BackendKind::Openai => {
            let endpoint = Endpoint::new(kind, &url, if kind == BackendKind::Openai { config::api_key() } else { None });
            match ping(&endpoint, freshness).await {
                Err(failure) => (
                    false,
                    None,
                    Some((failure.code(), failure.sentence())),
                    Vec::new(),
                    settings.model_for(kind),
                    ModelDetails::default(),
                ),
                Ok(version) => {
                    let (available, list_error) = match list_models(&endpoint, freshness).await {
                        Ok(list) => (list, None),
                        Err(failure) => (Vec::new(), Some((failure.code(), failure.sentence()))),
                    };
                    let model = pick_model(settings.model_for(kind).as_deref(), &available);
                    let chosen_cloud = settings.model_for(kind).as_deref().is_some_and(local_llm::is_cloud_name);
                    let error = list_error.or_else(|| {
                        if chosen_cloud {
                            // A cloud model chosen before CodeFlow refused them: say so rather than
                            // silently running a different model.
                            Some(("cloud-model", "That model runs on Ollama's servers; CodeFlow only runs models on this machine.".to_string()))
                        } else if available.is_empty() {
                            Some(("no-models", "The server answers but lists no models.".to_string()))
                        } else {
                            None
                        }
                    });
                    let mut details = match &model {
                        Some(model) => model_details(&endpoint, model, freshness).await,
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

    // Everything else of this app's that holds model memory now, beside the model resolved here.
    let also_resident = resident_beside(kind, model.as_deref(), &url);
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
    // A server that lists no cache shape still has a size: the estimate then leaves the cache out.
    // A model that does not fit at all has no speed worth quoting.
    let write_tps = details.size_bytes.filter(|_| fit != Fit::DoesNotFit).and_then(|bytes| {
        let shape = budget::Shape {
            bytes,
            kv_bytes_per_token: details.kv_bytes_per_token.unwrap_or(0),
            active_share: f64::from(details.active_share.unwrap_or(1.0)),
        };
        budget::write_speed(&shape, ctx, also_resident, &machine)
    });
    if settings.backend.is_some() && kind != BackendKind::Bundled && !reachable {
        detected = detect(settings, Freshness::Recent).await;
    }
    let delegate_suggested = budget::suggest_delegate(details.params_b);
    let (error_code, error) = match error {
        Some((code, sentence)) => (Some(code), Some(sentence)),
        None => (None, None),
    };
    if let Some(model) = model.as_deref().filter(|_| error_code.is_none()) {
        note_window(model, ctx);
    }
    Resolved {
        kind,
        url,
        detected,
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
        write_tps,
        delegate: settings.delegate.unwrap_or(delegate_suggested),
        delegate_suggested,
        details,
    }
}

/// Before a request to an Ollama model, unloads the other models Ollama keeps resident when keeping
/// them would push this one off the GPU or out of memory.
///
/// Ollama evicts on its own when a model cannot load at all, but a model that *partly* fits is
/// loaded split between the GPU and the CPU — several times slower — while an idle model it no
/// longer needs holds the rest of the card. Requests to one server are queued
/// (`super::scheduler`), so nothing of this app's is mid-answer on the models it unloads.
pub async fn make_room(resolved: &Resolved) {
    if resolved.kind != BackendKind::Ollama {
        return;
    }
    let (Some(model), Some(need)) = (resolved.model.as_deref(), resolved.need_bytes) else { return };
    let endpoint = Endpoint::new(resolved.kind, &resolved.url, None);
    let others: Vec<(String, u64)> = local_llm::ollama_residency(&endpoint)
        .await
        .into_iter()
        .filter(|(name, _, _)| name != model)
        .map(|(name, size, _)| (name, size))
        .collect();
    let others_bytes: u64 = others.iter().map(|(_, size)| *size).sum();
    if crowded(need, others_bytes, resolved.also_resident, &resolved.machine) {
        for (name, _) in others {
            local_llm::ollama_unload(&endpoint, &name).await;
        }
    }
}

/// Whether models already resident (`others_bytes`) turn a model that fits on its own into one
/// that spills to the CPU or does not fit.
pub fn crowded(need: u64, others_bytes: u64, also_resident: u64, machine: &Machine) -> bool {
    if others_bytes == 0 {
        return false;
    }
    let alone = budget::fit(need, also_resident, machine);
    let together = budget::fit(need + others_bytes, also_resident, machine);
    matches!(alone, Fit::Comfortable | Fit::Tight) && matches!(together, Fit::SpillsToCpu | Fit::DoesNotFit)
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

/// What this app's other `llama-server`s hold right now, beside the model `kind`/`model`/`url`
/// names — the memory a fit estimate must not hand out twice.
///
/// Counting only the completion engine was the old answer, from when it was the only other one.
/// There are four now, and each can be up while a task asks whether its model fits: the completion
/// engine (the editor), the embedder (knowledge search — ~0.4–0.9 GB), the executor (another task's
/// model, with its window's cache) and a fine-tuned adapter's server. The executor is left out when
/// it is the very model being resolved (its memory *is* `need_bytes`), and so is the adapter's
/// server when `url` is its address.
pub fn resident_beside(kind: BackendKind, model: Option<&str>, url: &str) -> u64 {
    let mut bytes = completion_engine_bytes() + crate::localai::embedder::resident_bytes();
    if let Some((running, held)) = executor::resident() {
        if !(kind == BackendKind::Bundled && model == Some(running.as_str())) {
            bytes += held;
        }
    }
    if let Some((port, held)) = crate::learning::serving::resident() {
        let own = url::Url::parse(url).ok().and_then(|parsed| parsed.port()) == Some(port) && local_llm::is_loopback(url);
        if !own {
            bytes += held;
        }
    }
    bytes
}

/// The window each model was last resolved with — what [`known_window`] answers from without
/// asking a server.
fn windows() -> &'static Mutex<HashMap<String, u32>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    WINDOWS.get_or_init(Default::default)
}

fn note_window(model: &str, ctx: u32) {
    if let Ok(mut windows) = windows().lock() {
        windows.insert(model.trim().to_string(), ctx);
    }
}

/// The window the «CodeFlow» provider last ran — or the pane last resolved — `model` with, without
/// asking any server: for a caller that cannot wait, such as the context meter
/// (`ai::context_window_for`). `None` until something resolved that model this session; an empty
/// `model` or «auto» is the pane's own model, whichever that was last.
// Read by the chats' context meter (`chat_cmd::chat_context_window`).
pub fn known_window(model: &str) -> Option<u32> {
    let model = model.trim();
    let windows = windows().lock().ok()?;
    if model.is_empty() || model == crate::model_registry::AUTO {
        return LAST_PANE_MODEL.lock().ok()?.as_deref().and_then(|pane| windows.get(pane).copied());
    }
    windows.get(model).copied()
}

/// The pane's model as last resolved, for [`known_window`]'s «auto».
#[allow(dead_code)]
static LAST_PANE_MODEL: Mutex<Option<String>> = Mutex::new(None);

/// The window the «CodeFlow» provider runs `model` with right now — the figure its runs are
/// budgeted against, so the one a context meter and an auto-compaction should measure with:
///
/// * Ollama: the `num_ctx` every request is sent with (the pane's choice, capped at the model's own);
/// * the bundled engine, a llama.cpp or LM Studio server: the window the server was started with
///   when it says one (`ctx_fixed_by_server`), the pane's choice otherwise;
/// * a fine-tuned adapter (`adapter:<id>`): the window its server is started with.
///
/// `model` empty or «auto» is the pane's model. Asks the server only when its last answer is older
/// than a few seconds ([`Freshness::Recent`]); `None` when the settings cannot be read or the model
/// is on no server.
#[allow(dead_code)]
pub async fn codeflow_window(model: &str) -> Option<u32> {
    let settings = crate::ai_usage::with_conn(config::read)?.ok()?;
    let model = model.trim();
    if model.starts_with(crate::learning::serving::PREFIX) {
        return Some(crate::learning::serving::window(&settings));
    }
    let resolved = resolve(&settings, Freshness::Recent).await;
    if let Some(pane) = resolved.model.clone() {
        if let Ok(mut last) = LAST_PANE_MODEL.lock() {
            *last = Some(pane);
        }
    }
    if model.is_empty() || model == crate::model_registry::AUTO || resolved.model.as_deref() == Some(model) {
        return resolved.model.is_some().then_some(resolved.ctx);
    }
    if !resolved.available.iter().any(|candidate| candidate.id == model) {
        return None;
    }
    // Another model of the same server: resolved as a run picking it would be (`local_agent`), so
    // its own cap on the window applies.
    let mut chosen = settings.clone();
    chosen.backend = Some(resolved.kind);
    match resolved.kind {
        BackendKind::Bundled => chosen.model_bundled = Some(model.to_string()),
        BackendKind::Ollama => chosen.model_ollama = Some(model.to_string()),
        BackendKind::Openai => chosen.model_openai = Some(model.to_string()),
    }
    let picked = resolve(&chosen, Freshness::Recent).await;
    (picked.model.as_deref() == Some(model)).then_some(picked.ctx)
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
    // Every caller that reaches a local model goes through here or through `local_llm::chat` /
    // `converse` (which check again): a stored run, a flow node with its own address, a meeting. A
    // refusal is the error the caller shows — never a quiet switch to another engine.
    if let Some(why) = local_llm::cloud_refusal(if kind == BackendKind::Bundled { "" } else { url }, model) {
        return Err(format!("{why}."));
    }
    match kind {
        BackendKind::Bundled => {
            let entry = exec_catalogue::find(model).ok_or_else(|| format!("Unknown local model: {model}"))?;
            let machine = hardware::machine().await;
            let shape = budget::Shape {
                bytes: entry.spec.size_bytes,
                kv_bytes_per_token: entry.kv_bytes_per_token,
                active_share: entry.active_share(),
            };
            let launch = executor::Launch {
                model_id: model.to_string(),
                ctx,
                no_reasoning: !crate::model_registry::server_reasoning(),
                cpu_moe_layers: budget::cpu_moe_layers(&shape, entry.moe_layers, ctx, resident_beside(kind, Some(model), url), &machine),
            };
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
            schema: None,
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
        let launch = executor::Launch { model_id: entry.spec.id.to_string(), ctx: 16_384, no_reasoning: true, cpu_moe_layers: 0 };
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

#[cfg(test)]
mod room_tests {
    use super::*;
    use crate::hybrid::hardware::GpuKind;

    #[test]
    fn idle_models_are_unloaded_only_when_they_crowd_the_new_one_out() {
        let gib = 1u64 << 30;
        let card = Machine {
            ram_bytes: 64 * gib,
            ram_bandwidth: Some(60_000_000_000),
            gpu: GpuKind::Discrete,
            gpu_bytes: Some(24 * gib),
            gpu_name: Some("NVIDIA GeForce RTX 4090".into()),
            gpu_bandwidth: Some(1_008_000_000_000),
        };
        // 14 GB wanted, 11 GB idle beside it on a 24 GB card: together they spill.
        assert!(crowded(14 * gib, 11 * gib, 0, &card));
        // Room for both: nothing to unload.
        assert!(!crowded(6 * gib, 4 * gib, 0, &card));
        // Nothing else resident.
        assert!(!crowded(14 * gib, 0, 0, &card));
        // Too big even alone: unloading would not make it fit on the card, so it is left to Ollama.
        assert!(!crowded(30 * gib, 4 * gib, 0, &card));
    }
}

