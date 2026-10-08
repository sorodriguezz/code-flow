//! whisper.cpp through its C API, from the library `super` installed.
//!
//! **The parameter structs are opaque bytes, not mirrors.** `whisper_full_params` has some sixty
//! fields and changes between builds; copying it field by field would be sixty chances to be wrong
//! with nothing to catch it. Instead the library fills a default (`whisper_full_default_params_by_ref`),
//! this copies its bytes and sets the handful of fields that matter at their offsets, and passes the
//! struct by value as an array of exactly its size. Size and offsets are those of
//! [`super::ENGINE_BUILD`], read from its own `whisper.h` with `sizeof`/`offsetof` — on aarch64 and
//! on Windows x64 a struct this large is passed as a pointer to a copy, whatever its fields, so only
//! the size has to be right for the call to be. The engine archive is pinned by digest, so the
//! library cannot change under these numbers; a new build means measuring again:
//!
//! ```c
//! printf("%zu %zu\n", sizeof(struct whisper_full_params), offsetof(struct whisper_full_params, language));
//! ```
//!
//! One model stays loaded between dictations (loading `small` costs about half a second); a context
//! is not safe to use from two threads, so every use goes through one mutex.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use libloading::Library;

/// `sizeof(struct whisper_full_params)` in b5454.
const FULL_PARAMS_SIZE: usize = 304;
/// `sizeof(struct whisper_context_params)` in b5454.
const CONTEXT_PARAMS_SIZE: usize = 48;

/// Offsets into `whisper_full_params` (b5454).
mod offset {
    pub const NO_TIMESTAMPS: usize = 22;
    pub const PRINT_PROGRESS: usize = 25;
    pub const PRINT_REALTIME: usize = 26;
    pub const PRINT_TIMESTAMPS: usize = 27;
    pub const LANGUAGE: usize = 104;
    pub const DETECT_LANGUAGE: usize = 112;
    pub const SUPPRESS_NST: usize = 114;
    pub const ABORT_CALLBACK: usize = 208;
    pub const ABORT_CALLBACK_USER_DATA: usize = 216;
}

#[repr(C, align(8))]
#[derive(Clone, Copy)]
struct FullParams([u8; FULL_PARAMS_SIZE]);

#[repr(C, align(8))]
#[derive(Clone, Copy)]
struct ContextParams([u8; CONTEXT_PARAMS_SIZE]);

impl FullParams {
    fn set_bool(&mut self, at: usize, value: bool) {
        self.0[at] = u8::from(value);
    }

    fn set_pointer(&mut self, at: usize, value: *const c_void) {
        self.0[at..at + 8].copy_from_slice(&(value as usize as u64).to_ne_bytes());
    }
}

type InitFn = unsafe extern "C" fn(*const c_char, ContextParams) -> *mut c_void;
type ContextDefaultsFn = unsafe extern "C" fn() -> *mut ContextParams;
type FreeContextParamsFn = unsafe extern "C" fn(*mut ContextParams);
type FullDefaultsFn = unsafe extern "C" fn(c_int) -> *mut FullParams;
type FreeParamsFn = unsafe extern "C" fn(*mut FullParams);
type FullFn = unsafe extern "C" fn(*mut c_void, FullParams, *const f32, c_int) -> c_int;
type SegmentsFn = unsafe extern "C" fn(*mut c_void) -> c_int;
type SegmentTextFn = unsafe extern "C" fn(*mut c_void, c_int) -> *const c_char;
type FreeFn = unsafe extern "C" fn(*mut c_void);
type LogCallback = unsafe extern "C" fn(c_int, *const c_char, *mut c_void);
type LogSetFn = unsafe extern "C" fn(Option<LogCallback>, *mut c_void);

/// The library and the functions this uses, resolved once. The library is never unloaded: a
/// context may outlive any one call, and unloading code that a model still points into is how a
/// process dies an hour later.
struct Api {
    _library: Library,
    init: InitFn,
    context_defaults: ContextDefaultsFn,
    free_context_params: FreeContextParamsFn,
    full_defaults: FullDefaultsFn,
    free_params: FreeParamsFn,
    full: FullFn,
    segments: SegmentsFn,
    segment_text: SegmentTextFn,
    free: FreeFn,
}

// SAFETY: the function pointers are plain C entry points; the library handle is only kept alive.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

/// whisper.cpp's own logging goes nowhere: it writes a line per layer to stderr on every load.
unsafe extern "C" fn quiet(_level: c_int, _text: *const c_char, _user: *mut c_void) {}

/// Asked by whisper.cpp between computations: whether to stop.
unsafe extern "C" fn should_abort(user: *mut c_void) -> bool {
    !user.is_null() && unsafe { (*(user as *const AtomicBool)).load(Ordering::Relaxed) }
}

