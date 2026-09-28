//! An interactive shell on a remote host: `ssh` in a pty.
//!
//! There is deliberately almost nothing here. The session is registered in
//! [`crate::terminal::TerminalRegistry`], so every command that already drives a local terminal —
//! write, resize, close — drives this one too, and the xterm pane on the frontend is the same
//! component with a different session id. What this file owns is the argument list, and a small
//! record of what each session printed last, so a saved password is only ever typed into a prompt
//! that is asking for one.
//!
//! **Why a pty and not a piped process.** `ssh` decides whether to allocate a remote terminal by
//! looking at whether *it* has one. Without a pty there is no prompt, no `top`, no colour, no
//! password or passphrase question, and no `known_hosts` fingerprint confirmation — the last of
//! which would turn every first connection into a silent hang.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use tauri::AppHandle;

use super::{RemoteHostSpec, RemoteOs};
use crate::terminal::{self, TerminalRegistry};

/// Opens a shell on `spec` and returns the terminal session id.
///
/// `startup` is the body of the host's "run on connect" snippet, when it has one — resolved by the
/// command layer, which is the half that reads the database. `host_id` is `None` for a session on a
/// spec that was never saved, which therefore has no saved password to type.
pub fn open(
    app: AppHandle,
    registry: &TerminalRegistry,
    spec: &RemoteHostSpec,
    startup: Option<&str>,
    host_id: Option<&str>,
) -> Result<String, String> {
    spec.require_host()?;
    spec.require_shell()?;

    let watch = Arc::new(Watched { host_id: host_id.unwrap_or_default().to_string(), tail: Mutex::default() });
    // The id is only known once the pty exists; the exit hook needs it to forget the entry.
    let named: Arc<OnceLock<String>> = Arc::default();
    let hooks = terminal::PtyHooks {
        on_output: Some(Arc::new({
            let watch = watch.clone();
            move |_: u64, chunk: &str| watch.push(chunk)
        })),
        on_exit: Some(Box::new({
            let named = named.clone();
            move |_: Option<i32>| {
                if let Some(id) = named.get() {
                    if let Ok(mut map) = watched().lock() {
                        map.remove(id);
                    }
                }
            }
        })),
        ..Default::default()
    };

    // Not recorded: a transcript here would be a copy of somebody else's machine talking, kept in
    // this one's database. See `terminal::TerminalSession::transcript`. The tail above is not a
    // transcript — a few hundred characters in memory, gone with the session, never written anywhere.
    let id = terminal::open_pty(
        app,
        registry,
        "ssh",
        &args(spec, startup),
        None,
        None,
        // No owner, and that is load-bearing rather than a default: an owner is what lets a paired
        // phone write to a session, and this one is a live login on somebody else's server. The
        // Remote workspace is explicitly out of scope for the control surface (see
        // `remotectl::dispatch`), and an `ssh -t` reachable by id from a phone would be the whole
        // exclusion undone. A blank `cwd` because the local one says nothing about where this shell
        // actually is.
        terminal::Origin { cwd: String::new(), profile: "ssh".into(), owner: None },
        hooks,
    )
    .map_err(|e| explain(spec, e))?;

    let _ = named.set(id.clone());
    if let Ok(mut map) = watched().lock() {
        // A session that exited before this line ran has already had its exit hook fire; entries
        // for ids the registry no longer has are pruned here rather than left to accumulate.
        map.retain(|known, _| terminal::is_open(registry, known));
        map.insert(id.clone(), watch);
    }
    Ok(id)
}

/// The command line. Its own function so it can be asserted on without a host to connect to.
fn args(spec: &RemoteHostSpec, startup: Option<&str>) -> Vec<String> {
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

    if let Some(command) = remote_command(spec, startup) {
        args.push(command);
    }

    args
}

