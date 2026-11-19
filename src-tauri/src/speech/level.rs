//! Every piece of an utterance at the same loudness, with the same edges.
//!
//! A natural voice writes each sentence on its own and each comes out as loud as it happens to — a
//! question softer, a short line louder — and the computer's voice, a service's and a downloaded
//! one are not as loud as each other either. Each piece is brought to [`TARGET_RMS`], measured over
//! the stretches where the voice is speaking (not the silence around it), with a soft limit on its
//! peaks. Its own silence at either end is trimmed — the pause after it is the app's
//! ([`super::segments`]) — and it fades in and out over a few milliseconds so no edge clicks.
//!
//! **The pauses inside a piece are the app's too** ([`fit_pauses`]). A piece is said whole, so the
//! voice keeps its intonation across a comma or a short sentence; afterwards each silence it left
//! where the text has a mark ([`super::segments::marks`]) is stretched or shortened to that mark's
//! length, and a long silence where the text has none is cut down. A mark with no silence near it
//! is left as the voice said it — never worse than before.

/// ≈ −20 dBFS: a voice's usual level, with room for its peaks.
pub const TARGET_RMS: f32 = 0.1;
/// How far a piece may be turned up or down: a near-silent one is not blown up into noise.
const MIN_GAIN: f32 = 0.25;
const MAX_GAIN: f32 = 6.0;
/// Above this, peaks are rounded off rather than clipped.
const KNEE: f32 = 0.85;
/// The measure's step.
const FRAME_MS: u32 = 20;
/// Kept of the silence at each end, so a word's first and last sounds are not cut.
const MARGIN_MS: u32 = 40;
const FADE_MS: u32 = 8;
/// A piece shorter than this is measured less surely: its gain leans on the last piece's.
const SURE_MS: f32 = 1_000.0;

/// The measure's step for silences: fine enough to find a comma's.
const GAP_FRAME_MS: u32 = 10;
/// Shorter than this, a quiet stretch is a consonant (a «t» or a «p» closing), not a pause.
const MIN_GAP_MS: u32 = 70;
/// Quieter than this against the piece's voiced loudness (≈ −24 dB) is silence.
const GAP_LEVEL: f32 = 0.06;
/// How far (in the piece's length, 0–1) a silence may be from where its mark falls.
const MATCH_TOLERANCE: f32 = 0.15;
/// A silence where the text has no mark is held to this: the voice stopping mid-phrase.
const MAX_UNMARKED_MS: u32 = 180;

/// A quiet stretch inside a piece, in samples.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Gap {
    start: usize,
    end: usize,
}

/// The silences inside `samples` — not the ones at either end — of at least [`MIN_GAP_MS`].
fn gaps(samples: &[f32], rate: u32) -> Vec<Gap> {
    let Some(voiced) = voiced_rms(samples, rate) else { return Vec::new() };
    let frame = ((rate * GAP_FRAME_MS) / 1000).max(1) as usize;
    let quiet: Vec<bool> =
        samples.chunks(frame).map(|chunk| (chunk.iter().map(|v| v * v).sum::<f32>() / chunk.len() as f32).sqrt() < voiced * GAP_LEVEL).collect();
    let min_frames = (MIN_GAP_MS / GAP_FRAME_MS) as usize;
    let mut out = Vec::new();
    let mut run_start: Option<usize> = None;
    for (i, &is_quiet) in quiet.iter().chain(std::iter::once(&false)).enumerate() {
        match (is_quiet, run_start) {
            (true, None) => run_start = Some(i),
            (false, Some(first)) => {
                // One that touches either end is the piece's own edge, which the trim handles.
                if first > 0 && i < quiet.len() && i - first >= min_frames {
                    out.push(Gap { start: first * frame, end: (i * frame).min(samples.len()) });
                }
                run_start = None;
            }
            _ => {}
        }
    }
    out
}

