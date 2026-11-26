//! What the window asks of a call: starting one, what is said by typing, the microphone, the hand,
//! hanging up, and the countdown at the end.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;

use super::stage::AppStage;
use super::{cast, ear, Call, CallState, Event, Seat, Shared};
use crate::db::{queries, Db};
use crate::speech::{self, Voice};
use crate::team::{self, chat};

/// Whether the user said they wear headphones: what they say over an agent is then always theirs.
const HEADPHONES_KEY: &str = "team_call_headphones";
/// How fast a call's voices speak, 1 being each voice as it was recorded. Its own setting: the
/// reading speed is for long answers read aloud, and slowed down it made every agent drag.
const RATE_KEY: &str = "team_call_rate";

/// [`RATE_KEY`] as a number, within what a voice can be asked for.
fn pace(conn: &rusqlite::Connection) -> f32 {
    pace_of(queries::get_setting(conn, RATE_KEY).ok().flatten().as_deref())
}

pub(super) fn pace_of(stored: Option<&str>) -> f32 {
    stored.and_then(|value| value.trim().parse::<f32>().ok()).filter(|value| value.is_finite()).map_or(1.0, |value| value.clamp(0.85, 1.25))
}

/// Where the voices agents are given come from: `auto` · `local` · `system` · `cloud` (`cast::only`).
const VOICES_KEY: &str = "team_call_voices";

struct Handle {
    call: Shared,
    events: mpsc::UnboundedSender<Event>,
    /// Whether the microphone runs: the mute button.
    gate: Arc<AtomicBool>,
}

fn live() -> &'static Mutex<Option<Handle>> {
    static LIVE: std::sync::OnceLock<Mutex<Option<Handle>>> = std::sync::OnceLock::new();
    LIVE.get_or_init(Default::default)
}

fn held() -> std::sync::MutexGuard<'static, Option<Handle>> {
    live().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A call is going on: Codi keeps out of it, and nothing else is read aloud over it.
pub fn in_call() -> bool {
    held().as_ref().is_some_and(|handle| matches!(super::lock(&handle.call).phase, "live" | "closing" | "countdown" | "starting"))
}

fn send(event: Event) -> Result<(), String> {
    held().as_ref().ok_or("No hay ninguna llamada en curso.")?.events.send(event).map_err(|_| "La llamada ya terminó.".to_string())
}

fn view() -> Option<CallState> {
    held().as_ref().map(|handle| super::lock(&handle.call).view())
}

/// Every voice an agent can be given, for its editor and for the casting.
async fn voices() -> Vec<cast::PoolVoice> {
    let system = tauri::async_runtime::spawn_blocking(speech::system::voices).await.unwrap_or_default();
    let rows: Vec<speech::piper::VoiceRow> =
        speech::piper::rows().into_iter().chain(speech::kokoro::rows()).chain(speech::pocket::rows()).chain(crate::commands::speech_cmd::cloned_rows()).collect();
    cast::every(&system, &rows, crate::commands::speech_cmd::has_key(speech::cloud::OPENAI_KEY))
}

#[tauri::command]
pub async fn team_call_voices() -> Vec<cast::PoolVoice> {
    voices().await
}

/// The voices a call would hand out now — in the app's language, from where Settings says — so
/// they can be heard before a call does it, and counted against the size of a team.
#[tauri::command]
pub async fn team_call_pool(db: State<'_, Db>) -> Result<Vec<cast::PoolVoice>, String> {
    let all = voices().await;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let reading = speech::load_settings(&conn);
    let from = queries::get_setting(&conn, VOICES_KEY).ok().flatten().unwrap_or_default().trim().to_string();
    let lang = speech::app_language(&conn);
    let cloud = reading.engine == "cloud" && reading.cloud_service == "openai";
    Ok(cast::only(cast::pool(&all, &lang, cloud || from == "cloud"), &from))
}

