//! «Lectura en voz alta»: the thinking mark saying what the AI wrote and the notifications the user
//! picked, on the speaker they picked (Settings › Voz y sonido).
//!
//! Three engines and one player. The computer's own voice ([`system`]: `say`, SAPI, espeak-ng), a
//! downloaded natural voice ([`piper`], through the sherpa-onnx library meetings already use), or a
//! service ([`cloud`]: OpenAI, ElevenLabs). Each turns text into samples; [`player`] plays them on
//! the chosen output at the chosen volume and stops when told. Before it plays, the window is sent
//! the loudness envelope ([`SpeechState`]) — the mark moves by it while the voice runs, without an
//! event per frame.
//!
//! **Each text in its own language.** The app speaks Spanish and English, and each has its voice
//! for every engine (`speech_system_voice_es`, `…_en`…). What is said is read in the language it is
//! written in ([`language_of`]) — an English answer in a Spanish app gets the English voice — and
//! a text too short to tell, in the app's language.
//!
//! **One voice at a time, in order.** What is asked to be said waits in a short queue
//! ([`MAX_WAITING`]); «Callar» empties it and cuts what is playing. What to say, and when to keep
//! quiet (a meeting being recorded, a dictation), is the window's call — this module only speaks.

pub mod cloud;
pub mod piper;
pub mod player;
pub mod system;
pub mod wav;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{queries, Db};

/// Emitted with a [`SpeechState`] at every step of every utterance.
pub const STATE_EVENT: &str = "speech:state";

/// The settings the backend reads; the window writes them through `set_setting`.
pub mod keys {
    /// `system` · `local` · `cloud`.
    pub const ENGINE: &str = "speech_engine";
    /// Followed by `_es` / `_en` ([`voice`]): the voice each language is read with; empty is
    /// «Automática».
    pub const SYSTEM_VOICE: &str = "speech_system_voice";
    pub const LOCAL_VOICE: &str = "speech_local_voice";
    /// `openai` · `elevenlabs`.
    pub const CLOUD_SERVICE: &str = "speech_cloud_service";
    pub const CLOUD_VOICE: &str = "speech_cloud_voice";
    /// 0.6–1.8, 1 = normal.
    pub const RATE: &str = "speech_rate";
    /// 0–100.
    pub const VOLUME: &str = "speech_volume";

    /// `speech_system_voice_es`, `speech_local_voice_en`…
    pub fn voice(base: &str, lang: &str) -> String {
        format!("{base}_{lang}")
    }
}

/// `es` for any Spanish code (`es`, `es-MX`, `es_AR`), `en` for everything else — the app's rule.
pub fn language(code: &str) -> &'static str {
    if code.trim().to_ascii_lowercase().starts_with("es") {
        "es"
    } else {
        "en"
    }
}

/// The app's language as the backend reads it: the one chosen in Settings, else the system's —
/// the window's own rule (`languageFromLocale`), for a caller that does not say.
pub fn app_language(conn: &Connection) -> &'static str {
    match queries::get_setting(conn, "app_language").ok().flatten().as_deref().map(str::trim) {
        Some("es") => "es",
        Some("en") => "en",
        _ => language(&tauri_plugin_os::locale().unwrap_or_default()),
    }
}

/// The language `text` is written in, when it says so clearly. Counts words each language uses all
/// the time and the other never does, plus Spanish's own letters; one side must reach two and
/// double the other. A short title, a name or a mixed line says nothing (`None`): the caller's
/// fallback, the app's language, reads it.
pub fn language_of(text: &str) -> Option<&'static str> {
    const ES: &[&str] = &[
        "el", "la", "los", "las", "de", "del", "que", "y", "en", "un", "una", "es", "por", "para", "con", "se", "lo", "como", "pero",
        "más", "este", "esta", "hay", "fue", "sin", "sobre", "también", "porque", "cuando", "muy", "ya", "está", "están", "tiene",
        "puede", "ahora", "aquí", "todo", "son", "al",
    ];
    const EN: &[&str] = &[
        "the", "of", "and", "to", "is", "in", "that", "it", "for", "with", "as", "was", "are", "this", "be", "by", "on", "not", "you",
        "have", "but", "from", "or", "an", "they", "which", "can", "will", "has", "there", "been", "would", "what", "were", "when",
        "we", "your", "should", "these", "just",
    ];
    let (mut es, mut en) = (0usize, 0usize);
    for word in text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        let word = word.to_lowercase();
        es += usize::from(ES.contains(&word.as_str())) + word.chars().filter(|c| "ñáéíóú".contains(*c)).count();
        en += usize::from(EN.contains(&word.as_str()));
    }
    es += text.chars().filter(|c| matches!(c, '¿' | '¡')).count();
    match (es, en) {
        (es, en) if es >= 2 && es >= en * 2 + 1 => Some("es"),
        (es, en) if en >= 2 && en >= es * 2 + 1 => Some("en"),
        _ => None,
    }
}

