//! The editor's Tests view: one test command — a file's, or one test's — run to the end with its
//! output kept, so the view can say passed or failed and show why. The command line is built by the
//! frontend (`lib/testCommand.ts`) the same way the editor's «Ejecutar este test» types it into a
//! terminal; this only runs it.

use std::time::{Duration, Instant};

use serde::Serialize;

/// Past this, a run is stopped and reported as failed: a test file is not a ten-minute job, and a
/// runner left in watch mode would otherwise never come back.
const TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Output kept per run, from the end — where a runner prints its summary and the failures.
const MAX_OUTPUT: usize = 200_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    /// `None` when it was stopped (timeout) or killed by a signal.
    pub code: Option<i32>,
    pub output: String,
    pub millis: u64,
}

/// Through the platform's shell: `sh -c` here, PowerShell on Windows — `./gradlew.bat`, `npx` and a
/// double-quoted argument all read the same way in it as in Git Bash (see `testCommand`).
fn shell(command: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut cmd = crate::proc::command("powershell.exe");
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = crate::proc::command("/bin/sh");
        cmd.arg("-c").arg(command);
        cmd
    }
}

#[tauri::command]
pub async fn run_test_command(repo_path: String, cwd: String, command: String) -> Result<TestRunResult, String> {
    let root = std::path::Path::new(&repo_path);
    let dir = if cwd.is_empty() { root.to_path_buf() } else { root.join(&cwd) };
    // The working directory must stay inside the repository.
    let canonical = dir.canonicalize().map_err(|e| format!("{cwd}: {e}"))?;
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&base) {
        return Err("the test folder is outside the repository".to_string());
    }
    let path = tokio::task::spawn_blocking(crate::shell_env::fresh_path).await.ok().flatten();
    let mut cmd = shell(&command);
    cmd.current_dir(&canonical)
        // What a CI sets: runners stop watching and prompting, and leave colour out.
        .env("CI", "true")
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    let started = Instant::now();
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let outcome = tokio::time::timeout(TIMEOUT, child.wait_with_output()).await;
    let millis = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(Ok(output)) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            let err = String::from_utf8_lossy(&output.stderr);
            if !err.trim().is_empty() {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&err);
            }
            if text.len() > MAX_OUTPUT {
                let mut cut = text.len() - MAX_OUTPUT;
                while !text.is_char_boundary(cut) {
                    cut += 1;
                }
                text = format!("…\n{}", &text[cut..]);
            }
            Ok(TestRunResult { code: output.status.code(), output: text, millis })
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Ok(TestRunResult { code: None, output: format!("Stopped after {} minutes.", TIMEOUT.as_secs() / 60), millis }),
    }
}
