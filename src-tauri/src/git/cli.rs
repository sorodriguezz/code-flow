//! The git CLI, run to completion and waited for — for the local operations libgit2 either cannot
//! do at all or does without honouring the user's own setup.
//!
//! Everything else in this directory is libgit2, and for good reason: it is in-process, it cannot
//! prompt, and it reports structured errors. But it is a reimplementation of git, not git, and a few
//! things a git user relies on simply do not exist in it:
//!
//! * **hooks** — `pre-commit`, `commit-msg` and friends (husky, lint-staged, pre-commit.com) are run
//!   by `git commit`, and libgit2 has no notion of them;
//! * **commit signing** — `commit.gpgsign`, with either GPG or `gpg.format=ssh`;
//! * **filter drivers** — Git LFS is a `filter=lfs` attribute backed by a *process* that git runs on
//!   `git add`; libgit2 only knows its built-in CRLF and ident filters, so without the CLI an LFS
//!   file is staged as its whole binary instead of as a pointer;
//! * **bisect** and **worktree add/remove**, which are state machines git owns.
//!
//! Network operations are deliberately *not* here. Those stream their progress to the UI, classify
//! the dozen ways a remote can refuse, and run under a network-shaped deadline — see
//! [`crate::remote`]. What runs here is local: it touches the repository and the working tree and
//! nothing else, so a plain blocking call with a generous deadline is the right shape.
//!
//! Every run gets no stdin and `GIT_TERMINAL_PROMPT=0`, for the reason `crate::remote` gives: there
//! is no terminal behind this process, and anything that waits on one waits forever. An editor is
//! the other thing git reaches for on its own (`git commit` without `-m`, `bisect` never, `worktree`
//! never), so `GIT_EDITOR=true` accepts whatever git prepared rather than hanging on a `vi` nobody
//! can see.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

/// How long a local run may take before it is killed.
///
/// Far longer than any git operation takes on its own, because the long pole here is not git: it is
/// the user's hooks. A `pre-commit` that runs a type check and a test suite routinely takes a minute
/// on a real project, and killing it half-way would read as the app breaking their commit. Ten
/// minutes is a bound on a hook that hung, not an estimate of one that works.
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What a finished run printed, and whether it succeeded.
#[derive(Debug, Clone)]
pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    /// The run was killed at its deadline rather than finishing.
    pub timed_out: bool,
}

impl Output {
    /// Everything the run printed, stderr first — the order that reads naturally for a hook, which
    /// usually explains itself on stderr and dumps whatever it was running on stdout.
    pub fn combined(&self) -> String {
        [self.stderr.trim_end(), self.stdout.trim_end()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The one line of explanation to put in an error: git writes its own failures to stderr, and
    /// only falls back to stdout for the rare command that explains itself there.
    pub fn detail(&self) -> String {
        let text = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        text.trim().to_string()
    }
}

/// Runs `git <args>` in `cwd` and waits for it, up to `timeout`.
///
/// `Err` only when git could not be started at all (not installed, not on `PATH`); a git that ran and
/// failed is an `Ok` with `success: false`, because the callers here each read the failure in their
/// own terms — a hook refusing a commit is not the same kind of thing as a bad revision.
///
/// The child gets a process group of its own on Unix so the deadline can stop everything under it —
/// a hook is a shell script that starts node that starts a test runner, and killing `git` alone
/// would leave those holding the pipes this is reading.
pub fn run(cwd: &Path, args: &[&str], env: &[(&str, &str)], timeout: Duration) -> Result<Output, String> {
    let mut cmd = crate::proc::std_command("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        cmd.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    // Drained on threads of their own: a hook that prints more than a pipe buffer holds would
    // otherwise block on its write while this waits for it to exit — a deadlock that only shows up
    // on the projects with the chattiest hooks.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let out_thread = drain(stdout.map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err_thread = drain(stderr.map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                kill_group(&mut child);
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(e.to_string()),
        }
    };

    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok(Output {
        success: !timed_out && status.is_some_and(|s| s.success()),
        stdout,
        stderr,
        timed_out,
    })
}

/// [`run`] with a repository path as the working directory, which is how every caller here names it.
pub fn run_in(repo_path: &str, args: &[&str], env: &[(&str, &str)]) -> Result<Output, String> {
    run(Path::new(repo_path), args, env, LOCAL_TIMEOUT)
}

fn kill_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // The pid is the group id — see `process_group(0)` above. SIGKILL straight away: this is the
        // deadline, the polite window was the ten minutes before it.
        let group = -(child.id() as i32);
        // SAFETY: `kill` takes only integers and a group that already exited answers `ESRCH`, which
        // is exactly the outcome being asked for.
        unsafe { libc::kill(group, libc::SIGKILL) };
    }
    let _ = child.kill();
}

/// Whether `git lfs` is installed, asked once per process.
///
/// A repository can say `filter=lfs` in its attributes on a machine where Git LFS was never
/// installed, and then `git add` through the CLI stages the raw file exactly as libgit2 would — so
/// the answer changes what the indicator says, not just what runs. Cached because it is a process
/// spawn and the answer does not change while the app is open (installing LFS mid-session is rare
/// enough that a restart is a fair price).
pub fn lfs_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        run(&std::env::temp_dir(), &["lfs", "version"], &[], Duration::from_secs(10))
            .map(|out| out.success)
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_successful_run_reports_its_output() {
        let out = run(&std::env::temp_dir(), &["--version"], &[], Duration::from_secs(30)).unwrap();
        assert!(out.success);
        assert!(out.stdout.starts_with("git version"), "{:?}", out.stdout);
        assert!(!out.timed_out);
    }

    #[test]
    fn a_failing_run_is_ok_with_success_false() {
        let dir = std::env::temp_dir().join(format!("cf-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Not a repository: git answers with a fatal on stderr and a non-zero exit.
        let out = run(&dir, &["rev-parse", "HEAD"], &[], Duration::from_secs(30)).unwrap();
        assert!(!out.success);
        assert!(!out.detail().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn combined_puts_stderr_first_and_skips_empty_parts() {
        let out = Output {
            success: false,
            stdout: "ran 3 checks\n".into(),
            stderr: "lint failed\n".into(),
            timed_out: false,
        };
        assert_eq!(out.combined(), "lint failed\nran 3 checks");
        let quiet = Output { success: false, stdout: String::new(), stderr: "only this\n".into(), timed_out: false };
        assert_eq!(quiet.combined(), "only this");
        assert_eq!(quiet.detail(), "only this");
    }
}
