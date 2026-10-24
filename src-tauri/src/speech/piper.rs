//! A downloaded natural voice: Piper's VITS models, run by sherpa-onnx's offline TTS — the same
//! library meetings separate voices with (`meetings::SHERPA`, the full build), so a machine that has
//! one has half of the other.
//!
//! Measured on an M-series Mac: a voice loads in 0.3 s and writes 7.4 s of speech in 0.6 s of CPU —
//! seven times faster than Kokoro (`super::kokoro`), which is why it is the voice a modest laptop
//! is recommended. The voice stays loaded between sentences ([`LOADED`]); a different voice, or
//! removing it, lets it go. The library calls are `super::sherpa`'s.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::sherpa::{offsets, Config, Engine};

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
    pub id: Cow<'static, str>,
    pub label: Cow<'static, str>,
    pub lang: &'static str,
    pub size_bytes: u64,
    pub licence: &'static str,
    pub gender: &'static str,
    pub installed: bool,
    /// `piper` · `kokoro` — Kokoro's voices are one download for all of them (`super::kokoro`).
    pub engine: &'static str,
}

pub fn rows() -> Vec<VoiceRow> {
    VOICES
        .iter()
        .map(|voice| VoiceRow {
            id: voice.id.into(),
            label: voice.label.into(),
            lang: voice.lang,
            size_bytes: voice.size,
            licence: voice.licence,
            gender: voice.gender,
            installed: installed(voice.id),
            engine: "piper",
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
    // Kokoro reads through the same data.
    if !any_installed() && !super::kokoro::installed() {
        let _ = std::fs::remove_dir_all(espeak_dir());
    }
}

// ------------------------------------------------------------------------------------------ FFI

/// One loaded voice.
struct Tts {
    voice: String,
    engine: Engine,
}

static LOADED: Mutex<Option<Tts>> = Mutex::new(None);

/// The Piper voice held in memory, if any (`crate::background`); never waits on a sentence.
pub fn loaded() -> Option<String> {
    LOADED.try_lock().ok()?.as_ref().map(|tts| tts.voice.clone())
}


/// Frees the Piper voice held in memory — battery saving at its most (`crate::power::set_saving`). The
/// next sentence loads it again.
pub fn unload() {
    if let Ok(mut held) = LOADED.lock() {
        *held = None;
    }
}
fn create(dir: &Path, model: &str, espeak: &Path, threads: i32) -> Result<Engine, String> {
    let mut config = Config::new();
    config.path(offsets::VITS_MODEL, &dir.join(model))?;
    config.path(offsets::VITS_TOKENS, &dir.join("tokens.txt"))?;
    config.path(offsets::VITS_DATA_DIR, espeak)?;
    // Piper's own defaults.
    config.float(offsets::VITS_NOISE_SCALE, 0.667);
    config.float(offsets::VITS_NOISE_SCALE_W, 0.8);
    config.float(offsets::VITS_LENGTH_SCALE, 1.0);
    config.int(offsets::NUM_THREADS, threads.clamp(1, 4));
    config.text(offsets::PROVIDER, "cpu")?;
    config.int(offsets::MAX_NUM_SENTENCES, 1);
    config.float(offsets::SILENCE_SCALE, 0.2);
    Engine::create(config).map_err(|_| format!("The voice could not be loaded ({})", dir.display()))
}

/// Says `text` with voice `id` at `speed` (1 = normal), a sentence at a time into `on_chunk`
/// (mono samples and their rate; `false` stops it).
pub fn synthesize(id: &str, text: &str, speed: f32, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String> {
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
        let engine = create(&voice_dir(id), spec.model, &espeak_dir(), 2)?;
        *loaded = Some(Tts { voice: id.to_string(), engine });
    }
    let tts = loaded.as_ref().expect("loaded above");
    tts.engine.generate(text, 0, speed, on_chunk)
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
    /// Two sentences come out as two chunks, the first before the whole text is written.
    #[test]
    #[ignore]
    fn a_piper_voice_speaks_spanish() {
        let spec_env = std::env::var("CODEFLOW_TEST_PIPER").expect("CODEFLOW_TEST_PIPER=<library>|<voice folder>|<espeak-ng-data>");
        let parts: Vec<&str> = spec_env.split('|').collect();
        super::super::sherpa::load_library_for_test(Path::new(parts[0]));
        let dir = Path::new(parts[1]);
        let model = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|name| name.ends_with(".onnx"))
            .expect("an .onnx in the folder");
        let engine = create(dir, &model, Path::new(parts[2]), 2).unwrap();
        let started = std::time::Instant::now();
        let mut chunks: Vec<(usize, std::time::Duration)> = Vec::new();
        let mut rate = 0;
        engine
            .generate("Hola, soy el pensamiento de CodeFlow. Terminé de revisar el pull request.", 0, 1.0, &mut |chunk, at| {
                chunks.push((chunk.len(), started.elapsed()));
                rate = at;
                true
            })
            .unwrap();
        eprintln!("{chunks:?} at {rate} Hz in {:?}", started.elapsed());
        assert_eq!(rate, 22_050);
        assert_eq!(chunks.len(), 2, "one chunk a sentence");
        assert!(chunks.iter().map(|(n, _)| n).sum::<usize>() > rate as usize);
    }
}
