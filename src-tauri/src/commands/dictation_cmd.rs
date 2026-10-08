//! «Dictar»: what is installed, installing and removing the engine and its models, and turning one
//! recording into text. See `crate::dictation`.

use std::sync::Mutex;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::dictation::{self, engine, EngineSpec, WhisperModel};
use crate::reviewer::download::{self, FetchError};

/// Progress of an install, for Settings: `item` is `"engine"` or a model's id.
pub const EVENT: &str = "dictation:download";

/// Recordings shorter than this are a click on the button, not speech — answered with no text
/// rather than whatever the model makes of a few hundred milliseconds of room noise.
const SHORTEST: usize = 16_000 * 3 / 10;

/// The install under way. One at a time: the engine and a model share one pane and one disk.
#[derive(Default)]
pub struct DictationRegistry {
    install: Mutex<Option<CancellationToken>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    item: String,
    /// `downloading` · `unpacking` · `done` · `failed` · `cancelled`.
    phase: &'static str,
    done: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit(app: &AppHandle, item: &str, phase: &'static str, done: u64, total: u64, error: Option<String>) {
    let _ = app.emit(EVENT, Progress { item: item.to_string(), phase, done, total, error });
}

#[tauri::command]
pub fn dictation_status() -> dictation::Status {
    dictation::status()
}

/// Downloads the engine (when it is not there yet) and `model_id`, verified, into `models/whisper/`.
#[tauri::command]
pub async fn dictation_install(app: AppHandle, registry: State<'_, DictationRegistry>, model_id: String) -> Result<(), String> {
    let model = dictation::model(&model_id).ok_or_else(|| format!("Unknown dictation model: {model_id}"))?;
    let spec = dictation::ENGINE.ok_or("Dictation is not available on this platform")?;
    let cancel = CancellationToken::new();
    {
        let mut slot = registry.install.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("Another dictation download is under way".into());
        }
        *slot = Some(cancel.clone());
    }
    let result = install(&app, spec, model, &cancel).await;
    if let Ok(mut slot) = registry.install.lock() {
        *slot = None;
    }
    result
}

/// What a failed or stopped download tells the pane, and the caller.
fn settle(app: &AppHandle, item: &str, error: FetchError) -> String {
    match error {
        FetchError::Cancelled => {
            emit(app, item, "cancelled", 0, 0, None);
            "cancelled".to_string()
        }
        FetchError::Failed(message) => {
            emit(app, item, "failed", 0, 0, Some(message.clone()));
            message
        }
    }
}

async fn install(app: &AppHandle, spec: EngineSpec, model: &'static WhisperModel, cancel: &CancellationToken) -> Result<(), String> {
    if dictation::engine_library().is_none() {
        let archive = dictation::root().join("downloads").join(spec.archive);
        download::fetch(spec.url, spec.size, spec.sha256, &archive, cancel, |done, total| emit(app, "engine", "downloading", done, total, None))
            .await
            .map_err(|e| settle(app, "engine", e))?;
        emit(app, "engine", "unpacking", spec.size, spec.size, None);
        let (from, to) = (archive.clone(), dictation::engine_dir());
        let unpacked = tokio::task::spawn_blocking(move || dictation::unpack_engine(&spec, &from, &to))
            .await
            .map_err(|e| e.to_string())
            .and_then(|result| result);
        if let Err(message) = unpacked {
            emit(app, "engine", "failed", 0, 0, Some(message.clone()));
            return Err(message);
        }
        // The archive carries every Apple platform (or every tool); what was kept is all that is needed.
        let _ = std::fs::remove_file(&archive);
        emit(app, "engine", "done", spec.size, spec.size, None);
    }
    let path = dictation::model_path(model);
    download::fetch(&model.url(), model.size_bytes, model.sha256, &path, cancel, |done, total| {
        emit(app, model.id, "downloading", done, total, None)
    })
    .await
    .map_err(|e| settle(app, model.id, e))?;
    emit(app, model.id, "done", model.size_bytes, model.size_bytes, None);
    Ok(())
}

#[tauri::command]
pub fn dictation_cancel_install(registry: State<DictationRegistry>) {
    if let Some(cancel) = registry.install.lock().ok().and_then(|slot| slot.clone()) {
        cancel.cancel();
    }
}

/// Deletes one model — and the engine with the last one, so "remove" leaves nothing of dictation
/// behind. The loaded model is freed first: Windows cannot delete a file a process has open.
#[tauri::command]
pub async fn dictation_remove(model_id: String) -> Result<(), String> {
    let model = dictation::model(&model_id).ok_or_else(|| format!("Unknown dictation model: {model_id}"))?;
    tokio::task::spawn_blocking(engine::unload).await.map_err(|e| e.to_string())?;
    let path = dictation::model_path(model);
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("Couldn't delete {}: {e}", path.display()))?;
    }
    let _ = std::fs::remove_file(path.with_file_name(format!("{}.part", model.file)));
    if dictation::MODELS.iter().all(|m| !dictation::model_path(m).is_file()) {
        // Best effort: a library this process has loaded cannot be deleted on Windows until it quits.
        let _ = std::fs::remove_dir_all(dictation::engine_dir());
        let _ = std::fs::remove_dir_all(dictation::root().join("downloads"));
    }
    Ok(())
}

/// The text of one recording: 16-bit little-endian PCM, mono, 16 kHz, base64.
#[tauri::command]
pub async fn dictation_transcribe(audio: String, model_id: String, language: String) -> Result<String, String> {
    let model = dictation::model(&model_id).ok_or_else(|| format!("Unknown dictation model: {model_id}"))?;
    let path = dictation::model_path(model);
    if !path.is_file() {
        return Err("The dictation model is not installed — Settings › AI › Dictation".into());
    }
    let pcm = base64::engine::general_purpose::STANDARD.decode(audio.as_bytes()).map_err(|e| format!("The recording did not arrive whole: {e}"))?;
    let samples = engine::samples_of(&pcm);
    if samples.len() < SHORTEST {
        return Ok(String::new());
    }
    tokio::task::spawn_blocking(move || engine::transcribe(&path, &samples, &language)).await.map_err(|e| e.to_string())?
}

/// Stops the transcription under way.
#[tauri::command]
pub fn dictation_cancel() {
    engine::abort();
}
