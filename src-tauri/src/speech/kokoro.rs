//! Kokoro-82M: one model that speaks with fifty-four voices, through sherpa-onnx's offline TTS
//! (`super::sherpa`) like Piper's — the user asked for it (2026-10-21) as the light, natural voice.
//!
//! **One download, many voices.** The model (310 MB), its voice table and espeak-ng's data come in
//! one archive; every voice of [`VOICES`] is a speaker id in it, so choosing another voice costs
//! nothing. espeak-ng's data is the same as every Piper archive's (checked byte for byte), so it is
//! kept once, in Piper's shared folder.
//!
//! **Measured on an M4 (2026-10-21).** Loads in 0.4 s; five seconds of Spanish in 1.1 s on four
//! cores, 2 s on two — the first sentence after about 0.5 s. That is natural speech a modest laptop
//! still says faster than it is heard, but Piper is seven times faster, which is why the
//! recommendation (`crate::voice_fit`) picks this one only where the CPU has room. Read back by a
//! transcriber, the Spanish voices came out as clear as Piper's (13–15 % word errors against 14–16 %,
//! nearly all of them «Codi» and English product names).
//!
//! **A language is a different config.** Spanish is read through espeak-ng with `lang = "es"`;
//! English needs the lexicon too, and a lexicon on a Spanish text would turn its words that are
//! also English ones English. The loaded model is keyed by language, so switching from one to the
//! other reloads it (0.4–0.8 s) rather than reading one with the other's rules.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::piper;
use super::sherpa::{offsets, Config, Engine};

/// The archive: sherpa-onnx's `tts-models` release.
pub const PACK: Pack = Pack {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
    archive: "kokoro-multi-lang-v1_0.tar.bz2",
    size: 349_906_910,
    sha256: "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298",
    folder: "kokoro-multi-lang-v1_0",
    licence: "Apache-2.0",
};

#[derive(Debug, Clone, Copy)]
pub struct Pack {
    pub url: &'static str,
    pub archive: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub folder: &'static str,
    pub licence: &'static str,
}

/// What is kept of the archive besides espeak-ng's data: the Chinese dictionaries and rules are not.
const FILES: &[&str] = &["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-gb-en.txt", "LICENSE"];

/// One of the model's speakers.
#[derive(Debug, Clone, Copy)]
pub struct KokoroVoice {
    /// What `speech_local_voice_{es,en}` holds: `kokoro-` and the model's own name.
    pub id: &'static str,
    pub label: &'static str,
    pub lang: &'static str,
    /// The speaker id in `voices.bin` (the model's `speaker2id` metadata).
    pub sid: i32,
    pub gender: &'static str,
}

/// The app's two languages; every voice with the accent its name gives (`ef_` Spanish woman, `am_`
/// American man, `bf_` British woman…). The model has more English voices than these; these are the
/// ones its authors grade highest.
pub const VOICES: &[KokoroVoice] = &[
    KokoroVoice { id: "kokoro-ef_dora", label: "Kokoro · Dora", lang: "es-ES", sid: 28, gender: "female" },
    KokoroVoice { id: "kokoro-em_alex", label: "Kokoro · Alex", lang: "es-ES", sid: 29, gender: "male" },
    KokoroVoice { id: "kokoro-em_santa", label: "Kokoro · Santa", lang: "es-ES", sid: 53, gender: "male" },
    KokoroVoice { id: "kokoro-af_heart", label: "Kokoro · Heart", lang: "en-US", sid: 3, gender: "female" },
    KokoroVoice { id: "kokoro-af_bella", label: "Kokoro · Bella", lang: "en-US", sid: 2, gender: "female" },
    KokoroVoice { id: "kokoro-am_michael", label: "Kokoro · Michael", lang: "en-US", sid: 16, gender: "male" },
    KokoroVoice { id: "kokoro-am_fenrir", label: "Kokoro · Fenrir", lang: "en-US", sid: 14, gender: "male" },
    KokoroVoice { id: "kokoro-bf_emma", label: "Kokoro · Emma", lang: "en-GB", sid: 21, gender: "female" },
    KokoroVoice { id: "kokoro-bm_george", label: "Kokoro · George", lang: "en-GB", sid: 26, gender: "male" },
];

pub fn voice(id: &str) -> Option<&'static KokoroVoice> {
    VOICES.iter().find(|voice| voice.id == id)
}

pub fn dir() -> PathBuf {
    piper::root().join("kokoro")
}

/// The model is on disk — and with it every voice of [`VOICES`].
pub fn installed() -> bool {
    let dir = dir();
    FILES.iter().filter(|file| **file != "LICENSE").all(|file| dir.join(file).is_file()) && piper::espeak_dir().is_dir()
}

