//! A downloaded natural voice: Piper's VITS models, run by sherpa-onnx's offline TTS — the same
//! library meetings separate voices with (`meetings::SHERPA`, the full build), so a machine that has
//! one has half of the other.
//!
//! Measured on an M-series Mac: a voice loads in 0.3 s and writes 7.4 s of speech in 0.6 s of CPU.
//! The voice stays loaded between sentences ([`LOADED`]); a different voice, or removing it, lets
//! it go.
//!
//! **The config is opaque bytes.** `SherpaOnnxOfflineTtsConfig` nests nine model families' configs,
//! 448 bytes on a 64-bit build; mirroring all of them in Rust would be a page of structs that only
//! ever carry zeros. A zeroed buffer with the VITS fields written at their measured offsets (a C
//! probe against v1.13.8's `c-api.h`, `offsets`) is the same call with nothing to drift.

use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use libloading::Library;
use serde::Serialize;

/// One voice that can be downloaded.
#[derive(Debug, Clone, Copy)]
pub struct VoiceSpec {
    pub id: &'static str,
    /// Shown as is: the accent, then the speaker's name in Piper's catalogue.
    pub label: &'static str,
    pub lang: &'static str,
    pub url: &'static str,
    pub archive: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// The model's file inside the archive (and in the voice's folder).
    pub model: &'static str,
    /// The dataset's licence, from the voice's own model card.
    pub licence: &'static str,
    /// `female` · `male` · `nonbinary`. From the card where it says, and checked against the voice's
    /// published sample everywhere (median pitch: the women 172–203 Hz, the men 103–125 Hz, Sam —
    /// a voice made to be neither — 147 Hz).
    pub gender: &'static str,
}

/// The app's two languages, each text read by a voice of its own (`speech::local_voice`). Only voices
/// whose model card names a licence CodeFlow can repeat: the English ones are LibriVox and LJ Speech
/// recordings in the public domain, Sam (Accenture's non-binary voice, Apache-2.0) and an OpenSLR
/// speaker (CC BY-SA 4.0). Left out: Amy and Jenny (no licence stated), Lessac (Blizzard's
/// research-only terms), Ryan, the Hi-Fi Captain pair and Semaine (non-commercial).
pub const VOICES: &[VoiceSpec] = &[
    VoiceSpec {
        id: "es_MX-claude-high",
        label: "Español de México · Claude",
        lang: "es-MX",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_MX-claude-high.tar.bz2",
        archive: "vits-piper-es_MX-claude-high.tar.bz2",
        size: 67_207_890,
        sha256: "ec33fb689c248fe64810aab564cba97babf0f506672cfd404928d46e751a4721",
        model: "es_MX-claude-high.onnx",
        licence: "Apache-2.0",
        gender: "female",
    },
    VoiceSpec {
        id: "es_ES-davefx-medium",
        label: "Español de España · Davefx",
        lang: "es-ES",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_ES-davefx-medium.tar.bz2",
        archive: "vits-piper-es_ES-davefx-medium.tar.bz2",
        size: 67_184_952,
        sha256: "a3f6beb54a9cb893279f72978a22f807a4d9fc9c7848157b524d5cc7b7f58b22",
        model: "es_ES-davefx-medium.onnx",
        licence: "CC0",
        gender: "male",
    },
    VoiceSpec {
        id: "es_AR-daniela-high",
        label: "Español de Argentina · Daniela",
        lang: "es-AR",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_AR-daniela-high.tar.bz2",
        archive: "vits-piper-es_AR-daniela-high.tar.bz2",
        size: 115_562_134,
        sha256: "71cbf6b7f646ab74f3c51336151abef41e6c54467ac929ffdb19ed706a07dd7b",
        model: "es_AR-daniela-high.onnx",
        licence: "CC BY-SA 4.0",
        gender: "female",
    },
    VoiceSpec {
        id: "en_US-ljspeech-high",
        label: "English (US) · LJSpeech",
        lang: "en-US",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-ljspeech-high.tar.bz2",
        archive: "vits-piper-en_US-ljspeech-high.tar.bz2",
        size: 115_817_679,
        sha256: "00c6408d2409050312193b0d40ae07fde28af7d3d45a56efcc55440db516b935",
        model: "en_US-ljspeech-high.onnx",
        licence: "Public domain",
        gender: "female",
    },
    VoiceSpec {
        id: "en_US-norman-medium",
        label: "English (US) · Norman",
        lang: "en-US",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-norman-medium.tar.bz2",
        archive: "vits-piper-en_US-norman-medium.tar.bz2",
        size: 67_203_672,
        sha256: "1f32065d480abe9abc7c7f91442125d0b34c1cc065d1e600466cac408eabf3b8",
        model: "en_US-norman-medium.onnx",
        licence: "Public domain",
        gender: "male",
    },
    VoiceSpec {
        id: "en_US-sam-medium",
        label: "English (US) · Sam",
        lang: "en-US",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-sam-medium.tar.bz2",
        archive: "vits-piper-en_US-sam-medium.tar.bz2",
        size: 67_249_919,
        sha256: "7bcfcf73d7eb3dc7d2cba41ef4b1474d08819b581bafa9e9200821d607b74639",
        model: "en_US-sam-medium.onnx",
        licence: "Apache-2.0",
        gender: "nonbinary",
    },
    VoiceSpec {
        id: "en_GB-cori-high",
        label: "English (UK) · Cori",
        lang: "en-GB",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-cori-high.tar.bz2",
        archive: "vits-piper-en_GB-cori-high.tar.bz2",
        size: 115_574_061,
        sha256: "42922f07738fcde2e49eed4e959635692f73b933de35a6b7c1010162ff566292",
        model: "en_GB-cori-high.onnx",
        licence: "Public domain",
        gender: "female",
    },
    VoiceSpec {
        id: "en_GB-northern_english_male-medium",
        label: "English (UK) · Northern English",
        lang: "en-GB",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-northern_english_male-medium.tar.bz2",
        archive: "vits-piper-en_GB-northern_english_male-medium.tar.bz2",
        size: 67_210_490,
        sha256: "2bb2c1e709f58c11f17c693b3b38f500e110e7f54f2651774ec48b8d41f12c55",
        model: "en_GB-northern_english_male-medium.onnx",
        licence: "CC BY-SA 4.0",
        gender: "male",
    },
];

