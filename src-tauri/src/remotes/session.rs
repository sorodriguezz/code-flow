//! An interactive shell on a remote host: `ssh` in a pty.
//!
//! There is deliberately almost nothing here. The session is registered in
//! [`crate::terminal::TerminalRegistry`], so every command that already drives a local terminal —
//! write, resize, close — drives this one too, and the xterm pane on the frontend is the same
//! component with a different session id. What this file owns is only the argument list.
//!
//! **Why a pty and not a piped process.** `ssh` decides whether to allocate a remote terminal by
//! looking at whether *it* has one. Without a pty there is no prompt, no `top`, no colour, no
//! password or passphrase question, and no `known_hosts` fingerprint confirmation — the last of
//! which would turn every first connection into a silent hang.

use tauri::AppHandle;

use super::{RemoteHostSpec, RemoteOs};
use crate::terminal::{self, TerminalRegistry};

/// Opens a shell on `spec` and returns the terminal session id.
pub fn open(
    app: AppHandle,
    registry: &TerminalRegistry,
    spec: &RemoteHostSpec,
) -> Result<String, String> {
    spec.require_host()?;
    spec.require_shell()?;
    // Not recorded: a transcript here would be a copy of somebody else's machine talking, kept in
    // this one's database. See `terminal::TerminalSession::transcript`.
    terminal::open_pty(
        app,
        registry,
        "ssh",
        &args(spec),
        None,
        None,
        // No owner, and that is load-bearing rather than a default: an owner is what lets a paired
        // phone write to a session, and this one is a live login on somebody else's server. The
        // Remote workspace is explicitly out of scope for the control surface (see
        // `remotectl::dispatch`), and an `ssh -t` reachable by id from a phone would be the whole
        // exclusion undone. A blank `cwd` because the local one says nothing about where this shell
        // actually is.
        terminal::Origin { cwd: String::new(), profile: "ssh".into(), owner: None },
    )
    .map_err(|e| explain(spec, e))
}

/// The command line. Its own function so it can be asserted on without a host to connect to.
fn args(spec: &RemoteHostSpec) -> Vec<String> {
    let mut args = spec.base_args(true);

    // Force a remote pty. `ssh` allocates one by default for an interactive login, but *not* when a
    // command follows the destination — and a saved `command` or `directory` is exactly that. `-t`
    // makes the two cases behave the same, which is the difference between a working `sudo`/`vim`
    // over a saved command and a hang with no echo.
    args.push("-t".into());

    // Every forward the host has marked `auto`, raised as part of the session rather than as
    // separate processes. They then live and die with the terminal, which is what a user who wrote
    // "auto" meant: the tunnel is a property of being connected to this host, not a thing to
    // remember to close.
    for forward in spec.forwards.iter().filter(|f| f.auto) {
        args.extend(super::forward::flag(forward));
    }

    args.push(spec.destination());

    if let Some(command) = remote_command(spec) {
        args.push(command);
    }

    args
}

/// What to run on the far side, or `None` for a login shell.
///
/// A `directory` alone still produces a command, because `cd` has to happen somewhere — and it has
/// to be followed by a shell, or the session would end the instant the `cd` finished.
///
/// **This is the one place the *remote* operating system changes the command line.** `cd '/srv' &&
/// exec $SHELL -l` is POSIX: against a Windows host — where OpenSSH's default shell is `cmd.exe` —
/// the single quotes don't quote, `$SHELL` doesn't exist and `exec` isn't a builtin, so the whole
/// thing fails with an error about a file it can't find. `spec.os` already records which end this
/// is, so it decides the form.
///
/// A Windows host whose `DefaultShell` has been set to PowerShell is not served by either branch;
/// that one wants the command field directly, which is why the field exists.
fn remote_command(spec: &RemoteHostSpec) -> Option<String> {
    let command = spec.command.trim();
    let directory = spec.directory.trim();
    if directory.is_empty() {
        return if command.is_empty() { None } else { Some(command.to_string()) };
    }
    // `&&` in both dialects, and for the same reason: a `cd` that failed must not leave the user in
    // their home directory believing they are somewhere else.
    if spec.os == RemoteOs::Windows {
        // `/d` so a path on another drive actually switches to it — without it `cd D:\x` from `C:`
        // changes D:'s working directory and leaves you on C:, silently.
        let trailer = if command.is_empty() { "cmd" } else { command };
        return Some(format!("cd /d {} && {trailer}", windows_quote(directory)));
    }
    let trailer = if command.is_empty() { "exec $SHELL -l" } else { command };
    Some(format!("cd {} && {trailer}", posix_quote(directory)))
}

