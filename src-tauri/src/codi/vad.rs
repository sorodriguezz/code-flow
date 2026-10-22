//! Where an utterance starts and ends, as it is spoken: sherpa-onnx's streaming voice-activity
//! detector over Silero (the same detector whisper.cpp ships, in ONNX), on the library the models
//! that listen already need.
//!
//! **Streaming, not a pass over a recording.** whisper.cpp's detector (`dictation::engine::Vad`)
//! takes a whole buffer — right for a meeting cut every second, wrong for an assistant that should
//! answer the moment you stop talking. This one is fed 40 ms at a time and hands back each utterance
//! [`MIN_SILENCE_S`] after it ends, and says while somebody is talking ([`Detector::speaking`]) —
//! what the window's «te estoy oyendo» face and the barge-in read.
//!
//! **The config is opaque bytes** (`SherpaOnnxVadModelConfig`, 88 bytes in v1.13.8, offsets measured
//! with `offsetof` — [`offsets`]), as everywhere sherpa is called here.

use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::Library;

/// The model: Silero VAD in ONNX, from sherpa-onnx's `asr-models` release.
pub const MODEL: crate::meetings::ModelFile = crate::meetings::ModelFile {
    file: "silero_vad.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    size: 643_854,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
};

pub fn model_path() -> PathBuf {
    crate::asr::root().join(MODEL.file)
}

/// The silence that ends an utterance. Half a second answers promptly without cutting a sentence at
/// a breath; meetings use 0.7 s, where a turn ending early costs more than a beat of waiting.
pub const MIN_SILENCE_S: f32 = 0.5;
/// Shorter than this is a cough or a click.
const MIN_SPEECH_S: f32 = 0.25;
/// An utterance this long is cut even without a pause — an order is never this long.
const MAX_SPEECH_S: f32 = 20.0;

mod offsets {
    pub const SIZE: usize = 88;
    pub const MODEL: usize = 0;
    pub const THRESHOLD: usize = 8;
    pub const MIN_SILENCE: usize = 12;
    pub const MIN_SPEECH: usize = 16;
    pub const WINDOW: usize = 20;
    pub const MAX_SPEECH: usize = 24;
    pub const SAMPLE_RATE: usize = 32;
    pub const NUM_THREADS: usize = 36;
    pub const PROVIDER: usize = 40;
}

#[repr(C)]
struct Segment {
    _start: i32,
    samples: *const f32,
    n: i32,
}

type CreateFn = unsafe extern "C" fn(*const u8, f32) -> *const c_void;
type DestroyFn = unsafe extern "C" fn(*const c_void);
type AcceptFn = unsafe extern "C" fn(*const c_void, *const f32, i32);
type FlagFn = unsafe extern "C" fn(*const c_void) -> i32;
type FrontFn = unsafe extern "C" fn(*const c_void) -> *const Segment;
type DestroySegmentFn = unsafe extern "C" fn(*const Segment);

struct Api {
    _library: Library,
    create: CreateFn,
    destroy: DestroyFn,
    accept: AcceptFn,
    empty: FlagFn,
    detected: FlagFn,
    front: FrontFn,
    destroy_segment: DestroySegmentFn,
    pop: DestroyFn,
    flush: DestroyFn,
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
        let library = library.map_err(|e| format!("Couldn't load the speech library ({}): {e}", path.display()))?;
        macro_rules! symbol {
            ($name:literal, $ty:ty) => {
                *library.get::<$ty>(concat!($name, "\0").as_bytes()).map_err(|e| format!("The speech library has no {}: {e}", $name))?
            };
        }
        Ok(Api {
            create: symbol!("SherpaOnnxCreateVoiceActivityDetector", CreateFn),
            destroy: symbol!("SherpaOnnxDestroyVoiceActivityDetector", DestroyFn),
            accept: symbol!("SherpaOnnxVoiceActivityDetectorAcceptWaveform", AcceptFn),
            empty: symbol!("SherpaOnnxVoiceActivityDetectorEmpty", FlagFn),
            detected: symbol!("SherpaOnnxVoiceActivityDetectorDetected", FlagFn),
            front: symbol!("SherpaOnnxVoiceActivityDetectorFront", FrontFn),
            destroy_segment: symbol!("SherpaOnnxDestroySpeechSegment", DestroySegmentFn),
            pop: symbol!("SherpaOnnxVoiceActivityDetectorPop", DestroyFn),
            flush: symbol!("SherpaOnnxVoiceActivityDetectorFlush", DestroyFn),
            _library: library,
        })
    }
}

fn api() -> Result<&'static Api, String> {
    if let Some(api) = API.get() {
        return Ok(api);
    }
    let path = crate::meetings::sherpa_library().ok_or("The speech library is not installed — Settings › Voice & sound › Models")?;
    let loaded = load(&path)?;
    Ok(API.get_or_init(|| loaded))
}

#[cfg(test)]
pub fn load_library_for_test(path: &Path) {
    API.get_or_init(|| load(path).expect("the speech library loads"));
}

/// A detector fed as audio arrives. Used by one thread.
pub struct Detector {
    handle: *const c_void,
}

// SAFETY: the handle is used through `&mut self` by the one thread that owns the detector.
unsafe impl Send for Detector {}

