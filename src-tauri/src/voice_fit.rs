//! «¿Cuál le va a este equipo?»: for every model that listens and every voice, how heavy it is, how
//! fast it would be *here*, how accurate it is, and which one each feature is recommended — what
//! Settings › Voz y sonido shows beside every download (the user asked for exactly that, 2026-10-21:
//! "recomendar cuál se adapta mejor para su PC y mostrar sus pesos, velocidad").
//!
//! **Estimated until measured.** Before a model is downloaded its speed is an estimate: what it took
//! on the machine it was measured on (an M4, 2026-10-21, the clips of `.claude/plans/codi.md` «F0»),
//! for the class this machine falls in ([`Class`]). Once it is downloaded it is measured here, on a
//! synthetic utterance, right after the download and whenever «Medir» is pressed
//! ([`measure`]) — and that number replaces the estimate, marked as measured. A model's speed on a
//! CPU follows its cores far more than its gigabytes, so the class is read from the cores, not from
//! the memory.
//!
//! **The whisper library is CPU-only on Windows** (the prebuilt one this app downloads), and
//! sherpa-onnx runs on the CPU everywhere: a graphics card speeds up the local AI models
//! (`hybrid::hardware`), not these. Only Apple Silicon runs whisper on its GPU (Metal).

use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::queries;
use crate::dictation::{self, Listener};
use crate::speech;

/// The setting holding what was measured here: `{ id: Measured }`.
pub const BENCH_KEY: &str = "voice_bench";
/// Emitted after a measurement, so the panes re-read.
pub const EVENT: &str = "voice:fit";

/// The kind of machine an estimate is read for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    /// Apple Silicon: whisper on the GPU (Metal), the rest on fast cores.
    Apple,
    /// A PC with six physical cores or more.
    Pc,
    /// Fewer — the four-core laptop the recommendations must still work on.
    Modest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub class: Class,
    pub cpu: String,
    pub cores: usize,
    pub ram_gb: f64,
    /// The graphics card, when there is one — for the local AI models, not these.
    pub gpu: Option<String>,
}

/// This machine's class, read once — what Codi asks on every state it sends.
pub fn class() -> Class {
    static CLASS: std::sync::OnceLock<Class> = std::sync::OnceLock::new();
    *CLASS.get_or_init(|| {
        let cores = sysinfo::System::physical_core_count().unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
        class_of(cores)
    })
}

fn class_of(cores: usize) -> Class {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Class::Apple
    } else if cores >= 6 {
        Class::Pc
    } else {
        Class::Modest
    }
}

pub fn machine() -> Machine {
    let mut system = sysinfo::System::new();
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    system.refresh_memory();
    let cores = sysinfo::System::physical_core_count().unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
    let cpu = system.cpus().first().map(|cpu| cpu.brand().trim().to_string()).filter(|b| !b.is_empty()).unwrap_or_default();
    let class = class_of(cores);
    let hardware = crate::hybrid::hardware::machine_blocking();
    let gpu = match hardware.gpu {
        crate::hybrid::hardware::GpuKind::Discrete => hardware.gpu_name,
        _ => None,
    };
    Machine { class, cpu, cores, ram_gb: system.total_memory() as f64 / 1e9, gpu }
}

/// How fast, for the job it is for: a listener per short order, a voice per sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Pace {
    Fast,
    Ok,
    Slow,
    TooSlow,
}

/// A listener is judged by a short order (three seconds of speech): an assistant answers after it.
fn listen_pace(ms: u64) -> Pace {
    match ms {
        0..=350 => Pace::Fast,
        351..=900 => Pace::Ok,
        901..=2_500 => Pace::Slow,
        _ => Pace::TooSlow,
    }
}

/// A voice by how long its first sentence takes to start.
fn speak_pace(ms: u64) -> Pace {
    match ms {
        0..=400 => Pace::Fast,
        401..=1_200 => Pace::Ok,
        1_201..=2_500 => Pace::Slow,
        _ => Pace::TooSlow,
    }
}

/// Milliseconds a listener takes for a three-second order, by class — measured on the M4 for
/// `Apple` (GPU for whisper) and as its four- and two-core CPU runs for the other two, the x86 cores
/// taken as a third slower than the M4's. tiny/base/large on the CPU are scaled from the measured
/// ones by their size.
fn listen_estimate(id: &str, class: Class) -> u64 {
    let (apple, pc, modest) = match id {
        "tiny" => (100, 330, 800),
        "base" => (160, 600, 1_400),
        "small" => (330, 1_200, 3_500),
        "turbo" => (1_600, 5_400, 12_000),
        "large" => (1_750, 10_500, 24_000),
        "parakeet" => (90, 120, 260),
        "canary" => (120, 160, 330),
        _ => (1_000, 3_000, 8_000),
    };
    match class {
        Class::Apple => apple,
        Class::Pc => pc,
        Class::Modest => modest,
    }
}

