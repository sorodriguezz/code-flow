//! Where one voice hands over to another inside a stretch of speech — what the windowed separation
//! in `super::speaker` cannot see by itself, and what WhisperX is known for. The user asked for
//! "transcribir reuniones de varias personas" with WhisperX's quality and chose, on 2026-10-21, to
//! get it natively: pyannote's segmentation model (3.0, MIT, in ONNX from sherpa-onnx's release)
//! run through sherpa-onnx's offline diarization on the stretch alone.
//!
//! **Only the change points are taken.** Who is who is still decided over the whole meeting by
//! `speaker::cluster`; this only cuts a stretch where the speaker changes, so no 2-second window
//! straddles two voices. It runs on at most [`CHUNK_MS`] at a time, so a two-hour meeting never
//! has its channel in memory at once — the reason the full pipeline was not used (see `speaker`).

use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::Library;

/// The model: pyannote/segmentation-3.0 as sherpa-onnx exports it (int8).
pub const MODEL_ARCHIVE: crate::meetings::ModelFile = crate::meetings::ModelFile {
    file: "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    size: 6_958_444,
    sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
};

pub fn model_path() -> PathBuf {
    super::models_root().join("pyannote-segmentation-3-0.int8.onnx")
}

/// The archive's int8 model into [`model_path`] (the rest — scripts, a float copy — stays out).
pub fn unpack(archive: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    let target = model_path();
    let staging = target.with_extension("unpacking");
    for entry in tar.entries().map_err(|e| format!("The model archive is damaged: {e}"))? {
        let mut entry = entry.map_err(|e| format!("The model archive is damaged: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if path.file_name().and_then(|n| n.to_str()) == Some("model.int8.onnx") {
            let mut out = std::fs::File::create(&staging).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            return std::fs::rename(&staging, &target).map_err(|e| e.to_string());
        }
    }
    Err("The model archive has no model.int8.onnx".into())
}

/// The longest piece of audio handed to the model at once.
pub const CHUNK_MS: i64 = 60_000;
/// A side of a cut shorter than this is not a turn — a "sí" over someone else is left to the
/// smoothing.
const SHORTEST_SIDE_MS: i64 = 400;

#[repr(C)]
struct SegmentationConfig {
    model: *const c_char,
    window_shift_ratio: f32,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}

#[repr(C)]
struct EmbeddingConfig {
    model: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}

#[repr(C)]
struct ClusteringConfig {
    num_clusters: i32,
    threshold: f32,
    compute_confidence: i32,
}

/// `SherpaOnnxOfflineSpeakerDiarizationConfig` (80 bytes in v1.13.8, checked with `sizeof`).
#[repr(C)]
struct DiarizationConfig {
    segmentation: SegmentationConfig,
    embedding: EmbeddingConfig,
    clustering: ClusteringConfig,
    min_duration_on: f32,
    min_duration_off: f32,
}

const _: () = assert!(std::mem::size_of::<DiarizationConfig>() == 80);

#[repr(C)]
struct Segment {
    start: f32,
    end: f32,
    speaker: i32,
    _confidence: f32,
}

type CreateFn = unsafe extern "C" fn(*const DiarizationConfig) -> *const c_void;
type DestroyFn = unsafe extern "C" fn(*const c_void);
type ProcessFn = unsafe extern "C" fn(*const c_void, *const f32, i32) -> *const c_void;
type CountFn = unsafe extern "C" fn(*const c_void) -> i32;
type SortFn = unsafe extern "C" fn(*const c_void) -> *const Segment;
type DestroySegmentFn = unsafe extern "C" fn(*const Segment);

struct Api {
    _library: Library,
    create: CreateFn,
    destroy: DestroyFn,
    process: ProcessFn,
    count: CountFn,
    sorted: SortFn,
    destroy_segments: DestroySegmentFn,
    destroy_result: DestroyFn,
}

// SAFETY: plain C entry points; the library handle is only kept alive.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Api> = OnceLock::new();

fn load(path: &Path) -> Result<Api, String> {
    // SAFETY: the pinned sherpa-onnx build meetings verified and unpacked.
    unsafe {
        #[cfg(windows)]
        let library = libloading::os::windows::Library::load_with_flags(path, 0x100 | 0x1000).map(Library::from);
        #[cfg(not(windows))]
        let library = Library::new(path);
        let library = library.map_err(|e| format!("Couldn't load the voice library ({}): {e}", path.display()))?;
        macro_rules! symbol {
            ($name:literal, $ty:ty) => {
                *library.get::<$ty>(concat!($name, "\0").as_bytes()).map_err(|e| format!("The voice library has no {}: {e}", $name))?
            };
        }
        Ok(Api {
            create: symbol!("SherpaOnnxCreateOfflineSpeakerDiarization", CreateFn),
            destroy: symbol!("SherpaOnnxDestroyOfflineSpeakerDiarization", DestroyFn),
            process: symbol!("SherpaOnnxOfflineSpeakerDiarizationProcess", ProcessFn),
            count: symbol!("SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments", CountFn),
            sorted: symbol!("SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime", SortFn),
            destroy_segments: symbol!("SherpaOnnxOfflineSpeakerDiarizationDestroySegment", DestroySegmentFn),
            destroy_result: symbol!("SherpaOnnxOfflineSpeakerDiarizationDestroyResult", DestroyFn),
            _library: library,
        })
    }
}

fn api() -> Result<&'static Api, String> {
    if let Some(api) = API.get() {
        return Ok(api);
    }
    let path = super::sherpa_library().ok_or("Voice separation is not installed — Settings › Voice & sound › Meetings")?;
    let loaded = load(&path)?;
    Ok(API.get_or_init(|| loaded))
}

