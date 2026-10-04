//! The hybrid task's local model, as the settings pane and the new-task dialog see it.
//!
//! Settings themselves are written through the generic `set_setting` command (it announces
//! `settings:changed`); this file answers what those settings *resolve to* on this machine right
//! now, measures the model on request, and manages the bundled engine's downloads. The resolution
//! is [`crate::hybrid::runtime::resolve`], shared with the executor, so the pane can never describe
//! a different model from the one a task will reach.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::hybrid::budget::{self, Budget, Delegate, Fit, Machine, Pace, Shape};
use crate::hybrid::config::{self, OnFail, ReviewMode};
use crate::hybrid::local_llm::{self, BackendKind, ChatRequest, ModelDetails};
use crate::hybrid::runtime::{self, Detected, Freshness};
use crate::localai::{catalogue, download, engine, exec_catalogue, executor, models, LocalAiRegistry};

/// One model row in the pane: a server's listing, or the bundled catalogue with its on-disk state.
#[derive(Clone, serde::Serialize)]
pub struct ModelRow {
    pub id: String,
    pub label: String,
    pub size_bytes: Option<u64>,
    pub params: Option<String>,
    pub quant: Option<String>,
    /// Bundled catalogue only.
    pub installed: Option<bool>,
    pub partial_bytes: Option<u64>,
    pub licence: Option<String>,
    pub min_ram_gb: Option<u32>,
    pub tier: Option<catalogue::Tier>,
    /// How the model sits on this machine at 16k (bundled only — a server's listing does not carry
    /// the architecture, and asking it about every model would be one request per row).
    pub fit: Option<Fit>,
    /// Tokens a second it would write here at 16k, estimated (bundled only, like `fit`).
    pub write_tps: Option<f64>,
    pub pace: Pace,
    /// The row the pane points at as the one for this machine — see [`budget::recommend`].
    pub recommended: bool,
}

/// A model Ollama's library has that this server has not pulled yet, and how it would sit here.
#[derive(Clone, serde::Serialize)]
pub struct PullableRow {
    /// `ollama:<tag>` — the id its progress arrives under on `localai:download`.
    pub id: String,
    pub tag: String,
    pub label: String,
    pub params: String,
    pub size_bytes: u64,
    /// At 16k, like the bundled catalogue's rows.
    pub fit: Fit,
    pub write_tps: Option<f64>,
    pub pace: Pace,
    pub recommended: bool,
}

/// The progress id of an Ollama pull — kept apart from the bundled catalogue's ids.
fn pull_id(tag: &str) -> String {
    format!("ollama:{tag}")
}

/// What **Probar** measured, for the model and window it measured.
#[derive(Clone, serde::Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub backend: BackendKind,
    pub model: String,
    pub ctx: u32,
    /// Tokens sent, counted by the server where it can count and estimated where it cannot.
    pub sent_tokens: u64,
    /// Tokens the server says it processed. Far below `sent_tokens` means the prompt was cut.
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub prompt_tps: Option<f64>,
    pub gen_tps: Option<f64>,
    /// Share of the model in GPU memory, 0–1. Ollama only.
    pub gpu_share: Option<f64>,
    pub truncated: bool,
    /// English; `error_code` is what the UI shows.
    pub error: Option<String>,
    pub error_code: Option<&'static str>,
    pub at: i64,
}

#[derive(serde::Serialize)]
pub struct LocalExecState {
    pub backend: BackendKind,
    pub backend_chosen: bool,
    pub url: String,
    /// The URL does not point at this machine: code leaves it.
    pub remote: bool,
    pub detected: Detected,
    pub reachable: bool,
    pub server_version: Option<String>,
    /// English; `error_code` is what the UI shows — see `runtime::Resolved::error_code`.
    pub error: Option<String>,
    pub error_code: Option<&'static str>,
    pub models: Vec<ModelRow>,
    pub model: Option<String>,
    pub model_chosen: bool,
    pub details: ModelDetails,
    pub ctx: u32,
    pub ctx_chosen: bool,
    pub ctx_options: Vec<u32>,
    pub budget: Budget,
    pub machine: Machine,
    pub need_bytes: Option<u64>,
    pub also_resident_bytes: u64,
    pub fit: Fit,
    /// Tokens a second the chosen model is estimated to write here, at `ctx`.
    pub write_tps: Option<f64>,
    pub pace: Pace,
    pub delegate: Delegate,
    pub delegate_suggested: Delegate,
    pub delegate_chosen: bool,
    pub on_fail: OnFail,
    pub unload: bool,
    pub review_mode: ReviewMode,
    /// The bundled executor's process.
    pub engine: engine::Status,
    pub engine_available: bool,
    pub models_dir: String,
    pub disk_used: u64,
    pub has_key: bool,
    pub probe: Option<ProbeResult>,
    /// Ollama only: what can be pulled from here.
    pub pullable: Vec<PullableRow>,
}

