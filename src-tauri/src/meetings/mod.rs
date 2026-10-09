//! «Reuniones»: a meeting recorded into a note, turned into text with who said what, and handed to
//! an AI engine for the minutes, the decisions, the tasks.
//!
//! **Two channels, never mixed before they are transcribed.** The microphone is "Tú"; the
//! computer's own output (Teams, Meet, Zoom — whatever plays) is everybody else. Knowing when the
//! person recording spoke is then a fact of the recording rather than a guess, and separating voices
//! only has to tell the *others* apart. A meeting in a room records the microphone alone, and every
//! voice in it is separated, the recorder's included.
//!
//! **The recording comes first; everything after it can be repeated.** Audio goes to disk as it is
//! heard, in sixty-second WAV pieces closed as they fill ([`audio::ChunkWriter`]), so a crash loses
//! at most the piece being written, and transcription, separation and compression all read those
//! files back. A laptop that cannot keep up with transcribing live (`live`) stops trying and leaves
//! the work for the end, without losing a second of audio.
//!
//! **Three modes, for three kinds of computer** (`Mode`): *light* only records and does the rest
//! when the meeting ends; *balanced* writes the text as people speak and separates voices at the
//! end; *full* also guesses speakers while recording and transcribes everything again at the end
//! with the largest model. *Auto* picks one from a measurement of this machine (`bench`).
//!
//! **Where the work happens.** Transcription is whisper.cpp — the library «Dictar» installs — on a
//! context of its own (`dictation::engine::MEETINGS`), or an OpenAI-compatible transcription API
//! when the user chose the cloud (`cloud`). Separating voices is speaker embeddings from sherpa-onnx
//! (`speaker`), a library downloaded on demand like whisper, clustered here. Nothing of it ships in
//! the installer.
//!
//! **A book can be local-only** (`note_books.local_only`): every meeting filed in it transcribes on
//! this computer and runs its AI on a local model, whatever the settings say — so a confidential
//! meeting does not depend on remembering a switch.

#[cfg(any(target_os = "macos", windows))]
pub mod recorder;
pub mod ai;
pub mod audio;
pub mod bench;
pub mod cloud;
pub mod detect;
pub mod encode;
pub mod live;
pub mod pipeline;
pub mod speaker;
pub mod transcript;
pub mod vad;

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::queries;

/// The settings this feature reads, all in `app_settings`.
pub mod key {
    /// `auto` · `light` · `balanced` · `full`.
    pub const MODE: &str = "meetings_mode";
    /// `local` · `cloud`.
    pub const TRANSCRIBER: &str = "meetings_transcriber";
    /// A whisper model id for the live text, `""` = the smallest good one installed.
    pub const LIVE_MODEL: &str = "meetings_live_model";
    /// A whisper model id for the final pass, `""` = the best one installed.
    pub const FINAL_MODEL: &str = "meetings_final_model";
    /// `{ "url", "model" }` of the cloud transcription API. Its key is in the OS keychain.
    pub const CLOUD: &str = "meetings_cloud";
    /// Threads whisper may use, `0` = half of this machine's.
    pub const THREADS: &str = "meetings_threads";
    /// Days the audio is kept: `0` = for good, `-1` = deleted once transcribed.
    pub const AUDIO_DAYS: &str = "meetings_audio_days";
    /// `1` to suggest taking notes when a call app is using the microphone.
    pub const DETECT: &str = "meetings_detect";
    /// The last measurement of this machine (`bench::Measured`, JSON).
    pub const BENCH: &str = "meetings_bench";
    /// The microphone, shared with «Dictar».
    pub const DEVICE: &str = "dictation_device";
    /// Words whisper should spell right — names, products, acronyms — one prompt for every meeting.
    pub const VOCABULARY: &str = "meetings_vocabulary";
}

/// The keychain entry holding the cloud transcription API's key.
pub const CLOUD_KEY_SECRET: &str = "meetings-cloud-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Light,
    Balanced,
    Full,
}

impl Mode {
    pub fn parse(raw: &str) -> Option<Mode> {
        match raw.trim() {
            "light" => Some(Mode::Light),
            "balanced" => Some(Mode::Balanced),
            "full" => Some(Mode::Full),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Light => "light",
            Mode::Balanced => "balanced",
            Mode::Full => "full",
        }
    }

    /// Whether text is written while the meeting runs.
    pub fn live(self) -> bool {
        self != Mode::Light
    }
}

/// The cloud transcription API: an OpenAI-compatible `/audio/transcriptions`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudSettings {
    /// Base URL, up to and including the version: `https://api.openai.com/v1`.
    pub url: String,
    pub model: String,
}

/// What the meetings read from Settings, resolved.
#[derive(Debug, Clone)]
pub struct Settings {
    /// `None` = automatic.
    pub mode: Option<Mode>,
    pub cloud: bool,
    pub cloud_settings: CloudSettings,
    pub live_model: String,
    pub final_model: String,
    pub threads: i32,
    pub audio_days: i64,
    pub detect: bool,
    pub device: String,
    pub vocabulary: String,
}

