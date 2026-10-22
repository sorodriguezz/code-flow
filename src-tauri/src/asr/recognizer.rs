//! sherpa-onnx's offline recognizer through its C API.
//!
//! **The config is opaque bytes**, as in `speech::piper`: `SherpaOnnxOfflineRecognizerConfig` nests
//! some twenty model families' configs, 608 bytes on a 64-bit build of v1.13.8, and only one family's
//! fields are ever set. A zeroed buffer with those written at offsets measured with `offsetof`
//! against the pinned `c-api.h` ([`offsets`]) is the same call, with nothing to drift — the library
//! is pinned by digest, so a new version means measuring again:
//!
//! ```c
//! printf("%zu %zu\n", sizeof(SherpaOnnxOfflineRecognizerConfig),
//!        offsetof(SherpaOnnxOfflineRecognizerConfig, model_config.canary.src_lang));
//! ```
//!
//! One recognizer per [`Slot`] stays loaded between uses (Parakeet loads in about 0.8 s), keyed by
//! what built it: a different model, language pair or thread count builds a new one. Each feature
//! has its own slot, so Codi listening never waits for a dictation or swaps its model out.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use libloading::Library;

use super::{AsrModel, Family};

/// Byte offsets inside `SherpaOnnxOfflineRecognizerConfig` (v1.13.8, 64-bit), measured 2026-10-21.
mod offsets {
    pub const SIZE: usize = 608;
    pub const SAMPLE_RATE: usize = 0;
    pub const FEATURE_DIM: usize = 4;
    pub const TRANSDUCER_ENCODER: usize = 8;
    pub const TRANSDUCER_DECODER: usize = 16;
    pub const TRANSDUCER_JOINER: usize = 24;
    pub const TOKENS: usize = 104;
    pub const NUM_THREADS: usize = 112;
    pub const PROVIDER: usize = 120;
    pub const MODEL_TYPE: usize = 128;
    pub const CANARY_ENCODER: usize = 256;
    pub const CANARY_DECODER: usize = 264;
    pub const CANARY_SRC_LANG: usize = 272;
    pub const CANARY_TGT_LANG: usize = 280;
    pub const CANARY_USE_PNC: usize = 288;
    pub const DECODING_METHOD: usize = 528;
}

/// Both NeMo families read 128 mel bins; the library takes the model's own when it says.
const FEATURE_DIM: i32 = 128;
const RATE: i32 = 16_000;

type CreateFn = unsafe extern "C" fn(*const u8) -> *const c_void;
type DestroyFn = unsafe extern "C" fn(*const c_void);
type CreateStreamFn = unsafe extern "C" fn(*const c_void) -> *const c_void;
type AcceptFn = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type DecodeFn = unsafe extern "C" fn(*const c_void, *const c_void);
type ResultFn = unsafe extern "C" fn(*const c_void) -> *const c_void;

struct Api {
    _library: Library,
    create: CreateFn,
    destroy: DestroyFn,
    create_stream: CreateStreamFn,
    destroy_stream: DestroyFn,
    accept: AcceptFn,
    decode: DecodeFn,
    result: ResultFn,
    destroy_result: DestroyFn,
}

// SAFETY: plain C entry points; the library handle is only kept alive.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Api> = OnceLock::new();

fn load(path: &Path) -> Result<Api, String> {
    // SAFETY: the pinned sherpa-onnx build meetings verified and unpacked. Loading the file the
    // speaker extractor or a voice already loaded hands back the same module.
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
            create: symbol!("SherpaOnnxCreateOfflineRecognizer", CreateFn),
            destroy: symbol!("SherpaOnnxDestroyOfflineRecognizer", DestroyFn),
            create_stream: symbol!("SherpaOnnxCreateOfflineStream", CreateStreamFn),
            destroy_stream: symbol!("SherpaOnnxDestroyOfflineStream", DestroyFn),
            accept: symbol!("SherpaOnnxAcceptWaveformOffline", AcceptFn),
            decode: symbol!("SherpaOnnxDecodeOfflineStream", DecodeFn),
            result: symbol!("SherpaOnnxGetOfflineStreamResult", ResultFn),
            destroy_result: symbol!("SherpaOnnxDestroyOfflineRecognizerResult", DestroyFn),
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

/// Loads the library from `path` instead of the installed one — for the live tests.
#[cfg(test)]
pub fn load_library_for_test(path: &Path) {
    API.get_or_init(|| load(path).expect("the speech library loads"));
}

/// What a loaded recognizer was built from: change any of it and a new one is built.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Key {
    dir: std::path::PathBuf,
    family: Family,
    source: String,
    target: String,
    threads: i32,
}

struct Loaded {
    key: Key,
    handle: *const c_void,
}

// SAFETY: the handle is only touched under its slot's lock.
unsafe impl Send for Loaded {}

impl Drop for Loaded {
    fn drop(&mut self) {
        if let Some(api) = API.get() {
            // SAFETY: made by `create`, destroyed once.
            unsafe { (api.destroy)(self.handle) };
        }
    }
}

