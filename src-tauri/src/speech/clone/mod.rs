//! Voices made from a recording: the user (or somebody who said yes) speaks fifteen seconds, and a
//! model reads anything in that voice. The user's choice (2026-10-21): **Chatterbox Multilingual**
//! (Resemble AI, MIT, 23 languages with Spanish) by default, and **XTTS v2** as an option behind its
//! licence — the Coqui Public Model License allows non-commercial use only, Coqui closed in 2024 and
//! there is nobody left to buy another licence from, so it is downloaded only after the user accepts
//! that ([`XTTS_TERMS_KEY`]).
//!
//! **In a Python of the app's own.** Both are PyTorch models with no ONNX export worth running, so
//! each gets a venv of its own under `models/voice-python/` (Chatterbox pins its own torch; XTTS's
//! library wants another), made with the machine's Python 3.10+ or, without one, the self-contained
//! CPython the training environment already downloads (`learning::env`). Nothing is installed
//! outside that folder; deleting an engine deletes its venv and its weights.
//!
//! **One process per engine, loaded once.** `voice_server.py` loads the model (seconds) and answers a
//! sentence per request, so a voice speaks a sentence at a time like the others (`super::speak`).
//! It runs on CUDA when there is a card, on the Apple GPU for Chatterbox, else on the CPU — where it
//! is slow, which the pane says before anything is downloaded.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The setting holding when the user accepted XTTS v2's licence (RFC 3339), empty when not.
pub const XTTS_TERMS_KEY: &str = "voice_xtts_terms_accepted";
/// The licence the user accepts, linked from the pane.
pub const XTTS_TERMS_URL: &str = "https://coqui.ai/cpml";
/// Emitted with a [`PrepareEvent`] while an engine installs.
pub const EVENT: &str = "voice:clone";

const SERVER: &str = include_str!("voice_server.py");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Chatterbox,
    Xtts,
}

impl Engine {
    pub fn parse(raw: &str) -> Option<Engine> {
        match raw.trim() {
            "chatterbox" => Some(Engine::Chatterbox),
            "xtts" => Some(Engine::Xtts),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Chatterbox => "chatterbox",
            Engine::Xtts => "xtts",
        }
    }

    /// What pip installs: the engine's own package, pinned; it brings its torch with it.
    fn packages(self) -> &'static [&'static str] {
        match self {
            Engine::Chatterbox => &["chatterbox-tts==0.1.7"],
            Engine::Xtts => &["coqui-tts==0.28.0"],
        }
    }

    /// The import that proves an install.
    fn probe(self) -> &'static str {
        match self {
            Engine::Chatterbox => "import chatterbox.mtl_tts, torch; print(torch.__version__)",
            Engine::Xtts => "import TTS.api, torch; print(torch.__version__)",
        }
    }

    pub fn licence(self) -> &'static str {
        match self {
            Engine::Chatterbox => "MIT",
            Engine::Xtts => "CPML (non-commercial)",
        }
    }

    /// About what it takes on disk once its weights are in: the venv (PyTorch and the rest) plus the
    /// model. Said before the download; the real figure is read from the folder after.
    pub fn estimate_bytes(self) -> u64 {
        match self {
            Engine::Chatterbox => 4_500_000_000,
            Engine::Xtts => 4_000_000_000,
        }
    }
}

/// `models/voice-python/`.
pub fn root() -> PathBuf {
    crate::paths::models_dir().join("voice-python")
}

fn venv(engine: Engine) -> PathBuf {
    root().join(format!("venv-{}", engine.as_str()))
}

fn python(engine: Engine) -> PathBuf {
    let venv = venv(engine);
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Written once an install has been proved by importing it and loading the model.
fn ready_marker(engine: Engine) -> PathBuf {
    root().join(format!("{}.ready", engine.as_str()))
}

pub fn installed(engine: Engine) -> bool {
    python(engine).is_file() && ready_marker(engine).is_file()
}

/// Bytes an engine's venv and weights hold on disk now.
pub fn bytes_on_disk(engine: Engine) -> u64 {
    fn size(path: &Path) -> u64 {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() => std::fs::read_dir(path).map(|entries| entries.flatten().map(|e| size(&e.path())).sum()).unwrap_or(0),
            Ok(meta) if meta.is_file() => meta.len(),
            _ => 0,
        }
    }
    size(&venv(engine)) + size(&weights_dir(engine))
}

