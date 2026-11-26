//! «Lectura en voz alta»: the thinking mark saying what the AI wrote and the notifications the user
//! picked, on the speaker they picked (Settings › Voz y sonido).
//!
//! Three engines and one player. The computer's own voice ([`system`]: `say`, SAPI, espeak-ng), a
//! downloaded natural voice ([`piper`] or [`kokoro`], through the sherpa-onnx library meetings
//! already use — [`sherpa`]), or a service ([`cloud`]: OpenAI, ElevenLabs). Each turns text into
//! samples; [`player`] plays them on the chosen output at the chosen volume and stops when told. As
//! each piece plays, the window is sent its loudness envelope ([`SpeechState`]) — the mark moves by
//! it while the voice runs, without an event per frame.
//!
//! **A downloaded voice speaks a sentence at a time.** It hands each sentence over as soon as it is
//! written, and the player starts on the first while the next is being written
//! ([`player::play_stream`]); the window gets each piece's envelope appended to the last
//! (`SpeechState::append`). Kokoro writes about a sentence in half a second on four cores — waiting
//! for a whole answer before the first word is what that avoids.
//!
//! **Each text in its own language.** The app speaks Spanish and English, and each has its voice
//! for every engine (`speech_system_voice_es`, `…_en`…). What is said is read in the language it is
//! written in ([`language_of`]) — an English answer in a Spanish app gets the English voice — and
//! a text too short to tell, in the app's language.
//!
//! **Said, not read.** Before the voice gets a text it is respelled for it ([`pronounce`]: the
//! English terms in a Spanish sentence, the user's own dictionary, paths, versions, acronyms), cut
//! into sentences ([`segments`]) and every piece evened out to one loudness, its silence trimmed
//! and the pause after it the app's own ([`level`]) — so the computer's voice, a downloaded one or
//! a service's sound the same from the first sentence to the last. What is shown stays as written.
//!
//! **One voice at a time, in order.** What is asked to be said waits in a short queue
//! ([`MAX_WAITING`]); «Callar» empties it and cuts what is playing. What to say, and when to keep
//! quiet (a meeting being recorded, a dictation), is the window's call — this module only speaks.

pub mod clone;
pub mod cloud;
pub mod kokoro;
pub mod level;
pub mod piper;
pub mod player;
pub mod pocket;
pub mod pronounce;
pub mod segments;
pub mod sherpa;
pub mod system;
pub mod wav;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
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

/// A voice of the caller's own for one utterance: whose it is, how high and how fast. A call with
/// a team gives every agent one, so they are told apart by ear.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Voice {
    /// `system:<name>`, `cloud:<service>:<voice>`, or the id of a downloaded or cloned voice. Empty —
    /// or one that is not there any more — is the reading aloud's own.
    pub id: String,
    /// 1 is the voice as it is; above it is higher. Held to [`Voice::PITCH`].
    pub pitch: f32,
    /// Times the user's own rate. Held to [`Voice::RATE`].
    pub rate: f32,
}

impl Default for Voice {
    fn default() -> Self {
        Self { id: String::new(), pitch: 1.0, rate: 1.0 }
    }
}

impl Voice {
    /// A little either way and no more: the pitch moves by playing faster or slower, which moves
    /// everything else about the voice with it, and past a few percent it stops being understood
    /// (the user, 2026-11-25, on hearing the first casting: «muchas no se entienden si se van a los
    /// extremos»).
    pub const PITCH: (f32, f32) = (0.94, 1.06);
    /// How fast it speaks, 1 being the voice as it was recorded.
    pub const RATE: (f32, f32) = (0.8, 1.3);

    /// A downloaded or cloned voice as it is.
    pub fn downloaded(id: String) -> Self {
        Self { id, ..Self::default() }
    }

    pub fn pitch(&self) -> f32 {
        if self.pitch.is_finite() { self.pitch.clamp(Self::PITCH.0, Self::PITCH.1) } else { 1.0 }
    }

