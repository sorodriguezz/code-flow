//! «Reuniones» for the windows: recording a meeting into a note, the live text, the queue that
//! finishes meetings one at a time, the transcript's corrections, the voices, the recipes and the
//! downloads. See `crate::meetings` for how the work is done.
//!
//! **One recording at a time, app-wide**, held here with the live transcriber beside it. Its
//! samples never cross into a webview: the windows hear levels (`meetings:level`), finished lines
//! (`meetings:line`) and state changes (`meetings:state`), and read the rest from the database.
//!
//! **One job at a time** (`meetings:progress` while it runs): finishing a meeting is minutes of CPU
//! on a modest laptop, and two at once would finish neither sooner. A job interrupted by a quit is
//! queued again at the next launch; a recording interrupted by a crash is offered for processing
//! (`interrupted`) — its pieces are on disk up to the last second written.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::commands::claude_cmd::{load_ai_config_in, AiTask};
use crate::db::meeting_queries::{self as q, LineRow, MeetingRow, NewMeeting, NewSpeaker, RecipeRow, SpeakerRow, VoiceRow};
use crate::db::{queries, Db};
use crate::meetings::audio::Channel;
use crate::meetings::{self, ai as meeting_ai, live, pipeline, speaker, transcript, Mode};
use crate::reviewer::download::{self, FetchError};

pub const LEVEL_EVENT: &str = "meetings:level";
pub const LINE_EVENT: &str = "meetings:line";
pub const STATE_EVENT: &str = "meetings:state";
pub const PROGRESS_EVENT: &str = "meetings:progress";
pub const DOWNLOAD_EVENT: &str = "meetings:download";
pub const DETECTED_EVENT: &str = "meetings:detected";

/// What is recording and what is being finished — read by `keep_awake` ("busy" holds the machine
/// awake while either is true) and the quit question.
static BUSY: AtomicUsize = AtomicUsize::new(0);

pub fn busy_count() -> usize {
    BUSY.load(Ordering::SeqCst)
}

/// A meeting is being recorded — when a voice the user did not ask for keeps quiet (`speech.say`).
pub fn recording(app: &AppHandle) -> bool {
    app.try_state::<MeetingsState>().is_some_and(|state| state.active.lock().is_ok_and(|active| active.is_some()))
}

#[derive(Default)]
pub struct MeetingsState {
    active: Mutex<Option<Active>>,
    queue: Mutex<VecDeque<JobRequest>>,
    worker_running: AtomicBool,
    current: Mutex<Option<(String, Arc<JobControl>)>>,
    install: Mutex<Option<CancellationToken>>,
    announced: Mutex<HashSet<String>>,
}

struct Active {
    meeting_id: String,
    note_id: String,
    #[cfg(any(target_os = "macos", windows))]
    recording: meetings::recorder::Recording,
    live_stop: Arc<AtomicBool>,
    live: Option<std::thread::JoinHandle<live::Summary>>,
    behind: Arc<AtomicBool>,
}

#[derive(Clone)]
struct JobRequest {
    meeting_id: String,
    /// Transcribe again even when the live text was complete.
    retranscribe: bool,
    /// An imported file to decode first.
    import: Option<PathBuf>,
}

#[derive(Default)]
struct JobControl {
    cancel: AtomicBool,
    abort: AtomicBool,
}

fn db_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn with_db<T>(app: &AppHandle, f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(db_err)?;
    f(&conn).map_err(db_err)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    meeting_id: String,
    note_id: String,
    status: String,
    stage: String,
    error: String,
}

fn emit_state(app: &AppHandle, meeting: &MeetingRow) {
    let _ = app.emit(
        STATE_EVENT,
        StateEvent { meeting_id: meeting.id.clone(), note_id: meeting.note_id.clone(), status: meeting.status.clone(), stage: meeting.stage.clone(), error: meeting.error.clone() },
    );
}

fn set_status(app: &AppHandle, id: &str, status: &str, stage: &str, error: &str) {
    if let Ok(Some(meeting)) = with_db(app, |conn| {
        q::set_status(conn, id, status, stage, error)?;
        q::get_meeting(conn, id)
    }) {
        emit_state(app, &meeting);
    }
}

// ---------------------------------------------------------------------------------------------
// Status, settings, downloads
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    meeting_id: String,
    note_id: String,
    elapsed_ms: i64,
    paused: bool,
    behind: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullStatus {
    #[serde(flatten)]
    status: meetings::Status,
    recording: Option<Recording>,
    /// The meeting being finished, if any.
    processing: Option<String>,
    queued: Vec<String>,
    cloud_key: bool,
}

