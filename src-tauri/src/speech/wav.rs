//! Just enough of RIFF/WAVE to read what the system voices write: integer PCM (8, 16, 24 or 32 bits)
//! or 32-bit float, any rate, any channel count — mixed down to mono.

/// Mono samples and their rate.
pub fn parse(bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("The voice did not write a WAV file".into());
    }
    let mut at = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        let body = at + 8;
        // A writer that streamed the file may leave the data chunk's size at 0 or 0xFFFFFFFF.
        let end = if id == b"data" && (size == 0 || size == u32::MAX as usize || body + size > bytes.len()) { bytes.len() } else { (body + size).min(bytes.len()) };
        match id {
            b"fmt " if end - body >= 16 => {
                let tag = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
                let channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]).max(1);
                let rate = u32::from_le_bytes([bytes[body + 4], bytes[body + 5], bytes[body + 6], bytes[body + 7]]);
                let bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
                // WAVE_FORMAT_EXTENSIBLE carries the real tag in its sub-format GUID's first two bytes.
                let tag = if tag == 0xFFFE && end - body >= 26 { u16::from_le_bytes([bytes[body + 24], bytes[body + 25]]) } else { tag };
                format = Some((tag, channels, rate, bits));
            }
            b"data" => {
                let (tag, channels, rate, bits) = format.ok_or("The WAV file has no format")?;
                return Ok((decode(&bytes[body..end], tag, channels, bits)?, rate));
            }
            _ => {}
        }
        at = body + size + (size & 1);
    }
    Err("The WAV file has no audio".into())
}

fn decode(data: &[u8], tag: u16, channels: u16, bits: u16) -> Result<Vec<f32>, String> {
    let width = usize::from(bits / 8);
    if width == 0 {
        return Err(format!("Unsupported WAV sample width: {bits} bits"));
    }
    let sample = |chunk: &[u8]| -> f32 {
        match (tag, bits) {
            (3, 32) => f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
            (_, 8) => (f32::from(chunk[0]) - 128.0) / 128.0,
            (_, 16) => f32::from(i16::from_le_bytes([chunk[0], chunk[1]])) / 32_768.0,
            (_, 24) => (i32::from_le_bytes([0, chunk[0], chunk[1], chunk[2]]) >> 8) as f32 / 8_388_608.0,
            (_, 32) => i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f32 / 2_147_483_648.0,
            _ => 0.0,
        }
    };
    if !matches!((tag, bits), (1, 8 | 16 | 24 | 32) | (3, 32)) {
        return Err(format!("Unsupported WAV encoding ({tag}, {bits} bits)"));
    }
    let frame = width * usize::from(channels);
    Ok(data
        .chunks_exact(frame)
        .map(|frame| frame.chunks_exact(width).map(sample).sum::<f32>() / f32::from(channels))
        .collect())
}

/// Signed 16-bit little-endian PCM, as the speech services answer.
pub fn from_pcm16(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(2).map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(tag: u16, channels: u16, rate: u32, bits: u16, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * u32::from(channels) * u32::from(bits / 8)).to_le_bytes());
        out.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        out.extend_from_slice(&bits.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn reads_integer_and_float_wavs_and_mixes_to_mono() {
        let pcm: Vec<u8> = [16_384i16, -16_384].iter().flat_map(|v| v.to_le_bytes()).collect();
        let (samples, rate) = parse(&wav(1, 1, 22_050, 16, &pcm)).unwrap();
        assert_eq!(rate, 22_050);
        assert_eq!(samples, vec![0.5, -0.5]);

        let stereo: Vec<u8> = [0.5f32, 0.25].iter().flat_map(|v| v.to_le_bytes()).collect();
        let (samples, _) = parse(&wav(3, 2, 48_000, 32, &stereo)).unwrap();
        assert_eq!(samples, vec![0.375]);

        assert!(parse(b"not a wav").is_err());
    }
}
