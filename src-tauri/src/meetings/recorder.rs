//! The two inputs of a meeting, read through the system's audio API and written to disk as they
//! arrive.
//!
//! The microphone is the one «Dictar» uses (Settings' choice, or the default). The system channel is
//! what this computer plays — the other side of the call — recorded by loopback, which cpal opens
//! when an *output* device is asked for an input stream: a Core Audio process tap on macOS (14.6
//! and later, behind the "System audio recording" permission), WASAPI loopback on Windows.
//!
//! **Each channel has a thread of its own** that owns its stream from open to close (a cpal stream
//! is not `Send` everywhere), wakes every [`TICK`], and takes what the audio callback collected:
//! resampled to 16 kHz, written to the channel's pieces, measured for the waveform, and copied to
//! the live transcriber when there is one.
//!
//! **Both channels keep wall-clock time.** WASAPI loopback delivers nothing at all while nothing
//! plays — not silence, nothing — so a call with a quiet stretch would leave the system channel
//! shorter than the microphone's and every later line misplaced. A channel that has heard nothing
//! for a moment is padded with silence up to where the clock says it should be. Paused time is not
//! on the timeline: a pause is a cut, not a gap.
//!
//! **A device that goes away mid-meeting** (a headset unplugged) ends its stream with an error; the
//! thread drops it and opens the system's default again, padding the hole with silence so nothing
//! later shifts.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

use super::audio::{rms, Channel, ChunkWriter, Resampler, PER_MS};

/// How often a channel's thread takes what was heard.
const TICK: Duration = Duration::from_millis(40);
/// Silence after which a channel that hears nothing is padded up to the clock.
const QUIET_PAD: Duration = Duration::from_millis(300);
/// How far behind the clock a channel may lag before it is padded.
const LAG_TOLERANCE_MS: i64 = 400;
/// How often a lost device is looked for again.
const REOPEN_EVERY: Duration = Duration::from_secs(1);

/// The microphone was refused — the same code «Dictar» answers with.
pub const MIC_DENIED: &str = "MIC_DENIED";
pub const MIC_NONE: &str = "MIC_NONE";
/// The system audio could not be recorded: no permission (macOS) or no output device.
pub const SYSTEM_DENIED: &str = "SYSTEM_AUDIO_DENIED";

/// Audio on its way to the live transcriber.
pub struct LiveAudio {
    pub channel: Channel,
    pub samples: Vec<f32>,
}

/// What to record.
#[derive(Debug, Clone)]
pub struct Sources {
    /// An input's id (`dictation_device`), `""` for the default.
    pub mic_device: String,
    /// Record the computer's output too.
    pub system: bool,
}

/// The clock both channels keep.
struct Clock {
    started: Instant,
    paused_total_ms: AtomicU64,
    paused_at: Mutex<Option<Instant>>,
    paused: AtomicBool,
    stop: AtomicBool,
}

impl Clock {
    /// Milliseconds of recording so far, pauses left out.
    fn active_ms(&self) -> i64 {
        let now = match *self.paused_at.lock().unwrap_or_else(|p| p.into_inner()) {
            Some(at) => at,
            None => Instant::now(),
        };
        now.duration_since(self.started).as_millis() as i64 - self.paused_total_ms.load(Ordering::SeqCst) as i64
    }
}

/// What the audio callback hands its thread.
#[derive(Default)]
struct Inbox {
    samples: Vec<f32>,
    last: Option<Instant>,
    failed: bool,
}

/// A meeting being recorded. Dropping it stops the recording (the pieces stay on disk).
pub struct Recording {
    clock: Arc<Clock>,
    threads: Vec<(Channel, JoinHandle<Result<usize, String>>)>,
}

/// What a finished recording wrote, per channel, in samples.
#[derive(Debug, Default, Clone)]
pub struct Written {
    pub mic: usize,
    pub system: Option<usize>,
}