    pub fn rate(&self) -> f32 {
        if self.rate.is_finite() { self.rate.clamp(Self::RATE.0, Self::RATE.1) } else { 1.0 }
    }

    /// The settings this utterance is said with: the user's, with this voice in place of theirs
    /// for `lang`. A voice that cannot be used leaves theirs.
    fn apply(&self, settings: &mut Settings, lang: &str) {
        let place = |voices: &mut ByLanguage, id: &str| {
            if lang == "es" {
                voices.es = id.to_string();
            } else {
                voices.en = id.to_string();
            }
        };
        if let Some(name) = self.id.strip_prefix("system:") {
            settings.engine = "system".into();
            place(&mut settings.system_voices, name);
        } else if let Some((service, voice)) = self.id.strip_prefix("cloud:").and_then(|rest| rest.split_once(':')) {
            if cloud::key_name(service).is_some() {
                settings.engine = "cloud".into();
                settings.cloud_service = service.to_string();
                settings.cloud_voice = voice.to_string();
            }
        } else if voice_installed(&self.id) {
            settings.engine = "local".into();
            place(&mut settings.local_voices, &self.id);
        }
        // Its own speed, not the reading speed's: that one is set for listening to long answers
        // read aloud — slowed to 0.75 it made every agent of a call drag its words (the user,
        // 2026-11-25). A call sets how fast its voices speak itself (`team_call_rate`).
        settings.rate = self.rate();
    }
}

/// `samples` at `rate`, `pitch` times higher and as much shorter — played at the same rate. Said
/// that much slower first ([`speak`]), the length comes out as written and only the pitch moved.
pub fn shift_pitch(samples: &[f32], rate: u32, pitch: f32) -> Vec<f32> {
    if (pitch - 1.0).abs() < 0.005 {
        return samples.to_vec();
    }
    player::resample(samples, rate, ((rate as f32) / pitch).round().max(1.0) as u32)
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
    /// The user accepted XTTS v2's licence (`clone::XTTS_TERMS_KEY`).
    pub xtts_accepted: bool,
    /// The user's own pronunciations (`pronounce::LEXICON_KEY`).
    pub lexicon: Vec<pronounce::Entry>,
}

pub fn load_settings(conn: &Connection) -> Settings {
    let get = |key: &str| queries::get_setting(conn, key).ok().flatten().unwrap_or_default().trim().to_string();
    let number = |key: &str, default: f32| get(key).parse::<f32>().ok().filter(|v| v.is_finite()).unwrap_or(default);
    let by_language = |base: &str| ByLanguage { es: get(&keys::voice(base, "es")), en: get(&keys::voice(base, "en")) };
    let lexicon = pronounce::parse_user(&get(pronounce::LEXICON_KEY));
    pronounce::remember(&lexicon);
    Settings {
        engine: Some(get(keys::ENGINE)).filter(|e| matches!(e.as_str(), "system" | "local" | "cloud")).unwrap_or_else(|| "system".into()),
        system_voices: by_language(keys::SYSTEM_VOICE),
        local_voices: by_language(keys::LOCAL_VOICE),
        cloud_service: Some(get(keys::CLOUD_SERVICE)).filter(|s| s == "elevenlabs").unwrap_or_else(|| "openai".into()),
        cloud_voice: get(keys::CLOUD_VOICE),
        rate: number(keys::RATE, 1.0).clamp(0.6, 1.8),
        volume: (number(keys::VOLUME, 80.0) / 100.0).clamp(0.0, 1.0),
        device: get(player::DEVICE_KEY),
        xtts_accepted: !get(clone::XTTS_TERMS_KEY).is_empty(),
        lexicon,
    }
}

