//! «Dictar»: speech to text for the AI inputs, with whisper.cpp on this computer.
//!
//! **Nothing of it ships in the installer.** The user asked for it on demand: Settings → IA →
//! Dictado downloads the engine — whisper.cpp's own prebuilt library for this platform, pinned by
//! SHA-256 like every other download here — and one model, into `models/whisper/`. Until a model is
//! installed and chosen the app shows no microphone anywhere, and a build or a fresh install carries
//! no ML runtime it was not asked for.
//!
//! **The engine is a library loaded at run time, not a process.** whisper.cpp publishes no macOS
//! command-line binary — only an xcframework — so the library is what both platforms have in common:
//! the macOS slice of that framework (one universal dylib with Metal and Accelerate inside, nothing
//! but system frameworks outside), and `whisper.dll` with its `ggml*.dll` on Windows. `engine.rs`
//! talks to it through its C API.
//!
//! **The microphone is read here too** (`capture`, through the system's audio API), not in the
//! webview: the webview's `getUserMedia` brought its own browser-style permission prompt and could
//! not name the inputs for Settings' picker. `permission` asks the system's own question instead.
//! The audio stays in this process, is downsampled to 16 kHz mono here, and is never written to
//! disk; nothing leaves the machine.

#[cfg(any(target_os = "macos", windows))]
pub mod capture;
pub mod engine;
pub mod permission;

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The whisper.cpp build the engine comes from. `engine.rs`'s parameter layout is this build's —
/// bumping it means re-reading `struct whisper_full_params` (see `engine::FULL_PARAMS_SIZE`).
pub const ENGINE_BUILD: &str = "b5454";

/// One archive of the engine: where it is, how big, its digest, and which of its entries are kept.
#[derive(Debug, Clone, Copy)]
pub struct EngineSpec {
    pub url: &'static str,
    pub archive: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// `(path inside the archive, name kept)`. A path ending in `/` keeps every `.dll` under it whose
    /// name starts with one of the [`KEPT_DLLS`] prefixes.
    pub entries: &'static [(&'static str, &'static str)],
    /// The library to load, among what was kept.
    pub library: &'static str,
}

/// Which DLLs of the Windows archive the engine needs — the rest are its tools (`*.exe`, SDL2,
/// `llama.dll`, Parakeet).
pub const KEPT_DLLS: &[&str] = &["whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-"];

#[cfg(target_os = "macos")]
pub const ENGINE: Option<EngineSpec> = Some(EngineSpec {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-b5454-xcframework.zip",
    archive: "whisper-b5454-xcframework.zip",
    size: 65_816_082,
    sha256: "e57f8c48933000acabc13bb913fbe82805d483a2deff692cc6738836bd92393b",
    entries: &[("build-apple/whisper.xcframework/macos-arm64_x86_64/whisper.framework/Versions/A/whisper", "libwhisper.dylib")],
    library: "libwhisper.dylib",
});

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub const ENGINE: Option<EngineSpec> = Some(EngineSpec {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
    archive: "whisper-bin-x64.zip",
    size: 8_928_640,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
    entries: &[("Release/", "")],
    library: "whisper.dll",
});

#[cfg(not(any(target_os = "macos", all(target_os = "windows", target_arch = "x86_64"))))]
pub const ENGINE: Option<EngineSpec> = None;

/// One model of whisper.cpp's own repository — the multilingual ones, quantized.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModel {
    /// Stable: it is what the `dictation_model` setting holds.
    pub id: &'static str,
    pub file: &'static str,
    pub size_bytes: u64,
    #[serde(skip)]
    pub sha256: &'static str,
}

impl WhisperModel {
    pub fn url(&self) -> String {
        format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", self.file)
    }
}

