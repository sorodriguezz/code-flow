//! The text written while the meeting runs (modes *balanced* and *full*).
//!
//! One thread takes the recorder's samples, cuts each channel into utterances as they end
//! (`vad::Cutter`) and transcribes them one at a time, oldest first, on whisper's meetings context
//! or the cloud. In *full* mode each utterance of a separated channel also gets an embedding and a
//! provisional speaker (`speaker::Live`).
//!
//! **It gives up rather than fall behind.** When the utterance about to be transcribed ended more
//! than [`GIVE_UP_LAG_MS`] ago, this machine is not keeping up with the call: the queue is dropped,
//! the window is told (`LiveEvent::Behind`), and from then on samples are only drained. The audio
//! is all on disk regardless — the final pass transcribes it when the meeting ends. Nothing a slow
//! laptop does here can cost a second of the recording.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::dictation::engine::{self, Options};

use super::audio::Channel;
use super::speaker::{self, Extractor};
use super::transcript::{self, Line};
use super::vad::{self, Cutter, Utterance};
use super::CloudSettings;

/// How stale an utterance may be before the live text is abandoned for the final pass.
pub const GIVE_UP_LAG_MS: i64 = 30_000;
/// What is still queued when the meeting stops is transcribed here only if it is this short;
/// otherwise the final pass does it.
const FINISH_QUEUE_MS: i64 = 60_000;

pub enum Engine {
    Local { model: PathBuf },
    Cloud { settings: CloudSettings, key: String },
}

pub struct Config {
    pub engine: Engine,
    pub vad_model: PathBuf,
    pub embedding_model: PathBuf,
    pub language: String,
    pub threads: i32,
    pub vocabulary: String,
    /// The channels whose voices are separated: the system channel in a call, the microphone in a
    /// room.
    pub separate: Vec<Channel>,
    /// Guess speakers while recording (mode *full*, with voices installed).
    pub embed: bool,
}

pub enum LiveEvent {
    Line(Line),
    /// How far behind the conversation the text is, in milliseconds.
    Lag(i64),
    /// The machine cannot keep up: the rest is left for the final pass.
    Behind,
    Failed(String),
}

/// What the live text amounted to when the meeting stopped.
#[derive(Debug, Clone, Copy)]
pub struct Summary {
    /// Every utterance was transcribed: the final pass need not transcribe again.
    pub complete: bool,
}

pub fn spawn(rx: Receiver<super::recorder::LiveAudio>, config: Config, stop: Arc<AtomicBool>, on_event: Arc<dyn Fn(LiveEvent) + Send + Sync>) -> JoinHandle<Summary> {
    std::thread::Builder::new()
        .name("meeting-live".into())
        .spawn(move || {
            super::lower_priority();
            run(rx, config, stop, on_event)
        })
        .expect("a thread for the live text")
}

struct Queued {
    channel: Channel,
    utterance: Utterance,
}

