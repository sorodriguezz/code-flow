//! Codi's ear: the microphone, open while Codi is on, cut into utterances as they end, each one
//! transcribed here and handed on only when it is addressed to Codi.
//!
//! **One thread owns the detector**; the microphone's own thread hands it 40 ms blocks. An
//! utterance is transcribed on that thread too — Parakeet takes about a tenth of a second for an
//! order — so audio that arrives meanwhile waits in the channel, not lost.
//!
//! **Its own voice is not an order.** While Codi speaks, an utterance counts only if it starts with
//! its name (a barge-in: «Codi, para»); in «conversación» too, because its voice leaking from the
//! laptop's speakers would otherwise be answered. A transcript that is mostly the words being said
//! right now is dropped outright. The detector's threshold also rises while it speaks. With
//! headphones none of this ever triggers. A real echo canceller (the system's voice-processing
//! input) is the step after, if laptops need it.
//!
//! **Quiet while the user is busy elsewhere.** A dictation in progress is somebody typing with their
//! voice, and a meeting being recorded is a conversation among people: Codi hears neither.
//!
//! **Push to talk hears nothing between presses.** In that mode the microphone is paused (its
//! light goes out) until the key or button goes down, everything said while it is held is one order
//! — no detector cutting it, no name needed — and it is heard once the key is let go and
//! [`PTT_TAIL`] has passed. Before 2026-10-21 it listened all along and threw away what was said
//! between presses, which showed in the window as «… sin "Codi"».

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::{vad, wake, Phase, Settings};
use crate::dictation::Listener;

/// The detector's threshold, and the raised one while Codi speaks.
const THRESHOLD: f32 = 0.5;
const THRESHOLD_SPEAKING: f32 = 0.7;
/// Utterances shorter than this are a click or a breath.
const SHORTEST: usize = 16_000 * 3 / 10;
/// After the push-to-talk key is let go the microphone stays open this long: the last syllable is
/// usually still being said as the finger lifts.
const PTT_TAIL: Duration = Duration::from_millis(300);
/// What the capture needs, once paused, to hand on the end of what it heard.
const PTT_FLUSH: Duration = Duration::from_millis(120);
/// A held order longer than this is heard as it stands; the rest is the next one.
const PTT_LONGEST: usize = 16_000 * 60;
/// How often the listening mode is read again while the microphone is open.
const MODE_EVERY: Duration = Duration::from_secs(1);

struct Running {
    capture: crate::dictation::capture::Capture,
    /// Whether the microphone runs: always outside push to talk, only while held inside it.
    open: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static RUNNING: std::sync::OnceLock<Mutex<Option<Running>>> = std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Heard {
    text: String,
    /// Addressed to Codi: an order.
    addressed: bool,
    /// Why it was not acted on, when it was not: `name` (no «Codi»), `own` (its own voice), `quiet`
    /// (a dictation or a meeting).
    ignored: Option<&'static str>,
}

/// Opens the microphone and starts the thread that listens. Whatever was listening stops first.
pub fn start(app: &AppHandle, settings: &Settings, listener: Listener) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, settings, listener);
        return Err("Codi cannot listen on this platform yet".into());
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        stop();
        if crate::dictation::permission::request() == crate::dictation::permission::Permission::Denied {
            return Err(crate::dictation::capture::DENIED.to_string());
        }
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        let open = Arc::new(AtomicBool::new(settings.mode != "ptt" || super::talking()));
        let level_app = app.clone();
        let last_level = Mutex::new(Instant::now());
        let capture = crate::dictation::capture::listen(
            &settings.device,
            open.clone(),
            move |level| {
                // Twenty-five a second is what the face animates at.
                let mut last = last_level.lock().unwrap_or_else(|p| p.into_inner());
                if last.elapsed() >= Duration::from_millis(40) {
                    *last = Instant::now();
                    super::level(&level_app, level);
                }
            },
            move |block| {
                let _ = tx.send(block);
            },
        )?;
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_stop, thread_app, thread_settings, thread_open) = (stop.clone(), app.clone(), settings.clone(), open.clone());
        let thread = std::thread::Builder::new()
            .name("codi-listen".into())
            .spawn(move || run(&thread_app, &thread_settings, listener, rx, &thread_stop, &thread_open))
            .map_err(|e| e.to_string())?;
        *running().lock().unwrap_or_else(|p| p.into_inner()) = Some(Running { capture, open, stop, thread });
        Ok(())
    }
}

