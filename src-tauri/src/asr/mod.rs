//! Speech to text on sherpa-onnx's offline recognizer — NVIDIA's Parakeet and Canary, exported to
//! ONNX by sherpa's authors and run on the CPU, beside whisper.cpp (`crate::dictation`).
//!
//! **Why a second engine.** Measured on an M4 (2026-10-21, the same clips through both): Parakeet
//! TDT 0.6B v3 heard 95 % of «Codi, …» orders and wrote dictation at 1.1 % word errors in about
//! 90 ms per order on four CPU cores — 100 ms on two — while whisper small needed 330 ms on the GPU
//! and 0.4–0.75 s on the CPU, and turbo 1.6 s / 4.1 s. whisper's encoder always works on a 30-second
//! window, so a two-second order costs nearly what thirty seconds do; Parakeet's does not. On a
//! Windows laptop without a graphics card — where the whisper library here is CPU-only anyway — that
//! is the difference between an assistant and a wait. Canary 180M Flash is the one that translates
//! (es ↔ en, de, fr), at a little less accuracy.
//!
//! **What it does not do.** Neither model gives the per-word times and "no speech" estimate the
//! meetings' final pass lines speakers up with, so that pass stays whisper's (`features` says who
//! may use what). NeMo itself (Python, CUDA) is not involved: the ONNX exports are the models.
//!
//! **Nothing ships in the installer.** The library is sherpa-onnx's, the one meetings and the
//! reading voices already download (`meetings::SHERPA`); each model is a pinned archive unpacked
//! into `models/asr/<id>/`.

pub mod recognizer;

use std::path::{Path, PathBuf};

use serde::Serialize;

pub use recognizer::{transcribe, unload_all, DICTATION, MEETINGS};

/// How a model is run: its family decides which fields of the recognizer's config it fills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    /// NeMo's token-and-duration transducer: encoder, decoder, joiner.
    Transducer,
    /// NeMo's Canary: an encoder and a decoder told the source and target language.
    Canary,
}

/// One model that can be downloaded.
#[derive(Debug, Clone, Copy)]
pub struct AsrModel {
    /// Stable: it is what `dictation_model` / `codi_listen_model` hold, beside whisper's ids.
    pub id: &'static str,
    pub label: &'static str,
    pub family: Family,
    pub url: &'static str,
    pub archive: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// The archive's top folder.
    pub folder: &'static str,
    /// What is kept of it — the model's files, and nothing of its test clips.
    pub files: &'static [&'static str],
    /// The language codes it hears ([`Family::Transducer`] tells by itself which one is spoken).
    pub languages: &'static [&'static str],
    /// Can write a language other than the one heard.
    pub translates: bool,
    pub licence: &'static str,
}

/// Sizes and digests from sherpa-onnx's `asr-models` release (GitHub's `digest` field).
pub const MODELS: &[AsrModel] = &[
    AsrModel {
        id: "parakeet",
        label: "Parakeet TDT 0.6B v3",
        family: Family::Transducer,
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
        archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
        size: 487_170_055,
        sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
        folder: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        files: &["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
        languages: &[
            "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es",
            "sv", "ru", "uk",
        ],
        translates: false,
        licence: "CC-BY-4.0",
    },
    AsrModel {
        id: "canary",
        label: "Canary 180M Flash",
        family: Family::Canary,
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2",
        archive: "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2",
        size: 153_692_328,
        sha256: "7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9",
        folder: "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
        files: &["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
        languages: &["en", "es", "de", "fr"],
        translates: true,
        licence: "CC-BY-4.0",
    },
];

pub fn model(id: &str) -> Option<&'static AsrModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// Whether this platform has the library at all — the offsets in [`recognizer`] are 64-bit ones.
pub fn supported() -> bool {
    crate::meetings::SHERPA.is_some() && cfg!(target_pointer_width = "64")
}

/// `models/asr/`.
pub fn root() -> PathBuf {
    crate::paths::models_dir().join("asr")
}

pub fn model_dir(model: &AsrModel) -> PathBuf {
    root().join(model.id)
}

/// The model's files are all there — not the library, which [`usable`] adds.
pub fn installed(model: &AsrModel) -> bool {
    let dir = model_dir(model);
    model.files.iter().all(|file| dir.join(file).is_file())
}

/// Installed and runnable right now: the library is in too.
pub fn usable(model: &AsrModel) -> bool {
    supported() && installed(model) && crate::meetings::sherpa_library().is_some()
}

/// The archive's kept files into the model's folder, through a staging folder renamed into place —
/// a model folder that exists is a complete one.
pub fn unpack(model: &AsrModel, archive: &Path) -> Result<(), String> {
    unpack_into(model, archive, &model_dir(model))
}

fn unpack_into(model: &AsrModel, archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    let staging = dest.with_extension("unpacking");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("Couldn't create {}: {e}", staging.display()))?;
    let entries = tar.entries().map_err(|e| format!("The model archive is damaged: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("The model archive is damaged: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        // `<folder>/<file>` exactly: the test clips and READMEs beside them stay out, and nothing
        // may climb out of the folder.
        let parts: Vec<String> = path
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        if parts.len() != 2 || parts[0] != model.folder || !model.files.contains(&parts[1].as_str()) {
            continue;
        }
        let target = staging.join(&parts[1]);
        let mut out = std::fs::File::create(&target).map_err(|e| format!("Couldn't write {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Couldn't unpack {}: {e}", target.display()))?;
    }
    for file in model.files {
        if !staging.join(file).is_file() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("The model archive has no {file}"));
        }
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&staging, dest).map_err(|e| format!("Couldn't install the model: {e}"))
}