/// Starts a call with `team_id`: a conversation of its own in the team's history, every member with
/// a voice, the lead's opening words — and the microphone, when this computer can listen.
#[tauri::command]
pub async fn team_call_start(app: AppHandle, db: State<'_, Db>, team_id: String, project_id: Option<String>) -> Result<CallState, String> {
    if in_call() {
        return Err("Ya hay una llamada en curso: cuélgala antes de empezar otra.".into());
    }
    if crate::commands::meetings_cmd::recording(&app) {
        return Err("Se está grabando una reunión: termínala antes de llamar al equipo.".into());
    }
    let all = voices().await;
    let (chat, agents, lang, cloud, headphones, engines, talk, voices_from, pace) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let team = team::get_team(&conn, &team_id).map_err(|e| e.to_string())?.ok_or("El equipo ya no existe.")?;
        let state = chat::open(&conn, team, project_id.as_deref().unwrap_or(""), true)?;
        let agents = queries::list_workspace_agents(&conn, &state.chat.workspace_id).map_err(|e| e.to_string())?;
        let reading = speech::load_settings(&conn);
        let headphones = queries::get_setting(&conn, HEADPHONES_KEY).ok().flatten().is_some_and(|value| value.trim() == "1");
        // What each member talks with and as whom, for its tile: the same resolution its turns use.
        let engines: Vec<(String, String)> = state.chat.members.iter().map(|member| talks_with(&conn, member, &state.chat.workspace_id)).collect();
        let engines: std::collections::HashMap<String, (String, String)> = state.chat.members.iter().map(|member| member.member.id.clone()).zip(engines).collect();
        let voices_from = queries::get_setting(&conn, VOICES_KEY).ok().flatten().unwrap_or_default().trim().to_string();
        (state.chat, agents, speech::app_language(&conn), reading.engine == "cloud" && reading.cloud_service == "openai", headphones, engines, super::stage::talk_mode(&conn), voices_from, pace(&conn))
    };
    // The lead first: it opens, and it is who a thing said to nobody goes to.
    let mut members = chat.members.clone();
    members.sort_by_key(|member| member.member.id != chat.lead_id);
    let chosen: Vec<(String, Option<Voice>)> =
        members.iter().map(|member| (member.member.agent_id.clone(), agents.iter().find(|agent| agent.id == member.member.agent_id).and_then(|agent| agent.voice.clone()))).collect();
    // A service's voices are in the pool for somebody who reads aloud with it — or who asked for
    // them for calls, which says as much.
    let given = cast::cast(&chosen, &cast::only(cast::pool(&all, lang, cloud || voices_from == "cloud"), &voices_from));
    // Every voice at the call's speed, whichever it is and whoever chose it.
    let given: Vec<Voice> = given.into_iter().map(|voice| Voice { rate: voice.rate() * pace, ..voice }).collect();
    // The call's engine loads its model and these voices now, behind the lead's first words being
    // written, rather than when the first agent has to speak.
    let natural: Vec<&'static str> = given.iter().filter_map(|voice| speech::pocket::voice(&voice.id).map(|known| known.name)).collect();
    if !natural.is_empty() && speech::pocket::installed() {
        let lang = lang.to_string();
        std::thread::spawn(move || {
            if let Err(error) = speech::pocket::warm(&lang, &natural) {
                crate::applog::warn(&format!("team call: the voice engine did not warm up: {error}"));
            }
        });
    }
    let label = |voice: &Voice| all.iter().find(|known| known.id == voice.id).map(|known| known.label.clone()).unwrap_or_default();
    let seats: Vec<Seat> = members
        .into_iter()
        .zip(given)
        .map(|(member, voice)| {
            let (talk_model, account) = engines.get(&member.member.id).cloned().unwrap_or_default();
            Seat { lead: member.member.id == chat.lead_id, voice_label: label(&voice), voice, talk_model, account, member, state: "listening", note: String::new() }
        })
        .collect();
    let names: Vec<String> = seats.iter().map(|seat| team::member_name(&seat.member)).collect();
    let opening = super::opening(names.first().map(String::as_str).unwrap_or_default(), &names[1.min(names.len())..], lang);
    let call: Shared = Arc::new(Mutex::new(Call {
        id: uuid::Uuid::new_v4().to_string(),
        chat,
        lang,
        started: Instant::now(),
        started_at_ms: super::epoch_ms(),
        seats,
        lines: Vec::new(),
        phase: "live",
        mic: false,
        hearing: false,
        listening: "ready",
        missing: Vec::new(),
        headphones,
        talk,
        last: None,
        hands: Default::default(),
        said: 0,
        thoughts: Default::default(),
        thought: 0,
        wrap: None,
        countdown_ends_ms: None,
        countdown: 0,
        wait: super::COUNTDOWN,
        run_id: None,
        error: String::new(),
    }));
    let (events, inbox) = mpsc::unbounded_channel();
    let gate = Arc::new(AtomicBool::new(true));
    // Whatever was being read aloud gives way: the call has the speaker now.
    speech::stop();
    *held() = Some(Handle { call: call.clone(), events: events.clone(), gate: gate.clone() });
    listen(&app, &call, &events, &gate, names);
    tauri::async_runtime::spawn(super::conduct(AppStage { app }, call.clone(), events, inbox, opening));
    let view = super::lock(&call).view();
    Ok(view)
}