#[tauri::command]
pub fn meetings_status(state: State<MeetingsState>) -> FullStatus {
    let recording = state.active.lock().ok().and_then(|active| {
        active.as_ref().map(|a| Recording {
            meeting_id: a.meeting_id.clone(),
            note_id: a.note_id.clone(),
            #[cfg(any(target_os = "macos", windows))]
            elapsed_ms: a.recording.elapsed_ms(),
            #[cfg(not(any(target_os = "macos", windows)))]
            elapsed_ms: 0,
            #[cfg(any(target_os = "macos", windows))]
            paused: a.recording.paused(),
            #[cfg(not(any(target_os = "macos", windows)))]
            paused: false,
            behind: a.behind.load(Ordering::SeqCst),
        })
    });
    FullStatus {
        status: meetings::status(),
        recording,
        processing: state.current.lock().ok().and_then(|c| c.as_ref().map(|(id, _)| id.clone())),
        queued: state.queue.lock().map(|q| q.iter().map(|j| j.meeting_id.clone()).collect()).unwrap_or_default(),
        cloud_key: crate::secrets::get_secret(meetings::CLOUD_KEY_SECRET).ok().flatten().is_some_and(|k| !k.trim().is_empty()),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    item: String,
    phase: &'static str,
    done: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_download(app: &AppHandle, item: &str, phase: &'static str, done: u64, total: u64, error: Option<String>) {
    let _ = app.emit(DOWNLOAD_EVENT, Download { item: item.into(), phase, done, total, error });
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

/// Downloads `item`: `vad` (whisper's voice detector, under a megabyte — installed with the first
/// meeting) or `voices` (sherpa-onnx and the voice model).
#[tauri::command]
pub async fn meetings_install(app: AppHandle, state: State<'_, MeetingsState>, item: String) -> Result<(), String> {
    let cancel = CancellationToken::new();
    {
        let mut slot = state.install.lock().map_err(db_err)?;
        if slot.is_some() {
            return Err("Another download is under way".into());
        }
        *slot = Some(cancel.clone());
    }
    let result = install(&app, &item, &cancel).await;
    if let Ok(mut slot) = state.install.lock() {
        *slot = None;
    }
    result
}

async fn install(app: &AppHandle, item: &str, cancel: &CancellationToken) -> Result<(), String> {
    match item {
        "vad" => {
            let model = meetings::VAD_MODEL;
            download::fetch(model.url, model.size, model.sha256, &meetings::vad_model_path(), cancel, |done, total| emit_download(app, "vad", "downloading", done, total, None))
                .await
                .map_err(|e| settle(app, "vad", e))?;
            emit_download(app, "vad", "done", model.size, model.size, None);
            Ok(())
        }
        "voices" => {
            let spec = meetings::SHERPA.ok_or("Voice separation is not available on this platform")?;
            let model = meetings::EMBEDDING_MODEL;
            let total = spec.size + model.size;
            if meetings::sherpa_library().is_none() {
                let archive = meetings::models_root().join("downloads").join(spec.archive);
                download::fetch(spec.url, spec.size, spec.sha256, &archive, cancel, |done, _| emit_download(app, "voices", "downloading", done, total, None))
                    .await
                    .map_err(|e| settle(app, "voices", e))?;
                emit_download(app, "voices", "unpacking", spec.size, total, None);
                let (from, to) = (archive.clone(), meetings::sherpa_dir());
                tokio::task::spawn_blocking(move || meetings::unpack_library(&spec, &from, &to))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|r| r)
                    .map_err(|message| {
                        emit_download(app, "voices", "failed", 0, 0, Some(message.clone()));
                        message
                    })?;
                let _ = std::fs::remove_file(&archive);
                meetings::remove_stale_sherpa();
            }
            download::fetch(model.url, model.size, model.sha256, &meetings::embedding_model_path(), cancel, |done, _| {
                emit_download(app, "voices", "downloading", spec.size + done, total, None)
            })
            .await
            .map_err(|e| settle(app, "voices", e))?;
            emit_download(app, "voices", "done", total, total, None);
            Ok(())
        }
        other => Err(format!("Unknown download: {other}")),
    }
}

#[tauri::command]
pub fn meetings_cancel_install(state: State<MeetingsState>) {
    if let Some(cancel) = state.install.lock().ok().and_then(|slot| slot.clone()) {
        cancel.cancel();
    }
}

/// Deletes the voice separation model — and the library, unless a downloaded reading voice still
/// needs it (`crate::speech::piper`). A library this process has loaded cannot be deleted on Windows
/// until it quits; it goes at the next attempt.
#[tauri::command]
pub fn meetings_remove_voices() -> Result<(), String> {
    let _ = std::fs::remove_file(meetings::embedding_model_path());
    if !crate::speech::piper::any_installed() {
        let _ = std::fs::remove_dir_all(meetings::sherpa_dir());
    }
    Ok(())
}

#[tauri::command]
pub fn meetings_set_cloud_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        crate::secrets::delete_secret(meetings::CLOUD_KEY_SECRET)
    } else {
        crate::secrets::set_secret(meetings::CLOUD_KEY_SECRET, key.trim())
    }
}

/// Sends a second of silence to the configured cloud service — whether URL, model and key work.
#[tauri::command]
pub async fn meetings_test_cloud(db: State<'_, Db>) -> Result<(), String> {
    let settings = {
        let conn = db.0.lock().map_err(db_err)?;
        meetings::load_settings(&conn)
    };
    let key = crate::secrets::get_secret(meetings::CLOUD_KEY_SECRET)?.unwrap_or_default();
    meetings::cloud::check(&settings.cloud_settings, &key).await
}

/// Measures this machine (`meetings::bench`) and stores the result for «Automático».
#[tauri::command]
pub async fn meetings_bench(db: State<'_, Db>) -> Result<meetings::bench::Measured, String> {
    let threads = {
        let conn = db.0.lock().map_err(db_err)?;
        meetings::threads(meetings::load_settings(&conn).threads)
    };
    let measured = tokio::task::spawn_blocking(move || meetings::bench::measure(threads)).await.map_err(|e| e.to_string())??;
    let conn = db.0.lock().map_err(db_err)?;
    queries::set_setting(&conn, meetings::key::BENCH, &serde_json::to_string(&measured).unwrap_or_default()).map_err(db_err)?;
    Ok(measured)
}