/// What to run on the far side, or `None` for a login shell.
///
/// A `directory` alone still produces a command, because `cd` has to happen somewhere — and it has
/// to be followed by a shell, or the session would end the instant the `cd` finished.
///
/// **A startup snippet runs first, and then the session carries on** into the login shell (or into
/// the saved `command`, when there is one). It used to be spliced in with its newlines turned into
/// `; `, which broke in three ways: `ssh` exits when its command does, so the promised prompt never
/// came; a first-line `# comment` commented out the entire snippet; and an `if … then` over several
/// lines, a `\` continuation or a heredoc stopped parsing. So the snippet now travels as a script
/// with its lines intact, in an encoding no remote shell's quoting can touch — see [`posix_command`]
/// and [`windows_command`].
///
/// **This is the one place the *remote* operating system changes the command line.** `cd '/srv' &&
/// exec $SHELL -l` is POSIX: against a Windows host — where OpenSSH's default shell is `cmd.exe` —
/// the single quotes don't quote, `$SHELL` doesn't exist and `exec` isn't a builtin, so the whole
/// thing fails with an error about a file it can't find. `spec.os` already records which end this
/// is, so it decides the form.
///
/// A Windows host whose `DefaultShell` has been set to PowerShell is not served by either branch;
/// that one wants the command field directly, which is why the field exists.
pub(crate) fn remote_command(spec: &RemoteHostSpec, startup: Option<&str>) -> Option<String> {
    let command = spec.command.trim();
    let directory = spec.directory.trim();
    let startup = startup.map(str::trim).filter(|script| !script.is_empty());
    if spec.os == RemoteOs::Windows {
        return windows_command(directory, startup, command, &nonce());
    }
    posix_command(directory, startup, command)
}

/// The POSIX form.
///
/// With a snippet, the command `ssh` carries is
///
/// ```text
/// eval "$(printf '\143\144\040…')"; exec $SHELL -l
/// ```
///
/// — the script with every byte written as a `printf` octal escape, evaluated by the login shell
/// `sshd` runs the command with, and then replaced by a login shell. Three properties decide it:
///
/// - **Nothing to quote.** The payload is backslashes and digits inside single quotes, so no byte
///   of the snippet — a quote, a `$`, a newline — reaches any shell's parser before `eval` sees the
///   whole script. Its lines, comments, `if`/`fi` blocks, continuations and heredocs are intact.
/// - **Nothing to install.** `printf` and `eval` are shell builtins everywhere; `base64 -d` is not
///   (BusyBox images, old macOS spelled it `-D`).
/// - **It runs in your shell, and what it sets survives.** Evaluated by the user's own login shell
///   rather than a separate `sh`, so bash syntax works where bash is the shell (`source` on Debian,
///   whose `sh` is dash), and the directory and the variables it exports carry into the `exec`ed
///   shell — which is what "activate this environment on connect" needs. Functions and unexported
///   variables do not; nothing that ends in a fresh shell could keep those.
///
/// The snippet failing does not end the session — the `;` still reaches the prompt, with the error
/// on screen. The `directory`'s `cd` does: it goes inside the script with `|| exit 1`, keeping the
/// rule that a `cd` which failed must not leave you in your home directory believing you are
/// somewhere else.
fn posix_command(directory: &str, startup: Option<&str>, command: &str) -> Option<String> {
    let Some(script) = startup else {
        if directory.is_empty() {
            return if command.is_empty() { None } else { Some(command.to_string()) };
        }
        // `&&` so a `cd` that failed ends the session rather than leaving the user in their home
        // directory believing they are somewhere else.
        let trailer = if command.is_empty() { "exec $SHELL -l" } else { command };
        return Some(format!("cd {} && {trailer}", posix_quote(directory)));
    };
    let mut body = String::new();
    if !directory.is_empty() {
        body.push_str(&format!("cd {} || exit 1\n", posix_quote(directory)));
    }
    // Carriage returns from a snippet written on Windows would end every line in a stray `\r`
    // that bash reports as "command not found".
    body.push_str(&script.replace("\r\n", "\n"));
    let trailer = if command.is_empty() { "exec $SHELL -l" } else { command };
    Some(format!("eval \"$(printf '{}')\"; {trailer}", printf_octal(&body)))
}

/// Every byte as a `printf` octal escape — `\143` for `c`. NUL is dropped: no shell can hold one in
/// a string, and a snippet has no business containing it.
fn printf_octal(text: &str) -> String {
    text.bytes().filter(|byte| *byte != 0).map(|byte| format!("\\{byte:03o}")).collect()
}

