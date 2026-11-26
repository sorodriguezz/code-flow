//! The natural voices: **Pocket TTS** (Kyutai, MIT; weights CC BY 4.0), one small model that says
//! anything in any of its catalogue's twenty-seven voices.
//!
//! The user's call (2026-11-25), after hearing a team of sixteen share one downloaded voice moved a
//! few percent in pitch: one engine loaded once, and every agent a voice of its own that is really
//! another voice. Measured on the user's Mac (M4, CPU only) before a line of this was written: the
//! Spanish model starts sounding in some 50 ms and writes eight seconds of speech in one; every one
//! of the twenty-seven voices, the English-born ones too, was transcribed back word for word by a
//! speech recogniser except the acronyms [`super::pronounce`] respells anyway.
//!
//! **In a Python of the app's own**, like the cloned voices ([`super::clone`], whose folder and
//! interpreter rules these are): the model is PyTorch, on the CPU — it needs no card and gains
//! nothing from Apple's. A venv under `models/voice-python/`, made with the machine's Python 3.10+
//! or the self-contained one; deleting the engine deletes all of it.
//!
//! **One process, loaded once.** `pocket_server.py` holds a model per language (Spanish, English)
//! and a state per voice, written beside the weights the first time so the next start reads it. A
//! sentence per request, like every downloaded voice ([`super::synthesize_into`]). Measured on the
//! same Mac with the Spanish model and sixteen voices in memory: 1.2 s to start, 0.6 s more for the
//! first sentence, some 840 MB of memory — so it is let go after [`IDLE`] without a word, and the
//! next sentence starts it again.
//!
//! **Only the catalogue.** A voice from somebody's recording needs the weights Kyutai keeps behind
//! its terms and a Hugging Face login; the catalogue's voices need neither. Cloning stays where it
//! is, with its consent ([`super::clone`]).
//!
//! **For calls first, and for whoever chooses one.** They came for the calls, which hand them out
//! (`team::call::cast`); the user, on hearing them (2026-11-25, «es muy fluida»), asked for them in
//! the reading aloud and in Codi too. There they are *chosen*, never fallen into: «Automática»
//! keeps picking among Piper's and Kokoro's.
//!
//! **A language at a time.** The install brings the model of the app's language. The other one
//! comes down the first time a voice is asked to speak it ([`prepare_language`]) — in a process of
//! its own, so the engine keeps answering meanwhile — and until it is here that language is read by
//! the voice it would have had ([`speaks`]).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::piper;

/// Emitted with a [`PrepareEvent`] while the engine installs.
pub const EVENT: &str = "voice:pocket";
/// What pip installs: the engine's package; it brings its (CPU) torch with it.
const PACKAGE: &str = "pocket-tts>=4,<5";
/// What the venv and the weights of two languages come to, for the pane to say before downloading.
pub const ESTIMATE_BYTES: u64 = 1_500_000_000;
pub const LICENCE: &str = "MIT · CC BY 4.0";

const SERVER: &str = include_str!("pocket_server.py");

/// A voice of the catalogue.
pub struct PocketVoice {
    /// What an agent's voice holds: `pocket-` and the catalogue's own name.
    pub id: &'static str,
    pub label: &'static str,
    /// The catalogue's name, as the engine takes it.
    pub name: &'static str,
}

