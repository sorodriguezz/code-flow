//! The shells a terminal can be opened with — the model behind VS Code's terminal profile picker.
//!
//! A profile is a name plus the command and arguments to launch. Two kinds exist:
//!
//! * **Built-in** — detected on this machine at every launch (Git Bash, PowerShell and cmd on
//!   Windows; `$SHELL`, zsh, bash, fish, sh elsewhere). Deliberately *not* persisted: re-detecting
//!   means a shell installed after CodeFlow was first run shows up on its own, and one that was
//!   uninstalled stops being offered, with nothing for the user to edit either way.
//! * **Custom** — added by the user in Settings and stored in `app_settings` under
//!   [`PROFILES_KEY`], alongside the chosen default's id under [`DEFAULT_PROFILE_KEY`].
//!
//! The frontend passes a profile *id*, never a command line: which programs the app is willing to
//! spawn stays decided back here, the same way clone/fetch/pull/push go through a fixed `git`
//! invocation rather than a general shell-exec surface.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{queries, Db};

pub const PROFILES_KEY: &str = "terminal_profiles";
pub const DEFAULT_PROFILE_KEY: &str = "terminal_default_profile";

#[cfg(target_os = "windows")]
const GIT_BASH_ID: &str = "git-bash";

#[cfg(target_os = "windows")]
const GIT_BASH_MISSING: &str =
    "Git Bash not found — install Git for Windows (https://git-scm.com/download/win), or pick another shell as your default terminal profile in Settings › Terminal";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShellProfile {
    /// Stable across launches: a fixed slug for built-ins, a generated id for custom profiles.
    /// This is the only part of a profile the frontend sends back when opening a terminal.
    pub id: String,
    pub name: String,
    /// The absolute path detection resolved, or whatever the user typed for a custom profile.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Detected by the app rather than added by the user — built-ins aren't editable in Settings.
    #[serde(default)]
    pub builtin: bool,
}

