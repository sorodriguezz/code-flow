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
//!
//! **Why the answer is cached.** Asking costs a *login and interactive* shell, and a real one —
//! oh-my-zsh, nvm, pyenv, asdf, direnv — routinely takes 300ms to 1.5s to finish sourcing itself.
//! This runs as the very first statement of `run()`, before the database is opened and long before
//! a window exists, so every one of those milliseconds is spent with nothing at all on screen. That
//! is the worst place in the app to spend them.
//!
//! So the resolved value is written to a small file next to the database and adopted from there on
//! the next launch, in microseconds, while a background thread re-asks the shell and rewrites the
//! file for the launch after that. The cache is therefore always exactly one launch behind: install
//! a new tool and the first launch after it still runs on yesterday's `PATH`. That is acceptable
//! here and nowhere near as bad as it sounds — `PATH` gains directories far more often than it
//! loses them, `ai::install_dirs` covers the engines regardless, and the stale entry is corrected
//! before the user has finished noticing it.

#[cfg(not(target_os = "windows"))]
use std::time::Duration;

/// How long the shell gets before the app gives up *waiting on the main thread* for it.
///
/// Only the very first launch ever waits at all — after that there is a cache to start from — so
/// this is the price of a cold start and nothing else, which is what makes it much tighter than the
/// five seconds this used to be. A profile slower than this is not abandoned: the same shell is
/// left running on a background thread (see [`REFRESH_TIMEOUT`]) so its answer still lands in the
/// cache and the *second* launch is correct and instant.
#[cfg(not(target_os = "windows"))]
const COLD_TIMEOUT: Duration = Duration::from_millis(1500);

/// How long the shell gets when nobody is waiting for it.
///
/// Generous, because it costs the user nothing: this deadline is only ever waited on from a
/// background thread whose entire job is to rewrite the cache file. A profile that runs `nvm use`
/// or an asdf hook can genuinely take a second or two, and this is the path that lets it.
#[cfg(not(target_os = "windows"))]
const REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

/// Markers around the value, so what comes back can be found inside whatever else the shell said.
///
/// An interactive shell is not a quiet one: profiles print version banners, `motd` fragments,
/// direnv notices and job-control chatter, and any of it can land on stdout ahead of the answer.
/// Reading "the output" as the `PATH` would inherit all of that as a directory name. Reading
/// *between the markers* is immune to it, and to the shell that decides to print something after
/// the value as well.
#[cfg(not(target_os = "windows"))]
const OPEN: &str = "__CF_PATH_OPEN__";
#[cfg(not(target_os = "windows"))]
const CLOSE: &str = "__CF_PATH_CLOSE__";

/// Adopts the login shell's `PATH`, if it can be had.
///
/// Call once, early in startup, before any threads are spawned: this writes a process-wide
/// environment variable, and the reason `set_var` is a footgun at all is other threads reading it
/// concurrently. Everything downstream — [`crate::ai`]'s search dirs, `shell_profiles::which`, the
/// `git` and `ssh` invocations, the pty — then reads the widened value without knowing this
/// happened.
///
/// **That constraint survives the cache, and it is what shapes the design below.** This function
/// does spawn threads now, so the rule has to hold in a stronger form than "don't call me late":
/// *only the caller's thread ever writes the environment, and it always finishes writing it before
/// any thread is spawned.* The background threads here write the cache **file** and nothing else —
/// they never touch `PATH`. That is the whole reason a late answer is banked for the next launch
/// instead of being adopted the moment it arrives: adopting it would mean a `set_var` landing in a
/// process that is by then running a webview, a tokio runtime and a dozen of our own threads, which
/// is precisely the unsound thing this note has always been about. This launch uses what it had;
/// the next launch is the one that gets the correction.
///
/// Silent on every failure, and deliberately: the app worked before this existed and works after a
/// shell that won't answer. There is nothing here worth a dialog, and nothing the user could do
/// about it if there were.
#[cfg(not(target_os = "windows"))]
pub fn import_login_path() {
    let Some(shell) = std::env::var_os("SHELL").map(std::path::PathBuf::from) else {
        return;
    };

    // The warm path, which is every launch but the first. Adopt, then spawn — in that order, so the
    // one `set_var` in this process is over and done with while this is still the only thread.
    if let Some(cached) = read_cache() {
        adopt(&cached);
        std::thread::spawn(move || {
            let Some(rx) = probe(&shell) else { return };
            if let Some(fresh) = collect(&rx, REFRESH_TIMEOUT) {
                write_cache(&fresh);
            }
        });
        return;
    }

    // The cold path: first launch, or the first after a reset. There is nothing to start from, so
    // this is the one time the app waits — briefly — for a shell.
    let Some(rx) = probe(&shell) else { return };
    match collect(&rx, COLD_TIMEOUT) {
        Some(imported) => {
            adopt(&imported);
            write_cache(&imported);
        }
        // The shell is merely slow (or it failed, in which case the sender is already gone and this
        // thread ends immediately). Either way the receiver moves off the main thread, which keeps
        // the *same* shell invocation rather than starting a second one, and whatever it eventually
        // prints becomes the cache. This launch runs on the un-widened `PATH` exactly as it did
        // before any of this existed; the next one does not.
        None => {
            std::thread::spawn(move || {
                if let Some(late) = collect(&rx, REFRESH_TIMEOUT) {
                    write_cache(&late);
                }
            });
        }
    }
}

