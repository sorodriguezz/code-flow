//! What Settings › Voz y sonido asks of `crate::speech::clone`: which cloning engines are in, the
//! XTTS licence, installing and removing an engine, and making a voice from a recording made here.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{queries, Db};
use crate::speech::clone::{self, ClonedVoice, Engine, PrepareEvent};

/// The microphone's level while a reference is recorded: `{ level }`.
pub const LEVEL_EVENT: &str = "voice:clone-level";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRow {
    pub engine: Engine,
    pub installed: bool,
    pub licence: &'static str,
    /// About what it takes before it is in; what it takes, once it is.
    pub estimate_bytes: u64,
    pub bytes_on_disk: u64,
    pub terms_url: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneVoiceRow {
    #[serde(flatten)]
    pub voice: ClonedVoice,
    pub ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStatus {
    pub engines: Vec<EngineRow>,
    pub xtts_accepted: bool,
    pub voices: Vec<CloneVoiceRow>,
    /// A machine with a graphics card (or Apple Silicon for Chatterbox) speaks in about real time;
    /// a CPU alone takes several seconds a sentence — said before anything is downloaded.
    pub accelerated: bool,
}

fn accepted(app: &AppHandle) -> bool {
    app.state::<Db>().0.lock().ok().and_then(|conn| queries::get_setting(&conn, clone::XTTS_TERMS_KEY).ok().flatten()).is_some_and(|v| !v.trim().is_empty())
}

#[tauri::command]
pub async fn voice_clone_status(app: AppHandle) -> CloneStatus {
    let machine = crate::hybrid::hardware::machine().await;
    let accelerated = matches!(machine.gpu, crate::hybrid::hardware::GpuKind::Discrete | crate::hybrid::hardware::GpuKind::Unified);
    let rows = tokio::task::spawn_blocking(|| {
        [Engine::Chatterbox, Engine::Xtts]
            .into_iter()
            .map(|engine| EngineRow {
                engine,
                installed: clone::installed(engine),
                licence: engine.licence(),
                estimate_bytes: engine.estimate_bytes(),
                bytes_on_disk: clone::bytes_on_disk(engine),
                terms_url: (engine == Engine::Xtts).then_some(clone::XTTS_TERMS_URL),
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    CloneStatus {
        engines: rows,
        xtts_accepted: accepted(&app),
        voices: clone::voices().into_iter().map(|voice| CloneVoiceRow { ready: clone::ready(&voice.id), voice }).collect(),
        accelerated,
    }
}

/// The user accepting (or withdrawing from) XTTS v2's licence — non-commercial use only.
#[tauri::command]
pub fn voice_clone_accept_terms(app: AppHandle, accept: bool) -> Result<(), String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let value = if accept { chrono::Utc::now().to_rfc3339() } else { String::new() };
    queries::set_setting(&conn, clone::XTTS_TERMS_KEY, &value).map_err(|e| e.to_string())
}

static PREPARING: Mutex<bool> = Mutex::new(false);

/// Installs a cloning engine, its progress line by line on `voice:clone`. Gigabytes; one at a time.
#[tauri::command]
pub async fn voice_clone_prepare(app: AppHandle, engine: String) -> Result<(), String> {
    let engine = Engine::parse(&engine).ok_or("Unknown voice engine")?;
    {
        let mut busy = PREPARING.lock().map_err(|e| e.to_string())?;
        if *busy {
            return Err("Another voice engine is installing".into());
        }
        *busy = true;
    }
    let emitter = app.clone();
    let say = move |line: &str| {
        let _ = emitter.emit(clone::EVENT, PrepareEvent { engine: engine.as_str(), state: "running", line: Some(line.to_string()) });
    };
    let result = clone::prepare(engine, accepted(&app), &say).await;
    *PREPARING.lock().unwrap_or_else(|p| p.into_inner()) = false;
    let state = if result.is_ok() { "done" } else { "failed" };
    let _ = app.emit(clone::EVENT, PrepareEvent { engine: engine.as_str(), state, line: result.as_ref().err().cloned() });
    result
}

#[tauri::command]
pub async fn voice_clone_remove(engine: String) -> Result<(), String> {
    let engine = Engine::parse(&engine).ok_or("Unknown voice engine")?;
    tokio::task::spawn_blocking(move || clone::remove(engine)).await.map_err(|e| e.to_string())
}

// ------------------------------------------------------------------------- the reference recording

#[cfg(any(target_os = "macos", windows))]
static RECORDING: Mutex<Option<crate::dictation::capture::Capture>> = Mutex::new(None);
/// What was recorded, held until it is saved as a voice or dropped.
static HELD: Mutex<Option<(Vec<f32>, u32)>> = Mutex::new(None);

/// Starts recording the reference on `device` (`""` = the system's default).
#[tauri::command]
pub async fn voice_clone_record_start(app: AppHandle, device: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", windows))]
    return tokio::task::spawn_blocking(move || {
        if crate::dictation::permission::request() == crate::dictation::permission::Permission::Denied {
            return Err(crate::dictation::capture::DENIED.to_string());
        }
        drop(RECORDING.lock().unwrap_or_else(|p| p.into_inner()).take());
        let levels = app.clone();
        let capture = crate::dictation::capture::start(
            &device,
            move |level| {
                let _ = levels.emit(LEVEL_EVENT, level);
            },
            || {},
        )?;
        *RECORDING.lock().unwrap_or_else(|p| p.into_inner()) = Some(capture);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, device);
        Err("Recording is not available on this platform".into())
    }
}

/// Stops the recording and holds it; how long it was, in seconds.
#[tauri::command]
pub async fn voice_clone_record_finish() -> Result<f32, String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        let capture = RECORDING.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or("Nothing is being recorded")?;
        let (samples, rate) = tokio::task::spawn_blocking(move || capture.stop_raw()).await.map_err(|e| e.to_string())?;
        let seconds = samples.len() as f32 / rate.max(1) as f32;
        *HELD.lock().unwrap_or_else(|p| p.into_inner()) = Some((samples, rate));
        Ok(seconds)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("Recording is not available on this platform".into())
}

#[tauri::command]
pub fn voice_clone_record_cancel() {
    #[cfg(any(target_os = "macos", windows))]
    drop(RECORDING.lock().unwrap_or_else(|p| p.into_inner()).take());
    *HELD.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Makes a voice from the held recording. `consent`: the person recorded agreed.
#[tauri::command]
pub fn voice_clone_save(name: String, engine: String, consent: bool) -> Result<ClonedVoice, String> {
    let engine = Engine::parse(&engine).ok_or("Unknown voice engine")?;
    let held = HELD.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or("Record the voice first")?;
    let made = clone::create(&name, engine, consent, &held.0, held.1);
    if made.is_err() {
        // Kept, so the user can fix the name or the consent without recording again.
        *HELD.lock().unwrap_or_else(|p| p.into_inner()) = Some(held);
    }
    made
}

#[tauri::command]
pub fn voice_clone_delete(id: String) {
    clone::delete(&id);
}