/// Turns `text`, written in `lang` (`es` · `en`), into mono samples with the chosen engine, handing
/// them to `on_chunk` with their rate as they are written — a sentence at a time for a downloaded
/// voice, all at once for the others; `false` from it stops the rest. Blocking. The services'
/// voices are multilingual and read any language with the one voice.
pub fn synthesize_into(settings: &Settings, text: &str, lang: &str, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String> {
    let mut whole = |result: Result<(Vec<f32>, u32), String>| -> Result<(), String> {
        let (samples, rate) = result?;
        on_chunk(&samples, rate);
        Ok(())
    };
    match settings.engine.as_str() {
        // No downloaded voice in this language: the computer's own reads it, rather than a voice
        // of the other language saying it with the wrong sounds.
        "local" => match local_voice(settings, lang) {
            Some(id) if clone::is_cloned(&id) => clone::synthesize(&id, text, lang, settings.xtts_accepted, on_chunk),
            Some(id) if pocket::voice(&id).is_some() => pocket::synthesize(&id, text, lang, on_chunk),
            Some(id) if kokoro::voice(&id).is_some() => kokoro::synthesize(&id, text, settings.rate, on_chunk),
            Some(id) => piper::synthesize(&id, text, settings.rate, on_chunk),
            None => whole(system::synthesize(text, &system_voice(settings, lang), settings.rate)),
        },
        "cloud" => whole(tauri::async_runtime::block_on(cloud::synthesize(&settings.cloud_service, &settings.cloud_voice, text, lang, settings.rate))),
        _ => whole(system::synthesize(text, &system_voice(settings, lang), settings.rate)),
    }
}

/// All of `text` said by downloaded voice `id` — Piper's, Kokoro's, a cloned one or a natural one —
/// as one buffer and its rate, for a caller that saves it rather than plays it (a flow's «Voz
/// descargada»). Blocking; a natural voice asked for a language it has not read here yet brings
/// its model down first.
pub fn say_with_voice(id: &str, text: &str, speed: f32) -> Result<(Vec<f32>, u32), String> {
    let lang = language_of(text).unwrap_or("es");
    let spoken = pronounce::prepare(&flatten_lines(text), lang, true, &pronounce::remembered());
    let mut samples = Vec::new();
    let mut rate = 0;
    let mut keep = |chunk: &[f32], at: u32| {
        if rate == 0 {
            rate = at;
        }
        if at == rate {
            samples.extend_from_slice(chunk);
        } else {
            samples.extend(player::resample(chunk, at, rate));
        }
        true
    };
    let mut synth = |piece: &str, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool| {
        if clone::is_cloned(id) {
            clone::synthesize(id, piece, lang, true, on_chunk)
        } else if pocket::voice(id).is_some() {
            pocket::prepare_language(lang, id)?;
            pocket::synthesize(id, piece, lang, on_chunk)
        } else if kokoro::voice(id).is_some() {
            kokoro::synthesize(id, piece, speed, on_chunk)
        } else {
            piper::synthesize(id, piece, speed, on_chunk)
        }
    };
    render(&spoken, false, speed, &|| true, &mut synth, &mut keep)?;
    Ok((samples, rate.max(1)))
}

/// `text` as the voice is handed it with `settings`: respelled for voice `lang` — with the
/// built-in words unless a service's multilingual voice reads it — and the user's own.
pub fn spoken_form(settings: &Settings, text: &str, lang: &str) -> String {
    pronounce::prepare(text, lang, settings.engine != "cloud", &settings.lexicon)
}

/// Says `text` a piece at a time ([`segments`]; `whole` keeps it in one, for a service that reads a
/// whole text best): each piece written by `synth`, evened out ([`level::Leveler`]), followed by
/// its pause at `rate`, and handed to `on_piece` with its sample rate. Stops when `keep_going` or
/// `on_piece` says so.
fn render(
    text: &str,
    whole: bool,
    rate: f32,
    keep_going: &dyn Fn() -> bool,
    synth: &mut dyn FnMut(&str, &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String>,
    on_piece: &mut dyn FnMut(&[f32], u32) -> bool,
) -> Result<(), String> {
    render_pieces(&mut pieces_of(text, whole).into_iter(), rate, keep_going, synth, on_piece)
}

/// `text` in the pieces it is said in: its sentences, or itself for a service that reads a whole
/// text best.
fn pieces_of(text: &str, whole: bool) -> Vec<segments::Segment> {
    if whole {
        vec![segments::Segment { text: text.to_string(), pause_ms: 0 }]
    } else {
        segments::split(text)
    }
}

/// [`render`] over pieces that may still be on their way: an utterance said while it is being
/// written hands them over as its sentences arrive.
fn render_pieces(
    pieces: &mut dyn Iterator<Item = segments::Segment>,
    rate: f32,
    keep_going: &dyn Fn() -> bool,
    synth: &mut dyn FnMut(&str, &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String>,
    on_piece: &mut dyn FnMut(&[f32], u32) -> bool,
) -> Result<(), String> {
    let mut leveler = level::Leveler::default();
    for piece in pieces {
        if !keep_going() {
            return Ok(());
        }
        let mut samples = Vec::new();
        let mut at = 0u32;
        synth(&piece.text, &mut |chunk, chunk_rate| {
            if at == 0 {
                at = chunk_rate;
            }
            if chunk_rate == at {
                samples.extend_from_slice(chunk);
            } else {
                samples.extend(player::resample(chunk, chunk_rate, at));
            }
            keep_going()
        })?;
        if !keep_going() {
            return Ok(());
        }
        if samples.is_empty() || at == 0 {
            continue;
        }
        level::fit_pauses(&mut samples, at, &segments::marks(&piece.text), rate);
        leveler.process(&mut samples, at);
        let pause_ms = (piece.pause_ms as f32 / rate.clamp(0.6, 1.8)) as u64;
        samples.resize(samples.len() + (u64::from(at) * pause_ms / 1000) as usize, 0.0);
        if !on_piece(&samples, at) {
            return Ok(());
        }
    }
    Ok(())
}

/// The first downloaded voice — Piper's or Kokoro's — that reads `lang`.
pub fn first_voice_for(lang: &str) -> Option<&'static str> {
    downloadable_voices().find(|(id, voice_lang)| language(voice_lang) == lang && voice_installed(id)).map(|(id, _)| id)
}

/// A downloaded voice is ready: Piper's own files, Kokoro's one model for all of its voices, or a
/// cloned voice with its engine installed.
pub fn voice_installed(id: &str) -> bool {
    piper::installed(id)
        || (kokoro::voice(id).is_some() && kokoro::installed())
        || (clone::is_cloned(id) && clone::ready(id))
        || (pocket::voice(id).is_some() && pocket::installed())
}

/// The downloaded voices of both engines, as `(id, lang)`, in the catalogue's order — Piper's, then
/// Kokoro's.
fn downloadable_voices() -> impl Iterator<Item = (&'static str, &'static str)> {
    piper::VOICES.iter().map(|voice| (voice.id, voice.lang)).chain(kokoro::VOICES.iter().map(|voice| (voice.id, voice.lang)))
}

/// The downloaded voice that reads `lang`: the one chosen for it while it is installed — a cloned
/// one reads any language, its models are multilingual — else the first installed voice of that
/// language («Automática»), else none. «Automática» never picks a cloned voice: a person's voice is
/// chosen, not fallen into.
pub fn local_voice(settings: &Settings, lang: &str) -> Option<String> {
    let chosen = settings.local_voices.get(lang);
    if clone::is_cloned(chosen) && clone::ready(chosen) {
        return Some(chosen.to_string());
    }
    // A natural voice (`pocket`) says either language, and it is only ever chosen — for the reading
    // aloud, for Codi, for an agent, or handed out by a call — never fallen into. A language whose
    // model has not come down yet is read by the voice below while it does.
    if pocket::voice(chosen).is_some() && pocket::installed() {
        let lang = language(lang);
        if pocket::speaks(lang) {
            return Some(chosen.to_string());
        }
        pocket::prepare_in_background(lang, chosen);
    }
    let reads = |(id, voice_lang): &(&'static str, &'static str)| language(voice_lang) == lang && voice_installed(id);
    downloadable_voices()
        .filter(reads)
        .find(|(id, _)| *id == chosen)
        .or_else(|| downloadable_voices().find(reads))
        .map(|(id, _)| id.to_string())
}

/// The system voice that reads `lang`: the one chosen for it, else [`system::default_for`]; empty
/// leaves it to the system's own default.
pub fn system_voice(settings: &Settings, lang: &str) -> String {
    match settings.system_voices.get(lang) {
        "" => system::default_for(lang).unwrap_or_default(),
        chosen => chosen.to_string(),
    }
}

/// `text` on one line: a line that ends without punctuation gets a full stop, so a list or a title
/// above its paragraph is read as sentences rather than one breathless run.
pub fn flatten_lines(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        // A list's marker is not said.
        .map(|line| line.trim_start().trim_start_matches(['-', '*', '•', '·']).split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect();
    let last = lines.len().saturating_sub(1);
    lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| if i < last && !line.ends_with(['.', '!', '?', '…', ':', ';', ',']) { format!("{line}.") } else { line })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `text` as it is said: on one line ([`flatten_lines`]), held to [`MAX_CHARS`] at a sentence end.
pub fn speakable(text: &str) -> String {
    let flat = flatten_lines(text);
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
    /// This `speaking` continues the one before it: its envelope goes on the end of that one's (a
    /// voice that speaks a sentence at a time sends one per sentence).
    pub append: bool,
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
    /// A voice of its own this utterance is said with instead of the reading aloud's (Codi's, an
    /// agent's in a call).
    voice: Option<Voice>,
    /// The sentences of an utterance that is still being written, as they are ([`say_stream`]):
    /// `text` is empty then, and the utterance ends when the sender is dropped.
    incoming: Option<std::sync::mpsc::Receiver<String>>,
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
    enqueue(app, text, origin, interrupt, None, fallback, None, None, None)
}

/// «Probar» on a voice chosen for an agent: `text` with `voice`, now.
pub fn try_voice(app: &AppHandle, text: &str, fallback: &str, voice: Voice) -> u64 {
    enqueue(app, text, "test", true, None, fallback, None, Some(voice), None)
}

/// Says, in `lang` with `voice` and after whatever is being said, words that are still being
/// written — one participant's in a call: send each sentence as it is finished and drop the sender
/// at the end. The voice starts on the first while the rest are on their way, and the receiver is
/// told how it ended.
pub fn say_stream(
    app: &AppHandle,
    origin: &str,
    lang: &'static str,
    voice: Voice,
) -> (std::sync::mpsc::Sender<String>, tokio::sync::oneshot::Receiver<Said>) {
    let (sentences, incoming) = std::sync::mpsc::channel();
    let (done, receiver) = tokio::sync::oneshot::channel();
    enqueue(app, "", origin, false, Some(lang), lang, Some(done), Some(voice), Some(incoming));
    (sentences, receiver)
}

/// [`say`] with voice `voice` (a downloaded or cloned one's id) when it is ready, else the reading
/// aloud's — «Probar» on a voice chosen for Codi.
pub fn say_voice(app: &AppHandle, text: &str, origin: &str, interrupt: bool, fallback: &str, voice: String) -> u64 {
    enqueue(app, text, origin, interrupt, None, fallback, None, Some(voice).filter(|id| voice_installed(id)).map(Voice::downloaded), None)
}

/// [`say_and_wait`] with a voice of its own — Codi's, when its settings name one that is downloaded
/// (`voice`), else the reading aloud's. It cuts whatever was being said: Codi answers now.
pub fn say_as(
    app: &AppHandle,
    text: &str,
    origin: &str,
    language: Option<&'static str>,
    fallback: &str,
    voice: Option<String>,
) -> tokio::sync::oneshot::Receiver<Said> {
    let (done, receiver) = tokio::sync::oneshot::channel();
    enqueue(app, text, origin, true, language, fallback, Some(done), voice.filter(|id| voice_installed(id)).map(Voice::downloaded), None);
    receiver
}

/// Whether a voice is speaking right now — Codi's listener holds its own words apart by it.
pub fn speaking() -> bool {
    SPEAKING.load(Ordering::SeqCst)
}

/// What is being said, while it is — so Codi can tell its own words leaking back from the speakers.
pub fn saying() -> Option<String> {
    SAYING.lock().ok().and_then(|held| held.clone())
}

static SPEAKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SAYING: Mutex<Option<String>> = Mutex::new(None);

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
    enqueue(app, text, origin, false, language, fallback, Some(done), None, None);
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
    voice: Option<Voice>,
    incoming: Option<std::sync::mpsc::Receiver<String>>,
) -> u64 {
    let queue = queue(app);
    if interrupt {
        stop_all(&queue);
    }
    let id = queue.next_id.fetch_add(1, Ordering::SeqCst);
    let text = speakable(text);
    let lang = fixed.or_else(|| language_of(&text)).unwrap_or_else(|| language(fallback));
    let job = Job { id, text, origin: origin.to_string(), lang, voice, incoming, generation: queue.generation.load(Ordering::SeqCst), done };
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
    // A copy, so the player's thread can ask it without borrowing the job.
    let generation = job.generation;
    let current = || queue.generation.load(Ordering::SeqCst) == generation;
    let ended = |phase: &'static str, duration_ms: u64, error: Option<String>| Said { phase, lang: job.lang, duration_ms, error };
    if !current() || (job.incoming.is_none() && job.text.trim().is_empty()) {
        return ended("stopped", 0, None);
    }
    let state = |phase: &'static str| SpeechState {
        id: job.id,
        phase,
        text: job.text.clone(),
        origin: job.origin.clone(),
        envelope: Vec::new(),
        append: false,
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
    let mut settings = {
        let db = app.state::<Db>();
        let conn = db.0.lock();
        match conn {
            Ok(conn) => load_settings(&conn),
            Err(_) => return fail("The settings could not be read".into()),
        }
    };
    // A voice of its own (Codi's, an agent's): in place of the reading aloud's for this language.
    if let Some(voice) = &job.voice {
        voice.apply(&mut settings, job.lang);
    }
    // Higher by playing faster what was said that much slower: the length stays, the pitch moves.
    let pitch = job.voice.as_ref().map_or(1.0, Voice::pitch);
    settings.rate = (settings.rate / pitch).clamp(0.5, 2.0);
    SPEAKING.store(true, Ordering::SeqCst);
    *SAYING.lock().unwrap_or_else(|p| p.into_inner()) = Some(job.text.clone());
    struct Quiet;
    impl Drop for Quiet {
        fn drop(&mut self) {
            SPEAKING.store(false, Ordering::SeqCst);
            if let Ok(mut held) = SAYING.lock() {
                *held = None;
            }
        }
    }
    let _quiet = Quiet;
    // The voice writes on this thread; the player plays on its own as the pieces arrive.
    let (tx, rx) = std::sync::mpsc::channel::<(Vec<f32>, u32)>();
    let mut played_ms = 0u64;
    let mut loudest = 0f32;
    let mut pieces = 0usize;
    let mut written = Ok(());
    let playing = std::thread::scope(|scope| {
        let player = scope.spawn(|| player::play_stream(&settings.device, settings.volume, rx, &current));
        let whole = settings.engine == "cloud";
        let mut synth = |piece: &str, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool| synthesize_into(&settings, piece, job.lang, on_chunk);
        // The pieces of a text that is all here, or of one still being written as they arrive.
        let mut said: Box<dyn Iterator<Item = segments::Segment> + '_> = match &job.incoming {
            None => Box::new(pieces_of(&spoken_form(&settings, &job.text, job.lang), whole).into_iter()),
            Some(incoming) => Box::new(Incoming { sentences: incoming, current: &current, settings: &settings, lang: job.lang, whole, waiting: VecDeque::new(), chars: 0 }),
        };
        written = render_pieces(&mut said, settings.rate, &current, &mut synth, &mut |samples, rate| {
            if !current() || samples.is_empty() {
                return current();
            }
            let shifted = shift_pitch(samples, rate, pitch);
            let samples = shifted.as_slice();
            // Against the loudest piece so far, so a quiet sentence after a loud one stays quiet.
            let raw = player::levels(samples, rate, STEP_MS);
            loudest = raw.iter().copied().fold(loudest, f32::max);
            let envelope = raw.iter().map(|level| if loudest > f32::EPSILON { (level / loudest).clamp(0.0, 1.0) } else { 0.0 }).collect();
            let duration_ms = (samples.len() as u64 * 1000) / u64::from(rate.max(1));
            let _ = app.emit(STATE_EVENT, SpeechState { envelope, duration_ms, append: pieces > 0, ..state("speaking") });
            pieces += 1;
            played_ms += duration_ms;
            tx.send((shifted, rate)).is_ok()
        });
        drop(said);
        drop(tx);
        player.join().unwrap_or_else(|_| Err("The speaker thread stopped unexpectedly".into()))
    });
    if let Err(error) = written {
        return fail(error);
    }
    if let Err(error) = playing {
        return fail(format!("playing: {error}"));
    }
    let phase = if current() { "done" } else { "stopped" };
    let _ = app.emit(STATE_EVENT, state(phase));
    ended(phase, played_ms, None)
}

/// The pieces of an utterance still being written: each sentence as it comes, respelled and cut
/// like any other, until the writer is done or the voice is told to stop.
struct Incoming<'a> {
    sentences: &'a std::sync::mpsc::Receiver<String>,
    current: &'a dyn Fn() -> bool,
    settings: &'a Settings,
    lang: &'static str,
    whole: bool,
    waiting: VecDeque<segments::Segment>,
    chars: usize,
}