/// Memory a listener holds while loaded, measured (peak resident size of the bench).
fn listen_ram_mb(id: &str) -> u64 {
    match id {
        "tiny" => 200,
        "base" => 300,
        "small" => 640,
        "turbo" => 800,
        "large" => 1_550,
        "parakeet" => 1_170,
        "canary" => 540,
        _ => 1_000,
    }
}

/// How well it hears Spanish, from the words measured: `max` (0.3 % errors), `high` (1–2 %),
/// `medium`, `basic`.
fn accuracy(id: &str) -> &'static str {
    match id {
        "large" | "turbo" => "max",
        "small" | "parakeet" => "high",
        "canary" | "base" => "medium",
        _ => "basic",
    }
}

/// A voice's first sentence (about five seconds of speech), by class, in milliseconds.
fn speak_estimate(engine: &str, class: Class) -> u64 {
    let (apple, pc, modest) = match engine {
        "kokoro" => (600, 800, 2_700),
        _ => (110, 150, 400),
    };
    match class {
        Class::Apple => apple,
        Class::Pc => pc,
        Class::Modest => modest,
    }
}

/// One measurement on this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    /// A listener's three-second order, or a voice's first sentence.
    pub ms: u64,
    /// A voice: the whole sentence, against its own length (0.2 = five times faster than heard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtf: Option<f32>,
    pub measured_at: String,
}

