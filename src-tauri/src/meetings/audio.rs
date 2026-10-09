//! Samples on their way to disk and back: the resampler every source goes through, the WAV pieces
//! a recording is written as, and reading a channel back for transcription.
//!
//! **Why pieces.** A meeting runs an hour or two; one WAV would be a file whose header only becomes
//! right when it is closed — a crash at minute ninety leaves a file a reader has to guess about —
//! and a 230 MB buffer nobody needs in memory. Each piece holds [`CHUNK_SECONDS`] of one channel and
//! is closed (header written, synced) the moment it fills, so a crash loses the one being written
//! and nothing before it. A piece still open when the process died has a header that says zero
//! bytes; [`read_wav`] goes by the file's length instead.

use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What whisper and the speaker model listen at.
pub const RATE: u32 = 16_000;
/// Samples per millisecond at [`RATE`].
pub const PER_MS: i64 = (RATE / 1000) as i64;
/// One piece of a channel.
pub const CHUNK_SECONDS: usize = 60;

/// A recording's channels. The microphone is the person recording; the system channel is what the
/// computer played.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Mic,
    System,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Mic => "mic",
            Channel::System => "system",
        }
    }

    pub fn parse(raw: &str) -> Option<Channel> {
        match raw {
            "mic" => Some(Channel::Mic),
            "system" => Some(Channel::System),
            _ => None,
        }
    }
}

pub fn ms_to_samples(ms: i64) -> usize {
    (ms.max(0) * PER_MS) as usize
}

pub fn samples_to_ms(samples: usize) -> i64 {
    samples as i64 / PER_MS
}

/// Root mean square of a block — the level the waveform draws, and the "is anybody there" test.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

// ---------------------------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------------------------

/// A device's rate to [`RATE`], fed a block at a time.
///
/// Down (48 kHz, 44.1 kHz — every microphone and output): each output sample is the average of the
/// input it spans, the box filter «Dictar» uses — enough for speech, and it keeps what lies above
/// 8 kHz from folding back into the band whisper hears. Up (a Bluetooth headset's 8 kHz): linear
/// between neighbours. The fractional position carries across blocks, so a stream cut into
/// callbacks resamples exactly as it would whole.
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Where the next output sample starts, in input samples, relative to the current block.
    position: f64,
    sum: f32,
    count: usize,
    last: f32,
}

impl Resampler {
    pub fn new(from: u32) -> Self {
        Resampler { step: f64::from(from.max(1)) / f64::from(RATE), position: 0.0, sum: 0.0, count: 0, last: 0.0 }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if (self.step - 1.0).abs() < f64::EPSILON {
            out.extend(input.iter().map(|s| s.clamp(-1.0, 1.0)));
            return;
        }
        if self.step < 1.0 {
            // Upsampling: interpolate between the previous sample and each new one.
            for &sample in input {
                while self.position < 1.0 {
                    let value = self.last + (sample - self.last) * self.position as f32;
                    out.push(value.clamp(-1.0, 1.0));
                    self.position += self.step;
                }
                self.position -= 1.0;
                self.last = sample;
            }
            return;
        }
        for (index, &sample) in input.iter().enumerate() {
            self.sum += sample;
            self.count += 1;
            // This input sample ends at `index + 1`: emit every output whose span closes here.
            if (index + 1) as f64 >= self.position + self.step {
                out.push((self.sum / self.count as f32).clamp(-1.0, 1.0));
                self.sum = 0.0;
                self.count = 0;
                self.position += self.step;
            }
        }
        self.position -= input.len() as f64;
    }
}

// ---------------------------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------------------------

/// A 44-byte canonical header for 16-bit mono PCM at `rate`, saying `data_bytes` of samples follow.
pub fn wav_header(rate: u32, channels: u16, data_bytes: u32) -> [u8; 44] {
    let mut header = [0u8; 44];
    let block_align = channels * 2;
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes());
    header[22..24].copy_from_slice(&channels.to_le_bytes());
    header[24..28].copy_from_slice(&rate.to_le_bytes());
    header[28..32].copy_from_slice(&(rate * u32::from(block_align)).to_le_bytes());
    header[32..34].copy_from_slice(&block_align.to_le_bytes());
    header[34..36].copy_from_slice(&16u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

pub fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

/// A whole buffer as a WAV file's bytes — what goes to a cloud transcription API.
pub fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(&wav_header(RATE, 1, (samples.len() * 2) as u32));
    for &sample in samples {
        bytes.extend_from_slice(&to_i16(sample).to_le_bytes());
    }
    bytes
}