/// The push-to-talk key went down: the microphone opens now rather than on the loop's next turn,
/// and whatever Codi was saying stops — it would be heard as part of the order.
pub fn pressed(app: &AppHandle) {
    let open = running().lock().ok().and_then(|held| held.as_ref().map(|running| running.open.clone()));
    let Some(open) = open else { return };
    open.store(true, Ordering::SeqCst);
    if crate::speech::speaking() {
        crate::speech::stop();
    }
    if !matches!(current_phase(), Phase::Thinking | Phase::Acting | Phase::Waiting) {
        super::set_phase(app, Phase::Hearing);
    }
}

/// Closes the microphone and ends the thread.
pub fn stop() {
    let held = running().lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(running) = held {
        running.stop.store(true, Ordering::SeqCst);
        drop(running.capture);
        let _ = running.thread.join();
    }
    crate::asr::recognizer::unload(&crate::asr::recognizer::CODI);
    crate::dictation::engine::unload_slot(&crate::dictation::engine::CODI);
}

fn run(app: &AppHandle, settings: &Settings, listener: Listener, rx: mpsc::Receiver<Vec<f32>>, stop: &AtomicBool, open: &AtomicBool) {
    let mut detector = match vad::Detector::new(&vad::model_path(), THRESHOLD) {
        Ok(detector) => detector,
        Err(error) => {
            super::listening_failed(app, error);
            return;
        }
    };
    let mut raised = false;
    let mut was_speaking = false;
    let lang = super::lang(app);
    let mut mode = settings.mode.clone();
    let mut mode_read = Instant::now();
    let mut held = Held::default();
    while !stop.load(Ordering::SeqCst) {
        let block = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(block) => Some(block),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if mode_read.elapsed() >= MODE_EVERY {
            let now = super::settings(app).mode;
            mode_read = Instant::now();
            if now != mode {
                mode = now;
                // Into push to talk the chord is bound, out of it it is let go.
                if let Err(error) = super::hotkey::sync(app) {
                    super::listening_failed(app, error);
                }
            }
        }
        if mode == "ptt" {
            if let Some(samples) = held.step(super::talking(), block, open) {
                if current_phase() == Phase::Hearing {
                    super::set_phase(app, Phase::Idle);
                }
                if samples.len() >= SHORTEST {
                    hear(app, &super::settings(app), listener, &samples, lang, true);
                }
            }
            continue;
        }
        held = Held::default();
        open.store(true, Ordering::SeqCst);
        let Some(block) = block else { continue };
        // Its own voice raises the bar; a new detector, since the threshold is part of its config.
        let speaking_now = crate::speech::speaking();
        if speaking_now != raised {
            if let Ok(next) = vad::Detector::new(&vad::model_path(), if speaking_now { THRESHOLD_SPEAKING } else { THRESHOLD }) {
                detector = next;
                raised = speaking_now;
            }
        }
        let utterances = detector.push(&block);
        let speaking = detector.speaking();
        if speaking != was_speaking {
            was_speaking = speaking;
            if !matches!(current_phase(), Phase::Thinking | Phase::Acting | Phase::Speaking | Phase::Waiting) {
                super::set_phase(app, if speaking { Phase::Hearing } else { Phase::Idle });
            }
        }
        for samples in utterances {
            if samples.len() < SHORTEST {
                continue;
            }
            // Read again for every utterance: a mode or a name changed in Settings applies to the
            // next thing said, without closing the microphone. The model is the one opened with.
            hear(app, &super::settings(app), listener, &samples, lang, false);
        }
    }
    for samples in detector.flush() {
        if samples.len() >= SHORTEST {
            hear(app, &super::settings(app), listener, &samples, lang, false);
        }
    }
}

/// Push to talk, between the loop's turns: what is held, and when the key was let go.
#[derive(Default)]
struct Held {
    audio: Vec<f32>,
    down: bool,
    let_go: Option<Instant>,
}

