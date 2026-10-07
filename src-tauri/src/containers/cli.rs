//! Running the runtimes' own command-line tools: finding them, and reading what they print.
//!
//! **Found, not configured.** A GUI app inherits a `PATH` imported from the login shell
//! (`shell_env`), which covers Homebrew and most installers — but the container tools are the ones
//! that most often live somewhere no profile mentions: OrbStack's `~/.orbstack/bin`, Docker
//! Desktop's bundle, Rancher Desktop's `~/.rd/bin`, Podman's `/opt/podman/bin`. Those are added
//! behind `PATH`, never in front of it, so the user's own choice of `docker` still wins.
//!
//! **The engine the terminal talks to.** Which engine or cluster a tool reaches is chosen in a
//! profile too — `export DOCKER_HOST=…` for Colima, `KUBECONFIG=a:b` for a second cluster file — and
//! startup imports only `PATH`. So [`engine_env`] asks the login shell for those few variables, once,
//! the first time a runtime is reached, and every command here carries them: without it the panel
//! showed one engine and the terminal another. The clusters added in the panel ride on the same
//! variable: once CodeFlow has a kubeconfig of its own, it is appended to `KUBECONFIG` for every
//! command (see `kubeconfig`).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;

/// What a finished command printed.
#[derive(Debug, Clone)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// The tool's own complaint, cut to its first lines: stderr, or stdout when stderr is empty.
    pub fn complaint(&self) -> String {
        let text = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).take(6).collect();
        if lines.is_empty() {
            format!("exited with code {}", self.code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
        } else {
            lines.join("\n")
        }
    }
}