fn probes() -> &'static Mutex<HashMap<String, ProbeResult>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ProbeResult>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn probe_key(kind: BackendKind, url: &str, model: &str, ctx: u32) -> String {
    format!("{}|{}|{}|{}", kind.as_str(), url, model, ctx)
}

fn read_settings(db: &Db) -> Result<config::Settings, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    config::read(&conn)
}

/// What the stored choices resolve to right now. `fresh` asks every server again; without it, an
/// answer from the last few seconds stands — see [`Freshness`]. The pane asks fresh when it opens
/// and when a server, URL or key changes, and not after the clicks that change none of those.
#[tauri::command]
pub async fn local_exec_state(db: State<'_, Db>, fresh: Option<bool>) -> Result<LocalExecState, String> {
    let settings = read_settings(&db)?;
    let freshness = if fresh.unwrap_or(true) { Freshness::Now } else { Freshness::Recent };
    let resolved = runtime::resolve(&settings, freshness).await;

    let models = match resolved.kind {
        BackendKind::Bundled => bundled_rows(&resolved.machine),
        _ => resolved
            .available
            .iter()
            .map(|m| ModelRow {
                id: m.id.clone(),
                label: m.id.clone(),
                size_bytes: m.size_bytes,
                params: m.params.clone(),
                quant: m.quant.clone(),
                installed: None,
                partial_bytes: None,
                licence: None,
                min_ram_gb: None,
                tier: None,
                fit: None,
                write_tps: None,
                pace: Pace::Unknown,
                recommended: false,
            })
            .collect(),
    };
    let probe = resolved.model.as_ref().and_then(|model| {
        probes().lock().ok()?.get(&probe_key(resolved.kind, &resolved.url, model, resolved.ctx)).cloned()
    });
    let model_chosen = settings.model_for(resolved.kind).is_some();
    let pullable = if resolved.kind == BackendKind::Ollama && resolved.reachable {
        pullable_rows(&resolved.available, &resolved.machine)
    } else {
        Vec::new()
    };
    Ok(LocalExecState {
        backend: resolved.kind,
        backend_chosen: settings.backend.is_some(),
        remote: resolved.kind != BackendKind::Bundled && !local_llm::is_loopback(&resolved.url),
        url: resolved.url,
        detected: resolved.detected,
        reachable: resolved.reachable,
        server_version: resolved.server_version,
        error: resolved.error,
        error_code: resolved.error_code,
        models,
        model: resolved.model,
        model_chosen,
        details: resolved.details,
        ctx: resolved.ctx,
        ctx_chosen: settings.ctx.is_some(),
        ctx_options: resolved.ctx_options,
        budget: resolved.budget,
        machine: resolved.machine,
        need_bytes: resolved.need_bytes,
        also_resident_bytes: resolved.also_resident,
        fit: resolved.fit,
        write_tps: resolved.write_tps,
        pace: budget::pace(resolved.write_tps),
        delegate: resolved.delegate,
        delegate_suggested: resolved.delegate_suggested,
        delegate_chosen: settings.delegate.is_some(),
        on_fail: settings.on_fail,
        unload: settings.unload,
        review_mode: settings.review_mode,
        engine: executor::status(),
        engine_available: engine::is_available(),
        models_dir: models::dir().to_string_lossy().into_owned(),
        disk_used: models::disk_used(),
        has_key: config::api_key().is_some(),
        probe,
        pullable,
    })
}

