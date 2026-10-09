//! What happens when a meeting ends (or a file is imported, or the user asks for a second pass):
//! find the speech, transcribe it word by word, tell the voices apart, put names on the ones the
//! user saved, and turn it all into lines.
//!
//! **Read a piece at a time.** Every step walks the channel's pieces in order and holds only what it
//! is working on — a 28-second piece for whisper, a two-second window for the speaker model — so
//! the memory a two-hour meeting needs is the memory a two-minute one does.
//!
//! **One job at a time, app-wide** (`commands::meetings_cmd` queues them): a laptop finishing two
//! meetings at once finishes neither sooner and makes the call it is in stutter.
//!
//! The work here is pure with respect to the database: a [`Job`] in, an [`Outcome`] out. The
//! command layer reads the inputs, writes the result, and only then compresses the audio — a
//! failure anywhere before that leaves the pieces exactly as they were, ready for another try.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::Serialize;

use crate::dictation::engine::{self, Options};

use super::audio::{self, ms_to_samples, Channel, ChannelReader};
use super::speaker::{self, Extractor};
use super::transcript::{self, Line, Turn, Word};
use super::vad;
use super::CloudSettings;

pub enum Transcriber {
    Local { model: PathBuf },
    Cloud { settings: CloudSettings, key: String },
}

/// A saved voice, as the matcher reads it.
#[derive(Debug, Clone)]
pub struct Voice {
    pub id: String,
    pub name: String,
    pub is_me: bool,
    pub embedding: Vec<f32>,
}

pub struct Job {
    pub dir: PathBuf,
    pub vad_model: PathBuf,
    pub embedding_model: PathBuf,
    /// The channels recorded.
    pub channels: Vec<Channel>,
    /// The channels whose voices are separated.
    pub separate: Vec<Channel>,
    /// `None`: keep these lines (the live text was complete) and only separate voices.
    pub transcribe: Option<Transcriber>,
    pub live_lines: Vec<Line>,
    pub language: String,
    pub threads: i32,
    pub vocabulary: String,
    /// How many people the user said there were in the separated channel; 0 = unknown.
    pub speakers_hint: usize,
    pub voices: Vec<Voice>,
    pub diarize: bool,
}

/// A speaker as the meeting stores it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerOut {
    /// `me`, `others`, `p0`…
    pub key: String,
    pub voice_id: Option<String>,
    pub name: Option<String>,
    pub is_me: bool,
    #[serde(skip)]
    pub centroid: Option<Vec<f32>>,
    pub talk_ms: i64,
}

pub struct Outcome {
    pub lines: Vec<Line>,
    pub speakers: Vec<SpeakerOut>,
    pub duration_ms: i64,
}