/// Where one loaded recognizer lives.
pub struct Slot(Mutex<Option<Loaded>>);

impl Slot {
    const fn new() -> Self {
        Slot(Mutex::new(None))
    }
}

pub static DICTATION: Slot = Slot::new();
/// «Codi», listening all the time it is on.
pub static CODI: Slot = Slot::new();
pub static MEETINGS: Slot = Slot::new();
/// A flow's «Transcribir audio», freed when the node is done.
pub static FLOWS: Slot = Slot::new();

fn build(key: &Key, model: &AsrModel) -> Result<*const c_void, String> {
    let api = api()?;
    let cstr = |path: &Path| CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "The model's path has a NUL byte".to_string());
    let file = |name: &str| cstr(&key.dir.join(name));
    let tokens = file("tokens.txt")?;
    let encoder = file("encoder.int8.onnx")?;
    let decoder = file("decoder.int8.onnx")?;
    let joiner = file("joiner.int8.onnx")?;
    let source = CString::new(key.source.as_str()).unwrap_or_default();
    let target = CString::new(key.target.as_str()).unwrap_or_default();
    let provider = c"cpu";
    let greedy = c"greedy_search";
    let transducer = c"nemo_transducer";
    let mut config = [0u8; offsets::SIZE];
    let put_ptr = |buf: &mut [u8], at: usize, ptr: *const c_char| buf[at..at + 8].copy_from_slice(&(ptr as usize as u64).to_ne_bytes());
    let put_i32 = |buf: &mut [u8], at: usize, value: i32| buf[at..at + 4].copy_from_slice(&value.to_ne_bytes());
    put_i32(&mut config, offsets::SAMPLE_RATE, RATE);
    put_i32(&mut config, offsets::FEATURE_DIM, FEATURE_DIM);
    put_ptr(&mut config, offsets::TOKENS, tokens.as_ptr());
    put_i32(&mut config, offsets::NUM_THREADS, key.threads);
    put_ptr(&mut config, offsets::PROVIDER, provider.as_ptr());
    put_ptr(&mut config, offsets::DECODING_METHOD, greedy.as_ptr());
    match model.family {
        Family::Transducer => {
            put_ptr(&mut config, offsets::TRANSDUCER_ENCODER, encoder.as_ptr());
            put_ptr(&mut config, offsets::TRANSDUCER_DECODER, decoder.as_ptr());
            put_ptr(&mut config, offsets::TRANSDUCER_JOINER, joiner.as_ptr());
            put_ptr(&mut config, offsets::MODEL_TYPE, transducer.as_ptr());
        }
        Family::Canary => {
            put_ptr(&mut config, offsets::CANARY_ENCODER, encoder.as_ptr());
            put_ptr(&mut config, offsets::CANARY_DECODER, decoder.as_ptr());
            put_ptr(&mut config, offsets::CANARY_SRC_LANG, source.as_ptr());
            put_ptr(&mut config, offsets::CANARY_TGT_LANG, target.as_ptr());
            // Punctuation and capitals: a dictation wants sentences, not a lower-case stream.
            put_i32(&mut config, offsets::CANARY_USE_PNC, 1);
        }
    }
    // SAFETY: the buffer is the C struct's size and every pointer in it outlives the call (the
    // library copies the strings into its own config).
    let handle = unsafe { (api.create)(config.as_ptr()) };
    if handle.is_null() {
        return Err(format!("The speech model could not be loaded ({})", key.dir.display()));
    }
    Ok(handle)
}

/// How many threads a recognizer gets: two keep up with speech on any laptop measured (Parakeet,
/// 100 ms an order), four only shave a few milliseconds and take cores from whatever else runs.
pub fn threads() -> i32 {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32;
    (cores / 4).clamp(2, 4)
}