/// Deletes a model — loaded recognizers let go of it first (Windows cannot delete an open file).
pub fn remove(model: &AsrModel) {
    unload_all();
    let _ = std::fs::remove_dir_all(model_dir(model));
    let _ = std::fs::remove_file(root().join("downloads").join(format!("{}.part", model.archive)));
}

pub fn any_installed() -> bool {
    MODELS.iter().any(installed)
}

/// The two-letter code `language` names, for a model that hears it — `""` / `auto` / an unknown one
/// is `None`, which a transducer reads as "tell by yourself" and Canary as "the app's language".
pub fn language_code(language: &str) -> Option<String> {
    let code = language.trim().to_ascii_lowercase();
    let code = code.split(['-', '_']).next().unwrap_or("").to_string();
    (code.len() == 2).then_some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_is_well_formed() {
        for model in MODELS {
            assert_eq!(model.sha256.len(), 64, "{}", model.id);
            assert!(model.url.ends_with(model.archive), "{}", model.id);
            assert!(model.archive.starts_with(model.folder), "{}", model.id);
            assert!(model.files.contains(&"tokens.txt"), "{}", model.id);
            assert!(model.languages.contains(&"es") && model.languages.contains(&"en"), "{}", model.id);
            // Never the same id as a whisper model: one setting holds either.
            assert!(crate::dictation::model(model.id).is_none(), "{}", model.id);
        }
        assert_eq!(model("parakeet").map(|m| m.family), Some(Family::Transducer));
        assert_eq!(model("canary").map(|m| m.family), Some(Family::Canary));
    }

    #[test]
    fn languages_fold_to_their_two_letters() {
        assert_eq!(language_code("es-MX").as_deref(), Some("es"));
        assert_eq!(language_code("EN_gb").as_deref(), Some("en"));
        assert_eq!(language_code("auto"), None);
        assert_eq!(language_code(""), None);
    }

    /// A real archive taken apart: `CODEFLOW_TEST_ASR_ARCHIVE=<canary .tar.bz2>`.
    #[test]
    #[ignore]
    fn an_archive_keeps_only_the_model_files() {
        let archive = std::env::var("CODEFLOW_TEST_ASR_ARCHIVE").expect("CODEFLOW_TEST_ASR_ARCHIVE=<archive>");
        let model = MODELS.iter().find(|m| archive.ends_with(m.archive)).expect("a catalogue archive");
        let dest = std::env::temp_dir().join(format!("codeflow-asr-test-{}", std::process::id()));
        unpack_into(model, Path::new(&archive), &dest).unwrap();
        let mut kept: Vec<String> = std::fs::read_dir(&dest).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        kept.sort();
        let mut want: Vec<String> = model.files.iter().map(|f| f.to_string()).collect();
        want.sort();
        assert_eq!(kept, want);
        let _ = std::fs::remove_dir_all(&dest);
    }
}