/// What the job reports and asks while it runs.
pub trait Host {
    /// `stage` is `detect` · `transcribe` · `voices` · `finish`; `fraction` 0–1 within it.
    fn progress(&self, stage: &'static str, fraction: f32);
    fn cancelled(&self) -> bool;
    /// The flag whisper.cpp checks between computations.
    fn abort_flag(&self) -> &AtomicBool;
}

/// The longest piece sent to a cloud service: fewer requests, still far under the 25 MB cap.
const CLOUD_PIECE_MS: i64 = 90_000;
/// Mic windows embedded to give "Tú" a voice the user can save.
const ME_WINDOWS: usize = 20;

pub fn run(job: &Job, host: &dyn Host) -> Result<Outcome, String> {
    super::lower_priority();
    let duration_ms = job.channels.iter().map(|c| audio::channel_ms(&job.dir, *c)).max().unwrap_or(0);

    // 1. Where people speak, per channel.
    let mut vad = vad::load(&job.vad_model, job.threads)?;
    let mut speech: HashMap<Channel, Vec<(i64, i64)>> = HashMap::new();
    for (index, channel) in job.channels.iter().enumerate() {
        let share = 1.0 / job.channels.len() as f32;
        let found = vad::channel_speech(&mut vad, &job.dir, *channel, |f| host.progress("detect", (index as f32 + f) * share))?;
        speech.insert(*channel, found);
        if host.cancelled() {
            return Err("cancelled".into());
        }
    }
    drop(vad);

    // 2. Words, per channel.
    let mut words: HashMap<Channel, Vec<Word>> = HashMap::new();
    if let Some(transcriber) = &job.transcribe {
        let total: i64 = speech.values().flatten().map(|(s, e)| e - s).sum::<i64>().max(1);
        let mut done = 0i64;
        for channel in &job.channels {
            let limit = if matches!(transcriber, Transcriber::Cloud { .. }) { CLOUD_PIECE_MS } else { vad::PIECE_MS };
            let pieces = vad::join(&speech[channel], limit);
            let mut reader = SpanReader::new(&job.dir, *channel);
            let mut found: Vec<Word> = Vec::new();
            let mut tail = String::new();
            for (start, end) in pieces {
                if host.cancelled() {
                    return Err("cancelled".into());
                }
                let samples = reader.span(start, end)?;
                let prompt = format!("{} {}", job.vocabulary.trim(), tail).trim().to_string();
                let piece_words = match transcriber {
                    Transcriber::Local { model } => {
                        let options = Options { language: job.language.clone(), threads: job.threads, words: true, prompt, audio_ctx: 0 };
                        let segments = engine::segments(&engine::MEETINGS, model, &samples, &options, host.abort_flag())?;
                        transcript::words_from(&segments, start)
                    }
                    Transcriber::Cloud { settings, key } => {
                        let words = tauri::async_runtime::block_on(super::cloud::transcribe(settings, key, &samples, &job.language, &prompt))?;
                        words.into_iter().map(|w| Word { start_ms: w.start_ms + start, end_ms: w.end_ms + start, ..w }).collect()
                    }
                };
                let text: String = piece_words.iter().map(|w| w.text.as_str()).collect();
                tail = text.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
                found.extend(piece_words);
                done += end - start;
                host.progress("transcribe", (done as f32 / total as f32).min(1.0));
            }
            words.insert(*channel, found);
        }
        if let Transcriber::Local { .. } = transcriber {
            // A laptop does not keep a few hundred megabytes resident for a job that has ended.
            engine::unload_slot(&engine::MEETINGS);
        }
    }

    // 3. Voices, in the separated channels.
    let extractor = if job.diarize { Some(Extractor::load_from(&job.embedding_model, job.threads)?) } else { None };
    let mut turns: HashMap<Channel, Vec<Turn>> = HashMap::new();
    let mut centroids: Vec<Vec<f32>> = Vec::new();
    if let Some(extractor) = &extractor {
        for channel in &job.separate {
            let windows = embed_channel(extractor, &job.dir, *channel, &speech[channel], host)?;
            if windows.is_empty() {
                continue;
            }
            let vectors: Vec<Vec<f32>> = windows.iter().map(|w| w.embedding.clone()).collect();
            let mut labels = speaker::cluster(&vectors, job.speakers_hint);
            speaker::smooth(&mut labels);
            let labels = speaker::renumber(&labels);
            let count = labels.iter().max().map_or(0, |m| m + 1);
            for label in 0..count {
                let members = windows.iter().zip(&labels).filter(|(_, l)| **l == label).map(|(w, _)| w.embedding.as_slice());
                centroids.push(speaker::centroid(members).unwrap_or_default());
            }
            turns.insert(*channel, windows.iter().zip(&labels).map(|(w, l)| Turn { start_ms: w.start_ms, end_ms: w.end_ms, label: *l }).collect());
        }
    }

    // 4. Lines. The call heard back through the speakers comes out of the microphone first: by
    // energy (the moments the microphone is no louder than the echo), then by words (runs the call
    // said too, for the person recording speaking over it).
    host.progress("finish", 0.0);
    let own = if job.channels.contains(&Channel::System) && !job.separate.contains(&Channel::Mic) { own_speech(&job.dir)? } else { None };
    if !job.separate.contains(&Channel::Mic) {
        if let (Some(mic), Some(system)) = (words.remove(&Channel::Mic), words.get(&Channel::System)) {
            let mic = match &own {
                Some(own) => mic.into_iter().filter(|w| own.covers(w.start_ms, w.end_ms)).collect(),
                None => mic,
            };
            words.insert(Channel::Mic, transcript::drop_echo_words(mic, system));
        }
    }
    let mut by_channel: HashMap<Channel, Vec<Line>> = HashMap::new();
    for channel in &job.channels {
        let separated = job.separate.contains(channel);
        let default_key = if *channel == Channel::Mic && !separated { transcript::ME } else { transcript::OTHERS };
        let channel_turns = turns.get(channel);
        let lines = if job.transcribe.is_some() {
            let channel_words = words.remove(channel).unwrap_or_default();
            let keys: Vec<String> = match channel_turns {
                Some(turns) => transcript::label_positions(&transcript::anchor(&channel_words, &speech[channel]), turns)
                    .into_iter()
                    .map(|label| label.map(transcript::person).unwrap_or_else(|| default_key.to_string()))
                    .collect(),
                None => vec![default_key.to_string(); channel_words.len()],
            };
            transcript::group(&channel_words, &keys, *channel)
        } else {
            job.live_lines
                .iter()
                .filter(|line| line.channel == *channel)
                .map(|line| {
                    let speaker = channel_turns
                        .and_then(|turns| transcript::label_line(line.start_ms, line.end_ms, turns))
                        .map(transcript::person)
                        .unwrap_or_else(|| default_key.to_string());
                    Line { speaker, ..line.clone() }
                })
                .collect()
        };
        by_channel.insert(*channel, lines);
    }
    let system = by_channel.remove(&Channel::System).unwrap_or_default();
    let mut mic = by_channel.remove(&Channel::Mic).unwrap_or_default();
    if !system.is_empty() && !job.separate.contains(&Channel::Mic) {
        if let (Some(own), None) = (&own, &job.transcribe) {
            // Live lines have no word times: a line the microphone was mostly echo for goes whole.
            mic.retain(|line| own.covers(line.start_ms, line.end_ms));
        }
        mic = transcript::drop_echo(mic, &system);
    }
    let lines = transcript::merge(mic.into_iter().chain(system).collect());

    // 5. Speakers: who is in the lines, with a voice for each separated one.
    let saved: Vec<(String, Vec<f32>)> = job.voices.iter().map(|v| (v.id.clone(), v.embedding.clone())).collect();
    let matched = speaker::match_voices(&centroids, &saved);
    let mut talk: HashMap<String, i64> = HashMap::new();
    for line in &lines {
        *talk.entry(line.speaker.clone()).or_default() += line.end_ms - line.start_ms;
    }
    let mut speakers: Vec<SpeakerOut> = Vec::new();
    if talk.contains_key(transcript::ME) || (job.channels.contains(&Channel::Mic) && !job.separate.contains(&Channel::Mic)) {
        let centroid = match &extractor {
            Some(extractor) => me_centroid(extractor, &job.dir, speech.get(&Channel::Mic).map(Vec::as_slice).unwrap_or(&[])),
            None => None,
        };
        let me_voice = job.voices.iter().find(|v| v.is_me);
        speakers.push(SpeakerOut {
            key: transcript::ME.into(),
            voice_id: me_voice.map(|v| v.id.clone()),
            name: None,
            is_me: true,
            centroid,
            talk_ms: talk.get(transcript::ME).copied().unwrap_or(0),
        });
    }
    if talk.contains_key(transcript::OTHERS) {
        speakers.push(SpeakerOut { key: transcript::OTHERS.into(), voice_id: None, name: None, is_me: false, centroid: None, talk_ms: talk[transcript::OTHERS] });
    }
    for (index, centroid) in centroids.iter().enumerate() {
        let key = transcript::person(index);
        let Some(&talk_ms) = talk.get(&key) else { continue };
        let voice = matched[index].as_ref().and_then(|id| job.voices.iter().find(|v| &v.id == id));
        speakers.push(SpeakerOut {
            key,
            voice_id: voice.map(|v| v.id.clone()),
            name: voice.map(|v| v.name.clone()),
            is_me: voice.is_some_and(|v| v.is_me),
            centroid: Some(centroid.clone()),
            talk_ms,
        });
    }
    host.progress("finish", 1.0);
    Ok(Outcome { lines, speakers, duration_ms })
}

/// Where the microphone is *not* merely hearing the call through the speakers, frame by frame.
///
/// Per 100 ms frame, the microphone's and the system channel's loudness. While the call speaks and
/// the person recording does not, the microphone hears the call times a coupling factor (zero with
/// headphones, a quarter or so with laptop speakers); that factor is read off the frames where the
/// call is loud, at their quietest fifth — the person recording is silent in most of those. A frame
/// is echo when the call is loud around it and the microphone is no louder than the echo would make
/// it; anything else — the person speaking, both at once, silence — is not. The call is taken as
/// the loudest of the frame and its two neighbours: the echo arrives tens of milliseconds late, and
/// the tail of a word the call has just finished is still echo.
pub struct OwnSpeech {
    /// `true` where the frame is not echo.
    frames: Vec<bool>,
}

const FRAME_MS: i64 = 100;

impl OwnSpeech {
    /// Whether at least half of `[start_ms, end_ms)` is not echo.
    pub fn covers(&self, start_ms: i64, end_ms: i64) -> bool {
        let from = (start_ms.max(0) / FRAME_MS) as usize;
        let to = ((end_ms.max(start_ms + 1) + FRAME_MS - 1) / FRAME_MS) as usize;
        let span = &self.frames[from.min(self.frames.len())..to.min(self.frames.len())];
        if span.is_empty() {
            return true;
        }
        span.iter().filter(|own| **own).count() * 2 >= span.len()
    }

