//! The recording kept small, and read back: AAC in an `.m4a` written with the system's own encoder,
//! and any audio file decoded to the 16 kHz the rest of the feature reads.
//!
//! **The system's encoder, not a crate.** There is no AAC (or Opus) encoder in pure Rust worth
//! trusting, and a C codec is a build dependency CI would have to carry. Both platforms ship one:
//! AudioToolbox's `ExtAudioFile` on macOS, Media Foundation's sink writer on Windows. WAV at 16 kHz
//! is 115 MB an hour per channel; AAC is a few tens — and it plays in both webviews as it is.
//!
//! A meeting with both channels is kept as **one stereo file, microphone left and system right**,
//! so a later pass (a different model, separating voices again) gets both back apart; the player
//! mixes them to mono so nobody hears half a call in one ear. Windows' AAC encoder only takes 44.1
//! or 48 kHz at 96 kbps or more, so there the samples go up to 48 kHz first and the file is bigger.
//!
//! When the system has no encoder (a Windows "N" edition without the media pack) the pieces are
//! merged into a WAV instead: larger, never lost.
//!
//! Decoding is symphonia (pure Rust): AAC/MP4 — what this writes, and what Teams' own recordings
//! are — plus MP3, WAV, FLAC, Ogg Vorbis and ALAC, for «Importar audio».

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use super::audio::{self, Channel, ChannelReader, ChunkWriter, Resampler, RATE};

/// The file a finished meeting's audio is kept in, inside its folder.
pub const COMPRESSED: &str = "audio.m4a";
/// The fallback when there is no encoder.
pub const UNCOMPRESSED: &str = "audio.wav";

/// Writes the meeting's channels into one compressed file, and returns its name. The pieces are
/// left alone — the caller deletes them once this succeeded.
pub fn compress(meeting: &Path, channels: &[Channel]) -> Result<String, String> {
    let target = meeting.join(COMPRESSED);
    let _ = std::fs::remove_file(&target);
    match platform::encode_aac(meeting, channels, &target) {
        Ok(()) => Ok(COMPRESSED.to_string()),
        Err(error) => {
            crate::applog::warn(&format!("meetings: AAC encoder unavailable, keeping WAV: {error}"));
            let _ = std::fs::remove_file(&target);
            write_wav(meeting, channels, &meeting.join(UNCOMPRESSED))?;
            Ok(UNCOMPRESSED.to_string())
        }
    }
}

/// Interleaves the channels' pieces block by block — `f(frames, interleaved)` per block.
fn interleaved(meeting: &Path, channels: &[Channel], mut f: impl FnMut(usize, &[f32]) -> Result<(), String>) -> Result<(), String> {
    let mut readers: Vec<ChannelReader> = channels.iter().map(|c| ChannelReader::open(meeting, *c)).collect();
    let block = RATE as usize * 4;
    let mut out = Vec::with_capacity(block * channels.len());
    loop {
        let blocks: Vec<Vec<f32>> = readers.iter_mut().map(|r| r.read(block)).collect::<Result<_, _>>()?;
        let frames = blocks.iter().map(Vec::len).max().unwrap_or(0);
        if frames == 0 {
            return Ok(());
        }
        out.clear();
        for frame in 0..frames {
            for channel in &blocks {
                out.push(channel.get(frame).copied().unwrap_or(0.0));
            }
        }
        f(frames, &out)?;
    }
}

fn write_wav(meeting: &Path, channels: &[Channel], target: &Path) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let count = channels.len() as u16;
    let mut file = std::io::BufWriter::new(File::create(target).map_err(|e| e.to_string())?);
    file.write_all(&audio::wav_header(RATE, count, 0)).map_err(|e| e.to_string())?;
    let mut bytes = 0u32;
    interleaved(meeting, channels, |_, samples| {
        let mut buffer = Vec::with_capacity(samples.len() * 2);
        for &sample in samples {
            buffer.extend_from_slice(&audio::to_i16(sample).to_le_bytes());
        }
        bytes = bytes.saturating_add(buffer.len() as u32);
        file.write_all(&buffer).map_err(|e| e.to_string())
    })?;
    let mut file = file.into_inner().map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.write_all(&audio::wav_header(RATE, count, bytes)).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