/// Merges an answer into the process `PATH`. Main thread only — see [`import_login_path`].
#[cfg(not(target_os = "windows"))]
fn adopt(imported: &str) {
    let merged = merge(imported, std::env::var("PATH").ok().as_deref());
    // `set_var` *panics* on a value containing a NUL byte, and the two things feeding this are a
    // shell's stdout and a file on disk — neither of which is ours to vouch for. A truncated write
    // or a filesystem that padded the tail is a strange enough state to walk away from, but it is
    // not one to take the whole launch down with.
    if merged.is_empty() || merged.contains('\0') {
        return;
    }
    std::env::set_var("PATH", merged);
}

/// The cache file: one line, the resolved `PATH`, next to the database.
///
/// A plain file rather than a row in the settings table, and deliberately. This whole module runs
/// before `db::init()` — it must, because everything downstream resolves programs against the `PATH`
/// it leaves behind — so reading the cache from the settings table would mean either opening the
/// database first or reordering `run()` around it. Neither is worth it for one string: a file costs
/// no connection, needs no schema and cannot deadlock against one.
///
/// It lives in `paths::base_dir()` so that "wipe everything" takes it with it, like the rest of the
/// app's state. `run()` does that wipe *before* calling in here, on purpose — see the comment there.
#[cfg(not(target_os = "windows"))]
fn cache_path() -> std::path::PathBuf {
    crate::paths::base_dir().join(".shell-path")
}

/// The cached `PATH`, or `None` if there isn't a usable one.
#[cfg(not(target_os = "windows"))]
fn read_cache() -> Option<String> {
    let cached = std::fs::read_to_string(cache_path()).ok()?;
    let cached = cached.trim();
    (!cached.is_empty()).then(|| cached.to_string())
}

/// Banks an answer for the next launch. Called from a background thread as often as not.
#[cfg(not(target_os = "windows"))]
fn write_cache(path: &str) {
    let target = cache_path();
    let Some(dir) = target.parent() else { return };
    // First launch writes this before `paths::ensure_dirs` has ever run.
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    // Written beside and renamed over, so the next launch reads either the old value or the new one
    // and never half of either. A `PATH` truncated mid-entry names a directory that does not exist,
    // which is the kind of failure that looks like the tool was uninstalled.
    let staging = target.with_extension("tmp");
    if std::fs::write(&staging, path).is_ok() && std::fs::rename(&staging, &target).is_err() {
        let _ = std::fs::remove_file(&staging);
    }
}

/// Windows has no equivalent problem to solve: `PATH` is machine and user state in the registry,
/// not something a shell startup file assembles, and a GUI process gets the same one a console
/// does. (An app left *running* across an installer that edits it keeps the stale copy, which is
/// real — and is what `ai::install_dirs` already covers.)
#[cfg(target_os = "windows")]
pub fn import_login_path() {}

/// Starts the shell and hands back the channel its output will arrive on.
///
/// Split from the waiting half ([`collect`]) so that the deadline is the *caller's* and can change
/// hands: the cold path waits [`COLD_TIMEOUT`] on the main thread and, if that runs out, passes this
/// same receiver to a background thread to go on waiting. One shell invocation, two deadlines —
/// rather than abandoning the first and paying for a second.
#[cfg(not(target_os = "windows"))]
fn probe(shell: &std::path::Path) -> Option<std::sync::mpsc::Receiver<Option<std::process::Output>>> {
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
    // Once every deadline has passed the thread and its child are abandoned rather than killed: the
    // handle lives on the other side of the channel, and a shell that is merely slow will finish and
    // exit on its own moments later. The cost of being wrong is one short-lived orphaned process,
    // once, against plumbing a kill through a second channel to reclaim it.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(command.output().ok());
    });
    Some(rx)
}

/// Waits out `timeout` for the shell started by [`probe`] and returns what was between the markers.
///
/// A receiver whose sender is already gone answers instantly with `Disconnected` rather than
/// sitting out the deadline, which is what makes it safe to call this a second time on a channel
/// that has already delivered — the "the shell answered, but with nothing usable" case.
#[cfg(not(target_os = "windows"))]
fn collect(
    rx: &std::sync::mpsc::Receiver<Option<std::process::Output>>,
    timeout: Duration,
) -> Option<String> {
    let output = rx.recv_timeout(timeout).ok()??;
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
#[cfg(not(target_os = "windows"))]
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
#[cfg(not(target_os = "windows"))]
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

#[cfg(all(test, not(target_os = "windows")))]
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