/// A voice as Settings shows it — the same shape as Piper's, so one list holds both.
pub fn rows() -> Vec<piper::VoiceRow> {
    let installed = installed();
    VOICES
        .iter()
        .map(|voice| piper::VoiceRow {
            id: voice.id.into(),
            label: voice.label.into(),
            lang: voice.lang,
            size_bytes: PACK.size,
            licence: PACK.licence,
            gender: voice.gender,
            installed,
            engine: "kokoro",
        })
        .collect()
}

/// Takes the archive apart: the model files into [`dir`], espeak-ng's data into Piper's shared
/// folder when it is not there yet. Through staging folders renamed into place.
pub fn unpack(archive: &Path) -> Result<(), String> {
    unpack_into(archive, &dir(), &piper::espeak_dir())
}

fn unpack_into(archive: &Path, dest: &Path, espeak: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    let staging = dest.with_extension("unpacking");
    let espeak_staging = espeak.with_extension("unpacking");
    let need_espeak = !espeak.is_dir();
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&espeak_staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("Couldn't create {}: {e}", staging.display()))?;
    let entries = tar.entries().map_err(|e| format!("The voice archive is damaged: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("The voice archive is damaged: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }
        let parts: Vec<String> = path
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        if parts.len() < 2 || parts[0] != PACK.folder {
            continue;
        }
        let inner = &parts[1..];
        let target = if inner[0] == "espeak-ng-data" {
            if !need_espeak || inner.len() < 2 {
                continue;
            }
            inner[1..].iter().fold(espeak_staging.clone(), |at, part| at.join(part))
        } else if inner.len() == 1 && FILES.contains(&inner[0].as_str()) {
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
    for file in FILES.iter().filter(|file| **file != "LICENSE") {
        if !staging.join(file).is_file() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("The voice archive has no {file}"));
        }
    }
    if need_espeak {
        if !espeak_staging.is_dir() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("The voice archive has no espeak-ng data".into());
        }
        std::fs::rename(&espeak_staging, espeak).map_err(|e| format!("Couldn't install the voice data: {e}"))?;
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&staging, dest).map_err(|e| format!("Couldn't install the voice: {e}"))
}

/// Deletes the model — and the shared espeak data when no Piper voice needs it either.
pub fn remove() {
    if let Ok(mut loaded) = LOADED.lock() {
        *loaded = None;
    }
    let _ = std::fs::remove_dir_all(dir());
    if !piper::any_installed() {
        let _ = std::fs::remove_dir_all(piper::espeak_dir());
    }
}

/// The loaded model and the language its config reads.
struct Loaded {
    lang: &'static str,
    engine: Engine,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

fn create(lang: &'static str, threads: i32) -> Result<Engine, String> {
    let dir = dir();
    let mut config = Config::new();
    config.path(offsets::KOKORO_MODEL, &dir.join("model.onnx"))?;
    config.path(offsets::KOKORO_VOICES, &dir.join("voices.bin"))?;
    config.path(offsets::KOKORO_TOKENS, &dir.join("tokens.txt"))?;
    config.path(offsets::KOKORO_DATA_DIR, &piper::espeak_dir())?;
    config.float(offsets::KOKORO_LENGTH_SCALE, 1.0);
    match lang {
        "es" => config.text(offsets::KOKORO_LANG, "es")?,
        "en-gb" => {
            config.text(offsets::KOKORO_LANG, "en-gb")?;
            config.path(offsets::KOKORO_LEXICON, &dir.join("lexicon-gb-en.txt"))?;
        }
        _ => {
            config.text(offsets::KOKORO_LANG, "en-us")?;
            config.path(offsets::KOKORO_LEXICON, &dir.join("lexicon-us-en.txt"))?;
        }
    }
    config.int(offsets::NUM_THREADS, threads.clamp(1, 4));
    config.text(offsets::PROVIDER, "cpu")?;
    config.int(offsets::MAX_NUM_SENTENCES, 1);
    config.float(offsets::SILENCE_SCALE, 0.2);
    Engine::create(config).map_err(|_| "The Kokoro voice could not be loaded".to_string())
}

/// The config a voice's accent reads with.
fn config_lang(voice: &KokoroVoice) -> &'static str {
    match voice.lang {
        "en-GB" => "en-gb",
        lang if lang.starts_with("es") => "es",
        _ => "en-us",
    }
}