/// How much one utterance may say. A long answer is the summary's job; past this, the voice stops
/// at a sentence end rather than reading for minutes.
pub const MAX_CHARS: usize = 1_500;
/// What may wait behind the voice that is speaking. A burst of notifications beyond it drops the
/// oldest — they are news, and old news read late is worse than none.
const MAX_WAITING: usize = 4;
/// The envelope's step: 25 frames a second is what the mark animates at anyway.
const STEP_MS: u32 = 40;

/// One choice per language of the app.
#[derive(Debug, Clone, Default)]
pub struct ByLanguage {
    pub es: String,
    pub en: String,
}

impl ByLanguage {
    pub fn get(&self, lang: &str) -> &str {
        if lang == "es" {
            &self.es
        } else {
            &self.en
        }
    }
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub engine: String,
    pub system_voices: ByLanguage,
    pub local_voices: ByLanguage,
    pub cloud_service: String,
    pub cloud_voice: String,
    pub rate: f32,
    pub volume: f32,
    pub device: String,
}

pub fn load_settings(conn: &Connection) -> Settings {
    let get = |key: &str| queries::get_setting(conn, key).ok().flatten().unwrap_or_default().trim().to_string();
    let number = |key: &str, default: f32| get(key).parse::<f32>().ok().filter(|v| v.is_finite()).unwrap_or(default);
    let by_language = |base: &str| ByLanguage { es: get(&keys::voice(base, "es")), en: get(&keys::voice(base, "en")) };
    Settings {
        engine: Some(get(keys::ENGINE)).filter(|e| matches!(e.as_str(), "system" | "local" | "cloud")).unwrap_or_else(|| "system".into()),
        system_voices: by_language(keys::SYSTEM_VOICE),
        local_voices: by_language(keys::LOCAL_VOICE),
        cloud_service: Some(get(keys::CLOUD_SERVICE)).filter(|s| s == "elevenlabs").unwrap_or_else(|| "openai".into()),
        cloud_voice: get(keys::CLOUD_VOICE),
        rate: number(keys::RATE, 1.0).clamp(0.6, 1.8),
        volume: (number(keys::VOLUME, 80.0) / 100.0).clamp(0.0, 1.0),
        device: get(player::DEVICE_KEY),
    }
}

/// Turns `text`, written in `lang` (`es` · `en`), into mono samples with the chosen engine. Blocking.
/// The services' voices are multilingual and read any language with the one voice.
pub fn synthesize(settings: &Settings, text: &str, lang: &str) -> Result<(Vec<f32>, u32), String> {
    let system = || system::synthesize(text, &system_voice(settings, lang), settings.rate);
    match settings.engine.as_str() {
        // No downloaded voice in this language: the computer's own reads it, rather than a voice
        // of the other language saying it with the wrong sounds.
        "local" => match local_voice(settings, lang) {
            Some(id) => piper::synthesize(&id, text, settings.rate),
            None => system(),
        },
        "cloud" => tauri::async_runtime::block_on(cloud::synthesize(&settings.cloud_service, &settings.cloud_voice, text, settings.rate)),
        _ => system(),
    }
}

/// The downloaded voice that reads `lang`: the one chosen for it while it is installed, else the
/// first installed voice of that language («Automática»), else none.
pub fn local_voice(settings: &Settings, lang: &str) -> Option<String> {
    let reads = |voice: &&piper::VoiceSpec| language(voice.lang) == lang && piper::installed(voice.id);
    let chosen = settings.local_voices.get(lang);
    piper::VOICES
        .iter()
        .filter(reads)
        .find(|voice| voice.id == chosen)
        .or_else(|| piper::VOICES.iter().find(reads))
        .map(|voice| voice.id.to_string())
}

/// The system voice that reads `lang`: the one chosen for it, else [`system::default_for`]; empty
/// leaves it to the system's own default.
pub fn system_voice(settings: &Settings, lang: &str) -> String {
    match settings.system_voices.get(lang) {
        "" => system::default_for(lang).unwrap_or_default(),
        chosen => chosen.to_string(),
    }
}

/// `text` as it is said: whitespace collapsed, held to [`MAX_CHARS`] at a sentence end.
pub fn speakable(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(MAX_CHARS).collect();
    match cut.rfind(['.', '!', '?', '…']) {
        Some(end) if end > MAX_CHARS / 3 => cut[..=end].to_string(),
        _ => match cut.rfind(' ') {
            Some(space) => format!("{}…", &cut[..space]),
            None => cut,
        },
    }
}