/// The macOS page where "System audio recording" is granted (Windows needs none).
#[tauri::command]
pub fn meetings_system_audio_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return open::that("x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture").map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    Err("Not needed on this system".into())
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    meeting: MeetingRow,
    /// Something the user should know: `SYSTEM_AUDIO_DENIED` when only the microphone records.
    warning: Option<String>,
    /// The mode the meeting records in, after «Automático» was resolved.
    mode: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelEvent {
    meeting_id: String,
    channel: Channel,
    level: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LineEvent {
    meeting_id: String,
    line: LineRow,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LagEvent {
    meeting_id: String,
    lag_ms: i64,
    behind: bool,
}

/// The mode a meeting records in: the one asked for, the setting, or the measured recommendation
/// (balanced when nothing was measured).
fn resolve_mode(asked: Option<&str>, settings: &meetings::Settings, conn: &rusqlite::Connection) -> Mode {
    if let Some(mode) = asked.and_then(Mode::parse) {
        return mode;
    }
    if let Some(mode) = settings.mode {
        return mode;
    }
    queries::get_setting(conn, meetings::key::BENCH)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<meetings::bench::Measured>(&raw).ok())
        .and_then(|m| Mode::parse(&m.recommended))
        .unwrap_or(Mode::Balanced)
}

/// Starts recording a meeting into `note_id`. `kind` is `virtual` (microphone and the computer's
/// audio) or `room` (the microphone alone). `mode` overrides the setting (`light` · `balanced` ·
/// `full`), `language` is whisper's (`""` = detect).
#[tauri::command]
pub async fn meetings_start(
    app: AppHandle,
    state: State<'_, MeetingsState>,
    note_id: String,
    workspace_id: String,
    kind: String,
    mode: Option<String>,
    language: String,
) -> Result<Started, String> {
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, state, note_id, workspace_id, kind, mode, language);
        Err("Meetings are not available on this platform".into())
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        if state.active.lock().map_err(db_err)?.is_some() {
            return Err("A meeting is already being recorded".into());
        }
        if !meetings::vad_model_path().is_file() {
            // Under a megabyte: fetched on the spot rather than sending the user to Settings.
            let cancel = CancellationToken::new();
            install(&app, "vad", &cancel).await?;
        }
        let (settings, local_only, resolved) = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(db_err)?;
            let settings = meetings::load_settings(&conn);
            let local_only = q::note_is_local_only(&conn, &note_id).map_err(db_err)?;
            let resolved = resolve_mode(mode.as_deref(), &settings, &conn);
            (settings, local_only, resolved)
        };
        let cloud = settings.cloud && !local_only;
        let key = if cloud { crate::secrets::get_secret(meetings::CLOUD_KEY_SECRET)?.unwrap_or_default() } else { String::new() };
        // OpenAI and Groq refuse without one; a server of the user's own may not need it, so only
        // the services that always do are stopped here.
        let hosted = settings.cloud_settings.url.trim().is_empty() || settings.cloud_settings.url.contains("openai.com") || settings.cloud_settings.url.contains("groq.com");
        if cloud && hosted && key.trim().is_empty() {
            return Err("MEETINGS_NO_CLOUD_KEY".into());
        }
        let live_model = meetings::pick_model(&settings.live_model, true);
        if !cloud && meetings::pick_model(&settings.final_model, false).is_none() {
            return Err("MEETINGS_NO_MODEL".into());
        }
        // Without a live model (or with the cloud and no key), the text waits for the end.
        let mode = if resolved.live() && !cloud && live_model.is_none() { Mode::Light } else { resolved };
        let system = kind != "room";
        let permission = tokio::task::spawn_blocking(crate::dictation::permission::request).await.map_err(|e| e.to_string())?;
        if permission == crate::dictation::permission::Permission::Denied {
            return Err(meetings::recorder::MIC_DENIED.into());
        }
        let meeting = with_db(&app, |conn| {
            q::create_meeting(
                conn,
                &NewMeeting {
                    workspace_id: &workspace_id,
                    note_id: &note_id,
                    kind: if system { "virtual" } else { "room" },
                    mode: mode.as_str(),
                    transcriber: if cloud { "cloud" } else { "local" },
                    language: &language,
                    channels: if system { &["mic", "system"] } else { &["mic"] },
                    status: "recording",
                },
            )
        })?;
        let dir = meetings::meeting_dir(&meeting.id);
        let level_app = app.clone();
        let level_id = meeting.id.clone();
        let on_level: Arc<dyn Fn(Channel, f32) + Send + Sync> = Arc::new(move |channel, level| {
            let _ = level_app.emit(LEVEL_EVENT, LevelEvent { meeting_id: level_id.clone(), channel, level });
        });
        let (live_tx, live_rx) = if mode.live() { let (tx, rx) = std::sync::mpsc::channel(); (Some(tx), Some(rx)) } else { (None, None) };
        let sources = meetings::recorder::Sources { mic_device: settings.device.clone(), system };
        let started = {
            let (dir, on_level, live_tx) = (dir.clone(), on_level.clone(), live_tx.clone());
            tokio::task::spawn_blocking(move || meetings::recorder::start(&dir, sources, on_level, live_tx)).await.map_err(|e| e.to_string())?
        };
        let (recording, warning) = match started {
            Ok(recording) => (recording, None),
            Err(error) if system && error.starts_with(meetings::recorder::SYSTEM_DENIED) => {
                // The computer's audio refused: the microphone alone is still a meeting.
                crate::applog::warn(&format!("meetings: system audio unavailable: {error}"));
                let _ = std::fs::remove_dir_all(meetings::audio::channel_dir(&dir, Channel::System));
                let sources = meetings::recorder::Sources { mic_device: settings.device.clone(), system: false };
                let dir2 = dir.clone();
                let mic_only = tokio::task::spawn_blocking(move || meetings::recorder::start(&dir2, sources, on_level, live_tx)).await.map_err(|e| e.to_string())?;
                match mic_only {
                    Ok(recording) => {
                        let _ = with_db(&app, |conn| {
                            conn.execute("UPDATE meetings SET channels = '[\"mic\"]', kind = 'room' WHERE id = ?1", rusqlite::params![meeting.id])
                        });
                        (recording, Some(meetings::recorder::SYSTEM_DENIED.to_string()))
                    }
                    Err(error) => {
                        let _ = with_db(&app, |conn| q::delete_meeting(conn, &meeting.id));
                        let _ = std::fs::remove_dir_all(&dir);
                        return Err(error);
                    }
                }
            }
            Err(error) => {
                let _ = with_db(&app, |conn| q::delete_meeting(conn, &meeting.id));
                let _ = std::fs::remove_dir_all(&dir);
                return Err(error);
            }
        };
        let meeting = with_db(&app, |conn| q::get_meeting(conn, &meeting.id))?.ok_or("The meeting vanished")?;
        let live_stop = Arc::new(AtomicBool::new(false));
        let behind = Arc::new(AtomicBool::new(false));
        let live_thread = live_rx.map(|rx| {
            let engine = if cloud {
                live::Engine::Cloud { settings: settings.cloud_settings.clone(), key: key.clone() }
            } else {
                live::Engine::Local { model: crate::dictation::model_path(live_model.expect("checked above")) }
            };
            let separate = if meeting.kind == "room" { vec![Channel::Mic] } else { vec![Channel::System] };
            let config = live::Config {
                engine,
                vad_model: meetings::vad_model_path(),
                embedding_model: meetings::embedding_model_path(),
                language: language.clone(),
                threads: meetings::threads(settings.threads),
                vocabulary: settings.vocabulary.clone(),
                separate,
                embed: mode == Mode::Full && meetings::voices_installed(),
            };
            let (event_app, event_id, event_behind) = (app.clone(), meeting.id.clone(), behind.clone());
            let on_event: Arc<dyn Fn(live::LiveEvent) + Send + Sync> = Arc::new(move |event| on_live(&event_app, &event_id, &event_behind, event));
            live::spawn(rx, config, live_stop.clone(), on_event)
        });
        BUSY.fetch_add(1, Ordering::SeqCst);
        *state.active.lock().map_err(db_err)? = Some(Active {
            meeting_id: meeting.id.clone(),
            note_id: note_id.clone(),
            recording,
            live_stop,
            live: live_thread,
            behind,
        });
        emit_state(&app, &meeting);
        Ok(Started { meeting, warning, mode: mode.as_str().into() })
    }
}

fn on_live(app: &AppHandle, meeting_id: &str, behind: &AtomicBool, event: live::LiveEvent) {
    match event {
        live::LiveEvent::Line(line) => {
            let row = LineRow {
                seq: 0,
                channel: line.channel.as_str().into(),
                speaker: line.speaker.clone(),
                start_ms: line.start_ms,
                end_ms: line.end_ms,
                text: line.text.clone(),
                pass: "live".into(),
                edited: false,
            };
            let stored = with_db(app, |conn| {
                q::ensure_speaker(conn, meeting_id, &row.speaker, row.speaker == transcript::ME)?;
                q::append_line(conn, meeting_id, &row)
            });
            if let Ok(seq) = stored {
                let _ = app.emit(LINE_EVENT, LineEvent { meeting_id: meeting_id.into(), line: LineRow { seq, ..row } });
            }
        }
        live::LiveEvent::Lag(lag_ms) => {
            let _ = app.emit("meetings:lag", LagEvent { meeting_id: meeting_id.into(), lag_ms, behind: behind.load(Ordering::SeqCst) });
        }
        live::LiveEvent::Behind => {
            behind.store(true, Ordering::SeqCst);
            let _ = app.emit("meetings:lag", LagEvent { meeting_id: meeting_id.into(), lag_ms: live::GIVE_UP_LAG_MS, behind: true });
        }
        live::LiveEvent::Failed(error) => crate::applog::warn(&format!("meetings: live text: {error}")),
    }
}

