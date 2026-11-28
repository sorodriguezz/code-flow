//! Detects and installs the external tools used by CodeFlow.
//!
//! Settings lists the tools, their detected locations, and the platform's install route.
//! The first-launch check uses the same inventory for Git and the AI CLIs.
//!
//! # Where the commands come from
//!
//! The CLIs' lines are [`provider_caps::SETUPS`]: each vendor's own documented installer. `git` is
//! here because it is not a provider: Homebrew when the Mac has it, otherwise Apple's command line
//! tools (`xcode-select --install`, which hands off to a system dialog and returns at once — reported
//! as [`Outcome::HandedOff`], not as done), and winget on Windows.
//!
//! # What this never does
//!
//! - Run anything but a line from those tables. The frontend names a tool id; the command is ours.
//! - Install while an AI process is alive, or two things at once — the same rule as
//!   [`crate::cli_updates::update`], and for the same reason: an npm global install can replace a
//!   shim a running turn is about to spawn.
//! - Touch the process `PATH`. The fresh one is read from a login shell and handed to the child and to
//!   the check afterwards ([`crate::shell_env::fresh_path`]), never adopted — see that module.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::provider_caps::{self, ProviderCaps};

/// How long one install may run before it is stopped. Generous: winget downloading Git for Windows on
/// a slow line takes minutes.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long the output is still read once the process is gone or stopped.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Lines of output kept for "Show details".
const KEEP_LINES: usize = 80;
/// The page for installing git by hand.
const GIT_URL: &str = "https://git-scm.com/downloads";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolGroup {
    System,
    Agent,
    Model,
    Cloud,
    Container,
}

/// One tool the setup can offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub label: String,
    pub group: ToolGroup,
    pub installed: bool,
    /// The version line when installed, the resolved path when only that is known, else empty.
    pub detail: String,
    /// The command «Instalar» runs on this machine. `None` when there is none for this platform.
    pub command: Option<String>,
    /// A program the command needs that is not here (`npm`, `winget`) — the button is disabled and
    /// says so rather than failing with "command not found".
    pub missing_prerequisite: Option<String>,
    pub url: String,
}

/// How an install ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The command succeeded and the tool now answers.
    Done,
    /// An AI process is running, or another install is. Nothing was started.
    Busy,
    /// The command failed.
    Failed,
    /// The command succeeded but the tool is still not found — usually a `PATH` only a restart picks up.
    NotDetected,
    /// The work continues in a window of the system's own (`xcode-select --install`).
    HandedOff,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub id: String,
    pub outcome: Outcome,
    pub detail: String,
    pub error_kind: Option<crate::user_errors::ErrorKind>,
    pub reference: Option<String>,
    /// The tail of the output, scrubbed.
    pub details: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    line: String,
}

// ------------------------------------------------------------------------------------ the table

/// The providers that are CLIs to install — everything but the in-process engine and the user's
/// own command — in settings order.
fn cli_providers() -> Vec<ProviderCaps> {
    provider_caps::all().into_iter().filter(|caps| !caps.in_process && caps.id != crate::custom::PROVIDER_ID).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    MacAppleSilicon,
    MacIntel,
    WindowsX64,
    Linux,
    Other,
}

impl Platform {
    fn current() -> Self {
        Self::for_target(std::env::consts::OS, std::env::consts::ARCH)
    }

    fn for_target(os: &str, arch: &str) -> Self {
        match (os, arch) {
            ("macos", "aarch64") => Self::MacAppleSilicon,
            ("macos", "x86_64") => Self::MacIntel,
            ("windows", "x86_64") => Self::WindowsX64,
            ("linux", _) => Self::Linux,
            _ => Self::Other,
        }
    }

    fn mac_brew_paths(self) -> Option<(&'static str, &'static str)> {
        const APPLE_SILICON: &str = "/opt/homebrew/bin/brew";
        const INTEL: &str = "/usr/local/bin/brew";
        match self {
            Self::MacAppleSilicon => Some((APPLE_SILICON, INTEL)),
            Self::MacIntel => Some((INTEL, APPLE_SILICON)),
            _ => None,
        }
    }
}

struct ExternalTool {
    id: &'static str,
    label: &'static str,
    binary: &'static str,
    group: ToolGroup,
    url: &'static str,
    mac: Option<&'static str>,
    winget: Option<&'static str>,
}