/// Set once the library has loaded. A failed load is not kept, so installing the engine again can
/// fix it without a restart.
static API: OnceLock<Api> = OnceLock::new();
static ABORT: AtomicBool = AtomicBool::new(false);

fn load(path: &Path) -> Result<Api, String> {
    // SAFETY: the library is the pinned whisper.cpp build `super` verified and unpacked.
    unsafe {
        #[cfg(windows)]
        let library = {
            // Its `ggml*.dll` sit beside it: resolve them from its folder, not from the app's.
            const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x100;
            const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x1000;
            libloading::os::windows::Library::load_with_flags(path, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
                .map(Library::from)
        };
        #[cfg(not(windows))]
        let library = Library::new(path);
        let library = library.map_err(|e| format!("Couldn't load the dictation engine ({}): {e}", path.display()))?;
        macro_rules! symbol {
            ($name:literal, $ty:ty) => {
                *library.get::<$ty>(concat!($name, "\0").as_bytes()).map_err(|e| format!("The dictation engine has no {}: {e}", $name))?
            };
        }
        let log_set: LogSetFn = symbol!("whisper_log_set", LogSetFn);
        log_set(Some(quiet), std::ptr::null_mut());
        // The Windows build keeps its CPU backends in `ggml-cpu-*.dll` and picks the one this
        // processor runs best; they are found where the library is, which the app's folder is not.
        #[cfg(windows)]
        if let Some(dir) = path.parent().and_then(|dir| CString::new(dir.to_string_lossy().as_bytes()).ok()) {
            let ggml = libloading::os::windows::Library::load_with_flags(
                path.with_file_name("ggml.dll"),
                0x100 | 0x1000,
            )
            .map(Library::from)
            .map_err(|e| format!("Couldn't load ggml.dll: {e}"))?;
            let load_all = *ggml
                .get::<unsafe extern "C" fn(*const c_char)>(b"ggml_backend_load_all_from_path\0")
                .map_err(|e| format!("ggml.dll has no backend loader: {e}"))?;
            load_all(dir.as_ptr());
            std::mem::forget(ggml);
        }
        Ok(Api {
            init: symbol!("whisper_init_from_file_with_params", InitFn),
            context_defaults: symbol!("whisper_context_default_params_by_ref", ContextDefaultsFn),
            free_context_params: symbol!("whisper_free_context_params", FreeContextParamsFn),
            full_defaults: symbol!("whisper_full_default_params_by_ref", FullDefaultsFn),
            free_params: symbol!("whisper_free_params", FreeParamsFn),
            full: symbol!("whisper_full", FullFn),
            segments: symbol!("whisper_full_n_segments", SegmentsFn),
            segment_text: symbol!("whisper_full_get_segment_text", SegmentTextFn),
            free: symbol!("whisper_free", FreeFn),
            _library: library,
        })
    }
}

fn api() -> Result<&'static Api, String> {
    if let Some(api) = API.get() {
        return Ok(api);
    }
    let path = super::engine_library().ok_or("The dictation engine is not installed — Settings › AI › Dictation")?;
    let loaded = load(&path)?;
    Ok(API.get_or_init(|| loaded))
}

/// A loaded model.
struct Loaded {
    path: PathBuf,
    context: *mut c_void,
}

// SAFETY: the context is only ever touched while `MODEL`'s lock is held.
unsafe impl Send for Loaded {}

static MODEL: Mutex<Option<Loaded>> = Mutex::new(None);

