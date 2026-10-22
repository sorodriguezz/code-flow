//! sherpa-onnx's offline text to speech through its C API — what [`super::piper`] and
//! [`super::kokoro`] both drive, on the library meetings downloads (`meetings::SHERPA`).
//!
//! **The config is opaque bytes.** `SherpaOnnxOfflineTtsConfig` nests nine model families' configs,
//! 448 bytes on a 64-bit build; mirroring all of them in Rust would be a page of structs that only
//! ever carry zeros. A zeroed buffer with one family's fields written at their measured offsets (a C
//! `offsetof` probe against v1.13.8's `c-api.h`, [`offsets`]) is the same call with nothing to drift.
//!
//! **Speech comes out a sentence at a time.** `SherpaOnnxOfflineTtsGenerateWithConfig` hands every
//! sentence to a callback as soon as it is written (`max_num_sentences = 1`), so the player starts on
//! the first while the rest are still being synthesized: Kokoro needs about 0.2 s a second of speech
//! on four cores, and waiting for a whole answer before the first word is what made a long one feel
//! slow.

use std::ffi::{c_char, c_void, CString};
use std::path::Path;
use std::sync::OnceLock;

use libloading::Library;

/// Byte offsets inside `SherpaOnnxOfflineTtsConfig` (v1.13.8, 64-bit), measured with `offsetof`.
pub mod offsets {
    pub const SIZE: usize = 448;
    pub const VITS_MODEL: usize = 0;
    pub const VITS_TOKENS: usize = 16;
    pub const VITS_DATA_DIR: usize = 24;
    pub const VITS_NOISE_SCALE: usize = 32;
    pub const VITS_NOISE_SCALE_W: usize = 36;
    pub const VITS_LENGTH_SCALE: usize = 40;
    pub const NUM_THREADS: usize = 56;
    pub const PROVIDER: usize = 64;
    pub const KOKORO_MODEL: usize = 128;
    pub const KOKORO_VOICES: usize = 136;
    pub const KOKORO_TOKENS: usize = 144;
    pub const KOKORO_DATA_DIR: usize = 152;
    pub const KOKORO_LENGTH_SCALE: usize = 160;
    pub const KOKORO_LEXICON: usize = 176;
    pub const KOKORO_LANG: usize = 184;
    pub const MAX_NUM_SENTENCES: usize = 424;
    pub const SILENCE_SCALE: usize = 440;
}

/// `SherpaOnnxGenerationConfig` (56 bytes): the per-call knobs. Only these three are set; the
/// reference-audio fields are for the voice-cloning families this app does not run here.
#[repr(C)]
#[derive(Default)]
struct GenerationConfig {
    silence_scale: f32,
    speed: f32,
    sid: i32,
    _reference_audio: usize,
    _reference_len: i32,
    _reference_rate: i32,
    _reference_text: usize,
    _num_steps: i32,
    _extra: usize,
}

const _: () = assert!(std::mem::size_of::<GenerationConfig>() == 56);

#[repr(C)]
struct GeneratedAudio {
    _samples: *const f32,
    _n: i32,
    _sample_rate: i32,
}

type CreateFn = unsafe extern "C" fn(*const u8) -> *const c_void;
type DestroyFn = unsafe extern "C" fn(*const c_void);
type RateFn = unsafe extern "C" fn(*const c_void) -> i32;
type ProgressFn = unsafe extern "C" fn(*const f32, i32, f32, *mut c_void) -> i32;
type GenerateFn = unsafe extern "C" fn(*const c_void, *const c_char, *const GenerationConfig, Option<ProgressFn>, *mut c_void) -> *const GeneratedAudio;
type DestroyAudioFn = unsafe extern "C" fn(*const GeneratedAudio);

struct Api {
    _library: Library,
    create: CreateFn,
    destroy: DestroyFn,
    rate: RateFn,
    generate: GenerateFn,
    destroy_audio: DestroyAudioFn,
}

// SAFETY: plain C entry points; the library handle is only kept alive.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Api> = OnceLock::new();

fn load(path: &Path) -> Result<Api, String> {
    // SAFETY: the pinned sherpa-onnx build meetings verified and unpacked. Loading the same file
    // the speaker extractor loaded hands back the same module.
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
            create: symbol!("SherpaOnnxCreateOfflineTts", CreateFn),
            destroy: symbol!("SherpaOnnxDestroyOfflineTts", DestroyFn),
            rate: symbol!("SherpaOnnxOfflineTtsSampleRate", RateFn),
            generate: symbol!("SherpaOnnxOfflineTtsGenerateWithConfig", GenerateFn),
            destroy_audio: symbol!("SherpaOnnxDestroyOfflineTtsGeneratedAudio", DestroyAudioFn),
            _library: library,
        })
    }
}