impl Held {
    /// One turn of the loop with the key `down` or not and maybe a `block` of audio. Keeps the
    /// microphone `open` only while it is wanted, and returns the order's audio once it is complete:
    /// [`PTT_TAIL`] after the key was let go, plus the capture's last flush.
    fn step(&mut self, down: bool, block: Option<Vec<f32>>, open: &AtomicBool) -> Option<Vec<f32>> {
        if down && !self.down {
            self.audio.clear();
            self.let_go = None;
        }
        if !down && self.down {
            self.let_go = Some(Instant::now());
        }
        self.down = down;
        if let Some(block) = block {
            if down || self.let_go.is_some() {
                self.audio.extend(block);
            }
        }
        if down && self.audio.len() >= PTT_LONGEST {
            return Some(std::mem::take(&mut self.audio));
        }
        let Some(at) = self.let_go else {
            if !down {
                open.store(false, Ordering::SeqCst);
            }
            return None;
        };
        if at.elapsed() >= PTT_TAIL {
            open.store(false, Ordering::SeqCst);
        }
        if at.elapsed() < PTT_TAIL + PTT_FLUSH {
            return None;
        }
        self.let_go = None;
        Some(std::mem::take(&mut self.audio))
    }
}

fn current_phase() -> Phase {
    super::shared().lock().map(|held| held.phase).unwrap_or(Phase::Off)
}

/// One utterance: transcribed, and acted on when it is for Codi. `held`: said with the push-to-talk
/// key down — an order whole, name or not.
fn hear(app: &AppHandle, settings: &Settings, listener: Listener, samples: &[f32], lang: &str, held: bool) {
    let quiet = crate::commands::dictation_cmd::dictating() || crate::commands::meetings_cmd::recording(app);
    let text = match transcribe(listener, samples, lang, &settings.wake_words) {
        Ok(text) => text,
        Err(error) => {
            super::listening_failed(app, error);
            return;
        }
    };
    if text.trim().is_empty() {
        return;
    }
    let emit = |addressed: bool, ignored: Option<&'static str>| {
        let _ = app.emit(super::HEARD_EVENT, Heard { text: text.clone(), addressed, ignored });
    };
    if quiet {
        return emit(false, Some("quiet"));
    }
    // A question is waiting: a short yes or no answers it, name or not.
    if super::asking() {
        let answer = wake::addressed(&text, &settings.wake_words).unwrap_or_else(|| text.clone());
        if let Some(yes) = wake::yes_or_no(&answer) {
            super::answer(None, yes);
            return emit(true, None);
        }
    }
    let speaking = crate::speech::speaking();
    if speaking && echoes(&text, crate::speech::saying().as_deref().unwrap_or_default()) {
        return emit(false, Some("own"));
    }
    let order = match settings.mode.as_str() {
        _ if speaking && !held => wake::addressed(&text, &settings.wake_words),
        "conversation" => Some(wake::addressed(&text, &settings.wake_words).unwrap_or_else(|| text.clone())),
        "ptt" if held => Some(wake::addressed(&text, &settings.wake_words).unwrap_or_else(|| text.clone())),
        "ptt" => None,
        _ => wake::addressed(&text, &settings.wake_words),
    };
    let Some(order) = order else {
        return emit(false, Some(if speaking { "own" } else { "name" }));
    };
    emit(true, None);
    if speaking {
        // A barge-in: whatever Codi was saying gives way to what it is told now.
        crate::speech::stop();
    }
    if order.trim().is_empty() {
        // Just its name: it is listening — the face says so; nothing to answer yet.
        return;
    }
    super::order(app, order);
}

/// Most of `heard` is the words being said: its own voice, heard back.
fn echoes(heard: &str, saying: &str) -> bool {
    let said: std::collections::HashSet<String> = super::router::normalize(saying).split(' ').map(str::to_string).collect();
    let heard = super::router::normalize(heard);
    let words: Vec<&str> = heard.split(' ').filter(|w| w.len() > 2).collect();
    if words.is_empty() {
        return false;
    }
    let shared = words.iter().filter(|w| said.contains(**w)).count();
    shared * 2 > words.len()
}

