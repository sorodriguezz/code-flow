//! The microphone, read here rather than in the webview.
//!
//! It used to be captured with `getUserMedia`, and that put the webview between the user and their
//! microphone: WebView2 answers it with its own browser prompt ("… wants to use your microphone",
//! Allow / Block) — wry only auto-allows the clipboard — and a webview's device list carries no
//! names until that prompt has been answered, so Settings could not offer a choice of input. Read
//! through the system's own audio API (CoreAudio, WASAPI — via cpal) the only question left is the
//! operating system's (`super::permission`), and every input is listed by name up front.
//!
//! **One capture at a time, app-wide** (`commands::dictation_cmd` holds it): the samples stay here,
//! and the webview only ever sees the level, for its waveform, and the text.
//!
//! The stream lives on a thread of its own, which owns it from open to close — a cpal stream is not
//! `Send` on every host — and wakes every [`TICK`] to hand the levels the audio callback measured to
//! `on_level`, so nothing that talks to the webview runs on the system's audio thread.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;

/// What whisper listens at.
pub const TARGET_RATE: u32 = 16_000;
/// Recordings stop growing here — about 10 MB of audio at 16 kHz, and minutes of transcription.
pub const MAX_SECONDS: usize = 300;
/// The error a refused microphone answers with — the frontend's cue to offer the system's privacy
/// settings rather than a sentence about where they are.
pub const DENIED: &str = "MIC_DENIED";
/// The error when there is no input at all.
pub const NONE: &str = "MIC_NONE";

/// How often the levels reach the webview. One level per callback buffer, as the webview's own
/// `ScriptProcessor` drew them (2048 frames at 48 kHz ≈ 43 ms), so the waveform moves as it did.
const TICK: Duration = Duration::from_millis(40);
const LEVEL_SECONDS: f32 = 0.043;

/// One input, for Settings' picker. `id` is cpal's stable `host:device` string — what the
/// `dictation_device` setting stores.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Every input the system offers right now, the default flagged.
pub fn inputs() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|device| device.id().ok()).map(|id| id.to_string());
    let Ok(devices) = host.input_devices() else { return Vec::new() };
    devices
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            let name = device.description().map(|about| about.name().to_string()).unwrap_or_else(|_| id.clone());
            Some(InputDevice { is_default: default.as_deref() == Some(id.as_str()), id, name })
        })
        .collect()
}

/// The input `id` names, or the system's default — for `""`, and for a chosen input that is not
/// plugged in right now: the choice stays saved for when it comes back, and dictating meanwhile
/// beats a refusal.
fn device(id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if !id.is_empty() {
        if let Some(device) = id.parse::<cpal::DeviceId>().ok().and_then(|parsed| host.device_by_id(&parsed)) {
            return Ok(device);
        }
    }
    host.default_input_device().ok_or_else(|| NONE.to_string())
}

fn describe(error: cpal::Error) -> String {
    let text = error.to_string();
    // WASAPI's refusal arrives as a backend error carrying E_ACCESSDENIED rather than as the kind.
    if error.kind() == cpal::ErrorKind::PermissionDenied || text.contains("0x80070005") || text.contains("E_ACCESSDENIED") {
        return DENIED.to_string();
    }
    text
}

/// What the audio callback writes and the capture thread reads.
#[derive(Default)]
struct Shared {
    samples: Vec<f32>,
    levels: Vec<f32>,
}

fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Mixes each frame to mono, keeps it while under the limit, and measures one RMS level per block.
struct Meter {
    shared: Arc<Mutex<Shared>>,
    limit: usize,
    block: usize,
    sum: f32,
    count: usize,
}

impl Meter {
    fn push<T>(&mut self, data: &[T], channels: usize)
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let mut shared = lock(&self.shared);
        for frame in data.chunks(channels) {
            let sample = frame.iter().map(|value| value.to_sample::<f32>()).sum::<f32>() / frame.len() as f32;
            if shared.samples.len() < self.limit {
                shared.samples.push(sample);
            }
            self.sum += sample * sample;
            self.count += 1;
            if self.count >= self.block {
                shared.levels.push((self.sum / self.count as f32).sqrt());
                self.sum = 0.0;
                self.count = 0;
            }
        }
    }
}

fn build<T>(device: &cpal::Device, config: cpal::StreamConfig, mut meter: Meter) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| meter.push(data, channels),
            // A device pulled mid-recording: what was heard so far is still transcribed on stop.
            |error| crate::applog::warn(&format!("dictation: microphone: {error}")),
            None,
        )
        .map_err(describe)
}

/// Opens and starts the input; the stream and the rate it runs at.
fn open(device_id: &str, shared: Arc<Mutex<Shared>>) -> Result<(cpal::Stream, u32), String> {
    let device = device(device_id)?;
    let supported = device.default_input_config().map_err(describe)?;
    let config = supported.config();
    let rate = config.sample_rate;
    let meter = Meter {
        shared,
        limit: rate as usize * MAX_SECONDS,
        block: ((rate as f32 * LEVEL_SECONDS) as usize).max(1),
        sum: 0.0,
        count: 0,
    };
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, meter),
        SampleFormat::I16 => build::<i16>(&device, config, meter),
        SampleFormat::U16 => build::<u16>(&device, config, meter),
        SampleFormat::I32 => build::<i32>(&device, config, meter),
        SampleFormat::I8 => build::<i8>(&device, config, meter),
        SampleFormat::U8 => build::<u8>(&device, config, meter),
        SampleFormat::F64 => build::<f64>(&device, config, meter),
        other => Err(format!("The microphone delivers {other:?} samples, which dictation cannot read")),
    }?;
    stream.play().map_err(describe)?;
    Ok((stream, rate))
}