/// Text of `samples` — mono, 16 kHz, -1…1 — heard by `model` on `slot`'s recognizer. `language` is a
/// code or `auto`: a transducer tells by itself; Canary needs one and falls back to `fallback`
/// (the app's language). `translate_to` makes Canary write another of its languages. Blocking.
pub fn transcribe(slot: &Slot, model: &AsrModel, samples: &[f32], language: &str, fallback: &str, translate_to: Option<&str>) -> Result<String, String> {
    if !super::installed(model) {
        return Err("That speech model is not downloaded — Settings › Voice & sound › Models".into());
    }
    let api = api()?;
    let source = match model.family {
        Family::Transducer => String::new(),
        Family::Canary => {
            let code = super::language_code(language).or_else(|| super::language_code(fallback)).unwrap_or_else(|| "en".into());
            if !model.languages.contains(&code.as_str()) {
                return Err(format!("{} does not hear «{code}»: {}", model.label, model.languages.join(", ")));
            }
            code
        }
    };
    let target = match (model.family, translate_to.and_then(super::language_code)) {
        (Family::Canary, Some(code)) if model.languages.contains(&code.as_str()) => code,
        (Family::Canary, Some(code)) => return Err(format!("{} does not write «{code}»", model.label)),
        (Family::Canary, None) => source.clone(),
        (Family::Transducer, _) => String::new(),
    };
    let key = Key { dir: super::model_dir(model), family: model.family, source, target, threads: threads() };
    let mut held = slot.0.lock().map_err(|_| "The speech model is busy".to_string())?;
    if held.as_ref().map(|loaded| &loaded.key) != Some(&key) {
        *held = None;
        let handle = build(&key, model)?;
        *held = Some(Loaded { key, handle });
    }
    let recognizer = held.as_ref().map(|loaded| loaded.handle).unwrap_or(std::ptr::null());
    if samples.is_empty() {
        return Ok(String::new());
    }
    // SAFETY: the recognizer is live under the lock; the stream and result are destroyed below,
    // after the text is copied out of the result.
    unsafe {
        let stream = (api.create_stream)(recognizer);
        if stream.is_null() {
            return Err("The speech model could not start".into());
        }
        (api.accept)(stream, RATE, samples.as_ptr(), samples.len() as i32);
        (api.decode)(recognizer, stream);
        let result = (api.result)(stream);
        // `SherpaOnnxOfflineRecognizerResult` starts with `const char *text`.
        let text = if result.is_null() {
            String::new()
        } else {
            let pointer = *(result as *const *const c_char);
            if pointer.is_null() { String::new() } else { CStr::from_ptr(pointer).to_string_lossy().into_owned() }
        };
        if !result.is_null() {
            (api.destroy_result)(result);
        }
        (api.destroy_stream)(stream);
        Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
    }
}

/// Frees `slot`'s recognizer, if it holds one.
pub fn unload(slot: &Slot) {
    if let Ok(mut held) = slot.0.lock() {
        *held = None;
    }
}

/// Frees every recognizer — before a model's files are deleted.
pub fn unload_all() {
    for slot in [&DICTATION, &CODI, &MEETINGS, &FLOWS] {
        unload(slot);
    }
}

/// Transcribes with a Parakeet folder outside the app's models — for tests elsewhere in the crate.
#[cfg(test)]
pub fn transcribe_in_test(dir: &Path, samples: &[f32]) -> String {
    let model = *super::model("parakeet").expect("parakeet");
    let key = Key { dir: dir.to_path_buf(), family: model.family, source: String::new(), target: String::new(), threads: 2 };
    let handle = build(&key, &model).expect("the model loads");
    let api = api().unwrap();
    // SAFETY: as in `transcribe`.
    let text = unsafe {
        let stream = (api.create_stream)(handle);
        (api.accept)(stream, RATE, samples.as_ptr(), samples.len() as i32);
        (api.decode)(handle, stream);
        let result = (api.result)(stream);
        let text = CStr::from_ptr(*(result as *const *const c_char)).to_string_lossy().into_owned();
        (api.destroy_result)(result);
        (api.destroy_stream)(stream);
        (api.destroy)(handle);
        text
    };
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples_of(path: &str) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("the clip");
        // A 16 kHz mono s16le WAV: find the `data` chunk rather than assume a 44-byte header.
        let at = bytes.windows(4).position(|w| w == b"data").expect("a data chunk") + 8;
        bytes[at..].chunks_exact(2).map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0).collect()
    }

    /// The real library and model on a real clip:
    /// `CODEFLOW_TEST_ASR=<sherpa library>|<model folder>|<parakeet|canary>|<wav>|<a word it says>`.
    /// The clip is `say -v "Paulina (Español (México))"` + `afconvert -f WAVE -d LEI16@16000 -c 1`.
    #[test]
    #[ignore]
    fn hears_a_spanish_clip() {
        let spec = std::env::var("CODEFLOW_TEST_ASR").expect("CODEFLOW_TEST_ASR=<library>|<model dir>|<id>|<wav>|<word>");
        let parts: Vec<&str> = spec.split('|').collect();
        load_library_for_test(Path::new(parts[0]));
        let catalogue = *super::super::model(parts[2]).expect("parakeet or canary");
        // The catalogue's folder is under the app's models; point the key at the test's instead.
        let slot = Slot::new();
        let key = Key { dir: Path::new(parts[1]).to_path_buf(), family: catalogue.family, source: "es".into(), target: "es".into(), threads: 2 };
        let handle = build(&key, &catalogue).expect("the model loads");
        *slot.0.lock().unwrap() = Some(Loaded { key: key.clone(), handle });
        let samples = samples_of(parts[3]);
        let api = api().unwrap();
        let started = std::time::Instant::now();
        let text = unsafe {
            let stream = (api.create_stream)(handle);
            (api.accept)(stream, RATE, samples.as_ptr(), samples.len() as i32);
            (api.decode)(handle, stream);
            let result = (api.result)(stream);
            let text = CStr::from_ptr(*(result as *const *const c_char)).to_string_lossy().into_owned();
            (api.destroy_result)(result);
            (api.destroy_stream)(stream);
            text
        };
        eprintln!("{text:?} in {:?}", started.elapsed());
        assert!(text.to_lowercase().contains(&parts[4].to_lowercase()), "{text}");
        unload(&slot);
    }
}
