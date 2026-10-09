//! Playing samples on the speaker the user chose — «Voz y sonido › Dispositivos › Altavoz».
//!
//! The webview can only play on the system's default output (WebKit has no `setSinkId`), so
//! anything that has to come out of a chosen speaker is played here: the reading voice always, and a
//! notification's tone when a speaker other than the default is picked. One output stream per
//! playback, opened on the thread that plays it (a cpal stream is not `Send` everywhere) and closed
//! when it ends — a voice speaks for seconds at a time, and holding an output open in between would
//! keep a Bluetooth headset from sleeping.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;

/// The setting holding the chosen output's id: cpal's `host:device` string, `""` for the default.
pub const DEVICE_KEY: &str = "audio_output_device";

/// One output, for Settings' picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Every output the system offers right now, the default flagged.
pub fn outputs() -> Vec<OutputDevice> {
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|device| device.id().ok()).map(|id| id.to_string());
    let Ok(devices) = host.output_devices() else { return Vec::new() };
    devices
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            let name = device.description().map(|about| about.name().to_string()).unwrap_or_else(|_| id.clone());
            Some(OutputDevice { is_default: default.as_deref() == Some(id.as_str()), id, name })
        })
        .collect()
}

/// The output `id` names, or the default — for `""`, and for a chosen one that is unplugged right
/// now: the choice stays saved, and sounding on the default beats sounding nowhere.
fn device(id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if !id.is_empty() {
        if let Some(device) = id.parse::<cpal::DeviceId>().ok().and_then(|parsed| host.device_by_id(&parsed)) {
            return Ok(device);
        }
    }
    host.default_output_device().ok_or_else(|| "There is no speaker to play on".to_string())
}

/// What the callback reads from: the samples at the output's rate, and how far it got.
struct Cursor {
    samples: Vec<f32>,
    at: usize,
}

/// Plays `samples` (mono, at `rate`) on output `device_id` at `volume` (0–1), until they end or
/// `keep_going` says otherwise. Blocks for the length of the sound.
pub fn play(device_id: &str, samples: &[f32], rate: u32, volume: f32, keep_going: &dyn Fn() -> bool) -> Result<(), String> {
    if samples.is_empty() {
        return Ok(());
    }
    let device = device(device_id)?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    let out_rate = config.sample_rate;
    let channels = usize::from(config.channels.max(1));
    let volume = volume.clamp(0.0, 1.0);
    let cursor = Arc::new(Mutex::new(Cursor { samples: resample(samples, rate, out_rate).into_iter().map(|v| v * volume).collect(), at: 0 }));
    let finished = Arc::new(AtomicBool::new(false));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::I16 => build::<i16>(&device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::U16 => build::<u16>(&device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::I32 => build::<i32>(&device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::F64 => build::<f64>(&device, config, channels, cursor.clone(), finished.clone()),
        other => Err(format!("The speaker takes {other:?} samples, which CodeFlow cannot write")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    let length = Duration::from_secs_f64(samples.len() as f64 / f64::from(rate.max(1)));
    // A device that stalls never reports the end: give up a second past the sound's own length.
    let deadline = Instant::now() + length + Duration::from_secs(1);
    while !finished.load(Ordering::SeqCst) && Instant::now() < deadline {
        if !keep_going() {
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    // The device's own buffer still holds the last few milliseconds.
    if finished.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(60));
    }
    drop(stream);
    Ok(())
}

fn build<T>(device: &cpal::Device, config: cpal::StreamConfig, channels: usize, cursor: Arc<Mutex<Cursor>>, finished: Arc<AtomicBool>) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _| {
                let mut cursor = cursor.lock().unwrap_or_else(|p| p.into_inner());
                for frame in data.chunks_mut(channels) {
                    let value = if cursor.at < cursor.samples.len() {
                        let v = cursor.samples[cursor.at];
                        cursor.at += 1;
                        v
                    } else {
                        finished.store(true, Ordering::SeqCst);
                        0.0
                    };
                    for slot in frame {
                        *slot = T::from_sample(value);
                    }
                }
            },
            |error| crate::applog::warn(&format!("speech: speaker: {error}")),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Linear interpolation from `from` to `to` Hz — plenty for a voice and a chime.
pub fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || from == 0 || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = f64::from(from) / f64::from(to);
    let length = ((samples.len() as f64) / ratio).floor() as usize;
    (0..length)
        .map(|i| {
            let position = i as f64 * ratio;
            let index = position.floor() as usize;
            let next = samples.get(index + 1).copied().unwrap_or(samples[index.min(samples.len() - 1)]);
            let here = samples[index.min(samples.len() - 1)];
            here + (next - here) * (position - index as f64) as f32
        })
        .collect()
}

/// How loud the sound is every `step_ms`, 0–1 against its own loudest step — what the thinking mark
/// moves by while it speaks.
pub fn envelope(samples: &[f32], rate: u32, step_ms: u32) -> Vec<f32> {
    let step = ((rate as usize * step_ms as usize) / 1000).max(1);
    let levels: Vec<f32> = samples.chunks(step).map(|chunk| (chunk.iter().map(|v| v * v).sum::<f32>() / chunk.len() as f32).sqrt()).collect();
    let peak = levels.iter().copied().fold(0.0f32, f32::max);
    if peak <= f32::EPSILON {
        return vec![0.0; levels.len()];
    }
    levels.iter().map(|level| (level / peak).clamp(0.0, 1.0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_keeps_the_length_in_time() {
        let second: Vec<f32> = (0..22_050).map(|i| (i as f32 / 22_050.0).sin()).collect();
        assert_eq!(resample(&second, 22_050, 48_000).len(), 48_000);
        assert_eq!(resample(&second, 22_050, 22_050).len(), 22_050);
        assert!(resample(&[], 22_050, 48_000).is_empty());
    }

    /// The real default output, fed silence so nothing is heard: `CODEFLOW_TEST_PLAY=1`. It plays
    /// for the sound's length, and stops early when told.
    #[test]
    #[ignore]
    fn plays_on_the_default_output_and_stops_when_told() {
        if std::env::var("CODEFLOW_TEST_PLAY").is_err() {
            return;
        }
        assert!(!outputs().is_empty());
        let silence = vec![0.0f32; 22_050 / 2];
        let started = Instant::now();
        play("", &silence, 22_050, 0.0, &|| true).unwrap();
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(400) && took < Duration::from_millis(1_500), "{took:?}");
        let long = vec![0.0f32; 22_050 * 5];
        let started = Instant::now();
        let deadline = started + Duration::from_millis(300);
        play("", &long, 22_050, 0.0, &|| Instant::now() < deadline).unwrap();
        assert!(started.elapsed() < Duration::from_millis(1_000), "{:?}", started.elapsed());
    }

    #[test]
    fn the_envelope_is_relative_to_the_loudest_step() {
        let mut samples = vec![0.0f32; 1_000];
        samples.extend(vec![0.5f32; 1_000]);
        let levels = envelope(&samples, 1_000, 1_000);
        assert_eq!(levels, vec![0.0, 1.0]);
        assert_eq!(envelope(&[0.0; 10], 1_000, 5), vec![0.0, 0.0]);
    }
}