/// A recording under way. Dropping it releases the microphone and drops the audio.
pub struct Capture {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<(Vec<f32>, u32)>,
}

/// Opens `device_id` (`""` = the system's default) and starts recording. `on_level` hears each
/// level as it is measured; `on_limit` once, when [`MAX_SECONDS`] are held. Returns once the input
/// is actually running, or with why it could not start.
pub fn start(device_id: &str, on_level: impl Fn(f32) + Send + 'static, on_limit: impl FnOnce() + Send + 'static) -> Result<Capture, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let device_id = device_id.to_string();
    let thread = std::thread::Builder::new()
        .name("dictation-mic".into())
        .spawn(move || {
            let shared = Arc::new(Mutex::new(Shared::default()));
            let (stream, rate) = match open(&device_id, shared.clone()) {
                Ok(opened) => opened,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return (Vec::new(), TARGET_RATE);
                }
            };
            let _ = ready_tx.send(Ok(()));
            let limit = rate as usize * MAX_SECONDS;
            let mut on_limit = Some(on_limit);
            // Until stopped — or until the `Capture` is dropped, which closes the channel.
            while let Err(RecvTimeoutError::Timeout) = stop_rx.recv_timeout(TICK) {
                let (levels, full) = {
                    let mut shared = lock(&shared);
                    (std::mem::take(&mut shared.levels), shared.samples.len() >= limit)
                };
                levels.into_iter().for_each(&on_level);
                if full {
                    if let Some(on_limit) = on_limit.take() {
                        on_limit();
                    }
                }
            }
            drop(stream);
            let samples = std::mem::take(&mut lock(&shared).samples);
            (samples, rate)
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(Capture { stop: stop_tx, thread }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => Err("The microphone stopped before it started".into()),
    }
}

impl Capture {
    /// Releases the microphone; the audio so far, mono at [`TARGET_RATE`].
    pub fn stop(self) -> Vec<f32> {
        let _ = self.stop.send(());
        let (samples, rate) = self.thread.join().unwrap_or_default();
        downsample(&samples, rate, TARGET_RATE)
    }
}

/// Averages each output sample's span of input: a box filter is enough for speech, and keeps what
/// lies above 8 kHz from folding back into the band whisper listens to. Clamped to whisper's
/// [-1, 1] on the way.
pub fn downsample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || from == 0 || to == 0 {
        return input.iter().map(|sample| sample.clamp(-1.0, 1.0)).collect();
    }
    let ratio = f64::from(from) / f64::from(to);
    let len = (input.len() as f64 / ratio).floor() as usize;
    (0..len)
        .map(|i| {
            let start = (i as f64 * ratio).floor() as usize;
            let end = input.len().min((start + 1).max(((i + 1) as f64 * ratio).floor() as usize));
            (input[start..end].iter().sum::<f32>() / (end - start) as f32).clamp(-1.0, 1.0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsampling_averages_each_output_samples_span() {
        assert_eq!(downsample(&[1.0, 1.0, 1.0, 0.0, 0.0, 0.0], 48_000, 16_000), vec![1.0, 0.0]);
        // 44.1 kHz does not divide evenly: every input lands in exactly one output.
        let out = downsample(&[0.5; 441], 44_100, 16_000);
        assert_eq!(out.len(), 160);
        assert!(out.iter().all(|sample| (*sample - 0.5).abs() < 1e-6));
    }

    #[test]
    fn the_target_rate_passes_through_clamped() {
        assert_eq!(downsample(&[-2.0, 0.25, 2.0], 16_000, 16_000), vec![-1.0, 0.25, 1.0]);
    }

    #[test]
    fn a_meter_mixes_to_mono_stops_keeping_at_the_limit_and_measures_per_block() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let mut meter = Meter { shared: shared.clone(), limit: 3, block: 2, sum: 0.0, count: 0 };
        // Stereo: (1, -1) → 0, (0.5, 0.5) → 0.5, (1, 1) → 1, (0, 0) → 0.
        meter.push(&[1.0f32, -1.0, 0.5, 0.5, 1.0, 1.0, 0.0, 0.0], 2);
        let shared = lock(&shared);
        assert_eq!(shared.samples, vec![0.0, 0.5, 1.0]);
        assert_eq!(shared.levels.len(), 2);
        assert!((shared.levels[0] - (0.125f32).sqrt()).abs() < 1e-6);
        assert!((shared.levels[1] - (0.5f32).sqrt()).abs() < 1e-6);
    }

    #[test]
    fn integer_samples_are_read_as_floats() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let mut meter = Meter { shared: shared.clone(), limit: 10, block: 100, sum: 0.0, count: 0 };
        meter.push(&[i16::MIN, 0, i16::MAX], 1);
        let samples = lock(&shared).samples.clone();
        assert_eq!(samples[0], -1.0);
        assert_eq!(samples[1], 0.0);
        assert!((samples[2] - 1.0).abs() < 1e-4);
    }
}