fn weights_dir(engine: Engine) -> PathBuf {
    root().join(format!("weights-{}", engine.as_str()))
}

/// The environment every Python started here gets: its weights in its own folder, no telemetry,
/// unbuffered output, the app's secrets scrubbed, no console window — and XTTS's licence agreed only
/// when the user agreed to it.
fn environment(cmd: &mut Command, engine: Engine, terms_accepted: bool) {
    let weights = weights_dir(engine);
    cmd.env("HF_HOME", weights.join("hf"))
        .env("TTS_HOME", weights.join("tts"))
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1");
    if engine == Engine::Xtts && terms_accepted {
        cmd.env("COQUI_TOS_AGREED", "1");
    }
    crate::tool_gateway::scrub_env_std(cmd);
    crate::proc::hide_console_std(cmd);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareEvent {
    pub engine: &'static str,
    /// `running` · `done` · `failed`.
    pub state: &'static str,
    pub line: Option<String>,
}

/// Installs `engine`: a Python 3.10+ (the machine's, or the self-contained one), its venv, its
/// packages, then one load of the model so its weights come down now and not on the first sentence.
/// Long — gigabytes — and reported line by line through `say`.
pub async fn prepare(engine: Engine, terms_accepted: bool, say: &(dyn Fn(&str) + Sync)) -> Result<(), String> {
    use crate::learning::env;
    if engine == Engine::Xtts && !terms_accepted {
        return Err("XTTS_TERMS".into());
    }
    let root = root();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let interpreter = python(engine);
    if !interpreter.is_file() {
        let system = match env::system_python().await.filter(|(_, version)| version_at_least(version, 3, 10)) {
            Some((path, _)) => path,
            None => {
                let build = env::standalone_here().ok_or("This machine has no Python 3.10 or newer, and there is no self-contained build for it")?;
                env::install_standalone(&root, build, &say).await?
            }
        };
        say("Creating the environment…");
        env::run_logged(&system, &["-m".into(), "venv".into(), venv(engine).to_string_lossy().to_string()], &say).await?;
    }
    env::run_logged(&interpreter, &["-m".into(), "pip".into(), "install".into(), "--upgrade".into(), "pip".into()], &say).await?;
    let mut install: Vec<String> = vec!["-m".into(), "pip".into(), "install".into()];
    install.extend(engine.packages().iter().map(|p| p.to_string()));
    env::run_logged(&interpreter, &install, &say).await?;
    if env::output(&interpreter, &["-c", engine.probe()]).await.is_none() {
        return Err(format!("{} installed but does not import", engine.as_str()));
    }
    say("Downloading the model…");
    let warm_engine = engine;
    tokio::task::spawn_blocking(move || Server::start(warm_engine, terms_accepted).map(drop)).await.map_err(|e| e.to_string())??;
    std::fs::write(ready_marker(engine), chrono::Utc::now().to_rfc3339()).map_err(|e| e.to_string())?;
    Ok(())
}

fn version_at_least(text: &str, major: u32, minor: u32) -> bool {
    let mut parts = text.trim().split('.').filter_map(|p| p.parse::<u32>().ok());
    matches!((parts.next(), parts.next()), (Some(a), Some(b)) if (a, b) >= (major, minor))
}

/// Deletes an engine: its venv, its weights, its marker — and the voices made with it stay, waiting
/// for it to come back.
pub fn remove(engine: Engine) {
    stop_server();
    let _ = std::fs::remove_dir_all(venv(engine));
    let _ = std::fs::remove_dir_all(weights_dir(engine));
    let _ = std::fs::remove_file(ready_marker(engine));
}

// --------------------------------------------------------------------------------- voices

/// A voice made from a recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClonedVoice {
    /// `clone-…` — what `speech_local_voice_{es,en}` and `codi_voice_*` hold.
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub created_at: String,
    /// The person recorded said yes to having their voice cloned (the pane asks; it is kept here).
    pub consent: bool,
    #[serde(default)]
    pub seconds: f32,
}

fn voices_dir() -> PathBuf {
    root().join("voices")
}

fn voice_dir(id: &str) -> PathBuf {
    voices_dir().join(id)
}

fn reference(id: &str) -> PathBuf {
    voice_dir(id).join("ref.wav")
}

pub fn is_cloned(id: &str) -> bool {
    id.starts_with("clone-")
}

