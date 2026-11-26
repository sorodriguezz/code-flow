//! The call's ear: the microphone open while the call is, cut into what the user says as each
//! thing ends, transcribed here and handed to the call.
//!
//! Built from the pieces Codi listens with — the capture, the detector, the listening model — and
//! not from Codi's own listener: that one answers to a name and hands what it hears to Codi's
//! brain. Here everything said is for the call, and the call decides who it was for.
//!
//! **An agent's voice is not the user.** On speakers the microphone hears the agents too. What is
//! heard while one speaks — and for a moment after, the end of its words is still in the room — is
//! marked as said over a voice (the call lets through only a name or a «esperen», unless the user
//! said they wear headphones), a transcript that is the agents' own words in their own order is
//! dropped outright, and the detector's bar is raised.
//!
//! Both are judged against **when it was heard**, not when its text is ready: a long thing takes a
//! second or two to transcribe, by which time the voice it was heard over has stopped — and an
//! agent's whole answer, which opens with its own name, came through as the user's.

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
/// How long what an agent said is remembered, to tell it from the user when it is heard back.
const REMEMBER: Duration = Duration::from_secs(90);

/// What the agents' voices have been saying, and when: each stretch of one voice with the last
/// moment it was heard to be on.
#[derive(Default)]
struct Voices {
    said: std::collections::VecDeque<(Instant, String)>,
}

impl Voices {
    /// A voice is on now, saying `text` — everything of its turn so far.
    fn on(&mut self, now: Instant, text: String) {
        match self.said.back_mut() {
            // The same turn, grown by a sentence — or a block later.
            Some((at, last)) if text.starts_with(last.as_str()) || last.starts_with(text.as_str()) => {
                *at = now;
                if text.len() > last.len() {
                    *last = text;
                }
            }
            _ => self.said.push_back((now, text)),
        }
        while self.said.front().is_some_and(|(at, _)| now.duration_since(*at) > REMEMBER) {
            self.said.pop_front();
        }
    }

