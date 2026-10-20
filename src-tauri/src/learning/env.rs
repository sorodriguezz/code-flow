//! The training environment: a Python venv the app owns (`state_dir()/training/venv`), made only
//! when the user asks. On Apple Silicon it holds `mlx-lm`; on an NVIDIA card, PEFT and TRL.
//!
//! The machine's own Python 3.9+ creates it. A machine with none gets a self-contained CPython
//! ([`STANDALONE`], the `python-build-standalone` builds `uv` installs) downloaded into the training
//! folder when the user clicks Prepare, pinned by release and SHA-256. Nothing is installed outside
//! that folder, and deleting it removes all of it.

use std::path::PathBuf;

use serde::Serialize;

use super::{root, LearningEvent, Worker};

pub fn venv_dir() -> PathBuf {
    root().join("venv")
}

/// The venv's interpreter.
pub fn python() -> PathBuf {
    if cfg!(windows) {
        venv_dir().join("Scripts").join("python.exe")
    } else {
        venv_dir().join("bin").join("python")
    }
}

/// Where Hugging Face weights land: inside the training folder, so deleting it removes them too.
pub fn hf_home() -> PathBuf {
    root().join("hf")
}

/// Whether `repo`'s weights are already on disk (a training run fetched them).
pub fn downloaded(repo: &str) -> bool {
    let dir = hf_home().join("hub").join(format!("models--{}", repo.replace('/', "--"))).join("snapshots");
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().any(|e| e.path().join("config.json").is_file()))
        .unwrap_or(false)
}

/// What every Python this module starts gets: the app's weight cache, no telemetry, unbuffered
/// output, no secrets from the app's environment, no console window.
pub fn prepare_command(cmd: &mut tokio::process::Command) {
    cmd.env("HF_HOME", hf_home())
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("TOKENIZERS_PARALLELISM", "false")
        .env("PYTHONUNBUFFERED", "1");
    crate::tool_gateway::scrub_env(cmd);
    crate::proc::hide_console(cmd);
}