/// Decodes `path` and writes it as pieces: each of `channels` taken from the file's channel at the
/// same position (a stereo file this module wrote), or — with one channel asked for — every channel
/// mixed down. Returns the samples written per channel.
pub fn decode_to_pieces(path: &Path, meeting: &Path, channels: &[Channel], progress: impl FnMut(f32)) -> Result<usize, String> {
    let mut writers: Vec<ChunkWriter> = channels.iter().map(|c| ChunkWriter::open(meeting, *c)).collect::<Result<_, _>>()?;
    let mut resamplers: Vec<Option<Resampler>> = channels.iter().map(|_| None).collect();
    let mut out = Vec::new();
    decode(path, progress, |samples, count, rate| {
        for (index, writer) in writers.iter_mut().enumerate() {
            let mono: Vec<f32> = if channels.len() == 1 {
                mix_down(samples, count)
            } else {
                let at = index.min(count - 1);
                samples.chunks(count).map(|frame| frame[at]).collect()
            };
            let resampler = resamplers[index].get_or_insert_with(|| Resampler::new(rate));
            out.clear();
            resampler.push(&mono, &mut out);
            writer.push(&out)?;
        }
        Ok(())
    })?;
    let mut written = 0;
    for writer in writers {
        written = written.max(writer.finish()?);
    }
    if written == 0 {
        return Err("This file has no audio in it".into());
    }
    Ok(written)
}

/// All of `path` as one channel at [`RATE`] — every channel mixed down — held in memory, for a
/// caller that transcribes it whole (a flow's «Transcribir audio»). Longer than `limit_secs` is an
/// error rather than gigabytes of samples.
pub fn decode_mono(path: &Path, limit_secs: u32) -> Result<Vec<f32>, String> {
    let most = limit_secs as usize * RATE as usize;
    let mut resampler: Option<Resampler> = None;
    let mut all = Vec::new();
    decode(path, |_| {}, |samples, count, rate| {
        resampler.get_or_insert_with(|| Resampler::new(rate)).push(&mix_down(samples, count), &mut all);
        if all.len() > most {
            return Err(format!("The audio is longer than {} minutes", limit_secs / 60));
        }
        Ok(())
    })?;
    if all.is_empty() {
        return Err("This file has no audio in it".into());
    }
    Ok(all)
}

fn mix_down(samples: &[f32], count: usize) -> Vec<f32> {
    samples.chunks(count).map(|frame| frame.iter().sum::<f32>() / frame.len() as f32).collect()
}