/// Smallest first. Sizes and digests from the Hugging Face API (`lfs.oid` is the SHA-256).
/// `small` is the one recommended: measured here, it wrote "CodeFlow" and "pull request" where
/// `base` heard "Coldflow" and "pulrico", and still answered a five-second clip in 0.6 s.
pub const MODELS: &[WhisperModel] = &[
    WhisperModel {
        id: "base",
        file: "ggml-base-q5_1.bin",
        size_bytes: 59_707_625,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    },
    WhisperModel {
        id: "small",
        file: "ggml-small-q5_1.bin",
        size_bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    WhisperModel {
        id: "turbo",
        file: "ggml-large-v3-turbo-q5_0.bin",
        size_bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
];

pub fn model(id: &str) -> Option<&'static WhisperModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// `models/whisper/` — beside the completion models, under the state root the reset wipe spares.
pub fn root() -> PathBuf {
    crate::paths::models_dir().join("whisper")
}

/// The engine of [`ENGINE_BUILD`]: a folder per build, so a newer one never loads an older library.
pub fn engine_dir() -> PathBuf {
    root().join(format!("engine-{ENGINE_BUILD}"))
}

/// The library to load, once installed.
pub fn engine_library() -> Option<PathBuf> {
    let spec = ENGINE?;
    let path = engine_dir().join(spec.library);
    path.is_file().then_some(path)
}

pub fn model_path(model: &WhisperModel) -> PathBuf {
    root().join(model.file)
}

/// What Settings and the microphone need to know.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Whether this platform has an engine to install at all.
    pub supported: bool,
    pub engine_installed: bool,
    pub engine_bytes: u64,
    pub models: Vec<ModelStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    pub model: WhisperModel,
    pub installed: bool,
}

pub fn status() -> Status {
    Status {
        supported: ENGINE.is_some(),
        engine_installed: engine_library().is_some(),
        engine_bytes: ENGINE.map_or(0, |spec| spec.size),
        models: MODELS.iter().map(|model| ModelStatus { model: *model, installed: model_path(model).is_file() }).collect(),
    }
}

/// Takes what the engine needs out of its archive into `dest` — written to a folder beside it and
/// renamed into place, so an engine folder that exists is a complete one.
pub fn unpack_engine(spec: &EngineSpec, archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The engine archive is not a zip: {e}"))?;
    let staging = dest.with_extension("unpacking");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("Couldn't create {}: {e}", staging.display()))?;
    let mut kept = 0;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| format!("The engine archive is damaged: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let Some(target) = kept_name(spec, &name) else { continue };
        let mut out = std::fs::File::create(staging.join(&target)).map_err(|e| format!("Couldn't write {target}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Couldn't unpack {target}: {e}"))?;
        kept += 1;
    }
    if !staging.join(spec.library).is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("The engine archive has no {} ({kept} files kept)", spec.library));
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&staging, dest).map_err(|e| format!("Couldn't install the engine: {e}"))
}

/// The name an archive entry is kept under, or `None` for one the engine does not need.
fn kept_name(spec: &EngineSpec, entry: &str) -> Option<String> {
    for (path, keep) in spec.entries {
        if path.ends_with('/') {
            let Some(rest) = entry.strip_prefix(path) else { continue };
            if !rest.contains('/') && rest.ends_with(".dll") && KEPT_DLLS.iter().any(|prefix| rest.starts_with(prefix)) {
                return Some(rest.to_string());
            }
        } else if entry == *path {
            return Some(keep.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_is_well_formed() {
        for model in MODELS {
            assert_eq!(model.sha256.len(), 64, "{}", model.id);
            assert!(model.file.starts_with("ggml-") && model.file.ends_with(".bin"));
        }
        assert!(model("small").is_some());
        assert!(model("nope").is_none());
    }

    #[test]
    fn only_the_engine_files_are_kept() {
        let windows = EngineSpec { url: "", archive: "", size: 0, sha256: "", entries: &[("Release/", "")], library: "whisper.dll" };
        assert_eq!(kept_name(&windows, "Release/whisper.dll").as_deref(), Some("whisper.dll"));
        assert_eq!(kept_name(&windows, "Release/ggml-cpu-haswell.dll").as_deref(), Some("ggml-cpu-haswell.dll"));
        assert_eq!(kept_name(&windows, "Release/ggml-base.dll").as_deref(), Some("ggml-base.dll"));
        assert_eq!(kept_name(&windows, "Release/SDL2.dll"), None);
        assert_eq!(kept_name(&windows, "Release/llama.dll"), None);
        assert_eq!(kept_name(&windows, "Release/whisper-cli.exe"), None);
        let mac = EngineSpec { url: "", archive: "", size: 0, sha256: "", entries: &[("a/whisper", "libwhisper.dylib")], library: "libwhisper.dylib" };
        assert_eq!(kept_name(&mac, "a/whisper").as_deref(), Some("libwhisper.dylib"));
        assert_eq!(kept_name(&mac, "a/whisper.dSYM"), None);
    }
}
