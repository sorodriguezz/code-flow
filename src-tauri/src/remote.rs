use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// All clone/fetch/pull/push runs go through the system `git` binary so the user's
/// existing SSH keys, HTTPS credential manager, and global git config are reused as-is —
/// never through a generic shell-exec surface exposed to the frontend.

#[derive(Clone, Serialize)]
pub struct GitProgressEvent {
    pub op: String,
    pub line: String,
}

#[derive(Clone, Serialize)]
pub struct GitDoneEvent {
    pub op: String,
    pub success: bool,
    pub message: String,
}

async fn run_streamed(app: &AppHandle, op: &str, cwd: Option<&str>, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let app_out = app.clone();
    let op_out = op.to_string();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut collected = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("git:progress", GitProgressEvent { op: op_out.clone(), line: line.clone() });
            collected.push(line);
        }
        collected
    });

    let app_err = app.clone();
    let op_err = op.to_string();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("git:progress", GitProgressEvent { op: op_err.clone(), line: line.clone() });
            collected.push(line);
        }
        collected
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stdout_lines = stdout_task.await.unwrap_or_default();
    let stderr_lines = stderr_task.await.unwrap_or_default();

    let success = status.success();

    // git writes most error detail to stderr, but some commands (rare misconfigurations)
    // only explain themselves on stdout — fall back so the UI never shows a bare
    // "git fetch failed" with no reason.
    let detail = if !stderr_lines.is_empty() {
        stderr_lines.join("\n")
    } else if !stdout_lines.is_empty() {
        stdout_lines.join("\n")
    } else {
        format!("git {op} exited with {status}")
    };

    let _ = app.emit(
        "git:done",
        GitDoneEvent {
            op: op.to_string(),
            success,
            message: if success { "ok".to_string() } else { detail.clone() },
        },
    );

    if success {
        Ok(())
    } else {
        Err(format!("git {op} failed: {detail}"))
    }
}

pub async fn clone(app: AppHandle, url: String, dest: String) -> Result<(), String> {
    run_streamed(&app, "clone", None, &["clone", &url, &dest]).await
}

pub async fn fetch(app: AppHandle, repo_path: String, remote: Option<String>) -> Result<(), String> {
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    run_streamed(&app, "fetch", Some(&repo_path), &["fetch", &remote]).await
}

pub async fn pull(app: AppHandle, repo_path: String) -> Result<(), String> {
    run_streamed(&app, "pull", Some(&repo_path), &["pull"]).await
}

pub async fn push(app: AppHandle, repo_path: String, set_upstream: bool) -> Result<(), String> {
    if set_upstream {
        let branch = {
            let repo = crate::git::repo::open(&repo_path)?;
            let head = repo.head().map_err(|e| e.message().to_string())?;
            head.shorthand()
                .ok_or("cannot push -u from a detached HEAD")?
                .to_string()
        };
        run_streamed(&app, "push", Some(&repo_path), &["push", "-u", "origin", &branch]).await
    } else {
        run_streamed(&app, "push", Some(&repo_path), &["push"]).await
    }
}