/// The Windows form: the snippet becomes a batch file, and `cmd` runs it in the session's own shell.
///
/// `cmd.exe` cannot take a multi-line script as an argument — its only statement separator is `&`,
/// which breaks every parenthesised block and turns a `::` comment on line one into a comment over
/// the whole joined line, the same failure as the POSIX `#`. A batch file *is* a multi-line script,
/// so the command first writes one to `%TEMP%` and then runs it with `cmd /k`, which is the prompt
/// the session would have opened anyway — and since it is the same `cmd`, the directory and the
/// variables the snippet sets are still set at that prompt. The file removes itself as its last
/// line.
///
/// Writing it is PowerShell's job, through `-EncodedCommand`: the only way to hand Windows a script
/// whose argument is pure base64, so nothing in the snippet can meet `cmd`'s quoting on the way.
/// Every Windows that ships an OpenSSH server ships PowerShell. The batch file is UTF-8 and switches
/// the console to it first when the snippet is not plain ASCII, or `cmd` would read its accents in
/// the OEM code page.
///
/// A saved `command` runs at the end of the batch instead of the prompt, and `/c` rather than `/k`
/// ends the session with it — which is what the command form without a snippet does too.
fn windows_command(directory: &str, startup: Option<&str>, command: &str, nonce: &str) -> Option<String> {
    let cd = if directory.is_empty() {
        String::new()
    } else {
        // `/d` so a path on another drive actually switches to it — without it `cd D:\x` from `C:`
        // changes D:'s working directory and leaves you on C:, silently.
        format!("cd /d {} && ", windows_quote(directory))
    };
    let Some(script) = startup else {
        if directory.is_empty() {
            return if command.is_empty() { None } else { Some(command.to_string()) };
        }
        let trailer = if command.is_empty() { "cmd" } else { command };
        return Some(format!("{cd}{trailer}"));
    };

    let file = format!("codeflow-startup-{nonce}.cmd");
    let mut batch = String::new();
    if !script.is_ascii() || !command.is_ascii() {
        batch.push_str("@chcp 65001 >nul\r\n");
    }
    for line in script.replace("\r\n", "\n").split('\n') {
        batch.push_str(line);
        batch.push_str("\r\n");
    }
    if !command.is_empty() {
        batch.push_str(command);
        batch.push_str("\r\n");
    }
    // `(goto)` ends the batch before `del` runs, so deleting the file it is reading does not print
    // "The batch file cannot be found." — the standard idiom for a batch file that removes itself.
    batch.push_str("@(goto) 2>nul & del \"%~f0\"\r\n");

    let write = format!(
        "[IO.File]::WriteAllBytes((Join-Path $env:TEMP '{file}'), [Convert]::FromBase64String('{}'))",
        base64::engine::general_purpose::STANDARD.encode(batch.as_bytes())
    );
    let encoded: Vec<u8> = write.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let keep = if command.is_empty() { "/k" } else { "/c" };
    Some(format!(
        "powershell -NoProfile -NonInteractive -EncodedCommand {} && {cd}cmd /d {keep} \"%TEMP%\\{file}\"",
        base64::engine::general_purpose::STANDARD.encode(encoded)
    ))
}