/// One step of one utterance, for the window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechState {
    pub id: u64,
    /// `preparing` · `speaking` · `done` · `stopped` · `failed`.
    pub phase: &'static str,
    pub text: String,
    /// Who asked: `notification`, `answer`, `selection`, `test`…
    pub origin: String,
    /// Loudness every [`STEP_MS`], 0–1, from the moment `speaking` is sent. Only on `speaking`.
    pub envelope: Vec<f32>,
    pub step_ms: u32,
    pub duration_ms: u64,
    pub error: Option<String>,
}

struct Job {
    id: u64,
    text: String,
    origin: String,
    /// `es` · `en`: what [`language_of`] read in the text, else the caller's.
    lang: &'static str,
    generation: u64,
    /// Told how it ended, for a caller that waits ([`say_and_wait`]). Dropped unsent when the job
    /// is — «Callar», or a burst pushing it out of the queue — which the receiver reads as stopped.
    done: Option<tokio::sync::oneshot::Sender<Said>>,
}

/// How an utterance ended.
#[derive(Debug, Clone)]
pub struct Said {
    /// `done` · `stopped` · `failed`.
    pub phase: &'static str,
    /// The language it was read in.
    pub lang: &'static str,
    pub duration_ms: u64,
    pub error: Option<String>,
}

struct Queue {
    jobs: Mutex<VecDeque<Job>>,
    ready: Condvar,
    /// Bumped by every «Callar»: a job of an older generation is not said, one playing stops.
    generation: AtomicU64,
    next_id: AtomicU64,
}

static QUEUE: OnceLock<Arc<Queue>> = OnceLock::new();

fn queue(app: &AppHandle) -> Arc<Queue> {
    QUEUE
        .get_or_init(|| {
            let queue = Arc::new(Queue { jobs: Mutex::new(VecDeque::new()), ready: Condvar::new(), generation: AtomicU64::new(0), next_id: AtomicU64::new(1) });
            let (worker, app) = (queue.clone(), app.clone());
            std::thread::Builder::new()
                .name("speech".into())
                .spawn(move || run(&app, &worker))
                .expect("a thread for the voice");
            queue
        })
        .clone()
}

/// Queues `text` to be said, in the language it is written in — `fallback` (the app's) when it is
/// too short to tell. `interrupt` cuts what is playing and what waits first (a test, a «Leer en voz
/// alta» the user just asked for). Returns the utterance's id.
pub fn say(app: &AppHandle, text: &str, origin: &str, interrupt: bool, fallback: &str) -> u64 {
    enqueue(app, text, origin, interrupt, None, fallback, None)
}

/// [`say`] in `language` when it is given (`es` · `en`), and a receiver told how it ended — a flow's
/// «Decir en voz alta» waits on it. An error on the receiver means the job was dropped before it
/// played: stopped.
pub fn say_and_wait(
    app: &AppHandle,
    text: &str,
    origin: &str,
    language: Option<&'static str>,
    fallback: &str,
) -> tokio::sync::oneshot::Receiver<Said> {
    let (done, receiver) = tokio::sync::oneshot::channel();
    enqueue(app, text, origin, false, language, fallback, Some(done));
    receiver
}

fn enqueue(
    app: &AppHandle,
    text: &str,
    origin: &str,
    interrupt: bool,
    fixed: Option<&'static str>,
    fallback: &str,
    done: Option<tokio::sync::oneshot::Sender<Said>>,
) -> u64 {
    let queue = queue(app);
    if interrupt {
        stop_all(&queue);
    }
    let id = queue.next_id.fetch_add(1, Ordering::SeqCst);
    let text = speakable(text);
    let lang = fixed.or_else(|| language_of(&text)).unwrap_or_else(|| language(fallback));
    let job = Job { id, text, origin: origin.to_string(), lang, generation: queue.generation.load(Ordering::SeqCst), done };
    let mut jobs = queue.jobs.lock().unwrap_or_else(|p| p.into_inner());
    jobs.push_back(job);
    while jobs.len() > MAX_WAITING {
        jobs.pop_front();
    }
    queue.ready.notify_one();
    id
}

/// «Callar»: nothing waiting is said, and what is playing stops.
pub fn stop() {
    if let Some(queue) = QUEUE.get() {
        stop_all(queue);
    }
}