/// The window catalogue rows are judged at: the smallest a useful task fits in comfortably, so a row
/// says how the model sits before anyone has picked a context for it.
const ROW_CTX: u32 = 16_384;

/// How a model of `size_bytes` from the catalogue entry `entry` sits on `machine` at [`ROW_CTX`]:
/// its fit, and how fast it would write — no speed for one that does not fit at all.
fn judge(entry: &exec_catalogue::ExecModelSpec, size_bytes: u64, machine: &Machine) -> (Fit, Option<f64>) {
    let also_resident = runtime::completion_engine_bytes();
    let need = budget::memory_need(size_bytes, entry.kv_bytes_per_token, ROW_CTX);
    let fit = budget::fit(need, also_resident, machine);
    if fit == Fit::DoesNotFit {
        return (fit, None);
    }
    let shape = Shape { bytes: size_bytes, kv_bytes_per_token: entry.kv_bytes_per_token, active_share: entry.active_share() };
    (fit, budget::write_speed(&shape, ROW_CTX, also_resident, machine))
}

fn pullable_rows(available: &[local_llm::LocalModel], machine: &Machine) -> Vec<PullableRow> {
    let judged: Vec<(&exec_catalogue::OllamaTag, &exec_catalogue::ExecModelSpec, Fit, Option<f64>)> = exec_catalogue::OLLAMA_TAGS
        .iter()
        .filter_map(|tag| {
            let entry = exec_catalogue::find(tag.catalogue_id)?;
            let (fit, write_tps) = judge(entry, tag.size_bytes, machine);
            Some((tag, entry, fit, write_tps))
        })
        .collect();
    // Chosen among every tag, pulled or not: with the best one already on the server, the badge
    // must not move to the best of what is left.
    let best = budget::recommend(&judged.iter().map(|&(_, _, fit, tps)| (fit, tps)).collect::<Vec<_>>());
    judged
        .iter()
        .enumerate()
        // `qwen2.5-coder:7b` is listed as such, or with `:latest`-style suffixes stripped by the user.
        .filter(|(_, (tag, ..))| !available.iter().any(|model| model.id == tag.tag))
        .map(|(index, &(tag, entry, fit, write_tps))| PullableRow {
            id: pull_id(tag.tag),
            tag: tag.tag.to_string(),
            label: entry.spec.label.to_string(),
            params: entry.spec.params.to_string(),
            size_bytes: tag.size_bytes,
            fit,
            write_tps,
            pace: budget::pace(write_tps),
            recommended: best == Some(index),
        })
        .collect()
}

/// A model name as Ollama's library spells them — `name[:tag]`, a namespace at most. Anything else
/// is refused before it reaches the server.
fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 200
        && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
        && !tag.starts_with(['-', '/', ':'])
}

fn ollama_endpoint(db: &Db) -> Result<local_llm::Endpoint, String> {
    let settings = read_settings(db)?;
    Ok(local_llm::Endpoint::new(BackendKind::Ollama, &settings.url_for(BackendKind::Ollama), None))
}

/// Pulls `tag` into Ollama, with progress on `localai:download` under `ollama:<tag>` — the same
/// event, and so the same bar, as a bundled download. Resolves when the pull ends, however it ends.
#[tauri::command]
pub async fn local_exec_ollama_pull(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, LocalAiRegistry>,
    tag: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let tag = tag.trim().to_string();
    if !valid_tag(&tag) {
        return Err(format!("\"{tag}\" is not a model name Ollama knows how to pull."));
    }
    let endpoint = ollama_endpoint(&db)?;
    let id = pull_id(&tag);
    let cancel = registry.register_download(id.clone());
    let emit = |phase: download::Phase, done: u64, total: u64, error: Option<String>| {
        let _ = app.emit(download::EVENT, download::Progress { model_id: id.clone(), phase, done, total, error });
    };
    emit(download::Phase::Downloading, 0, 0, None);
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let result = local_llm::ollama_pull(
        &endpoint,
        &tag,
        |progress| {
            // Throttled like the bundled downloads: the stream sends a line per few hundred KB.
            if last.elapsed() < std::time::Duration::from_millis(250) && progress.status != "success" {
                return;
            }
            last = std::time::Instant::now();
            let phase = if progress.status.starts_with("verifying") || progress.status.starts_with("writing") {
                download::Phase::Verifying
            } else {
                download::Phase::Downloading
            };
            emit(phase, progress.completed, progress.total, None);
        },
        async {
            let _ = cancel.await;
        },
    )
    .await;
    registry.clear_download(&id);
    // What the server lists has changed (or may have, if the pull failed part way).
    runtime::forget_servers();
    match result {
        Ok(()) => {
            emit(download::Phase::Done, 0, 0, None);
            Ok(())
        }
        Err(local_llm::LocalError::Cancelled) => {
            emit(download::Phase::Cancelled, 0, 0, None);
            Ok(())
        }
        Err(failure) => {
            let sentence = failure.sentence();
            emit(download::Phase::Failed, 0, 0, Some(sentence.clone()));
            Err(sentence)
        }
    }
}

