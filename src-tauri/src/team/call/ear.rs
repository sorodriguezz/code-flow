//! The call's ear: the microphone open while the call is, cut into what the user says as each
//! thing ends, transcribed here and handed to the call.
//!
//! Built from the pieces Codi listens with — the capture, the detector, the listening model — and
//! not from Codi's own listener: that one answers to a name and hands what it hears to Codi's
//! brain. Here everything said is for the call, and the call decides who it was for.
//!
//! **An agent's voice is not the user.** On speakers the microphone hears the agents too. While
//! one speaks — and for a moment after, the end of its words is still in the room — what is heard
//! is marked as said over a voice (the call lets through only a name or a «esperen», unless the
//! user said they wear headphones), a transcript that is mostly the words being said is dropped
//! outright, and the detector's bar is raised.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedSender;

use super::{Event, LEVEL_EVENT};
use crate::codi::vad;
use crate::dictation::Listener;

const THRESHOLD: f32 = 0.5;
const THRESHOLD_SPEAKING: f32 = 0.7;
/// Shorter than this is a click or a breath.
const SHORTEST: usize = 16_000 * 3 / 10;
/// How long after a voice stops what is heard may still be that voice.
const TAIL: Duration = Duration::from_millis(900);

struct Running {
    capture: crate::dictation::capture::Capture,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static RUNNING: std::sync::OnceLock<Mutex<Option<Running>>> = std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// The model a call transcribes the user with (`dictation::listener`'s ids); empty is the one this
/// computer is recommended. The call's own — not Codi's choice, which is tuned to hear a name.
pub const LISTEN_KEY: &str = "team_call_listen_model";

/// What a call listens with: its own choice while that model is usable, else what this computer
/// is recommended, else any model that is installed — and the microphone, which is the app's one.
fn settings(conn: &rusqlite::Connection) -> crate::codi::Settings {
    let mut settings = crate::codi::load_settings(conn);
    settings.listen_model = crate::db::queries::get_setting(conn, LISTEN_KEY).ok().flatten().unwrap_or_default().trim().to_string();
    settings
}

/// The id of the model a call would listen with now, if there is one.
pub fn listening_with(conn: &rusqlite::Connection) -> Option<&'static str> {
    crate::codi::listener(&settings(conn)).map(|listener| match listener {
        Listener::Whisper(model) => model.id,
        Listener::Sherpa(model) => model.id,
    })
}

/// Why the microphone cannot open, as the call's state names it.
pub enum Deaf {
    /// This platform has no capture yet.
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    Unsupported,
    Denied,
    /// What has to be downloaded first.
    Missing(Vec<&'static str>),
    Failed(String),
}

/// Opens the microphone. `gate` says whether it runs (the mute button); `names` are the team's,
/// for a listening model that takes a hint of what it will hear.
pub fn start(app: &AppHandle, events: UnboundedSender<Event>, gate: Arc<AtomicBool>, lang: &'static str, names: Vec<String>) -> Result<(), Deaf> {
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, events, gate, lang, names);
        return Err(Deaf::Unsupported);
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        use tauri::Manager;
        stop();
        let settings = {
            let db = app.state::<crate::db::Db>();
            let conn = db.0.lock().map_err(|e| Deaf::Failed(e.to_string()))?;
            settings(&conn)
        };
        let missing = crate::codi::missing(&settings);
        let Some(listener) = crate::codi::listener(&settings).filter(|_| missing.is_empty()) else {
            return Err(Deaf::Missing(missing));
        };
        if crate::dictation::permission::request() == crate::dictation::permission::Permission::Denied {
            return Err(Deaf::Denied);
        }
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        let level_app = app.clone();
        let last_level = Mutex::new(Instant::now());
        let capture = crate::dictation::capture::listen(
            &settings.device,
            gate,
            move |level| {
                // Twenty-five a second is what the bars move at.
                let mut last = last_level.lock().unwrap_or_else(|p| p.into_inner());
                if last.elapsed() >= Duration::from_millis(40) {
                    *last = Instant::now();
                    let _ = level_app.emit(LEVEL_EVENT, level);
                }
            },
            move |block| {
                let _ = tx.send(block);
            },
        )
        .map_err(|error| if error == crate::dictation::capture::DENIED { Deaf::Denied } else { Deaf::Failed(error) })?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("team-call-ear".into())
            .spawn(move || run(listener, rx, &thread_stop, &events, lang, &names))
            .map_err(|e| Deaf::Failed(e.to_string()))?;
        *running().lock().unwrap_or_else(|p| p.into_inner()) = Some(Running { capture, stop, thread });
        Ok(())
    }
}