impl Iterator for Incoming<'_> {
    type Item = segments::Segment;

    fn next(&mut self) -> Option<segments::Segment> {
        loop {
            if let Some(piece) = self.waiting.pop_front() {
                return Some(piece);
            }
            // The same ceiling as a text handed over whole: past it the voice stops.
            if !(self.current)() || self.chars >= MAX_CHARS {
                return None;
            }
            match self.sentences.recv_timeout(std::time::Duration::from_millis(80)) {
                Ok(sentence) => {
                    let sentence = flatten_lines(&sentence);
                    if sentence.is_empty() {
                        continue;
                    }
                    self.chars += sentence.chars().count();
                    // What is being said grows with it: a listener tells its own echo by this.
                    if let Ok(mut held) = SAYING.lock() {
                        let so_far = held.get_or_insert_with(String::new);
                        if !so_far.is_empty() {
                            so_far.push(' ');
                        }
                        so_far.push_str(&sentence);
                    }
                    self.waiting.extend(pieces_of(&spoken_form(self.settings, &sentence, self.lang), self.whole));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
            }
        }
    }
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
        assert_eq!(speakable("  hola\n\n  mundo  "), "hola. mundo");
        assert_eq!(speakable("Pipelines\n- Abre uno\n• Ejecútalo"), "Pipelines. Abre uno. Ejecútalo");
        assert_eq!(speakable("Una línea, sin punto final"), "Una línea, sin punto final");
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
    fn a_voice_of_its_own_takes_the_place_of_the_user_s_and_keeps_within_bounds() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let mut settings = load_settings(&conn);
        settings.rate = 1.2;
        Voice { id: "system:Paulina".into(), pitch: 9.0, rate: 0.1 }.apply(&mut settings, "es");
        assert_eq!(settings.engine, "system");
        assert_eq!(settings.system_voices.es, "Paulina");
        assert_eq!(settings.system_voices.en, "", "the other language keeps its own");
        assert!((settings.rate - Voice::RATE.0).abs() < 1e-5, "the reading speed does not reach a voice of its own");
        // A voice is moved a little and no more: past a few percent it is not understood.
        assert!(Voice::PITCH.0 >= 0.94 && Voice::PITCH.1 <= 1.06);
        assert_eq!(Voice { pitch: 9.0, ..Voice::default() }.pitch(), Voice::PITCH.1);
        assert_eq!(Voice { pitch: f32::NAN, ..Voice::default() }.pitch(), 1.0);

        let mut settings = load_settings(&conn);
        Voice { id: "cloud:elevenlabs:abc".into(), ..Voice::default() }.apply(&mut settings, "en");
        assert_eq!((settings.engine.as_str(), settings.cloud_service.as_str(), settings.cloud_voice.as_str()), ("cloud", "elevenlabs", "abc"));

        // One that is not here — a downloaded voice removed, a service nobody knows — leaves the user's.
        let mut settings = load_settings(&conn);
        let before = settings.engine.clone();
        Voice { id: "es_XX-nobody-high".into(), ..Voice::default() }.apply(&mut settings, "es");
        Voice { id: "cloud:nobody:x".into(), ..Voice::default() }.apply(&mut settings, "es");
        assert_eq!(settings.engine, before);
    }

    #[test]
    fn a_higher_pitch_is_as_much_shorter_so_saying_it_slower_keeps_its_length() {
        let second: Vec<f32> = (0..22_050).map(|i| (i as f32 * 0.05).sin()).collect();
        assert_eq!(shift_pitch(&second, 22_050, 1.0).len(), second.len());
        let higher = shift_pitch(&second, 22_050, 1.04);
        assert!((higher.len() as f32 - second.len() as f32 / 1.04).abs() < 4.0, "{}", higher.len());
        let lower = shift_pitch(&second, 22_050, 0.96);
        assert!((lower.len() as f32 - second.len() as f32 / 0.96).abs() < 4.0, "{}", lower.len());
    }

    #[test]
    fn an_utterance_still_being_written_is_said_a_sentence_at_a_time() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let settings = load_settings(&conn);
        let (sentences, incoming) = std::sync::mpsc::channel();
        let going = std::sync::atomic::AtomicBool::new(true);
        let current = || going.load(Ordering::SeqCst);
        let mut pieces = Incoming { sentences: &incoming, current: &current, settings: &settings, lang: "es", whole: false, waiting: VecDeque::new(), chars: 0 };
        sentences.send("El desarrollo está terminado.".to_string()).unwrap();
        sentences.send("   ".to_string()).unwrap();
        // The first piece is there before the writer is done: the voice does not wait for the rest.
        assert!(pieces.next().unwrap().text.contains("desarrollo"));
        sentences.send("Se verifican los escenarios. Falta uno.".to_string()).unwrap();
        // The writer is done: what it sent is said, and then the utterance ends rather than wait.
        drop(sentences);
        let rest: Vec<String> = pieces.by_ref().map(|piece| piece.text).collect();
        assert!(!rest.is_empty());
        let said = rest.join(" ");
        assert!(said.contains("verifican") && said.contains("Falta"), "{said}");
        assert!(pieces.next().is_none());

        // Told to stop, it does not wait for the writer.
        let (_held, incoming) = std::sync::mpsc::channel::<String>();
        going.store(false, Ordering::SeqCst);
        let mut pieces = Incoming { sentences: &incoming, current: &current, settings: &settings, lang: "es", whole: false, waiting: VecDeque::new(), chars: 0 };
        assert!(pieces.next().is_none());
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
