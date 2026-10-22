//! «Codi»: CodeFlow's voice assistant — it listens for its name, runs what it is asked anywhere in
//! the interface (`ui`), and says what it did. Asked for by the user on 2026-10-21; the plan, the
//! measurements behind every choice here and the user's decisions are in `.claude/plans/codi.md`.
//!
//! **The runtime lives here, not in a window.** The microphone ([`listen`]), the detector that cuts
//! utterances ([`vad`]), the transcription (`crate::asr`, or whisper), the three tiers that decide
//! what to do ([`router`] → the local model → the provider, in [`brain`]) and the voice
//! (`crate::speech`) all run in Rust; Codi's window only draws the [`CodiState`] it is sent and
//! sends the two switches back. Closing that window turns Codi off — nothing listens unseen — and
//! while the microphone is open the main window's status bar says so as well.
//!
//! **Only the microphone gives orders.** What a meeting records, what a page or a tool returns, is
//! data: nothing heard from the system's audio reaches here, and what an engine reads back from the
//! interface is marked as data in its prompt. What destroys waits for a yes ([`confirm`]).
//!
//! **Listening by name** (the user's default, 2026-10-21). Every utterance is transcribed here, on
//! this machine, and acted on only when it starts with «Codi» ([`wake`]) — no second model, and the
//! audio never leaves. «Conversación» drops the name; «Pulsar para hablar» listens only while the
//! shortcut is held.

pub mod brain;
pub mod hotkey;
pub mod listen;
pub mod router;
pub mod ui;
pub mod vad;
pub mod wake;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{queries, Db};

pub const STATE_EVENT: &str = "codi:state";
pub const LEVEL_EVENT: &str = "codi:level";
pub const HEARD_EVENT: &str = "codi:heard";
pub const TURN_EVENT: &str = "codi:turn";
pub const CONFIRM_EVENT: &str = "codi:confirm";
pub const ANNOUNCE_EVENT: &str = "codi:announce";

/// The settings Codi reads; the window writes them through `set_setting`.
pub mod keys {
    /// A listener's id (`parakeet`, `small`…); `""` = what this machine is recommended.
    pub const LISTEN_MODEL: &str = "codi_listen_model";
    /// `wake` (by name, the default) · `conversation` · `ptt`.
    pub const MODE: &str = "codi_listen_mode";
    /// More names it answers to, comma-separated, beside «Codi».
    pub const WAKE_WORDS: &str = "codi_wake_words";
    /// `tiers` (the default: own router → local model → provider) · `provider` · `local`.
    pub const BRAIN: &str = "codi_brain";
    /// `on` · `off`: whether it speaks. Kept, so the window opens as it was left.
    pub const SOUND: &str = "codi_sound";
    /// A downloaded voice for Codi alone (`kokoro-ef_dora`…), followed by `_es` / `_en`; empty is
    /// the reading aloud's.
    pub const VOICE: &str = "codi_voice";
    /// The microphone, shared with dictation and meetings.
    pub const DEVICE: &str = "dictation_device";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// The microphone is closed.
    Off,
    /// Listening for its name.
    Idle,
    /// Somebody is speaking.
    Hearing,
    /// An order is being worked out.
    Thinking,
    /// Running actions in the interface.
    Acting,
    Speaking,
    /// Waiting for a yes or a no.
    Waiting,
}

/// What Codi's window draws.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodiState {
    pub phase: Phase,
    pub mic: bool,
    pub sound: bool,
    /// `wake` · `conversation` · `ptt`.
    pub mode: String,
    pub listen_model: String,
    /// What is missing before the microphone can open: `library`, `listener`, `detector`.
    pub missing: Vec<&'static str>,
    pub error: Option<String>,
    /// The push-to-talk key is held.
    pub talking: bool,
    /// The system-wide push-to-talk chord, when in push-to-talk and one is chosen.
    pub ptt_key: Option<String>,
}

struct Shared {
    phase: Phase,
    mic: bool,
    sound: bool,
    talking: bool,
    error: Option<String>,
}

fn shared() -> &'static Mutex<Shared> {
    static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
    SHARED.get_or_init(|| Mutex::new(Shared { phase: Phase::Off, mic: false, sound: true, talking: false, error: None }))
}

/// The settings, resolved.
#[derive(Debug, Clone)]
pub struct Settings {
    pub listen_model: String,
    pub mode: String,
    pub wake_words: Vec<String>,
    pub brain: String,
    pub sound: bool,
    pub device: String,
    pub voice_es: String,
    pub voice_en: String,
}