pub fn spec(id: &str) -> Option<&'static VoiceSpec> {
    VOICES.iter().find(|voice| voice.id == id)
}

/// Whether this platform has the library at all.
pub fn supported() -> bool {
    crate::meetings::SHERPA.is_some() && cfg!(target_pointer_width = "64")
}

pub fn root() -> PathBuf {
    crate::paths::models_dir().join("speech")
}

pub fn voice_dir(id: &str) -> PathBuf {
    root().join("voices").join(id)
}

/// espeak-ng's phoneme data, which every Piper voice needs and every archive carries a copy of —
/// identical across them, so it is kept once.
pub fn espeak_dir() -> PathBuf {
    root().join("espeak-ng-data")
}

pub fn installed(id: &str) -> bool {
    let Some(spec) = spec(id) else { return false };
    let dir = voice_dir(id);
    dir.join(spec.model).is_file() && dir.join("tokens.txt").is_file() && espeak_dir().is_dir()
}

pub fn any_installed() -> bool {
    VOICES.iter().any(|voice| installed(voice.id))
}

/// A voice as Settings shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRow {
    pub id: &'static str,
    pub label: &'static str,
    pub lang: &'static str,
    pub size_bytes: u64,
    pub licence: &'static str,
    pub gender: &'static str,
    pub installed: bool,
}

pub fn rows() -> Vec<VoiceRow> {
    VOICES
        .iter()
        .map(|voice| VoiceRow {
            id: voice.id,
            label: voice.label,
            lang: voice.lang,
            size_bytes: voice.size,
            licence: voice.licence,
            gender: voice.gender,
            installed: installed(voice.id),
        })
        .collect()
}

/// Takes a downloaded archive apart: the model, its tokens and its card into the voice's folder,
/// espeak-ng's data into the shared folder when it is not there yet. Each through a staging folder
/// renamed into place, so a folder that exists is a complete one.
pub fn unpack(spec: &VoiceSpec, archive: &Path) -> Result<(), String> {
    unpack_into(spec, archive, &root())
}

