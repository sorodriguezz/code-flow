//! The bench and the model registry, for Settings › Local model › Diagnóstico.
//!
//! A bench run outlives the request that started it: it runs in the background, reports on
//! `ai:eval`, files its report in `ai_evaluations` (and the tool verdict on the registry row), and
//! [`ai_eval_status`] lets a reloaded window pick the progress line back up. One run at a time —
//! two would measure each other.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

use crate::db::Db;
use crate::evals::{self, corpus::Suite, report, Options, Progress};
use crate::hybrid::local_llm::BackendKind;
use crate::model_registry::store;

#[derive(Default)]
struct Running {
    cancel: Option<watch::Sender<bool>>,
    progress: Option<Progress>,
    model: Option<String>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// Whether a bench run is going — an adapter's evaluation waits for it rather than load a second
/// model beside it.
pub fn busy() -> bool {
    RUNNING.lock().map(|slot| slot.is_some()).unwrap_or(false)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvalRequest {
    pub runs: Option<usize>,
    pub suites: Option<Vec<Suite>>,
    pub only: Option<Vec<String>>,
    /// Measure this model on the configured server instead of the pane's choice.
    pub model: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalEvent {
    pub state: &'static str,
    pub progress: Option<Progress>,
    pub model: Option<String>,
    pub evaluation_id: Option<String>,
    pub score: Option<f64>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalStatus {
    pub running: bool,
    pub progress: Option<Progress>,
    pub model: Option<String>,
}

fn emit(app: &AppHandle, event: EvalEvent) {
    let _ = app.emit("ai:eval", event);
}

/// Starts a bench run against the local model. Returns at once; the outcome arrives on `ai:eval`.
#[tauri::command]
pub async fn ai_eval_run(app: AppHandle, db: State<'_, Db>, request: EvalRequest) -> Result<(), String> {
    let mut settings = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::hybrid::config::read(&conn)?
    };
    if let Some(model) = request.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        if crate::hybrid::local_llm::is_cloud_name(model) {
            return Err("cloud-model".to_string());
        }
        match settings.backend {
            Some(BackendKind::Ollama) => settings.model_ollama = Some(model.to_string()),
            Some(BackendKind::Openai) => settings.model_openai = Some(model.to_string()),
            _ => settings.model_bundled = Some(model.to_string()),
        }
    }
    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut slot = RUNNING.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("busy".to_string());
        }
        *slot = Some(Running { cancel: Some(cancel_tx), progress: None, model: request.model.clone() });
    }
    let options = Options {
        runs: request.runs.unwrap_or(1).clamp(1, 10),
        suites: request.suites.filter(|s| !s.is_empty()).unwrap_or_else(|| Suite::ALL.to_vec()),
        only: request.only.unwrap_or_default(),
        app_version: Some(app.package_info().version.to_string()),
        adapter: None,
    };
    tauri::async_runtime::spawn(async move {
        let progress_app = app.clone();
        let outcome = evals::run(
            &settings,
            &options,
            move |progress| {
                if let Ok(mut slot) = RUNNING.lock() {
                    if let Some(running) = slot.as_mut() {
                        running.progress = Some(progress.clone());
                    }
                }
                emit(&progress_app, EvalEvent { state: "progress", progress: Some(progress), model: None, evaluation_id: None, score: None, error: None });
            },
            Some(cancel_rx),
        )
        .await;
        if let Ok(mut slot) = RUNNING.lock() {
            *slot = None;
        }
        match outcome {
            Ok(report) => {
                // The plain-text table, for the app log: what a bug report about a model attaches.
                crate::applog::info(&format!("bench finished:\n{}", report.summary()));
                let stored = app
                    .try_state::<Db>()
                    .and_then(|db| db.0.lock().ok().map(|conn| store::record_evaluation(&conn, &report, None)));
                let evaluation_id = match stored {
                    Some(Ok(id)) => Some(id),
                    _ => None,
                };
                emit(
                    &app,
                    EvalEvent { state: "done", progress: None, model: Some(report.model.clone()), evaluation_id, score: Some(report.score), error: report.aborted.clone() },
                );
            }
            Err(error) => emit(&app, EvalEvent { state: "failed", progress: None, model: None, evaluation_id: None, score: None, error: Some(error) }),
        }
    });
    Ok(())
}