pub fn load_settings(conn: &Connection) -> Settings {
    let get = |key: &str| queries::get_setting(conn, key).ok().flatten().unwrap_or_default().trim().to_string();
    let mode = Some(get(keys::MODE)).filter(|m| matches!(m.as_str(), "wake" | "conversation" | "ptt")).unwrap_or_else(|| "wake".into());
    let brain = Some(get(keys::BRAIN)).filter(|b| matches!(b.as_str(), "tiers" | "provider" | "local")).unwrap_or_else(|| "tiers".into());
    let mut wake_words = vec!["codi".to_string()];
    wake_words.extend(get(keys::WAKE_WORDS).split(',').map(|w| router::normalize(w)).filter(|w| !w.is_empty()));
    Settings {
        listen_model: get(keys::LISTEN_MODEL),
        mode,
        wake_words,
        brain,
        sound: get(keys::SOUND) != "off",
        device: get(keys::DEVICE),
        voice_es: get(&format!("{}_es", keys::VOICE)),
        voice_en: get(&format!("{}_en", keys::VOICE)),
    }
}

fn settings(app: &AppHandle) -> Settings {
    let db = app.state::<Db>();
    let conn = db.0.lock();
    match conn {
        Ok(conn) => load_settings(&conn),
        // A poisoned lock: the defaults, rather than a Codi that cannot even say why.
        Err(_) => Settings {
            listen_model: String::new(),
            mode: "wake".into(),
            wake_words: vec!["codi".into()],
            brain: "tiers".into(),
            sound: true,
            device: String::new(),
            voice_es: String::new(),
            voice_en: String::new(),
        },
    }
}

/// The language Codi speaks and reads in: the app's.
pub fn lang(app: &AppHandle) -> &'static str {
    app.state::<Db>().0.lock().map(|conn| crate::speech::app_language(&conn)).unwrap_or("en")
}

/// The model Codi listens with: the chosen one while it is usable, else what this machine is
/// recommended (`voice_fit`), else any usable one — Parakeet first.
pub fn listener(settings: &Settings) -> Option<crate::dictation::Listener> {
    use crate::dictation::listener as find;
    let usable = |id: &str| find(id).filter(|l| l.usable());
    if let Some(chosen) = usable(&settings.listen_model) {
        return Some(chosen);
    }
    let pick = crate::voice_fit::picks(crate::voice_fit::class(), 16.0, crate::asr::supported()).codi;
    usable(&pick).or_else(|| ["parakeet", "small", "base", "canary", "turbo", "tiny", "large"].iter().find_map(|id| usable(id)))
}

/// What is missing before the microphone can open.
pub fn missing(settings: &Settings) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if crate::meetings::sherpa_library().is_none() {
        missing.push("library");
    }
    if !vad::model_path().is_file() {
        missing.push("detector");
    }
    if listener(settings).is_none() {
        missing.push("listener");
    }
    missing
}

pub fn state(app: &AppHandle) -> CodiState {
    let settings = settings(app);
    let held = shared().lock().unwrap_or_else(|p| p.into_inner());
    CodiState {
        phase: held.phase,
        mic: held.mic,
        sound: held.sound && settings.sound,
        mode: settings.mode.clone(),
        listen_model: listener(&settings).map(|l| l.id().to_string()).unwrap_or_default(),
        missing: missing(&settings),
        error: held.error.clone(),
        talking: held.talking,
        ptt_key: if settings.mode == "ptt" { hotkey::chosen(app) } else { None },
    }
}

fn announce_state(app: &AppHandle) {
    let _ = app.emit(STATE_EVENT, state(app));
}

pub fn set_phase(app: &AppHandle, phase: Phase) {
    {
        let mut held = shared().lock().unwrap_or_else(|p| p.into_inner());
        // With the microphone closed it is off, whatever finished last.
        let phase = if !held.mic && matches!(phase, Phase::Idle | Phase::Hearing) { Phase::Off } else { phase };
        if held.phase == phase {
            return;
        }
        held.phase = phase;
    }
    announce_state(app);
}

/// The phase to rest in once a turn is over.
fn rest(app: &AppHandle) {
    let mic = shared().lock().map(|held| held.mic).unwrap_or(false);
    set_phase(app, if mic { Phase::Idle } else { Phase::Off });
}

pub fn mic_on() -> bool {
    shared().lock().is_ok_and(|held| held.mic)
}

pub fn sound_on(app: &AppHandle) -> bool {
    shared().lock().is_ok_and(|held| held.sound) && settings(app).sound
}

