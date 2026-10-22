//! What Codi's window and the rest of the app ask of `crate::codi`: its state and switches, an order
//! typed instead of said, the answer to a confirmation, an announcement, and — from every window —
//! the interface's catalogue and the answers to its requests (`codi::ui`).

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::codi::{self, ui, CodiState};

#[tauri::command]
pub fn codi_status(app: AppHandle) -> CodiState {
    codi::state(&app)
}

/// Opens (or brings forward) Codi's window.
#[tauri::command]
pub async fn codi_open_window(app: AppHandle) -> Result<String, String> {
    crate::windows::open_codi(app).await
}

/// The microphone switch. On, with something missing, says what (`CODI_MISSING:library,listener`).
#[tauri::command]
pub async fn codi_set_mic(app: AppHandle, on: bool) -> Result<CodiState, String> {
    let worker = app.clone();
    tokio::task::spawn_blocking(move || if on { codi::start(&worker) } else { Ok(codi::stop(&worker)) }).await.map_err(|e| e.to_string())??;
    Ok(codi::state(&app))
}

#[tauri::command]
pub fn codi_set_sound(app: AppHandle, on: bool) -> CodiState {
    codi::set_sound(&app, on);
    codi::state(&app)
}

/// Push-to-talk, held or let go.
#[tauri::command]
pub fn codi_talk(app: AppHandle, held: bool) {
    codi::set_talking(&app, held);
}

/// The push-to-talk chord: the one chosen (`None` = switched off) and this build's default.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PttHotkey {
    accelerator: Option<String>,
    default_accelerator: &'static str,
}

#[tauri::command]
pub fn codi_ptt_hotkey(app: AppHandle) -> PttHotkey {
    PttHotkey { accelerator: codi::hotkey::chosen(&app), default_accelerator: codi::hotkey::DEFAULT }
}

/// Records a chord (`off`, or `""` for the default); `Err` when the system refused it.
#[tauri::command]
pub fn codi_set_ptt_hotkey(app: AppHandle, accelerator: String) -> Result<(), String> {
    codi::hotkey::set(&app, &accelerator)?;
    let _ = app.emit(codi::STATE_EVENT, codi::state(&app));
    Ok(())
}

/// Frees the chord while Settings records a new one.
#[tauri::command]
pub fn codi_suspend_ptt_hotkey(app: AppHandle, suspended: bool) -> Result<(), String> {
    codi::hotkey::suspend(&app, suspended)
}

/// An order typed into Codi's window — the same turn as a spoken one.
#[tauri::command]
pub fn codi_order(app: AppHandle, text: String) {
    codi::order(&app, text);
}

/// The answer to the confirmation Codi is asking (its card's buttons).
#[tauri::command]
pub fn codi_confirm(id: String, yes: bool) -> bool {
    codi::answer(Some(&id), yes)
}

/// «Callar».
#[tauri::command]
pub fn codi_hush() {
    codi::hush();
}

/// Something finished elsewhere while Codi is on — said and logged (the main window sends the
/// notifications it would have spoken).
#[tauri::command]
pub async fn codi_announce(app: AppHandle, text: String, source: String) {
    codi::announce(&app, &text, &source).await;
}

/// Downloads what Codi needs and is missing: sherpa-onnx, the voice detector, and the model this
/// machine is recommended for listening when none usable is in. Progress arrives as `codi:prepare`.
#[tauri::command]
pub async fn codi_prepare(app: AppHandle) -> Result<CodiState, String> {
    use crate::reviewer::download;
    let cancel = CancellationToken::new();
    let emit = |item: &str, done: u64, total: u64| {
        let _ = app.emit("codi:prepare", serde_json::json!({ "item": item, "done": done, "total": total }));
    };
    crate::meetings::ensure_sherpa(&cancel, |done| emit("library", done, crate::meetings::SHERPA.map_or(0, |s| s.size)))
        .await
        .map_err(|e| match e {
            download::FetchError::Cancelled => "cancelled".to_string(),
            download::FetchError::Failed(message) => message,
        })?;
    let detector = codi::vad::MODEL;
    if !codi::vad::model_path().is_file() {
        download::fetch(detector.url, detector.size, detector.sha256, &codi::vad::model_path(), &cancel, |done, total| emit("detector", done, total))
            .await
            .map_err(|e| match e {
                download::FetchError::Cancelled => "cancelled".to_string(),
                download::FetchError::Failed(message) => message,
            })?;
    }
    let settings = {
        use tauri::Manager;
        let db = app.state::<crate::db::Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        codi::load_settings(&conn)
    };
    if codi::listener(&settings).is_none() {
        let pick = crate::voice_fit::picks(crate::voice_fit::class(), 16.0, crate::asr::supported()).codi;
        let model = crate::asr::model(&pick).ok_or_else(|| format!("CODI_MISSING:listener:{pick}"))?;
        let archive = crate::asr::root().join("downloads").join(model.archive);
        download::fetch(model.url, model.size, model.sha256, &archive, &cancel, |done, total| emit(model.id, done, total))
            .await
            .map_err(|e| match e {
                download::FetchError::Cancelled => "cancelled".to_string(),
                download::FetchError::Failed(message) => message,
            })?;
        let from = archive.clone();
        tokio::task::spawn_blocking(move || crate::asr::unpack(model, &from)).await.map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&archive);
        crate::voice_fit::measure_in_background(&app, model.id);
    }
    let state = codi::state(&app);
    let _ = app.emit(codi::STATE_EVENT, &state);
    Ok(state)
}

// ------------------------------------------------------------------------------- the interface

/// A window's catalogue (`src/lib/codi/actions`), registered at boot and again when its language
/// changes.
#[tauri::command]
pub fn codi_register_actions(window: String, actions: Vec<ui::ActionSpec>) {
    ui::register(&window, actions);
}

/// A window's answer to a `codi:act` request.
#[tauri::command]
pub fn codi_act_result(answer: ui::ActResult) {
    ui::answer(answer);
}

/// Runs one interface action from the window (a test, a shortcut): the same door as an engine's.
#[tauri::command]
pub async fn codi_act(app: AppHandle, action: String, params: Value) -> Result<ui::ActResult, String> {
    ui::act(&app, &action, params, ui::Asker::Codi, false).await
}