    /// From the loudness of both channels per frame.
    pub fn from_levels(mic: &[f32], system: &[f32]) -> Option<OwnSpeech> {
        const LOUD: f32 = 0.01;
        let at = |f: usize| system.get(f).copied().unwrap_or(0.0);
        let near: Vec<f32> = (0..mic.len()).map(|f| at(f.saturating_sub(1)).max(at(f)).max(at(f + 1))).collect();
        let mut ratios: Vec<f32> = mic.iter().zip(&near).filter(|(_, s)| **s > LOUD).map(|(m, s)| m / s).collect();
        if ratios.len() < 20 {
            // The call barely spoke: nothing to tell apart.
            return None;
        }
        ratios.sort_by(f32::total_cmp);
        let coupling = ratios[ratios.len() / 5];
        let frames = mic.iter().zip(&near).map(|(m, s)| !(*s > LOUD && *m <= 2.0 * coupling * s)).collect();
        Some(OwnSpeech { frames })
    }
}

fn own_speech(dir: &Path) -> Result<Option<OwnSpeech>, String> {
    let frame = ms_to_samples(FRAME_MS);
    let levels = |channel: Channel| -> Result<Vec<f32>, String> {
        let mut reader = ChannelReader::open(dir, channel);
        let mut out = Vec::new();
        loop {
            let block = reader.read(frame * 600)?;
            if block.is_empty() {
                return Ok(out);
            }
            out.extend(block.chunks(frame).map(audio::rms));
        }
    };
    let mic = levels(Channel::Mic)?;
    let system = levels(Channel::System)?;
    Ok(OwnSpeech::from_levels(&mic, &system))
}

/// Reads spans of a channel in increasing order — what both whisper's pieces and the speaker
/// model's windows are.
struct SpanReader {
    reader: ChannelReader,
}

impl SpanReader {
    fn new(dir: &Path, channel: Channel) -> Self {
        SpanReader { reader: ChannelReader::open(dir, channel) }
    }