/// What a worker needs installed.
pub fn packages(worker: Worker) -> &'static [&'static str] {
    match worker {
        Worker::Mlx => &["mlx-lm"],
        Worker::Cuda => &["torch", "transformers", "peft", "trl", "datasets", "accelerate", "bitsandbytes"],
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvStatus {
    pub worker: Option<Worker>,
    /// The Python that would create the venv, and its version.
    pub system_python: Option<String>,
    /// Bytes Prepare would download for a self-contained Python, when the machine has none.
    pub python_download: Option<u64>,
    pub venv: bool,
    /// The trainer library's version in the venv, when it imports.
    pub trainer_version: Option<String>,
    pub ready: bool,
}

async fn output(program: &std::path::Path, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(std::process::Stdio::null());
    crate::proc::hide_console(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await.ok()?.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A self-contained CPython for one platform.
#[derive(Debug)]
pub struct Standalone {
    pub target: &'static str,
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// The `astral-sh/python-build-standalone` release the builds below come from.
pub const STANDALONE_RELEASE: &str = "20261013";

/// CPython 3.12 for every platform that can train: Apple Silicon (MLX) and the NVIDIA hosts (PEFT).
/// `install_only_stripped`: the interpreter and the standard library, no debug symbols.
pub const STANDALONE: &[Standalone] = &[
    Standalone {
        target: "aarch64-apple-darwin",
        file: "cpython-3.12.15+20261013-aarch64-apple-darwin-install_only_stripped.tar.gz",
        size: 25_052_618,
        sha256: "9866e11cf2ae9caa1e671383786f248859a52dd8bfb702fb4c0dc2c65f1d36de",
    },
    Standalone {
        target: "x86_64-pc-windows-msvc",
        file: "cpython-3.12.15+20261013-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        size: 22_019_610,
        sha256: "7a2aef48e5ee569e310b29b32681debbc5d888e92790d85331a47736c6b06aad",
    },
    Standalone {
        target: "x86_64-unknown-linux-gnu",
        file: "cpython-3.12.15+20261013-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
        size: 34_340_172,
        sha256: "178d3d83b6e8e99285a65d3fce9c16b87952cc5efdb4d1a0e3ff3be18ff0fc9c",
    },
    Standalone {
        target: "aarch64-unknown-linux-gnu",
        file: "cpython-3.12.15+20261013-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
        size: 29_242_161,
        sha256: "9467a99bacc7d90b64b02de7fa9ecfc99b72905e64e74f7ff6b460ad95cfed5a",
    },
];

/// The build for this machine, if there is one.
pub fn standalone_here() -> Option<&'static Standalone> {
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => return None,
    };
    STANDALONE.iter().find(|s| s.target == target)
}

fn standalone_url(build: &Standalone) -> String {
    format!(
        "https://github.com/astral-sh/python-build-standalone/releases/download/{STANDALONE_RELEASE}/{}",
        build.file.replace('+', "%2B")
    )
}

/// Where the self-contained Python lives once downloaded.
pub fn standalone_dir(root: &std::path::Path) -> PathBuf {
    root.join("python")
}

/// Its interpreter (the archive's top folder is `python/`).
pub fn standalone_python(root: &std::path::Path) -> PathBuf {
    let dir = standalone_dir(root);
    if cfg!(windows) {
        dir.join("python.exe")
    } else {
        dir.join("bin").join("python3")
    }
}

/// Downloads `build` into `root`, checks its size and SHA-256, unpacks it, and returns its
/// interpreter once it runs. Progress goes to `say`.
pub async fn install_standalone(root: &std::path::Path, build: &Standalone, say: &impl Fn(&str)) -> Result<PathBuf, String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let python = standalone_python(root);
    if python.is_file() && output(&python, &["-c", "print(1)"]).await.is_some() {
        return Ok(python);
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let archive = root.join(build.file);
    let part = root.join(format!("{}.part", build.file));
    let mb = |bytes: u64| bytes as f64 / 1_048_576.0;
    say(&format!("Downloading Python 3.12 ({:.0} MB)…", mb(build.size)));
    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let response = client.get(standalone_url(build)).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("couldn't download Python: {e}"))?;
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut shown = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("the Python download broke off: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        let percent = done * 100 / build.size.max(1);
        if percent >= shown + 10 {
            shown = percent - percent % 10;
            say(&format!("Python 3.12: {:.0} of {:.0} MB", mb(done), mb(build.size)));
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    if done != build.size || digest != build.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err("the downloaded Python didn't match its checksum, so it was discarded — a proxy or captive portal may be rewriting downloads".into());
    }
    std::fs::rename(&part, &archive).map_err(|e| e.to_string())?;
    say("Unpacking Python…");
    let unpacking = root.join("python.unpacking");
    let (from, into) = (archive.clone(), unpacking.clone());
    tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(&into);
        std::fs::create_dir_all(&into).map_err(|e| e.to_string())?;
        crate::datasource::drivers::extract(&from, &into)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&archive);
    let target = standalone_dir(root);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(unpacking.join("python"), &target).map_err(|e| format!("the Python archive had an unexpected layout: {e}"))?;
    let _ = std::fs::remove_dir_all(&unpacking);
    match output(&python, &["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).await {
        Some(version) => {
            say(&format!("Python {version} ready."));
            Ok(python)
        }
        None => Err("the downloaded Python doesn't run on this machine".into()),
    }
}

/// The oldest Python `mlx-lm` and PEFT still install on.
const MIN_MINOR: u32 = 9;

/// A Python that only stands in for one: running it offers to install something instead. macOS's
/// `/usr/bin/python3` is an `xcrun` shim — on a Mac without the Command Line Tools it opens the
/// "install the developer tools" dialog, on every call — and Windows' `WindowsApps\python.exe` is
/// the Microsoft Store alias.
fn is_stub(path: &std::path::Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    lower == "/usr/bin/python3" || lower.contains("\\windowsapps\\")
}

/// Every real interpreter on this machine worth asking: `PATH` (the login shell's, see
/// `shell_env`), then the usual install places. Never a stub.
async fn candidates() -> Vec<PathBuf> {
    // The one this app downloaded, when it did.
    let mut found: Vec<PathBuf> = vec![standalone_python(&root())];
    let names: &[&str] = if cfg!(windows) { &["python.exe", "python3.exe"] } else { &["python3"] };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            found.extend(names.iter().map(|name| dir.join(name)));
        }
    }
    if cfg!(target_os = "macos") {
        found.extend(
            [
                "/opt/homebrew/bin/python3",
                "/usr/local/bin/python3",
                "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
                // The developer tools' own interpreter — the real binary the shim would run, present
                // only when they are installed.
                "/Library/Developer/CommandLineTools/usr/bin/python3",
                "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
            ]
            .map(PathBuf::from),
        );
    }
    if cfg!(windows) {
        // The python.org launcher knows the installs it made; asked for the interpreter's own path.
        if let Some(exe) = output(std::path::Path::new("py"), &["-3", "-c", "import sys; print(sys.executable)"]).await {
            found.push(PathBuf::from(exe));
        }
    }
    let mut seen = std::collections::HashSet::new();
    found
        .into_iter()
        .filter(|p| p.is_file() && !is_stub(p))
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

/// `"3.12"` → `(3, 12)`.
fn version_of(text: &str) -> Option<(u32, u32)> {
    let (major, minor) = text.trim().split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// The newest Python 3.9+ on this machine, which creates the venv — `None` when there is none.
pub async fn system_python() -> Option<(PathBuf, String)> {
    let mut best: Option<((u32, u32), PathBuf, String)> = None;
    for candidate in candidates().await {
        let Some(text) = output(&candidate, &["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).await else { continue };
        let Some(version) = version_of(&text) else { continue };
        if version.0 != 3 || version.1 < MIN_MINOR {
            continue;
        }
        if best.as_ref().is_none_or(|(have, _, _)| version > *have) {
            best = Some((version, candidate, text.trim().to_string()));
        }
    }
    best.map(|(_, path, text)| (path, text))
}

pub async fn status(machine: &crate::hybrid::hardware::Machine) -> EnvStatus {
    let worker = super::worker_here(machine);
    let system_python = system_python().await.map(|(_, version)| version);
    let python_download = if system_python.is_none() { standalone_here().map(|b| b.size) } else { None };
    let venv = python().is_file();
    let probe = match worker {
        Some(Worker::Mlx) => "import mlx_lm; print(mlx_lm.__version__)",
        Some(Worker::Cuda) => "import peft, torch; print(peft.__version__ + ' · torch ' + torch.__version__ + (' · cuda' if torch.cuda.is_available() else ' · no cuda'))",
        None => "",
    };
    let trainer_version = if venv && !probe.is_empty() { output(&python(), &["-c", probe]).await } else { None };
    let ready = trainer_version.as_deref().is_some_and(|v| worker != Some(Worker::Cuda) || v.contains("· cuda"));
    EnvStatus { worker, system_python, python_download, venv, trainer_version, ready }
}

/// Creates the venv (when missing) and installs `worker`'s packages, reporting each line on
/// `ai:learning`. Long: a CUDA install is gigabytes.
pub async fn prepare(app: &tauri::AppHandle, worker: Worker) -> Result<(), String> {
    std::fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    let log_path = root().join("env.log");
    let say = |line: &str| {
        super::emit(app, LearningEvent { kind: "env", id: "env".into(), state: "running", line: Some(line.to_string()), progress: None });
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{line}")
        });
    };
    let system = match system_python().await {
        Some((path, _)) => path,
        None => {
            let build = standalone_here().ok_or("this machine has no Python 3.9 or newer, and there's no self-contained build for it — install Python and try again")?;
            install_standalone(&root(), build, &say).await?
        }
    };
    if !python().is_file() {
        say("Creating the training environment…");
        let venv = venv_dir();
        let args: Vec<String> = vec!["-m".into(), "venv".into(), venv.to_string_lossy().to_string()];
        run_logged(&system, &args, &say).await?;
    }
    run_logged(&python(), &["-m".into(), "pip".into(), "install".into(), "--upgrade".into(), "pip".into()], &say).await?;
    let mut install: Vec<String> = vec!["-m".into(), "pip".into(), "install".into()];
    install.extend(packages(worker).iter().map(|p| p.to_string()));
    run_logged(&python(), &install, &say).await?;
    super::emit(app, LearningEvent { kind: "env", id: "env".into(), state: "done", line: None, progress: None });
    Ok(())
}

async fn run_logged(program: &std::path::Path, args: &[String], say: &impl Fn(&str)) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    crate::proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", program.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for pipe in [stdout.map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>), stderr.map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)].into_iter().flatten() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);
    while let Some(line) = rx.recv().await {
        say(&line);
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("{} failed ({status})", program.display())) }
}

/// The trainer library's version in the venv (`mlx-lm`, else `peft`), for the adapter's record.
pub async fn trainer_version() -> Option<String> {
    if !python().is_file() {
        return None;
    }
    for probe in ["import mlx_lm; print('mlx-lm ' + mlx_lm.__version__)", "import peft; print('peft ' + peft.__version__)"] {
        if let Some(version) = output(&python(), &["-c", probe]).await {
            return Some(version);
        }
    }
    None
}

/// The key that holds whether a base passed a validation run on this machine.
pub fn validated_key(base_id: &str) -> String {
    format!("learning_validated:{base_id}")
}

/// Whether `base_id` trained and served here in a validation run: `None` never tried.
pub fn validated(conn: &rusqlite::Connection, base_id: &str) -> Option<bool> {
    crate::db::queries::get_setting(conn, &validated_key(base_id)).ok().flatten().map(|v| v == "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stubs_are_never_run() {
        assert!(is_stub(std::path::Path::new("/usr/bin/python3")));
        assert!(is_stub(std::path::Path::new(r"C:\Users\a\AppData\Local\Microsoft\WindowsApps\python.exe")));
        assert!(!is_stub(std::path::Path::new("/opt/homebrew/bin/python3")));
        assert!(!is_stub(std::path::Path::new("/Library/Developer/CommandLineTools/usr/bin/python3")));
        assert_eq!(version_of("3.12\n"), Some((3, 12)));
        assert_eq!(version_of("garbage"), None);
    }

    #[tokio::test]
    async fn the_shim_is_not_among_the_candidates() {
        assert!(candidates().await.iter().all(|p| !is_stub(p)));
    }

    #[test]
    fn every_training_platform_has_a_pinned_python() {
        for build in STANDALONE {
            assert_eq!(build.sha256.len(), 64);
            assert!(build.file.contains(build.target) && build.file.contains(STANDALONE_RELEASE));
            assert!(standalone_url(build).contains("%2B") && !standalone_url(build).contains('+'));
        }
        if cfg!(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64"))) {
            assert!(standalone_here().is_some());
        }
        let root = std::path::Path::new("/r");
        assert!(standalone_python(root).starts_with(standalone_dir(root)));
    }

    /// The real download, into a scratch folder: fetched, verified, unpacked, run, and able to make
    /// a venv with pip — ignored by default (25 MB from GitHub).
    ///
    /// `CODEFLOW_LEARNING_LIVE=1 cargo test --lib learning::env::tests::standalone -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn standalone_python_installs_and_makes_a_venv() {
        if std::env::var("CODEFLOW_LEARNING_LIVE").is_err() {
            return;
        }
        let Some(build) = standalone_here() else { return };
        let root = std::env::temp_dir().join(format!("codeflow-standalone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let python = install_standalone(&root, build, &|line: &str| eprintln!("  {line}")).await.expect("installed");
        assert_eq!(output(&python, &["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).await.as_deref(), Some("3.12"));
        let venv = root.join("venv");
        let made = tokio::process::Command::new(&python).args(["-m", "venv"]).arg(&venv).status().await.unwrap();
        assert!(made.success());
        let venv_python = if cfg!(windows) { venv.join("Scripts").join("python.exe") } else { venv.join("bin").join("python") };
        let pip = output(&venv_python, &["-m", "pip", "--version"]).await;
        eprintln!("  {pip:?}");
        assert!(pip.is_some_and(|v| v.contains("python 3.12")));
        assert!(!root.join(build.file).exists() && !root.join("python.unpacking").exists(), "the archive and the scratch folder are cleaned up");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn every_worker_installs_something() {
        assert_eq!(packages(Worker::Mlx), ["mlx-lm"]);
        assert!(packages(Worker::Cuda).contains(&"peft"));
        assert!(python().starts_with(venv_dir()));
    }
}