fn read_bench(conn: &Connection) -> BTreeMap<String, Measured> {
    queries::get_setting(conn, BENCH_KEY).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn write_bench(conn: &Connection, id: &str, measured: Measured) -> Result<(), String> {
    let mut all = read_bench(conn);
    all.insert(id.to_string(), measured);
    let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    queries::set_setting(conn, BENCH_KEY, &json).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenFit {
    pub id: String,
    pub ms: u64,
    pub measured: bool,
    pub pace: Pace,
    pub ram_mb: u64,
    pub accuracy: &'static str,
    /// Features this machine is recommended to use it for: `codi`, `dictation`, `meetingsLive`,
    /// `meetingsFinal`, `translate`.
    pub recommended_for: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakFit {
    /// `kokoro`, or a Piper voice's id.
    pub id: String,
    pub engine: &'static str,
    pub first_ms: u64,
    pub rtf: Option<f32>,
    pub measured: bool,
    pub pace: Pace,
    pub ram_mb: u64,
    pub recommended: bool,
}

/// What each feature is recommended, on this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picks {
    pub codi: String,
    pub dictation: String,
    pub meetings_live: String,
    pub meetings_final: String,
    pub translate: String,
    /// `kokoro` · `piper`.
    pub voice_engine: &'static str,
    pub voice_es: &'static str,
    pub voice_en: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub machine: Machine,
    pub listen: Vec<ListenFit>,
    pub speak: Vec<SpeakFit>,
    pub picks: Picks,
}

/// The recommendations for a class. Parakeet for anything spoken short (it is the fastest and the
/// one that hears «Codi» best everywhere); whisper turbo for the written word where the GPU makes it
/// cheap; Parakeet again on a PC, where turbo takes seconds an order on the CPU.
pub fn picks(class: Class, ram_gb: f64, sherpa: bool) -> Picks {
    let (codi, dictation, live, last, translate) = match (class, sherpa) {
        (_, false) => ("small", "small", "base", "small", "large"),
        (Class::Apple, true) if ram_gb >= 15.0 => ("parakeet", "turbo", "parakeet", "turbo", "canary"),
        (Class::Apple, true) => ("parakeet", "small", "parakeet", "small", "canary"),
        (Class::Pc, true) => ("parakeet", "parakeet", "parakeet", "small", "canary"),
        (Class::Modest, true) => ("parakeet", "parakeet", "parakeet", "base", "canary"),
    };
    // Kokoro where its first sentence starts within about a second; Piper, seven times faster, on
    // the four-core laptop.
    let kokoro = sherpa && class != Class::Modest;
    Picks {
        codi: codi.into(),
        dictation: dictation.into(),
        meetings_live: live.into(),
        meetings_final: last.into(),
        translate: translate.into(),
        voice_engine: if kokoro { "kokoro" } else { "piper" },
        voice_es: if kokoro { "kokoro-ef_dora" } else { "es_MX-claude-high" },
        voice_en: if kokoro { "kokoro-af_heart" } else { "en_US-ljspeech-high" },
    }
}

pub fn fit(conn: &Connection) -> Fit {
    let machine = machine();
    let bench = read_bench(conn);
    let sherpa = crate::asr::supported();
    let picks = picks(machine.class, machine.ram_gb, sherpa);
    let status = dictation::status();
    let listen = status
        .models
        .iter()
        .map(|model| {
            let measured = bench.get(model.id).filter(|_| model.installed);
            let ms = measured.map_or_else(|| listen_estimate(model.id, machine.class), |m| m.ms);
            let mut recommended_for = Vec::new();
            for (feature, id) in [
                ("codi", &picks.codi),
                ("dictation", &picks.dictation),
                ("meetingsLive", &picks.meetings_live),
                ("meetingsFinal", &picks.meetings_final),
                ("translate", &picks.translate),
            ] {
                if id == model.id {
                    recommended_for.push(feature);
                }
            }
            ListenFit {
                id: model.id.to_string(),
                ms,
                measured: measured.is_some(),
                pace: listen_pace(ms),
                ram_mb: listen_ram_mb(model.id),
                accuracy: accuracy(model.id),
                recommended_for,
            }
        })
        .collect();
    let voice = |id: &str, engine: &'static str, installed: bool, ram_mb: u64, recommended: bool| {
        let measured = bench.get(id).filter(|_| installed);
        let first_ms = measured.map_or_else(|| speak_estimate(engine, machine.class), |m| m.ms);
        SpeakFit {
            id: id.to_string(),
            engine,
            first_ms,
            rtf: measured.and_then(|m| m.rtf),
            measured: measured.is_some(),
            pace: speak_pace(first_ms),
            ram_mb,
            recommended,
        }
    };
    let mut speak = vec![voice("kokoro", "kokoro", speech::kokoro::installed(), 700, picks.voice_engine == "kokoro")];
    for spec in speech::piper::VOICES {
        let recommended = picks.voice_engine == "piper" && (spec.id == picks.voice_es || spec.id == picks.voice_en);
        speak.push(voice(spec.id, "piper", speech::piper::installed(spec.id), 330, recommended));
    }
    Fit { machine, listen, speak, picks }
}

/// Three seconds of a voiced, syllable-paced signal — what an encoder costs does not depend on the
/// words (`meetings::bench` measures the same way).
fn utterance(seconds: f32) -> Vec<f32> {
    let rate = 16_000.0f32;
    (0..(rate * seconds) as usize)
        .map(|i| {
            let t = i as f32 / rate;
            let syllables = (t * 4.0 * std::f32::consts::TAU).sin().max(0.0);
            let voice: f32 = [140.0f32, 280.0, 560.0, 1_100.0].iter().map(|hz| (t * hz * std::f32::consts::TAU).sin()).sum::<f32>() / 4.0;
            voice * syllables * 0.3
        })
        .collect()
}

/// What a voice is measured saying: one sentence of about five seconds.
const SENTENCE_ES: &str = "Terminé la revisión del pull request cuarenta y dos: hay dos comentarios y nada bloqueante.";

/// Measures `id` — a listener or a voice (`kokoro`, a Piper voice) — on this machine and stores it.
/// Blocking: seconds of work. A warm-up runs first, so loading is not counted.
pub fn measure(conn_for_result: impl FnOnce(Measured) -> Result<(), String>, id: &str) -> Result<Measured, String> {
    let now = || chrono::Utc::now().to_rfc3339();
    let measured = if let Some(listener) = dictation::listener(id) {
        if !listener.usable() {
            return Err("Download the model first".into());
        }
        let (warm, timed) = (utterance(1.0), utterance(3.0));
        let ms = match listener {
            Listener::Whisper(model) => {
                use dictation::engine;
                let path = dictation::model_path(model);
                let options = engine::Options { language: "es".into(), ..engine::Options::default() };
                let abort = AtomicBool::new(false);
                engine::segments(&engine::FLOWS, &path, &warm, &options, &abort)?;
                let started = Instant::now();
                let result = engine::segments(&engine::FLOWS, &path, &timed, &options, &abort);
                let ms = started.elapsed().as_millis() as u64;
                engine::unload_slot(&engine::FLOWS);
                result?;
                ms
            }
            Listener::Sherpa(model) => {
                let slot = &crate::asr::recognizer::FLOWS;
                crate::asr::transcribe(slot, model, &warm, "es", "es", None)?;
                let started = Instant::now();
                let result = crate::asr::transcribe(slot, model, &timed, "es", "es", None);
                let ms = started.elapsed().as_millis() as u64;
                crate::asr::recognizer::unload(slot);
                result?;
                ms
            }
        };
        Measured { ms, rtf: None, measured_at: now() }
    } else {
        let voice = if id == "kokoro" { "kokoro-ef_dora".to_string() } else { id.to_string() };
        if !speech::voice_installed(&voice) {
            return Err("Download the voice first".into());
        }
        speech::say_with_voice(&voice, "Hola.", 1.0)?;
        let started = Instant::now();
        let mut first = None;
        let mut samples = 0usize;
        let mut rate = 1u32;
        let mut keep = |chunk: &[f32], at: u32| {
            first.get_or_insert_with(|| started.elapsed().as_millis() as u64);
            samples += chunk.len();
            rate = at;
            true
        };
        if speech::kokoro::voice(&voice).is_some() {
            speech::kokoro::synthesize(&voice, SENTENCE_ES, 1.0, &mut keep)?;
        } else {
            speech::piper::synthesize(&voice, SENTENCE_ES, 1.0, &mut keep)?;
        }
        let total = started.elapsed().as_secs_f32();
        let heard = samples as f32 / rate.max(1) as f32;
        Measured { ms: first.unwrap_or(0), rtf: (heard > 0.0).then(|| total / heard), measured_at: now() }
    };
    conn_for_result(measured.clone())?;
    Ok(measured)
}

/// [`measure`] and store it under `id`.
pub fn measure_and_store(db: &crate::db::Db, id: &str) -> Result<Measured, String> {
    measure(
        |measured| {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            write_bench(&conn, id, measured)
        },
        id,
    )
}

/// Measures `id` on a blocking thread once it is downloaded, and tells the panes — the row's speed
/// turns from estimated to measured without anybody pressing anything.
pub fn measure_in_background(app: &tauri::AppHandle, id: &str) {
    use tauri::{Emitter, Manager};
    let (app, id) = (app.clone(), id.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<crate::db::Db>();
        match measure_and_store(&db, &id) {
            Ok(_) => {
                let _ = app.emit(EVENT, &id);
            }
            Err(error) => crate::applog::warn(&format!("voice fit: measuring {id}: {error}")),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_class_gets_parakeet_for_codi_and_a_voice_it_can_say_quickly() {
        for class in [Class::Apple, Class::Pc, Class::Modest] {
            let picks = picks(class, 16.0, true);
            assert_eq!(picks.codi, "parakeet");
            let voice_ms = speak_estimate(picks.voice_engine, class);
            assert!(speak_pace(voice_ms) != Pace::TooSlow, "{class:?}: {voice_ms} ms");
            assert!(listen_pace(listen_estimate(&picks.codi, class)) == Pace::Fast, "{class:?}");
            // Whatever is recommended for a feature is fast enough there.
            for id in [&picks.dictation, &picks.meetings_live] {
                assert!(listen_pace(listen_estimate(id, class)) != Pace::TooSlow, "{class:?} {id}");
            }
        }
        assert_eq!(picks(Class::Modest, 8.0, true).voice_engine, "piper");
        assert_eq!(picks(Class::Apple, 16.0, true).dictation, "turbo");
        assert_eq!(picks(Class::Pc, 16.0, true).dictation, "parakeet", "turbo takes seconds an order on a CPU");
    }

    #[test]
    fn without_sherpa_everything_falls_back_to_whisper() {
        let picks = picks(Class::Pc, 16.0, false);
        assert!(dictation::model(&picks.codi).is_some());
        assert!(dictation::model(&picks.dictation).is_some());
        assert_eq!(picks.voice_engine, "piper");
    }

    #[test]
    fn every_recommended_id_is_in_a_catalogue() {
        for class in [Class::Apple, Class::Pc, Class::Modest] {
            for sherpa in [true, false] {
                let picks = picks(class, 16.0, sherpa);
                for id in [&picks.codi, &picks.dictation, &picks.meetings_live, &picks.meetings_final, &picks.translate] {
                    assert!(dictation::listener(id).is_some(), "{id}");
                }
                assert!(speech::kokoro::voice(picks.voice_es).is_some() || speech::piper::spec(picks.voice_es).is_some());
                assert!(speech::kokoro::voice(picks.voice_en).is_some() || speech::piper::spec(picks.voice_en).is_some());
            }
        }
    }

    #[test]
    fn the_paces_read_the_way_an_assistant_feels() {
        assert_eq!(listen_pace(90), Pace::Fast);
        assert_eq!(listen_pace(1_600), Pace::Slow);
        assert_eq!(listen_pace(4_100), Pace::TooSlow);
        assert_eq!(speak_pace(150), Pace::Fast);
        assert_eq!(speak_pace(600), Pace::Ok);
    }
}