/// Where these tools install themselves without telling the shell.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for rel in [".orbstack/bin", ".docker/bin", ".rd/bin", ".local/bin", ".krew/bin", "bin"] {
            dirs.push(home.join(rel));
        }
        // The clouds' CLIs and the kubectl plugins they sign in with, where their own installers put
        // them: the Google Cloud SDK's archive (gke-gcloud-auth-plugin lives beside gcloud), and
        // `az aks install-cli`'s kubelogin and kubectl on Windows.
        for rel in ["google-cloud-sdk/bin", ".azure-kubelogin", ".azure-kubectl"] {
            dirs.push(home.join(rel));
        }
    }
    #[cfg(target_os = "macos")]
    {
        for dir in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Applications/Docker.app/Contents/Resources/bin",
            "/Applications/OrbStack.app/Contents/MacOS/xbin",
            "/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin",
            "/opt/podman/bin",
        ] {
            dirs.push(PathBuf::from(dir));
        }
    }
    #[cfg(target_os = "windows")]
    {
        for dir in [
            r"C:\Program Files\Docker\Docker\resources\bin",
            r"C:\Program Files\RedHat\Podman",
            r"C:\ProgramData\chocolatey\bin",
            r"C:\Program Files\Amazon\AWSCLIV2",
            r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin",
            r"C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin",
            r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin",
        ] {
            dirs.push(PathBuf::from(dir));
        }
        if let Some(local) = dirs::data_local_dir() {
            dirs.push(local.join(r"Programs\Rancher Desktop\resources\resources\win32\bin"));
            dirs.push(local.join(r"Microsoft\WinGet\Links"));
            dirs.push(local.join(r"Google\Cloud SDK\google-cloud-sdk\bin"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        for dir in ["/usr/local/bin", "/usr/bin", "/snap/bin", "/var/lib/rancher/rke2/bin", "/usr/local/sbin"] {
            dirs.push(PathBuf::from(dir));
        }
    }
    dirs
}

/// The search path: the process's own `PATH` first, then the install folders above.
pub fn search_path() -> String {
    let separator = if cfg!(windows) { ";" } else { ":" };
    let mut parts: Vec<String> = std::env::var("PATH").unwrap_or_default().split(separator).map(str::to_string).collect();
    for dir in extra_dirs() {
        let text = dir.to_string_lossy().into_owned();
        if !parts.contains(&text) {
            parts.push(text);
        }
    }
    parts.retain(|part| !part.trim().is_empty());
    parts.join(separator)
}

/// `name` as an executable path, or `None` when it is not installed anywhere we look.
pub fn find(name: &str) -> Option<PathBuf> {
    crate::scaffold::tools::which_in(&search_path(), name)
}

/// The variables that pick an engine or a cluster — and, for a cluster in a cloud, the identity its
/// auth plugin signs in as (`aws eks get-token` reads `AWS_PROFILE`, kubelogin reads az's
/// `AZURE_CONFIG_DIR`, gke-gcloud-auth-plugin reads `CLOUDSDK_CONFIG`): without those, a context the
/// terminal reaches would be refused here. One this process already has is left alone: whoever
/// launched it set it on purpose.
const ENGINE_VARS: &[&str] = &[
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "CONTAINER_HOST",
    "CONTAINER_CONNECTION",
    "CONTAINERD_ADDRESS",
    "CONTAINERD_NAMESPACE",
    "KUBECONFIG",
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AZURE_CONFIG_DIR",
    "CLOUDSDK_CONFIG",
    "CLOUDSDK_ACTIVE_CONFIG_NAME",
];

/// Markers around the shell's answer, so a profile's banner never reads as a variable.
const OPEN: &str = "__CF_ENGINE_ENV_OPEN__";
const CLOSE: &str = "__CF_ENGINE_ENV_CLOSE__";

static ENGINE_ENV: tokio::sync::OnceCell<Vec<(String, String)>> = tokio::sync::OnceCell::const_new();

/// [`ENGINE_VARS`] as the user's login shell sets them, for the ones this process lacks — asked once
/// (a login shell takes up to a second or two to source itself), then reused by every command.
async fn login_env() -> &'static [(String, String)] {
    ENGINE_ENV.get_or_init(|| async { tokio::task::spawn_blocking(login_engine_env).await.unwrap_or_default() }).await
}

/// What every command here runs with: [`login_env`], with CodeFlow's own kubeconfig in `KUBECONFIG`.
pub async fn engine_env() -> Vec<(String, String)> {
    with_app_kubeconfig(login_env().await.to_vec())
}

/// The same for a caller that cannot wait — a terminal session is opened synchronously: what the
/// first command learnt (the panel's detection always runs before one can be opened), or nothing.
pub fn engine_env_now() -> Vec<(String, String)> {
    with_app_kubeconfig(ENGINE_ENV.get().cloned().unwrap_or_default())
}

/// One of [`ENGINE_VARS`] as the user's terminal has it: this process's own value, else the login
/// shell's.
pub async fn login_var(name: &str) -> Option<String> {
    if let Some(own) = std::env::var(name).ok().filter(|v| !v.trim().is_empty()) {
        return Some(own);
    }
    login_env().await.iter().find(|(var, _)| var == name).map(|(_, value)| value.clone())
}

/// `KUBECONFIG` with CodeFlow's kubeconfig after the user's files — once it exists: until a cluster
/// is added in the panel, every command runs with exactly the environment it always had.
fn with_app_kubeconfig(mut env: Vec<(String, String)>) -> Vec<(String, String)> {
    let app = super::kubeconfig::app_path();
    if !app.is_file() {
        return env;
    }
    let user = std::env::var("KUBECONFIG")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| env.iter().find(|(name, _)| name == "KUBECONFIG").map(|(_, value)| value.clone()));
    let value = super::kubeconfig::compose(user.as_deref(), dirs::home_dir().as_deref(), &app);
    env.retain(|(name, _)| name != "KUBECONFIG");
    env.push(("KUBECONFIG".to_string(), value));
    env
}

fn login_engine_env() -> Vec<(String, String)> {
    // Windows keeps these in the registry with `PATH`, which a GUI process already reads. And never
    // the developer's own shell under `cargo test`.
    if cfg!(windows) || cfg!(test) {
        return vec![];
    }
    let missing: Vec<&str> = ENGINE_VARS.iter().copied().filter(|name| std::env::var_os(name).is_none_or(|v| v.is_empty())).collect();
    let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from) else { return vec![] };
    let name = shell.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // Login *and* interactive, as `shell_env` asks: `~/.zprofile` and `~/.zshrc` each hold half a
    // profile. An unknown shell is not handed flags it may read as something else.
    if missing.is_empty() || !matches!(name.as_str(), "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh") {
        return vec![];
    }
    // `NAME=value`, a line each — `printf` and `"$NAME"` read the same in sh, zsh and fish.
    let lines: String = missing.iter().map(|var| format!("printf '{var}=%s\\n' \"${var}\"; ")).collect();
    let script = format!("printf '{OPEN}\\n'; {lines}printf '{CLOSE}\\n'");
    let mut command = crate::proc::std_command(&shell);
    command.args(["-l", "-i", "-c", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // A profile that hangs (a prompt, a `read`) is left behind at the deadline instead of waited on:
    // the commands then run with this process's own environment, as they always had.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(command.output().ok());
    });
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(output)) => parse_engine_env(&String::from_utf8_lossy(&output.stdout), &missing),
        _ => vec![],
    }
}