/// [`unpack`] under `root` instead of the app's — for the test.
fn unpack_into(spec: &VoiceSpec, archive: &Path, root: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    let dest = root.join("voices").join(spec.id);
    let staging = dest.with_extension("unpacking");
    let espeak = root.join("espeak-ng-data");
    let espeak_staging = espeak.with_extension("unpacking");
    let need_espeak = !espeak.is_dir();
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&espeak_staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("Couldn't create {}: {e}", staging.display()))?;
    let entries = tar.entries().map_err(|e| format!("The voice archive is damaged: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("The voice archive is damaged: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        // `vits-piper-…/<file>` or `vits-piper-…/espeak-ng-data/<…>`; nothing may climb out.
        let parts: Vec<String> = path.components().filter_map(|c| match c {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        }).collect();
        if parts.len() < 2 || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }
        let inner = &parts[1..];
        let target = if inner[0] == "espeak-ng-data" {
            if !need_espeak || inner.len() < 2 {
                continue;
            }
            inner[1..].iter().fold(espeak_staging.clone(), |at, part| at.join(part))
        } else if inner.len() == 1 && [spec.model, "tokens.txt", "MODEL_CARD"].contains(&inner[0].as_str()) || inner[0] == format!("{}.json", spec.model) {
            staging.join(&inner[0])
        } else {
            continue;
        };
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| format!("Couldn't write {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Couldn't unpack {}: {e}", target.display()))?;
    }
    if !staging.join(spec.model).is_file() || !staging.join("tokens.txt").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("The voice archive has no {}", spec.model));
    }
    if need_espeak {
        if !espeak_staging.is_dir() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("The voice archive has no espeak-ng data".into());
        }
        std::fs::rename(&espeak_staging, &espeak).map_err(|e| format!("Couldn't install the voice data: {e}"))?;
    }
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&staging, &dest).map_err(|e| format!("Couldn't install the voice: {e}"))
}

/// Deletes a voice — and the shared espeak data with the last one.
pub fn remove(id: &str) {
    if let Ok(mut loaded) = LOADED.lock() {
        if loaded.as_ref().is_some_and(|tts| tts.voice == id) {
            *loaded = None;
        }
    }
    let _ = std::fs::remove_dir_all(voice_dir(id));
    if !any_installed() {
        let _ = std::fs::remove_dir_all(espeak_dir());
    }
}

// ------------------------------------------------------------------------------------------ FFI

/// Byte offsets inside `SherpaOnnxOfflineTtsConfig` (v1.13.8, 64-bit), measured with `offsetof`.
mod offsets {
    pub const SIZE: usize = 448;
    pub const VITS_MODEL: usize = 0;
    pub const VITS_TOKENS: usize = 16;
    pub const VITS_DATA_DIR: usize = 24;
    pub const VITS_NOISE_SCALE: usize = 32;
    pub const VITS_NOISE_SCALE_W: usize = 36;
    pub const VITS_LENGTH_SCALE: usize = 40;
    pub const NUM_THREADS: usize = 56;
    pub const PROVIDER: usize = 64;
    pub const MAX_NUM_SENTENCES: usize = 424;
    pub const SILENCE_SCALE: usize = 440;
}

#[repr(C)]
struct GeneratedAudio {
    samples: *const f32,
    n: i32,
    sample_rate: i32,
}

type CreateFn = unsafe extern "C" fn(*const u8) -> *const c_void;
type DestroyFn = unsafe extern "C" fn(*const c_void);
type RateFn = unsafe extern "C" fn(*const c_void) -> i32;
type GenerateFn = unsafe extern "C" fn(*const c_void, *const c_char, i32, f32) -> *const GeneratedAudio;
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
            generate: symbol!("SherpaOnnxOfflineTtsGenerate", GenerateFn),
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

/// Loads the library from `path` instead of the installed one — for the live test.
#[cfg(test)]
pub fn load_library_for_test(path: &Path) {
    API.get_or_init(|| load(path).expect("the voice library loads"));
}

