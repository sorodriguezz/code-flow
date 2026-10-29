//! Installing what the app shells out to — `git` and the AI CLIs — from inside the app.
//!
//! Two callers: the first-launch «Preparar CodeFlow» screen, where the person ticks what they want,
//! and the one-click «Instalar» beside a tool Settings reports as not found. Both run the same
//! command from the same table, so there is one answer to "how does CodeFlow install X".
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

/// One tool the setup can offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    /// `git`, or a provider id.
    pub id: String,
    pub label: String,
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

/// The install line for `id` on this platform. `has` answers "is this program on the machine",
/// which only decides git's route on a Mac.
fn command_for(id: &str, windows: bool, has: &dyn Fn(&str) -> bool) -> Option<String> {
    if id == "git" {
        let line = if windows {
            "winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements"
        } else if has("brew") {
            "brew install git"
        } else if cfg!(target_os = "macos") {
            "xcode-select --install"
        } else {
            // Linux: the distribution's package manager wants root; that is the person's to run.
            return None;
        };
        return Some(line.to_string());
    }
    let row = provider_caps::setup_of(id)?;
    (if windows { row.windows } else { row.unix }).map(str::to_string)
}

/// The program a command needs before it can run, when that is something people often lack.
fn prerequisite(command: &str) -> Option<&'static str> {
    let first = command.split_whitespace().next()?;
    match first {
        "npm" => Some("npm"),
        "winget" => Some("winget"),
        "brew" => Some("brew"),
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

/// `git --version` with the given `PATH` — running it, for the reason `requirements::git` gives.
fn git_version(path: Option<&str>) -> Option<String> {
    let mut command = crate::proc::std_command("git");
    command.arg("--version").stdin(std::process::Stdio::null());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Every tool and whether it is here. `fresh` is a login shell's `PATH` when the caller has one.
fn status_with(fresh: Option<&str>) -> Vec<ToolStatus> {
    let windows = cfg!(target_os = "windows");
    let has = |program: &str| locate(program, fresh).is_some();
    let entry = |id: &str, label: String, installed: bool, detail: String, url: &str| {
        let command = command_for(id, windows, &has);
        let missing_prerequisite = command
            .as_deref()
            .and_then(prerequisite)
            .filter(|program| !has(program))
            .map(str::to_string);
        ToolStatus { id: id.to_string(), label, installed, detail, command, missing_prerequisite, url: url.to_string() }
    };

    let git = git_version(fresh).or_else(|| git_version(None));
    let mut tools = vec![entry("git", "Git".into(), git.is_some(), git.unwrap_or_default(), GIT_URL)];
    for caps in cli_providers() {
        let found = locate(&binary_of(&caps), fresh);
        let url = provider_caps::setup_of(&caps.id).map(|row| row.url).unwrap_or_default();
        tools.push(entry(
            &caps.id,
            caps.label.clone(),
            found.is_some(),
            found.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default(),
            url,
        ));
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
        command.args(["-c", line]);
        command
    };
    if let Some(path) = path {
        command.env("PATH", path);
    }
    // Package managers that would otherwise stop to ask.
    command.env("CI", "1").env("HOMEBREW_NO_AUTO_UPDATE", "1").env("NONINTERACTIVE", "1");
    command
}

/// Installs `id` with its command from the table, streaming its output as `tool-setup:progress`.
pub async fn install(app: &AppHandle, id: &str) -> Result<InstallResult, String> {
    let fresh = tokio::task::spawn_blocking(crate::shell_env::fresh_path).await.ok().flatten();
    let tools = status_with(fresh.as_deref());
    let tool = tools.iter().find(|tool| tool.id == id).ok_or_else(|| format!("{id} is not something the setup installs"))?;
    let line = tool.command.clone().ok_or_else(|| format!("{id} has no install command on this platform"))?;
    if let Some(missing) = &tool.missing_prerequisite {
        let tail = vec![format!("{missing} is not installed; it is needed to run: {line}")];
        return Ok(result(id, Outcome::Failed, String::new(), &tail, true));
    }
    if crate::ai_runs::live_processes() > 0 {
        return Ok(result(id, Outcome::Busy, String::new(), &[], false));
    }
    // The update's lock, not one of our own: see `cli_updates::single_flight`.
    let Ok(_turn) = crate::cli_updates::single_flight().try_lock() else {
        return Ok(result(id, Outcome::Busy, String::new(), &[], false));
    };

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
    let status = loop {
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
    if !status.is_some_and(|status| status.success()) {
        return Ok(result(id, Outcome::Failed, String::new(), &lines, true));
    }
    if line.starts_with("xcode-select") {
        return Ok(result(id, Outcome::HandedOff, String::new(), &lines, false));
    }

    // Asked again with a `PATH` read after the install: an installer that edited a profile is only
    // visible to a shell started now.
    let fresh = tokio::task::spawn_blocking(crate::shell_env::fresh_path).await.ok().flatten();
    let after = status_with(fresh.as_deref());
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
        if cfg!(target_os = "macos") {
            assert_eq!(command_for("git", false, &|p| p == "brew").as_deref(), Some("brew install git"));
            assert_eq!(command_for("git", false, &|_| false).as_deref(), Some("xcode-select --install"));
        }
        let windows = command_for("git", true, &|_| false).unwrap();
        assert!(windows.starts_with("winget install -e --id Git.Git"), "{windows}");
    }

    #[test]
    fn every_cli_provider_is_offered_with_its_own_command() {
        for caps in cli_providers() {
            let row = provider_caps::setup_of(&caps.id).unwrap();
            assert_eq!(command_for(&caps.id, true, &|_| true).as_deref(), row.windows, "{}", caps.id);
            assert_eq!(command_for(&caps.id, false, &|_| true).as_deref(), row.unix, "{}", caps.id);
        }
        assert!(command_for("codeflow", false, &|_| true).is_none());
        assert!(command_for("not-a-tool", false, &|_| true).is_none());
    }

    #[test]
    fn a_command_names_the_program_it_needs() {
        assert_eq!(prerequisite("npm install -g cline"), Some("npm"));
        assert_eq!(prerequisite("winget install -e --id Git.Git"), Some("winget"));
        assert_eq!(prerequisite("curl -fsSL https://claude.ai/install.sh | bash"), None);
    }

    #[test]
    fn the_status_lists_git_first_and_every_cli() {
        let tools = status_with(None);
        assert_eq!(tools[0].id, "git");
        assert!(tools[0].installed, "the suite runs where git is installed");
        assert_eq!(tools.len(), 1 + cli_providers().len());
        assert!(tools.iter().all(|tool| !tool.url.is_empty()));
    }
}
