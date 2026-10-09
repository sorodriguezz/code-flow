//! «Medir este equipo»: how long whisper takes here for one utterance, per installed model — what
//! «Automático» picks a mode from.
//!
//! **An utterance, not a second of audio.** whisper's encoder always works on a 30-second window, so
//! a five-second utterance costs nearly what thirty seconds do. The live text keeps up when one
//! utterance is transcribed faster than people produce the next; that is the number measured here,
//! on a synthetic five-second clip (a voiced, syllable-paced signal — the encoder's cost does not
//! depend on the words), after one warm-up run that loads the model.

use std::sync::atomic::AtomicBool;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::dictation::engine::{self, Options};
use crate::dictation::{model_path, MODELS};

use super::audio::RATE;

/// An utterance this fast keeps up comfortably beside a call (people rarely finish a sentence a
/// second apart).
const COMFORTABLE_MS: u64 = 1_500;
/// The slowest that still keeps up, with the call's own load on the machine.
const KEEPS_UP_MS: u64 = 2_600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub measured_at: String,
    pub threads: i32,
    /// Milliseconds per five-second utterance, by model id.
    pub per_utterance_ms: Vec<(String, u64)>,
    /// `light` · `balanced` · `full`.
    pub recommended: String,
    /// The model the live text should use.
    pub live_model: String,
}

fn clip(seconds: usize) -> Vec<f32> {
    (0..RATE as usize * seconds)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let syllables = (t * 4.0 * std::f32::consts::TAU).sin().max(0.0);
            let voice: f32 = [140.0f32, 280.0, 560.0, 1_100.0].iter().map(|hz| (t * hz * std::f32::consts::TAU).sin()).sum::<f32>() / 4.0;
            voice * syllables * 0.3
        })
        .collect()
}

/// Measures every installed model up to `small` (turbo is never a live model).
pub fn measure(threads: i32) -> Result<Measured, String> {
    super::lower_priority();
    let abort = AtomicBool::new(false);
    let utterance = clip(5);
    let mut per = Vec::new();
    for model in MODELS.iter().filter(|m| m.id != "turbo") {
        let path = model_path(model);
        if !path.is_file() {
            continue;
        }
        let options = Options { language: "es".into(), threads, ..Options::default() };
        engine::segments(&engine::MEETINGS, &path, &clip(1), &options, &abort)?;
        let started = Instant::now();
        engine::segments(&engine::MEETINGS, &path, &utterance, &options, &abort)?;
        per.push((model.id.to_string(), started.elapsed().as_millis() as u64));
    }
    engine::unload_slot(&engine::MEETINGS);
    if per.is_empty() {
        return Err("Download a Whisper model first — Settings › Voice & sound › Models".into());
    }
    let (recommended, live_model) = recommend(&per);
    Ok(Measured { measured_at: chrono::Utc::now().to_rfc3339(), threads, per_utterance_ms: per, recommended: recommended.into(), live_model })
}

/// The mode and live model a measurement points to.
pub fn recommend(per: &[(String, u64)]) -> (&'static str, String) {
    let time = |id: &str| per.iter().find(|(m, _)| m == id).map(|(_, ms)| *ms);
    if time("small").is_some_and(|ms| ms <= COMFORTABLE_MS) {
        return ("full", "small".into());
    }
    for id in ["small", "base", "tiny"] {
        if time(id).is_some_and(|ms| ms <= KEEPS_UP_MS) {
            return ("balanced", id.into());
        }
    }
    ("light", per.first().map(|(id, _)| id.clone()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fast_machine_gets_everything_and_a_slow_one_records_first() {
        let fast = vec![("base".to_string(), 300), ("small".to_string(), 900)];
        assert_eq!(recommend(&fast), ("full", "small".into()));
        let middling = vec![("tiny".to_string(), 1_200), ("base".to_string(), 2_100), ("small".to_string(), 5_000)];
        assert_eq!(recommend(&middling), ("balanced", "base".into()));
        let slow = vec![("tiny".to_string(), 4_000)];
        assert_eq!(recommend(&slow).0, "light");
    }
}