pub fn talking() -> bool {
    shared().lock().is_ok_and(|held| held.talking)
}

fn fail(app: &AppHandle, error: impl Into<String>) {
    let error = error.into();
    crate::applog::warn(&format!("codi: {error}"));
    shared().lock().unwrap_or_else(|p| p.into_inner()).error = Some(error);
    announce_state(app);
}

/// Opens the microphone and starts listening.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let settings = settings(app);
    let missing = missing(&settings);
    if !missing.is_empty() {
        return Err(format!("CODI_MISSING:{}", missing.join(",")));
    }
    let listener = listener(&settings).ok_or("CODI_MISSING:listener")?;
    listen::start(app, &settings, listener)?;
    {
        let mut held = shared().lock().unwrap_or_else(|p| p.into_inner());
        held.mic = true;
        held.error = None;
    }
    set_phase(app, Phase::Idle);
    brain::warm(app);
    // Refused (another application owns the chord) is said in the window; the button and Space
    // still work.
    if let Err(error) = hotkey::sync(app) {
        fail(app, error);
    }
    Ok(())
}

/// Closes the microphone. Codi stays able to speak (an announcement), not to hear.
pub fn stop(app: &AppHandle) {
    hotkey::unbind(app);
    listen::stop();
    {
        let mut held = shared().lock().unwrap_or_else(|p| p.into_inner());
        held.mic = false;
        held.talking = false;
    }
    set_phase(app, Phase::Off);
}

/// The sound switch: off, nothing is said — answers stay as text in the window.
pub fn set_sound(app: &AppHandle, on: bool) {
    shared().lock().unwrap_or_else(|p| p.into_inner()).sound = on;
    if let Ok(conn) = app.state::<Db>().0.lock() {
        let _ = queries::set_setting(&conn, keys::SOUND, if on { "on" } else { "off" });
    }
    if !on {
        crate::speech::stop();
    }
    announce_state(app);
}

/// The push-to-talk key, held or let go.
pub fn set_talking(app: &AppHandle, held: bool) {
    shared().lock().unwrap_or_else(|p| p.into_inner()).talking = held;
    if held {
        listen::pressed(app);
    }
    announce_state(app);
}

/// The listening mode as the setting has it now.
pub fn mode(app: &AppHandle) -> String {
    settings(app).mode
}

/// «Callar»: stops what Codi is saying.
pub fn hush() {
    crate::speech::stop();
}

// ------------------------------------------------------------------------------- turns

/// One order and what came of it, for the window's log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: u64,
    pub order: String,
    pub reply: String,
    /// `own` (Codi's own words) · `router` · `local` · `provider`.
    pub tier: &'static str,
    pub actions: Vec<Acted>,
    pub ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acted {
    pub action: String,
    pub params: Value,
    pub ok: bool,
    pub say: Option<String>,
    pub error: Option<String>,
}

static TURNS: AtomicU64 = AtomicU64::new(1);
/// A turn is under way: an order heard meanwhile waits for it (one waits; more are the user
/// talking over themselves, and the newest wins).
static BUSY: AtomicBool = AtomicBool::new(false);

fn queued() -> &'static Mutex<Option<String>> {
    static QUEUED: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    QUEUED.get_or_init(Default::default)
}