/// The catalogue, in the order voices are handed out: the Spanish-born one first, then a low voice
/// and a high one in turn — by the pitch each was measured at — so the agents sitting next to each
/// other in a call are the easiest to tell apart.
pub const VOICES: &[PocketVoice] = &[
    PocketVoice { id: "pocket-lola", label: "Lola", name: "lola" },
    PocketVoice { id: "pocket-javert", label: "Javert", name: "javert" },
    PocketVoice { id: "pocket-estelle", label: "Estelle", name: "estelle" },
    PocketVoice { id: "pocket-george", label: "George", name: "george" },
    PocketVoice { id: "pocket-vera", label: "Vera", name: "vera" },
    PocketVoice { id: "pocket-michael", label: "Michael", name: "michael" },
    PocketVoice { id: "pocket-jane", label: "Jane", name: "jane" },
    PocketVoice { id: "pocket-stuart_bell", label: "Stuart", name: "stuart_bell" },
    PocketVoice { id: "pocket-azelma", label: "Azelma", name: "azelma" },
    PocketVoice { id: "pocket-giovanni", label: "Giovanni", name: "giovanni" },
    PocketVoice { id: "pocket-rafael", label: "Rafael", name: "rafael" },
    PocketVoice { id: "pocket-peter_yearsley", label: "Peter", name: "peter_yearsley" },
    PocketVoice { id: "pocket-cosette", label: "Cosette", name: "cosette" },
    PocketVoice { id: "pocket-bill_boerst", label: "Bill", name: "bill_boerst" },
    PocketVoice { id: "pocket-anna", label: "Anna", name: "anna" },
    PocketVoice { id: "pocket-juergen", label: "Jürgen", name: "juergen" },
    PocketVoice { id: "pocket-eve", label: "Eve", name: "eve" },
    PocketVoice { id: "pocket-marius", label: "Marius", name: "marius" },
    PocketVoice { id: "pocket-fantine", label: "Fantine", name: "fantine" },
    PocketVoice { id: "pocket-daan", label: "Daan", name: "daan" },
    PocketVoice { id: "pocket-mary", label: "Mary", name: "mary" },
    PocketVoice { id: "pocket-paul", label: "Paul", name: "paul" },
    PocketVoice { id: "pocket-eponine", label: "Éponine", name: "eponine" },
    PocketVoice { id: "pocket-jean", label: "Jean", name: "jean" },
    PocketVoice { id: "pocket-caro_davy", label: "Caro", name: "caro_davy" },
    PocketVoice { id: "pocket-charles", label: "Charles", name: "charles" },
    PocketVoice { id: "pocket-alba", label: "Alba", name: "alba" },
];

pub fn voice(id: &str) -> Option<&'static PocketVoice> {
    VOICES.iter().find(|voice| voice.id == id)
}

/// The catalogue as rows of the voices list — the calls' and Settings': every one says any language
/// the engine has, and all of them come with its one install.
pub fn rows() -> Vec<piper::VoiceRow> {
    let installed = installed();
    VOICES
        .iter()
        .map(|voice| piper::VoiceRow {
            id: voice.id.into(),
            label: format!("Pocket · {}", voice.label).into(),
            lang: "multi",
            size_bytes: ESTIMATE_BYTES,
            licence: LICENCE,
            gender: "",
            installed,
            engine: "pocket",
        })
        .collect()
}

// --------------------------------------------------------------------------------- the install

/// `models/voice-python/`, the cloned voices' folder: one place for every Python the voices need.
fn root() -> PathBuf {
    super::clone::root()
}

fn venv() -> PathBuf {
    root().join("venv-pocket")
}

fn python() -> PathBuf {
    if cfg!(windows) {
        venv().join("Scripts").join("python.exe")
    } else {
        venv().join("bin").join("python")
    }
}

fn weights_dir() -> PathBuf {
    root().join("weights-pocket")
}

/// Written once an install has been proved by loading the model and saying a sentence.
fn ready_marker() -> PathBuf {
    root().join("pocket.ready")
}

pub fn installed() -> bool {
    python().is_file() && ready_marker().is_file()
}

/// The engine's name for the model that says `lang` (`pocket_server.py`'s `MODELS`).
fn model_name(lang: &str) -> &'static str {
    if lang == "es" { "spanish" } else { "english" }
}

/// Written when the model of a language has been loaded here once.
fn language_marker(lang: &str) -> PathBuf {
    weights_dir().join(format!("{}.ready", model_name(lang)))
}

/// Whether the engine can say `lang` without downloading anything: its model has been loaded here
/// before — the marker says so, and so does a voice's state in that language, which is all an
/// install made before the marker existed left behind.
pub fn speaks(lang: &str) -> bool {
    installed() && model_is_in(&weights_dir(), lang)
}