/// One loaded voice.
struct Tts {
    voice: String,
    handle: *const c_void,
}

// SAFETY: used under `LOADED`'s lock only.
unsafe impl Send for Tts {}

impl Drop for Tts {
    fn drop(&mut self) {
        if let Some(api) = API.get() {
            // SAFETY: created by `create` and not destroyed elsewhere.
            unsafe { (api.destroy)(self.handle) };
        }
    }
}

static LOADED: Mutex<Option<Tts>> = Mutex::new(None);

fn create(dir: &Path, model: &str, espeak: &Path, threads: i32) -> Result<*const c_void, String> {
    let api = api()?;
    let cstr = |path: &Path| CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "The voice's path has a NUL byte".to_string());
    let model = cstr(&dir.join(model))?;
    let tokens = cstr(&dir.join("tokens.txt"))?;
    let data = cstr(espeak)?;
    let provider = c"cpu";
    let mut config = [0u8; offsets::SIZE];
    let put_ptr = |buf: &mut [u8], at: usize, ptr: *const c_char| buf[at..at + 8].copy_from_slice(&(ptr as usize as u64).to_ne_bytes());
    let put_f32 = |buf: &mut [u8], at: usize, value: f32| buf[at..at + 4].copy_from_slice(&value.to_ne_bytes());
    let put_i32 = |buf: &mut [u8], at: usize, value: i32| buf[at..at + 4].copy_from_slice(&value.to_ne_bytes());
    put_ptr(&mut config, offsets::VITS_MODEL, model.as_ptr());
    put_ptr(&mut config, offsets::VITS_TOKENS, tokens.as_ptr());
    put_ptr(&mut config, offsets::VITS_DATA_DIR, data.as_ptr());
    // Piper's own defaults.
    put_f32(&mut config, offsets::VITS_NOISE_SCALE, 0.667);
    put_f32(&mut config, offsets::VITS_NOISE_SCALE_W, 0.8);
    put_f32(&mut config, offsets::VITS_LENGTH_SCALE, 1.0);
    put_i32(&mut config, offsets::NUM_THREADS, threads.clamp(1, 4));
    put_ptr(&mut config, offsets::PROVIDER, provider.as_ptr());
    put_i32(&mut config, offsets::MAX_NUM_SENTENCES, 1);
    put_f32(&mut config, offsets::SILENCE_SCALE, 0.2);
    // SAFETY: the buffer is the C struct's size, every pointer in it outlives the call (the library
    // copies the strings into its own config).
    let handle = unsafe { (api.create)(config.as_ptr()) };
    if handle.is_null() {
        return Err(format!("The voice could not be loaded ({})", dir.display()));
    }
    Ok(handle)
}