#[tauri::command]
pub fn meetings_pause(app: AppHandle, state: State<MeetingsState>, meeting_id: String, paused: bool) -> Result<(), String> {
    let active = state.active.lock().map_err(db_err)?;
    let Some(active) = active.as_ref().filter(|a| a.meeting_id == meeting_id) else { return Err("That meeting is not being recorded".into()) };
    #[cfg(any(target_os = "macos", windows))]
    if paused {
        active.recording.pause();
    } else {
        active.recording.resume();
    }
    set_status(&app, &meeting_id, if paused { "paused" } else { "recording" }, "", "");
    let _ = active;
    Ok(())
}

/// Takes the recording out of the state and stops it: the pieces closed, the live text finished
/// (or abandoned). Blocking.
fn stop_active(active: Active) -> (i64, bool) {
    active.live_stop.store(true, Ordering::SeqCst);
    #[cfg(any(target_os = "macos", windows))]
    let elapsed = active.recording.elapsed_ms();
    #[cfg(not(any(target_os = "macos", windows)))]
    let elapsed = 0;
    #[cfg(any(target_os = "macos", windows))]
    if let Err(error) = active.recording.stop() {
        crate::applog::warn(&format!("meetings: stopping the recording: {error}"));
    }
    let complete = match active.live {
        Some(thread) => thread.join().map(|s| s.complete).unwrap_or(false),
        None => false,
    };
    BUSY.fetch_sub(1, Ordering::SeqCst);
    (elapsed, complete)
}

/// Stops the recording and queues it to be finished.
#[tauri::command]
pub async fn meetings_stop(app: AppHandle, state: State<'_, MeetingsState>, meeting_id: String) -> Result<MeetingRow, String> {
    let active = {
        let mut slot = state.active.lock().map_err(db_err)?;
        match slot.as_ref() {
            Some(a) if a.meeting_id == meeting_id => slot.take().expect("checked"),
            _ => return Err("That meeting is not being recorded".into()),
        }
    };
    set_status(&app, &meeting_id, "queued", "stopping", "");
    let (_, complete) = tokio::task::spawn_blocking(move || stop_active(active)).await.map_err(|e| e.to_string())?;
    let dir = meetings::meeting_dir(&meeting_id);
    let duration = [Channel::Mic, Channel::System].iter().map(|c| meetings::audio::channel_ms(&dir, *c)).max().unwrap_or(0);
    with_db(&app, |conn| q::finish_recording(conn, &meeting_id, duration, complete))?;
    enqueue(&app, JobRequest { meeting_id: meeting_id.clone(), retranscribe: false, import: None });
    let meeting = with_db(&app, |conn| q::get_meeting(conn, &meeting_id))?.ok_or("The meeting vanished")?;
    emit_state(&app, &meeting);
    Ok(meeting)
}

/// Stops the recording and throws it away — the "Descartar" of a recording started by mistake.
#[tauri::command]
pub async fn meetings_discard(app: AppHandle, state: State<'_, MeetingsState>, meeting_id: String) -> Result<(), String> {
    let active = {
        let mut slot = state.active.lock().map_err(db_err)?;
        match slot.as_ref() {
            Some(a) if a.meeting_id == meeting_id => slot.take(),
            _ => None,
        }
    };
    if let Some(active) = active {
        tokio::task::spawn_blocking(move || stop_active(active)).await.map_err(|e| e.to_string())?;
    }
    delete(&app, &meeting_id)
}

fn delete(app: &AppHandle, meeting_id: &str) -> Result<(), String> {
    let note = with_db(app, |conn| q::get_meeting(conn, meeting_id))?.map(|m| m.note_id).unwrap_or_default();
    with_db(app, |conn| q::delete_meeting(conn, meeting_id))?;
    let _ = std::fs::remove_dir_all(meetings::meeting_dir(meeting_id));
    let _ = app.emit(STATE_EVENT, StateEvent { meeting_id: meeting_id.into(), note_id: note, status: "deleted".into(), stage: String::new(), error: String::new() });
    Ok(())
}

#[tauri::command]
pub async fn meetings_delete(app: AppHandle, state: State<'_, MeetingsState>, meeting_id: String) -> Result<(), String> {
    if state.active.lock().map_err(db_err)?.as_ref().is_some_and(|a| a.meeting_id == meeting_id) {
        return meetings_discard(app, state, meeting_id).await;
    }
    cancel_job(&state, &meeting_id);
    delete(&app, &meeting_id)
}

// ---------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------

fn enqueue(app: &AppHandle, request: JobRequest) {
    let state = app.state::<MeetingsState>();
    if let Ok(mut queue) = state.queue.lock() {
        if !queue.iter().any(|j| j.meeting_id == request.meeting_id) {
            queue.push_back(request);
        }
    }
    if !state.worker_running.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { worker(app).await });
    }
}

async fn worker(app: AppHandle) {
    loop {
        let next = app.state::<MeetingsState>().queue.lock().ok().and_then(|mut q| q.pop_front());
        let Some(request) = next else {
            app.state::<MeetingsState>().worker_running.store(false, Ordering::SeqCst);
            // A job queued between the pop and the flag going down would wait for the next one.
            let pending = app.state::<MeetingsState>().queue.lock().map(|q| !q.is_empty()).unwrap_or(false);
            if pending && !app.state::<MeetingsState>().worker_running.swap(true, Ordering::SeqCst) {
                continue;
            }
            return;
        };
        let control = Arc::new(JobControl::default());
        if let Ok(mut current) = app.state::<MeetingsState>().current.lock() {
            *current = Some((request.meeting_id.clone(), control.clone()));
        }
        BUSY.fetch_add(1, Ordering::SeqCst);
        let id = request.meeting_id.clone();
        let result = process(&app, request, control.clone()).await;
        BUSY.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut current) = app.state::<MeetingsState>().current.lock() {
            *current = None;
        }
        match result {
            Ok(()) => {
                set_status(&app, &id, "ready", "", "");
                announce_ready(&app, &id);
            }
            Err(error) if error == "cancelled" || control.cancel.load(Ordering::SeqCst) => set_status(&app, &id, "failed", "", "cancelled"),
            Err(error) => {
                crate::applog::warn(&format!("meetings: finishing {id}: {error}"));
                set_status(&app, &id, "failed", "", &error)
            }
        }
    }
}

/// What a speaker is called when nobody named it, in the app's language.
fn default_name(key: &str, kind: &str, english: bool) -> String {
    match key {
        "me" => (if english { "You" } else { "Tú" }).into(),
        "others" if kind == "virtual" => (if english { "Others" } else { "Otros" }).into(),
        "others" => (if english { "Participants" } else { "Participantes" }).into(),
        other => {
            let n = other.trim_start_matches('p').parse::<usize>().map_or(1, |n| n + 1);
            if english { format!("Person {n}") } else { format!("Persona {n}") }
        }
    }
}