/// Each silence of `samples` that falls near one of `marks` set to that mark's pause (at speech
/// rate `rate_factor`); a long one with no mark held to [`MAX_UNMARKED_MS`]. In place.
pub fn fit_pauses(samples: &mut Vec<f32>, rate: u32, marks: &[super::segments::Mark], rate_factor: f32) {
    let found = gaps(samples, rate);
    if found.is_empty() {
        return;
    }
    // Where the voice is: from its first sound to its last, so the silence at the ends does not
    // shift every position.
    let floor = samples.iter().fold(0.0f32, |held, v| held.max(v.abs())) * 0.02;
    let first = samples.iter().position(|v| v.abs() > floor).unwrap_or(0);
    let last = samples.iter().rposition(|v| v.abs() > floor).unwrap_or(samples.len().saturating_sub(1));
    let span = (last.saturating_sub(first)).max(1) as f32;
    let position = |gap: &Gap| ((gap.start + gap.end) / 2).saturating_sub(first) as f32 / span;
    let ms = |pause_ms: u32| ((u64::from(rate) * u64::from(pause_ms)) as f32 / 1000.0 / rate_factor.clamp(0.6, 1.8)) as usize;
    // In order: each mark takes the nearest silence after the last one taken.
    let mut targets: Vec<Option<usize>> = vec![None; found.len()];
    let mut next = 0usize;
    for mark in marks {
        // The nearest, a longer silence counting as a little nearer: a pause, not a consonant.
        let best = (next..found.len())
            .map(|i| {
                let distance = (position(&found[i]) - mark.at).abs();
                let length_ms = (found[i].end - found[i].start) as f32 * 1000.0 / rate as f32;
                (i, distance, distance - 0.05 * (length_ms / 300.0).min(1.0))
            })
            .filter(|(_, distance, _)| *distance <= MATCH_TOLERANCE)
            .min_by(|a, b| a.2.total_cmp(&b.2));
        if let Some((i, _, _)) = best {
            targets[i] = Some(ms(mark.pause_ms));
            next = i + 1;
        }
    }
    let unmarked_max = ms(MAX_UNMARKED_MS);
    // From the end, so the earlier positions still hold.
    for (gap, target) in found.iter().zip(targets).rev() {
        let length = gap.end - gap.start;
        let wanted = match target {
            Some(wanted) => wanted,
            None if length > unmarked_max => unmarked_max,
            None => continue,
        };
        let middle = gap.start + length / 2;
        if wanted < length {
            let cut = length - wanted;
            samples.drain(middle - cut / 2..middle - cut / 2 + cut);
        } else if wanted > length {
            samples.splice(middle..middle, std::iter::repeat_n(0.0, wanted - length));
        }
    }
}

/// The gain of the pieces so far, so a short piece is not swung far from its neighbours.
#[derive(Debug, Default)]
pub struct Leveler {
    gain: Option<f32>,
}

impl Leveler {
    /// `samples` (mono, at `rate`) trimmed, evened out and faded, in place.
    pub fn process(&mut self, samples: &mut Vec<f32>, rate: u32) {
        trim(samples, rate);
        let Some(loudness) = voiced_rms(samples, rate) else { return };
        let wanted = (TARGET_RMS / loudness).clamp(MIN_GAIN, MAX_GAIN);
        let seconds_sure = (samples.len() as f32 * 1000.0 / rate.max(1) as f32 / SURE_MS).min(1.0);
        let gain = match self.gain {
            Some(before) => before + (wanted - before) * seconds_sure,
            None => wanted,
        };
        self.gain = Some(gain);
        for sample in samples.iter_mut() {
            *sample = limit(*sample * gain);
        }
        fade(samples, rate);
    }
}

/// The loudness of the frames where the voice is speaking: those within 30 dB of the loudest.
/// `None` for silence.
pub fn voiced_rms(samples: &[f32], rate: u32) -> Option<f32> {
    let frame = ((rate * FRAME_MS) / 1000).max(1) as usize;
    let frames: Vec<f32> = samples.chunks(frame).map(|chunk| chunk.iter().map(|v| v * v).sum::<f32>() / chunk.len() as f32).collect();
    let loudest = frames.iter().copied().fold(0.0f32, f32::max);
    if loudest < 1e-8 {
        return None;
    }
    let gate = loudest * 1e-3;
    let voiced: Vec<f32> = frames.into_iter().filter(|power| *power >= gate).collect();
    Some((voiced.iter().sum::<f32>() / voiced.len() as f32).sqrt())
}

/// A sample past [`KNEE`] bent towards 1 instead of clipped.
fn limit(sample: f32) -> f32 {
    let magnitude = sample.abs();
    if magnitude <= KNEE {
        return sample;
    }
    let room = 1.0 - KNEE;
    (KNEE + room * ((magnitude - KNEE) / room).tanh()).copysign(sample)
}

/// The silence at either end cut to [`MARGIN_MS`].
fn trim(samples: &mut Vec<f32>, rate: u32) {
    let peak = samples.iter().fold(0.0f32, |held, v| held.max(v.abs()));
    if peak < 1e-4 {
        return;
    }
    let floor = (peak * 0.02).max(0.002);
    let margin = ((rate * MARGIN_MS) / 1000) as usize;
    let Some(first) = samples.iter().position(|v| v.abs() >= floor) else { return };
    let last = samples.iter().rposition(|v| v.abs() >= floor).unwrap_or(samples.len() - 1);
    let end = (last + margin + 1).min(samples.len());
    samples.truncate(end);
    samples.drain(..first.saturating_sub(margin));
}