impl Detector {
    /// `threshold`: how sure a 32 ms frame must be to count as speech — raised while Codi itself is
    /// speaking, so its own voice leaking from the speakers is less often taken for the user's.
    pub fn new(model: &Path, threshold: f32) -> Result<Detector, String> {
        let api = api()?;
        let model = CString::new(model.to_string_lossy().as_bytes()).map_err(|_| "The model's path has a NUL byte".to_string())?;
        let provider = c"cpu";
        let mut config = [0u8; offsets::SIZE];
        let put_ptr = |buf: &mut [u8], at: usize, ptr: *const c_char| buf[at..at + 8].copy_from_slice(&(ptr as usize as u64).to_ne_bytes());
        let put_f32 = |buf: &mut [u8], at: usize, value: f32| buf[at..at + 4].copy_from_slice(&value.to_ne_bytes());
        let put_i32 = |buf: &mut [u8], at: usize, value: i32| buf[at..at + 4].copy_from_slice(&value.to_ne_bytes());
        put_ptr(&mut config, offsets::MODEL, model.as_ptr());
        put_f32(&mut config, offsets::THRESHOLD, threshold.clamp(0.1, 0.95));
        put_f32(&mut config, offsets::MIN_SILENCE, MIN_SILENCE_S);
        put_f32(&mut config, offsets::MIN_SPEECH, MIN_SPEECH_S);
        put_i32(&mut config, offsets::WINDOW, 512);
        put_f32(&mut config, offsets::MAX_SPEECH, MAX_SPEECH_S);
        put_i32(&mut config, offsets::SAMPLE_RATE, 16_000);
        put_i32(&mut config, offsets::NUM_THREADS, 1);
        put_ptr(&mut config, offsets::PROVIDER, provider.as_ptr());
        // SAFETY: the buffer is the struct's size; its strings outlive the call, which copies them.
        // Thirty seconds of buffer: more than any order, little memory.
        let handle = unsafe { (api.create)(config.as_ptr(), 30.0) };
        if handle.is_null() {
            return Err(format!("The voice detector could not be loaded ({})", model.to_string_lossy()));
        }
        Ok(Detector { handle })
    }

    /// Feeds 16 kHz mono samples; the utterances that ended in them, oldest first.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        let Ok(api) = api() else { return Vec::new() };
        // SAFETY: the samples outlive the call; segments are copied out before they are freed.
        unsafe {
            (api.accept)(self.handle, samples.as_ptr(), samples.len() as i32);
            self.drain(api)
        }
    }

    /// Whether somebody is speaking right now.
    pub fn speaking(&self) -> bool {
        // SAFETY: a live handle.
        api().is_ok_and(|api| unsafe { (api.detected)(self.handle) } != 0)
    }

    /// Ends what is being said (the microphone is closing): the last utterance, if any.
    pub fn flush(&mut self) -> Vec<Vec<f32>> {
        let Ok(api) = api() else { return Vec::new() };
        // SAFETY: as in `push`.
        unsafe {
            (api.flush)(self.handle);
            self.drain(api)
        }
    }

    unsafe fn drain(&mut self, api: &Api) -> Vec<Vec<f32>> {
        let mut done = Vec::new();
        // SAFETY: the caller's; each segment is freed after it is copied, then popped.
        unsafe {
            while (api.empty)(self.handle) == 0 {
                let segment = (api.front)(self.handle);
                if !segment.is_null() {
                    let s = &*segment;
                    if !s.samples.is_null() && s.n > 0 {
                        done.push(std::slice::from_raw_parts(s.samples, s.n as usize).to_vec());
                    }
                    (api.destroy_segment)(segment);
                }
                (api.pop)(self.handle);
            }
        }
        done
    }
}

impl Drop for Detector {
    fn drop(&mut self) {
        if let Some(api) = API.get() {
            // SAFETY: made by `create`, destroyed once.
            unsafe { (api.destroy)(self.handle) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real library and model: `CODEFLOW_TEST_VAD=<library>|<silero_vad.onnx>|<wav>`. A clip of
    /// one sentence, padded with a second of silence on each side, comes out as one utterance about
    /// as long as the sentence, fed 40 ms at a time.
    #[test]
    #[ignore]
    fn one_sentence_is_one_utterance() {
        let spec = std::env::var("CODEFLOW_TEST_VAD").expect("CODEFLOW_TEST_VAD=<library>|<model>|<wav>");
        let parts: Vec<&str> = spec.split('|').collect();
        load_library_for_test(Path::new(parts[0]));
        let bytes = std::fs::read(parts[2]).unwrap();
        let at = bytes.windows(4).position(|w| w == b"data").unwrap() + 8;
        let speech: Vec<f32> = bytes[at..].chunks_exact(2).map(|p| f32::from(i16::from_le_bytes([p[0], p[1]])) / 32768.0).collect();
        let mut audio = vec![0.0f32; 16_000];
        audio.extend(&speech);
        audio.extend(vec![0.0f32; 16_000]);
        let mut detector = Detector::new(Path::new(parts[1]), 0.5).unwrap();
        let mut found = Vec::new();
        let mut heard_speaking = false;
        for block in audio.chunks(640) {
            found.extend(detector.push(block));
            heard_speaking |= detector.speaking();
        }
        found.extend(detector.flush());
        assert!(heard_speaking);
        assert_eq!(found.len(), 1, "{:?}", found.iter().map(Vec::len).collect::<Vec<_>>());
        let ratio = found[0].len() as f32 / speech.len() as f32;
        assert!((0.6..1.6).contains(&ratio), "{ratio}");
    }
}