/// Flujos' «Evento de CodeFlow › Se transcribió una reunión»: the meeting, its note, who spoke and
/// what was said, as one item.
fn announce_ready(app: &AppHandle, meeting_id: &str) {
    let Ok((Some(meeting), lines, speakers, title, english)) = with_db(app, |conn| {
        let meeting = q::get_meeting(conn, meeting_id)?;
        let title = match &meeting {
            Some(m) => conn
                .query_row("SELECT title FROM notes WHERE id = ?1", rusqlite::params![m.note_id], |row| row.get::<_, String>(0))
                .unwrap_or_default(),
            None => String::new(),
        };
        let english = queries::get_setting(conn, "app_language").ok().flatten().as_deref() == Some("en");
        Ok((meeting, q::lines(conn, meeting_id)?, q::speakers(conn, meeting_id)?, title, english))
    }) else {
        return;
    };
    let name_of = |key: &str| {
        speakers
            .iter()
            .find(|s| s.key == key)
            .map(|s| s.name.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| default_name(key, &meeting.kind, english))
    };
    let rows: Vec<(i64, String, String)> = lines.iter().map(|l| (l.start_ms, name_of(&l.speaker), l.text.clone())).collect();
    let payload = serde_json::json!({
        "meetingId": meeting.id,
        "noteId": meeting.note_id,
        "workspaceId": meeting.workspace_id,
        "title": title,
        "startedAt": meeting.started_at,
        "durationMs": meeting.duration_ms,
        "speakers": speakers.iter().map(|s| serde_json::json!({"name": name_of(&s.key), "minutes": s.talk_ms / 60_000, "isMe": s.is_me})).collect::<Vec<_>>(),
        "lines": lines.iter().map(|l| serde_json::json!({"at": meetings::clock(l.start_ms), "speaker": name_of(&l.speaker), "text": l.text})).collect::<Vec<_>>(),
        "transcript": transcript::for_ai(&rows),
    });
    crate::flows::triggers::app_event(app, "meetingReady", payload);
}