/// The samples of a 16-bit PCM WAV of this module's shape. A header that says zero bytes (a piece
/// whose writer never closed it) is read by the file's length.
pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{} is not a WAV file", path.display()));
    }
    let body = &bytes[44..];
    let usable = body.len() - body.len() % 2;
    Ok(body[..usable]
        .chunks_exact(2)
        .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0)
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

/// A channel's folder inside a meeting's.
pub fn channel_dir(meeting: &Path, channel: Channel) -> PathBuf {
    meeting.join(channel.as_str())
}

fn piece_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("{index:06}.wav"))
}

/// The pieces of a channel, in order.
pub fn pieces(meeting: &Path, channel: Channel) -> Vec<PathBuf> {
    let dir = channel_dir(meeting, channel);
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut found: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "wav"))
        .collect();
    found.sort();
    found
}

/// How many samples a channel's pieces hold, read from their sizes.
pub fn channel_samples(meeting: &Path, channel: Channel) -> usize {
    let bytes: u64 = pieces(meeting, channel)
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|meta| meta.len().saturating_sub(44) / 2 * 2)
        .sum();
    (bytes / 2) as usize
}

/// How long a channel's pieces last.
pub fn channel_ms(meeting: &Path, channel: Channel) -> i64 {
    samples_to_ms(channel_samples(meeting, channel))
}

/// Writes one channel as pieces of [`CHUNK_SECONDS`].
pub struct ChunkWriter {
    dir: PathBuf,
    index: usize,
    file: Option<BufWriter<File>>,
    in_piece: usize,
    pub total: usize,
}

impl ChunkWriter {
    /// Starts after whatever pieces are already there — a recording resumed after a crash appends.
    pub fn open(meeting: &Path, channel: Channel) -> Result<Self, String> {
        let dir = channel_dir(meeting, channel);
        fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        let existing = pieces(meeting, channel);
        let total = channel_samples(meeting, channel);
        Ok(ChunkWriter { dir, index: existing.len(), file: None, in_piece: 0, total })
    }

    pub fn push(&mut self, samples: &[f32]) -> Result<(), String> {
        let per_piece = RATE as usize * CHUNK_SECONDS;
        let mut rest = samples;
        while !rest.is_empty() {
            if self.file.is_none() {
                self.index += 1;
                let path = piece_path(&self.dir, self.index);
                let mut file = BufWriter::new(File::create(&path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))?);
                file.write_all(&wav_header(RATE, 1, 0)).map_err(|e| e.to_string())?;
                self.file = Some(file);
                self.in_piece = 0;
            }
            let room = per_piece - self.in_piece;
            let (now, later) = rest.split_at(rest.len().min(room));
            let file = self.file.as_mut().expect("opened above");
            let mut bytes = Vec::with_capacity(now.len() * 2);
            for &sample in now {
                bytes.extend_from_slice(&to_i16(sample).to_le_bytes());
            }
            file.write_all(&bytes).map_err(|e| format!("Couldn't write the recording: {e}"))?;
            self.in_piece += now.len();
            self.total += now.len();
            rest = later;
            if self.in_piece >= per_piece {
                self.close_piece()?;
            }
        }
        Ok(())
    }

    /// Writes the open piece's header and syncs it, if one is open.
    fn close_piece(&mut self) -> Result<(), String> {
        let Some(writer) = self.file.take() else { return Ok(()) };
        let mut file = writer.into_inner().map_err(|e| format!("Couldn't write the recording: {e}"))?;
        let data = (self.in_piece * 2) as u32;
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        file.write_all(&wav_header(RATE, 1, data)).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        self.in_piece = 0;
        Ok(())
    }

    /// Closes the last piece. Dropping a writer without this leaves a piece [`read_wav`] still
    /// reads — this only makes its header right.
    pub fn finish(mut self) -> Result<usize, String> {
        self.close_piece()?;
        Ok(self.total)
    }
}

impl Drop for ChunkWriter {
    fn drop(&mut self) {
        let _ = self.close_piece();
    }
}

/// Reads a channel back as one stream of samples, a block at a time, across its pieces.
pub struct ChannelReader {
    pieces: std::vec::IntoIter<PathBuf>,
    buffer: Vec<f32>,
    at: usize,
    /// Samples handed out so far — the position of the next one.
    pub position: usize,
}

impl ChannelReader {
    pub fn open(meeting: &Path, channel: Channel) -> Self {
        ChannelReader { pieces: pieces(meeting, channel).into_iter(), buffer: Vec::new(), at: 0, position: 0 }
    }