/// A name no two sessions share, for the Windows form's batch file.
fn nonce() -> String {
    let bytes: [u8; 6] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

// ---------------------------------------------------------------------------
// Typing the saved password
// ---------------------------------------------------------------------------

/// What [`type_password`] returns when the session is not at a password prompt. The frontend
/// matches it to ask "type it anyway?" — keep it identical to `NOT_ASKING` in
/// `src/lib/remote/transfers.ts`.
pub const NOT_ASKING: &str = "This session isn't asking for a password right now.";

/// How much of a session's output is kept to recognise a prompt by. A prompt is one line; this is
/// several, so a banner redrawn around it cannot push it out.
const TAIL: usize = 512;

/// A live session's host, and the end of what it printed.
struct Watched {
    host_id: String,
    tail: Mutex<String>,
}

impl Watched {
    fn push(&self, chunk: &str) {
        let Ok(mut tail) = self.tail.lock() else { return };
        tail.push_str(chunk);
        if tail.len() > TAIL * 2 {
            let mut cut = tail.len() - TAIL;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }

    fn tail(&self) -> String {
        self.tail.lock().map(|tail| tail.clone()).unwrap_or_default()
    }
}

fn watched() -> &'static Mutex<HashMap<String, Arc<Watched>>> {
    static WATCHED: OnceLock<Mutex<HashMap<String, Arc<Watched>>>> = OnceLock::new();
    WATCHED.get_or_init(Default::default)
}

/// Types this host's saved password into one of its sessions, followed by Enter.
///
/// **The password never leaves the backend.** It is read from the keychain here and written to the
/// pty here: it does not cross into the webview, it is not a keystroke xterm saw (so the command
/// history built from typed lines never records it), and remote sessions keep no transcript.
///
/// **And it is only typed into a prompt that asks for it.** At a shell prompt the same keystrokes
/// would run the password as a command — echoed on screen and saved in the far side's history — so
/// unless `force` is set, the session's last line has to read like a password prompt
/// ([`asks_for_password`]). `force` is the answer to the UI's "type it anyway?", for the prompt this
/// does not recognise.
pub fn type_password(registry: &TerminalRegistry, session_id: &str, host_id: &str, force: bool) -> Result<(), String> {
    let watch = watched()
        .lock()
        .map_err(|e| e.to_string())?
        .get(session_id)
        .cloned()
        .ok_or("That session has ended.")?;
    // The session's own host, whatever the caller said: a saved password goes to the machine it
    // was saved for and no other.
    if watch.host_id.is_empty() || watch.host_id != host_id {
        return Err("That session isn't one of this host's.".into());
    }
    if !force && !asks_for_password(&watch.tail()) {
        return Err(NOT_ASKING.into());
    }
    let password = crate::secrets::get_secret(&super::password_key(host_id))?
        .filter(|password| !password.is_empty())
        .ok_or("No password is saved for this host — add it in the host's settings.")?;
    terminal::write_terminal(registry, session_id, &format!("{password}\r"))?;
    // The prompt it answered is no longer the last thing on screen for this purpose — a second
    // click before the next output must not type it again into whatever comes next.
    if let Ok(mut tail) = watch.tail.lock() {
        tail.clear();
    }
    Ok(())
}

/// The words a password prompt is made of, in the languages a server's PAM is likely to speak.
/// Lower case; matched against the lower-cased last line.
const PROMPT_WORDS: &[&str] = &[
    "password", "passphrase", "contraseña", "contrasena", "clave", "passwort", "kennwort",
    "mot de passe", "senha", "wachtwoord", "parola", "hasło", "пароль", "密码", "密碼", "パスワード",
    "비밀번호", "암호",
];

/// Whether the end of a session's output is a prompt waiting for a password.
///
/// The last line, after stripping terminal escapes, has to end in a colon — every password prompt
/// does (`deploy@web-01's password:`, `[sudo] password for deploy:`, `Enter passphrase for key …:`)
/// — and name a password in one of [`PROMPT_WORDS`]. A one-time-code prompt (`Verification code:`)
/// names none and is left alone: a password is exactly the wrong answer to it.
pub(crate) fn asks_for_password(tail: &str) -> bool {
    let plain = strip_escapes(tail);
    let line = plain.rsplit(['\n', '\r']).next().unwrap_or_default().trim_end().to_lowercase();
    (line.ends_with(':') || line.ends_with('：')) && PROMPT_WORDS.iter().any(|word| line.contains(word))
}

/// The text of terminal output with its escape sequences taken out: CSI (`\x1b[…m`), OSC
/// (`\x1b]…\x07`, a window title) and the two-byte forms.
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                // Parameters and intermediates, then one final byte in `@`..=`~`.
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                // Up to BEL or the two-byte string terminator.
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
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

    /// Undoes [`printf_octal`], the way `printf` on the far side will.
    fn unescape(octal: &str) -> String {
        let bytes: Vec<u8> = octal
            .split('\\')
            .filter(|part| !part.is_empty())
            .map(|digits| u8::from_str_radix(digits, 8).unwrap())
            .collect();
        String::from_utf8(bytes).unwrap()
    }

    /// The script a POSIX startup command carries, decoded.
    fn carried(command: &str) -> (String, String) {
        let start = command.find("printf '").unwrap() + "printf '".len();
        let end = command[start..].find('\'').unwrap() + start;
        let trailer = command.split_once(")\"; ").unwrap().1.to_string();
        (unescape(&command[start..end]), trailer)
    }

    #[test]
    fn the_destination_is_last_when_there_is_no_remote_command() {
        assert_eq!(args(&spec(), None).last().unwrap(), "deploy@web-01");
    }

    #[test]
    fn a_remote_pty_is_always_forced() {
        assert!(args(&spec(), None).contains(&"-t".to_string()));
    }

    #[test]
    fn a_directory_becomes_a_cd_that_still_leaves_a_shell_behind() {
        let mut s = spec();
        s.directory = "/srv/app".into();
        assert_eq!(args(&s, None).last().unwrap(), "cd '/srv/app' && exec $SHELL -l");
    }

    #[test]
    fn a_directory_with_a_quote_in_it_cannot_break_out_of_the_cd() {
        let mut s = spec();
        s.directory = "/srv/it's".into();
        assert_eq!(args(&s, None).last().unwrap(), r"cd '/srv/it'\''s' && exec $SHELL -l");
    }

    #[test]
    fn a_windows_host_gets_a_cmd_line_cmd_can_actually_run() {
        let mut s = spec();
        s.os = RemoteOs::Windows;
        s.directory = r"D:\srv\app".into();
        assert_eq!(args(&s, None).last().unwrap(), r#"cd /d "D:\srv\app" && cmd"#);
    }

    #[test]
    fn a_windows_host_with_a_command_keeps_the_command() {
        let mut s = spec();
        s.os = RemoteOs::Windows;
        s.directory = r"C:\app".into();
        s.command = "npm run build".into();
        assert_eq!(args(&s, None).last().unwrap(), r#"cd /d "C:\app" && npm run build"#);
    }

    #[test]
    fn a_quote_cannot_close_the_windows_quoting_early() {
        let mut s = spec();
        s.os = RemoteOs::Windows;
        s.directory = "C:\\a\"&calc".into();
        let last = args(&s, None).last().unwrap().clone();
        assert!(!last.contains("\"&calc"), "{last}");
    }

    #[test]
    fn a_saved_command_is_passed_through_unquoted_so_it_stays_a_command() {
        let mut s = spec();
        s.command = "docker compose logs -f".into();
        assert_eq!(args(&s, None).last().unwrap(), "docker compose logs -f");
    }

    /// The bug: the snippet was the whole command, so `ssh` exited when it did and "run on connect"
    /// closed the session. Now it is followed by the login shell.
    #[test]
    fn a_startup_snippet_runs_and_then_the_session_carries_on_into_a_shell() {
        let command = remote_command(&spec(), Some("uptime")).unwrap();
        assert!(command.starts_with("eval \"$(printf '"), "{command}");
        let (script, trailer) = carried(&command);
        assert_eq!(script, "uptime");
        assert_eq!(trailer, "exec $SHELL -l");
    }

    /// The other half of the bug: joined with `; `, a first-line comment commented out everything,
    /// and multi-line constructs stopped parsing. The script now arrives exactly as written.
    #[test]
    fn a_snippet_keeps_its_lines_comments_blocks_and_heredocs() {
        let snippet = "# set up the box\nif [ -d .venv ]; then\n  . .venv/bin/activate\nfi\n\
                       echo one \\\n  two\ncat <<'EOF'\nit's $HOME\nEOF";
        let command = remote_command(&spec(), Some(snippet)).unwrap();
        let (script, _) = carried(&command);
        assert_eq!(script, snippet);
        // Nothing of the snippet is visible to the outer shell's parser: backslashes and digits.
        let payload = &command["eval \"$(printf '".len()..command.find("')\"").unwrap()];
        assert!(payload.chars().all(|c| c == '\\' || c.is_ascii_digit()), "{payload}");
    }

    #[test]
    fn a_snippet_runs_in_the_directory_and_a_failed_cd_ends_the_session() {
        let mut s = spec();
        s.directory = "/srv/it's".into();
        let (script, trailer) = carried(&remote_command(&s, Some("make")).unwrap());
        assert_eq!(script, "cd '/srv/it'\\''s' || exit 1\nmake");
        assert_eq!(trailer, "exec $SHELL -l");
    }

    #[test]
    fn a_snippet_with_a_saved_command_runs_the_command_instead_of_a_shell() {
        let mut s = spec();
        s.command = "docker compose logs -f".into();
        let (script, trailer) = carried(&remote_command(&s, Some("cd /srv\r\nexport A=1\r\n")).unwrap());
        assert_eq!(script, "cd /srv\nexport A=1", "CRLF from a Windows editor is normalised");
        assert_eq!(trailer, "docker compose logs -f");
    }

    #[test]
    fn a_blank_snippet_is_no_snippet() {
        assert_eq!(remote_command(&spec(), Some("  \n ")), None);
    }

    /// Unpacks the Windows form: the PowerShell that writes the batch file, and the file itself.
    fn windows_parts(command: &str) -> (String, String) {
        let engine = base64::engine::general_purpose::STANDARD;
        let encoded = command.split_whitespace().nth(4).unwrap();
        let utf16: Vec<u16> = engine
            .decode(encoded)
            .unwrap()
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let powershell = String::from_utf16(&utf16).unwrap();
        let inner = powershell.split("FromBase64String('").nth(1).unwrap().split('\'').next().unwrap();
        let batch = String::from_utf8(engine.decode(inner).unwrap()).unwrap();
        (powershell, batch)
    }

    #[test]
    fn a_windows_snippet_becomes_a_batch_file_run_by_the_sessions_own_cmd() {
        let command = windows_command(
            r"D:\app",
            Some("rem prepare\nif exist venv (\n  call venv\\Scripts\\activate.bat\n)"),
            "",
            "abc123",
        )
        .unwrap();
        assert!(command.starts_with("powershell -NoProfile -NonInteractive -EncodedCommand "), "{command}");
        assert!(
            command.ends_with(r#" && cd /d "D:\app" && cmd /d /k "%TEMP%\codeflow-startup-abc123.cmd""#),
            "{command}"
        );
        let (powershell, batch) = windows_parts(&command);
        assert!(powershell.contains("Join-Path $env:TEMP 'codeflow-startup-abc123.cmd'"), "{powershell}");
        assert_eq!(
            batch,
            "rem prepare\r\nif exist venv (\r\n  call venv\\Scripts\\activate.bat\r\n)\r\n\
             @(goto) 2>nul & del \"%~f0\"\r\n"
        );
    }

    #[test]
    fn a_windows_snippet_with_a_command_ends_with_it_and_accents_switch_to_utf8() {
        let command = windows_command("", Some("echo café"), "npm start", "n1").unwrap();
        assert!(command.ends_with(r#" && cmd /d /c "%TEMP%\codeflow-startup-n1.cmd""#), "{command}");
        let (_, batch) = windows_parts(&command);
        assert!(batch.starts_with("@chcp 65001 >nul\r\necho café\r\nnpm start\r\n"), "{batch}");
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
        let args = args(&s, None);
        assert!(args.contains(&"127.0.0.1:5432:db.internal:5432".to_string()));
        assert!(!args.iter().any(|a| a.contains("6379")));
    }

    #[test]
    fn a_password_prompt_is_recognised_and_a_shell_prompt_is_not() {
        for prompt in [
            "deploy@web-01's password: ",
            "(deploy@web-01) Password:",
            "[sudo] password for deploy: ",
            "Enter passphrase for key '/home/deploy/.ssh/id_ed25519': ",
            "Last login: Mon\r\n\x1b[1mContraseña:\x1b[0m ",
        ] {
            assert!(asks_for_password(prompt), "{prompt:?}");
        }
        for not in [
            "deploy@web-01:~$ ",
            "Verification code: ",
            "Password: \r\nLast login: today\r\n$ ",
            "password saved to vault\r\n",
            "",
        ] {
            assert!(!asks_for_password(not), "{not:?}");
        }
    }

    #[test]
    fn escapes_are_stripped_before_a_prompt_is_read() {
        assert_eq!(strip_escapes("\x1b]0;title\x07\x1b[32mok\x1b[0m"), "ok");
        assert_eq!(strip_escapes("a\x1b]2;t\x1b\\b"), "ab");
    }

    #[test]
    fn the_tail_keeps_the_end_of_the_output_and_whole_characters() {
        let watch = Watched { host_id: "h".into(), tail: Mutex::default() };
        for _ in 0..200 {
            watch.push("ñandú ");
        }
        watch.push("password:");
        let tail = watch.tail();
        assert!(tail.len() <= TAIL * 2);
        assert!(tail.ends_with("password:"));
    }
}
