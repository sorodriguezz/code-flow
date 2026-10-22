//! Playing samples on the speaker the user chose — «Voz y sonido › Dispositivos › Altavoz».
//!
//! The webview can only play on the system's default output (WebKit has no `setSinkId`), so
//! anything that has to come out of a chosen speaker is played here: the reading voice always, and a
//! notification's tone when a speaker other than the default is picked. One output stream per
//! playback, opened on the thread that plays it (a cpal stream is not `Send` everywhere) and closed
//! when it ends — a voice speaks for seconds at a time, and holding an output open in between would
//! keep a Bluetooth headset from sleeping.
//!
//! **The stream lives on a thread [`play`] spawns for it**, whoever calls: on Windows that thread
//! enters COM's multithreaded apartment before cpal touches it, a default output that still
//! refuses to open (`RPC_E_CHANGED_MODE`) is opened by its concrete id, and under/overruns are
//! noted at most once a minute — see `dictation::stream_health`. A glitch never ends a playback.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;

use crate::dictation::stream_health::{self, LogGate};

/// How often a glitch (under/overrun) may reach the log.
const GLITCH_LOG_EVERY: Duration = Duration::from_secs(60);

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

/// What the callback reads from: the samples at the output's rate, and how far it got. A streamed
/// playback keeps appending to `samples` while it plays, and sets `closed` after the last.
struct Cursor {
    samples: Vec<f32>,
    at: usize,
    closed: bool,
}

/// Plays `samples` (mono, at `rate`) on output `device_id` at `volume` (0–1), until they end or
/// `keep_going` says otherwise. Blocks for the length of the sound. The stream is opened, played and
/// closed on a thread of its own; this one only asks `keep_going`.
pub fn play(device_id: &str, samples: &[f32], rate: u32, volume: f32, keep_going: &dyn Fn() -> bool) -> Result<(), String> {
    if samples.is_empty() {
        return Ok(());
    }
    let stop = AtomicBool::new(false);
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let player = std::thread::Builder::new()
            .name("speaker".into())
            .spawn_scoped(scope, || {
                let result = play_here(device_id, samples, rate, volume, &stop);
                done.store(true, Ordering::SeqCst);
                result
            })
            .map_err(|e| e.to_string())?;
        while !done.load(Ordering::SeqCst) {
            if !keep_going() {
                stop.store(true, Ordering::SeqCst);
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        player.join().unwrap_or_else(|_| Err("The speaker thread stopped unexpectedly".into()))
    })
}

/// [`play`]'s thread: opens the output, plays, and closes it.
fn play_here(device_id: &str, samples: &[f32], rate: u32, volume: f32, stop: &AtomicBool) -> Result<(), String> {
    stream_health::enter_mta();
    let device = device(device_id)?;
    let volume = volume.clamp(0.0, 1.0);
    let (stream, finished) = match start_on(&device, samples, rate, volume) {
        Err(error) if stream_health::is_apartment_clash(&error) => {
            let Some(concrete) = stream_health::concrete(&cpal::default_host(), &device) else { return Err(error) };
            crate::applog::warn(&format!("speech: speaker: {error}; opening the device by its id"));
            start_on(&concrete, samples, rate, volume)?
        }
        other => other?,
    };
    let length = Duration::from_secs_f64(samples.len() as f64 / f64::from(rate.max(1)));
    // A device that stalls never reports the end: give up a second past the sound's own length.
    let deadline = Instant::now() + length + Duration::from_secs(1);
    while !finished.load(Ordering::SeqCst) && Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(15));
    }
    // The device's own buffer still holds the last few milliseconds.
    if finished.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(60));
    }
    drop(stream);
    Ok(())
}