use ToolGroup::{Agent, Cloud, Container, Model, System};

const EXTERNAL_TOOLS: &[ExternalTool] = &[
    ExternalTool {
        id: "node", label: "Node.js + npm", binary: "node", group: System,
        url: "https://nodejs.org/download",
        mac: Some("brew install node"), winget: Some("OpenJS.NodeJS.LTS"),
    },
    ExternalTool {
        id: "python", label: "Python", binary: "python3", group: System,
        url: "https://www.python.org/downloads/",
        mac: Some("brew install python"), winget: Some("Python.Python.3.14"),
    },
    ExternalTool {
        id: "ollama", label: "Ollama", binary: "ollama", group: Model,
        url: "https://ollama.com/download",
        mac: Some("brew install --cask ollama-app"), winget: Some("Ollama.Ollama"),
    },
    ExternalTool {
        id: "az", label: "Azure CLI", binary: "az", group: Cloud,
        url: "https://learn.microsoft.com/cli/azure/install-azure-cli",
        mac: Some("brew install azure-cli"), winget: Some("Microsoft.AzureCLI"),
    },
    ExternalTool {
        id: "aws", label: "AWS CLI", binary: "aws", group: Cloud,
        url: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
        mac: Some("brew install awscli"), winget: Some("Amazon.AWSCLI"),
    },
    ExternalTool {
        id: "gcloud", label: "Google Cloud CLI", binary: "gcloud", group: Cloud,
        url: "https://docs.cloud.google.com/sdk/docs/install",
        mac: Some("brew install --cask gcloud-cli"), winget: Some("Google.CloudSDK"),
    },
    ExternalTool {
        id: "kubelogin", label: "Azure Kubelogin", binary: "kubelogin", group: Cloud,
        url: "https://azure.github.io/kubelogin/install.html",
        mac: Some("brew install Azure/kubelogin/kubelogin"), winget: Some("Microsoft.Azure.Kubelogin"),
    },
    ExternalTool {
        id: "gke-auth-plugin", label: "GKE Authentication Plugin", binary: "gke-gcloud-auth-plugin", group: Cloud,
        url: "https://docs.cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin",
        mac: None, winget: None,
    },
    ExternalTool {
        id: "docker", label: "Docker", binary: "docker", group: Container,
        url: "https://docs.docker.com/get-started/get-docker/",
        mac: Some("brew install --cask docker-desktop"), winget: Some("Docker.DockerDesktop"),
    },
    ExternalTool {
        id: "hadolint", label: "Hadolint", binary: "hadolint", group: Container,
        url: "https://github.com/hadolint/hadolint#install",
        mac: Some("brew install hadolint"), winget: None,
    },
    ExternalTool {
        id: "kubectl", label: "kubectl", binary: "kubectl", group: Container,
        url: "https://kubernetes.io/docs/tasks/tools/",
        mac: Some("brew install kubectl"), winget: Some("Kubernetes.kubectl"),
    },
    ExternalTool {
        id: "helm", label: "Helm", binary: "helm", group: Container,
        url: "https://helm.sh/docs/intro/install/",
        mac: Some("brew install helm"), winget: Some("Helm.Helm"),
    },
    ExternalTool {
        id: "kind", label: "kind", binary: "kind", group: Container,
        url: "https://kind.sigs.k8s.io/docs/user/quick-start/#installation",
        mac: Some("brew install kind"), winget: Some("Kubernetes.kind"),
    },
    ExternalTool {
        id: "k3d", label: "k3d", binary: "k3d", group: Container,
        url: "https://k3d.io/stable/#installation",
        mac: Some("brew install k3d"), winget: None,
    },
    ExternalTool {
        id: "minikube", label: "minikube", binary: "minikube", group: Container,
        url: "https://minikube.sigs.k8s.io/docs/start/",
        mac: Some("brew install minikube"), winget: Some("Kubernetes.minikube"),
    },
];

fn winget(package: &str) -> String {
    format!("winget install -e --id {package} --accept-package-agreements --accept-source-agreements")
}