fn cancel_job(state: &MeetingsState, meeting_id: &str) {
    if let Ok(mut queue) = state.queue.lock() {
        queue.retain(|j| j.meeting_id != meeting_id);
    }
    if let Ok(current) = state.current.lock() {
        if let Some((id, control)) = current.as_ref() {
            if id == meeting_id {
                control.cancel.store(true, Ordering::SeqCst);
                control.abort.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[tauri::command]
pub fn meetings_cancel_job(app: AppHandle, state: State<MeetingsState>, meeting_id: String) {
    let queued = state.queue.lock().map(|q| q.iter().any(|j| j.meeting_id == meeting_id)).unwrap_or(false);
    cancel_job(&state, &meeting_id);
    if queued {
        set_status(&app, &meeting_id, "failed", "", "cancelled");
    }
}

/// Finishes `meeting_id` again: `retranscribe` transcribes it anew (another model, the cloud);
/// `speakers` is how many people there were (0 = unknown).
#[tauri::command]
pub fn meetings_reprocess(app: AppHandle, meeting_id: String, retranscribe: bool, speakers: i64, cloud: Option<bool>) -> Result<(), String> {
    with_db(&app, |conn| {
        let transcriber = match cloud {
            Some(true) => "cloud".to_string(),
            Some(false) => "local".to_string(),
            None => q::get_meeting(conn, &meeting_id)?.map(|m| m.transcriber).unwrap_or_else(|| "local".into()),
        };
        q::set_processing_choices(conn, &meeting_id, &transcriber, speakers.max(0))
    })?;
    set_status(&app, &meeting_id, "queued", "", "");
    enqueue(&app, JobRequest { meeting_id, retranscribe, import: None });
    Ok(())
}

/// A meeting from an audio or video file: decoded, then finished like a recording of a room.
#[tauri::command]
pub fn meetings_import(app: AppHandle, note_id: String, workspace_id: String, path: String, language: String) -> Result<MeetingRow, String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let (cloud, local_only) = with_db(&app, |conn| Ok((meetings::load_settings(conn).cloud, q::note_is_local_only(conn, &note_id)?)))?;
    let meeting = with_db(&app, |conn| {
        q::create_meeting(
            conn,
            &NewMeeting {
                workspace_id: &workspace_id,
                note_id: &note_id,
                kind: "import",
                mode: "light",
                transcriber: if cloud && !local_only { "cloud" } else { "local" },
                language: &language,
                channels: &["mic"],
                status: "queued",
            },
        )
    })?;
    emit_state(&app, &meeting);
    enqueue(&app, JobRequest { meeting_id: meeting.id.clone(), retranscribe: true, import: Some(file) });
    Ok(meeting)
}

struct Reporter {
    app: AppHandle,
    meeting_id: String,
    control: Arc<JobControl>,
    last: Mutex<(Instant, &'static str, f32)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    meeting_id: String,
    stage: &'static str,
    fraction: f32,
}

impl pipeline::Host for Reporter {
    fn progress(&self, stage: &'static str, fraction: f32) {
        let Ok(mut last) = self.last.lock() else { return };
        if last.1 == stage && last.0.elapsed() < Duration::from_millis(300) && (fraction - last.2).abs() < 0.05 && fraction < 1.0 {
            return;
        }
        *last = (Instant::now(), stage, fraction);
        let _ = self.app.emit(PROGRESS_EVENT, ProgressEvent { meeting_id: self.meeting_id.clone(), stage, fraction });
    }

    fn cancelled(&self) -> bool {
        self.control.cancel.load(Ordering::SeqCst)
    }

    fn abort_flag(&self) -> &AtomicBool {
        &self.control.abort
    }
}

async fn process(app: &AppHandle, request: JobRequest, control: Arc<JobControl>) -> Result<(), String> {
    let id = request.meeting_id.clone();
    let meeting = with_db(app, |conn| q::get_meeting(conn, &id))?.ok_or("The meeting no longer exists")?;
    let (settings, local_only, voices) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        let settings = meetings::load_settings(&conn);
        let local_only = q::note_is_local_only(&conn, &meeting.note_id).map_err(db_err)?;
        let voices = q::voice_embeddings(&conn, meetings::EMBEDDING_MODEL_ID).map_err(db_err)?;
        (settings, local_only, voices)
    };
    set_status(app, &id, "processing", "detect", "");
    let dir = meetings::meeting_dir(&id);
    let channels: Vec<Channel> = serde_json::from_str::<Vec<String>>(&meeting.channels).unwrap_or_default().iter().filter_map(|c| Channel::parse(c)).collect();
    let channels = if channels.is_empty() { vec![Channel::Mic] } else { channels };

    if let Some(file) = &request.import {
        set_status(app, &id, "processing", "decode", "");
        let (file, dir2, reporter_app, report_id) = (file.clone(), dir.clone(), app.clone(), id.clone());
        tokio::task::spawn_blocking(move || {
            meetings::encode::decode_to_pieces(&file, &dir2, &[Channel::Mic], |fraction| {
                let _ = reporter_app.emit(PROGRESS_EVENT, ProgressEvent { meeting_id: report_id.clone(), stage: "decode", fraction });
            })
        })
        .await
        .map_err(|e| e.to_string())??;
        let duration = meetings::audio::channel_ms(&dir, Channel::Mic);
        with_db(app, |conn| q::set_duration(conn, &id, duration))?;
    }
    let decoded = {
        let (dir, channels, audio) = (dir.clone(), channels.clone(), meeting.audio_file.clone());
        tokio::task::spawn_blocking(move || pipeline::ensure_pieces(&dir, &channels, &audio)).await.map_err(|e| e.to_string())??
    };

    let mode = Mode::parse(&meeting.mode).unwrap_or(Mode::Balanced);
    let has_live = with_db(app, |conn| q::lines(conn, &id))?;
    let transcribe_again = request.retranscribe || mode != Mode::Balanced || !meeting.live_complete || has_live.is_empty();
    let cloud = meeting.transcriber == "cloud" && !local_only;
    let transcriber = if !transcribe_again {
        None
    } else if cloud {
        let key = crate::secrets::get_secret(meetings::CLOUD_KEY_SECRET)?.unwrap_or_default();
        Some(pipeline::Transcriber::Cloud { settings: settings.cloud_settings.clone(), key })
    } else {
        let preferred = if mode == Mode::Full && settings.final_model.trim().is_empty() { "turbo" } else { settings.final_model.as_str() };
        let model = meetings::pick_model(preferred, false).ok_or("MEETINGS_NO_MODEL")?;
        Some(pipeline::Transcriber::Local { model: crate::dictation::model_path(model) })
    };
    let live_lines: Vec<transcript::Line> = has_live
        .iter()
        .filter_map(|l| Some(transcript::Line { channel: Channel::parse(&l.channel)?, speaker: l.speaker.clone(), start_ms: l.start_ms, end_ms: l.end_ms, text: l.text.clone() }))
        .collect();
    let separate = if meeting.kind == "virtual" { vec![Channel::System] } else { vec![Channel::Mic] };
    let job = pipeline::Job {
        dir: dir.clone(),
        vad_model: meetings::vad_model_path(),
        embedding_model: meetings::embedding_model_path(),
        channels: channels.clone(),
        separate,
        transcribe: transcriber,
        live_lines,
        language: meeting.language.clone(),
        threads: meetings::threads(settings.threads),
        vocabulary: settings.vocabulary.clone(),
        speakers_hint: meeting.speakers_hint.max(0) as usize,
        voices: voices
            .into_iter()
            .map(|(row, blob)| pipeline::Voice { id: row.id, name: row.name, is_me: row.is_me, embedding: speaker::from_blob(&blob) })
            .collect(),
        diarize: meetings::voices_installed(),
    };
    let reporter = Reporter { app: app.clone(), meeting_id: id.clone(), control: control.clone(), last: Mutex::new((Instant::now(), "", 0.0)) };
    let outcome = tokio::task::spawn_blocking(move || {
        let result = pipeline::run(&job, &reporter);
        (result, reporter)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (result, reporter) = outcome;
    let outcome = result?;
    drop(reporter);

    // The result first, the audio after: a failure compressing never costs the transcript.
    let pass = if transcribe_again { "final" } else { "live" };
    let lines: Vec<LineRow> = outcome
        .lines
        .iter()
        .map(|l| LineRow { seq: 0, channel: l.channel.as_str().into(), speaker: l.speaker.clone(), start_ms: l.start_ms, end_ms: l.end_ms, text: l.text.clone(), pass: pass.into(), edited: false })
        .collect();
    let speakers: Vec<NewSpeaker> = outcome
        .speakers
        .iter()
        .map(|s| NewSpeaker {
            key: s.key.clone(),
            name: s.name.clone().unwrap_or_default(),
            is_me: s.is_me,
            voice_id: s.voice_id.clone().unwrap_or_default(),
            embedding: s.centroid.as_deref().map(speaker::to_blob),
            talk_ms: s.talk_ms,
        })
        .collect();
    with_db(app, |conn| {
        q::replace_result(conn, &id, &lines, &speakers)?;
        q::set_duration(conn, &id, outcome.duration_ms.max(meeting.duration_ms))
    })?;

    if meeting.audio_file.is_empty() || !decoded {
        set_status(app, &id, "processing", "compress", "");
        let (dir2, channels2) = (dir.clone(), channels.clone());
        let compressed = tokio::task::spawn_blocking(move || {
            pipeline::write_peaks(&dir2, &channels2);
            meetings::encode::compress(&dir2, &channels2)
        })
        .await
        .map_err(|e| e.to_string())?;
        match compressed {
            Ok(file) => {
                let bytes = std::fs::metadata(dir.join(&file)).map(|m| m.len() as i64).unwrap_or(0);
                let expires = match settings.audio_days {
                    0 => String::new(),
                    days if days < 0 => chrono::Utc::now().to_rfc3339(),
                    days => (chrono::Utc::now() + chrono::Duration::days(days)).to_rfc3339(),
                };
                with_db(app, |conn| q::set_audio(conn, &id, &file, bytes, &expires))?;
                pipeline::drop_pieces(&dir, &channels);
                if settings.audio_days < 0 {
                    sweep_audio(app);
                }
            }
            Err(error) => crate::applog::warn(&format!("meetings: compressing {id}: {error}")),
        }
    } else {
        // A second pass decoded the kept file back into pieces: they go again.
        pipeline::drop_pieces(&dir, &channels);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Reading and correcting
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn meetings_for_note(db: State<Db>, note_id: String) -> Result<Vec<MeetingRow>, String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::meetings_for_note(&conn, &note_id).map_err(db_err)
}

#[tauri::command]
pub fn meetings_notes_with(db: State<Db>, workspace_id: String) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::notes_with_meetings(&conn, &workspace_id).map_err(db_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    meeting: MeetingRow,
    lines: Vec<LineRow>,
    speakers: Vec<SpeakerRow>,
    local_only: bool,
}

#[tauri::command]
pub fn meetings_detail(db: State<Db>, meeting_id: String) -> Result<Detail, String> {
    let conn = db.0.lock().map_err(db_err)?;
    let meeting = q::get_meeting(&conn, &meeting_id).map_err(db_err)?.ok_or("The meeting no longer exists")?;
    let local_only = q::note_is_local_only(&conn, &meeting.note_id).map_err(db_err)?;
    Ok(Detail { lines: q::lines(&conn, &meeting_id).map_err(db_err)?, speakers: q::speakers(&conn, &meeting_id).map_err(db_err)?, meeting, local_only })
}

/// The meeting's audio, for the player: the file's bytes and its type.
#[tauri::command]
pub fn meetings_audio(db: State<Db>, meeting_id: String) -> Result<tauri::ipc::Response, String> {
    let file = {
        let conn = db.0.lock().map_err(db_err)?;
        q::get_meeting(&conn, &meeting_id).map_err(db_err)?.map(|m| m.audio_file).unwrap_or_default()
    };
    if file.is_empty() {
        return Err("This meeting's audio is no longer kept".into());
    }
    let bytes = std::fs::read(meetings::meeting_dir(&meeting_id).join(&file)).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The waveform: per channel, a few hundred peaks 0–255.
#[tauri::command]
pub fn meetings_peaks(meeting_id: String) -> HashMap<String, Vec<u8>> {
    std::fs::read(meetings::meeting_dir(&meeting_id).join("peaks.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Copies the meeting's audio to `path` — the way to keep it past the retention, or elsewhere.
#[tauri::command]
pub fn meetings_export_audio(db: State<Db>, meeting_id: String, path: String) -> Result<(), String> {
    let file = {
        let conn = db.0.lock().map_err(db_err)?;
        q::get_meeting(&conn, &meeting_id).map_err(db_err)?.map(|m| m.audio_file).unwrap_or_default()
    };
    if file.is_empty() {
        return Err("This meeting's audio is no longer kept".into());
    }
    std::fs::copy(meetings::meeting_dir(&meeting_id).join(&file), &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn meetings_update_line(db: State<Db>, meeting_id: String, seq: i64, text: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::update_line_text(&conn, &meeting_id, seq, text.trim()).map_err(db_err)
}

#[tauri::command]
pub fn meetings_set_line_speaker(db: State<Db>, meeting_id: String, seq: i64, speaker: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::set_line_speaker(&conn, &meeting_id, seq, &speaker).map_err(db_err)
}

#[tauri::command]
pub fn meetings_rename_speaker(db: State<Db>, meeting_id: String, key: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::rename_speaker(&conn, &meeting_id, &key, &name).map_err(db_err)
}

#[tauri::command]
pub fn meetings_merge_speakers(db: State<Db>, meeting_id: String, from: String, into: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::merge_speakers(&conn, &meeting_id, &from, &into).map_err(db_err)
}

#[tauri::command]
pub fn meetings_add_speaker(db: State<Db>, meeting_id: String) -> Result<String, String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::add_speaker(&conn, &meeting_id).map_err(db_err)
}

#[tauri::command]
pub fn meetings_set_book_local_only(db: State<Db>, book_id: String, local_only: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::set_book_local_only(&conn, &book_id, local_only).map_err(db_err)
}

// ---------------------------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn meetings_voices(db: State<Db>) -> Result<Vec<VoiceRow>, String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::voices(&conn).map_err(db_err)
}

/// Saves a speaker's voice under `name` — or, when `voice_id` names a saved voice, adds this
/// meeting's sample to it (a running mean, so a voice gets surer with every meeting).
#[tauri::command]
pub fn meetings_save_voice(db: State<Db>, meeting_id: String, key: String, name: String, is_me: bool, voice_id: Option<String>) -> Result<VoiceRow, String> {
    let conn = db.0.lock().map_err(db_err)?;
    let blob = q::speaker_embedding(&conn, &meeting_id, &key).map_err(db_err)?.filter(|b| !b.is_empty()).ok_or("This speaker has no voice sample to save")?;
    let sample = speaker::from_blob(&blob);
    let voice = match voice_id.filter(|v| !v.is_empty()) {
        Some(existing) => {
            let (current, samples) = q::get_voice_embedding(&conn, &existing).map_err(db_err)?.ok_or("That voice no longer exists")?;
            let current = speaker::from_blob(&current);
            let n = samples.max(1) as f32;
            let mut mean: Vec<f32> = current.iter().zip(&sample).map(|(c, s)| (c * n + s) / (n + 1.0)).collect();
            speaker::normalise(&mut mean);
            q::update_voice_embedding(&conn, &existing, &speaker::to_blob(&mean), samples + 1).map_err(db_err)?;
            q::voices(&conn).map_err(db_err)?.into_iter().find(|v| v.id == existing).ok_or("That voice no longer exists")?
        }
        None => q::create_voice(&conn, &name, is_me, &blob, meetings::EMBEDDING_MODEL_ID).map_err(db_err)?,
    };
    q::set_speaker_voice(&conn, &meeting_id, &key, &voice.id, if voice.is_me { "" } else { &voice.name }).map_err(db_err)?;
    Ok(voice)
}

#[tauri::command]
pub fn meetings_rename_voice(db: State<Db>, voice_id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::rename_voice(&conn, &voice_id, &name).map_err(db_err)
}

#[tauri::command]
pub fn meetings_delete_voice(db: State<Db>, voice_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::delete_voice(&conn, &voice_id).map_err(db_err)
}

// ---------------------------------------------------------------------------------------------
// Recipes and the AI
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn meetings_recipes(db: State<Db>, workspace_id: String) -> Result<Vec<RecipeRow>, String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::recipes(&conn, &workspace_id).map_err(db_err)
}

#[tauri::command]
pub fn meetings_save_recipe(db: State<Db>, workspace_id: String, id: Option<String>, name: String, prompt: String) -> Result<RecipeRow, String> {
    if name.trim().is_empty() || prompt.trim().is_empty() {
        return Err("A recipe needs a name and an instruction".into());
    }
    let conn = db.0.lock().map_err(db_err)?;
    q::save_recipe(&conn, &workspace_id, id.as_deref(), &name, &prompt).map_err(db_err)
}

#[tauri::command]
pub fn meetings_delete_recipe(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(db_err)?;
    q::delete_recipe(&conn, &id).map_err(db_err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    meeting_id: String,
    /// A built-in recipe id, a saved recipe's id, or `None` with `instruction`.
    recipe: Option<String>,
    instruction: Option<String>,
    /// A question about the meeting rather than a recipe.
    question: bool,
    facts: meeting_ai::Facts,
    /// Display names by speaker key — what the window shows.
    names: HashMap<String, String>,
    run_id: Option<String>,
    workspace_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    markdown: String,
    /// Which engine wrote it: a provider id, or `local`.
    engine: String,
}

/// A recipe or a question over the meeting's transcript, on the «Reuniones» engine — or on the local
/// model when the meeting's book is local-only.
#[tauri::command]
pub async fn meetings_ai(app: AppHandle, request: AiRequest) -> Result<AiAnswer, String> {
    let (instruction, transcript_text, local_only) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        let meeting = q::get_meeting(&conn, &request.meeting_id).map_err(db_err)?.ok_or("The meeting no longer exists")?;
        let instruction = match (&request.recipe, &request.instruction) {
            (Some(id), _) => match meeting_ai::builtin(id) {
                Some(text) => text.to_string(),
                None => q::get_recipe(&conn, id).map_err(db_err)?.map(|r| r.prompt).ok_or("That recipe no longer exists")?,
            },
            (None, Some(text)) if !text.trim().is_empty() => text.clone(),
            _ => return Err("Say what to write".into()),
        };
        let lines = q::lines(&conn, &request.meeting_id).map_err(db_err)?;
        if lines.is_empty() {
            return Err("This meeting has no transcript yet".into());
        }
        let rows: Vec<(i64, String, String)> = lines
            .into_iter()
            .map(|l| (l.start_ms, request.names.get(&l.speaker).cloned().unwrap_or_else(|| l.speaker.clone()), l.text))
            .collect();
        (instruction, transcript::for_ai(&rows), q::note_is_local_only(&conn, &meeting.note_id).map_err(db_err)?)
    };
    let facts = request.facts.clone();
    let question = request.question;
    if local_only {
        let settings = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(db_err)?;
            crate::hybrid::config::read(&conn)?
        };
        let resolved = crate::hybrid::runtime::resolve(&settings, crate::hybrid::runtime::Freshness::Recent).await;
        if let Some(error) = resolved.error.clone() {
            return Err(format!("MEETINGS_LOCAL_UNAVAILABLE: {error}"));
        }
        let model = resolved.model.clone().ok_or("MEETINGS_LOCAL_UNAVAILABLE: no local model is set up")?;
        let live = crate::hybrid::runtime::connect(resolved.kind, &resolved.url, &model, resolved.ctx).await?;
        let runner = meeting_ai::Runner::Local { endpoint: live.endpoint.clone(), model: live.model.clone(), ctx: resolved.ctx, label: "Local model" };
        let markdown = crate::ai_runs::scoped(app.clone(), request.run_id, async {
            meeting_ai::answer(&runner, &facts, &transcript_text, &instruction, question).await
        })
        .await?;
        return Ok(AiAnswer { markdown, engine: "local".into() });
    }
    let config = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        load_ai_config_in(&conn, AiTask::Meetings, request.workspace_id.as_deref())?
    };
    let provider = config.provider.clone();
    let markdown = crate::ai_runs::scoped(app.clone(), request.run_id, async {
        let runner = meeting_ai::Runner::Cli { engine: &*config.engine, binary: &config.binary, model: &config.model };
        meeting_ai::answer(&runner, &facts, &transcript_text, &instruction, question).await
    })
    .await?;
    Ok(AiAnswer { markdown, engine: provider })
}

// ---------------------------------------------------------------------------------------------
// In the background
// ---------------------------------------------------------------------------------------------

/// Deletes the audio whose retention has run out; the transcript stays.
fn sweep_audio(app: &AppHandle) {
    let Ok(expired) = with_db(app, |conn| q::expired_audio(conn, &chrono::Utc::now().to_rfc3339())) else { return };
    for (id, file) in expired {
        let dir = meetings::meeting_dir(&id);
        let _ = std::fs::remove_file(dir.join(&file));
        let _ = std::fs::remove_file(dir.join("peaks.json"));
        let _ = with_db(app, |conn| q::set_audio(conn, &id, "", 0, ""));
    }
}

/// At launch: recordings cut short by a crash are offered for processing, jobs cut short by a quit
/// are queued again, audio past its retention is deleted, and folders no meeting owns are removed.
/// Then the background loops start: the retention sweep and the call detector.
pub fn start(app: &AppHandle) {
    if let Ok(cut) = with_db(app, |conn| q::meetings_with_status(conn, &["recording", "paused"])) {
        for meeting in cut {
            let dir = meetings::meeting_dir(&meeting.id);
            let duration = [Channel::Mic, Channel::System].iter().map(|c| meetings::audio::channel_ms(&dir, *c)).max().unwrap_or(0);
            let _ = with_db(app, |conn| {
                q::set_duration(conn, &meeting.id, duration)?;
                q::set_status(conn, &meeting.id, "interrupted", "", "")
            });
        }
    }
    if let Ok(pending) = with_db(app, |conn| q::meetings_with_status(conn, &["queued", "processing"])) {
        for meeting in pending {
            enqueue(app, JobRequest { meeting_id: meeting.id, retranscribe: false, import: None });
        }
    }
    if let (Ok(ids), Ok(entries)) = (with_db(app, q::all_meeting_ids), std::fs::read_dir(meetings::recordings_root())) {
        let known: HashSet<String> = ids.into_iter().collect();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !known.contains(&name) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut since_sweep = Duration::from_secs(u64::MAX / 4);
        loop {
            if since_sweep >= Duration::from_secs(6 * 3600) {
                sweep_audio(&handle);
                since_sweep = Duration::ZERO;
            }
            detect_tick(&handle).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
            since_sweep += Duration::from_secs(5);
        }
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Detected {
    caller: meetings::detect::Caller,
}

async fn detect_tick(app: &AppHandle) {
    let enabled = with_db(app, |conn| Ok(meetings::load_settings(conn).detect)).unwrap_or(false);
    let state = app.state::<MeetingsState>();
    let recording = state.active.lock().map(|a| a.is_some()).unwrap_or(true);
    if !enabled || recording || !meetings::status().supported {
        if let Ok(mut announced) = state.announced.lock() {
            announced.clear();
        }
        return;
    }
    let callers = tokio::task::spawn_blocking(meetings::detect::callers).await.unwrap_or_default();
    let Ok(mut announced) = state.announced.lock() else { return };
    let now: HashSet<String> = callers.iter().map(|c| c.name.clone()).collect();
    for caller in callers {
        if !announced.contains(&caller.name) {
            let _ = app.emit_to("main", DETECTED_EVENT, Detected { caller });
        }
    }
    // An app that let go of the microphone may be asked about again on its next call.
    *announced = now;
}

/// The quit: the recording's pieces closed and the job stopped, so the next launch finds both in a
/// state it can pick up.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<MeetingsState>() else { return };
    if let Some(active) = state.active.lock().ok().and_then(|mut slot| slot.take()) {
        // Stopped cleanly: queued, so the next launch finishes it like any other.
        let id = active.meeting_id.clone();
        let (_, complete) = stop_active(active);
        let dir = meetings::meeting_dir(&id);
        let duration = [Channel::Mic, Channel::System].iter().map(|c| meetings::audio::channel_ms(&dir, *c)).max().unwrap_or(0);
        let _ = with_db(app, |conn| {
            q::finish_recording(conn, &id, duration, complete)?;
            q::set_status(conn, &id, "queued", "", "")
        });
    }
    let running = state.current.lock().ok().and_then(|current| current.as_ref().map(|(_, control)| control.clone()));
    if let Some(control) = running {
        control.cancel.store(true, Ordering::SeqCst);
        control.abort.store(true, Ordering::SeqCst);
    }
}
