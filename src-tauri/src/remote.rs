use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::proc;

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
    let mut cmd = proc::command("git");
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

/// Fetches a single explicit refspec (e.g. a GitHub `refs/pull/<n>/head` pull-request ref)
/// rather than the remote's default branches — used to pull a PR's exact head commit for
/// review, which works even when the PR comes from a fork.
pub async fn fetch_refspec(app: AppHandle, repo_path: String, remote: String, refspec: String) -> Result<(), String> {
    run_streamed(&app, "fetch", Some(&repo_path), &["fetch", &remote, &refspec]).await
}

pub async fn pull(app: AppHandle, repo_path: String) -> Result<(), String> {
    run_streamed(&app, "pull", Some(&repo_path), &["pull"]).await
}

/// Brings one branch's remote-tracking ref up to date and nothing else — no working tree touched,
/// no local branch moved.
///
/// Narrow on purpose. The whole point of the per-row button in the branch list is to ask about
/// *that* branch from wherever you happen to be standing, rather than waiting on every ref the
/// remote has just to find out whether one of them moved.
pub async fn fetch_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    let (remote, merge_ref) = crate::git::branch::upstream_of(&repo_path, &branch)?;
    let short = merge_ref.strip_prefix("refs/heads/").unwrap_or(&merge_ref);
    let refspec = format!("+{merge_ref}:refs/remotes/{remote}/{short}");
    run_streamed(&app, "fetch", Some(&repo_path), &["fetch", &remote, &refspec]).await
}

/// Updates a branch from its upstream, checked out or not.
///
/// Two different commands behind one button, because git has no way to pull into a branch you are
/// not standing on. The checked-out branch takes the ordinary `git pull`, so it keeps whatever
/// merge-or-rebase the user's own config says; any other branch is fast-forwarded in place by
/// fetching straight into its ref.
///
/// No `+` on that refspec, and that is the safety of the whole feature: without force git refuses
/// anything that isn't a fast-forward, so a branch nobody is looking at is never rewritten behind
/// their back — it either moves forward or the pull fails and says why.
pub async fn pull_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    // `git fetch` flatly refuses to write the ref of a branch that is checked out, so this is not
    // an optimisation — it is the only route for the current branch.
    if crate::git::branch::is_head_branch(&repo_path, &branch)? {
        return pull(app, repo_path).await;
    }
    let (remote, merge_ref) = crate::git::branch::upstream_of(&repo_path, &branch)?;
    let short = merge_ref.strip_prefix("refs/heads/").unwrap_or(&merge_ref);
    let into_branch = format!("{merge_ref}:refs/heads/{branch}");
    // The tracking ref moves alongside the branch. git does update it opportunistically for an
    // explicit refspec, but only where the remote's own refspec covers it — and a list that still
    // says "3 behind" after a pull that worked is worse than one extra refspec here.
    let into_tracking = format!("+{merge_ref}:refs/remotes/{remote}/{short}");
    // Reported as "pull" rather than "fetch": the op name is what the progress lines and the
    // failure message are labelled with, and the user asked for a pull.
    run_streamed(&app, "pull", Some(&repo_path), &["fetch", &remote, &into_branch, &into_tracking]).await
}

/// Publishes one branch by name, whether or not it is the one checked out.
///
/// `push` publishes HEAD, which is the right shape for the status bar's button and the wrong one
/// everywhere a branch is *named* — the pull-request form most of all, where the branch you are
/// opening a PR from is picked from a list and is routinely not the one you are standing on.
///
/// Always `-u`. The only caller is "this branch has no upstream, publish it", so the tracking link
/// is the point rather than an option: a push that left the branch untracked would put the commits
/// on the remote and leave the form still saying the branch is local-only.
pub async fn push_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    // Against the named branch, not HEAD — see `guard_branch_unlocked_at`.
    crate::git::branch::guard_branch_unlocked_at(&repo_path, &branch)?;
    // Refuse a name that is not a local branch here rather than letting git answer with a refspec
    // error: this is reached from a picker, so the branch existing is the caller's claim to check.
    if !crate::git::branch::local_branch_exists(&repo_path, &branch)? {
        return Err(format!("no local branch named {branch}"));
    }
    run_streamed(&app, "push", Some(&repo_path), &["push", "-u", "origin", &branch]).await
}

pub async fn push(app: AppHandle, repo_path: String, set_upstream: bool) -> Result<(), String> {
    // `git push` publishes whatever branch is checked out, so the lock is checked against HEAD.
    crate::git::branch::guard_head_unlocked_at(&repo_path)?;
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