/// The model `member` talks with in a call and the name of the account it runs as (empty for the
/// provider's own login) — what [`super::stage::AppStage`] resolves for each thing it says.
fn talks_with(conn: &rusqlite::Connection, member: &team::MemberSnap, workspace: &str) -> (String, String) {
    let Ok((config, model)) = super::stage::talk_config(conn, member, workspace) else {
        return (member.model.clone(), String::new());
    };
    let account = config.account.account_id.as_deref().and_then(|id| crate::ai_accounts::get(conn, id).ok().flatten()).map(|account| account.label).unwrap_or_default();
    (model, account)
}

/// Opens the microphone for `call`, or writes down why it cannot.
fn listen(app: &AppHandle, call: &Shared, events: &mpsc::UnboundedSender<Event>, gate: &Arc<AtomicBool>, names: Vec<String>) {
    let lang = super::lock(call).lang;
    gate.store(true, Ordering::SeqCst);
    let heard = ear::start(app, events.clone(), gate.clone(), lang, names);
    let mut held = super::lock(call);
    held.missing.clear();
    match heard {
        Ok(()) => {
            held.listening = "ready";
            held.mic = true;
        }
        Err(deaf) => {
            held.mic = false;
            held.listening = match deaf {
                ear::Deaf::Unsupported => "unsupported",
                ear::Deaf::Denied => "denied",
                ear::Deaf::Missing(missing) => {
                    held.missing = missing;
                    "missing"
                }
                ear::Deaf::Failed(error) => {
                    held.error = error;
                    "failed"
                }
            };
        }
    }
}

/// What Settings › Llamadas shows that is not a setting: the model a call would listen with now —
/// the one chosen for calls, or the one this computer is recommended.
#[tauri::command]
pub fn team_call_listening(db: State<'_, Db>) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(ear::listening_with(&conn).map(str::to_string))
}

/// The call as it is now, with everything said so far — for a window that opens while it goes on.
#[tauri::command]
pub fn team_call_state() -> Option<CallState> {
    view()
}

/// Something typed instead of spoken.
#[tauri::command]
pub fn team_call_say(text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    send(Event::Said { text, typed: true, over_voice: false })
}

/// The mute button. Unmuting a call that could not listen tries again — the model may be there now.
#[tauri::command]
pub fn team_call_mic(app: AppHandle, on: bool) -> Result<CallState, String> {
    let (call, events, gate) = {
        let held = held();
        let handle = held.as_ref().ok_or("No hay ninguna llamada en curso.")?;
        (handle.call.clone(), handle.events.clone(), handle.gate.clone())
    };
    if super::lock(&call).phase != "live" {
        let view = super::lock(&call).view();
        return Ok(view);
    }
    if on && !ear::open() {
        let names = super::lock(&call).seats.iter().map(|seat| team::member_name(&seat.member)).collect();
        listen(&app, &call, &events, &gate, names);
    } else {
        gate.store(on, Ordering::SeqCst);
        let mut held = super::lock(&call);
        held.mic = on && ear::open();
        if !on {
            held.hearing = false;
        }
    }
    let _ = events.send(Event::Changed);
    let view = super::lock(&call).view();
    Ok(view)
}