#[cfg(test)]
pub fn load_library_for_test(path: &Path) {
    API.get_or_init(|| load(path).expect("the voice library loads"));
}

/// The segmentation model and CAM++ (for its own clustering of each piece), loaded.
pub struct Turns {
    handle: *const c_void,
}

// SAFETY: used by the one job that owns it.
unsafe impl Send for Turns {}

impl Turns {
    pub fn load(segmentation: &Path, embedding: &Path, threads: i32) -> Result<Turns, String> {
        let api = api()?;
        let segmentation = CString::new(segmentation.to_string_lossy().as_bytes()).map_err(|_| "NUL in a path".to_string())?;
        let embedding = CString::new(embedding.to_string_lossy().as_bytes()).map_err(|_| "NUL in a path".to_string())?;
        let provider = c"cpu";
        let config = DiarizationConfig {
            segmentation: SegmentationConfig { model: segmentation.as_ptr(), window_shift_ratio: 0.1, num_threads: threads.clamp(1, 4), debug: 0, provider: provider.as_ptr() },
            embedding: EmbeddingConfig { model: embedding.as_ptr(), num_threads: threads.clamp(1, 4), debug: 0, provider: provider.as_ptr() },
            // Its own clustering only tells the voices of one piece apart; the meeting's are
            // decided later, over every window.
            clustering: ClusteringConfig { num_clusters: -1, threshold: 0.5, compute_confidence: 0 },
            min_duration_on: 0.3,
            min_duration_off: 0.5,
        };
        // SAFETY: the config and its strings outlive the call.
        let handle = unsafe { (api.create)(&config) };
        if handle.is_null() {
            return Err("The turn detector could not be loaded".into());
        }
        Ok(Turns { handle })
    }

