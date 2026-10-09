//! Telling voices apart: a speaker embedding per stretch of speech (sherpa-onnx's C API, CAM++),
//! clustered here into Persona 1, Persona 2… and matched against the voices the user saved.
//!
//! **Why not the diarization pipeline sherpa-onnx ships.** It takes the whole recording at once —
//! two hours of one channel is 460 MB of floats — and the laptops this has to run on beside a call
//! have eight. Here the channel is read a window at a time: the detector finds speech, each stretch
//! is cut into [`WINDOW_MS`] windows, each window becomes a 192-number embedding, and only the
//! embeddings (a few megabytes for two hours) are kept and clustered. What it gives up is
//! pyannote's frame-level change detection inside a stretch; a turn change is placed to the nearest
//! window instead, and words are assigned to the window they fall in.
//!
//! **Clustering** is agglomerative with average linkage on cosine similarity: every window starts
//! alone, the two most similar clusters merge, until the best pair is less similar than
//! [`MERGE_THRESHOLD`] — or, when the user said how many people there were, until that many are
//! left. A long meeting is clustered on an even sample of windows and the rest assigned to the
//! nearest centroid, which keeps the work quadratic in [`MAX_CLUSTERED`], not in the meeting.

use std::ffi::{c_char, c_void, CString};
use std::path::Path;
use std::sync::OnceLock;

use libloading::Library;

/// One window of speech an embedding is taken over.
pub const WINDOW_MS: i64 = 2_000;
/// Windows start this far apart inside a stretch.
pub const HOP_MS: i64 = 1_000;
/// Stretches shorter than this have no reliable voice; their words take a neighbour's speaker.
pub const SHORTEST_MS: i64 = 700;
/// Average cosine similarity below which two clusters stay apart. CAM++ puts the same voice well
/// above it and different voices well below; tuned on synthetic Spanish voices.
pub const MERGE_THRESHOLD: f32 = 0.45;
/// How sure a match with a saved voice must be before its name is used.
pub const MATCH_THRESHOLD: f32 = 0.55;
/// The most windows clustered directly.
const MAX_CLUSTERED: usize = 1_500;

#[repr(C)]
struct ExtractorConfig {
    model: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}

type CreateFn = unsafe extern "C" fn(*const ExtractorConfig) -> *const c_void;
type DestroyFn = unsafe extern "C" fn(*const c_void);
type DimFn = unsafe extern "C" fn(*const c_void) -> i32;
type StreamFn = unsafe extern "C" fn(*const c_void) -> *const c_void;
type AcceptFn = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type ReadyFn = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type ComputeFn = unsafe extern "C" fn(*const c_void, *const c_void) -> *const f32;
type FreeEmbeddingFn = unsafe extern "C" fn(*const f32);

struct Api {
    _library: Library,
    create: CreateFn,
    destroy: DestroyFn,
    dim: DimFn,
    stream: StreamFn,
    accept: AcceptFn,
    finished: DestroyFn,
    ready: ReadyFn,
    compute: ComputeFn,
    free_embedding: FreeEmbeddingFn,
    destroy_stream: DestroyFn,
}

// SAFETY: plain C entry points; the library handle is only kept alive.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Api> = OnceLock::new();