/// Works out `order` and answers it — from the microphone or typed into Codi's window.
pub fn order(app: &AppHandle, order: String) {
    if order.trim().is_empty() {
        return;
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        *queued().lock().unwrap_or_else(|p| p.into_inner()) = Some(order);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut next = Some(order);
        while let Some(order) = next.take() {
            run_turn(&app, &order).await;
            next = queued().lock().unwrap_or_else(|p| p.into_inner()).take();
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

async fn run_turn(app: &AppHandle, order: &str) {
    let started = std::time::Instant::now();
    let id = TURNS.fetch_add(1, Ordering::SeqCst);
    let lang = lang(app);
    set_phase(app, Phase::Thinking);
    let outcome = brain::think(app, order, lang).await;
    let (reply, tier, actions, error) = match outcome {
        Ok(thought) => (thought.reply, thought.tier, thought.actions, None),
        Err(error) => (if lang == "es" { format!("No pude hacerlo: {error}") } else { format!("I couldn't do it: {error}") }, "own", Vec::new(), Some(error)),
    };
    let turn = Turn { id, order: order.to_string(), reply: reply.clone(), tier, actions, ms: started.elapsed().as_millis() as u64, error };
    let _ = app.emit(TURN_EVENT, &turn);
    say(app, &reply).await;
    rest(app);
}

/// Says `text` in Codi's voice, when the sound is on, and waits until it has been said (or stopped).
pub async fn say(app: &AppHandle, text: &str) {
    if text.trim().is_empty() || !sound_on(app) {
        return;
    }
    set_phase(app, Phase::Speaking);
    let lang = lang(app);
    let settings = settings(app);
    let voice = if lang == "es" { settings.voice_es } else { settings.voice_en };
    let receiver = crate::speech::say_as(app, text, "codi", Some(lang), lang, (!voice.is_empty()).then_some(voice));
    let _ = receiver.await;
}

// ------------------------------------------------------------------------------- confirmations

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub id: String,
    pub action: String,
    pub params: Value,
    /// What it will do, as shown and said.
    pub what: String,
    /// `None` while asked; the answer once given (or `false` when it timed out).
    pub answer: Option<bool>,
}

fn waiting() -> &'static Mutex<Option<(String, tokio::sync::oneshot::Sender<bool>)>> {
    static WAITING: OnceLock<Mutex<Option<(String, tokio::sync::oneshot::Sender<bool>)>>> = OnceLock::new();
    WAITING.get_or_init(Default::default)
}

/// How long a question waits for its answer.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

/// Asks the user to confirm `what` — in Codi's window and aloud — and waits for a yes (the button,
/// or «sí» said). `false` on a no, on silence, or when another question replaced this one.
pub async fn confirm(app: &AppHandle, action: &str, params: &Value, what: &str) -> bool {
    let id = format!("confirm-{}", TURNS.fetch_add(1, Ordering::SeqCst));
    let (sender, receiver) = tokio::sync::oneshot::channel();
    *waiting().lock().unwrap_or_else(|p| p.into_inner()) = Some((id.clone(), sender));
    let mut question = Confirmation { id: id.clone(), action: action.to_string(), params: params.clone(), what: what.to_string(), answer: None };
    let _ = app.emit(CONFIRM_EVENT, &question);
    set_phase(app, Phase::Waiting);
    let lang = lang(app);
    let asked = if lang == "es" { format!("¿Confirmo «{what}»? Di sí o no.") } else { format!("Shall I {what}? Say yes or no.") };
    // Said without waiting for it: the answer may come while it is still being said.
    if sound_on(app) {
        let settings = settings(app);
        let voice = if lang == "es" { settings.voice_es } else { settings.voice_en };
        let _ = crate::speech::say_as(app, &asked, "codi", Some(lang), lang, (!voice.is_empty()).then_some(voice));
    }
    let yes = matches!(tokio::time::timeout(CONFIRM_TIMEOUT, receiver).await, Ok(Ok(true)));
    if let Ok(mut held) = waiting().lock() {
        if held.as_ref().is_some_and(|(waiting_id, _)| *waiting_id == id) {
            *held = None;
        }
    }
    question.answer = Some(yes);
    let _ = app.emit(CONFIRM_EVENT, &question);
    set_phase(app, Phase::Acting);
    yes
}

/// The answer to the question being asked, from the window's button or a «sí» heard.
pub fn answer(id: Option<&str>, yes: bool) -> bool {
    let mut held = waiting().lock().unwrap_or_else(|p| p.into_inner());
    if held.as_ref().is_some_and(|(waiting_id, _)| id.is_none_or(|id| id == waiting_id)) {
        if let Some((_, sender)) = held.take() {
            let _ = sender.send(yes);
            return true;
        }
    }
    false
}

/// A question is waiting for its answer.
pub fn asking() -> bool {
    waiting().lock().is_ok_and(|held| held.is_some())
}

// ------------------------------------------------------------------------------- announcements

/// Something finished elsewhere in the app (a review, a run, a flow) while Codi is on: said in a
/// sentence, and logged in its window.
pub async fn announce(app: &AppHandle, text: &str, source: &str) {
    if !mic_on() {
        return;
    }
    let _ = app.emit(ANNOUNCE_EVENT, serde_json::json!({ "text": text, "source": source }));
    if BUSY.load(Ordering::SeqCst) || asking() {
        return;
    }
    say(app, text).await;
    rest(app);
}

/// The level the microphone hears, for the face.
pub fn level(app: &AppHandle, level: f32) {
    let _ = app.emit(LEVEL_EVENT, level);
}

/// A listener's failure, shown in the window without closing the microphone.
pub fn listening_failed(app: &AppHandle, error: String) {
    fail(app, error);
}

/// Codi's window closed: nothing listens unseen.
pub fn window_closed(app: &AppHandle) {
    stop(app);
    hush();
}
