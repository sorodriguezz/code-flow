//! The user's real `PATH`, imported from their login shell at startup.
//!
//! **The problem.** A GUI application is not launched by a shell. On macOS launchd starts it with a
//! four-entry `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) and nothing else; a Linux desktop entry is
//! much the same. None of the places a developer's tools actually live are on it: Homebrew's
//! `/opt/homebrew/bin`, nvm's `~/.nvm/versions/node/<version>/bin`, pnpm's global bin, asdf's
//! shims, `~/.cargo/bin`, a Volta or fnm install. Every one of those is put on `PATH` by a line in
//! `~/.zprofile` or `~/.zshrc` — files that a shell reads and a GUI app never does.
//!
//! So the app inherits a `PATH` that is missing most of the machine, and the failure lands far from
//! the cause: `failed to launch 'opencode': No such file or directory`, for a CLI that runs
//! perfectly in the user's terminal. Nothing about that message points at the environment, and the
//! obvious reading — "it isn't installed" — is wrong.
//!
//! **The fix.** Ask the login shell. It is the one thing that knows, because building that `PATH`
//! is precisely what its startup files do. Run it once, print `$PATH`, and adopt the answer.
//!
//! This is the same thing VS Code, Atom and a long line of Electron apps ended up doing, for the
//! same reason and after the same bug report.
//!
//! **What this is not.** It is not a replacement for [`crate::ai`]'s `install_dirs`, which stays:
//! that list covers directories a CLI installs into *without* putting itself on anyone's `PATH`
//! (the Codex desktop app is the clearest case), and no shell can report a directory its profile
//! never mentions. The two compose — this widens `PATH` to what the user has, and that list adds
//! what nobody put on it.

use std::time::Duration;

/// How long the shell gets. A profile that runs `nvm use` or an asdf hook can genuinely take a
/// second or two, so this is generous — but it is a hard ceiling on how long a broken or
/// input-blocked startup file can delay the app's own launch.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Markers around the value, so what comes back can be found inside whatever else the shell said.
///
/// An interactive shell is not a quiet one: profiles print version banners, `motd` fragments,
/// direnv notices and job-control chatter, and any of it can land on stdout ahead of the answer.
/// Reading "the output" as the `PATH` would inherit all of that as a directory name. Reading
/// *between the markers* is immune to it, and to the shell that decides to print something after
/// the value as well.
const OPEN: &str = "__CF_PATH_OPEN__";
const CLOSE: &str = "__CF_PATH_CLOSE__";

/// Adopts the login shell's `PATH`, if it can be had.
///
/// Call once, early in startup, before any threads are spawned: this writes a process-wide
/// environment variable, and the reason `set_var` is a footgun at all is other threads reading it
/// concurrently. Everything downstream — [`crate::ai`]'s search dirs, `shell_profiles::which`, the
/// `git` and `ssh` invocations, the pty — then reads the widened value without knowing this
/// happened.
///
/// Silent on every failure, and deliberately: the app worked before this existed and works after a
/// shell that won't answer. There is nothing here worth a dialog, and nothing the user could do
/// about it if there were.
#[cfg(not(target_os = "windows"))]
pub fn import_login_path() {
    let Some(shell) = std::env::var_os("SHELL").map(std::path::PathBuf::from) else {
        return;
    };
    let Some(imported) = query(&shell) else { return };
    let merged = merge(&imported, std::env::var("PATH").ok().as_deref());
    if merged.is_empty() {
        return;
    }
    std::env::set_var("PATH", merged);
}

/// Windows has no equivalent problem to solve: `PATH` is machine and user state in the registry,
/// not something a shell startup file assembles, and a GUI process gets the same one a console
/// does. (An app left *running* across an installer that edits it keeps the stale copy, which is
/// real — and is what `ai::install_dirs` already covers.)
#[cfg(target_os = "windows")]
pub fn import_login_path() {}

/// Runs the shell and returns whatever came back between the markers.
#[cfg(not(target_os = "windows"))]
fn query(shell: &std::path::Path) -> Option<String> {
    let name = shell.file_name()?.to_string_lossy().into_owned();
    let mut command = crate::proc::std_command(shell);
    for arg in login_args(&name) {
        command.arg(arg);
    }
    command.arg(script(&name));
    // No stdin at all. An interactive shell that decides to read from it — a profile prompting for
    // something, a `read` left in a startup file — blocks forever against a terminal that isn't
    // there; against `/dev/null` it gets EOF and moves on.
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());

    // Read on a thread so the wait can be given a deadline. `output()` has none of its own, and a
    // startup file that hangs would hang the app's launch behind it with no way out.
    //
    // On timeout the thread and its child are abandoned rather than killed: the handle lives on the
    // other side of the channel, and a shell that is merely slow will finish and exit on its own
    // moments later. The cost of being wrong is one short-lived orphaned process, once, against
    // plumbing a kill through a second channel to reclaim it.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(command.output().ok());
    });
    let output = rx.recv_timeout(TIMEOUT).ok()??;
    if !output.status.success() {
        return None;
    }
    extract(&String::from_utf8_lossy(&output.stdout))
}

