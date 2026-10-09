//! What the window asks of [`crate::speech`]: saying and silencing, the outputs and the voices,
//! downloading a natural voice, the service keys, and the summary a long answer is read as.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::commands::claude_cmd::{load_ai_config_in, shared_template, AiTask};
use crate::db::Db;
use crate::meetings;
use crate::reviewer::download::{self, FetchError};
use crate::speech::{self, cloud, piper, player, system};

pub const DOWNLOAD_EVENT: &str = "speech:download";

/// The download in progress, if any — one at a time, like every model download in the app.
#[derive(Default)]
pub struct SpeechInstalls {
    install: Mutex<Option<CancellationToken>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechKeys {
    pub openai: bool,
    pub elevenlabs: bool,
}

/// What Settings › Voz y sonido shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub system_voices: Vec<system::SystemVoice>,
    /// The voice «Automática» reads each language with here, by its id; none = the system's default.
    pub system_defaults: SystemDefaults,
    /// Downloaded voices can run here at all.
    pub local_supported: bool,
    /// The sherpa-onnx library is in — shared with meetings' voice separation.
    pub library_installed: bool,
    /// What the first voice download adds when the library is not in yet.
    pub library_bytes: u64,
    pub voices: Vec<piper::VoiceRow>,
    pub keys: SpeechKeys,
}

#[derive(Serialize)]
pub struct SystemDefaults {
    pub es: Option<String>,
    pub en: Option<String>,
}

fn has_key(name: &str) -> bool {
    crate::secrets::get_secret(name).ok().flatten().is_some_and(|k| !k.trim().is_empty())
}

#[tauri::command]
pub async fn speech_status() -> Result<SpeechStatus, String> {
    let system_voices = tauri::async_runtime::spawn_blocking(system::voices).await.map_err(|e| e.to_string())?;
    let library_installed = meetings::sherpa_library().is_some();
    Ok(SpeechStatus {
        system_defaults: SystemDefaults { es: system::pick(&system_voices, "es"), en: system::pick(&system_voices, "en") },
        system_voices,
        local_supported: piper::supported(),
        library_installed,
        library_bytes: if library_installed { 0 } else { meetings::SHERPA.map_or(0, |spec| spec.size) },
        voices: piper::rows(),
        keys: SpeechKeys { openai: has_key(cloud::OPENAI_KEY), elevenlabs: has_key(cloud::ELEVENLABS_KEY) },
    })
}

/// Queues `text` to be said; the id of the utterance its `speech:state` events carry. `lang` is the
/// window's language, for a text too short to tell its own; without it, the app's setting.
#[tauri::command]
pub fn speech_say(app: AppHandle, text: String, origin: String, interrupt: Option<bool>, lang: Option<String>) -> u64 {
    let fallback = match lang {
        Some(lang) => speech::language(&lang),
        None => app.state::<Db>().0.lock().map(|conn| speech::app_language(&conn)).unwrap_or("en"),
    };
    speech::say(&app, &text, &origin, interrupt.unwrap_or(false), fallback)
}

/// «Callar».
#[tauri::command]
pub fn speech_stop() {
    speech::stop();
}

#[tauri::command]
pub fn audio_outputs() -> Vec<player::OutputDevice> {
    player::outputs()
}

/// A short sound on the chosen speaker (a notification's tone rendered by the window).
#[tauri::command]
pub fn audio_play(app: AppHandle, samples: Vec<f32>, rate: u32, volume: f32) {
    speech::play_sound(&app, samples, rate, volume);
}

/// Stores (or, blank, forgets) a voice service's key in the keychain.
#[tauri::command]
pub fn speech_set_key(service: String, key: String) -> Result<(), String> {
    let name = cloud::key_name(&service).ok_or_else(|| format!("Unknown voice service {service}"))?;
    if key.trim().is_empty() {
        crate::secrets::delete_secret(name)
    } else {
        crate::secrets::set_secret(name, key.trim())
    }
}

fn emit_download(app: &AppHandle, item: &str, phase: &'static str, done: u64, total: u64, error: Option<String>) {
    let _ = app.emit(
        DOWNLOAD_EVENT,
        serde_json::json!({ "item": item, "phase": phase, "done": done, "total": total, "error": error }),
    );
}