/// Closes the microphone and lets go of the model.
pub fn stop() {
    let held = running().lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(running) = held {
        running.stop.store(true, Ordering::SeqCst);
        drop(running.capture);
        let _ = running.thread.join();
        crate::asr::recognizer::unload(&crate::asr::recognizer::CALL);
        crate::dictation::engine::unload_slot(&crate::dictation::engine::CALL);
    }
}

pub fn open() -> bool {
    running().lock().is_ok_and(|held| held.is_some())
}

fn run(listener: Listener, rx: mpsc::Receiver<Vec<f32>>, stop: &AtomicBool, events: &UnboundedSender<Event>, lang: &'static str, names: &[String]) {
    let mut detector = match vad::Detector::new(&vad::model_path(), THRESHOLD) {
        Ok(detector) => detector,
        Err(error) => {
            let _ = events.send(Event::EarFailed(error));
            return;
        }
    };
    let mut raised = false;
    let mut was_speaking = false;
    // The last moment an agent's voice was heard to be on, and what it was saying.
    let mut voice: Option<(Instant, String)> = None;
    while !stop.load(Ordering::SeqCst) {
        let block = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(block) => block,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let speaking_now = crate::speech::speaking();
        if speaking_now {
            voice = Some((Instant::now(), crate::speech::saying().unwrap_or_default()));
        }
        // An agent's voice raises the bar; a new detector, since the threshold is part of its config.
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
            let _ = events.send(Event::Hearing(speaking));
        }
        for samples in utterances {
            if samples.len() < SHORTEST || crate::commands::dictation_cmd::dictating() {
                continue;
            }
            let text = match transcribe(listener, &samples, lang, names) {
                Ok(text) => text,
                Err(error) => {
                    let _ = events.send(Event::EarFailed(error));
                    return;
                }
            };
            if text.trim().is_empty() {
                continue;
            }
            let over = voice.as_ref().filter(|(at, _)| at.elapsed() <= TAIL);
            if over.is_some_and(|(_, saying)| echoes(&text, saying)) {
                continue;
            }
            let _ = events.send(Event::Said { text, typed: false, over_voice: over.is_some() });
        }
    }
}

/// Most of `heard` is the words being said: an agent's voice, heard back.
pub(super) fn echoes(heard: &str, saying: &str) -> bool {
    let normal = crate::codi::router::normalize;
    let said: std::collections::HashSet<String> = normal(saying).split(' ').map(str::to_string).collect();
    let heard = normal(heard);
    let words: Vec<&str> = heard.split(' ').filter(|w| w.len() > 2).collect();
    if words.is_empty() {
        return false;
    }
    let shared = words.iter().filter(|w| said.contains(**w)).count();
    shared * 2 > words.len()
}

/// The text of one thing said, by whichever engine listens. The team's names go in whisper's prompt:
/// a name it was told to expect is a name it hears.
fn transcribe(listener: Listener, samples: &[f32], lang: &str, names: &[String]) -> Result<String, String> {
    match listener {
        Listener::Sherpa(model) => crate::asr::transcribe(&crate::asr::recognizer::CALL, model, samples, "auto", lang, None),
        Listener::Whisper(model) => {
            use crate::dictation::engine;
            let path = crate::dictation::model_path(model);
            let prompt = format!("{}.", names.join(", "));
            let options = engine::Options { language: lang.to_string(), prompt, ..engine::Options::default() };
            let abort = AtomicBool::new(false);
            let segments = engine::segments(&engine::CALL, &path, samples, &options, &abort)?;
            Ok(segments.iter().map(|segment| segment.text.trim()).collect::<Vec<_>>().join(" ").replace("[BLANK_AUDIO]", "").trim().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_s_words_heard_back_are_not_the_user_s() {
        let saying = "El desarrollo está terminado. QA está verificando los escenarios de expiración del token.";
        assert!(echoes("el desarrollo esta terminado qa esta verificando", saying));
        assert!(echoes("verificando los escenarios de expiración", saying));
        assert!(!echoes("QA, ¿encontraste algún problema?", saying));
        assert!(!echoes("Esperen", saying));
        assert!(!echoes("", saying));
    }
}