fn load(path: &Path) -> Result<Api, String> {
    // SAFETY: the library is the pinned sherpa-onnx build `super` verified and unpacked.
    unsafe {
        #[cfg(windows)]
        let library = libloading::os::windows::Library::load_with_flags(path, 0x100 | 0x1000).map(Library::from);
        #[cfg(not(windows))]
        let library = Library::new(path);
        let library = library.map_err(|e| format!("Couldn't load the voice separation library ({}): {e}", path.display()))?;
        macro_rules! symbol {
            ($name:literal, $ty:ty) => {
                *library.get::<$ty>(concat!($name, "\0").as_bytes()).map_err(|e| format!("The voice library has no {}: {e}", $name))?
            };
        }
        Ok(Api {
            create: symbol!("SherpaOnnxCreateSpeakerEmbeddingExtractor", CreateFn),
            destroy: symbol!("SherpaOnnxDestroySpeakerEmbeddingExtractor", DestroyFn),
            dim: symbol!("SherpaOnnxSpeakerEmbeddingExtractorDim", DimFn),
            stream: symbol!("SherpaOnnxSpeakerEmbeddingExtractorCreateStream", StreamFn),
            accept: symbol!("SherpaOnnxOnlineStreamAcceptWaveform", AcceptFn),
            finished: symbol!("SherpaOnnxOnlineStreamInputFinished", DestroyFn),
            ready: symbol!("SherpaOnnxSpeakerEmbeddingExtractorIsReady", ReadyFn),
            compute: symbol!("SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding", ComputeFn),
            free_embedding: symbol!("SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding", FreeEmbeddingFn),
            destroy_stream: symbol!("SherpaOnnxDestroyOnlineStream", DestroyFn),
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

/// The embedding model, loaded. One per job; not shared between threads.
pub struct Extractor {
    handle: *const c_void,
    pub dim: usize,
}

// SAFETY: used through `&self` by one thread at a time (each job owns its own).
unsafe impl Send for Extractor {}

/// Loads the library from `path` instead of the installed one — for the live tests.
#[cfg(test)]
pub fn load_library_for_test(path: &Path) {
    API.get_or_init(|| load(path).expect("the voice library loads"));
}

impl Extractor {
    pub fn load_from(model: &Path, threads: i32) -> Result<Extractor, String> {
        let api = api()?;
        if !model.is_file() {
            return Err("The voice model is not installed — Settings › Voice & sound › Meetings".into());
        }
        let path = CString::new(model.to_string_lossy().as_bytes()).map_err(|_| "The model's path has a NUL byte".to_string())?;
        let provider = c"cpu";
        let config = ExtractorConfig { model: path.as_ptr(), num_threads: threads.clamp(1, 4), debug: 0, provider: provider.as_ptr() };
        // SAFETY: the config and the strings it points at outlive the call.
        let handle = unsafe { (api.create)(&config) };
        if handle.is_null() {
            return Err(format!("The voice model could not be loaded ({})", model.display()));
        }
        // SAFETY: a live extractor.
        let dim = unsafe { (api.dim)(handle) }.max(0) as usize;
        Ok(Extractor { handle, dim })
    }

    /// The embedding of `samples` (16 kHz mono), normalised to unit length — `None` for audio too
    /// short to carry a voice.
    pub fn embed(&self, samples: &[f32]) -> Result<Option<Vec<f32>>, String> {
        let api = api()?;
        // SAFETY: the stream is made, fed, read and destroyed here; the embedding is copied out
        // before it is freed.
        unsafe {
            let stream = (api.stream)(self.handle);
            if stream.is_null() {
                return Err("The voice model could not start".into());
            }
            (api.accept)(stream, super::audio::RATE as i32, samples.as_ptr(), samples.len() as i32);
            (api.finished)(stream);
            let mut out = None;
            if (api.ready)(self.handle, stream) != 0 {
                let raw = (api.compute)(self.handle, stream);
                if !raw.is_null() {
                    let mut vector = std::slice::from_raw_parts(raw, self.dim).to_vec();
                    (api.free_embedding)(raw);
                    normalise(&mut vector);
                    out = Some(vector);
                }
            }
            (api.destroy_stream)(stream);
            Ok(out)
        }
    }
}

impl Drop for Extractor {
    fn drop(&mut self) {
        if let Some(api) = API.get() {
            // SAFETY: made by `create`, destroyed once.
            unsafe { (api.destroy)(self.handle) };
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------------------------

pub fn normalise(vector: &mut [f32]) {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        vector.iter_mut().for_each(|v| *v /= norm);
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// The mean of `vectors`, normalised.
pub fn centroid<'a>(vectors: impl IntoIterator<Item = &'a [f32]>) -> Option<Vec<f32>> {
    let mut sum: Option<Vec<f32>> = None;
    for vector in vectors {
        match &mut sum {
            Some(total) => total.iter_mut().zip(vector).for_each(|(t, v)| *t += v),
            None => sum = Some(vector.to_vec()),
        }
    }
    let mut mean = sum?;
    normalise(&mut mean);
    Some(mean)
}

/// One embedded window on a channel's timeline.
#[derive(Debug, Clone)]
pub struct Window {
    pub start_ms: i64,
    pub end_ms: i64,
    pub embedding: Vec<f32>,
}

/// The windows an utterance or stretch is embedded over: `WINDOW_MS` long, `HOP_MS` apart, the
/// last one ending where the stretch ends. A stretch shorter than a window is one window.
pub fn windows_of(start_ms: i64, end_ms: i64) -> Vec<(i64, i64)> {
    let length = end_ms - start_ms;
    if length < SHORTEST_MS {
        return Vec::new();
    }
    if length <= WINDOW_MS {
        return vec![(start_ms, end_ms)];
    }
    let mut out = Vec::new();
    let mut at = start_ms;
    while at + WINDOW_MS < end_ms {
        out.push((at, at + WINDOW_MS));
        at += HOP_MS;
    }
    out.push((end_ms - WINDOW_MS, end_ms));
    out
}

/// A label per vector. `expected` > 0 stops at that many clusters; otherwise merging stops below
/// [`MERGE_THRESHOLD`]. Labels are numbered by first appearance, so "Persona 1" is whoever spoke
/// first.
pub fn cluster(vectors: &[Vec<f32>], expected: usize) -> Vec<usize> {
    if vectors.is_empty() {
        return Vec::new();
    }
    // An even sample when there are too many to cluster directly; the rest join the nearest.
    let sampled: Vec<usize> = if vectors.len() > MAX_CLUSTERED {
        let step = vectors.len() as f64 / MAX_CLUSTERED as f64;
        (0..MAX_CLUSTERED).map(|i| ((i as f64) * step) as usize).collect()
    } else {
        (0..vectors.len()).collect()
    };
    let n = sampled.len();
    // Similarity sums between clusters (average linkage = sum / (|a|·|b|)).
    let mut sums = vec![0f32; n * n];
    for i in 0..n {
        for j in (i + 1)..n {
            let s = cosine(&vectors[sampled[i]], &vectors[sampled[j]]);
            sums[i * n + j] = s;
            sums[j * n + i] = s;
        }
    }
    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut alive: Vec<bool> = vec![true; n];
    let mut count = n;
    loop {
        if count <= 1 || (expected > 0 && count <= expected) {
            break;
        }
        let mut best: Option<(usize, usize, f32)> = None;
        for i in 0..n {
            if !alive[i] {
                continue;
            }
            for j in (i + 1)..n {
                if !alive[j] {
                    continue;
                }
                let average = sums[i * n + j] / (members[i].len() * members[j].len()) as f32;
                if best.is_none_or(|(_, _, b)| average > b) {
                    best = Some((i, j, average));
                }
            }
        }
        let Some((i, j, average)) = best else { break };
        if expected == 0 && average < MERGE_THRESHOLD {
            break;
        }
        // Merge j into i: sums with every other cluster add up.
        for k in 0..n {
            if k != i && k != j && alive[k] {
                let combined = sums[i * n + k] + sums[j * n + k];
                sums[i * n + k] = combined;
                sums[k * n + i] = combined;
            }
        }
        let moved = std::mem::take(&mut members[j]);
        members[i].extend(moved);
        alive[j] = false;
        count -= 1;
    }
    // Centroids of the surviving clusters, then every vector to its nearest.
    let clusters: Vec<Vec<f32>> = (0..n)
        .filter(|&i| alive[i])
        .filter_map(|i| centroid(members[i].iter().map(|&m| vectors[sampled[m]].as_slice())))
        .collect();
    let raw: Vec<usize> = vectors
        .iter()
        .map(|vector| {
            clusters
                .iter()
                .enumerate()
                .map(|(index, c)| (index, cosine(vector, c)))
                .fold((0, f32::MIN), |best, (index, s)| if s > best.1 { (index, s) } else { best })
                .0
        })
        .collect();
    renumber(&raw)
}

/// Labels renumbered by first appearance.
pub fn renumber(labels: &[usize]) -> Vec<usize> {
    let mut map = std::collections::HashMap::new();
    labels
        .iter()
        .map(|label| {
            let next = map.len();
            *map.entry(*label).or_insert(next)
        })
        .collect()
}

/// Smooths a run of labels in time: a window whose neighbours on both sides agree with each other
/// and not with it is an outlier — one cough in another voice's cluster — and takes theirs.
pub fn smooth(labels: &mut [usize]) {
    if labels.len() < 3 {
        return;
    }
    for index in 1..labels.len() - 1 {
        if labels[index - 1] == labels[index + 1] && labels[index] != labels[index - 1] {
            labels[index] = labels[index - 1];
        }
    }
}

/// Which saved voice each cluster centroid is, if any: greedy best-first, one voice per cluster
/// and one cluster per voice, nothing below [`MATCH_THRESHOLD`].
pub fn match_voices(centroids: &[Vec<f32>], voices: &[(String, Vec<f32>)]) -> Vec<Option<String>> {
    let mut pairs: Vec<(usize, usize, f32)> = Vec::new();
    for (c, centroid) in centroids.iter().enumerate() {
        for (v, (_, voice)) in voices.iter().enumerate() {
            let similarity = cosine(centroid, voice);
            if similarity >= MATCH_THRESHOLD {
                pairs.push((c, v, similarity));
            }
        }
    }
    pairs.sort_by(|a, b| b.2.total_cmp(&a.2));
    let mut out = vec![None; centroids.len()];
    let mut used = vec![false; voices.len()];
    for (c, v, _) in pairs {
        if out[c].is_none() && !used[v] {
            out[c] = Some(voices[v].0.clone());
            used[v] = true;
        }
    }
    out
}

/// Online clustering for the live text: an utterance's embedding joins the closest speaker seen so
/// far when it is close enough, or starts a new one. Cheap and often wrong — the final pass
/// replaces it.
#[derive(Default)]
pub struct Live {
    speakers: Vec<(Vec<f32>, usize)>,
}

impl Live {
    pub fn assign(&mut self, embedding: &[f32]) -> usize {
        let best = self
            .speakers
            .iter()
            .enumerate()
            .map(|(index, (c, _))| (index, cosine(embedding, c)))
            .fold(None::<(usize, f32)>, |best, (index, s)| match best {
                Some((_, b)) if b >= s => best,
                _ => Some((index, s)),
            });
        match best {
            Some((index, similarity)) if similarity >= MERGE_THRESHOLD => {
                let (centre, count) = &mut self.speakers[index];
                let n = *count as f32;
                centre.iter_mut().zip(embedding).for_each(|(c, e)| *c = (*c * n + e) / (n + 1.0));
                normalise(centre);
                *count += 1;
                index
            }
            _ => {
                self.speakers.push((embedding.to_vec(), 1));
                self.speakers.len() - 1
            }
        }
    }
}

/// An embedding as the bytes a BLOB column holds (little-endian f32).
pub fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn from_blob(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice(seed: f32, noise: f32) -> Vec<f32> {
        let mut v: Vec<f32> = (0..16).map(|i| ((i as f32 + 1.0) * seed).sin() + noise * ((i as f32) * 7.3 + seed * 3.1).cos()).collect();
        normalise(&mut v);
        v
    }

    #[test]
    fn windows_cover_a_stretch_and_skip_a_cough() {
        assert!(windows_of(0, 500).is_empty());
        assert_eq!(windows_of(1_000, 2_500), vec![(1_000, 2_500)]);
        assert_eq!(windows_of(0, 3_500), vec![(0, 2_000), (1_000, 3_000), (1_500, 3_500)]);
    }

    #[test]
    fn three_voices_make_three_people_numbered_by_who_spoke_first() {
        let mut vectors = Vec::new();
        for turn in [2.0f32, 5.0, 2.0, 9.0, 5.0] {
            for k in 0..4 {
                vectors.push(voice(turn, 0.05 * k as f32));
            }
        }
        let labels = cluster(&vectors, 0);
        assert_eq!(labels[0], 0);
        assert_eq!(labels[4], 1);
        assert_eq!(labels[8], 0);
        assert_eq!(labels[12], 2);
        assert_eq!(labels[16], 1);
        assert_eq!(*labels.iter().max().unwrap(), 2);
        // Told there were two, it makes two.
        assert_eq!(*cluster(&vectors, 2).iter().max().unwrap(), 1);
    }

    #[test]
    fn an_outlier_between_agreeing_neighbours_takes_their_label() {
        let mut labels = vec![0, 0, 1, 0, 2, 2, 0];
        smooth(&mut labels);
        assert_eq!(labels, vec![0, 0, 0, 0, 2, 2, 0]);
    }

    #[test]
    fn saved_voices_match_one_to_one() {
        let maria = voice(2.0, 0.0);
        let juan = voice(9.0, 0.0);
        let centroids = vec![voice(9.0, 0.02), voice(2.0, 0.02), voice(5.0, 0.0)];
        let matched = match_voices(&centroids, &[("María".into(), maria), ("Juan".into(), juan)]);
        assert_eq!(matched, vec![Some("Juan".into()), Some("María".into()), None]);
    }

    #[test]
    fn live_clustering_keeps_a_voice_together() {
        let mut live = Live::default();
        assert_eq!(live.assign(&voice(2.0, 0.0)), 0);
        assert_eq!(live.assign(&voice(9.0, 0.0)), 1);
        assert_eq!(live.assign(&voice(2.0, 0.05)), 0);
    }

    #[test]
    fn blobs_round_trip() {
        let v = vec![0.5f32, -1.25, 3.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
    }

    /// The real library and model: `CODEFLOW_TEST_SHERPA=<library>:<model>:<wav a>:<wav b>` — two
    /// clips of different voices (16 kHz mono WAV). The same voice must be closer to itself than to
    /// the other.
    #[test]
    #[ignore]
    fn real_embeddings_tell_two_voices_apart() {
        let spec = std::env::var("CODEFLOW_TEST_SHERPA").expect("CODEFLOW_TEST_SHERPA=<lib>:<model>:<a.wav>:<b.wav>");
        let parts: Vec<&str> = spec.split(':').collect();
        load_library_for_test(Path::new(parts[0]));
        let extractor = Extractor::load_from(Path::new(parts[1]), 2).expect("the model loads");
        let a = super::super::audio::read_wav(Path::new(parts[2])).unwrap();
        let b = super::super::audio::read_wav(Path::new(parts[3])).unwrap();
        let half = |s: &[f32]| (s[..s.len() / 2].to_vec(), s[s.len() / 2..].to_vec());
        let (a1, a2) = half(&a);
        let (b1, _) = half(&b);
        let ea1 = extractor.embed(&a1).unwrap().unwrap();
        let ea2 = extractor.embed(&a2).unwrap().unwrap();
        let eb1 = extractor.embed(&b1).unwrap().unwrap();
        let same = cosine(&ea1, &ea2);
        let other = cosine(&ea1, &eb1);
        eprintln!("dim {} same {same:.3} other {other:.3}", extractor.dim);
        assert!(same > other + 0.1, "same {same} other {other}");
    }
}