fn run(rx: Receiver<super::recorder::LiveAudio>, config: Config, stop: Arc<AtomicBool>, on_event: Arc<dyn Fn(LiveEvent) + Send + Sync>) -> Summary {
    let mut vad = match vad::load(&config.vad_model, config.threads) {
        Ok(vad) => vad,
        Err(error) => {
            on_event(LiveEvent::Failed(error));
            drain_until_stopped(&rx, &stop);
            return Summary { complete: false };
        }
    };
    let extractor = if config.embed { Extractor::load_from(&config.embedding_model, config.threads).ok() } else { None };
    let mut live_speakers = speaker::Live::default();
    let mut cutters = [Cutter::new(), Cutter::new()];
    let index = |channel: Channel| if channel == Channel::Mic { 0 } else { 1 };
    let mut queue: VecDeque<Queued> = VecDeque::new();
    let mut behind = false;
    let mut recent_system: VecDeque<Line> = VecDeque::new();
    let abort = AtomicBool::new(false);
    let mut prompt_tail = [String::new(), String::new()];
    let mut detect = |samples: &[f32]| vad.speech(samples, vad::params());

    let transcribe = |queued: &Queued, tail: &str| -> Result<String, String> {
        let prompt = format!("{} {}", config.vocabulary.trim(), tail).trim().to_string();
        match &config.engine {
            Engine::Local { model } => {
                let options = Options { language: config.language.clone(), threads: config.threads, words: false, prompt, audio_ctx: 0 };
                let segments = engine::segments(&engine::MEETINGS, model, &queued.utterance.samples, &options, &abort)?;
                Ok(segments
                    .iter()
                    .filter(|s| !transcript::invented(&s.text, s.no_speech))
                    .map(|s| transcript::clean_text(&s.text))
                    .collect::<Vec<_>>()
                    .join(" "))
            }
            Engine::Cloud { settings, key } => {
                let words = tauri::async_runtime::block_on(super::cloud::transcribe(settings, key, &queued.utterance.samples, &config.language, &prompt))?;
                Ok(transcript::clean_text(&words.iter().map(|w| w.text.as_str()).collect::<String>()))
            }
        }
    };

    loop {
        let stopping = stop.load(Ordering::SeqCst);
        let (arrived, disconnected) = take_arrived(&rx, if queue.is_empty() { Duration::from_millis(60) } else { Duration::ZERO });
        if !behind {
            for audio in arrived {
                cutters[index(audio.channel)].push(&audio.samples);
            }
        }
        let finishing = stopping || disconnected;
        if !behind {
            for channel in [Channel::Mic, Channel::System] {
                let cutter = &mut cutters[index(channel)];
                if cutter.due() || finishing {
                    match cutter.cut(&mut detect, finishing) {
                        Ok(done) => queue.extend(done.into_iter().map(|utterance| Queued { channel, utterance })),
                        Err(error) => on_event(LiveEvent::Failed(error)),
                    }
                }
            }
        }
        if finishing {
            let left: i64 = queue.iter().map(|q| q.utterance.end_ms - q.utterance.start_ms).sum();
            if behind || left > FINISH_QUEUE_MS {
                return Summary { complete: false };
            }
        }
        let Some(next) = queue.pop_front() else {
            if finishing {
                return Summary { complete: !behind };
            }
            continue;
        };
        let heard = cutters[index(next.channel)].heard_ms();
        let lag = heard - next.utterance.end_ms;
        on_event(LiveEvent::Lag(lag.max(0)));
        if lag > GIVE_UP_LAG_MS && !finishing {
            behind = true;
            queue.clear();
            cutters = [Cutter::new(), Cutter::new()];
            on_event(LiveEvent::Behind);
            continue;
        }
        let tail = prompt_tail[index(next.channel)].clone();
        let text = match transcribe(&next, &tail) {
            Ok(text) => text,
            Err(error) if error == "cancelled" => continue,
            Err(error) => {
                on_event(LiveEvent::Failed(error));
                continue;
            }
        };
        if text.trim().is_empty() || transcript::invented(&text, 0.0) {
            continue;
        }
        prompt_tail[index(next.channel)] = text.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
        let separated = config.separate.contains(&next.channel);
        let provisional = match (&extractor, separated) {
            (Some(extractor), true) => extractor.embed(&next.utterance.samples).ok().flatten().map(|e| live_speakers.assign(&e)),
            _ => None,
        };
        let speaker = match (next.channel, separated, provisional) {
            (_, true, Some(label)) => transcript::person(label),
            (Channel::Mic, false, _) => transcript::ME.to_string(),
            _ => transcript::OTHERS.to_string(),
        };
        let line = Line { channel: next.channel, speaker, start_ms: next.utterance.start_ms, end_ms: next.utterance.end_ms, text };
        if next.channel == Channel::System {
            recent_system.push_back(line.clone());
            while recent_system.len() > 12 {
                recent_system.pop_front();
            }
        } else if transcript::drop_echo(vec![line.clone()], recent_system.make_contiguous()).is_empty() {
            // The call heard back through the speakers.
            continue;
        }
        on_event(LiveEvent::Line(line));
    }
}

/// What the recorder has sent since the last look, and whether it has hung up. Waits up to `wait`
/// for the first block, then takes only what is already there.
///
/// **Never waits for a quiet moment.** The recorder sends every 40 ms per channel — a block every
/// 20 ms in a call — so a gap of `wait` never comes while it records: a loop that drained until
/// one did never got to cut, and the whole meeting's text came out at «Detener».
fn take_arrived(rx: &Receiver<super::recorder::LiveAudio>, wait: Duration) -> (Vec<super::recorder::LiveAudio>, bool) {
    let mut arrived = Vec::new();
    let first = if wait.is_zero() {
        rx.try_recv().map_err(|error| error == TryRecvError::Disconnected)
    } else {
        rx.recv_timeout(wait).map_err(|error| error == RecvTimeoutError::Disconnected)
    };
    let mut next = first;
    loop {
        match next {
            Ok(audio) => arrived.push(audio),
            Err(disconnected) => return (arrived, disconnected),
        }
        next = rx.try_recv().map_err(|error| error == TryRecvError::Disconnected);
    }
}