/// Login *and* interactive, because the two halves of a `PATH` live in different files and no one
/// flag gets both: Homebrew's `shellenv` and asdf go in `~/.zprofile` (login only), while nvm and
/// pnpm's own installer append to `~/.zshrc` (interactive only). Asking for one of the two reliably
/// returns half the answer, which is worse than none — it looks like it worked.
///
/// By shell name rather than for anything `$SHELL` happens to point at, for the same reason
/// [`crate::shell_profiles`] spells its login flag out by name: an unrecognised shell is left to
/// the default `PATH` rather than handed flags it may read as something else entirely.
#[cfg(not(target_os = "windows"))]
fn login_args(shell_name: &str) -> &'static [&'static str] {
    match shell_name {
        "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" => &["-l", "-i", "-c"],
        _ => &["-c"],
    }
}

/// fish keeps `$PATH` as a *list*, so `"$PATH"` there is the entries joined by spaces rather than
/// by colons — a string that names one directory with spaces in it. It has to be joined explicitly.
#[cfg(not(target_os = "windows"))]
fn script(shell_name: &str) -> String {
    if shell_name == "fish" {
        format!("printf '{OPEN}%s{CLOSE}' (string join : $PATH)")
    } else {
        // The markers are inside the format string rather than interpolated as arguments, so the
        // shell never has to quote them and `$PATH` is the only thing it expands.
        format!("printf '{OPEN}%s{CLOSE}' \"$PATH\"")
    }
}

/// The value between the markers, or `None` if the shell never printed them.
fn extract(output: &str) -> Option<String> {
    let start = output.find(OPEN)? + OPEN.len();
    let end = output[start..].find(CLOSE)? + start;
    let value = output[start..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// The imported `PATH` first, then anything the process already had that it doesn't mention.
///
/// Additive rather than a replacement, so this can only ever widen the search. The login shell's
/// answer is the better one and goes first — it is the order the user's own terminal resolves in,
/// which is what makes "it works in my terminal" and "it works in CodeFlow" agree about *which*
/// `node` — but a launcher that injected something of its own into our environment keeps it, at
/// lower precedence, instead of having it silently dropped.
fn merge(imported: &str, current: Option<&str>) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut entries: Vec<&str> = Vec::new();
    for entry in imported.split(':').chain(current.unwrap_or("").split(':')) {
        if entry.is_empty() || !seen.insert(entry) {
            continue;
        }
        entries.push(entry);
    }
    entries.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole reason the markers exist: a profile that prints a banner, and a shell that adds a
    /// newline of its own after the value.
    #[test]
    fn the_value_is_found_among_whatever_else_the_shell_printed() {
        let noisy = format!("Welcome to zsh!\ndirenv: loading .envrc\n{OPEN}/opt/homebrew/bin:/usr/bin{CLOSE}\n");
        assert_eq!(extract(&noisy).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
    }

    /// A shell that failed before reaching the `printf`, or one whose output was truncated —
    /// answered with `None` rather than with a fragment that would become a directory name.
    #[test]
    fn output_without_both_markers_is_not_a_path() {
        assert_eq!(extract("command not found: nvm"), None);
        assert_eq!(extract(&format!("{OPEN}/usr/bin")), None);
        assert_eq!(extract(&format!("{OPEN}   {CLOSE}")), None);
    }

    /// The case this whole module is for: the launchd `PATH` on the left, a developer's real one on
    /// the right. Nothing is lost, nothing is duplicated, and the shell's entries win the order.
    #[test]
    fn the_imported_path_leads_and_nothing_is_dropped() {
        let merged = merge(
            "/opt/homebrew/bin:/Users/x/.nvm/versions/node/v22.3.0/bin:/usr/bin:/bin",
            Some("/usr/bin:/bin:/usr/sbin:/sbin"),
        );
        assert_eq!(
            merged,
            "/opt/homebrew/bin:/Users/x/.nvm/versions/node/v22.3.0/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        );
    }

    /// Empty segments are what a trailing or doubled colon leaves behind, and each one means "the
    /// current directory" to every program that resolves a `PATH` — which is not something to
    /// inherit from a stray keystroke in a profile, let alone to hand to a subprocess.
    #[test]
    fn empty_segments_are_dropped() {
        assert_eq!(merge("/usr/bin::/bin:", Some(":/usr/bin:")), "/usr/bin:/bin");
    }

    /// With nothing to merge against — a process launched with no `PATH` at all — the import stands
    /// on its own rather than coming back empty.
    #[test]
    fn a_missing_current_path_leaves_the_import_intact() {
        assert_eq!(merge("/opt/homebrew/bin:/usr/bin", None), "/opt/homebrew/bin:/usr/bin");
    }
}