/// Another microphone was chosen (the app's one choice, `dictation_device`): the call goes on
/// listening with it. Muted stays muted — the choice is which microphone, not whether it is open.
#[tauri::command]
pub fn team_call_mic_changed(app: AppHandle) -> Result<CallState, String> {
    let (call, events, gate) = {
        let held = held();
        let handle = held.as_ref().ok_or("No hay ninguna llamada en curso.")?;
        (handle.call.clone(), handle.events.clone(), handle.gate.clone())
    };
    if super::lock(&call).phase == "live" {
        let was_open = gate.load(Ordering::SeqCst) && ear::open();
        let muted = ear::open() && !was_open;
        let names = super::lock(&call).seats.iter().map(|seat| team::member_name(&seat.member)).collect();
        listen(&app, &call, &events, &gate, names);
        if muted && ear::open() {
            gate.store(false, Ordering::SeqCst);
            super::lock(&call).mic = false;
        }
        let _ = events.send(Event::Changed);
    }
    let view = super::lock(&call).view();
    Ok(view)
}

/// «Uso audífonos»: what is heard over an agent's voice is the user, always.
#[tauri::command]
pub fn team_call_headphones(db: State<'_, Db>, on: bool) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, HEADPHONES_KEY, if on { "1" } else { "0" }).map_err(|e| e.to_string())?;
    }
    if let Some(handle) = held().as_ref() {
        super::lock(&handle.call).headphones = on;
        let _ = handle.events.send(Event::Changed);
    }
    Ok(())
}

/// Which model the agents talk with when none was chosen for one: `fast` — their provider's fast
/// model — or `own`. Kept for the next call too, and in one that is going on it applies to the next
/// thing said.
#[tauri::command]
pub fn team_call_talk(db: State<'_, Db>, mode: String) -> Result<Option<CallState>, String> {
    let mode = if mode.trim() == "own" { "own" } else { "fast" };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_setting(&conn, super::stage::TALK_KEY, mode).map_err(|e| e.to_string())?;
    let held = held();
    let Some(handle) = held.as_ref() else { return Ok(None) };
    let (members, workspace) = {
        let call = super::lock(&handle.call);
        (call.seats.iter().map(|seat| seat.member.clone()).collect::<Vec<_>>(), call.chat.workspace_id.clone())
    };
    // What each tile says it talks with follows the choice.
    let models: Vec<String> = members.iter().map(|member| talks_with(&conn, member, &workspace).0).collect();
    let view = {
        let mut call = super::lock(&handle.call);
        call.talk = mode;
        for (seat, model) in call.seats.iter_mut().zip(models) {
            seat.talk_model = model;
        }
        call.view()
    };
    let _ = handle.events.send(Event::Changed);
    Ok(Some(view))
}

/// The hand: whoever is speaking stops.
#[tauri::command]
pub fn team_call_interrupt() -> Result<(), String> {
    send(Event::Interrupt)
}

/// The user gives the word to `member_id`, who had its hand up: it says what it was waiting to say.
#[tauri::command]
pub fn team_call_grant(member_id: String) -> Result<(), String> {
    send(Event::Grant(member_id))
}

/// `member_id`'s hand is lowered: what it was waiting to say is not wanted.
#[tauri::command]
pub fn team_call_lower(member_id: String) -> Result<(), String> {
    send(Event::Lower(member_id))
}

#[tauri::command]
pub fn team_call_hang_up() -> Result<(), String> {
    send(Event::HangUp)
}

#[tauri::command]
pub fn team_call_start_now() -> Result<(), String> {
    send(Event::StartNow)
}

#[tauri::command]
pub fn team_call_cancel_start() -> Result<(), String> {
    send(Event::CancelStart)
}

/// The window is done with the call. One in which the user said nothing leaves no conversation
/// behind: an empty entry in the team's history is nothing anybody wants to find.
#[tauri::command]
pub fn team_call_close(app: AppHandle) -> Result<(), String> {
    let Some(handle) = held().take() else { return Ok(()) };
    let _ = handle.events.send(Event::Close);
    ear::stop();
    let (chat_id, spoke) = {
        let call = super::lock(&handle.call);
        (call.chat.id.clone(), call.lines.iter().any(|line| line.who == "user" && line.kind == "say"))
    };
    if !spoke {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = chat::delete(&conn, &chat_id);
    }
    Ok(())
}