fn drain_until_stopped(rx: &Receiver<super::recorder::LiveAudio>, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(_) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A call sends a block every 20 ms (40 ms per channel); the look must still end, with what came.
    #[test]
    fn a_steady_stream_is_taken_without_waiting_for_a_gap() {
        let (tx, rx) = std::sync::mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let sending = stop.clone();
        let sender = std::thread::spawn(move || {
            while !sending.load(Ordering::SeqCst) {
                let _ = tx.send(super::super::recorder::LiveAudio { channel: Channel::Mic, samples: vec![0.0; 320] });
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        let started = std::time::Instant::now();
        let (arrived, disconnected) = take_arrived(&rx, Duration::from_millis(60));
        let took = started.elapsed();
        stop.store(true, Ordering::SeqCst);
        sender.join().unwrap();
        assert!(!arrived.is_empty());
        assert!(!disconnected);
        assert!(took < Duration::from_millis(500), "{took:?}");
        // Hung up: what is left comes out with the news.
        let (rest, disconnected) = take_arrived(&rx, Duration::from_millis(60));
        assert!(disconnected, "{} blocks", rest.len());
    }

    /// The live text on a real recording, fed at four times the speed of speech the way a call
    /// sends it (the microphone and a silent system channel, a block each per tick):
    /// `CODEFLOW_TEST_LIVE=<whisper lib>|<model>|<silero>|<wav>`. Every turn of the synthetic
    /// three-voice meeting must come out as a line, in order, on the microphone's timeline — and
    /// the first while the meeting is still being heard, not at «Detener».
    #[test]
    #[ignore]
    fn a_meeting_heard_live_comes_out_line_by_line() {
        let spec = std::env::var("CODEFLOW_TEST_LIVE").expect("CODEFLOW_TEST_LIVE=<whisper lib>|<model>|<silero>|<wav>");
        let parts: Vec<&str> = spec.split('|').collect();
        crate::dictation::engine::load_library_for_test(std::path::Path::new(parts[0]));
        let samples = super::super::audio::read_wav(std::path::Path::new(parts[3])).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let lines: Arc<Mutex<Vec<Line>>> = Arc::default();
        let seen = lines.clone();
        let config = Config {
            engine: Engine::Local { model: PathBuf::from(parts[1]) },
            vad_model: PathBuf::from(parts[2]),
            embedding_model: PathBuf::new(),
            language: "es".into(),
            threads: 4,
            vocabulary: "CQRS".into(),
            separate: vec![Channel::System],
            embed: false,
        };
        let started = std::time::Instant::now();
        let first_line: Arc<Mutex<Option<Duration>>> = Arc::default();
        let first = first_line.clone();
        let worker = spawn(rx, config, stop.clone(), Arc::new(move |event| {
            if let LiveEvent::Line(line) = event {
                eprintln!("[{:>6}] {:>5} ms · {}: {}", line.start_ms, started.elapsed().as_millis(), line.speaker, line.text);
                first.lock().unwrap().get_or_insert(started.elapsed());
                seen.lock().unwrap().push(line);
            }
        }));
        for block in samples.chunks(1_600) {
            tx.send(super::super::recorder::LiveAudio { channel: Channel::Mic, samples: block.to_vec() }).unwrap();
            tx.send(super::super::recorder::LiveAudio { channel: Channel::System, samples: vec![0.0; block.len()] }).unwrap();
            std::thread::sleep(Duration::from_millis(25));
        }
        let fed = started.elapsed();
        stop.store(true, Ordering::SeqCst);
        drop(tx);
        let summary = worker.join().unwrap();
        // ggml's Metal device aborts at exit while a context still holds it.
        engine::unload_slot(&engine::MEETINGS);
        eprintln!("{:?} in {:?}", summary, started.elapsed());
        let lines = lines.lock().unwrap();
        assert!(summary.complete);
        let first = first_line.lock().unwrap().expect("no line at all");
        assert!(first < fed / 2, "the first line came at {first:?}, the feed ended at {fed:?}");
        assert!(lines.len() >= 6, "{}", lines.len());
        assert!(lines.windows(2).all(|w| w[0].start_ms <= w[1].start_ms));
        assert!(lines.iter().all(|l| l.speaker == transcript::ME));
        let text: String = lines.iter().map(|l| l.text.to_lowercase()).collect::<Vec<_>>().join(" ");
        assert!(text.contains("arquitectura") && text.contains("lunes"), "{text}");
    }
}