pub fn load_settings(conn: &Connection) -> Settings {
    let get = |name: &str| queries::get_setting(conn, name).ok().flatten().unwrap_or_default();
    Settings {
        mode: Mode::parse(&get(key::MODE)),
        cloud: get(key::TRANSCRIBER).trim() == "cloud",
        cloud_settings: serde_json::from_str(&get(key::CLOUD)).unwrap_or_default(),
        live_model: get(key::LIVE_MODEL),
        final_model: get(key::FINAL_MODEL),
        threads: get(key::THREADS).trim().parse().unwrap_or(0),
        audio_days: get(key::AUDIO_DAYS).trim().parse().unwrap_or(30),
        detect: get(key::DETECT).trim() != "0",
        device: get(key::DEVICE),
        vocabulary: get(key::VOCABULARY),
    }
}

/// Threads for whisper: the setting, or half of what this machine has — what keeps a call app
/// fluid on a four-core laptop while a meeting is transcribed beside it.
pub fn threads(setting: i32) -> i32 {
    if setting > 0 {
        return setting;
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32;
    (cores / 2).clamp(1, 8)
}

/// Lowers the calling thread's priority, best effort: when the machine has to choose between the
/// call and its transcription, the transcription waits. Threads whisper.cpp starts from here
/// inherit it on macOS.
pub fn lower_priority() {
    #[cfg(target_os = "macos")]
    {
        // QOS_CLASS_UTILITY.
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        // SAFETY: a plain libSystem call on the current thread.
        unsafe {
            pthread_set_qos_class_self_np(0x11, 0);
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
        // SAFETY: the pseudo-handle of the current thread.
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------------------------

/// `<state>/meetings/` — the recordings. Under the state root, never in a backup: the backup
/// carries the text, and the audio stays on the machine it was recorded on.
pub fn recordings_root() -> PathBuf {
    crate::paths::state_dir().join("meetings")
}

/// One meeting's folder: its audio pieces while it records, its compressed audio after.
pub fn meeting_dir(id: &str) -> PathBuf {
    recordings_root().join(id)
}

/// `models/meetings/` — the speaker-separation library and model, beside whisper's.
pub fn models_root() -> PathBuf {
    crate::paths::models_dir().join("meetings")
}

/// The voice detector whisper.cpp runs: Silero v5, converted to ggml by its authors.
pub const VAD_MODEL: ModelFile = ModelFile {
    file: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    size: 885_098,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
};

/// The speaker-embedding model: 3D-Speaker's CAM++, trained on Chinese and English speech — voices
/// are told apart by timbre, not by language.
pub const EMBEDDING_MODEL: ModelFile = ModelFile {
    file: "3dspeaker_campplus_zh_en_advanced.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    size: 28_281_164,
    sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
};

/// The id stored with a voice: an embedding from another model is not comparable with this one's.
pub const EMBEDDING_MODEL_ID: &str = "campplus-zh-en-advanced";

#[derive(Debug, Clone, Copy)]
pub struct ModelFile {
    pub file: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub fn vad_model_path() -> PathBuf {
    crate::dictation::root().join(VAD_MODEL.file)
}

pub fn embedding_model_path() -> PathBuf {
    models_root().join(EMBEDDING_MODEL.file)
}

/// sherpa-onnx's C library and the ONNX Runtime beside it, for this platform.
///
/// The full build, text to speech included: it is a megabyte more than the `no-tts` one meetings
/// first used, and it is what reads aloud with a downloaded voice (`crate::speech::piper`) — one
/// library for both, downloaded by whichever is set up first.
#[derive(Debug, Clone, Copy)]
pub struct LibrarySpec {
    pub url: &'static str,
    pub archive: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// The archive's entries kept, by file name.
    pub keep: &'static [&'static str],
    pub library: &'static str,
}

pub const SHERPA_VERSION: &str = "1.13.8";

#[cfg(target_os = "macos")]
pub const SHERPA: Option<LibrarySpec> = Some(LibrarySpec {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-universal2-shared-lib.tar.bz2",
    archive: "sherpa-onnx-v1.13.8-osx-universal2-shared-lib.tar.bz2",
    size: 18_819_320,
    sha256: "c1cca5b4a1867543e27d42fbea513983e73f629d0aa53b43b51555a71d2108d9",
    keep: &["libsherpa-onnx-c-api.dylib", "libonnxruntime.dylib"],
    library: "libsherpa-onnx-c-api.dylib",
});

/// The `MT` build: the C runtime linked in, so nothing depends on a Visual C++ redistributable.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub const SHERPA: Option<LibrarySpec> = Some(LibrarySpec {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib.tar.bz2",
    archive: "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib.tar.bz2",
    size: 8_032_957,
    sha256: "b8eedf41bd6d3779218887b48367bb7a3ece5aaa7667f01f69ee823a12b0a9e7",
    keep: &["sherpa-onnx-c-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"],
    library: "sherpa-onnx-c-api.dll",
});

#[cfg(not(any(target_os = "macos", all(target_os = "windows", target_arch = "x86_64"))))]
pub const SHERPA: Option<LibrarySpec> = None;

/// A folder per version, so a newer library never loads an older one's runtime — and per build:
/// `-full` since the library carries text to speech, so a `no-tts` one left from before is never
/// taken for it (see [`remove_stale_sherpa`]).
pub fn sherpa_dir() -> PathBuf {
    models_root().join(format!("sherpa-{SHERPA_VERSION}-full"))
}

/// The `no-tts` build's folder, which the full one replaces. Removed once the full one is in.
pub fn remove_stale_sherpa() {
    let _ = std::fs::remove_dir_all(models_root().join(format!("sherpa-{SHERPA_VERSION}")));
}

pub fn sherpa_library() -> Option<PathBuf> {
    let spec = SHERPA?;
    let path = sherpa_dir().join(spec.library);
    path.is_file().then_some(path)
}

/// Whether voices can be told apart on this machine right now.
pub fn voices_installed() -> bool {
    sherpa_library().is_some() && embedding_model_path().is_file()
}

/// Takes the kept files out of a `.tar.bz2` into `dest`, through a staging folder renamed into
/// place — a library folder that exists is a complete one.
pub fn unpack_library(spec: &LibrarySpec, archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    let staging = dest.with_extension("unpacking");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("Couldn't create {}: {e}", staging.display()))?;
    let entries = tar.entries().map_err(|e| format!("The library archive is damaged: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("The library archive is damaged: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if !spec.keep.contains(&name.as_str()) {
            continue;
        }
        let mut out = std::fs::File::create(staging.join(&name)).map_err(|e| format!("Couldn't write {name}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Couldn't unpack {name}: {e}"))?;
    }
    for name in spec.keep {
        if !staging.join(name).is_file() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("The library archive has no {name}"));
        }
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&staging, dest).map_err(|e| format!("Couldn't install the library: {e}"))
}

