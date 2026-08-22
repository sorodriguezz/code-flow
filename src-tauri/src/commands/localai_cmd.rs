//! The editor's local completion, as seen from the frontend.
//!
//! Everything the settings pane and the Monaco provider can ask for. The work lives in
//! [`crate::localai`]; this file is the boundary — it reads the two settings rows, resolves a
//! catalogue id to a spec, and owns the cancel bookkeeping.
//!
//! # Why a completion is a command and not a stream
//!
//! Every other long-running thing in this app emits events. A completion does not: it is a single
//! request with a single answer, under a fifth of a second, and the caller is a Monaco provider
//! that is already `async` and already holds a `CancellationToken`. A one-shot `invoke` maps onto
//! that exactly; an event channel would mean the frontend correlating replies to requests by hand,
//! which is the cancellation bug this feature would then spend its life fixing.

use tauri::{AppHandle, State};

use crate::db::{queries, Db};
use crate::localai::{catalogue, complete, download, engine, models, LocalAiRegistry};

/// `app_settings` key: whether the user has turned inline completion on. `"1"` or absent.
const KEY_ENABLED: &str = "localai_completion_enabled";

/// `app_settings` key: which catalogue id is active. Absent means
/// [`catalogue::DEFAULT_MODEL_ID`].
const KEY_MODEL: &str = "localai_completion_model";

/// Everything the settings pane draws, in one round trip.
///
/// One command rather than five, because the pane needs all of it to render a single coherent
/// answer to "is this working?", and five separate `invoke`s would let it paint a state that never
/// actually existed — enabled with no model, or a model marked installed next to an engine that
/// says it is missing.
#[derive(serde::Serialize)]
pub struct LocalAiState {
    pub enabled: bool,
    /// The active catalogue id. Always set, even before the user has chosen — it is the default
    /// until they do.
    pub model_id: String,
    /// `false` when `model_id` names a model this build's catalogue does not have, which happens
    /// after a downgrade. The pane says so rather than silently switching them to another model.
    pub model_known: bool,
    /// Whether the active model's weights are on disk. The single condition that decides whether
    /// the feature can actually do anything.
    pub model_installed: bool,
    pub models: Vec<models::ModelRow>,
    /// Where the weights live, so the pane can offer a "show in Finder/Explorer" button.
    ///
    /// Sent as a plain string rather than left for the frontend to reconstruct: that path is
    /// resolved by `paths` from three per-OS conventions plus a `CODEFLOW_HOME` override, and the
    /// settings screen used to reproduce exactly that kind of branch in TSX and get it wrong —
    /// see the note on `APP_DIR` in `paths.rs`.
    pub models_dir: String,
    pub engine: engine::Status,
    /// Whether `llama-server` is present in this install. `false` is a broken or partial
    /// installation, not a user choice, and reads very differently in the UI.
    pub engine_available: bool,
    pub disk_used: u64,
}

#[tauri::command]
pub fn localai_state(db: State<Db>) -> Result<LocalAiState, String> {
    let (enabled, model_id) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (read_enabled(&conn)?, read_model_id(&conn)?)
    };
    let spec = catalogue::find(&model_id);
    Ok(LocalAiState {
        enabled,
        model_known: spec.is_some(),
        model_installed: spec.is_some_and(models::is_installed),
        model_id,
        models: models::rows(),
        models_dir: models::dir().to_string_lossy().into_owned(),
        engine: engine::status(),
        engine_available: engine::is_available(),
        disk_used: models::disk_used(),
    })
}

#[tauri::command]
pub async fn localai_set_enabled(db: State<'_, Db>, enabled: bool) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, KEY_ENABLED, if enabled { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
    }
    // Turning it off must give the memory back now, not in five minutes when the reaper next
    // wakes. Turning it *on* deliberately starts nothing — see the lazy table in `engine`.
    if !enabled {
        engine::shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn localai_set_model(db: State<'_, Db>, model_id: String) -> Result<(), String> {
    if catalogue::find(&model_id).is_none() {
        return Err(format!("Unknown model: {model_id}"));
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, KEY_MODEL, &model_id).map_err(|e| e.to_string())?;
    }
    // A server is bound to the `-m` it was launched with, so the running one is now the wrong
    // one. Stopping here rather than letting the next request notice keeps a gigabyte of the
    // *previous* model from sitting resident until someone types.
    engine::shutdown().await;
    Ok(())
}

#[tauri::command]
pub async fn localai_download_model(
    app: AppHandle,
    registry: State<'_, LocalAiRegistry>,
    model_id: String,
) -> Result<(), String> {
    let spec = catalogue::find(&model_id).ok_or_else(|| format!("Unknown model: {model_id}"))?;
    let cancel = registry.register_download(model_id.clone());
    let result = download::fetch(&app, spec, &models::dir(), cancel).await;
    registry.clear_download(&model_id);
    result.map(|_| ())
}