fn fade(samples: &mut [f32], rate: u32) {
    let length = (((rate * FADE_MS) / 1000) as usize).min(samples.len() / 2);
    for i in 0..length {
        let scale = i as f32 / length as f32;
        samples[i] *= scale;
        let end = samples.len() - 1 - i;
        samples[end] *= scale;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16_000;

    /// `seconds` of a tone at `amplitude`, with `pad` seconds of silence either side.
    fn tone(amplitude: f32, seconds: f32, pad: f32) -> Vec<f32> {
        let silence = vec![0.0; (RATE as f32 * pad) as usize];
        let voice = (0..(RATE as f32 * seconds) as usize).map(|i| amplitude * (i as f32 * 0.07).sin());
        silence.iter().copied().chain(voice).chain(silence.iter().copied()).collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|v| v * v).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn a_soft_piece_and_a_loud_one_come_out_alike() {
        let mut leveler = Leveler::default();
        let mut soft = tone(0.05, 1.5, 0.0);
        let mut loud = tone(0.5, 1.5, 0.0);
        leveler.process(&mut soft, RATE);
        leveler.process(&mut loud, RATE);
        let (soft, loud) = (rms(&soft), rms(&loud));
        assert!((soft - loud).abs() / loud < 0.1, "{soft} vs {loud}");
        assert!((soft - TARGET_RMS).abs() < 0.02, "{soft}");
    }

    #[test]
    fn silence_around_a_piece_is_trimmed_and_does_not_count() {
        let mut leveler = Leveler::default();
        let mut padded = tone(0.05, 1.5, 0.5);
        leveler.process(&mut padded, RATE);
        let expected = (RATE as f32 * 1.5) as usize + 2 * (RATE * MARGIN_MS / 1000) as usize;
        assert!(padded.len().abs_diff(expected) < 200, "{} vs {expected}", padded.len());
        assert!((rms(&padded) - TARGET_RMS).abs() < 0.02, "{}", rms(&padded));
    }

    #[test]
    fn peaks_never_pass_full_scale_and_edges_start_silent() {
        let mut leveler = Leveler::default();
        let mut spiky = tone(0.05, 1.5, 0.0);
        spiky[8_000] = 0.9;
        leveler.process(&mut spiky, RATE);
        assert!(spiky.iter().all(|v| v.abs() <= 1.0));
        assert_eq!(spiky[0], 0.0);
        assert_eq!(*spiky.last().unwrap(), 0.0);
    }

    /// Voice, `gap` seconds of silence, voice.
    fn two_words(gap: f32) -> Vec<f32> {
        let mut samples = tone(0.3, 0.6, 0.0);
        samples.extend(vec![0.0; (RATE as f32 * gap) as usize]);
        samples.extend(tone(0.3, 0.6, 0.0));
        samples
    }

    fn mark(at: f32, pause_ms: u32) -> super::super::segments::Mark {
        super::super::segments::Mark { at, pause_ms }
    }

    #[test]
    fn a_silence_at_a_mark_takes_the_marks_length() {
        // A comma the voice hardly paused at is lengthened…
        let mut short = two_words(0.08);
        fit_pauses(&mut short, RATE, &[mark(0.5, 150)], 1.0);
        let gap = gaps(&short, RATE);
        assert_eq!(gap.len(), 1);
        let ms = (gap[0].end - gap[0].start) as u32 * 1000 / RATE;
        assert!((140..=170).contains(&ms), "{ms} ms");
        // …and a sentence end it lingered at is shortened.
        let mut long = two_words(0.8);
        fit_pauses(&mut long, RATE, &[mark(0.5, 300)], 1.0);
        let gap = gaps(&long, RATE);
        let ms = (gap[0].end - gap[0].start) as u32 * 1000 / RATE;
        assert!((290..=320).contains(&ms), "{ms} ms");
    }

    #[test]
    fn a_long_silence_with_no_mark_is_cut_down_and_a_far_mark_is_ignored() {
        let mut stray = two_words(0.6);
        fit_pauses(&mut stray, RATE, &[], 1.0);
        let ms = gaps(&stray, RATE).first().map(|gap| (gap.end - gap.start) as u32 * 1000 / RATE).unwrap();
        assert!(ms <= MAX_UNMARKED_MS + 10, "{ms} ms");
        // A mark far from any silence: the short silence stays as it was.
        let mut untouched = two_words(0.1);
        let before = untouched.len();
        fit_pauses(&mut untouched, RATE, &[mark(0.95, 300)], 1.0);
        assert_eq!(untouched.len(), before);
    }

    /// The computer's own voice, its pauses set by the marks: on macOS, `CODEFLOW_TEST_VOICE=1`.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn the_system_voice_gets_the_apps_pauses() {
        if std::env::var("CODEFLOW_TEST_VOICE").is_err() {
            return;
        }
        let text = "Abre el panel de pipelines, elige uno y ejecútalo. Luego revisa el resultado, con calma.";
        let (mut samples, rate) = super::super::system::synthesize(text, "Paulina", 1.0).unwrap();
        let marks = super::super::segments::marks(text);
        fit_pauses(&mut samples, rate, &marks, 1.0);
        let found: Vec<u32> = gaps(&samples, rate).iter().map(|gap| (gap.end - gap.start) as u32 * 1000 / rate).collect();
        eprintln!("marks {marks:?}\ngaps (ms) {found:?}");
        assert!(found.iter().any(|ms| (130..=175).contains(ms)), "{found:?}");
        assert!(found.iter().any(|ms| (280..=325).contains(ms)), "{found:?}");
    }

    #[test]
    fn silence_is_left_alone() {
        let mut leveler = Leveler::default();
        let mut quiet = vec![0.0; 1_000];
        leveler.process(&mut quiet, RATE);
        assert!(quiet.iter().all(|v| *v == 0.0));
    }
}