/// [`speaks`] for the weights under `weights` — apart, for the test.
fn model_is_in(weights: &Path, lang: &str) -> bool {
    let model = model_name(lang);
    if weights.join(format!("{model}.ready")).is_file() {
        return true;
    }
    let prefix = format!("{model}-");
    std::fs::read_dir(weights.join("voices"))
        .map(|entries| entries.flatten().any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)))
        .unwrap_or(false)
}

/// The languages being brought down right now, so nobody starts the same download twice.
static PREPARING: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Brings the model of `lang` here, with voice `id` in it, when it is not here yet. In an engine of
/// its own that ends with it: the download takes as long as the network allows, and the one that
/// is speaking must not wait behind it. Blocking; a second caller for the same language waits for
/// the first and finds it done.
pub fn prepare_language(lang: &str, id: &str) -> Result<(), String> {
    let lang = super::language(lang);
    let voice = voice(id).ok_or_else(|| format!("Unknown voice {id}"))?;
    if !installed() {
        return Err("Pocket TTS is not installed — Settings › Voice & sound › Models".into());
    }
    loop {
        if speaks(lang) {
            return Ok(());
        }
        let mut preparing = PREPARING.lock().map_err(|_| "The voice engine is busy".to_string())?;
        if !preparing.contains(&lang) {
            preparing.push(lang);
            break;
        }
        drop(preparing);
        std::thread::sleep(Duration::from_millis(400));
    }
    let result = Server::start().and_then(|mut server| server.ask(&serde_json::json!({ "op": "warm", "lang": lang, "voices": [voice.name] })));
    if result.is_ok() {
        let _ = std::fs::write(language_marker(lang), chrono::Utc::now().to_rfc3339());
    }
    if let Ok(mut preparing) = PREPARING.lock() {
        preparing.retain(|held| *held != lang);
    }
    result
}

/// [`prepare_language`] without waiting for it — from the voice that found the language missing and
/// goes on to read with another.
pub fn prepare_in_background(lang: &'static str, id: &str) {
    if PREPARING.lock().map(|preparing| preparing.contains(&lang)).unwrap_or(true) {
        return;
    }
    let id = id.to_string();
    std::thread::spawn(move || {
        if let Err(error) = prepare_language(lang, &id) {
            crate::applog::warn(&format!("speech: the natural voices could not get ready for {lang}: {error}"));
        }
    });
}

/// Bytes the venv and the weights hold on disk now.
pub fn bytes_on_disk() -> u64 {
    fn size(path: &Path) -> u64 {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() => std::fs::read_dir(path).map(|entries| entries.flatten().map(|e| size(&e.path())).sum()).unwrap_or(0),
            Ok(meta) if meta.is_file() => meta.len(),
            _ => 0,
        }
    }
    size(&venv()) + size(&weights_dir())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareEvent {
    /// `running` · `done` · `failed`.
    pub state: &'static str,
    pub line: Option<String>,
}