pub fn voices() -> Vec<ClonedVoice> {
    let Ok(entries) = std::fs::read_dir(voices_dir()) else { return Vec::new() };
    let mut voices: Vec<ClonedVoice> = entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("voice.json")).ok())
        .filter_map(|raw| serde_json::from_str(&raw).ok())
        .collect();
    voices.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    voices
}

pub fn voice(id: &str) -> Option<ClonedVoice> {
    voices().into_iter().find(|voice| voice.id == id)
}

/// The voice can speak now: its recording is there and its engine is installed.
pub fn ready(id: &str) -> bool {
    voice(id).is_some_and(|voice| reference(id).is_file() && installed(voice.engine))
}

/// The shortest recording a voice is made from, and the longest kept (the models read 6–15 s).
pub const MIN_SECONDS: f32 = 6.0;
pub const MAX_SECONDS: f32 = 20.0;

/// Makes a voice from `samples` (mono at `rate`): trimmed of the silence around it, levelled, saved
/// as a 16-bit WAV beside its description.
pub fn create(name: &str, engine: Engine, consent: bool, samples: &[f32], rate: u32) -> Result<ClonedVoice, String> {
    if !consent {
        return Err("A voice is cloned only with the consent of the person who speaks".into());
    }
    let trimmed = trim(samples, rate);
    let seconds = trimmed.len() as f32 / rate.max(1) as f32;
    if seconds < MIN_SECONDS {
        return Err(format!("CLONE_TOO_SHORT:{seconds:.1}"));
    }
    let keep = (MAX_SECONDS * rate as f32) as usize;
    let trimmed = &trimmed[..trimmed.len().min(keep)];
    let peak = trimmed.iter().fold(0f32, |m, v| m.max(v.abs())).max(1e-4);
    let levelled: Vec<f32> = trimmed.iter().map(|v| (v / peak * 0.9).clamp(-1.0, 1.0)).collect();
    let id = format!("clone-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let dir = voice_dir(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(reference(&id), wav16(&levelled, rate)).map_err(|e| e.to_string())?;
    let voice = ClonedVoice {
        id: id.clone(),
        name: name.trim().chars().take(60).collect::<String>().trim().to_string(),
        engine,
        created_at: chrono::Utc::now().to_rfc3339(),
        consent,
        seconds: levelled.len() as f32 / rate.max(1) as f32,
    };
    let voice = if voice.name.is_empty() { ClonedVoice { name: "Mi voz".into(), ..voice } } else { voice };
    std::fs::write(dir.join("voice.json"), serde_json::to_string_pretty(&voice).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(voice)
}

pub fn delete(id: &str) {
    if is_cloned(id) {
        let _ = std::fs::remove_dir_all(voice_dir(id));
    }
}

/// The recording without the silence before and after it (anything under 2 % of its peak, with a
/// tenth of a second kept on each side).
fn trim(samples: &[f32], rate: u32) -> Vec<f32> {
    let peak = samples.iter().fold(0f32, |m, v| m.max(v.abs()));
    if peak <= 1e-4 {
        return Vec::new();
    }
    let floor = peak * 0.02;
    let first = samples.iter().position(|v| v.abs() > floor).unwrap_or(0);
    let last = samples.iter().rposition(|v| v.abs() > floor).unwrap_or(samples.len().saturating_sub(1));
    let pad = (rate / 10) as usize;
    samples[first.saturating_sub(pad)..(last + pad).min(samples.len())].to_vec()
}

fn wav16(samples: &[f32], rate: u32) -> Vec<u8> {
    let data: Vec<u8> = samples.iter().flat_map(|v| ((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out
}

// --------------------------------------------------------------------------------- the server

struct Server {
    engine: Engine,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static SERVER_HELD: Mutex<Option<Server>> = Mutex::new(None);

impl Server {
    /// Starts `voice_server.py` for `engine` and waits for its model to load (the first time, for
    /// its weights to download).
    fn start(engine: Engine, terms_accepted: bool) -> Result<Server, String> {
        let script = root().join("voice_server.py");
        std::fs::write(&script, SERVER).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(python(engine));
        cmd.arg("-I").arg(&script).arg(engine.as_str()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        environment(&mut cmd, engine, terms_accepted);
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
        Ok(Server { engine, child, stdin, stdout })
    }

    fn say(&mut self, text: &str, lang: &str, reference: &Path, out: &Path) -> Result<(), String> {
        let request = serde_json::json!({ "op": "say", "text": text, "lang": lang, "ref": reference, "out": out });
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

/// Ends the voice engine's process — on quit, and before its files are deleted.
pub fn stop_server() {
    if let Ok(mut held) = SERVER_HELD.lock() {
        *held = None;
    }
}

/// Splits a text where a sentence ends, so a cloned voice speaks a sentence at a time.
fn sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        current.push(c);
        if matches!(c, '.' | '!' | '?' | '…' | ';') && current.trim().chars().count() > 12 {
            out.push(current.trim().to_string());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// Says `text` with cloned voice `id`, a sentence at a time into `on_chunk`. Blocking: the first
/// sentence costs the model's load the first time (seconds), then a sentence each.
pub fn synthesize(id: &str, text: &str, lang: &str, terms_accepted: bool, on_chunk: &mut dyn FnMut(&[f32], u32) -> bool) -> Result<(), String> {
    let voice = voice(id).ok_or_else(|| format!("Unknown voice {id}"))?;
    if !installed(voice.engine) {
        return Err(format!("{} is not installed — Settings › Voice & sound › Models", voice.engine.as_str()));
    }
    let reference = reference(id);
    let mut held = SERVER_HELD.lock().map_err(|_| "The voice engine is busy".to_string())?;
    if held.as_ref().is_none_or(|server| server.engine != voice.engine) {
        *held = None;
        *held = Some(Server::start(voice.engine, terms_accepted)?);
    }
    let server = held.as_mut().expect("started above");
    let scratch = root().join(format!("out-{}.wav", std::process::id()));
    for sentence in sentences(text) {
        server.say(&sentence, lang, &reference, &scratch)?;
        let bytes = std::fs::read(&scratch).map_err(|e| e.to_string())?;
        let (samples, rate) = super::wav::parse(&bytes)?;
        if !on_chunk(&samples, rate) {
            break;
        }
    }
    let _ = std::fs::remove_file(&scratch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_is_trimmed_to_the_voice_and_too_little_is_refused() {
        let rate = 16_000;
        let mut samples = vec![0.0f32; rate as usize];
        samples.extend((0..rate as usize * 8).map(|i| ((i as f32) * 0.05).sin() * 0.4));
        samples.extend(vec![0.0f32; rate as usize]);
        let trimmed = trim(&samples, rate);
        let seconds = trimmed.len() as f32 / rate as f32;
        assert!((8.0..8.4).contains(&seconds), "{seconds}");
        assert!(trim(&vec![0.0; 1000], rate).is_empty());
    }

    #[test]
    fn a_long_text_is_said_a_sentence_at_a_time() {
        let parts = sentences("Terminé la revisión del pull request. Hay dos comentarios, nada bloqueante. ¿Lo apruebo?");
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert_eq!(sentences("Hola."), vec!["Hola.".to_string()], "a short one stays whole");
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(version_at_least("3.12", 3, 10));
        assert!(!version_at_least("3.9", 3, 10));
        assert!(version_at_least("3.10.4", 3, 10));
    }

    #[test]
    fn a_wav_written_here_reads_back() {
        let samples: Vec<f32> = (0..2400).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
        let (back, rate) = super::super::wav::parse(&wav16(&samples, 24_000)).unwrap();
        assert_eq!(rate, 24_000);
        assert_eq!(back.len(), samples.len());
        assert!((back[100] - samples[100]).abs() < 1e-3);
    }

    /// The real engine end to end: `CODEFLOW_TEST_CLONE=chatterbox|<a 10 s WAV of a voice>` with the
    /// engine installed (Settings, or `prepare`). Writes two sentences in that voice.
    #[test]
    #[ignore]
    fn a_cloned_voice_speaks() {
        let spec = std::env::var("CODEFLOW_TEST_CLONE").expect("CODEFLOW_TEST_CLONE=<engine>|<wav>");
        let (engine, wav) = spec.split_once('|').unwrap();
        let engine = Engine::parse(engine).unwrap();
        let (samples, rate) = super::super::wav::parse(&std::fs::read(wav).unwrap()).unwrap();
        let voice = create("test", engine, true, &samples, rate).unwrap();
        let mut chunks = 0;
        synthesize(&voice.id, "Hola, soy Codi. Esta es mi voz clonada.", "es", true, &mut |chunk, _| {
            chunks += 1;
            !chunk.is_empty()
        })
        .unwrap();
        delete(&voice.id);
        stop_server();
        assert_eq!(chunks, 2);
    }
}