fn stop_all(queue: &Queue) {
    queue.generation.fetch_add(1, Ordering::SeqCst);
    queue.jobs.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

fn run(app: &AppHandle, queue: &Queue) {
    loop {
        let mut job = {
            let mut jobs = queue.jobs.lock().unwrap_or_else(|p| p.into_inner());
            loop {
                if let Some(job) = jobs.pop_front() {
                    break job;
                }
                jobs = queue.ready.wait(jobs).unwrap_or_else(|p| p.into_inner());
            }
        };
        let said = speak(app, queue, &job);
        if let Some(done) = job.done.take() {
            let _ = done.send(said);
        }
    }
}

/// Says one job, telling the window every step; how it ended.
fn speak(app: &AppHandle, queue: &Queue, job: &Job) -> Said {
    let current = || queue.generation.load(Ordering::SeqCst) == job.generation;
    let ended = |phase: &'static str, duration_ms: u64, error: Option<String>| Said { phase, lang: job.lang, duration_ms, error };
    if !current() || job.text.trim().is_empty() {
        return ended("stopped", 0, None);
    }
    let state = |phase: &'static str| SpeechState {
        id: job.id,
        phase,
        text: job.text.clone(),
        origin: job.origin.clone(),
        envelope: Vec::new(),
        step_ms: STEP_MS,
        duration_ms: 0,
        error: None,
    };
    let fail = |error: String| {
        crate::applog::warn(&format!("speech: {error}"));
        let _ = app.emit(STATE_EVENT, SpeechState { error: Some(error.clone()), ..state("failed") });
        ended("failed", 0, Some(error))
    };
    let _ = app.emit(STATE_EVENT, state("preparing"));
    let settings = {
        let db = app.state::<Db>();
        let conn = db.0.lock();
        match conn {
            Ok(conn) => load_settings(&conn),
            Err(_) => return fail("The settings could not be read".into()),
        }
    };
    let (samples, rate) = match synthesize(&settings, &job.text, job.lang) {
        Ok(audio) => audio,
        Err(error) => return fail(error),
    };
    if !current() {
        let _ = app.emit(STATE_EVENT, state("stopped"));
        return ended("stopped", 0, None);
    }
    let duration_ms = (samples.len() as u64 * 1000) / u64::from(rate.max(1));
    let _ = app.emit(STATE_EVENT, SpeechState { envelope: player::envelope(&samples, rate, STEP_MS), duration_ms, ..state("speaking") });
    if let Err(error) = player::play(&settings.device, &samples, rate, settings.volume, &current) {
        return fail(format!("playing: {error}"));
    }
    let phase = if current() { "done" } else { "stopped" };
    let _ = app.emit(STATE_EVENT, state(phase));
    ended(phase, duration_ms, None)
}

/// Plays a short sound (a notification's tone, «Probar» on the speaker) on the chosen output, on a
/// thread of its own — it may overlap the voice, as it would through the webview.
pub fn play_sound(app: &AppHandle, samples: Vec<f32>, rate: u32, volume: f32) {
    let device = {
        let db = app.state::<Db>();
        let Ok(conn) = db.0.lock() else { return };
        queries::get_setting(&conn, player::DEVICE_KEY).ok().flatten().unwrap_or_default()
    };
    let _ = std::thread::Builder::new().name("sound".into()).spawn(move || {
        if let Err(error) = player::play(&device, &samples, rate, volume, &|| true) {
            crate::applog::warn(&format!("speech: sound: {error}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_text_stops_at_a_sentence_end() {
        let sentence = "Esta es una frase de prueba que se repite. ";
        let long = sentence.repeat(60);
        let said = speakable(&long);
        assert!(said.chars().count() <= MAX_CHARS);
        assert!(said.ends_with('.'), "{said}");
        assert_eq!(speakable("  hola\n\n  mundo  "), "hola mundo");
        let one_word = "a".repeat(MAX_CHARS + 10);
        assert_eq!(speakable(&one_word).chars().count(), MAX_CHARS);
    }

    #[test]
    fn a_text_is_read_in_the_language_it_is_written_in() {
        assert_eq!(language_of("Terminé de revisar el pull request: encontré dos problemas y una sugerencia."), Some("es"));
        assert_eq!(language_of("I finished reviewing the pull request and found two problems in the parser."), Some("en"));
        assert_eq!(language_of("¿Seguimos?"), None, "one mark is not enough");
        assert_eq!(language_of("La rama está al día"), Some("es"));
        // An English identifier or two inside a Spanish answer does not turn it.
        assert_eq!(language_of("Cambié la función para que use the_config y el test pasa con la base de datos."), Some("es"));
        // Too short, or only names: the app's language decides.
        assert_eq!(language_of("Git: push completed"), None);
        assert_eq!(language_of("Pipelines: main"), None);
        assert_eq!(language_of(""), None);
    }

    #[test]
    fn codes_fold_into_the_two_languages() {
        assert_eq!(language("es-MX"), "es");
        assert_eq!(language("es_AR"), "es");
        assert_eq!(language("en-GB"), "en");
        assert_eq!(language("fr"), "en");
        assert_eq!(language(""), "en");
    }
}