/// Installs the engine: a Python 3.10+ (the machine's, or the self-contained one), its venv, the
/// package, then the model of `lang` and every voice of the catalogue in it — so the first call
/// starts speaking at once instead of downloading. About a gigabyte and a few minutes, reported
/// line by line through `say`.
pub async fn prepare(lang: &str, say: &(dyn Fn(&str) + Sync)) -> Result<(), String> {
    use crate::learning::env;
    let root = root();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let interpreter = python();
    if !interpreter.is_file() {
        let system = match env::system_python().await.filter(|(_, version)| super::clone::version_at_least(version, 3, 10)) {
            Some((path, _)) => path,
            None => {
                let build = env::standalone_here().ok_or("This machine has no Python 3.10 or newer, and there is no self-contained build for it")?;
                env::install_standalone(&root, build, &say).await?
            }
        };
        say("Creating the environment…");
        env::run_logged(&system, &["-m".into(), "venv".into(), venv().to_string_lossy().to_string()], &say).await?;
    }
    env::run_logged(&interpreter, &["-m".into(), "pip".into(), "install".into(), "--upgrade".into(), "pip".into()], &say).await?;
    let mut install: Vec<String> = vec!["-m".into(), "pip".into(), "install".into(), PACKAGE.into()];
    // Linux's default torch brings CUDA with it, gigabytes this engine never uses.
    if cfg!(target_os = "linux") {
        install.extend(["--extra-index-url".to_string(), "https://download.pytorch.org/whl/cpu".to_string()]);
    }
    env::run_logged(&interpreter, &install, &say).await?;
    if env::output(&interpreter, &["-c", "import pocket_tts, torch; print(torch.__version__)"]).await.is_none() {
        return Err("Pocket TTS installed but does not import".into());
    }
    say("Downloading the model…");
    let lang = lang.to_string();
    let total = VOICES.len();
    // One voice at a time, so the pane can say how far along it is.
    for (index, voice) in VOICES.iter().enumerate() {
        say(&format!("Preparing the voices… {} / {total}", index + 1));
        let (lang, name) = (lang.clone(), voice.name);
        tokio::task::spawn_blocking(move || warm(&lang, &[name])).await.map_err(|e| e.to_string())??;
    }
    let _ = std::fs::write(language_marker(&lang), chrono::Utc::now().to_rfc3339());
    std::fs::write(ready_marker(), chrono::Utc::now().to_rfc3339()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes the engine: its venv, its weights, its markers. An agent given one of its voices speaks
/// with whatever the call hands out until it is back, and a text read with one is read by the
/// voice «Automática» would pick.
pub fn remove() {
    stop_server();
    let _ = std::fs::remove_dir_all(venv());
    let _ = std::fs::remove_dir_all(weights_dir());
    let _ = std::fs::remove_file(ready_marker());
}

// --------------------------------------------------------------------------------- the server

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static SERVER_HELD: Mutex<Option<Server>> = Mutex::new(None);
/// When the engine last said something, while it is running.
static LAST_USED: Mutex<Option<Instant>> = Mutex::new(None);
/// How long the engine is kept in memory with nothing to say. It holds the better part of a
/// gigabyte and is back in under two seconds, so a reading voice used now and then does not keep
/// it for the whole day.
const IDLE: Duration = Duration::from_secs(10 * 60);

/// Lets the engine go once it has been quiet for [`IDLE`]. One thread per engine started; it ends
/// with it.
fn watch_idle() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        let Ok(mut held) = SERVER_HELD.lock() else { return };
        if held.is_none() {
            return;
        }
        let quiet = LAST_USED.lock().ok().and_then(|used| *used).is_none_or(|used| used.elapsed() >= IDLE);
        if quiet {
            *held = None;
            return;
        }
    });
}

