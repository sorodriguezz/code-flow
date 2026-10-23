//! Where people speak: Silero's detector over a channel — whisper.cpp's, or sherpa-onnx's on a
//! machine that listens with Parakeet and has no whisper (2026-10-22) — and the two ways a meeting
//! cuts what it finds: into pieces for the final pass, and into utterances as they end, live.
//!
//! **Never hand whisper a silence.** It does not answer "nothing": it invents. In Spanish the
//! classic is «Subtítulos realizados por la comunidad de Amara.org», a line from the subtitles it was
//! trained on, written into a pause. Every piece whisper sees here is speech the detector found,
//! padded a little so first and last syllables survive.

use std::path::Path;

use crate::dictation::engine::{Vad, VadParams};

use super::audio::{ms_to_samples, samples_to_ms};

/// The longest piece the final pass sends whisper: its window is 30 s, and a piece that fits in one
/// is decoded in one go.
pub const PIECE_MS: i64 = 28_000;
/// Stretches closer than this are one piece: a breath is not a turn.
const JOIN_GAP_MS: i64 = 1_200;

/// The detector a meeting reads with: whisper.cpp's when whisper is installed (what meetings were
/// measured with), else sherpa-onnx's over the same model in ONNX.
pub enum Detector {
    Whisper(Vad),
    Sherpa(crate::codi::vad::Detector),
}

impl Detector {
    /// The stretches of `samples` (16 kHz mono) somebody speaks in, as `(start_ms, end_ms)`.
    pub fn speech(&mut self, samples: &[f32]) -> Result<Vec<(i64, i64)>, String> {
        match self {
            Detector::Whisper(vad) => vad.speech(samples, params()),
            Detector::Sherpa(detector) => Ok(pad(&detector.stretches(samples)?, samples_to_ms(samples.len()))),
        }
    }
}

/// [`params`] read into sherpa's detector, which has no padding of its own ([`pad`] adds it).
const SHERPA_TUNING: crate::codi::vad::Tuning = crate::codi::vad::Tuning { threshold: 0.5, min_silence_s: 0.5, min_speech_s: 0.25, max_speech_s: PIECE_MS as f32 / 1000.0, buffer_s: 60.0 };
/// whisper's `speech_pad_ms`: so the first and last syllables survive.
const PAD_MS: i64 = 120;