/// The text of one utterance, by whichever engine listens. Codi's name goes in whisper's prompt —
/// measured, it took «Codi» from 45 % to 83–89 % of orders heard.
fn transcribe(listener: Listener, samples: &[f32], lang: &str, names: &[String]) -> Result<String, String> {
    match listener {
        Listener::Sherpa(model) => crate::asr::transcribe(&crate::asr::recognizer::CODI, model, samples, "auto", lang, None),
        Listener::Whisper(model) => {
            use crate::dictation::engine;
            let path = crate::dictation::model_path(model);
            let prompt = format!("Codi, CodeFlow, {}.", names.iter().filter(|n| *n != "codi").cloned().collect::<Vec<_>>().join(", "));
            let options = engine::Options { language: lang.to_string(), prompt, ..engine::Options::default() };
            let abort = AtomicBool::new(false);
            let segments = engine::segments(&engine::CODI, &path, samples, &options, &abort)?;
            Ok(segments.iter().map(|segment| segment.text.trim()).collect::<Vec<_>>().join(" ").replace("[BLANK_AUDIO]", "").trim().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_to_talk_hears_only_what_is_held_and_its_tail() {
        let open = AtomicBool::new(false);
        let mut held = Held::default();
        let block = |v: f32| Some(vec![v; 640]);
        // Between presses: nothing kept, the microphone stays closed.
        assert!(held.step(false, block(0.1), &open).is_none());
        assert!(!open.load(Ordering::SeqCst));
        // Held (`pressed` opened it): every block is the order.
        open.store(true, Ordering::SeqCst);
        assert!(held.step(true, block(0.2), &open).is_none());
        assert!(held.step(true, block(0.2), &open).is_none());
        // Let go: the last syllable is still coming, so it stays open for the tail.
        assert!(held.step(false, block(0.3), &open).is_none());
        assert!(open.load(Ordering::SeqCst));
        std::thread::sleep(PTT_TAIL + PTT_FLUSH + Duration::from_millis(30));
        let order = held.step(false, block(0.4), &open).expect("heard once the tail has passed");
        assert_eq!(order.len(), 640 * 4, "the held blocks, the tail and the capture's last flush");
        assert!(!open.load(Ordering::SeqCst), "closed again");
        // And nothing after it.
        assert!(held.step(false, block(0.5), &open).is_none());
    }

    /// The ear without the app: a real clip («Codi, revisa el pull request cuarenta y dos…» said by
    /// Paulina) padded with silence, fed 40 ms at a time through the detector and Parakeet, comes
    /// out as one utterance addressed to Codi, its name taken off.
    /// `CODEFLOW_TEST_EAR=<sherpa library>|<silero_vad.onnx>|<parakeet folder>|<wav>`.
    #[test]
    #[ignore]
    fn a_spoken_order_reaches_codi_without_its_name() {
        let spec = std::env::var("CODEFLOW_TEST_EAR").expect("CODEFLOW_TEST_EAR=<library>|<vad>|<parakeet dir>|<wav>");
        let parts: Vec<&str> = spec.split('|').collect();
        let library = std::path::Path::new(parts[0]);
        crate::codi::vad::load_library_for_test(library);
        crate::asr::recognizer::load_library_for_test(library);
        let bytes = std::fs::read(parts[3]).unwrap();
        let at = bytes.windows(4).position(|w| w == b"data").unwrap() + 8;
        let speech: Vec<f32> = bytes[at..].chunks_exact(2).map(|p| f32::from(i16::from_le_bytes([p[0], p[1]])) / 32768.0).collect();
        let mut audio = vec![0.0f32; 12_000];
        audio.extend(&speech);
        audio.extend(vec![0.0f32; 16_000]);
        let mut detector = vad::Detector::new(std::path::Path::new(parts[1]), THRESHOLD).unwrap();
        let started = Instant::now();
        let mut utterances = Vec::new();
        for block in audio.chunks(640) {
            utterances.extend(detector.push(block));
        }
        utterances.extend(detector.flush());
        assert_eq!(utterances.len(), 1);
        let text = crate::asr::recognizer::transcribe_in_test(std::path::Path::new(parts[2]), &utterances[0]);
        let order = wake::addressed(&text, &["codi".to_string()]);
        eprintln!("{text:?} → {order:?} in {:?}", started.elapsed());
        let order = order.expect("addressed to Codi");
        assert!(order.to_lowercase().contains("pull request"), "{order}");
        assert!(!order.to_lowercase().starts_with("cod"), "{order}");
    }

    #[test]
    fn its_own_words_heard_back_are_not_an_order() {
        let saying = "Terminé la revisión del pull request cuarenta y dos: hay dos comentarios y nada bloqueante.";
        assert!(echoes("terminé la revisión del pull request", saying));
        assert!(!echoes("Codi, para", saying));
        assert!(!echoes("abre las notas", saying));
        assert!(!echoes("", saying));
    }
}