    /// The turns in `samples` (16 kHz mono): `(start_ms, end_ms, speaker)`, the speaker numbered
    /// within this piece only.
    pub fn of(&self, samples: &[f32]) -> Result<Vec<(i64, i64, i32)>, String> {
        let api = api()?;
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        // SAFETY: the samples outlive the call; the segments are copied out before they are freed.
        unsafe {
            let result = (api.process)(self.handle, samples.as_ptr(), samples.len() as i32);
            if result.is_null() {
                return Err("The turn detector failed".into());
            }
            let count = (api.count)(result).max(0) as usize;
            let segments = (api.sorted)(result);
            let mut out = Vec::with_capacity(count);
            if !segments.is_null() {
                for segment in std::slice::from_raw_parts(segments, count) {
                    out.push(((segment.start * 1000.0) as i64, (segment.end * 1000.0) as i64, segment.speaker));
                }
                (api.destroy_segments)(segments);
            }
            (api.destroy_result)(result);
            Ok(out)
        }
    }
}

impl Drop for Turns {
    fn drop(&mut self) {
        if let Some(api) = API.get() {
            // SAFETY: made by `create`, destroyed once.
            unsafe { (api.destroy)(self.handle) };
        }
    }
}

/// Where the speaker changes inside `turns` — the start of each turn whose speaker is not the one
/// before it.
pub fn changes(turns: &[(i64, i64, i32)]) -> Vec<i64> {
    turns.windows(2).filter(|pair| pair[0].2 != pair[1].2).map(|pair| (pair[0].1 + pair[1].0) / 2).collect()
}

/// `stretches` (ms, sorted) cut at `points` wherever both sides keep at least [`SHORTEST_SIDE_MS`].
pub fn split(stretches: &[(i64, i64)], points: &[i64]) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    for &(start, end) in stretches {
        let mut from = start;
        for &point in points.iter().filter(|p| **p > start && **p < end) {
            if point - from >= SHORTEST_SIDE_MS && end - point >= SHORTEST_SIDE_MS {
                out.push((from, point));
                from = point;
            }
        }
        out.push((from, end));
    }
    out
}

/// `stretches` of `audio` cut where the speaker changes, read [`CHUNK_MS`] at a time.
#[cfg(test)]
pub fn split_stretches(turns: &Turns, audio: &[f32], stretches: &[(i64, i64)]) -> Result<Vec<(i64, i64)>, String> {
    let rate = super::audio::RATE as i64;
    split_reading(turns, stretches, |start, end| {
        let from = ((start * rate) / 1000).clamp(0, audio.len() as i64) as usize;
        let to = ((end * rate) / 1000).clamp(0, audio.len() as i64) as usize;
        Ok(audio[from..to].to_vec())
    })
}