/// `stretches` widened by [`PAD_MS`] on each side, within `0..total_ms`, those that come to touch
/// joined.
fn pad(stretches: &[(i64, i64)], total_ms: i64) -> Vec<(i64, i64)> {
    let mut out: Vec<(i64, i64)> = Vec::new();
    for &(start, end) in stretches {
        let (start, end) = ((start - PAD_MS).max(0), (end + PAD_MS).min(total_ms));
        match out.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

/// Whether a meeting can find speech on this machine: whisper.cpp with its model, or sherpa-onnx
/// (the model is fetched on the way into a meeting).
pub fn available() -> bool {
    crate::dictation::engine_library().is_some() || crate::meetings::sherpa_library().is_some()
}

/// The detector, whisper's (`path`, its model) when whisper is installed, else sherpa's.
pub fn load(path: &Path, threads: i32) -> Result<Detector, String> {
    if crate::dictation::engine_library().is_some() && path.is_file() {
        return Vad::load(path, threads.min(2)).map(Detector::Whisper);
    }
    let onnx = crate::codi::vad::model_path();
    if crate::meetings::sherpa_library().is_some() && onnx.is_file() {
        return crate::codi::vad::Detector::tuned(&onnx, SHERPA_TUNING).map(Detector::Sherpa);
    }
    Err("The voice detector is not installed — Settings › Voice & sound › Meetings".into())
}

/// The parameters a meeting uses: a pause of half a second ends speech; a stretch never runs past
/// [`PIECE_MS`].
pub fn params() -> VadParams {
    VadParams { max_speech_duration_s: PIECE_MS as f32 / 1000.0, ..VadParams::default() }
}

/// Speech stretches joined into pieces whisper reads whole: neighbours closer than [`JOIN_GAP_MS`]
/// merge while the result stays within `max_ms`.
pub fn join(stretches: &[(i64, i64)], max_ms: i64) -> Vec<(i64, i64)> {
    join_within(stretches, max_ms, JOIN_GAP_MS)
}

/// [`join`] with its own gap: neighbours closer than `gap_ms` merge.
pub fn join_within(stretches: &[(i64, i64)], max_ms: i64, gap_ms: i64) -> Vec<(i64, i64)> {
    let mut pieces: Vec<(i64, i64)> = Vec::new();
    for &(start, end) in stretches {
        if let Some(last) = pieces.last_mut() {
            if start - last.1 < gap_ms && end - last.0 <= max_ms {
                last.1 = last.1.max(end);
                continue;
            }
        }
        pieces.push((start, end));
    }
    pieces
}

/// Cuts a live channel into utterances as they end.
///
/// Audio arrives in small blocks; once at least [`STEP_MS`] has come in, the detector looks at what
/// is pending. A stretch of speech that is followed by enough silence before the end of the pending
/// audio is finished: it is handed out and the audio up to it dropped. Speech that runs on is cut
/// at [`PIECE_MS`] — someone talking for a minute without a pause still gets text every half
/// minute. Silence that has gone on for a while is dropped without a word, so the pending buffer
/// stays small however long nobody speaks.
pub struct Cutter {
    /// Samples not yet given out, starting at `offset` on the channel's timeline.
    pending: Vec<f32>,
    offset: usize,
    since_look: usize,
}

/// How much new audio makes the detector look again.
pub const STEP_MS: i64 = 1_000;
/// Silence after speech that finishes an utterance live — longer than the detector's own half
/// second, so a short pause mid-sentence does not cut it.
const END_SILENCE_MS: i64 = 700;

/// One finished utterance: its samples and where they sit on the channel's timeline.
#[derive(Debug, Clone)]
pub struct Utterance {
    pub start_ms: i64,
    pub end_ms: i64,
    pub samples: Vec<f32>,
}

impl Default for Cutter {
    fn default() -> Self {
        Self::new()
    }
}

impl Cutter {
    pub fn new() -> Self {
        Cutter { pending: Vec::new(), offset: 0, since_look: 0 }
    }

    /// Where the channel's timeline is up to.
    pub fn heard_ms(&self) -> i64 {
        samples_to_ms(self.offset + self.pending.len())
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
        self.since_look += samples.len();
    }

    /// Whether enough has arrived to look again.
    pub fn due(&self) -> bool {
        self.since_look >= ms_to_samples(STEP_MS)
    }

    /// Finished utterances, judged by `detect` (the detector, or a stand-in in tests). `flush` hands
    /// out whatever speech is pending — the recording has stopped.
    pub fn cut(&mut self, detect: &mut dyn FnMut(&[f32]) -> Result<Vec<(i64, i64)>, String>, flush: bool) -> Result<Vec<Utterance>, String> {
        self.since_look = 0;
        if self.pending.is_empty() {
            return Ok(Vec::new());
        }
        let stretches = detect(&self.pending)?;
        let pending_ms = samples_to_ms(self.pending.len());
        let mut out = Vec::new();
        let mut consumed_ms = 0i64;
        // Live, a pause that ends an utterance ends its line: only a breath shorter than that keeps
        // two stretches together. (The final pass joins more, for whisper's sake, and separates
        // the voices afterwards; here the line is what the reader sees appear.)
        for (start, end) in join_within(&stretches, PIECE_MS, END_SILENCE_MS) {
            let finished = flush || pending_ms - end >= END_SILENCE_MS || end - start >= PIECE_MS;
            if !finished {
                break;
            }
            let from = ms_to_samples(start).min(self.pending.len());
            let to = ms_to_samples(end).min(self.pending.len());
            if to > from {
                out.push(Utterance {
                    start_ms: samples_to_ms(self.offset) + start,
                    end_ms: samples_to_ms(self.offset) + end,
                    samples: self.pending[from..to].to_vec(),
                });
            }
            consumed_ms = end;
        }
        if out.is_empty() && stretches.is_empty() && !flush {
            // Nothing but silence: keep the last second, in case speech is just starting.
            consumed_ms = (pending_ms - 1_000).max(0);
        }
        if flush {
            consumed_ms = pending_ms;
        }
        let drop = ms_to_samples(consumed_ms).min(self.pending.len());
        self.pending.drain(..drop);
        self.offset += drop;
        Ok(out)
    }
}

/// The speech stretches of a whole channel, read a window at a time so a two-hour channel never
/// sits in memory whole. Windows overlap by a few seconds and stretches are stitched across them.
pub fn channel_speech(vad: &mut Detector, meeting: &Path, channel: super::audio::Channel, mut progress: impl FnMut(f32)) -> Result<Vec<(i64, i64)>, String> {
    const WINDOW_MS: i64 = 300_000;
    let total = super::audio::channel_ms(meeting, channel).max(1);
    let mut reader = super::audio::ChannelReader::open(meeting, channel);
    let mut found: Vec<(i64, i64)> = Vec::new();
    loop {
        let base = samples_to_ms(reader.position);
        let block = reader.read(ms_to_samples(WINDOW_MS))?;
        if block.is_empty() {
            break;
        }
        for (start, end) in vad.speech(&block)? {
            let (start, end) = (base + start, base + end);
            match found.last_mut() {
                // A stretch cut by the window's edge continues in the next one.
                Some(last) if start - last.1 <= 300 => last.1 = last.1.max(end),
                _ => found.push((start, end)),
            }
        }
        progress((samples_to_ms(reader.position) as f32 / total as f32).min(1.0));
    }
    Ok(found)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sherpas_stretches_are_padded_like_whispers() {
        assert_eq!(pad(&[(50, 1_000), (1_150, 2_000), (5_000, 9_950)], 10_000), vec![(0, 2_120), (4_880, 10_000)]);
        assert!(pad(&[], 1_000).is_empty());
    }

    #[test]
    fn neighbours_join_until_a_piece_is_full() {
        let joined = join(&[(0, 5_000), (5_800, 9_000), (20_000, 21_000)], PIECE_MS);
        assert_eq!(joined, vec![(0, 9_000), (20_000, 21_000)]);
        let capped = join(&[(0, 20_000), (20_500, 30_000)], PIECE_MS);
        assert_eq!(capped, vec![(0, 20_000), (20_500, 30_000)]);
    }

    /// A stand-in detector: speech wherever the samples are loud, in 100 ms steps.
    fn loud(samples: &[f32]) -> Result<Vec<(i64, i64)>, String> {
        let step = ms_to_samples(100);
        let mut out: Vec<(i64, i64)> = Vec::new();
        for (index, block) in samples.chunks(step).enumerate() {
            if super::super::audio::rms(block) > 0.1 {
                let (start, end) = (index as i64 * 100, index as i64 * 100 + 100);
                match out.last_mut() {
                    Some(last) if last.1 == start => last.1 = end,
                    _ => out.push((start, end)),
                }
            }
        }
        Ok(out)
    }

    #[test]
    fn the_cutter_waits_for_the_pause_and_keeps_the_timeline() {
        let mut cutter = Cutter::new();
        let silence = vec![0.0f32; ms_to_samples(3_000)];
        let speech = vec![0.5f32; ms_to_samples(2_000)];
        cutter.push(&silence);
        assert!(cutter.cut(&mut loud, false).unwrap().is_empty());
        cutter.push(&speech);
        // Speech runs to the end of what is pending: not finished yet.
        assert!(cutter.cut(&mut loud, false).unwrap().is_empty());
        cutter.push(&vec![0.0f32; ms_to_samples(1_000)]);
        let done = cutter.cut(&mut loud, false).unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].start_ms, done[0].end_ms), (3_000, 5_000));
        assert_eq!(done[0].samples.len(), ms_to_samples(2_000));
        // What was said later lands later on the same timeline, and a stop flushes it.
        cutter.push(&speech);
        let flushed = cutter.cut(&mut loud, true).unwrap();
        assert_eq!(flushed.len(), 1);
        assert_eq!(flushed[0].start_ms, 6_000);
        assert_eq!(cutter.heard_ms(), 8_000);
    }

    #[test]
    fn a_long_monologue_is_cut_at_the_piece_limit() {
        let mut cutter = Cutter::new();
        cutter.push(&vec![0.5f32; ms_to_samples(PIECE_MS + 2_000)]);
        let stretches = |samples: &[f32]| -> Result<Vec<(i64, i64)>, String> {
            // The detector itself caps a stretch at the piece limit.
            let total = samples_to_ms(samples.len());
            Ok(vec![(0, PIECE_MS.min(total)), (PIECE_MS, total)])
        };
        let mut detect = stretches;
        let done = cutter.cut(&mut detect, false).unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].end_ms, PIECE_MS);
    }
}