/// Only preselected installers are executable. Use the official guide for platform-specific manual routes.
fn command_for(id: &str, platform: Platform, has: &dyn Fn(&str) -> bool) -> Option<String> {
    if id == "git" {
        return match platform {
            Platform::WindowsX64 => Some(winget("Git.Git")),
            Platform::MacAppleSilicon | Platform::MacIntel if !has("brew") => Some("xcode-select --install".into()),
            Platform::MacAppleSilicon | Platform::MacIntel | Platform::Linux if has("brew") => Some("brew install git".into()),
            _ => None,
        };
    }
    if let Some(tool) = EXTERNAL_TOOLS.iter().find(|tool| tool.id == id) {
        return match platform {
            Platform::Other => None,
            _ if id == "gke-auth-plugin" => Some("gcloud components install gke-gcloud-auth-plugin --quiet".into()),
            Platform::MacAppleSilicon | Platform::MacIntel => tool.mac.map(str::to_string),
            Platform::WindowsX64 => tool.winget.map(winget).or_else(|| (id == "k3d").then(|| "choco install k3d -y".into())),
            Platform::Linux => None,
        };
    }

    let row = provider_caps::setup_of(id)?;
    match platform {
        Platform::WindowsX64 => row.windows,
        Platform::MacAppleSilicon | Platform::MacIntel | Platform::Linux => row.unix,
        Platform::Other => None,
    }.map(str::to_string)
}

fn prerequisite(command: &str) -> Option<&str> {
    let first = command.split_whitespace().next()?;
    match first {
        "npm" | "winget" | "brew" | "choco" | "curl" | "gcloud" => Some(first),
        _ => None,
    }
}

fn binary_of(caps: &ProviderCaps) -> String {
    crate::ai_usage::setting(&format!("{}_binary_path", caps.id))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| caps.default_binary.clone())
}

/// `binary` looked up the way a run would, then — for a tool installed a minute ago that this
/// process's `PATH` predates — across the fresh `PATH` too.
fn locate(binary: &str, fresh: Option<&str>) -> Option<std::path::PathBuf> {
    if let Some(found) = crate::ai::find_on_path(binary) {
        return Some(found);
    }
    let extensions: &[&str] = if cfg!(target_os = "windows") { &["exe", "cmd", "bat", ""] } else { &[""] };
    std::env::split_paths(fresh?).find_map(|dir| {
        extensions.iter().find_map(|ext| {
            let candidate = if ext.is_empty() { dir.join(binary) } else { dir.join(format!("{binary}.{ext}")) };
            candidate.is_file().then_some(candidate)
        })
    })
}

fn resolve_program(binary: &str, fresh: Option<&str>, platform: Platform) -> Option<std::path::PathBuf> {
    if binary == "brew" {
        if let Some((native, alternate)) = platform.mac_brew_paths() {
            if let Some(found) = locate(native, None) {
                return Some(found);
            }
            // A second Homebrew installation may be on PATH for Rosetta. Keep its recipes out
            // of the native installer while still allowing a custom Homebrew prefix.
            let alternate = std::path::Path::new(alternate);
            let resolved_alternate = alternate.canonicalize().ok();
            return locate(binary, fresh).filter(|path| {
                path != alternate && !resolved_alternate.as_ref().is_some_and(|other| path.canonicalize().ok().as_ref() == Some(other))
            });
        }
    }
    locate(binary, fresh)
}

