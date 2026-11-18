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
//! left ([`cluster_guided`]). A long meeting is clustered on an even sample of windows and the rest
//! assigned to the nearest centroid, which keeps the work quadratic in [`MAX_CLUSTERED`], not in the
//! meeting.
//!
//! **Who the user said was there.** A count is honoured as people, not as groups: a group needs
//! [`MIN_PERSON_WINDOWS`] of speech to count as one. Stopping at "eight groups" used to leave a
//! cough or a burst of noise as one of the eight while two real voices were merged to make room —
//! and the cough's group then vanished in [`smooth`], so eight came out as six. The voices the user
//! named as present are anchors: each joins the clustering as one more member, two anchors never
//! merge, and the group an anchor ends in is that person — named however far below
//! [`MATCH_THRESHOLD`] the match is, because the user said they were there.

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
/// The fewest windows (about five seconds of speech, a window every second) a group needs to count
/// as one of the people the user said there were. A group a named voice anchors needs one.
pub const MIN_PERSON_WINDOWS: usize = 4;
/// The least similarity a named voice needs with a group's speech to join it. Below it the voice
/// stays alone and comes back as not heard — a voice the user ticked by mistake must not put its
/// name on a stranger. Well under [`MATCH_THRESHOLD`]: the user said this person was there, and the
/// same voice across meetings (another microphone, another room) drifts.
pub const ANCHOR_JOIN: f32 = 0.30;

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

/// A label per vector. `expected` > 0 stops at that many people; otherwise merging stops below
/// [`MERGE_THRESHOLD`]. Labels are numbered by first appearance, so "Persona 1" is whoever spoke
/// first. Only the tests call it now — the pipeline always goes through [`cluster_guided`].
#[cfg(test)]
pub fn cluster(vectors: &[Vec<f32>], expected: usize) -> Vec<usize> {
    cluster_guided(vectors, expected, &[]).labels
}

/// What [`cluster_guided`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct Guided {
    /// A label per vector, numbered by first appearance.
    pub labels: Vec<usize>,
    /// Per anchor, the label of the person it is — `None` when no speech was found for that voice.
    pub anchors: Vec<Option<usize>>,
}