/// Threads the voice gets: four where there are eight cores or more, else two — five seconds of
/// speech took 1.1 s on four, 2 s on two.
fn threads() -> i32 {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32;
    if cores >= 8 { 4 } else { 2 }
}

/// Says `text` with voice `id` at `speed`, a sentence at a time into `on_chunk` (samples, rate).
pub fn synthesize(id: &str, text: &str, speed: f32, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String> {
    if !piper::supported() {
        return Err("Downloaded voices are not available on this computer".into());
    }
    let voice = voice(id).ok_or_else(|| format!("Unknown voice {id}"))?;
    if !installed() {
        return Err("Kokoro is not downloaded — Settings › Voice & sound › Models".into());
    }
    let lang = config_lang(voice);
    let mut loaded = LOADED.lock().map_err(|_| "The voice is busy".to_string())?;
    if loaded.as_ref().map(|held| held.lang) != Some(lang) {
        *loaded = None;
        *loaded = Some(Loaded { lang, engine: create(lang, threads())? });
    }
    let held = loaded.as_ref().expect("loaded above");
    held.engine.generate(text, voice.sid, speed, on_chunk)
}

/// The model as a one-row summary for Settings' download list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRow {
    pub size_bytes: u64,
    pub licence: &'static str,
    pub installed: bool,
    pub voices: usize,
}

pub fn pack_row() -> PackRow {
    PackRow { size_bytes: PACK.size, licence: PACK.licence, installed: installed(), voices: VOICES.len() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_voice_has_its_accent_in_its_name() {
        for voice in VOICES {
            let name = voice.id.strip_prefix("kokoro-").expect("kokoro- prefix");
            let accent = &name[..1];
            let expected = match voice.lang {
                "es-ES" => "e",
                "en-US" => "a",
                "en-GB" => "b",
                other => panic!("unexpected {other}"),
            };
            assert_eq!(accent, expected, "{}", voice.id);
            assert_eq!(&name[1..2], if voice.gender == "female" { "f" } else { "m" }, "{}", voice.id);
            assert!(piper::spec(voice.id).is_none(), "ids never collide with Piper's");
        }
        assert_eq!(PACK.sha256.len(), 64);
        assert!(PACK.url.ends_with(PACK.archive));
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

    /// The real library and model: `CODEFLOW_TEST_KOKORO=<library>|<kokoro-multi-lang-v1_0 folder>`.
    /// Spanish through espeak-ng (no lexicon), English with its lexicon, a sentence per chunk.
    #[test]
    #[ignore]
    fn kokoro_speaks_both_languages() {
        let spec = std::env::var("CODEFLOW_TEST_KOKORO").expect("CODEFLOW_TEST_KOKORO=<library>|<model folder>");
        let parts: Vec<&str> = spec.split('|').collect();
        super::super::sherpa::load_library_for_test(Path::new(parts[0]));
        let folder = Path::new(parts[1]);
        for (lang, sid, text) in [("es", 28, "Listo, abrí Flujos. Terminé la revisión."), ("en-us", 3, "Done, I opened Flows. The review is finished.")] {
            let mut config = Config::new();
            config.path(offsets::KOKORO_MODEL, &folder.join("model.onnx")).unwrap();
            config.path(offsets::KOKORO_VOICES, &folder.join("voices.bin")).unwrap();
            config.path(offsets::KOKORO_TOKENS, &folder.join("tokens.txt")).unwrap();
            config.path(offsets::KOKORO_DATA_DIR, &folder.join("espeak-ng-data")).unwrap();
            config.float(offsets::KOKORO_LENGTH_SCALE, 1.0);
            config.text(offsets::KOKORO_LANG, lang).unwrap();
            if lang != "es" {
                config.path(offsets::KOKORO_LEXICON, &folder.join("lexicon-us-en.txt")).unwrap();
            }
            config.int(offsets::NUM_THREADS, 2);
            config.text(offsets::PROVIDER, "cpu").unwrap();
            config.int(offsets::MAX_NUM_SENTENCES, 1);
            config.float(offsets::SILENCE_SCALE, 0.2);
            let engine = Engine::create(config).unwrap();
            let started = std::time::Instant::now();
            let mut chunks = Vec::new();
            let mut rate = 0;
            engine
                .generate(text, sid, 1.0, &mut |chunk, at| {
                    chunks.push((chunk.len(), started.elapsed()));
                    rate = at;
                    true
                })
                .unwrap();
            eprintln!("{lang}: {chunks:?} at {rate} Hz");
            assert_eq!(rate, 24_000);
            assert_eq!(chunks.len(), 2, "{lang}: a chunk a sentence");
            assert!(chunks[0].1 < started.elapsed());
        }
    }
}