/// Reads `path` packet by packet: each decoded block reaches `sink` interleaved, with its channel
/// count and rate; `progress` hears the share of the file read so far.
fn decode(path: &Path, mut progress: impl FnMut(f32), mut sink: impl FnMut(&[f32], usize, u32) -> Result<(), String>) -> Result<(), String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let total_bytes = file.metadata().map(|m| m.len()).unwrap_or(0).max(1);
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("This file's audio cannot be read: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.channels.is_some_and(|c| c.count() > 0))
        .or_else(|| format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL))
        .ok_or("This file has no audio track")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("This file's audio format is not supported: {e}"))?;
    let mut consumed = 0u64;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("Reading the audio failed: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        consumed += packet.data.len() as u64;
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("Decoding the audio failed: {e}")),
        };
        let spec = *decoded.spec();
        let count = spec.channels.count().max(1);
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        sink(buffer.samples(), count, spec.rate)?;
        progress((consumed as f32 / total_bytes as f32).min(1.0));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::path::Path;

    use super::super::audio::{to_i16, Channel, RATE};

    type Ref = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct StreamDescription {
        sample_rate: f64,
        format_id: u32,
        format_flags: u32,
        bytes_per_packet: u32,
        frames_per_packet: u32,
        bytes_per_frame: u32,
        channels_per_frame: u32,
        bits_per_channel: u32,
        reserved: u32,
    }

    #[repr(C)]
    struct Buffer {
        channels: u32,
        bytes: u32,
        data: *mut c_void,
    }

    #[repr(C)]
    struct BufferList {
        count: u32,
        buffers: [Buffer; 1],
    }

    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        fn ExtAudioFileCreateWithURL(url: *const c_void, file_type: u32, format: *const StreamDescription, layout: *const c_void, flags: u32, out: *mut Ref) -> i32;
        fn ExtAudioFileSetProperty(file: Ref, id: u32, size: u32, data: *const c_void) -> i32;
        fn ExtAudioFileGetProperty(file: Ref, id: u32, size: *mut u32, data: *mut c_void) -> i32;
        fn ExtAudioFileWrite(file: Ref, frames: u32, data: *const BufferList) -> i32;
        fn ExtAudioFileDispose(file: Ref) -> i32;
        fn AudioConverterSetProperty(converter: Ref, id: u32, size: u32, data: *const c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(allocator: *const c_void, buffer: *const u8, length: isize, directory: u8) -> *const c_void;
        fn CFRelease(object: *const c_void);
    }

    const fn four(code: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*code)
    }

    fn check(status: i32, what: &str) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(format!("{what} failed (OSStatus {status})"))
        }
    }

    pub fn encode_aac(meeting: &Path, channels: &[Channel], target: &Path) -> Result<(), String> {
        let count = channels.len() as u32;
        let path = target.to_string_lossy().into_owned();
        // SAFETY: Core Foundation and AudioToolbox calls with values that outlive them; the file
        // handle is disposed on every path out.
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), path.as_ptr(), path.len() as isize, 0);
            if url.is_null() {
                return Err("Couldn't name the audio file".into());
            }
            let output = StreamDescription { sample_rate: f64::from(RATE), format_id: four(b"aac "), channels_per_frame: count, frames_per_packet: 1024, ..Default::default() };
            let mut file: Ref = std::ptr::null_mut();
            // kAudioFileM4AType, kAudioFileFlags_EraseFile.
            let status = ExtAudioFileCreateWithURL(url, four(b"m4af"), &output, std::ptr::null(), 1, &mut file);
            CFRelease(url);
            check(status, "Creating the AAC file")?;
            let result = (|| {
                let client = StreamDescription {
                    sample_rate: f64::from(RATE),
                    format_id: four(b"lpcm"),
                    // Signed integer, packed.
                    format_flags: 4 | 8,
                    bytes_per_packet: 2 * count,
                    frames_per_packet: 1,
                    bytes_per_frame: 2 * count,
                    channels_per_frame: count,
                    bits_per_channel: 16,
                    reserved: 0,
                };
                check(
                    ExtAudioFileSetProperty(file, four(b"cfmt"), std::mem::size_of::<StreamDescription>() as u32, (&client as *const StreamDescription).cast()),
                    "Setting the input format",
                )?;
                // A speech bitrate, best effort: an encoder that refuses it keeps its own.
                let mut converter: Ref = std::ptr::null_mut();
                let mut size = std::mem::size_of::<Ref>() as u32;
                if ExtAudioFileGetProperty(file, four(b"acnv"), &mut size, (&mut converter as *mut Ref).cast()) == 0 && !converter.is_null() {
                    let bitrate: u32 = if count > 1 { 48_000 } else { 32_000 };
                    if AudioConverterSetProperty(converter, four(b"brat"), 4, (&bitrate as *const u32).cast()) == 0 {
                        let none: *const c_void = std::ptr::null();
                        ExtAudioFileSetProperty(file, four(b"acfg"), std::mem::size_of::<*const c_void>() as u32, (&none as *const *const c_void).cast());
                    }
                }
                super::interleaved(meeting, channels, |frames, samples| {
                    let mut pcm: Vec<i16> = samples.iter().map(|&s| to_i16(s)).collect();
                    let list = BufferList {
                        count: 1,
                        buffers: [Buffer { channels: count, bytes: (pcm.len() * 2) as u32, data: pcm.as_mut_ptr().cast() }],
                    };
                    check(ExtAudioFileWrite(file, frames as u32, &list), "Writing the AAC file")
                })
            })();
            let closed = ExtAudioFileDispose(file);
            result?;
            check(closed, "Closing the AAC file")
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::path::Path;

    use windows::core::HSTRING;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    use super::super::audio::{to_i16, Channel};

    /// `MF_VERSION` (MF_SDK_VERSION 0x0002 << 16 | MF_API_VERSION 0x0070).
    const VERSION: u32 = 0x0002_0070;
    /// The rate Windows' AAC encoder takes.
    const RATE_OUT: u32 = 48_000;

    fn err(what: &str, e: windows::core::Error) -> String {
        format!("{what} failed: {e}")
    }

    pub fn encode_aac(meeting: &Path, channels: &[Channel], target: &Path) -> Result<(), String> {
        let count = channels.len() as u32;
        // SAFETY: COM and Media Foundation calls on this thread, released in order below.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(VERSION, MFSTARTUP_FULL).map_err(|e| err("Starting Media Foundation", e))?;
            let result = (|| -> Result<(), String> {
                let writer = MFCreateSinkWriterFromURL(&HSTRING::from(target.as_os_str()), None, None).map_err(|e| err("Creating the AAC file", e))?;
                let output = MFCreateMediaType().map_err(|e| err("Media type", e))?;
                output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| err("Media type", e))?;
                output.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(|e| err("Media type", e))?;
                output.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| err("Media type", e))?;
                output.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE_OUT).map_err(|e| err("Media type", e))?;
                output.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, count).map_err(|e| err("Media type", e))?;
                // 96 kbps, the encoder's lowest.
                output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 12_000).map_err(|e| err("Media type", e))?;
                let stream = writer.AddStream(&output).map_err(|e| err("Adding the audio stream", e))?;
                let input = MFCreateMediaType().map_err(|e| err("Media type", e))?;
                input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| err("Media type", e))?;
                input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(|e| err("Media type", e))?;
                input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| err("Media type", e))?;
                input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE_OUT).map_err(|e| err("Media type", e))?;
                input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, count).map_err(|e| err("Media type", e))?;
                input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, count * 2).map_err(|e| err("Media type", e))?;
                input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, RATE_OUT * count * 2).map_err(|e| err("Media type", e))?;
                writer.SetInputMediaType(stream, &input, None).map_err(|e| err("Setting the input format", e))?;
                writer.BeginWriting().map_err(|e| err("Starting to write", e))?;
                let mut written_frames: i64 = 0;
                let mut previous = vec![0f32; count as usize];
                super::interleaved(meeting, channels, |frames, samples| {
                    // 16 kHz to 48 kHz: three output frames per input frame, linear between them.
                    let width = count as usize;
                    let mut pcm: Vec<u8> = Vec::with_capacity(frames * 3 * width * 2);
                    for frame in 0..frames {
                        for step in 0..3 {
                            for c in 0..width {
                                let now = samples[frame * width + c];
                                let value = previous[c] + (now - previous[c]) * ((step + 1) as f32 / 3.0);
                                pcm.extend_from_slice(&to_i16(value).to_le_bytes());
                            }
                        }
                        for c in 0..width {
                            previous[c] = samples[frame * width + c];
                        }
                    }
                    let out_frames = (frames * 3) as i64;
                    let buffer = MFCreateMemoryBuffer(pcm.len() as u32).map_err(|e| err("Buffer", e))?;
                    let mut data: *mut u8 = std::ptr::null_mut();
                    buffer.Lock(&mut data, None, None).map_err(|e| err("Buffer", e))?;
                    std::ptr::copy_nonoverlapping(pcm.as_ptr(), data, pcm.len());
                    buffer.Unlock().map_err(|e| err("Buffer", e))?;
                    buffer.SetCurrentLength(pcm.len() as u32).map_err(|e| err("Buffer", e))?;
                    let sample = MFCreateSample().map_err(|e| err("Sample", e))?;
                    sample.AddBuffer(&buffer).map_err(|e| err("Sample", e))?;
                    // Times in 100 ns units.
                    sample.SetSampleTime(written_frames * 10_000_000 / i64::from(RATE_OUT)).map_err(|e| err("Sample", e))?;
                    sample.SetSampleDuration(out_frames * 10_000_000 / i64::from(RATE_OUT)).map_err(|e| err("Sample", e))?;
                    writer.WriteSample(stream, &sample).map_err(|e| err("Writing the AAC file", e))?;
                    written_frames += out_frames;
                    Ok(())
                })?;
                writer.Finalize().map_err(|e| err("Closing the AAC file", e))
            })();
            let _ = MFShutdown();
            result
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn encode_aac(_: &std::path::Path, _: &[super::Channel], _: &std::path::Path) -> Result<(), String> {
        Err("no AAC encoder on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Any file in, one 16 kHz channel out, in memory: a stereo 44.1 kHz WAV (what a phone or an
    /// exported clip is) mixed down and resampled — and a file past the limit refused.
    #[test]
    fn a_file_decodes_to_one_channel_at_16_khz() {
        let dir = std::env::temp_dir().join(format!("cf-decode-mono-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.wav");
        let (rate, seconds) = (44_100u32, 2u32);
        let mut pcm = Vec::new();
        for i in 0..rate * seconds {
            let left = ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5 * 32767.0) as i16;
            pcm.extend_from_slice(&left.to_le_bytes());
            pcm.extend_from_slice(&0i16.to_le_bytes());
        }
        let mut file = audio::wav_header(rate, 2, pcm.len() as u32).to_vec();
        file.extend_from_slice(&pcm);
        std::fs::write(&path, file).unwrap();
        let samples = decode_mono(&path, 60).unwrap();
        assert!((samples.len() as i64 - i64::from(RATE * seconds)).abs() <= 2, "{}", samples.len());
        // Mixed down: one loud channel and one silent one make half the swing.
        let peak = samples.iter().fold(0f32, |most, s| most.max(s.abs()));
        assert!((0.2..0.3).contains(&peak), "{peak}");
        assert!(decode_mono(&path, 1).unwrap_err().contains("longer than"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The flow's «Transcribir audio» path end to end, on the real engine:
    /// `CODEFLOW_TEST_FLOW_WHISPER=<whisper library>|<ggml model>|<audio file>|<expected word>`.
    #[test]
    #[ignore]
    fn a_flow_transcribes_a_file_with_codeflows_whisper() {
        use crate::dictation::engine;
        let spec = std::env::var("CODEFLOW_TEST_FLOW_WHISPER").expect("CODEFLOW_TEST_FLOW_WHISPER=<library>|<model>|<audio>|<word>");
        let parts: Vec<&str> = spec.split('|').collect();
        engine::load_library_for_test(Path::new(parts[0]));
        let samples = decode_mono(Path::new(parts[2]), 600).unwrap();
        let started = std::time::Instant::now();
        let options = engine::Options { language: "auto".into(), ..engine::Options::default() };
        let segments = engine::segments(&engine::FLOWS, Path::new(parts[1]), &samples, &options, &std::sync::atomic::AtomicBool::new(false)).unwrap();
        engine::unload_slot(&engine::FLOWS);
        let text: String = segments.iter().map(|s| s.text.as_str()).collect();
        eprintln!("{:.1} s of audio in {:?}: {text}", samples.len() as f64 / 16_000.0, started.elapsed());
        assert!(text.to_lowercase().contains(&parts[3].to_lowercase()), "{text}");
    }

    /// Two channels in, one stereo file out, and back apart: what a meeting does at its end and a
    /// second pass does at its start. Uses the real system encoder (macOS here).
    #[test]
    fn a_stereo_meeting_compresses_and_comes_back_apart() {
        let dir = std::env::temp_dir().join(format!("cf-meeting-encode-{}", uuid::Uuid::new_v4()));
        let seconds = 5usize;
        let tone = |hz: f32| -> Vec<f32> { (0..RATE as usize * seconds).map(|i| (i as f32 * hz * std::f32::consts::TAU / RATE as f32).sin() * 0.4).collect() };
        let mut mic = ChunkWriter::open(&dir, Channel::Mic).unwrap();
        mic.push(&tone(440.0)).unwrap();
        mic.finish().unwrap();
        let mut system = ChunkWriter::open(&dir, Channel::System).unwrap();
        system.push(&vec![0.0; RATE as usize * seconds]).unwrap();
        system.finish().unwrap();
        let name = compress(&dir, &[Channel::Mic, Channel::System]).unwrap();
        let file = dir.join(&name);
        let size = std::fs::metadata(&file).unwrap().len();
        eprintln!("{name}: {size} bytes for {seconds} s");
        let back = dir.join("back");
        let written = decode_to_pieces(&file, &back, &[Channel::Mic, Channel::System], |_| {}).unwrap();
        assert!((written as i64 - (RATE as usize * seconds) as i64).abs() < RATE as i64 / 2, "{written}");
        let mic_back = ChannelReader::open(&back, Channel::Mic).read_all().unwrap();
        let system_back = ChannelReader::open(&back, Channel::System).read_all().unwrap();
        assert!(audio::rms(&mic_back) > 0.15, "the tone is on the left: {}", audio::rms(&mic_back));
        assert!(audio::rms(&system_back) < 0.05, "the right is silent: {}", audio::rms(&system_back));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