/// Says `text` with voice `id` at `speed` (1 = normal): mono samples and their rate.
pub fn synthesize(id: &str, text: &str, speed: f32) -> Result<(Vec<f32>, u32), String> {
    if !supported() {
        return Err("Downloaded voices are not available on this computer".into());
    }
    let spec = spec(id).ok_or_else(|| format!("Unknown voice {id}"))?;
    if !installed(id) {
        return Err("That voice is not downloaded — Settings › Voice & sound › Models".into());
    }
    let mut loaded = LOADED.lock().map_err(|_| "The voice is busy".to_string())?;
    if loaded.as_ref().map(|tts| tts.voice.as_str()) != Some(id) {
        *loaded = None;
        let handle = create(&voice_dir(id), spec.model, &espeak_dir(), 2)?;
        *loaded = Some(Tts { voice: id.to_string(), handle });
    }
    let tts = loaded.as_ref().expect("loaded above");
    let api = api()?;
    let text = CString::new(text.replace('\0', " ")).map_err(|_| "The text has a NUL byte".to_string())?;
    // SAFETY: the handle is live under the lock; the audio is freed below.
    unsafe {
        let audio = (api.generate)(tts.handle, text.as_ptr(), 0, speed.clamp(0.5, 2.0));
        if audio.is_null() {
            return Err("The voice said nothing".into());
        }
        let generated = &*audio;
        let samples = if generated.samples.is_null() || generated.n <= 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(generated.samples, generated.n as usize).to_vec()
        };
        let rate = if generated.sample_rate > 0 { generated.sample_rate as u32 } else { (api.rate)(tts.handle).max(1) as u32 };
        (api.destroy_audio)(audio);
        Ok((samples, rate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_voice_has_a_checksum_and_its_model_in_its_name() {
        for voice in VOICES {
            assert_eq!(voice.sha256.len(), 64, "{}", voice.id);
            assert!(voice.archive.contains(voice.id) && voice.model.starts_with(voice.id), "{}", voice.id);
            assert!(voice.url.ends_with(voice.archive), "{}", voice.id);
            assert!(["female", "male", "nonbinary"].contains(&voice.gender), "{}", voice.id);
            assert!(voice.id.starts_with(&voice.lang.replace('-', "_")), "{}", voice.id);
        }
    }

    /// Each of the app's languages can be read by a woman's voice and a man's.
    #[test]
    fn both_languages_have_both_kinds_of_voice() {
        for lang in ["es", "en"] {
            for gender in ["female", "male"] {
                assert!(VOICES.iter().any(|v| v.lang.starts_with(lang) && v.gender == gender), "{lang} {gender}");
            }
        }
    }

    /// A real archive taken apart: `CODEFLOW_TEST_PIPER_ARCHIVE=<the es_MX-claude-high .tar.bz2>`.
    /// The model and tokens land in the voice's folder, espeak's data once beside it.
    #[test]
    #[ignore]
    fn a_voice_archive_unpacks_into_its_folder_and_the_shared_data() {
        let archive = std::env::var("CODEFLOW_TEST_PIPER_ARCHIVE").expect("CODEFLOW_TEST_PIPER_ARCHIVE=<archive>");
        let root = std::env::temp_dir().join(format!("codeflow-piper-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let voice = spec("es_MX-claude-high").unwrap();
        unpack_into(voice, Path::new(&archive), &root).unwrap();
        let dir = root.join("voices").join(voice.id);
        assert!(dir.join(voice.model).is_file());
        assert!(dir.join("tokens.txt").is_file());
        assert!(!dir.join("espeak-ng-data").exists());
        assert!(root.join("espeak-ng-data").join("phontab").is_file());
        assert!(!dir.with_extension("unpacking").exists());
        // A second voice reuses the data folder rather than unpacking it again.
        unpack_into(voice, Path::new(&archive), &root).unwrap();
        assert!(root.join("espeak-ng-data").join("phontab").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The real library and voice: `CODEFLOW_TEST_PIPER=<library>|<voice folder>|<espeak-ng-data>`.
    #[test]
    #[ignore]
    fn a_piper_voice_speaks_spanish() {
        let spec_env = std::env::var("CODEFLOW_TEST_PIPER").expect("CODEFLOW_TEST_PIPER=<library>|<voice folder>|<espeak-ng-data>");
        let parts: Vec<&str> = spec_env.split('|').collect();
        load_library_for_test(Path::new(parts[0]));
        let dir = Path::new(parts[1]);
        let model = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|name| name.ends_with(".onnx"))
            .expect("an .onnx in the folder");
        let handle = create(dir, &model, Path::new(parts[2]), 2).unwrap();
        *LOADED.lock().unwrap() = Some(Tts { voice: "test".into(), handle });
        let api = api().unwrap();
        let text = CString::new("Hola, soy el pensamiento de CodeFlow.").unwrap();
        let started = std::time::Instant::now();
        let (samples, rate) = unsafe {
            let tts = LOADED.lock().unwrap();
            let audio = (api.generate)(tts.as_ref().unwrap().handle, text.as_ptr(), 0, 1.0);
            let generated = &*audio;
            let samples = std::slice::from_raw_parts(generated.samples, generated.n as usize).to_vec();
            let rate = generated.sample_rate as u32;
            (api.destroy_audio)(audio);
            (samples, rate)
        };
        eprintln!("{} samples at {rate} Hz in {:?}", samples.len(), started.elapsed());
        assert_eq!(rate, 22_050);
        assert!(samples.len() > rate as usize);
        *LOADED.lock().unwrap() = None;
    }
}