/// [`split_stretches`] reading the channel through `span(start_ms, end_ms)` — forward only, a chunk
/// at a time, as the pipeline reads its pieces from disk.
pub fn split_reading(turns: &Turns, stretches: &[(i64, i64)], mut span: impl FnMut(i64, i64) -> Result<Vec<f32>, String>) -> Result<Vec<(i64, i64)>, String> {
    let mut points = Vec::new();
    let mut index = 0;
    while index < stretches.len() {
        let chunk_start = stretches[index].0;
        let mut chunk_end = stretches[index].1;
        let mut next = index + 1;
        while next < stretches.len() && stretches[next].1 - chunk_start <= CHUNK_MS {
            chunk_end = stretches[next].1;
            next += 1;
        }
        let local = turns.of(&span(chunk_start, chunk_end)?)?;
        points.extend(changes(&local).into_iter().map(|p| p + chunk_start));
        index = next;
    }
    Ok(split(stretches, &points))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stretch_is_cut_only_where_both_sides_are_turns() {
        let stretches = vec![(0, 10_000), (12_000, 13_000)];
        assert_eq!(split(&stretches, &[4_000, 9_800, 12_300]), vec![(0, 4_000), (4_000, 10_000), (12_000, 13_000)]);
        assert_eq!(split(&stretches, &[12_500]), vec![(0, 10_000), (12_000, 12_500), (12_500, 13_000)]);
        assert_eq!(changes(&[(0, 1_000, 0), (1_100, 2_000, 0), (2_200, 3_000, 1)]), vec![2_100]);
    }

    /// The measurement behind turning this on: a synthetic meeting (three voices, 24 turns, half of
    /// them 0.15 s apart — inside one stretch) separated the way `pipeline` does, with and without the
    /// cut. `CODEFLOW_TEST_TURNS=<library>|<segmentation model>|<CAM++ model>|<conv.wav>|<truth.json>`.
    #[test]
    #[ignore]
    fn cutting_at_turns_separates_quick_exchanges() {
        use super::super::speaker;
        let spec = std::env::var("CODEFLOW_TEST_TURNS").expect("CODEFLOW_TEST_TURNS=<lib>|<seg>|<campp>|<wav>|<truth>");
        let parts: Vec<&str> = spec.split('|').collect();
        load_library_for_test(Path::new(parts[0]));
        speaker::load_library_for_test(Path::new(parts[0]));
        let bytes = std::fs::read(parts[3]).unwrap();
        let at = bytes.windows(4).position(|w| w == b"data").unwrap() + 8;
        let audio: Vec<f32> = bytes[at..].chunks_exact(2).map(|p| f32::from(i16::from_le_bytes([p[0], p[1]])) / 32768.0).collect();
        let truth: Vec<(f64, f64, usize)> = serde_json::from_str(&std::fs::read_to_string(parts[4]).unwrap()).unwrap();
        // What the voice detector makes of it: turns closer than half a second are one stretch.
        let mut stretches: Vec<(i64, i64)> = Vec::new();
        for (start, end, _) in &truth {
            let (start, end) = ((start * 1000.0) as i64, (end * 1000.0) as i64);
            match stretches.last_mut() {
                Some(last) if start - last.1 < 500 => last.1 = end,
                _ => stretches.push((start, end)),
            }
        }
        let extractor = speaker::Extractor::load_from(Path::new(parts[2]), 2).unwrap();
        let separate = |stretches: &[(i64, i64)]| -> f64 {
            let mut windows = Vec::new();
            for &(start, end) in stretches {
                for (from, to) in speaker::windows_of(start, end) {
                    let slice = &audio[(from * 16) as usize..((to * 16) as usize).min(audio.len())];
                    if let Some(embedding) = extractor.embed(slice).unwrap() {
                        windows.push((from, to, embedding));
                    }
                }
            }
            let vectors: Vec<Vec<f32>> = windows.iter().map(|w| w.2.clone()).collect();
            let mut labels = speaker::cluster(&vectors, 0);
            speaker::smooth(&mut labels);
            // Each 100 ms of speech: the window covering its middle gives the label; a cluster is
            // read as the truth's speaker it overlaps most (purity), and the frames agreeing count.
            let mut votes = std::collections::HashMap::<(usize, usize), usize>::new();
            let mut frames = Vec::new();
            for (start, end, who) in &truth {
                let mut t = (start * 1000.0) as i64;
                while t < (end * 1000.0) as i64 {
                    if let Some(index) = windows.iter().position(|w| w.0 <= t && t < w.1) {
                        *votes.entry((labels[index], *who)).or_default() += 1;
                        frames.push((labels[index], *who));
                    }
                    t += 100;
                }
            }
            let best = |label: usize| (0..3).max_by_key(|who| votes.get(&(label, *who)).copied().unwrap_or(0)).unwrap();
            let right = frames.iter().filter(|(label, who)| best(*label) == *who).count();
            right as f64 / frames.len().max(1) as f64
        };
        let before = separate(&stretches);
        let turns = Turns::load(Path::new(parts[1]), Path::new(parts[2]), 2).unwrap();
        let started = std::time::Instant::now();
        let cut = split_stretches(&turns, &audio, &stretches).unwrap();
        let took = started.elapsed();
        let after = separate(&cut);
        eprintln!("{} stretches → {} after cutting ({took:?}); right frames {:.1} % → {:.1} %", stretches.len(), cut.len(), before * 100.0, after * 100.0);
        assert!(after >= before, "cutting made it worse: {before} → {after}");
    }
}