#[tauri::command]
pub fn ai_eval_status() -> EvalStatus {
    match RUNNING.lock().ok().and_then(|slot| slot.as_ref().map(|r| (r.progress.clone(), r.model.clone()))) {
        Some((progress, model)) => EvalStatus { running: true, progress, model },
        None => EvalStatus { running: false, progress: None, model: None },
    }
}

/// Stops the run after the step in flight.
#[tauri::command]
pub fn ai_eval_cancel() {
    if let Ok(slot) = RUNNING.lock() {
        if let Some(cancel) = slot.as_ref().and_then(|r| r.cancel.as_ref()) {
            let _ = cancel.send(true);
        }
    }
}

#[tauri::command]
pub fn ai_eval_list(db: State<'_, Db>, limit: Option<usize>) -> Result<Vec<store::EvaluationRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::evaluations(&conn, limit.unwrap_or(50).clamp(1, 500)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_eval_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::delete_evaluation(&conn, &id).map_err(|e| e.to_string())
}

/// Two stored runs side by side: what changed per task, and which tasks regressed.
#[tauri::command]
pub fn ai_eval_compare(db: State<'_, Db>, before: String, after: String) -> Result<report::Comparison, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let a = store::evaluation(&conn, &before).map_err(|e| e.to_string())?.ok_or("before not found")?;
    let b = store::evaluation(&conn, &after).map_err(|e| e.to_string())?.ok_or("after not found")?;
    Ok(report::compare(&a, &b))
}

/// Every model the registry knows, with what it declares and its tool verdict.
#[tauri::command]
pub fn ai_model_registry_list(db: State<'_, Db>) -> Result<Vec<store::ModelRecord>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::list(&conn).map_err(|e| e.to_string())
}

/// What agents did lately — every file write and command, with its level and outcome
/// (`crate::tool_gateway`).
#[tauri::command]
pub fn ai_tool_audit_list(db: State<'_, Db>, workspace_id: Option<String>, limit: Option<usize>) -> Result<Vec<crate::tool_gateway::AuditRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::tool_gateway::recent(&conn, workspace_id.as_deref(), limit.unwrap_or(100).clamp(1, 1_000)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// The bundled engines that are loaded now.
    pub executor: Option<String>,
    pub completion: Option<String>,
    pub embedder: Option<String>,
    /// What Ollama holds in memory: `(model, bytes, bytes on the GPU)`.
    pub ollama: Vec<(String, u64, u64)>,
    pub pressure: crate::hybrid::hardware::Pressure,
    /// Free commands of an agent run sandboxed on this machine (`crate::tool_gateway`).
    pub sandbox: bool,
}

/// What is loaded and how pressed the machine is — Diagnóstico's "now" line.
#[tauri::command]
pub async fn ai_runtime_status(db: State<'_, Db>) -> Result<RuntimeStatus, String> {
    let url = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::queries::get_setting(&conn, crate::hybrid::config::KEY_URL_OLLAMA).ok().flatten()
    };
    let endpoint = crate::hybrid::local_llm::Endpoint::new(
        BackendKind::Ollama,
        url.as_deref().unwrap_or(BackendKind::Ollama.default_url()),
        None,
    );
    let ollama = crate::hybrid::local_llm::ollama_residency(&endpoint).await;
    let loaded = |status: crate::localai::engine::Status| match status {
        crate::localai::engine::Status::Ready { model_id } | crate::localai::engine::Status::Starting { model_id } => Some(model_id),
        _ => None,
    };
    Ok(RuntimeStatus {
        executor: crate::localai::executor::running_model(),
        completion: loaded(crate::localai::engine::status()),
        embedder: crate::localai::embedder::running_model(),
        ollama,
        pressure: crate::hybrid::hardware::memory_pressure(),
        sandbox: crate::tool_gateway::sandbox_available(),
    })
}