impl Recording {
    pub fn pause(&self) {
        if !self.clock.paused.swap(true, Ordering::SeqCst) {
            *self.clock.paused_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        }
    }

    pub fn resume(&self) {
        if self.clock.paused.swap(false, Ordering::SeqCst) {
            if let Some(at) = self.clock.paused_at.lock().unwrap_or_else(|p| p.into_inner()).take() {
                self.clock.paused_total_ms.fetch_add(at.elapsed().as_millis() as u64, Ordering::SeqCst);
            }
        }
    }

    pub fn paused(&self) -> bool {
        self.clock.paused.load(Ordering::SeqCst)
    }

    /// Milliseconds recorded so far.
    pub fn elapsed_ms(&self) -> i64 {
        self.clock.active_ms().max(0)
    }

    /// Stops both channels, closes their last pieces, and says how much each wrote.
    pub fn stop(mut self) -> Result<Written, String> {
        self.finish()
    }

    fn finish(&mut self) -> Result<Written, String> {
        self.clock.stop.store(true, Ordering::SeqCst);
        let mut written = Written::default();
        let mut failure = None;
        for (channel, thread) in self.threads.drain(..) {
            match thread.join().unwrap_or_else(|_| Err("A recording thread stopped unexpectedly".into())) {
                Ok(samples) => match channel {
                    Channel::Mic => written.mic = samples,
                    Channel::System => written.system = Some(samples),
                },
                Err(error) => failure = Some(error),
            }
        }
        match failure {
            Some(error) if written.mic == 0 => Err(error),
            _ => Ok(written),
        }
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        if !self.threads.is_empty() {
            let _ = self.finish();
        }
    }
}

/// Starts recording into `meeting`'s folder. `on_level` hears each channel's level about 25 times
/// a second; `live` receives the samples when the text is written as people speak. Returns once
/// every channel is actually running — or with why one could not start (`MIC_DENIED`,
/// `SYSTEM_AUDIO_DENIED`, …), having released whatever had opened.
pub fn start(
    meeting: &std::path::Path,
    sources: Sources,
    on_level: Arc<dyn Fn(Channel, f32) + Send + Sync>,
    live: Option<Sender<LiveAudio>>,
) -> Result<Recording, String> {
    let clock = Arc::new(Clock {
        started: Instant::now(),
        paused_total_ms: AtomicU64::new(0),
        paused_at: Mutex::new(None),
        paused: AtomicBool::new(false),
        stop: AtomicBool::new(false),
    });
    let mut channels = vec![Channel::Mic];
    if sources.system {
        channels.push(Channel::System);
    }
    let mut threads = Vec::new();
    for channel in channels {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let writer = ChunkWriter::open(meeting, channel)?;
        let thread_clock = clock.clone();
        let on_level = on_level.clone();
        let live = live.clone();
        let device = sources.mic_device.clone();
        let thread = std::thread::Builder::new()
            .name(format!("meeting-{}", channel.as_str()))
            .spawn(move || run_channel(channel, device, writer, thread_clock, on_level, live, ready_tx))
            .map_err(|e| e.to_string())?;
        match ready_rx.recv() {
            Ok(Ok(())) => threads.push((channel, thread)),
            Ok(Err(error)) => {
                clock.stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                for (_, started) in threads {
                    let _ = started.join();
                }
                return Err(error);
            }
            Err(_) => {
                clock.stop.store(true, Ordering::SeqCst);
                return Err("A recording channel stopped before it started".into());
            }
        }
    }
    Ok(Recording { clock, threads })
}

fn describe(error: cpal::Error, channel: Channel) -> String {
    let text = error.to_string();
    let denied = error.kind() == cpal::ErrorKind::PermissionDenied || text.contains("0x80070005") || text.contains("E_ACCESSDENIED");
    match (channel, denied) {
        (Channel::Mic, true) => MIC_DENIED.to_string(),
        (Channel::System, true) => SYSTEM_DENIED.to_string(),
        (Channel::System, false) => format!("{SYSTEM_DENIED}: {text}"),
        (Channel::Mic, false) => text,
    }
}