    /// Up to `count` samples; fewer only at the end, none after it.
    pub fn read(&mut self, count: usize) -> Result<Vec<f32>, String> {
        let mut out = Vec::with_capacity(count);
        while out.len() < count {
            if self.at >= self.buffer.len() {
                match self.pieces.next() {
                    Some(path) => {
                        self.buffer = read_wav(&path)?;
                        self.at = 0;
                        continue;
                    }
                    None => break,
                }
            }
            let take = (count - out.len()).min(self.buffer.len() - self.at);
            out.extend_from_slice(&self.buffer[self.at..self.at + take]);
            self.at += take;
        }
        self.position += out.len();
        Ok(out)
    }

    /// The whole of what is left — for a channel known to be short.
    #[cfg(test)]
    pub fn read_all(&mut self) -> Result<Vec<f32>, String> {
        let mut out = Vec::new();
        loop {
            let block = self.read(RATE as usize * CHUNK_SECONDS)?;
            if block.is_empty() {
                return Ok(out);
            }
            out.extend(block);
        }
    }
}

/// `count` peaks across a channel — what the player's waveform draws. Read a piece at a time, so a
/// two-hour channel never sits in memory whole.
pub fn peaks(meeting: &Path, channel: Channel, count: usize) -> Vec<f32> {
    let total = channel_samples(meeting, channel);
    if total == 0 || count == 0 {
        return Vec::new();
    }
    let per = (total / count).max(1);
    let mut reader = ChannelReader::open(meeting, channel);
    let mut out = Vec::with_capacity(count);
    while out.len() < count {
        match reader.read(per) {
            Ok(block) if !block.is_empty() => out.push(block.iter().fold(0f32, |peak, s| peak.max(s.abs()))),
            _ => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsampling_carries_its_position_across_blocks() {
        let input: Vec<f32> = (0..48_000).map(|i| ((i % 3) as f32) / 10.0).collect();
        let mut whole = Vec::new();
        Resampler::new(48_000).push(&input, &mut whole);
        let mut split = Vec::new();
        let mut resampler = Resampler::new(48_000);
        for block in input.chunks(1_031) {
            resampler.push(block, &mut split);
        }
        assert_eq!(whole.len(), 16_000);
        assert_eq!(split.len(), whole.len());
        assert!(whole.iter().zip(&split).all(|(a, b)| (a - b).abs() < 1e-6));
        assert!((whole[5] - 0.1).abs() < 1e-6);
    }

    #[test]
    fn odd_rates_land_on_the_right_count() {
        let mut out = Vec::new();
        let mut resampler = Resampler::new(44_100);
        for block in vec![0.25f32; 44_100].chunks(512) {
            resampler.push(block, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 1, "{}", out.len());
        let mut up = Vec::new();
        Resampler::new(8_000).push(&vec![0.5f32; 8_000], &mut up);
        assert!((up.len() as i64 - 16_000).abs() <= 1, "{}", up.len());
    }

    #[test]
    fn pieces_round_trip_and_survive_an_unclosed_header() {
        let dir = std::env::temp_dir().join(format!("cf-meeting-audio-{}", uuid::Uuid::new_v4()));
        let samples: Vec<f32> = (0..(RATE as usize * 61 + 500)).map(|i| ((i % 100) as f32 - 50.0) / 100.0).collect();
        let mut writer = ChunkWriter::open(&dir, Channel::Mic).unwrap();
        writer.push(&samples[..1000]).unwrap();
        writer.push(&samples[1000..]).unwrap();
        // Dropped, not finished: the second piece's header is written by `Drop`.
        drop(writer);
        assert_eq!(pieces(&dir, Channel::Mic).len(), 2);
        assert_eq!(channel_ms(&dir, Channel::Mic), samples_to_ms(samples.len()));
        let back = ChannelReader::open(&dir, Channel::Mic).read_all().unwrap();
        assert_eq!(back.len(), samples.len());
        assert!((back[777] - samples[777]).abs() < 1e-3);
        // A piece whose header still says zero bytes reads by length.
        let second = &pieces(&dir, Channel::Mic)[1];
        let mut bytes = fs::read(second).unwrap();
        bytes[40..44].copy_from_slice(&0u32.to_le_bytes());
        fs::write(second, &bytes).unwrap();
        assert_eq!(read_wav(second).unwrap().len(), 500 + RATE as usize);
        // Reopening appends after the pieces already there.
        let mut again = ChunkWriter::open(&dir, Channel::Mic).unwrap();
        again.push(&[0.0; 10]).unwrap();
        assert_eq!(again.finish().unwrap(), samples.len() + 10);
        assert_eq!(pieces(&dir, Channel::Mic).len(), 3);
        assert_eq!(peaks(&dir, Channel::Mic, 10).len(), 10);
        let _ = fs::remove_dir_all(&dir);
    }
}