impl Server {
    /// Starts `pocket_server.py` and waits for it to say the package is there. No model yet: each
    /// language's loads the first time it is asked for.
    fn start() -> Result<Server, String> {
        let script = root().join("pocket_server.py");
        std::fs::write(&script, SERVER).map_err(|e| e.to_string())?;
        let weights = weights_dir();
        let mut cmd = Command::new(python());
        cmd.arg("-I")
            .arg(&script)
            .arg(weights.join("voices"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Its weights in its own folder, no telemetry, unbuffered output.
            .env("HF_HOME", weights.join("hf"))
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("PYTHONUNBUFFERED", "1");
        crate::tool_gateway::scrub_env_std(&mut cmd);
        crate::proc::hide_console_std(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the voice engine: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut line = String::new();
        stdout.read_line(&mut line).map_err(|e| e.to_string())?;
        let ready: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| format!("The voice engine said: {}", line.trim()))?;
        if ready.get("ready").and_then(serde_json::Value::as_bool) != Some(true) {
            let _ = child.kill();
            return Err(ready.get("error").and_then(serde_json::Value::as_str).unwrap_or("The voice engine did not load").to_string());
        }
        Ok(Server { child, stdin, stdout })
    }

    fn ask(&mut self, request: &serde_json::Value) -> Result<(), String> {
        writeln!(self.stdin, "{request}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        self.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
        let reply: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| "The voice engine stopped".to_string())?;
        if reply.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err(reply.get("error").and_then(serde_json::Value::as_str).unwrap_or("The voice engine failed").to_string())
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Runs `work` on the one server, started if it is not running. A server that stopped answering is
/// let go, so the next request starts another.
fn with_server<T>(work: impl FnOnce(&mut Server) -> Result<T, String>) -> Result<T, String> {
    let mut held = SERVER_HELD.lock().map_err(|_| "The voice engine is busy".to_string())?;
    if held.is_none() {
        *held = Some(Server::start()?);
        watch_idle();
    }
    let result = work(held.as_mut().expect("started above"));
    if let Ok(mut used) = LAST_USED.lock() {
        *used = Some(Instant::now());
    }
    if matches!(&result, Err(error) if error == "The voice engine stopped") {
        *held = None;
    }
    result
}

/// Ends the engine's process — on quit, and before its files are deleted.
pub fn stop_server() {
    if let Ok(mut held) = SERVER_HELD.lock() {
        *held = None;
    }
}

/// Loads the model of `lang` and the catalogue voices `names` into the running engine — at the
/// start of a call, so the first agent to speak does not wait for them. Blocking.
pub fn warm(lang: &str, names: &[&str]) -> Result<(), String> {
    with_server(|server| server.ask(&serde_json::json!({ "op": "warm", "lang": lang, "voices": names })))
}

/// Says `text` with catalogue voice `id` into `on_chunk`, all of it at once: the callers hand over
/// a sentence at a time already. Blocking — the first sentence in a language costs its model's load.
pub fn synthesize(id: &str, text: &str, lang: &str, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String> {
    let voice = voice(id).ok_or_else(|| format!("Unknown voice {id}"))?;
    if !installed() {
        return Err("Pocket TTS is not installed — Settings › Voice & sound › Models".into());
    }
    let scratch = root().join(format!("pocket-out-{}.wav", std::process::id()));
    with_server(|server| server.ask(&serde_json::json!({ "op": "say", "text": text, "lang": lang, "voice": voice.name, "out": scratch })))?;
    let bytes = std::fs::read(&scratch).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&scratch);
    let (samples, rate) = super::wav::parse(&bytes)?;
    on_chunk(&samples, rate);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_language_is_here_once_its_model_has_been_loaded() {
        let dir = std::env::temp_dir().join(format!("codeflow-pocket-test-{}", uuid::Uuid::new_v4().simple()));
        assert!(!model_is_in(&dir, "es") && !model_is_in(&dir, "en"), "nothing downloaded says nothing");
        // An install made before the marker existed: its voices' states are what says so.
        std::fs::create_dir_all(dir.join("voices")).unwrap();
        std::fs::write(dir.join("voices").join("spanish-lola.safetensors"), b"x").unwrap();
        assert!(model_is_in(&dir, "es"));
        assert!(!model_is_in(&dir, "en"), "Spanish being here does not make English be");
        std::fs::write(dir.join("english.ready"), b"x").unwrap();
        assert!(model_is_in(&dir, "en"));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((model_name("es"), model_name("en")), ("spanish", "english"));
    }

    #[test]
    fn the_catalogue_is_twenty_seven_voices_each_named_once() {
        assert_eq!(VOICES.len(), 27);
        let mut ids: Vec<&str> = VOICES.iter().map(|voice| voice.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 27);
        // An id is the catalogue's name behind the prefix, which is what the engine is sent.
        assert!(VOICES.iter().all(|voice| voice.id == format!("pocket-{}", voice.name)));
        assert_eq!(voice("pocket-lola").map(|voice| voice.name), Some("lola"));
        assert!(voice("lola").is_none() && voice("kokoro-ef_dora").is_none());
        // The Spanish-born voice is the first handed out.
        assert_eq!(VOICES[0].name, "lola");
    }

    #[test]
    fn its_rows_say_any_language_and_come_with_the_one_install() {
        let rows = rows();
        assert_eq!(rows.len(), VOICES.len());
        assert!(rows.iter().all(|row| row.engine == "pocket" && row.lang == "multi"));
        assert!(rows.iter().all(|row| row.installed == installed()));
    }

    /// The server's script is what the app writes to disk and runs: it has to be Python that parses.
    #[test]
    fn the_server_script_names_every_request_the_app_sends() {
        for op in ["\"say\"", "\"warm\"", "\"ping\""] {
            assert!(SERVER.contains(op), "{op}");
        }
        assert!(SERVER.contains("\"es\": \"spanish\"") && SERVER.contains("\"en\": \"english\""));
    }

    /// The whole road on a real machine: the venv, the package, the model, the voices, a sentence
    /// from two of them, and the engine gone again. Gigabytes and minutes — never part of a normal
    /// run. Into a folder of its own, so the user's install is not touched:
    /// `CODEFLOW_HOME=/some/scratch CODEFLOW_POCKET_EVAL=1 cargo test --lib speech::pocket::tests::eval -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "installs a real voice engine; set CODEFLOW_HOME and CODEFLOW_POCKET_EVAL"]
    async fn eval_the_engine_installs_and_speaks() {
        if std::env::var("CODEFLOW_POCKET_EVAL").is_err() || std::env::var("CODEFLOW_HOME").is_err() {
            return;
        }
        let started = std::time::Instant::now();
        prepare("es", &|line| println!("  {line}")).await.expect("the engine installs");
        println!("EVAL installed in {:.0}s, {} MB on disk", started.elapsed().as_secs_f32(), bytes_on_disk() / 1_000_000);
        assert!(installed());
        for id in ["pocket-lola", "pocket-javert"] {
            let begun = std::time::Instant::now();
            let (mut heard, mut at) = (0usize, 0u32);
            synthesize(id, "Hola, ya revisé la migración y el índice está listo.", "es", &mut |samples, rate| {
                heard += samples.len();
                at = rate;
                true
            })
            .expect("it speaks");
            let seconds = heard as f32 / at as f32;
            println!("EVAL {id}: {seconds:.1}s of audio at {at} Hz in {:.2}s", begun.elapsed().as_secs_f32());
            assert!(at == 24_000 && (1.5..12.0).contains(&seconds), "{seconds}s at {at}");
        }
        assert!(synthesize("pocket-nadie", "Hola.", "es", &mut |_, _| true).is_err());
        // The other language: not here after an install in Spanish, brought down by the first
        // voice asked to read it, and spoken from then on.
        assert!(speaks("es") && !speaks("en"), "the install brings the app's language only");
        let (before, begun) = (bytes_on_disk(), std::time::Instant::now());
        tokio::task::spawn_blocking(|| prepare_language("en", "pocket-george")).await.unwrap().expect("English comes down");
        println!("EVAL English ready in {:.0}s, {} MB more on disk", begun.elapsed().as_secs_f32(), (bytes_on_disk() - before) / 1_000_000);
        assert!(speaks("en") && language_marker("en").is_file());
        let begun = std::time::Instant::now();
        let (mut heard, mut at) = (0usize, 0u32);
        synthesize("pocket-george", "Hi, I finished reviewing the pull request and found two problems.", "en", &mut |samples, rate| {
            heard += samples.len();
            at = rate;
            true
        })
        .expect("it speaks English");
        println!("EVAL English: {:.1}s of audio in {:.2}s, the model's load included", heard as f32 / at as f32, begun.elapsed().as_secs_f32());
        let again = std::time::Instant::now();
        prepare_language("en", "pocket-lola").expect("a language that is here answers at once");
        assert!(again.elapsed().as_millis() < 200, "nothing is downloaded twice");
        remove();
        assert!(!installed() && !venv().exists());
    }
}