    /// What was being said while something heard from `began` on was being heard — nothing when no
    /// voice was on then, nor in the moment before.
    fn over(&self, began: Instant) -> Option<String> {
        let texts: Vec<&str> = self.said.iter().filter(|(at, _)| *at + TAIL >= began).map(|(_, text)| text.as_str()).collect();
        (!texts.is_empty()).then(|| texts.join(" "))
    }
}

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
        let (tx, rx) = mpsc::channel::<Heard>();
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
            move |samples| {
                // Stamped as it is captured, with what a voice was saying then: the thread that
                // reads these falls behind while it transcribes, and by the time it gets to a
                // block the voice it was heard over may have stopped.
                let voice = crate::speech::speaking().then(|| crate::speech::saying().unwrap_or_default());
                let _ = tx.send(Heard { at: Instant::now(), voice, samples });
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

/// A block of what the microphone heard: when, and what an agent's voice was saying at that moment.
struct Heard {
    at: Instant,
    voice: Option<String>,
    samples: Vec<f32>,
}

fn run(listener: Listener, rx: mpsc::Receiver<Heard>, stop: &AtomicBool, events: &UnboundedSender<Event>, lang: &'static str, names: &[String]) {
    let mut detector = match vad::Detector::new(&vad::model_path(), THRESHOLD) {
        Ok(detector) => detector,
        Err(error) => {
            let _ = events.send(Event::EarFailed(error));
            return;
        }
    };
    let mut raised = false;
    let mut was_speaking = false;
    let mut voices = Voices::default();
    while !stop.load(Ordering::SeqCst) {
        let Heard { at, voice, samples: block } = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(heard) => heard,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let speaking_now = voice.is_some();
        if let Some(saying) = voice {
            voices.on(at, saying);
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
            // When it was heard — it ends with the block just read — and not when its text is ready:
            // by then the voice it was heard over may have been quiet for seconds.
            let began = at.checked_sub(Duration::from_millis(samples.len() as u64 * 1000 / 16_000)).unwrap_or(at);
            let over = voices.over(began);
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
            if over.as_deref().is_some_and(|saying| echoes(&text, saying)) {
                continue;
            }
            let _ = events.send(Event::Said { text, typed: false, over_voice: over.is_some() });
        }
    }
}

/// `heard` is what was being said (`saying`), heard back: the agents' own words in their own
/// order. Words in common are not enough — somebody asking about «la base de datos» while an agent
/// talks about it shares most of its words with it — so what counts is runs: half of what was
/// heard in runs of three words the voice said, or most of it in pairs, which is what a transcript
/// with a word misheard here and there still leaves.
pub(super) fn echoes(heard: &str, saying: &str) -> bool {
    let normal = crate::codi::router::normalize;
    let (heard, saying) = (normal(heard), normal(saying));
    let heard: Vec<&str> = heard.split(' ').filter(|w| !w.is_empty()).collect();
    let said: Vec<&str> = saying.split(' ').filter(|w| !w.is_empty()).collect();
    if heard.is_empty() || said.is_empty() {
        return false;
    }
    // A word or two: an echo when the voice said exactly that.
    if heard.len() < 3 {
        return said.windows(heard.len()).any(|run| run == heard.as_slice());
    }
    // How many of the words heard sit in a run of `n` the voice said.
    let covered = |n: usize| {
        let runs: std::collections::HashSet<&[&str]> = said.windows(n).collect();
        let mut inside = vec![false; heard.len()];
        for at in 0..=heard.len() - n {
            if runs.contains(&heard[at..at + n]) {
                inside[at..at + n].fill(true);
            }
        }
        inside.into_iter().filter(|inside| *inside).count()
    };
    covered(3) * 2 >= heard.len() || covered(2) * 10 >= heard.len() * 7
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

    #[test]
    fn a_whole_answer_heard_back_is_an_echo_though_it_opens_with_a_name_and_a_word_was_misheard() {
        let saying = "Te responde Arquitecto. La pregunta es sobre la base de datos de maestros, y ahí el choque es claro: el lienzo quiere el estado del ETL en Table Storage, vía la API del Core, y el código lo tiene como schema etl en Prisma. Mi postura es seguir el lienzo y cerrarlo con un ADR. Antes de afirmarlo del todo, lo confirmo en el código.";
        let heard = "responde arquitecto. La pregunta es sobre la base de datos de maestros y ahí el choque es claro. El lienzo quiere el estado del ETL en Table Storage vía la API del core. Y el código lo tiene como esquema Excel en Prisma. Mi postura es seguir el lienzo y cerrarlo con una DR. Antes de afirmarlo del todo. Lo confirmo en el código.";
        assert!(echoes(heard, saying));
        // A piece of it, cut where the detector cut it.
        assert!(echoes("QA haga la verificación completa, que integraciones corrija", "Falta decidir cómo seguimos: que QA haga la verificación completa, que Integraciones corrija la consulta y las credenciales."));
        // The user, talking about the same thing over it, is not the voice.
        assert!(!echoes("DBA, ¿qué falta para que la base de datos soporte particiones por fecha?", saying));
        assert!(!echoes("Arquitecto, espera un segundo", saying));
        // A word alone is the voice's only when the voice said it.
        assert!(echoes("para", "Esto es para el módulo de pagos."));
        assert!(!echoes("para", "El desarrollo está terminado."));
    }

    #[test]
    fn what_was_being_said_is_judged_by_when_it_was_heard() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut voices = Voices::default();
        // One turn, growing sentence by sentence, then another agent's.
        voices.on(at(0), "Te responde Arquitecto.".into());
        voices.on(at(2_000), "Te responde Arquitecto. La pregunta es sobre la base.".into());
        voices.on(at(20_000), "Revisé los índices.".into());
        // Heard from the middle of the first turn on: both were said over it.
        assert_eq!(voices.over(at(1_000)).as_deref(), Some("Te responde Arquitecto. La pregunta es sobre la base. Revisé los índices."));
        // Heard just after the last voice stopped: its tail is still in the room.
        assert_eq!(voices.over(at(20_500)).as_deref(), Some("Revisé los índices."));
        // Heard well after: nobody was speaking.
        assert_eq!(voices.over(at(22_000)), None);
    }
}