fn settle(app: &AppHandle, item: &str, error: FetchError) -> String {
    match error {
        FetchError::Cancelled => {
            emit_download(app, item, "cancelled", 0, 0, None);
            "cancelled".into()
        }
        FetchError::Failed(message) => {
            emit_download(app, item, "failed", 0, 0, Some(message.clone()));
            message
        }
    }
}

/// Downloads voice `id` — and sherpa-onnx first, when meetings has not brought it already.
#[tauri::command]
pub async fn speech_install_voice(app: AppHandle, state: State<'_, SpeechInstalls>, id: String) -> Result<(), String> {
    let cancel = CancellationToken::new();
    {
        let mut slot = state.install.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("Another download is under way".into());
        }
        *slot = Some(cancel.clone());
    }
    let result = install(&app, &id, &cancel).await;
    if let Ok(mut slot) = state.install.lock() {
        *slot = None;
    }
    result
}

async fn install(app: &AppHandle, id: &str, cancel: &CancellationToken) -> Result<(), String> {
    let voice = *piper::spec(id).ok_or_else(|| format!("Unknown voice {id}"))?;
    if !piper::supported() {
        return Err("Downloaded voices are not available on this computer".into());
    }
    let library = meetings::SHERPA.ok_or("Downloaded voices are not available on this computer")?;
    let need_library = meetings::sherpa_library().is_none();
    let total = voice.size + if need_library { library.size } else { 0 };
    let downloads = piper::root().join("downloads");
    if need_library {
        let archive = meetings::models_root().join("downloads").join(library.archive);
        download::fetch(library.url, library.size, library.sha256, &archive, cancel, |done, _| emit_download(app, id, "downloading", done, total, None))
            .await
            .map_err(|e| settle(app, id, e))?;
        emit_download(app, id, "unpacking", library.size, total, None);
        let (from, to) = (archive.clone(), meetings::sherpa_dir());
        tokio::task::spawn_blocking(move || meetings::unpack_library(&library, &from, &to))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .map_err(|message| {
                emit_download(app, id, "failed", 0, 0, Some(message.clone()));
                message
            })?;
        let _ = std::fs::remove_file(&archive);
        meetings::remove_stale_sherpa();
    }
    let offset = if need_library { library.size } else { 0 };
    let archive = downloads.join(voice.archive);
    download::fetch(voice.url, voice.size, voice.sha256, &archive, cancel, |done, _| emit_download(app, id, "downloading", offset + done, total, None))
        .await
        .map_err(|e| settle(app, id, e))?;
    emit_download(app, id, "unpacking", total, total, None);
    let from = archive.clone();
    tokio::task::spawn_blocking(move || piper::unpack(&voice, &from))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
        .map_err(|message| {
            emit_download(app, id, "failed", 0, 0, Some(message.clone()));
            message
        })?;
    let _ = std::fs::remove_file(&archive);
    emit_download(app, id, "done", total, total, None);
    Ok(())
}

#[tauri::command]
pub fn speech_cancel_install(state: State<SpeechInstalls>) {
    if let Some(cancel) = state.install.lock().ok().and_then(|slot| slot.clone()) {
        cancel.cancel();
    }
}

/// Deletes voice `id` — and sherpa-onnx with the last voice, unless meetings still separates
/// voices with it.
#[tauri::command]
pub fn speech_remove_voice(id: String) -> Result<(), String> {
    piper::remove(&id);
    if !piper::any_installed() && !meetings::embedding_model_path().is_file() {
        let _ = std::fs::remove_dir_all(meetings::sherpa_dir());
    }
    Ok(())
}

/// «Resumen hablado»: `text` cut to what is worth hearing, by the engine its row routes to.
#[tauri::command]
pub async fn speech_summarize(app: AppHandle, text: String, workspace_id: Option<String>) -> Result<String, String> {
    let (config, template) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (load_ai_config_in(&conn, AiTask::SpokenSummary, workspace_id.as_deref())?, shared_template(&conn, "spoken_summary_template", "")?)
    };
    crate::ai::spoken_summary(&*config.engine, &config.binary, &config.model, &template, &text).await
}