/// Single-quotes a path for a POSIX remote shell.
///
/// Only ever applied to the directory, never to `command` — a saved command is a command, and
/// quoting it would turn `docker compose logs -f` into an attempt to run a program with that
/// entire string as its name.
fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Double-quotes a path for `cmd.exe`, which has no single-quote quoting at all.
///
/// A `"` inside a Windows path is not legal, so there is nothing to escape — it is stripped rather
/// than escaped, because leaving it would end the quoted string early and hand the rest to `cmd`
/// as a command.
fn windows_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', ""))
}

/// A failure to *spawn* — the binary missing, chiefly. Anything `ssh` itself objects to arrives in
/// the pty where the user can read it, which is where it belongs.
fn explain(spec: &RemoteHostSpec, error: String) -> String {
    if error.contains("No such file") || error.contains("not found") || error.contains("cannot find") {
        return super::explain_missing_ssh(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            error,
        ));
    }
    format!("Couldn't open a session on {}: {error}", spec.destination())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remotes::{ForwardKind, ForwardSpec};

    fn spec() -> RemoteHostSpec {
        RemoteHostSpec {
            host: "web-01".into(),
            user: "deploy".into(),
            ..Default::default()
        }
    }

    #[test]
    fn the_destination_is_last_when_there_is_no_remote_command() {
        assert_eq!(args(&spec()).last().unwrap(), "deploy@web-01");
    }

    #[test]
    fn a_remote_pty_is_always_forced() {
        assert!(args(&spec()).contains(&"-t".to_string()));
    }

    #[test]
    fn a_directory_becomes_a_cd_that_still_leaves_a_shell_behind() {
        let mut s = spec();
        s.directory = "/srv/app".into();
        assert_eq!(args(&s).last().unwrap(), "cd '/srv/app' && exec $SHELL -l");
    }

    #[test]
    fn a_directory_with_a_quote_in_it_cannot_break_out_of_the_cd() {
        let mut s = spec();
        s.directory = "/srv/it's".into();
        assert_eq!(args(&s).last().unwrap(), r"cd '/srv/it'\''s' && exec $SHELL -l");
    }

    #[test]
    fn a_windows_host_gets_a_cmd_line_cmd_can_actually_run() {
        let mut s = spec();
        s.os = RemoteOs::Windows;
        s.directory = r"D:\srv\app".into();
        assert_eq!(args(&s).last().unwrap(), r#"cd /d "D:\srv\app" && cmd"#);
    }

    #[test]
    fn a_windows_host_with_a_command_keeps_the_command() {
        let mut s = spec();
        s.os = RemoteOs::Windows;
        s.directory = r"C:\app".into();
        s.command = "npm run build".into();
        assert_eq!(args(&s).last().unwrap(), r#"cd /d "C:\app" && npm run build"#);
    }

    #[test]
    fn a_quote_cannot_close_the_windows_quoting_early() {
        let mut s = spec();
        s.os = RemoteOs::Windows;
        s.directory = "C:\\a\"&calc".into();
        let last = args(&s).last().unwrap().clone();
        assert!(!last.contains("\"&calc"), "{last}");
    }

    #[test]
    fn a_saved_command_is_passed_through_unquoted_so_it_stays_a_command() {
        let mut s = spec();
        s.command = "docker compose logs -f".into();
        assert_eq!(args(&s).last().unwrap(), "docker compose logs -f");
    }

    #[test]
    fn only_auto_forwards_ride_along_with_the_session() {
        let mut s = spec();
        s.forwards = vec![
            ForwardSpec {
                id: "a".into(),
                kind: ForwardKind::Local,
                listen_port: 5432,
                target_host: "db.internal".into(),
                target_port: 5432,
                auto: true,
                label: String::new(),
            },
            ForwardSpec {
                id: "b".into(),
                kind: ForwardKind::Local,
                listen_port: 6379,
                target_host: "cache.internal".into(),
                target_port: 6379,
                auto: false,
                label: String::new(),
            },
        ];
        let args = args(&s);
        assert!(args.contains(&"127.0.0.1:5432:db.internal:5432".to_string()));
        assert!(!args.iter().any(|a| a.contains("6379")));
    }
}