#[tauri::command]
pub fn local_exec_ollama_cancel_pull(registry: State<LocalAiRegistry>, tag: String) {
    registry.cancel_download(&pull_id(tag.trim()));
}

/// Removes a model from Ollama — the disk it takes is the user's, and this is the one place in the
/// app that put it there.
#[tauri::command]
pub async fn local_exec_ollama_delete(db: State<'_, Db>, tag: String) -> Result<(), String> {
    let tag = tag.trim().to_string();
    if !valid_tag(&tag) {
        return Err(format!("\"{tag}\" is not a model name."));
    }
    let endpoint = ollama_endpoint(&db)?;
    let deleted = local_llm::ollama_delete(&endpoint, &tag).await.map_err(|failure| failure.sentence());
    runtime::forget_servers();
    deleted
}

fn bundled_rows(machine: &Machine) -> Vec<ModelRow> {
    let mut rows: Vec<ModelRow> = exec_catalogue::EXEC_CATALOGUE
        .iter()
        .map(|entry| {
            let spec = &entry.spec;
            let (fit, write_tps) = judge(entry, spec.size_bytes, machine);
            ModelRow {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                size_bytes: Some(spec.size_bytes),
                params: Some(spec.params.to_string()),
                quant: None,
                installed: Some(models::is_installed(spec)),
                partial_bytes: models::partial_bytes(spec),
                licence: Some(spec.licence.to_string()),
                min_ram_gb: Some(spec.min_ram_gb),
                tier: Some(spec.tier),
                fit: Some(fit),
                write_tps,
                pace: budget::pace(write_tps),
                recommended: false,
            }
        })
        .collect();
    let judged: Vec<(Fit, Option<f64>)> =
        rows.iter().map(|row| (row.fit.unwrap_or(Fit::Unknown), row.write_tps)).collect();
    if let Some(best) = budget::recommend(&judged) {
        rows[best].recommended = true;
    }
    rows
}

/// Ordinary code up to about `target_tokens`, then a small request.
///
/// Sized from the budget rather than fixed: the failure this button exists to catch is a server
/// whose real window is smaller than the one configured here (LM Studio and llama.cpp both start
/// at 4k unless told otherwise), and only a prompt longer than that window exposes it. Capped by
/// the caller so prompt evaluation stays well under a minute on a laptop.
fn probe_prompt(target_tokens: u64) -> String {
    let mut prompt = String::from("Reference code (do not repeat it):\n\n```ts\n");
    for i in 0.. {
        if budget::estimate_tokens(&prompt) >= target_tokens {
            break;
        }
        prompt.push_str(&format!(
            "export function normalizeRecord{i}(input: Record<string, unknown>): Record<string, string> {{\n  const out: Record<string, string> = {{}};\n  for (const [key, value] of Object.entries(input)) {{\n    out[key.trim().toLowerCase()] = String(value ?? \"\").trim();\n  }}\n  return out;\n}}\n\n"
        ));
    }
    prompt.push_str("```\n\nTask: write a TypeScript function `sumAll(values: number[]): number` that returns the sum. Answer with one fenced code block and nothing else.");
    prompt
}