/// Opens `device` and starts it on `samples`: the stream, and the flag set when they have played.
fn start_on(device: &cpal::Device, samples: &[f32], rate: u32, volume: f32) -> Result<(cpal::Stream, Arc<AtomicBool>), String> {
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    let out_rate = config.sample_rate;
    let channels = usize::from(config.channels.max(1));
    let cursor = Arc::new(Mutex::new(Cursor { samples: resample(samples, rate, out_rate).into_iter().map(|v| v * volume).collect(), at: 0, closed: true }));
    let finished = Arc::new(AtomicBool::new(false));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(device, config, channels, cursor, finished.clone()),
        SampleFormat::I16 => build::<i16>(device, config, channels, cursor, finished.clone()),
        SampleFormat::U16 => build::<u16>(device, config, channels, cursor, finished.clone()),
        SampleFormat::I32 => build::<i32>(device, config, channels, cursor, finished.clone()),
        SampleFormat::F64 => build::<f64>(device, config, channels, cursor, finished.clone()),
        other => Err(format!("The speaker takes {other:?} samples, which CodeFlow cannot write")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, finished))
}

fn build<T>(device: &cpal::Device, config: cpal::StreamConfig, channels: usize, cursor: Arc<Mutex<Cursor>>, finished: Arc<AtomicBool>) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let mut glitches = LogGate::new(GLITCH_LOG_EVERY);
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
                        // Run dry while more is coming: silence, not the end.
                        if cursor.closed {
                            finished.store(true, Ordering::SeqCst);
                        }
                        0.0
                    };
                    for slot in frame {
                        *slot = T::from_sample(value);
                    }
                }
            },
            // A lost speaker ends the playback by the deadline; a glitch is only noted, now and then.
            move |error: cpal::Error| {
                if stream_health::is_fatal(error.kind()) {
                    crate::applog::warn(&format!("speech: speaker: {error}"));
                } else if let Some(held) = glitches.allow(Instant::now()) {
                    crate::applog::warn(&format!("speech: speaker: {error}{} (not fatal)", stream_health::more(held)));
                }
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Plays chunks as they arrive on `chunks` — mono samples and their rate — on output `device_id`
/// at `volume`, until the sender hangs up and the last of them has played, or `keep_going` says
/// otherwise. What a voice that writes a sentence at a time is played with (`super::speak`): the
/// first sentence sounds while the next is still being written. One output stream for the whole
/// utterance, on a thread of its own as in [`play`]; a sentence that is late leaves a moment of
/// silence rather than a stream reopened.
pub fn play_stream(device_id: &str, volume: f32, chunks: std::sync::mpsc::Receiver<(Vec<f32>, u32)>, keep_going: &dyn Fn() -> bool) -> Result<(), String> {
    let stop = AtomicBool::new(false);
    let done = AtomicBool::new(false);
    // The receiver moves to the player's thread (it is not `Sync`); the flags are borrowed.
    let (stop_flag, done_flag) = (&stop, &done);
    std::thread::scope(|scope| {
        let player = std::thread::Builder::new()
            .name("speaker".into())
            .spawn_scoped(scope, move || {
                let result = stream_here(device_id, volume, chunks, stop_flag);
                done_flag.store(true, Ordering::SeqCst);
                result
            })
            .map_err(|e| e.to_string())?;
        while !done.load(Ordering::SeqCst) {
            if !keep_going() {
                stop.store(true, Ordering::SeqCst);
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        player.join().unwrap_or_else(|_| Err("The speaker thread stopped unexpectedly".into()))
    })
}

/// [`play_stream`]'s thread: opens the output on the first chunk, appends the rest as they come.
fn stream_here(device_id: &str, volume: f32, chunks: std::sync::mpsc::Receiver<(Vec<f32>, u32)>, stop: &AtomicBool) -> Result<(), String> {
    use std::sync::mpsc::RecvTimeoutError;
    stream_health::enter_mta();
    let volume = volume.clamp(0.0, 1.0);
    // Nothing is opened before there is something to say: a voice that fails to write keeps the
    // speaker closed.
    let first = loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        match chunks.recv_timeout(Duration::from_millis(15)) {
            Ok(chunk) => break chunk,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    };
    let device = device(device_id)?;
    let opened = match open_stream(&device) {
        Err(error) if stream_health::is_apartment_clash(&error) => {
            let Some(concrete) = stream_health::concrete(&cpal::default_host(), &device) else { return Err(error) };
            crate::applog::warn(&format!("speech: speaker: {error}; opening the device by its id"));
            open_stream(&concrete)?
        }
        other => other?,
    };
    let (stream, cursor, finished, out_rate) = opened;
    let push = |(samples, rate): (Vec<f32>, u32)| {
        let resampled = resample(&samples, rate, out_rate);
        let mut cursor = cursor.lock().unwrap_or_else(|p| p.into_inner());
        cursor.samples.extend(resampled.into_iter().map(|v| v * volume));
    };
    push(first);
    stream.play().map_err(|e| e.to_string())?;
    let mut open = true;
    while !stop.load(Ordering::SeqCst) {
        if open {
            match chunks.recv_timeout(Duration::from_millis(15)) {
                Ok(chunk) => push(chunk),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    open = false;
                    cursor.lock().unwrap_or_else(|p| p.into_inner()).closed = true;
                }
            }
        } else {
            if finished.load(Ordering::SeqCst) {
                // The device's own buffer still holds the last few milliseconds.
                std::thread::sleep(Duration::from_millis(60));
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
    drop(stream);
    Ok(())
}

/// An output stream on `device` reading from a cursor that starts empty and open.
fn open_stream(device: &cpal::Device) -> Result<(cpal::Stream, Arc<Mutex<Cursor>>, Arc<AtomicBool>, u32), String> {
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    let out_rate = config.sample_rate;
    let channels = usize::from(config.channels.max(1));
    let cursor = Arc::new(Mutex::new(Cursor { samples: Vec::new(), at: 0, closed: false }));
    let finished = Arc::new(AtomicBool::new(false));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::I16 => build::<i16>(device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::U16 => build::<u16>(device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::I32 => build::<i32>(device, config, channels, cursor.clone(), finished.clone()),
        SampleFormat::F64 => build::<f64>(device, config, channels, cursor.clone(), finished.clone()),
        other => Err(format!("The speaker takes {other:?} samples, which CodeFlow cannot write")),
    }?;
    Ok((stream, cursor, finished, out_rate))
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

/// The loudness (RMS) of every `step_ms` of `samples`, unscaled.
pub fn levels(samples: &[f32], rate: u32, step_ms: u32) -> Vec<f32> {
    let step = ((rate as usize * step_ms as usize) / 1000).max(1);
    samples.chunks(step).map(|chunk| (chunk.iter().map(|v| v * v).sum::<f32>() / chunk.len() as f32).sqrt()).collect()
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

    /// A streamed playback on the real default output, fed silence: `CODEFLOW_TEST_PLAY=1`. Two
    /// chunks a little apart play for their length together, and a stop cuts it.
    #[test]
    #[ignore]
    fn a_stream_plays_its_chunks_and_stops_when_told() {
        if std::env::var("CODEFLOW_TEST_PLAY").is_err() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let feeder = std::thread::spawn(move || {
            tx.send((vec![0.0f32; 11_025], 22_050)).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            tx.send((vec![0.0f32; 12_000], 24_000)).unwrap();
        });
        let started = Instant::now();
        play_stream("", 0.0, rx, &|| true).unwrap();
        feeder.join().unwrap();
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(900) && took < Duration::from_millis(2_000), "{took:?}");
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send((vec![0.0f32; 22_050 * 5], 22_050)).unwrap();
        let started = Instant::now();
        let deadline = started + Duration::from_millis(300);
        play_stream("", 0.0, rx, &|| Instant::now() < deadline).unwrap();
        drop(tx);
        assert!(started.elapsed() < Duration::from_millis(1_000), "{:?}", started.elapsed());
    }

    #[test]
    fn levels_are_the_loudness_of_each_step() {
        let mut samples = vec![0.0f32; 1_000];
        samples.extend(vec![0.5f32; 1_000]);
        assert_eq!(levels(&samples, 1_000, 1_000), vec![0.0, 0.5]);
    }
}