/// Resolves a bare executable name against `PATH`. Windows callers pass the name *with* its
/// extension, so there's no `PATHEXT` guessing to do.
fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
fn windows_git_bash() -> Option<PathBuf> {
    // Ask git itself where it's installed rather than guessing — this app already requires
    // `git` on PATH for clone/fetch/pull/push, so this resolves regardless of whether it's a
    // standard Program Files install, a custom drive, scoop/chocolatey, or a portable copy.
    // `--exec-path` prints something like `<root>\mingw64\libexec\git-core`; walk up from
    // there looking for `<ancestor>\bin\bash.exe`.
    if let Ok(output) = crate::proc::std_command("git").arg("--exec-path").output() {
        if output.status.success() {
            let exec_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let mut dir = PathBuf::from(exec_path);
            for _ in 0..6 {
                let candidate = dir.join("bin").join("bash.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }

    // Common install locations, as a fallback if `git --exec-path` didn't resolve (e.g. `git`
    // not actually on PATH despite being installed).
    [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
}

fn profile(id: &str, name: &str, command: PathBuf, args: &[&str]) -> ShellProfile {
    ShellProfile {
        id: id.to_string(),
        name: name.to_string(),
        command: command.to_string_lossy().into_owned(),
        args: args.iter().map(|a| a.to_string()).collect(),
        builtin: true,
    }
}

/// Every shell found on this machine, in the order they're offered. First place is the
/// platform-conventional one, which is also what an unconfigured default falls back to.
#[cfg(target_os = "windows")]
fn detect() -> Vec<ShellProfile> {
    let mut found = Vec::new();
    if let Some(bash) = windows_git_bash() {
        // `--login -i` so the profile files run and the shell behaves like a real login shell,
        // which is what Git Bash's own shortcut does.
        found.push(profile(GIT_BASH_ID, "Git Bash", bash, &["--login", "-i"]));
    }
    if let Some(pwsh) = which("pwsh.exe") {
        found.push(profile("pwsh", "PowerShell", pwsh, &["-NoLogo"]));
    }
    if let Some(powershell) = which("powershell.exe") {
        found.push(profile("powershell", "Windows PowerShell", powershell, &["-NoLogo"]));
    }
    if let Some(cmd) = which("cmd.exe") {
        found.push(profile("cmd", "Command Prompt", cmd, &[]));
    }
    found
}

/// The flag that makes a shell a *login* shell, for the shells that spell it `-l`.
///
/// Without it the terminal's `PATH` is launchd's, not the user's. A GUI app on macOS inherits a
/// four-entry `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) and nothing else, and the file that fixes
/// that on almost every developer machine — `~/.zprofile`, where Homebrew's `shellenv`, nvm, pnpm
/// and asdf all put themselves — is read by login shells *only*. `~/.zshrc` still ran, which is
/// why the prompt looked right; that made the failure read as "CodeFlow can't find npm" rather
/// than "this shell never sourced your profile". `node`, `npm`, `pnpm` and every globally-installed
/// CLI came back as `command not found` in a terminal where the same command works one window over.
///
/// This is what Terminal.app, iTerm and VS Code all do, so `-l` is also the thing that makes this
/// pane behave like the terminal the user already has rather than like a subtly different one.
///
/// By name rather than for everything, because `-l` is only near-universal: it holds for the four
/// shells detected below and for the usual `$SHELL` values, but a login shell is not required to
/// spell the flag that way, and passing it to one that reads it as something else turns "an odd
/// `PATH`" into "the terminal won't open at all". An unrecognised `$SHELL` keeps today's behaviour.
#[cfg(not(target_os = "windows"))]
fn login_args(shell_name: &str) -> &'static [&'static str] {
    match shell_name {
        "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" => &["-l"],
        _ => &[],
    }
}

#[cfg(not(target_os = "windows"))]
fn detect() -> Vec<ShellProfile> {
    let mut found: Vec<ShellProfile> = Vec::new();

    let mut push = |id: String, command: PathBuf| {
        // Deduplicated by id, so `$SHELL` pointing at /bin/zsh doesn't list zsh twice — the
        // login shell is added first and therefore wins the slot.
        if !found.iter().any(|p| p.id == id) {
            let name = id.clone();
            // The id *is* the executable's basename, for both the `$SHELL` entry and the four
            // below, which is exactly what decides how to ask for a login shell.
            let args = login_args(&id);
            found.push(profile(&id, &name, command, args));
        }
    };

    // The user's login shell leads: it's what every other terminal on the machine opens, and it
    // was this app's only behaviour before profiles existed.
    if let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_file()) {
        if let Some(name) = shell.file_name().map(|n| n.to_string_lossy().into_owned()) {
            push(name, shell);
        }
    }

    for name in ["zsh", "bash", "fish", "sh"] {
        // `/bin` explicitly as well as `PATH`: a login shell can have a `PATH` that omits it.
        if let Some(path) = which(name).or_else(|| Some(PathBuf::from("/bin").join(name)).filter(|p| p.is_file())) {
            push(name.to_string(), path);
        }
    }

    found
}

fn setting(db: &State<'_, Db>, key: &str) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_setting(&conn, key).map_err(|e| e.to_string())
}

/// Built-ins followed by the user's own profiles. A custom profile whose id collides with a
/// built-in is dropped rather than shadowing it — ids are generated, so a collision means
/// corrupted settings, not an intentional override.
pub fn list(db: &State<'_, Db>) -> Result<Vec<ShellProfile>, String> {
    let mut profiles = detect();
    if let Some(raw) = setting(db, PROFILES_KEY)? {
        if let Ok(custom) = serde_json::from_str::<Vec<ShellProfile>>(&raw) {
            for mut entry in custom {
                if entry.command.trim().is_empty() || profiles.iter().any(|p| p.id == entry.id) {
                    continue;
                }
                entry.builtin = false;
                profiles.push(entry);
            }
        }
    }
    Ok(profiles)
}

/// Picks the profile a new terminal should run: the one explicitly requested, else the configured
/// default, else the platform's implicit default.
pub fn resolve(db: &State<'_, Db>, requested: Option<&str>) -> Result<ShellProfile, String> {
    let profiles = list(db)?;
    let configured = setting(db, DEFAULT_PROFILE_KEY)?;
    choose(profiles, requested, configured.as_deref())
}

/// The precedence itself, split from the IO above so it can be tested against synthetic profile
/// lists — this is where every branch that decides which shell a user actually gets lives.
fn choose(
    profiles: Vec<ShellProfile>,
    requested: Option<&str>,
    configured: Option<&str>,
) -> Result<ShellProfile, String> {
    if let Some(id) = requested.filter(|id| !id.is_empty()) {
        return profiles
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("terminal profile \"{id}\" is no longer available"));
    }

    if let Some(id) = configured.filter(|id| !id.is_empty()) {
        if let Some(found) = profiles.iter().find(|p| p.id == id) {
            return Ok(found.clone());
        }
        // A default pointing at something that's gone — an uninstalled shell, a custom profile
        // deleted from another window — falls through to the implicit default rather than
        // leaving the user unable to open a terminal at all.
    }

    implicit_default(profiles)
}

/// Windows keeps Git Bash as the *implicit* default even with PowerShell and cmd detected: this
/// app leans on git for everything, and quietly handing back PowerShell when Git for Windows is
/// missing is the exact failure the previous single-shell code was written to avoid. Choosing
/// PowerShell or cmd is now possible, but it stays a deliberate choice — from the terminal's
/// profile menu, or by setting one as the default in Settings.
#[cfg(target_os = "windows")]
fn implicit_default(profiles: Vec<ShellProfile>) -> Result<ShellProfile, String> {
    profiles
        .into_iter()
        .find(|p| p.id == GIT_BASH_ID)
        .ok_or_else(|| GIT_BASH_MISSING.to_string())
}

#[cfg(not(target_os = "windows"))]
fn implicit_default(profiles: Vec<ShellProfile>) -> Result<ShellProfile, String> {
    profiles
        .into_iter()
        .next()
        .ok_or_else(|| "No shell found — set SHELL, or add a terminal profile in Settings".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Detection has to produce something usable on whatever machine the suite runs on, and every
    /// entry has to be launchable: a blank command or a duplicate id would reach `CommandBuilder`.
    #[test]
    fn detects_at_least_one_launchable_shell() {
        let found = detect();
        assert!(!found.is_empty(), "no shell detected on this machine");

        let mut ids: Vec<&str> = found.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "detected profiles share an id");

        for p in &found {
            assert!(!p.command.trim().is_empty(), "profile {} has no command", p.id);
            assert!(p.builtin, "detected profile {} isn't marked built-in", p.id);
        }
    }

    /// Every detected shell has to be asked for a *login* shell, or its user's `PATH` never gets
    /// built: a GUI app's environment is launchd's, and `~/.zprofile` is where the entries that
    /// make `npm`, `pnpm` and every other globally-installed CLI resolvable actually live.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn detected_shells_are_login_shells() {
        for p in detect() {
            // Only the shells `login_args` knows; an exotic `$SHELL` is deliberately left alone.
            if !matches!(p.id.as_str(), "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh") {
                continue;
            }
            assert!(
                p.args.iter().any(|a| a == "-l"),
                "profile {} is not a login shell: {:?}",
                p.id,
                p.args,
            );
        }
    }

    /// The login shell has to lead on Unix — that's the behaviour terminals had before profiles
    /// existed, and an unconfigured default still resolves to whatever comes first.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_login_shell_comes_first() {
        let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_file()) else {
            return; // No SHELL set (some CI containers) — nothing to assert.
        };
        let found = detect();
        assert_eq!(found[0].command, shell.to_string_lossy());
    }

    fn fake(id: &str) -> ShellProfile {
        ShellProfile {
            id: id.to_string(),
            name: id.to_string(),
            command: format!("/bin/{id}"),
            args: Vec::new(),
            builtin: true,
        }
    }

    /// On Windows the implicit default is Git Bash specifically, so the synthetic lists below have
    /// to contain it for the "no explicit choice" cases to resolve at all.
    fn sample() -> Vec<ShellProfile> {
        #[cfg(target_os = "windows")]
        return vec![fake(GIT_BASH_ID), fake("powershell"), fake("custom-one")];
        #[cfg(not(target_os = "windows"))]
        return vec![fake("zsh"), fake("bash"), fake("custom-one")];
    }

    #[test]
    fn an_explicit_request_wins_over_the_configured_default() {
        let picked = choose(sample(), Some("custom-one"), Some("bash")).unwrap();
        assert_eq!(picked.id, "custom-one");
    }

    #[test]
    fn the_configured_default_is_used_when_nothing_was_requested() {
        let picked = choose(sample(), None, Some("custom-one")).unwrap();
        assert_eq!(picked.id, "custom-one");
    }

    /// The case that would otherwise leave a user unable to open a terminal at all: a saved
    /// default naming a shell that has since been uninstalled or deleted.
    #[test]
    fn a_stale_configured_default_falls_back_instead_of_failing() {
        let picked = choose(sample(), None, Some("uninstalled-shell")).unwrap();
        assert_eq!(picked.id, sample()[0].id);
    }

    #[test]
    fn an_empty_default_is_treated_as_unset() {
        let picked = choose(sample(), None, Some("")).unwrap();
        assert_eq!(picked.id, sample()[0].id);
    }

    /// Asking for a profile that's gone is the one case that surfaces as an error rather than a
    /// fallback — the user picked it by name, so silently opening a different shell would lie.
    #[test]
    fn requesting_a_missing_profile_is_an_error() {
        let err = choose(sample(), Some("nope"), None).unwrap_err();
        assert!(err.contains("nope"), "error should name the missing profile, got: {err}");
    }

    /// Unix falls back to the first detected profile (the login shell); Windows insists on Git
    /// Bash and reports how to install it rather than quietly substituting PowerShell.
    #[test]
    fn the_implicit_default_matches_the_platform_rule() {
        #[cfg(target_os = "windows")]
        {
            let without_git_bash = vec![fake("powershell"), fake("cmd")];
            let err = choose(without_git_bash, None, None).unwrap_err();
            assert!(err.contains("git-scm.com"), "should point at the Git for Windows download");
            assert_eq!(choose(sample(), None, None).unwrap().id, GIT_BASH_ID);
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(choose(sample(), None, None).unwrap().id, "zsh");
            assert!(choose(Vec::new(), None, None).is_err());
        }
    }
}