/// Measures the chosen model: how fast it reads, how fast it writes, how much of it is on the GPU,
/// and whether the server cut the prompt.
#[tauri::command]
pub async fn local_exec_probe(db: State<'_, Db>) -> Result<ProbeResult, String> {
    let settings = read_settings(&db)?;
    let resolved = runtime::resolve(&settings, Freshness::Recent).await;
    let model = resolved.model.clone().ok_or_else(|| {
        resolved.error.clone().unwrap_or_else(|| "There is no local model to try.".to_string())
    })?;

    let live = runtime::connect(resolved.kind, &resolved.url, &model, resolved.ctx).await?;
    let _in_flight = live.engine.as_ref().map(|engine| engine.begin());
    let system = "You write code. Answer with exactly one fenced code block.";
    let user = probe_prompt(u64::from(resolved.budget.input.saturating_sub(256)).clamp(1_024, 6_000));
    let sent_tokens = match local_llm::count_tokens(&live.endpoint, &format!("{system}\n{user}")).await {
        Some(exact) => exact,
        None => budget::estimate_tokens(system) + budget::estimate_tokens(&user),
    };
    let request = ChatRequest {
        model: &live.model,
        system,
        user: &user,
        num_ctx: (resolved.kind == BackendKind::Ollama).then_some(resolved.ctx),
        max_tokens: 160,
        temperature: 0.0,
        think: resolved.details.thinking.then_some(false),
        keep_alive: None,
        schema: None,
    };
    let at = chrono::Utc::now().timestamp_millis();
    let outcome = local_llm::chat(&live.endpoint, &request, |_| {}, std::future::pending::<()>()).await;
    let result = match outcome {
        Err(failure) => ProbeResult {
            ok: false,
            backend: resolved.kind,
            model: model.clone(),
            ctx: resolved.ctx,
            sent_tokens,
            prompt_tokens: None,
            completion_tokens: None,
            prompt_tps: None,
            gen_tps: None,
            gpu_share: None,
            truncated: false,
            error: Some(failure.sentence()),
            error_code: Some(failure.code()),
            at,
        },
        Ok(outcome) => {
            let truncated = budget::truncated(sent_tokens, outcome.prompt_tokens);
            let prompt_ms = outcome.prompt_ms.or(outcome.first_token_ms);
            let gen_ms = outcome
                .gen_ms
                .or_else(|| outcome.first_token_ms.map(|first| outcome.total_ms.saturating_sub(first)));
            let rate = |tokens: Option<u64>, ms: Option<u64>| match (tokens, ms) {
                (Some(tokens), Some(ms)) if ms > 0 && tokens > 0 => Some(tokens as f64 * 1000.0 / ms as f64),
                _ => None,
            };
            let gpu_share = local_llm::ollama_residency(&live.endpoint)
                .await
                .into_iter()
                .find(|(name, _, _)| name == &model)
                .filter(|(_, size, _)| *size > 0)
                .map(|(_, size, vram)| (vram as f64 / size as f64).clamp(0.0, 1.0));
            ProbeResult {
                ok: !truncated,
                backend: resolved.kind,
                model: model.clone(),
                ctx: resolved.ctx,
                sent_tokens,
                prompt_tokens: outcome.prompt_tokens,
                completion_tokens: outcome.completion_tokens,
                prompt_tps: rate(outcome.prompt_tokens.or(Some(sent_tokens)), prompt_ms),
                gen_tps: rate(outcome.completion_tokens, gen_ms),
                gpu_share,
                truncated,
                error: truncated.then(|| {
                    format!(
                        "The server processed {} of ~{} tokens: it is cutting prompts. Raise the server's context or lower this one.",
                        outcome.prompt_tokens.unwrap_or(0),
                        sent_tokens
                    )
                }),
                error_code: truncated.then_some("truncated"),
                at,
            }
        }
    };
    if let Ok(mut cache) = probes().lock() {
        cache.insert(probe_key(resolved.kind, &resolved.url, &model, resolved.ctx), result.clone());
    }
    Ok(result)
}

#[tauri::command]
pub async fn local_exec_download_model(
    app: AppHandle,
    registry: State<'_, LocalAiRegistry>,
    model_id: String,
) -> Result<(), String> {
    let entry = exec_catalogue::find(&model_id).ok_or_else(|| format!("Unknown model: {model_id}"))?;
    let cancel = registry.register_download(model_id.clone());
    let result = download::fetch(&app, &entry.spec, &models::dir(), cancel).await;
    registry.clear_download(&model_id);
    result.map(|_| ())
}