/// Text of `samples` — mono, 16 kHz, -1…1 — in `language` (`"auto"` to let the model tell).
/// Blocking: seconds of CPU or GPU work. Call it off the async runtime.
pub fn transcribe(model: &Path, samples: &[f32], language: &str) -> Result<String, String> {
    let api = api()?;
    let mut slot = MODEL.lock().map_err(|_| "The dictation engine is busy".to_string())?;
    if slot.as_ref().is_some_and(|loaded| loaded.path != model) {
        if let Some(old) = slot.take() {
            // SAFETY: a context made by `init`, freed once.
            unsafe { (api.free)(old.context) };
        }
    }
    if slot.is_none() {
        let path = CString::new(model.to_string_lossy().as_bytes()).map_err(|_| "The model's path has a NUL byte".to_string())?;
        // SAFETY: the defaults are the library's own; the copy is passed by value and the original freed.
        let context = unsafe {
            let defaults = (api.context_defaults)();
            if defaults.is_null() {
                return Err("The dictation engine could not start".into());
            }
            let params = *defaults;
            (api.free_context_params)(defaults);
            (api.init)(path.as_ptr(), params)
        };
        if context.is_null() {
            return Err(format!("The dictation model could not be loaded ({})", model.display()));
        }
        *slot = Some(Loaded { path: model.to_path_buf(), context });
    }
    let context = slot.as_ref().map(|loaded| loaded.context).unwrap_or(std::ptr::null_mut());
    let language = CString::new(if language.trim().is_empty() { "auto" } else { language.trim() }).unwrap_or_else(|_| c"auto".to_owned());
    ABORT.store(false, Ordering::Relaxed);
    // SAFETY: as above; `language` and `ABORT` outlive the call that reads them.
    let status = unsafe {
        let defaults = (api.full_defaults)(0); // WHISPER_SAMPLING_GREEDY
        if defaults.is_null() {
            return Err("The dictation engine could not start".into());
        }
        let mut params = *defaults;
        (api.free_params)(defaults);
        params.set_bool(offset::NO_TIMESTAMPS, true);
        params.set_bool(offset::PRINT_PROGRESS, false);
        params.set_bool(offset::PRINT_REALTIME, false);
        params.set_bool(offset::PRINT_TIMESTAMPS, false);
        params.set_pointer(offset::LANGUAGE, language.as_ptr().cast());
        params.set_bool(offset::DETECT_LANGUAGE, false);
        // No "[Música]", "(risas)" — a dictation wants the words.
        params.set_bool(offset::SUPPRESS_NST, true);
        params.set_pointer(offset::ABORT_CALLBACK, should_abort as *const c_void);
        params.set_pointer(offset::ABORT_CALLBACK_USER_DATA, (&ABORT as *const AtomicBool).cast());
        (api.full)(context, params, samples.as_ptr(), samples.len() as c_int)
    };
    if ABORT.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if status != 0 {
        return Err(format!("The dictation engine failed ({status})"));
    }
    let mut text = String::new();
    // SAFETY: segment texts belong to the context and are copied out before the lock is released.
    unsafe {
        for index in 0..(api.segments)(context) {
            let segment = (api.segment_text)(context, index);
            if !segment.is_null() {
                text.push_str(&CStr::from_ptr(segment).to_string_lossy());
            }
        }
    }
    Ok(clean(&text))
}

/// Stops a transcription under way, at whisper.cpp's next check.
pub fn abort() {
    ABORT.store(true, Ordering::Relaxed);
}

/// Frees the loaded model — before its file is deleted, and when dictation is switched off.
pub fn unload() {
    let Ok(mut slot) = MODEL.lock() else { return };
    if let (Some(loaded), Some(api)) = (slot.take(), API.get()) {
        // SAFETY: a context made by `init`, freed once, under the lock.
        unsafe { (api.free)(loaded.context) };
    }
}

/// The segments joined as one text: whisper starts each with a space, and marks a silence it
/// heard nothing in as `[BLANK_AUDIO]`.
fn clean(text: &str) -> String {
    let without = text.replace("[BLANK_AUDIO]", " ");
    without.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Little-endian 16-bit PCM as the samples whisper takes.
pub fn samples_of(pcm: &[u8]) -> Vec<f32> {
    pcm.chunks_exact(2).map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whispers_marks_are_cleaned_out() {
        assert_eq!(clean(" Hola, esto es una prueba. [BLANK_AUDIO]  Y otra."), "Hola, esto es una prueba. Y otra.");
        assert_eq!(clean("[BLANK_AUDIO]"), "");
    }

    #[test]
    fn pcm_becomes_samples() {
        let pcm = [0x00, 0x80, 0xff, 0x7f, 0x00, 0x00];
        assert_eq!(samples_of(&pcm), vec![-1.0, 32767.0 / 32768.0, 0.0]);
    }

    /// The real library and a real model, on a real clip: `CODEFLOW_TEST_WHISPER=<engine dir>:<model>:<wav>`.
    /// The WAV is 16 kHz mono PCM with a 44-byte header (`afconvert -f WAVE -d LEI16@16000 -c 1`).
    #[test]
    #[ignore]
    fn transcribes_a_clip() {
        let spec = std::env::var("CODEFLOW_TEST_WHISPER").expect("CODEFLOW_TEST_WHISPER=<engine dir>:<model>:<wav>");
        let mut parts = spec.splitn(3, ':');
        let (dir, model, wav) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
        let library = Path::new(dir).join(super::super::ENGINE.unwrap().library);
        API.get_or_init(|| load(&library).expect("the engine loads"));
        let bytes = std::fs::read(wav).expect("the clip");
        let started = std::time::Instant::now();
        let text = transcribe(Path::new(model), &samples_of(&bytes[44..]), "es").expect("a transcript");
        eprintln!("{:?} in {:?}", text, started.elapsed());
        assert!(text.to_lowercase().contains("prueba"), "{text}");
        // A second clip reuses the loaded model.
        let again = transcribe(Path::new(model), &samples_of(&bytes[44..]), "es").expect("again");
        assert_eq!(again, text);
        unload();
    }
}
