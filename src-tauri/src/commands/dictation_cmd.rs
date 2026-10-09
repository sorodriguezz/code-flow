//! «Dictar»: what is installed, installing and removing the engine and its models, the microphone
//! (which inputs there are, whether the system lets us use them, one recording at a time) and turning
//! a recording into text. See `crate::dictation`.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::dictation::{self, engine, permission, EngineSpec, WhisperModel};
use crate::reviewer::download::{self, FetchError};

/// Progress of an install, for Settings: `item` is `"engine"` or a model's id.
pub const EVENT: &str = "dictation:download";
/// The microphone's level while a recording runs: `{ session, level }`, for the waveform.
pub const LEVEL_EVENT: &str = "dictation:level";
/// A recording reached its longest: the session's id. The window that started it finishes it.
pub const LIMIT_EVENT: &str = "dictation:limit";

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

/// The inputs Settings' picker offers — by name, without asking for anything first.
#[tauri::command]
pub async fn dictation_inputs() -> Vec<MicInput> {
    #[cfg(any(target_os = "macos", windows))]
    return tokio::task::spawn_blocking(dictation::capture::inputs).await.unwrap_or_default();
    #[cfg(not(any(target_os = "macos", windows)))]
    Vec::new()
}

#[cfg(any(target_os = "macos", windows))]
type MicInput = dictation::capture::InputDevice;
#[cfg(not(any(target_os = "macos", windows)))]
type MicInput = ();

/// Whether the system lets this app use the microphone, without asking.
#[tauri::command]
pub fn dictation_mic_permission() -> permission::Permission {
    permission::status()
}

/// The system's own question (macOS), when it has not been asked yet — and the answer.
#[tauri::command]
pub async fn dictation_mic_request() -> permission::Permission {
    tokio::task::spawn_blocking(permission::request).await.unwrap_or(permission::Permission::Unknown)
}

/// The system's microphone privacy page.
#[tauri::command]
pub fn dictation_mic_settings() -> Result<(), String> {
    permission::open_settings()
}

/// The recording under way, app-wide, under the id the window that started it gave it.
#[cfg(any(target_os = "macos", windows))]
static RECORDING: Mutex<Option<(String, dictation::capture::Capture)>> = Mutex::new(None);

/// The microphone is open for a dictation — when a voice the user did not ask for keeps quiet
/// (`speech.say`): it would be written down.
pub fn dictating() -> bool {
    #[cfg(any(target_os = "macos", windows))]
    return RECORDING.lock().is_ok_and(|slot| slot.is_some());
    #[cfg(not(any(target_os = "macos", windows)))]
    false
}

/// Takes the recording — only `session`'s, when one is named.
#[cfg(any(target_os = "macos", windows))]
fn take_recording(session: Option<&str>) -> Option<dictation::capture::Capture> {
    let mut slot = RECORDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match (&*slot, session) {
        (Some((current, _)), Some(wanted)) if current != wanted => None,
        _ => slot.take().map(|(_, capture)| capture),
    }
}

#[derive(Clone, Serialize)]
struct Level {
    session: String,
    level: f32,
}

/// Opens the microphone (`device`: an input's id, `""` for the system's default) and starts
/// recording under `session`, the caller's id for it. One at a time: a recording still holding the
/// microphone is dropped first — a window reloaded mid-recording would otherwise hold it for good.
/// On macOS the system's question is asked here, the first time; a refusal is `MIC_DENIED`.
#[tauri::command]
pub async fn dictation_record_start(app: AppHandle, session: String, device: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", windows))]
    return tokio::task::spawn_blocking(move || {
        drop(take_recording(None));
        if permission::request() == permission::Permission::Denied {
            return Err(dictation::capture::DENIED.to_string());
        }
        let (levels, limit) = (app.clone(), app);
        let (level_session, limit_session) = (session.clone(), session.clone());
        let capture = dictation::capture::start(
            &device,
            move |level| {
                let _ = levels.emit(LEVEL_EVENT, Level { session: level_session.clone(), level });
            },
            move || {
                let _ = limit.emit(LIMIT_EVENT, limit_session);
            },
        )?;
        *RECORDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((session, capture));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, session, device);
        Err("Dictation is not available on this platform".into())
    }
}

/// Stops `session`'s recording — the microphone is released before anything else — and returns its
/// text.
#[tauri::command]
pub async fn dictation_record_finish(session: String, model_id: String, language: String) -> Result<String, String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        let capture = take_recording(Some(&session)).ok_or("The recording is no longer under way")?;
        let samples = tokio::task::spawn_blocking(move || capture.stop()).await.map_err(|e| e.to_string())?;
        let model = dictation::model(&model_id).ok_or_else(|| format!("Unknown dictation model: {model_id}"))?;
        let path = dictation::model_path(model);
        if !path.is_file() {
            return Err("The dictation model is not downloaded — Settings › Voice & sound › Models".into());
        }
        if samples.len() < SHORTEST {
            return Ok(String::new());
        }
        tokio::task::spawn_blocking(move || engine::transcribe(&path, &samples, &language)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (session, model_id, language);
        Err("Dictation is not available on this platform".into())
    }
}

/// Releases the microphone and drops `session`'s audio.
#[tauri::command]
pub fn dictation_record_cancel(session: String) {
    #[cfg(any(target_os = "macos", windows))]
    drop(take_recording(Some(&session)));
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = session;
}

/// Stops the transcription under way.
#[tauri::command]
pub fn dictation_cancel() {
    engine::abort();
}