/// [`cluster`] with the voices the user said were there as `anchors` (saved embeddings): each is one
/// more member of the clustering, never merged with another anchor, and comes back with the label
/// of the person it ended in.
///
/// With `expected` > 0, a group counts as a person once it holds [`MIN_PERSON_WINDOWS`] windows (one,
/// for an anchored group). Two people merge only while there are more than `expected`; a group too
/// small to be a person always may merge, into whoever it is closest to — so it ends inside a person
/// instead of standing in for one.
pub fn cluster_guided(vectors: &[Vec<f32>], expected: usize, anchors: &[Vec<f32>]) -> Guided {
    if vectors.is_empty() {
        return Guided { labels: Vec::new(), anchors: vec![None; anchors.len()] };
    }
    // An even sample when there are too many to cluster directly; the rest join the nearest.
    let sampled: Vec<usize> = if vectors.len() > MAX_CLUSTERED {
        let step = vectors.len() as f64 / MAX_CLUSTERED as f64;
        (0..MAX_CLUSTERED).map(|i| ((i as f64) * step) as usize).collect()
    } else {
        (0..vectors.len()).collect()
    };
    let windows = sampled.len();
    let items: Vec<&[f32]> = sampled.iter().map(|&i| vectors[i].as_slice()).chain(anchors.iter().map(Vec::as_slice)).collect();
    let n = items.len();
    // Similarity sums between clusters (average linkage = sum / (|a|·|b|)).
    let mut sums = vec![0f32; n * n];
    for i in 0..n {
        for j in (i + 1)..n {
            let s = cosine(items[i], items[j]);
            sums[i * n + j] = s;
            sums[j * n + i] = s;
        }
    }
    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut alive: Vec<bool> = vec![true; n];
    // Windows of speech in each cluster (an anchor is not speech), and the anchor it holds.
    let mut speech: Vec<usize> = (0..n).map(|i| usize::from(i < windows)).collect();
    let mut anchor_of: Vec<Option<usize>> = (0..n).map(|i| (i >= windows).then(|| i - windows)).collect();
    let person = |speech: usize, anchor: Option<usize>| speech >= MIN_PERSON_WINDOWS || (anchor.is_some() && speech >= 1);
    loop {
        let people = (0..n).filter(|&i| alive[i] && person(speech[i], anchor_of[i])).count();
        // Enough people: only a group too small to be one may still merge.
        let settled = expected > 0 && people <= expected;
        let mut best: Option<(usize, usize, f32)> = None;
        for i in 0..n {
            if !alive[i] {
                continue;
            }
            for j in (i + 1)..n {
                if !alive[j] || (anchor_of[i].is_some() && anchor_of[j].is_some()) {
                    continue;
                }
                if settled && person(speech[i], anchor_of[i]) && person(speech[j], anchor_of[j]) {
                    continue;
                }
                let average = sums[i * n + j] / (members[i].len() * members[j].len()) as f32;
                // A named voice with no speech yet joins only speech that sounds like it.
                if (speech[i] == 0 || speech[j] == 0) && average < ANCHOR_JOIN {
                    continue;
                }
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
        speech[i] += speech[j];
        anchor_of[i] = anchor_of[i].or(anchor_of[j]);
        alive[j] = false;
    }
    // Centroids of the surviving clusters that hold speech — of the speech alone — then every
    // vector to its nearest.
    let kept: Vec<usize> = (0..n).filter(|&i| alive[i] && speech[i] > 0).collect();
    let clusters: Vec<Vec<f32>> = kept
        .iter()
        .map(|&i| centroid(members[i].iter().filter(|&&m| m < windows).map(|&m| items[m])).unwrap_or_default())
        .collect();
    let raw: Vec<usize> = vectors.iter().map(|vector| nearest(vector, &clusters)).collect();
    let mut anchor_raw: Vec<Option<usize>> = vec![None; anchors.len()];
    for (index, &cluster) in kept.iter().enumerate() {
        if let Some(anchor) = anchor_of[cluster] {
            anchor_raw[anchor] = Some(index);
        }
    }
    let (labels, map) = renumbered(&raw);
    Guided { labels, anchors: anchor_raw.into_iter().map(|a| a.and_then(|a| map.get(&a).copied())).collect() }
}

/// The index of the centroid closest to `vector`.
fn nearest(vector: &[f32], centroids: &[Vec<f32>]) -> usize {
    centroids
        .iter()
        .enumerate()
        .map(|(index, c)| (index, cosine(vector, c)))
        .fold((0, f32::MIN), |best, (index, s)| if s > best.1 { (index, s) } else { best })
        .0
}

/// Labels renumbered by first appearance, and the old label → new label map.
pub fn renumbered(labels: &[usize]) -> (Vec<usize>, std::collections::HashMap<usize, usize>) {
    let mut map = std::collections::HashMap::new();
    let out = labels
        .iter()
        .map(|label| {
            let next = map.len();
            *map.entry(*label).or_insert(next)
        })
        .collect();
    (out, map)
}

/// Smooths a run of labels in time: a window whose neighbours on both sides agree with each other
/// and not with it is an outlier — one cough in another voice's cluster — and takes theirs. A window
/// of a label in `keep` stays: a person the user named may have said one short thing.
pub fn smooth(labels: &mut [usize], keep: &[usize]) {
    if labels.len() < 3 {
        return;
    }
    for index in 1..labels.len() - 1 {
        if labels[index - 1] == labels[index + 1] && labels[index] != labels[index - 1] && !keep.contains(&labels[index]) {
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
        smooth(&mut labels, &[]);
        assert_eq!(labels, vec![0, 0, 0, 0, 2, 2, 0]);
        let mut labels = vec![0, 0, 1, 0, 2, 2, 0];
        smooth(&mut labels, &[1]);
        assert_eq!(labels, vec![0, 0, 1, 0, 2, 2, 0], "a named person's one window stays theirs");
    }

    /// Three voices that speak at length and a cough of a fourth: told "three", the cough is not one
    /// of the three — it joins the nearest, and the three voices stay apart.
    #[test]
    fn a_count_is_of_people_not_of_coughs() {
        let mut vectors = Vec::new();
        for turn in [2.0f32, 5.0, 9.0] {
            for k in 0..8 {
                vectors.push(voice(turn, 0.04 * k as f32));
            }
        }
        vectors.push(voice(13.0, 0.0));
        let labels = cluster(&vectors, 3);
        assert_eq!(*labels.iter().max().unwrap(), 2, "three people: {labels:?}");
        assert_ne!(labels[0], labels[8]);
        assert_ne!(labels[8], labels[16]);
        assert_ne!(labels[0], labels[16]);
    }

    /// Two named voices close to each other stay two people, and each comes back with its group —
    /// even a voice that matches its speech below the naming threshold.
    #[test]
    fn named_voices_anchor_their_people_and_never_merge() {
        let mut vectors = Vec::new();
        for turn in [2.0f32, 2.3, 9.0] {
            for k in 0..6 {
                vectors.push(voice(turn, 0.03 * k as f32));
            }
        }
        let juan = voice(2.0, 0.0);
        let pedro = voice(2.3, 0.0);
        let guided = cluster_guided(&vectors, 3, &[juan, pedro]);
        assert_eq!(*guided.labels.iter().max().unwrap(), 2, "{:?}", guided.labels);
        assert_eq!(guided.anchors[0], Some(guided.labels[0]), "Juan is the first voice");
        assert_eq!(guided.anchors[1], Some(guided.labels[6]), "Pedro is the second");
        assert_ne!(guided.anchors[0], guided.anchors[1]);
    }

    /// A named voice nobody in the meeting has comes back as not heard, and the count still holds
    /// for the others.
    #[test]
    fn a_named_voice_not_heard_is_said_so() {
        let mut vectors = Vec::new();
        for turn in [2.0f32, 9.0] {
            for k in 0..6 {
                vectors.push(voice(turn, 0.03 * k as f32));
            }
        }
        // A voice unlike both: what is left of a third once its likeness to the two is taken out.
        let mut absent = voice(31.0, 0.0);
        for known in [voice(2.0, 0.0), voice(9.0, 0.0)] {
            let along = cosine(&absent, &known);
            absent.iter_mut().zip(&known).for_each(|(a, k)| *a -= along * k);
            normalise(&mut absent);
        }
        let guided = cluster_guided(&vectors, 3, &[absent]);
        assert_eq!(guided.anchors, vec![None]);
        assert_eq!(*guided.labels.iter().max().unwrap(), 1, "two voices heard: {:?}", guided.labels);
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