/// The device a channel reads: the chosen microphone (or the default input), or the default output
/// for the system channel.
fn device(channel: Channel, id: &str) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let host = cpal::default_host();
    match channel {
        Channel::Mic => {
            let chosen = (!id.is_empty())
                .then(|| id.parse::<cpal::DeviceId>().ok().and_then(|parsed| host.device_by_id(&parsed)))
                .flatten();
            let device = chosen.or_else(|| host.default_input_device()).ok_or_else(|| MIC_NONE.to_string())?;
            let config = device.default_input_config().map_err(|e| describe(e, channel))?;
            Ok((device, config))
        }
        Channel::System => {
            let device = host.default_output_device().ok_or_else(|| format!("{SYSTEM_DENIED}: no output device"))?;
            let config = device.default_output_config().map_err(|e| describe(e, channel))?;
            Ok((device, config))
        }
    }
}

fn build<T>(device: &cpal::Device, config: cpal::StreamConfig, inbox: Arc<Mutex<Inbox>>, channel: Channel) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let failed = inbox.clone();
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                let mut inbox = inbox.lock().unwrap_or_else(|p| p.into_inner());
                for frame in data.chunks(channels) {
                    inbox.samples.push(frame.iter().map(|v| v.to_sample::<f32>()).sum::<f32>() / frame.len() as f32);
                }
                inbox.last = Some(Instant::now());
            },
            move |error| {
                crate::applog::warn(&format!("meetings: {} stream: {error}", channel.as_str()));
                failed.lock().unwrap_or_else(|p| p.into_inner()).failed = true;
            },
            None,
        )
        .map_err(|e| describe(e, channel))
}

/// Opens a channel's device and starts it: the stream and its rate.
fn open(channel: Channel, id: &str, inbox: Arc<Mutex<Inbox>>) -> Result<(cpal::Stream, u32), String> {
    let (device, supported) = device(channel, id)?;
    let config = supported.config();
    let rate = config.sample_rate;
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, inbox, channel),
        SampleFormat::I16 => build::<i16>(&device, config, inbox, channel),
        SampleFormat::U16 => build::<u16>(&device, config, inbox, channel),
        SampleFormat::I32 => build::<i32>(&device, config, inbox, channel),
        SampleFormat::I8 => build::<i8>(&device, config, inbox, channel),
        SampleFormat::U8 => build::<u8>(&device, config, inbox, channel),
        SampleFormat::F64 => build::<f64>(&device, config, inbox, channel),
        other => Err(format!("The {} input delivers {other:?} samples, which cannot be read", channel.as_str())),
    }?;
    stream.play().map_err(|e| describe(e, channel))?;
    Ok((stream, rate))
}