/// `git --version` with the given `PATH` — running it, for the reason `requirements::git` gives.
fn git_version(path: Option<&str>) -> Option<String> {
    let git = locate("git", path).unwrap_or_else(|| "git".into());
    let mut command = crate::proc::std_command(git);
    command.arg("--version").stdin(std::process::Stdio::null());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Every tool and whether it is here. `fresh` is a login shell's `PATH` when the caller has one.
fn status_with(fresh: Option<&str>) -> Vec<ToolStatus> {
    let platform = Platform::current();
    let find = |program: &str| resolve_program(program, fresh, platform);
    let has = |program: &str| find(program).is_some() || (program == "gcloud" && crate::containers::cli::find(program).is_some());
    let entry = |id: &str, label: &str, group, installed, detail, url: &str| {
        let command = command_for(id, platform, &has);
        let missing_prerequisite = command
            .as_deref()
            .and_then(prerequisite)
            .filter(|program| !has(program))
            .map(str::to_string);
        ToolStatus { id: id.to_string(), label: label.to_string(), group, installed, detail, command, missing_prerequisite, url: url.to_string() }
    };
    let from_path = |id: &str, label: &str, group, found: Option<std::path::PathBuf>, url: &str| {
        entry(id, label, group, found.is_some(), found.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default(), url)
    };

    let git = git_version(fresh).or_else(|| git_version(None));
    let mut tools = vec![entry("git", "Git", System, git.is_some(), git.unwrap_or_default(), GIT_URL)];
    for caps in cli_providers() {
        let url = provider_caps::setup_of(&caps.id).map(|row| row.url).unwrap_or_default();
        let label = if caps.id == "gemini" {
            "Antigravity CLI (agy)".to_string()
        } else {
            format!("{} CLI", caps.label)
        };
        tools.push(from_path(&caps.id, &label, Agent, find(&binary_of(&caps)), url));
    }
    for tool in EXTERNAL_TOOLS {
        let found = match tool.id {
            "node" if !has("npm") => None,
            "ollama" if platform.mac_brew_paths().is_some() => find(tool.binary).or_else(|| {
                let app_binary = "Ollama.app/Contents/Resources/ollama";
                let system = std::path::Path::new("/Applications").join(app_binary);
                if system.is_file() {
                    return Some(system);
                }
                let user = dirs::home_dir()?.join("Applications").join(app_binary);
                user.is_file().then_some(user)
            }),
            "python" if platform == Platform::WindowsX64 => find("python").or_else(|| find("py")),
            "gke-auth-plugin" => find(tool.binary).or_else(|| {
                crate::containers::kubeconfig::gke_plugin(find("gcloud").or_else(|| crate::containers::cli::find("gcloud")).as_deref())
            }),
            "az" | "aws" | "gcloud" | "docker" | "hadolint" | "kubectl" | "kubelogin" | "helm" | "kind" | "k3d" | "minikube" => {
                find(tool.binary).or_else(|| crate::containers::cli::find(tool.binary))
            }
            _ => find(tool.binary),
        };
        tools.push(from_path(tool.id, tool.label, tool.group, found, tool.url));
    }
    match platform {
        Platform::MacAppleSilicon | Platform::MacIntel => tools.push(from_path("brew", "Homebrew", System, find("brew"), "https://brew.sh/")),
        Platform::WindowsX64 => {
            tools.push(from_path("winget", "WinGet", System, find("winget"), "https://learn.microsoft.com/windows/package-manager/winget/"));
            tools.push(from_path("choco", "Chocolatey", System, find("choco"), "https://chocolatey.org/install"));
        }
        _ => {}
    }
    tools
}

/// Every tool the setup offers and whether it is installed. Blocking (it may run a login shell):
/// call it off the UI thread.
pub fn status() -> Vec<ToolStatus> {
    let fresh = crate::shell_env::fresh_path();
    status_with(fresh.as_deref())
}

// ---------------------------------------------------------------------------------- the install

fn result(id: &str, outcome: Outcome, detail: String, tail: &[String], failure: bool) -> InstallResult {
    let details = crate::applog::scrub(&tail.join("\n"));
    let classified = failure.then(|| crate::user_errors::classify(&details));
    InstallResult {
        id: id.to_string(),
        outcome,
        detail,
        error_kind: classified.as_ref().map(|c| c.kind),
        reference: classified.and_then(|c| c.reference),
        details,
    }
}

/// The shell that runs a line from the table.
fn shell(line: &str, path: Option<&str>) -> tokio::process::Command {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = crate::proc::command("powershell.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", line]);
        command
    } else {
        let mut command = crate::proc::command("/bin/bash");
        command.args(["-o", "pipefail", "-c", line]);
        command
    };
    let mut dirs = crate::ai::search_dirs();
    if let Some(path) = path {
        dirs.extend(std::env::split_paths(path));
    }
    if let Some(program) = prerequisite(line) {
        let prerequisite = if program == "gcloud" {
            locate(program, path).or_else(|| crate::containers::cli::find(program))
        } else {
            resolve_program(program, path, Platform::current())
        };
        if let Some(dir) = prerequisite.as_deref().and_then(std::path::Path::parent) {
            dirs.insert(0, dir.to_path_buf());
        }
    }
    if let Ok(path) = std::env::join_paths(dirs) {
        command.env("PATH", path);
    }
    // Package managers that would otherwise stop to ask.
    command.env("CI", "1").env("HOMEBREW_NO_AUTO_UPDATE", "1").env("NONINTERACTIVE", "1");
    command
}

