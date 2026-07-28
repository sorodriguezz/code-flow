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