fn run_channel(
    channel: Channel,
    device_id: String,
    mut writer: ChunkWriter,
    clock: Arc<Clock>,
    on_level: Arc<dyn Fn(Channel, f32) + Send + Sync>,
    live: Option<Sender<LiveAudio>>,
    ready: Sender<Result<(), String>>,
) -> Result<usize, String> {
    let inbox = Arc::new(Mutex::new(Inbox::default()));
    let (opened, rate) = match open(channel, &device_id, inbox.clone()) {
        Ok(opened) => opened,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Ok(0);
        }
    };
    let _ = ready.send(Ok(()));
    // `None` while a lost device has not come back: the clock pads the channel meanwhile.
    let mut stream = Some(opened);
    let mut stream_rate = rate;
    let mut resampler = Resampler::new(rate);
    let mut last_attempt = Instant::now();
    let mut out = Vec::with_capacity(4096);
    let mut failure: Option<String> = None;
    while !clock.stop.load(Ordering::SeqCst) {
        std::thread::sleep(TICK);
        let (raw, last, failed) = {
            let mut inbox = inbox.lock().unwrap_or_else(|p| p.into_inner());
            let failed = std::mem::take(&mut inbox.failed);
            (std::mem::take(&mut inbox.samples), inbox.last, failed)
        };
        if failed {
            // The device went away: let the stream go; the system's default is tried below.
            stream = None;
        }
        if stream.is_none() && last_attempt.elapsed() >= REOPEN_EVERY {
            last_attempt = Instant::now();
            match open(channel, "", inbox.clone()) {
                Ok((reopened, rate)) => {
                    crate::applog::info(&format!("meetings: {} input reopened at {rate} Hz", channel.as_str()));
                    stream = Some(reopened);
                    if rate != stream_rate {
                        stream_rate = rate;
                        resampler = Resampler::new(rate);
                    }
                }
                Err(error) => crate::applog::warn(&format!("meetings: reopening {}: {error}", channel.as_str())),
            }
        }
        out.clear();
        resampler.push(&raw, &mut out);
        if clock.paused.load(Ordering::SeqCst) {
            continue;
        }
        // Behind the clock and hearing nothing: silence up to where the clock is.
        let expected = clock.active_ms() * PER_MS;
        let have = (writer.total + out.len()) as i64;
        let quiet = last.is_none_or(|at| at.elapsed() >= QUIET_PAD);
        if quiet && expected - have > LAG_TOLERANCE_MS * PER_MS {
            let missing = (expected - have - 100 * PER_MS).max(0) as usize;
            out.extend(std::iter::repeat_n(0.0, missing));
        }
        if out.is_empty() {
            continue;
        }
        on_level(channel, rms(&out));
        if let Err(error) = writer.push(&out) {
            failure = Some(error);
            break;
        }
        if let Some(live) = &live {
            let _ = live.send(LiveAudio { channel, samples: out.clone() });
        }
    }
    drop(stream);
    let total = writer.finish()?;
    if let Some(error) = failure {
        crate::applog::warn(&format!("meetings: {} channel stopped: {error}", channel.as_str()));
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records three seconds from this machine's default microphone (and the computer's audio with
    /// `CODEFLOW_TEST_RECORD=system`) into a scratch meeting folder. Only where the microphone is
    /// already granted to whatever runs the test: `CODEFLOW_TEST_RECORD=mic cargo test --lib
    /// meetings::recorder -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn records_the_microphone_into_pieces_on_the_clock() {
        let Ok(which) = std::env::var("CODEFLOW_TEST_RECORD") else { return };
        let dir = std::env::temp_dir().join(format!("cf-meeting-rec-{}", uuid::Uuid::new_v4()));
        let levels = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = levels.clone();
        let on_level: Arc<dyn Fn(Channel, f32) + Send + Sync> = Arc::new(move |_, _| {
            counted.fetch_add(1, Ordering::Relaxed);
        });
        let recording = start(&dir, Sources { mic_device: String::new(), system: which == "system" }, on_level, None).expect("the inputs open");
        std::thread::sleep(Duration::from_millis(1_500));
        recording.pause();
        std::thread::sleep(Duration::from_millis(700));
        recording.resume();
        std::thread::sleep(Duration::from_millis(1_500));
        let written = recording.stop().unwrap();
        let mic_ms = super::super::audio::channel_ms(&dir, Channel::Mic);
        eprintln!("written {written:?}, mic {mic_ms} ms, levels {}", levels.load(Ordering::Relaxed));
        // Three seconds of recording; the 0.7 s pause is not on the timeline.
        assert!((2_700..=3_400).contains(&mic_ms), "{mic_ms}");
        if which == "system" {
            let system_ms = super::super::audio::channel_ms(&dir, Channel::System);
            eprintln!("system {system_ms} ms");
            assert!((mic_ms - system_ms).abs() < 600, "the channels keep the same clock: {mic_ms} vs {system_ms}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