/// Installs `id` with its command from the table, streaming its output as `tool-setup:progress`.
pub async fn install(app: &AppHandle, id: &str) -> Result<InstallResult, String> {
    if crate::ai_runs::live_processes() > 0 {
        return Ok(result(id, Outcome::Busy, String::new(), &[], false));
    }
    // The update's lock, not one of our own: see `cli_updates::single_flight`.
    let Ok(_turn) = crate::cli_updates::single_flight().try_lock() else {
        return Ok(result(id, Outcome::Busy, String::new(), &[], false));
    };

    let (fresh, tools) = tokio::task::spawn_blocking(|| {
        let fresh = crate::shell_env::fresh_path();
        let tools = status_with(fresh.as_deref());
        (fresh, tools)
    }).await.map_err(|error| error.to_string())?;
    let tool = tools.into_iter().find(|tool| tool.id == id).ok_or_else(|| format!("{id} is not something the setup installs"))?;
    if tool.installed {
        return Ok(result(id, Outcome::Done, tool.detail, &[], false));
    }
    let line = tool.command.ok_or_else(|| format!("{id} has no install command on this platform"))?;
    if let Some(missing) = &tool.missing_prerequisite {
        let tail = vec![format!("{missing} is not installed; it is needed to run: {line}")];
        return Ok(result(id, Outcome::Failed, String::new(), &tail, true));
    }

    if crate::ai_runs::live_processes() > 0 {
        return Ok(result(id, Outcome::Busy, String::new(), &[], false));
    }
    let mut lines = vec![format!("$ {line}")];
    let _ = app.emit("tool-setup:progress", Progress { id, line: lines[0].clone() });
    let mut command = shell(&line, fresh.as_deref());
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);
    // Its own group, so the timeout can stop everything it started: see `ai_runs::kill_tree`.
    crate::proc::own_process_group(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            lines.push(format!("could not start the installer: {error}"));
            return Ok(result(id, Outcome::Failed, String::new(), &lines, true));
        }
    };
    let (mut out, mut err) = (
        BufReader::new(child.stdout.take().expect("piped")).lines(),
        BufReader::new(child.stderr.take().expect("piped")).lines(),
    );
    let deadline = tokio::time::sleep(INSTALL_TIMEOUT);
    tokio::pin!(deadline);
    // A stream that has ended is not polled again: `next_line` answers `None` at once from then on,
    // and a branch that is always ready turned the wait for the process into a busy loop.
    let (mut out_open, mut err_open) = (true, true);
    let exit_status = loop {
        tokio::select! {
            line = out.next_line(), if out_open => match line {
                Ok(Some(line)) => keep(app, id, &mut lines, line),
                _ => out_open = false,
            },
            line = err.next_line(), if err_open => match line {
                Ok(Some(line)) => keep(app, id, &mut lines, line),
                _ => err_open = false,
            },
            status = child.wait() => break status.ok(),
            _ = &mut deadline => {
                // The whole tree: an installer is a shell running a package manager running more,
                // and killing only the shell left them going — and holding the pipes read below.
                crate::ai_runs::kill_tree(&mut child).await;
                lines.push("the install did not finish in 15 minutes and was stopped (timed out)".to_string());
                break None;
            }
        }
    };
    // Bounded: a descendant that outlived the process (a daemon it started) can keep the pipes
    // open forever, and the result must not wait on it.
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
        while out_open {
            match out.next_line().await {
                Ok(Some(line)) => keep(app, id, &mut lines, line),
                _ => out_open = false,
            }
        }
        while err_open {
            match err.next_line().await {
                Ok(Some(line)) => keep(app, id, &mut lines, line),
                _ => err_open = false,
            }
        }
    })
    .await;
    if !exit_status.is_some_and(|status| status.success()) {
        return Ok(result(id, Outcome::Failed, String::new(), &lines, true));
    }
    if line.starts_with("xcode-select") {
        return Ok(result(id, Outcome::HandedOff, String::new(), &lines, false));
    }

    // Asked again with a `PATH` read after the install: an installer that edited a profile is only
    // visible to a shell started now.
    let after = tokio::task::spawn_blocking(status).await.map_err(|error| error.to_string())?;
    let now = after.into_iter().find(|tool| tool.id == id);
    if let Some(caps) = provider_caps::caps_of(id) {
        crate::ai::forget_engine_version(&binary_of(&caps));
    }
    match now {
        Some(tool) if tool.installed => Ok(result(id, Outcome::Done, tool.detail, &lines, false)),
        _ => Ok(result(id, Outcome::NotDetected, String::new(), &lines, false)),
    }
}