#[tauri::command]
pub fn localai_cancel_download(registry: State<LocalAiRegistry>, model_id: String) {
    registry.cancel_download(&model_id);
}

#[tauri::command]
pub async fn localai_delete_model(
    registry: State<'_, LocalAiRegistry>,
    model_id: String,
) -> Result<(), String> {
    let spec = catalogue::find(&model_id).ok_or_else(|| format!("Unknown model: {model_id}"))?;

    // In case a download is still running against it — otherwise the delete succeeds and the
    // transfer immediately recreates the file.
    registry.cancel_download(&model_id);

    // And in case the engine has it open. On Windows this is not optional: a mapped file cannot be
    // unlinked, so deleting the active model without this fails with a sharing violation. On macOS
    // the unlink would succeed and leave the server running against an inode with no name, which
    // is worse — the disk stays full and nothing shows why.
    let engine_holds_it = match engine::status() {
        engine::Status::Ready { model_id } | engine::Status::Starting { model_id } => {
            model_id == spec.id
        }
        _ => false,
    };
    if engine_holds_it {
        engine::shutdown().await;
    }

    models::delete(spec)
}

/// Stops the engine now, freeing its memory. The next completion request starts a new one.
#[tauri::command]
pub async fn localai_stop_engine() {
    engine::shutdown().await;
}

/// What the Monaco provider sends.
#[derive(serde::Deserialize)]
pub struct CompletionRequest {
    /// Correlates the cancel call with this request. The provider generates it.
    pub request_id: String,
    pub prefix: String,
    pub suffix: String,
}

/// The gap-filling text, or `None`.
///
/// `None` — not an error — for every ordinary reason there is nothing to show: the feature is off,
/// no model is downloaded, the engine is still warming up, the request was superseded. The caller
/// is a keystroke, and a keystroke must never produce an error toast. Genuine faults (a model that
/// cannot do FIM, a server that died) do come back as `Err` so the settings pane can surface them,
/// but the provider still swallows them into "no suggestion".
#[tauri::command]
pub async fn localai_complete(
    db: State<'_, Db>,
    registry: State<'_, LocalAiRegistry>,
    request: CompletionRequest,
) -> Result<Option<String>, String> {
    let (enabled, model_id) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (read_enabled(&conn)?, read_model_id(&conn)?)
    };
    if !enabled {
        return Ok(None);
    }
    let Some(spec) = catalogue::find(&model_id) else { return Ok(None) };
    if !models::is_installed(spec) {
        return Ok(None);
    }

    // Claimed before the engine is touched, so a keystroke that lands during a cold start cancels
    // the one before it rather than queueing behind it.
    let cancel = registry.begin_completion(request.request_id.clone());

    // `Ok(None)` while the model loads. This is the deliberate answer to the cold-start problem:
    // the first keystroke after the engine is retired gets no ghost text, and the one a second
    // later does. Blocking here instead would stall the provider — and with it Monaco's
    // suggestion pipeline — behind a model load.
    let engine = match engine::ensure(spec, models::path_of(spec)).await {
        Ok(Some(engine)) => engine,
        Ok(None) => {
            registry.finish_completion(&request.request_id);
            return Ok(None);
        }
        Err(message) => {
            registry.finish_completion(&request.request_id);
            return Err(message);
        }
    };

    let outcome = complete::infill(
        &engine,
        &complete::Request { prefix: request.prefix, suffix: request.suffix },
        cancel,
    )
    .await;
    registry.finish_completion(&request.request_id);

    match outcome {
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => Ok(Some(text)),
        // A superseded request is the normal case, not a fault. It must not reach the UI.
        Err(message) if message == complete::CANCELLED => Ok(None),
        Err(message) => Err(message),
    }
}

#[tauri::command]
pub fn localai_cancel_completion(registry: State<LocalAiRegistry>, request_id: String) {
    registry.cancel_completion(&request_id);
}

// --------------------------------------------------------------------- settings

fn read_enabled(conn: &rusqlite::Connection) -> Result<bool, String> {
    // Default off. This feature downloads gigabytes and holds a gigabyte of memory; it is opted
    // into, never defaulted into.
    Ok(queries::get_setting(conn, KEY_ENABLED).map_err(|e| e.to_string())?.as_deref() == Some("1"))
}

fn read_model_id(conn: &rusqlite::Connection) -> Result<String, String> {
    Ok(queries::get_setting(conn, KEY_MODEL)
        .map_err(|e| e.to_string())?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| catalogue::DEFAULT_MODEL_ID.to_string()))
}