/// What Settings and the record button need to know.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Whether this platform records meetings at all.
    pub supported: bool,
    /// The whisper library «Dictar» installs.
    pub engine_installed: bool,
    pub vad_installed: bool,
    pub voices_installed: bool,
    pub voices_supported: bool,
    /// What installing the voices still downloads.
    pub voices_bytes: u64,
    pub models: Vec<crate::dictation::ModelStatus>,
}

pub fn status() -> Status {
    let dictation = crate::dictation::status();
    let library_bytes = if sherpa_library().is_some() { 0 } else { SHERPA.map_or(0, |spec| spec.size) };
    let model_bytes = if embedding_model_path().is_file() { 0 } else { EMBEDDING_MODEL.size };
    Status {
        supported: cfg!(any(target_os = "macos", windows)) && dictation.supported,
        engine_installed: dictation.engine_installed,
        vad_installed: vad_model_path().is_file(),
        voices_installed: voices_installed(),
        voices_supported: SHERPA.is_some(),
        voices_bytes: library_bytes + model_bytes,
        models: dictation.models,
    }
}

/// The whisper model a pass uses: the chosen one when it is installed, else the best installed one
/// for the job — the live text wants a fast model, the final pass an accurate one.
pub fn pick_model(chosen: &str, live: bool) -> Option<&'static crate::dictation::WhisperModel> {
    use crate::dictation::{model, model_path, MODELS};
    if let Some(found) = model(chosen.trim()).filter(|m| model_path(m).is_file()) {
        return Some(found);
    }
    let installed: Vec<_> = MODELS.iter().filter(|m| model_path(m).is_file()).collect();
    let preference: &[&str] = if live { &["base", "small", "tiny", "turbo"] } else { &["small", "turbo", "base", "tiny"] };
    preference.iter().find_map(|id| installed.iter().find(|m| m.id == *id).copied())
}

/// Spoken-time label for logs and AI transcripts: `1:02:03`, `12:34`.
pub fn clock(ms: i64) -> String {
    let total = (ms.max(0) / 1000) as u64;
    let (h, m, s) = (total / 3600, (total / 60) % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_round_trip() {
        for mode in [Mode::Light, Mode::Balanced, Mode::Full] {
            assert_eq!(Mode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(Mode::parse("auto"), None);
        assert!(!Mode::Light.live());
        assert!(Mode::Balanced.live());
    }

    #[test]
    fn clocks_read_like_a_player() {
        assert_eq!(clock(0), "00:00");
        assert_eq!(clock(754_900), "12:34");
        assert_eq!(clock(3_723_000), "1:02:03");
    }

    #[test]
    fn threads_leave_room_for_the_call() {
        assert_eq!(threads(3), 3);
        let auto = threads(0);
        assert!((1..=8).contains(&auto));
    }
}
