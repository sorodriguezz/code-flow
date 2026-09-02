//! Every child process this app launches is built here.
//!
//! `windows_subsystem = "windows"` (see `main.rs`) only keeps *CodeFlow itself* from owning a
//! console — it says nothing about the processes CodeFlow spawns. Windows hands each console
//! binary we launch (`git`, `node`, `npx`, the AI CLIs, `taskkill`, …) a fresh `conhost` window,
//! so a plain `Command::new("git")` flashes a black window on screen on every fetch, pull, push
//! and review. `CREATE_NO_WINDOW` suppresses it: the child still gets a console — piped stdout
//! and stderr keep working exactly as before — that console just never becomes visible.
//!
//! Going through [`command`] / [`std_command`] instead of `Command::new` is what keeps this
//! fixed: a spawn site added later can't reintroduce the flash by forgetting the flag.

use std::ffi::OsStr;

/// `CREATE_NO_WINDOW` from the Win32 process-creation flags (winbase.h).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// An async [`tokio::process::Command`] that won't flash a console window on Windows.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    hide_console(&mut cmd);
    cmd
}

/// The blocking [`std::process::Command`] counterpart of [`command`].
pub fn std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    hide_console_std(&mut cmd);
    cmd
}

/// Applies the no-window flag to a command that was built elsewhere. The AI engines assemble
/// their own `Command` in `AiEngine::build_command`, so rather than repeating the flag in each
/// engine they're covered at the single point where `ai::run`/`ai::capture` prepare that command
/// for spawning.
pub fn hide_console(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// [`hide_console`] for the blocking `Command`.
pub fn hide_console_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Puts the child in a **process group of its own**, so it can later be stopped along with
/// everything it starts.
///
/// Unix only, and it is half of a pair — the other half is [`crate::ai_runs::kill_tree`], which
/// signals the group. Without this the two are useless to each other: a child that inherits
/// CodeFlow's own process group cannot be signalled as a group, because doing so would signal
/// CodeFlow.
///
/// The reason it matters is what these children *are*. Every AI CLI here is a Node process that
/// spawns more — MCP servers, ripgrep, its own subagents — and `Child::kill` sends SIGKILL to the
/// one process it holds a handle to. The CLI dies; its children are reparented to init and carry on
/// burning tokens, which is precisely the "Stop did nothing" a long agentic run reports. A run that
/// has only just started usually has no descendants yet, which is why this looked like it worked.
///
/// Windows needs nothing here: `taskkill /T` walks the process tree from a pid on its own, and
/// `CREATE_NEW_PROCESS_GROUP` there would change Ctrl-C handling rather than help.
pub fn own_process_group(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    // `0` means "a new group whose id is the child's own pid" — which is what makes the pid the
    // caller already has double as the group to signal.
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

/// Adds `extra` Windows creation flags **on top of** `CREATE_NO_WINDOW`.
///
/// `creation_flags` *replaces* the whole flag word rather than OR-ing into it — std stores it
/// verbatim (`self.flags = flags;`) and tokio forwards it unchanged — so a second call anywhere
/// wins outright and takes the no-window flag with it. A future site wanting, say,
/// `CREATE_NEW_PROCESS_GROUP` for Ctrl-Break handling would write `cmd.creation_flags(GROUP)` after
/// `command()` and silently un-hide every child it starts: no compile error, no failing test, and a
/// symptom only visible on Windows. That is exactly the drift this module exists to stop, which is
/// why the test below makes a bare `creation_flags(` outside this file a build failure.
// Unused today, and it has to exist anyway: it is the escape hatch the test below tells you to
// use, and an error message pointing at a function nobody wrote is worse than a dead one.
#[allow(dead_code)]
pub fn with_flags(cmd: &mut tokio::process::Command, extra: u32) -> &mut tokio::process::Command {
    // `extra` is meaningful only on Windows; naming it here keeps the signature identical on every
    // platform so a call site needs no `cfg` of its own.
    let _ = extra;
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW | extra);
    cmd
}

#[cfg(test)]
mod tests {
    /// `creation_flags` may only be called here.
    ///
    /// Not a style rule. It replaces the flag word, so one call anywhere else removes
    /// `CREATE_NO_WINDOW` from every child that site starts — and the failure is invisible on the
    /// machines most of this is written on. A grep in CI would work if there were a CI that ran on
    /// pull requests; there is only `release.yml`, so this lives where the project already looks.
    #[test]
    fn creation_flags_is_only_called_in_this_module() {
        fn walk(dir: &std::path::Path, hits: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, hits);
                } else if path.extension().is_some_and(|e| e == "rs")
                    && path.file_name().is_some_and(|n| n != "proc.rs")
                {
                    let Ok(text) = std::fs::read_to_string(&path) else { continue };
                    for (n, line) in text.lines().enumerate() {
                        if line.contains("creation_flags(") {
                            hits.push(format!("{}:{}", path.display(), n + 1));
                        }
                    }
                }
            }
        }

        let mut hits = Vec::new();
        walk(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").as_path(), &mut hits);
        assert!(
            hits.is_empty(),
            "`creation_flags` replaces the flag word rather than OR-ing into it, so calling it \
             outside `proc.rs` drops CREATE_NO_WINDOW and flashes a console window on Windows. \
             Use `proc::with_flags`, which ORs. Found at: {hits:?}",
        );
    }
}