fn keep(app: &AppHandle, id: &str, lines: &mut Vec<String>, line: String) {
    let line = line.trim_end().to_string();
    if line.is_empty() {
        return;
    }
    let _ = app.emit("tool-setup:progress", Progress { id, line: crate::applog::scrub(&line) });
    lines.push(line);
    if lines.len() > KEEP_LINES {
        lines.remove(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_takes_homebrew_when_there_is_one_and_apples_tools_when_not() {
        for mac in [Platform::MacAppleSilicon, Platform::MacIntel] {
            assert_eq!(command_for("git", mac, &|p| p == "brew").as_deref(), Some("brew install git"));
            assert_eq!(command_for("git", mac, &|_| false).as_deref(), Some("xcode-select --install"));
        }
        let windows = command_for("git", Platform::WindowsX64, &|_| false).unwrap();
        assert!(windows.starts_with("winget install -e --id Git.Git"), "{windows}");
    }

    #[test]
    fn every_cli_provider_is_offered_with_its_own_command() {
        for caps in cli_providers() {
            let row = provider_caps::setup_of(&caps.id).unwrap();
            assert_eq!(command_for(&caps.id, Platform::WindowsX64, &|_| true).as_deref(), row.windows, "{}", caps.id);
            assert_eq!(command_for(&caps.id, Platform::Linux, &|_| true).as_deref(), row.unix, "{}", caps.id);
        }
        assert!(command_for("codeflow", Platform::Linux, &|_| true).is_none());
        assert!(command_for("not-a-tool", Platform::Linux, &|_| true).is_none());
    }

    #[test]
    fn release_targets_use_native_install_routes() {
        let silicon = Platform::for_target("macos", "aarch64");
        let intel = Platform::for_target("macos", "x86_64");
        let windows = Platform::for_target("windows", "x86_64");
        assert_eq!(silicon.mac_brew_paths().map(|paths| paths.0), Some("/opt/homebrew/bin/brew"));
        assert_eq!(intel.mac_brew_paths().map(|paths| paths.0), Some("/usr/local/bin/brew"));
        let available = |_: &str| true;
        for mac in [silicon, intel] {
            assert_eq!(command_for("ollama", mac, &available).as_deref(), Some("brew install --cask ollama-app"));
            assert_eq!(command_for("az", mac, &available).as_deref(), Some("brew install azure-cli"));
            assert!(command_for("gemini", mac, &available).unwrap().contains("install.sh"));
        }
        let azure = command_for("az", windows, &available).unwrap();
        assert!(azure.contains("Microsoft.AzureCLI"));
        assert_eq!(prerequisite(&azure), Some("winget"));
        assert!(command_for("gemini", windows, &available).unwrap().contains("install.ps1"));
        assert!(command_for("grok", windows, &available).unwrap().contains("install.ps1"));
        let plugin = command_for("gke-auth-plugin", Platform::Linux, &available).unwrap();
        assert_eq!(prerequisite(&plugin), Some("gcloud"));
    }

    #[test]
    fn a_command_names_the_program_it_needs() {
        assert_eq!(prerequisite("npm install -g cline"), Some("npm"));
        assert_eq!(prerequisite("winget install -e --id Git.Git"), Some("winget"));
        assert_eq!(prerequisite("curl -fsSL https://claude.ai/install.sh | bash"), Some("curl"));
    }

    #[test]
    fn the_status_lists_git_first_and_every_cli() {
        let tools = status_with(None);
        assert_eq!(tools[0].id, "git");
        assert!(tools[0].installed, "the suite runs where git is installed");
        assert_eq!(tools.iter().filter(|tool| tool.group == Agent).count(), cli_providers().len());
        assert!(EXTERNAL_TOOLS.iter().all(|expected| tools.iter().any(|tool| tool.id == expected.id)));
        assert!(tools.iter().all(|tool| !tool.url.is_empty()));
    }
}