fn api() -> Result<&'static Api, String> {
    if let Some(api) = API.get() {
        return Ok(api);
    }
    let path = crate::meetings::sherpa_library().ok_or("The voice library is not installed — Settings › Voice & sound › Models")?;
    let loaded = load(&path)?;
    Ok(API.get_or_init(|| loaded))
}

/// Loads the library from `path` instead of the installed one — for the live tests.
#[cfg(test)]
pub fn load_library_for_test(path: &Path) {
    API.get_or_init(|| load(path).expect("the voice library loads"));
}

/// A config being filled: the bytes, and the strings its pointers point into — kept alive here
/// until [`Engine::create`] has read them.
pub struct Config {
    bytes: [u8; offsets::SIZE],
    strings: Vec<CString>,
}

impl Config {
    pub fn new() -> Self {
        Config { bytes: [0u8; offsets::SIZE], strings: Vec::new() }
    }

    pub fn path(&mut self, at: usize, path: &Path) -> Result<(), String> {
        self.text(at, &path.to_string_lossy())
    }

    pub fn text(&mut self, at: usize, value: &str) -> Result<(), String> {
        let owned = CString::new(value.as_bytes()).map_err(|_| "A voice setting has a NUL byte".to_string())?;
        let pointer = owned.as_ptr() as usize as u64;
        self.strings.push(owned);
        self.bytes[at..at + 8].copy_from_slice(&pointer.to_ne_bytes());
        Ok(())
    }

    pub fn float(&mut self, at: usize, value: f32) {
        self.bytes[at..at + 4].copy_from_slice(&value.to_ne_bytes());
    }

    pub fn int(&mut self, at: usize, value: i32) {
        self.bytes[at..at + 4].copy_from_slice(&value.to_ne_bytes());
    }
}

/// One loaded voice model.
pub struct Engine {
    handle: *const c_void,
}

// SAFETY: used under its owner's lock only (`piper::LOADED`, `kokoro::LOADED`).
unsafe impl Send for Engine {}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(api) = API.get() {
            // SAFETY: created by `create` and not destroyed elsewhere.
            unsafe { (api.destroy)(self.handle) };
        }
    }
}

/// What a chunk callback is handed, through the C callback's user pointer.
struct Sink<'a> {
    rate: u32,
    on_chunk: &'a mut dyn FnMut(&[f32], u32) -> bool,
}

unsafe extern "C" fn forward(samples: *const f32, n: i32, _progress: f32, user: *mut c_void) -> i32 {
    if user.is_null() || samples.is_null() || n <= 0 {
        return 1;
    }
    // SAFETY: `user` is the `Sink` `generate` passed, alive for the whole call; the samples are
    // valid for the callback's duration only, and are copied by the closure if it keeps them.
    let sink = unsafe { &mut *(user as *mut Sink<'_>) };
    let chunk = unsafe { std::slice::from_raw_parts(samples, n as usize) };
    i32::from((sink.on_chunk)(chunk, sink.rate))
}

impl Engine {
    pub fn create(config: Config) -> Result<Engine, String> {
        let api = api()?;
        // SAFETY: the buffer is the C struct's size and every pointer in it is into `config.strings`,
        // alive across the call (the library copies the strings into its own config).
        let handle = unsafe { (api.create)(config.bytes.as_ptr()) };
        drop(config);
        if handle.is_null() {
            return Err("The voice could not be loaded".into());
        }
        Ok(Engine { handle })
    }

    pub fn sample_rate(&self) -> u32 {
        // SAFETY: the handle is live while `self` is.
        api().map(|api| unsafe { (api.rate)(self.handle) }).unwrap_or(0).max(1) as u32
    }

    /// Says `text` as speaker `sid` at `speed`, handing every sentence to `on_chunk` as it is written,
    /// with its sample rate (`false` from it stops the rest).
    pub fn generate(&self, text: &str, sid: i32, speed: f32, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String> {
        let api = api()?;
        let text = CString::new(text.replace('\0', " ")).map_err(|_| "The text has a NUL byte".to_string())?;
        let config = GenerationConfig { silence_scale: 0.2, speed: speed.clamp(0.5, 2.0), sid, ..GenerationConfig::default() };
        let mut sink = Sink { rate: self.sample_rate(), on_chunk };
        // SAFETY: the handle is live (we own it); `text`, `config` and `sink` outlive the call; the
        // audio it returns is freed below. Its whole samples were already handed out chunk by chunk.
        unsafe {
            let audio = (api.generate)(self.handle, text.as_ptr(), &config, Some(forward), (&mut sink as *mut Sink<'_>).cast());
            if audio.is_null() {
                return Err("The voice said nothing".into());
            }
            (api.destroy_audio)(audio);
            Ok(())
        }
    }
}