/// The `NAME=value` lines between the markers, for the variables asked about that have a value.
pub fn parse_engine_env(output: &str, wanted: &[&str]) -> Vec<(String, String)> {
    let Some(start) = output.find(OPEN).map(|at| at + OPEN.len()) else { return vec![] };
    let Some(end) = output[start..].find(CLOSE).map(|at| at + start) else { return vec![] };
    output[start..end]
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter_map(|line| line.split_once('='))
        .filter(|(name, value)| wanted.contains(name) && !value.trim().is_empty() && !value.contains('\0'))
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

/// Runs `program` with `args`, feeding `stdin` when given, and collects what it prints. A command
/// still running at `timeout` is killed and reported as such.
pub async fn run(program: &str, args: &[String], stdin: Option<&str>, timeout: Duration) -> Result<Output, String> {
    run_with(program, args, stdin, timeout, &[]).await
}

/// [`run`] with `env` on top of the panel's own — a cloud CLI pointed at a kubeconfig of its own.
pub async fn run_with(program: &str, args: &[String], stdin: Option<&str>, timeout: Duration, env: &[(String, String)]) -> Result<Output, String> {
    let mut cmd = crate::proc::command(program);
    cmd.args(args)
        .env("PATH", search_path())
        .envs(engine_env().await)
        .envs(env.iter().cloned())
        // Plain text: these outputs are parsed, and a tool that thinks it talks to a terminal colours them.
        .env("NO_COLOR", "1")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("could not start {program}: {e}"))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let body = text.as_bytes().to_vec();
        tokio::spawn(async move {
            let _ = pipe.write_all(&body).await;
            let _ = pipe.shutdown().await;
        });
    }
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(Output {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }),
        Ok(Err(error)) => Err(format!("{program}: {error}")),
        Err(_) => Err(format!("{program} did not answer within {} s", timeout.as_secs())),
    }
}

/// Runs and insists on success: the tool's complaint otherwise.
pub async fn run_ok(program: &str, args: &[String], stdin: Option<&str>, timeout: Duration) -> Result<String, String> {
    let output = run(program, args, stdin, timeout).await?;
    if output.ok() {
        Ok(output.stdout)
    } else {
        Err(output.complaint())
    }
}

/// The JSON a tool printed: one document, or one per line (`--format '{{json .}}'`), as a list.
pub fn json_values(text: &str) -> Vec<serde_json::Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return match value {
            serde_json::Value::Array(list) => list,
            serde_json::Value::Null => vec![],
            other => vec![other],
        };
    }
    trimmed.lines().filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_lines_and_arrays_read_the_same() {
        assert_eq!(json_values("{\"a\":1}\n{\"a\":2}\n").len(), 2);
        assert_eq!(json_values("[{\"a\":1},{\"a\":2}]").len(), 2);
        assert_eq!(json_values("null").len(), 0);
        assert_eq!(json_values("  ").len(), 0);
        assert_eq!(json_values("{\"a\":1}")[0]["a"], 1);
    }

    #[test]
    fn engine_variables_are_read_between_the_markers() {
        let noisy = format!("Welcome to zsh!\nDOCKER_HOST=unix:///banner.sock\n{OPEN}\nDOCKER_HOST=unix:///Users/me/.colima/default/docker.sock\nKUBECONFIG=/Users/me/.kube/config:/Users/me/.kube/prod.yaml\nDOCKER_CONTEXT=\nPATH=/evil\n{CLOSE}\nbye\n");
        let found = parse_engine_env(&noisy, &["DOCKER_HOST", "DOCKER_CONTEXT", "KUBECONFIG"]);
        assert_eq!(
            found,
            vec![
                ("DOCKER_HOST".to_string(), "unix:///Users/me/.colima/default/docker.sock".to_string()),
                ("KUBECONFIG".to_string(), "/Users/me/.kube/config:/Users/me/.kube/prod.yaml".to_string()),
            ],
            "an empty value is unset, and a variable not asked about is never taken"
        );
        assert!(parse_engine_env("DOCKER_HOST=x", &["DOCKER_HOST"]).is_empty(), "no markers, no answer");
    }

    #[test]
    fn a_complaint_names_the_exit_code_when_nothing_was_said() {
        let quiet = Output { code: Some(3), stdout: String::new(), stderr: "  \n".into() };
        assert_eq!(quiet.complaint(), "exited with code 3");
        let loud = Output { code: Some(1), stdout: "x".into(), stderr: "Error: no such container\n".into() };
        assert_eq!(loud.complaint(), "Error: no such container");
    }
}