    /// The samples of `[start_ms, end_ms)`. Spans must not go backwards past what was read.
    fn span(&mut self, start_ms: i64, end_ms: i64) -> Result<Vec<f32>, String> {
        let start = ms_to_samples(start_ms);
        let end = ms_to_samples(end_ms).max(start);
        if self.reader.position < start {
            let skip = start - self.reader.position;
            self.reader.read(skip)?;
        }
        let from = self.reader.position.min(end);
        let mut out = self.reader.read(end - from)?;
        // A span that overlaps the previous one (windows do) re-reads nothing: what overlaps is
        // padded from the start of this read instead — the windows are 2 s apart by 1 s, so this
        // only ever trims, never shifts.
        if from > start {
            let missing = from - start;
            let mut padded = vec![0.0; missing.min(out.len())];
            padded.extend(out.drain(..));
            out = padded;
        }
        Ok(out)
    }
}

/// Embeddings over a channel's speech, a window at a time.
fn embed_channel(extractor: &Extractor, dir: &Path, channel: Channel, stretches: &[(i64, i64)], host: &dyn Host) -> Result<Vec<speaker::Window>, String> {
    let all: Vec<(i64, i64)> = stretches.iter().flat_map(|(s, e)| speaker::windows_of(*s, *e)).collect();
    // Windows overlap, and a channel reads forward only: read each stretch whole, then cut it.
    let mut reader = SpanReader::new(dir, channel);
    let mut out = Vec::with_capacity(all.len());
    let mut done = 0usize;
    for &(start, end) in stretches {
        let windows = speaker::windows_of(start, end);
        if windows.is_empty() {
            continue;
        }
        if host.cancelled() {
            return Err("cancelled".into());
        }
        let samples = reader.span(start, end)?;
        for (from, to) in windows {
            let a = ms_to_samples(from - start).min(samples.len());
            let b = ms_to_samples(to - start).min(samples.len());
            if let Some(embedding) = extractor.embed(&samples[a..b])? {
                out.push(speaker::Window { start_ms: from, end_ms: to, embedding });
            }
            done += 1;
            host.progress("voices", done as f32 / all.len().max(1) as f32);
        }
    }
    Ok(out)
}

/// A voice for "Tú", from a sample of the microphone's longest stretches.
fn me_centroid(extractor: &Extractor, dir: &Path, stretches: &[(i64, i64)]) -> Option<Vec<f32>> {
    let mut longest: Vec<(i64, i64)> = stretches.iter().copied().filter(|(s, e)| e - s >= 1_500).collect();
    longest.sort_by_key(|(s, e)| std::cmp::Reverse(e - s));
    longest.truncate(ME_WINDOWS);
    longest.sort();
    let mut reader = SpanReader::new(dir, Channel::Mic);
    let mut vectors = Vec::new();
    for (start, end) in longest {
        let end = end.min(start + speaker::WINDOW_MS * 2);
        let samples = reader.span(start, end).ok()?;
        if let Ok(Some(vector)) = extractor.embed(&samples) {
            vectors.push(vector);
        }
    }
    speaker::centroid(vectors.iter().map(Vec::as_slice))
}

/// Makes sure the channels' pieces are on disk — decoding the compressed file back into them for a
/// second pass. Returns whether it decoded (the caller deletes the pieces again afterwards).
pub fn ensure_pieces(dir: &Path, channels: &[Channel], audio_file: &str) -> Result<bool, String> {
    if channels.iter().all(|c| !audio::pieces(dir, *c).is_empty()) {
        return Ok(false);
    }
    if audio_file.is_empty() {
        return Err("This meeting's audio is no longer kept".into());
    }
    let file = dir.join(audio_file);
    if !file.is_file() {
        return Err("This meeting's audio is no longer kept".into());
    }
    for channel in channels {
        let _ = std::fs::remove_dir_all(audio::channel_dir(dir, *channel));
    }
    super::encode::decode_to_pieces(&file, dir, channels, |_| {})?;
    Ok(true)
}

/// Deletes the pieces once the compressed file holds them.
pub fn drop_pieces(dir: &Path, channels: &[Channel]) {
    for channel in channels {
        let _ = std::fs::remove_dir_all(audio::channel_dir(dir, *channel));
    }
}

/// The waveform the player draws, saved beside the audio: a few hundred peaks per channel.
pub fn write_peaks(dir: &Path, channels: &[Channel]) {
    let peaks: HashMap<&str, Vec<u8>> = channels
        .iter()
        .map(|c| (c.as_str(), audio::peaks(dir, *c, 600).into_iter().map(|p| (p.min(1.0) * 255.0) as u8).collect()))
        .collect();
    if let Ok(json) = serde_json::to_vec(&peaks) {
        let _ = std::fs::write(dir.join("peaks.json"), json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Quiet(AtomicBool);

    impl Host for Quiet {
        fn progress(&self, _: &'static str, _: f32) {}
        fn cancelled(&self) -> bool {
            false
        }
        fn abort_flag(&self) -> &AtomicBool {
            &self.0
        }
    }

    /// The whole pass on a real recording, with the real libraries:
    /// `CODEFLOW_TEST_MEETING=<whisper lib>|<whisper model>|<silero>|<sherpa lib>|<campplus>|<wav>`.
    /// The WAV is a room recording (one channel, every voice separated) — the synthetic three-voice
    /// meeting `say` makes is what it was tuned on.
    #[test]
    #[ignore]
    fn a_real_meeting_comes_out_as_lines_with_people() {
        let spec = std::env::var("CODEFLOW_TEST_MEETING").expect("CODEFLOW_TEST_MEETING=<whisper lib>|<model>|<silero>|<sherpa lib>|<campplus>|<wav>");
        let parts: Vec<&str> = spec.split('|').collect();
        crate::dictation::engine::load_library_for_test(Path::new(parts[0]));
        speaker::load_library_for_test(Path::new(parts[3]));
        let dir = std::env::temp_dir().join(format!("cf-meeting-live-{}", uuid::Uuid::new_v4()));
        let samples = audio::read_wav(Path::new(parts[5])).unwrap();
        let mut writer = audio::ChunkWriter::open(&dir, Channel::Mic).unwrap();
        writer.push(&samples).unwrap();
        writer.finish().unwrap();
        let hint: usize = std::env::var("CODEFLOW_TEST_SPEAKERS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let job = Job {
            dir: dir.clone(),
            vad_model: PathBuf::from(parts[2]),
            embedding_model: PathBuf::from(parts[4]),
            channels: vec![Channel::Mic],
            separate: vec![Channel::Mic],
            transcribe: Some(Transcriber::Local { model: PathBuf::from(parts[1]) }),
            live_lines: Vec::new(),
            language: "es".into(),
            threads: 4,
            vocabulary: "CQRS".into(),
            speakers_hint: hint,
            voices: Vec::new(),
            diarize: true,
        };
        let started = std::time::Instant::now();
        let outcome = run(&job, &Quiet(AtomicBool::new(false))).unwrap();
        eprintln!("{} ms for {} ms of audio", started.elapsed().as_millis(), outcome.duration_ms);
        for line in &outcome.lines {
            eprintln!("[{:>6}–{:>6}] {:>3}: {}", line.start_ms, line.end_ms, line.speaker, line.text);
        }
        for speaker in &outcome.speakers {
            eprintln!("{} {} ms", speaker.key, speaker.talk_ms);
        }
        let text: String = outcome.lines.iter().map(|l| l.text.to_lowercase()).collect::<Vec<_>>().join(" ");
        assert!(text.contains("arquitectura"), "{text}");
        let people: std::collections::HashSet<&str> = outcome.lines.iter().map(|l| l.speaker.as_str()).collect();
        assert!(people.len() >= 2, "{people:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A call, with the real libraries: you on the microphone, the others on the computer's audio,
    /// and the call leaking back into the microphone through the speakers.
    /// `CODEFLOW_TEST_CALL=<whisper lib>|<model>|<silero>|<sherpa lib>|<campplus>|<mic wav>|<system wav>`.
    #[test]
    #[ignore]
    fn a_real_call_keeps_you_and_the_others_apart() {
        let spec = std::env::var("CODEFLOW_TEST_CALL").expect("CODEFLOW_TEST_CALL=…");
        let parts: Vec<&str> = spec.split('|').collect();
        crate::dictation::engine::load_library_for_test(Path::new(parts[0]));
        speaker::load_library_for_test(Path::new(parts[3]));
        let dir = std::env::temp_dir().join(format!("cf-meeting-call-{}", uuid::Uuid::new_v4()));
        for (channel, wav) in [(Channel::Mic, parts[5]), (Channel::System, parts[6])] {
            let mut writer = audio::ChunkWriter::open(&dir, channel).unwrap();
            writer.push(&audio::read_wav(Path::new(wav)).unwrap()).unwrap();
            writer.finish().unwrap();
        }
        let job = Job {
            dir: dir.clone(),
            vad_model: PathBuf::from(parts[2]),
            embedding_model: PathBuf::from(parts[4]),
            channels: vec![Channel::Mic, Channel::System],
            separate: vec![Channel::System],
            transcribe: Some(Transcriber::Local { model: PathBuf::from(parts[1]) }),
            live_lines: Vec::new(),
            language: "es".into(),
            threads: 4,
            vocabulary: "CQRS".into(),
            speakers_hint: std::env::var("CODEFLOW_TEST_SPEAKERS").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
            voices: Vec::new(),
            diarize: true,
        };
        let outcome = run(&job, &Quiet(AtomicBool::new(false))).unwrap();
        for line in &outcome.lines {
            eprintln!("[{:>6}] {:>6} {:>6}: {}", line.start_ms, line.channel.as_str(), line.speaker, line.text);
        }
        let mine: Vec<&Line> = outcome.lines.iter().filter(|l| l.speaker == transcript::ME).collect();
        assert_eq!(mine.len(), 3, "the three turns said into the microphone, and no echo of the call");
        assert!(outcome.lines.iter().filter(|l| l.channel == Channel::System).all(|l| l.speaker.starts_with('p')));
        assert!(outcome.speakers.iter().any(|s| s.key == transcript::ME && s.centroid.is_some()), "a voice to save for «Tú»");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_microphone_hearing_the_call_is_not_the_person_speaking() {
        // Frames 0–49: the call speaks and leaks at a quarter. 50–79: the person speaks, the call is
        // silent. 80–99: both at once — double talk is still the person's.
        let mut mic = vec![0.0f32; 100];
        let mut system = vec![0.0f32; 100];
        for f in 0..50 {
            system[f] = 0.2;
            mic[f] = 0.05;
        }
        for value in mic.iter_mut().take(80).skip(50) {
            *value = 0.15;
        }
        for f in 80..100 {
            system[f] = 0.2;
            mic[f] = 0.2;
        }
        let own = OwnSpeech::from_levels(&mic, &system).unwrap();
        assert!(!own.covers(0, 4_900), "echo only");
        assert!(own.covers(5_000, 7_900), "the person");
        assert!(own.covers(8_000, 9_900), "double talk");
        // With headphones the call never reaches the microphone.
        let quiet = OwnSpeech::from_levels(&vec![0.0; 50].into_iter().chain(vec![0.1; 50]).collect::<Vec<_>>(), &vec![0.2; 50].into_iter().chain(vec![0.0; 50]).collect::<Vec<_>>()).unwrap();
        assert!(quiet.covers(6_000, 8_000));
    }

    #[test]
    fn spans_read_forward_and_overlaps_keep_their_length() {
        let dir = std::env::temp_dir().join(format!("cf-meeting-spans-{}", uuid::Uuid::new_v4()));
        let ramp: Vec<f32> = (0..(audio::RATE as usize * 6)).map(|i| (i as f32 / (audio::RATE as f32 * 6.0)) - 0.5).collect();
        let mut writer = audio::ChunkWriter::open(&dir, Channel::Mic).unwrap();
        writer.push(&ramp).unwrap();
        writer.finish().unwrap();
        let mut reader = SpanReader::new(&dir, Channel::Mic);
        let first = reader.span(1_000, 2_000).unwrap();
        assert_eq!(first.len(), ms_to_samples(1_000));
        assert!((first[0] - ramp[ms_to_samples(1_000)]).abs() < 1e-3);
        let second = reader.span(4_000, 5_000).unwrap();
        assert!((second[0] - ramp[ms_to_samples(4_000)]).abs() < 1e-3);
        // Overlapping the last read: same length, the overlap padded.
        let again = reader.span(4_500, 5_500).unwrap();
        assert_eq!(again.len(), ms_to_samples(1_000));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