#[tauri::command]
pub fn local_exec_cancel_download(registry: State<LocalAiRegistry>, model_id: String) {
    registry.cancel_download(&model_id);
}

#[tauri::command]
pub async fn local_exec_delete_model(registry: State<'_, LocalAiRegistry>, model_id: String) -> Result<(), String> {
    let entry = exec_catalogue::find(&model_id).ok_or_else(|| format!("Unknown model: {model_id}"))?;
    registry.cancel_download(&model_id);
    // A mapped file cannot be unlinked on Windows, and on macOS unlinking it would leave the
    // engine holding gigabytes of a file nobody can see. Same reasoning as the completion slot.
    if executor::running_model().as_deref() == Some(entry.spec.id) {
        executor::shutdown().await;
    }
    models::delete(&entry.spec)
}

/// Gives the local model's memory back now: stops the bundled engine, and asks Ollama to unload
/// the chosen model when Ollama is what serves it.
#[tauri::command]
pub async fn local_exec_stop_engine(db: State<'_, Db>) -> Result<(), String> {
    executor::shutdown().await;
    let settings = read_settings(&db)?;
    if settings.backend == Some(BackendKind::Ollama) || settings.backend.is_none() {
        if let Some(model) = settings.model_for(BackendKind::Ollama) {
            let endpoint = local_llm::Endpoint::new(BackendKind::Ollama, &settings.url_for(BackendKind::Ollama), None);
            local_llm::ollama_unload(&endpoint, &model).await;
        }
    }
    Ok(())
}

/// Stores (or, with `None`, removes) the Bearer key for an OpenAI-compatible server.
#[tauri::command]
pub fn local_exec_set_key(key: Option<String>) -> Result<(), String> {
    let stored = match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(key) => crate::secrets::set_secret(config::SECRET_KEY, &key),
        None => crate::secrets::delete_secret(config::SECRET_KEY),
    };
    runtime::forget_servers();
    stored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_prompt_reaches_its_target_and_stops_there() {
        let tokens = budget::estimate_tokens(&probe_prompt(6_000));
        assert!(tokens > 6_000, "{tokens} estimated tokens would not expose a 4k server window");
        assert!(tokens < 6_600, "{tokens} estimated tokens is more than the probe asked for");
    }

    /// A PC whose model lives in its 32 GB of RAM, read at 40 GB/s. Made up rather than measured:
    /// measuring this machine streams half a gigabyte through every core, which a parallel test run
    /// does not need beside its timing-sensitive tests.
    fn pc_without_card() -> Machine {
        Machine {
            ram_bytes: 32 << 30,
            ram_bandwidth: Some(40_000_000_000),
            gpu: budget::GpuKind::Integrated,
            gpu_bytes: None,
            gpu_name: None,
            gpu_bandwidth: None,
        }
    }

    #[test]
    fn the_model_to_pull_is_chosen_among_all_of_them() {
        // The mixture is the one for a machine whose model lives in RAM.
        let machine = pc_without_card();
        let rows = pullable_rows(&[], &machine);
        assert_eq!(rows.iter().filter(|row| row.recommended).map(|row| row.tag.as_str()).collect::<Vec<_>>(), ["qwen3-coder:30b"]);
        // Already on the server, it is not offered — and the badge does not move to a worse one.
        let pulled = [local_llm::LocalModel { id: "qwen3-coder:30b".into(), ..Default::default() }];
        let rows = pullable_rows(&pulled, &machine);
        assert_eq!(rows.len(), exec_catalogue::OLLAMA_TAGS.len() - 1);
        assert!(rows.iter().all(|row| !row.recommended));
    }

    #[test]
    fn every_bundled_model_gets_a_row_with_its_disk_state() {
        let rows = bundled_rows(&pc_without_card());
        assert_eq!(rows.len(), exec_catalogue::EXEC_CATALOGUE.len());
        assert!(rows.iter().all(|row| row.installed.is_some() && row.fit.is_some()));
        assert!(rows.iter().filter(|row| row.recommended).count() <= 1, "one model is the one for this machine");
    }
}
