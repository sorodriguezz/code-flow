//! Shell integration: the escape sequences that tell the terminal pane where a prompt starts, which
//! command ran, how it ended and which folder the shell is in.
//!
//! A shell knows all four of those things and says none of them. The pane only sees bytes, so
//! without help it cannot tell a prompt from output, cannot mark a failed command, and has no idea
//! the user typed `cd` — which is why a new tab used to open in the folder the *first* one started
//! in. The fix every modern terminal uses (VS Code, iTerm, WezTerm, Windows Terminal) is a small
//! script run inside the shell that prints OSC sequences at the right moments, and this module is
//! CodeFlow's version of it.
//!
//! ## The wire protocol
//!
//! Every sequence is `ESC ]` … `BEL`. The pane parses exactly these and draws none of them:
//!
//! | sequence                         | when                                                       |
//! |----------------------------------|------------------------------------------------------------|
//! | `133;A`                          | right before every prompt is drawn                         |
//! | `633;E;<base64 of UTF-8 line>`   | optional, right before `C`: the command line about to run   |
//! | `133;C`                          | the command's output starts                                |
//! | `133;D;<exit code>`              | a command finished — only when one really ran              |
//! | `7;file://<host><absolute path>` | the working directory, every prompt                         |
//!
//! Per prompt the order is `D` (when a command ran) → `7` → `A`. Paths percent-encode `%`, space,
//! `#` and `?`; a Windows path is `file:///C:/Users/x` — empty host, forward slashes, drive letter.
//!
//! ## How the script gets in — without touching a dotfile
//!
//! The user's startup files are never edited. Each shell is instead *launched* so that it reads
//! CodeFlow's script, and that script reads the user's own files back, the way VS Code does it:
//!
//! * **zsh** — `ZDOTDIR` points at our folder, whose `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin` each
//!   source the user's file of the same name (with `ZDOTDIR` set back to theirs while it runs), add
//!   the hooks after `.zshrc`, and finally restore `ZDOTDIR` so a nested `zsh` starts normally.
//! * **bash** (Git Bash too) — `--init-file <script> -i`. `--init-file` and `--login` cannot be
//!   combined, so a login profile becomes `CODEFLOW_SHELL_LOGIN=1` and the script reads
//!   `/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile` itself.
//! * **fish** — `--init-command 'source <script>'`, which runs after `config.fish`.
//! * **PowerShell** — `-NoExit -Command` reading the script into a script block, which wraps the
//!   profile's `prompt` and PSReadLine's `PSConsoleHostReadLine`.
//!
//! Anything else — cmd, sh, WSL, nu, a custom profile with arguments this module does not know —
//! launches exactly as configured. Rewriting a command line it does not understand is how a terminal
//! stops opening at all, which is a far worse outcome than a terminal without marks.
//!
//! Only shells opened at the desk get it (`owner == None`); a phone's session is left alone, since
//! nothing on that side reads the marks. The `terminal_shell_integration` setting turns it off.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::db::{queries, Db};

/// `"0"` turns integration off for terminals opened from then on; anything else, or no row, is on.
pub const SETTING_KEY: &str = "terminal_shell_integration";

/// Set in every shell that was given the integration, so a user's own config (or a tool) can tell.
const MARKER_VAR: &str = "CODEFLOW_SHELL_INTEGRATION";
const USER_ZDOTDIR_VAR: &str = "CODEFLOW_USER_ZDOTDIR";
const ZDOTDIR_UNSET_VAR: &str = "CODEFLOW_ZDOTDIR_UNSET";
const LOGIN_VAR: &str = "CODEFLOW_SHELL_LOGIN";

/// Variables only this module may set, struck from every terminal's inherited environment first.
///
/// CodeFlow started from one of its own terminals — `pnpm tauri dev` typed into the dock is the
/// everyday case — inherits `CODEFLOW_SHELL_INTEGRATION=1`, and would otherwise hand it on to every
/// shell it opens, integrated or not.
pub const INTERNAL_VARS: &[&str] = &[MARKER_VAR, USER_ZDOTDIR_VAR, ZDOTDIR_UNSET_VAR, LOGIN_VAR];

/// The scripts, compiled into the binary and written out at run time — a shell can only source a
/// file. Paths are relative to [`dir`]; zsh's four must keep their dotted names, because zsh looks
/// them up by name in `ZDOTDIR`.
const SCRIPTS: &[(&str, &str)] = &[
    ("zsh/.zshenv", include_str!("shell_integration/zshenv.zsh")),
    ("zsh/.zprofile", include_str!("shell_integration/zprofile.zsh")),
    ("zsh/.zshrc", include_str!("shell_integration/zshrc.zsh")),
    ("zsh/.zlogin", include_str!("shell_integration/zlogin.zsh")),
    ("bash/codeflow.bash", include_str!("shell_integration/bash.sh")),
    ("fish/codeflow.fish", include_str!("shell_integration/fish.fish")),
    ("pwsh/codeflow.ps1", include_str!("shell_integration/pwsh.ps1")),
];

/// The arguments a profile may carry and still be integrated. Every built-in profile's arguments are
/// in here; a custom profile with anything else (`-c …`, `--rcfile`, `-NoProfile`) is launched as
/// written, because rewriting a command line around flags it does not understand is a guess.
const KNOWN_ARGS: &[&str] = &["-l", "--login", "-i", "-NoLogo", "-nologo"];

/// Where the scripts live: the cache root, since everything in it is rewritten from the binary on
/// the next terminal anyway — purging it costs nothing.
pub fn dir() -> PathBuf {
    crate::paths::cache_dir().join("shell-integration")
}

/// Whether a desk terminal opened now should be integrated. On unless the setting says `"0"`; an
/// unreadable database answers "on", the default.
pub fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(db) = app.try_state::<Db>() else { return true };
    let Ok(conn) = db.0.lock() else { return true };
    !matches!(queries::get_setting(&conn, SETTING_KEY), Ok(Some(value)) if value.trim() == "0")
}

/// Writes every script under `root`, each only when its content differs from what is already
/// there — a terminal opened a hundred times rewrites nothing.
///
/// Through a temporary file and a rename, so a second terminal opening at the same moment never
/// sources a half-written script.
///
/// Line endings are forced to LF on the way out. A Windows checkout with `core.autocrlf` hands
/// `include_str!` CRLF files, and bash reads `fi\r` as a command that does not exist.
pub fn install(root: &Path) -> std::io::Result<()> {
    for (rel, body) in SCRIPTS {
        let body = body.replace("\r\n", "\n");
        let path = root.join(rel);
        if std::fs::read(&path).map(|existing| existing == body.as_bytes()).unwrap_or(false) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&tmp, &body)?;
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            // Lost a race to an identical writer (Windows refuses to replace a file another
            // process has open): fine, as long as what is there now is what we meant to write.
            if std::fs::read(&path).map(|existing| existing == body.as_bytes()).unwrap_or(false) {
                continue;
            }
            return Err(e);
        }
    }
    Ok(())
}

/// A shell's launch after integration: what to run, with what, and what to add to its environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shell {
    Zsh,
    Bash,
    Fish,
    Pwsh,
}

/// Which shell a command is, by its file name alone: `/bin/zsh`, `C:\…\bash.exe`, `pwsh`. Split on
/// both separators by hand rather than through `Path`, so a Windows path reads the same when the
/// tests run on a Mac.
fn shell_of(command: &str) -> Option<Shell> {
    let name = command.trim().rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    match stem {
        "zsh" => Some(Shell::Zsh),
        "bash" => Some(Shell::Bash),
        "fish" => Some(Shell::Fish),
        "pwsh" | "powershell" => Some(Shell::Pwsh),
        _ => None,
    }
}

/// A path as the shells want it on every platform: forward slashes. Git Bash reads `C:/Users/…`
/// natively and chokes on backslashes, and PowerShell and fish accept either.
fn slashed(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The integrated launch for `command args`, or `None` to launch it as configured.
///
/// Pure — no file is read or written — so every shell's rewrite is testable on any machine.
/// `root` is [`dir`]; `user_zdotdir` is the `ZDOTDIR` the shell would otherwise have started with
/// (the profile's, else this process's), `home` the user's home folder.
pub fn rewrite(
    command: &str,
    args: &[String],
    root: &Path,
    user_zdotdir: Option<&str>,
    home: Option<&str>,
) -> Option<Launch> {
    let shell = shell_of(command)?;
    if !args.iter().all(|a| KNOWN_ARGS.contains(&a.as_str())) {
        return None;
    }
    let mut env = vec![(MARKER_VAR.to_string(), "1".to_string())];
    let program = command.to_string();
    let args = match shell {
        Shell::Zsh => {
            let ours = root.join("zsh");
            // A ZDOTDIR that is already ours was inherited from a CodeFlow shell mid-startup;
            // treating it as the user's would make every file source itself.
            let user = user_zdotdir
                .filter(|z| !z.trim().is_empty() && Path::new(z) != ours.as_path())
                .map(str::to_string);
            let was_unset = user.is_none();
            let user = user.or_else(|| home.filter(|h| !h.trim().is_empty()).map(str::to_string))?;
            env.push(("ZDOTDIR".to_string(), ours.to_string_lossy().into_owned()));
            env.push((USER_ZDOTDIR_VAR.to_string(), user));
            if was_unset {
                env.push((ZDOTDIR_UNSET_VAR.to_string(), "1".to_string()));
            }
            args.to_vec()
        }
        Shell::Bash => {
            if args.iter().any(|a| a == "-l" || a == "--login") {
                env.push((LOGIN_VAR.to_string(), "1".to_string()));
            }
            // Long options first: bash stops reading them at the first single-letter one.
            vec!["--init-file".to_string(), slashed(&root.join("bash").join("codeflow.bash")), "-i".to_string()]
        }
        Shell::Fish => {
            // Inside fish single quotes only `\` and `'` are special.
            let path = slashed(&root.join("fish").join("codeflow.fish")).replace('\\', "\\\\").replace('\'', "\\'");
            let mut out = args.to_vec();
            out.push("--init-command".to_string());
            out.push(format!("source '{path}'"));
            out
        }
        Shell::Pwsh => {
            // Read into a script block rather than dot-sourced as a file: execution policy governs
            // script *files*, and Windows PowerShell's default of Restricted would otherwise greet
            // every terminal with a red error. The try/catch keeps any surprise silent. Inside
            // PowerShell single quotes the only escape is a doubled quote.
            let path = root.join("pwsh").join("codeflow.ps1").to_string_lossy().replace('\'', "''");
            let mut out = args.to_vec();
            out.push("-NoExit".to_string());
            out.push("-Command".to_string());
            out.push(format!("try {{ . ([ScriptBlock]::Create([IO.File]::ReadAllText('{path}'))) }} catch {{}}"));
            out
        }
    };
    Some(Launch { program, args, env })
}

/// [`rewrite`] for a real launch: the scripts written out first, and `None` — launch unmodified —
/// when they cannot be. A read-only cache folder is a reason for a terminal without marks, never for
/// a terminal that does not open.
///
/// `profile_env` is consulted for `ZDOTDIR` before this process's environment, since it is what the
/// shell will actually start with.
pub fn prepare(command: &str, args: &[String], profile_env: &[(String, String)]) -> Option<Launch> {
    shell_of(command)?;
    let root = dir();
    if let Err(e) = install(&root) {
        crate::applog::warn(&format!("terminal: shell integration scripts not written to {}: {e}", root.display()));
        return None;
    }
    let zdotdir = profile_env
        .iter()
        .rev()
        .find(|(k, _)| k == "ZDOTDIR")
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var("ZDOTDIR").ok());
    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
    rewrite(command, args, &root, zdotdir.as_deref(), home.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    fn env_of<'a>(launch: &'a Launch, key: &str) -> Option<&'a str> {
        launch.env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn root() -> PathBuf {
        PathBuf::from("/cache/CodeFlow/shell-integration")
    }

    #[test]
    fn shells_are_recognised_by_file_stem() {
        assert_eq!(shell_of("/bin/zsh"), Some(Shell::Zsh));
        assert_eq!(shell_of(r"C:\Program Files\Git\bin\bash.exe"), Some(Shell::Bash));
        assert_eq!(shell_of(r"C:\Program Files\PowerShell\7\PWSH.EXE"), Some(Shell::Pwsh));
        assert_eq!(shell_of("powershell.exe"), Some(Shell::Pwsh));
        assert_eq!(shell_of("/opt/homebrew/bin/fish"), Some(Shell::Fish));
        assert_eq!(shell_of("cmd.exe"), None);
        assert_eq!(shell_of("/bin/sh"), None);
        assert_eq!(shell_of(r"C:\Windows\System32\wsl.exe"), None);
        assert_eq!(shell_of("nu"), None);
    }

    /// zsh keeps its arguments and gets everything through the environment: our ZDOTDIR, and the
    /// user's — HOME, flagged as "was unset", when they had none.
    #[test]
    fn zsh_moves_zdotdir_and_remembers_the_users() {
        let launch = rewrite("/bin/zsh", &s(&["-l"]), &root(), None, Some("/Users/me")).unwrap();
        assert_eq!(launch.program, "/bin/zsh");
        assert_eq!(launch.args, s(&["-l"]));
        assert_eq!(env_of(&launch, "ZDOTDIR"), Some(root().join("zsh").to_str().unwrap()));
        assert_eq!(env_of(&launch, USER_ZDOTDIR_VAR), Some("/Users/me"));
        assert_eq!(env_of(&launch, ZDOTDIR_UNSET_VAR), Some("1"));
        assert_eq!(env_of(&launch, MARKER_VAR), Some("1"));

        let custom = rewrite("/bin/zsh", &s(&["-l"]), &root(), Some("/Users/me/.config/zsh"), Some("/Users/me")).unwrap();
        assert_eq!(env_of(&custom, USER_ZDOTDIR_VAR), Some("/Users/me/.config/zsh"));
        assert_eq!(env_of(&custom, ZDOTDIR_UNSET_VAR), None);
    }

    /// An inherited ZDOTDIR that is already ours is not the user's — it would source itself.
    #[test]
    fn zsh_ignores_a_zdotdir_that_is_already_ours() {
        let ours = root().join("zsh");
        let launch = rewrite("zsh", &[], &root(), ours.to_str(), Some("/home/me")).unwrap();
        assert_eq!(env_of(&launch, USER_ZDOTDIR_VAR), Some("/home/me"));
        assert_eq!(env_of(&launch, ZDOTDIR_UNSET_VAR), Some("1"));
    }

    #[test]
    fn zsh_without_any_home_is_left_alone() {
        assert_eq!(rewrite("zsh", &[], &root(), None, None), None);
    }

    /// `--login` cannot ride along with `--init-file`; it becomes a variable the script reads.
    #[test]
    fn bash_trades_login_for_an_init_file() {
        let launch = rewrite("/bin/bash", &s(&["-l"]), &root(), None, None).unwrap();
        assert_eq!(
            launch.args,
            s(&["--init-file", "/cache/CodeFlow/shell-integration/bash/codeflow.bash", "-i"])
        );
        assert_eq!(env_of(&launch, LOGIN_VAR), Some("1"));

        let git_bash = rewrite(
            r"C:\Program Files\Git\bin\bash.exe",
            &s(&["--login", "-i"]),
            Path::new(r"C:\Users\Jane Doe\AppData\Local\CodeFlow\cache\shell-integration"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(git_bash.program, r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(git_bash.args[1].replace('\\', "/"), git_bash.args[1], "Git Bash wants forward slashes");
        assert!(git_bash.args[1].starts_with("C:/Users/Jane Doe/"));
        assert_eq!(env_of(&git_bash, LOGIN_VAR), Some("1"));

        let plain = rewrite("bash", &[], &root(), None, None).unwrap();
        assert_eq!(env_of(&plain, LOGIN_VAR), None);
    }

    #[test]
    fn fish_keeps_its_login_flag_and_sources_the_script() {
        let launch = rewrite("/usr/bin/fish", &s(&["-l"]), Path::new("/c/it's here"), None, None).unwrap();
        assert_eq!(launch.args, s(&["-l", "--init-command", r"source '/c/it\'s here/fish/codeflow.fish'"]));
    }

    #[test]
    fn powershell_appends_a_command_that_reads_the_script() {
        let launch = rewrite(
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            &s(&["-NoLogo"]),
            Path::new("/Users/o'neil/cache"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(launch.args[..3], s(&["-NoLogo", "-NoExit", "-Command"])[..]);
        assert!(launch.args[3].contains("ReadAllText('/Users/o''neil/cache"), "{}", launch.args[3]);
        assert!(launch.args[3].contains("codeflow.ps1')"), "{}", launch.args[3]);
        assert!(launch.args[3].starts_with("try {") && launch.args[3].ends_with("catch {}"));
        assert!(rewrite("powershell.exe", &s(&["-nologo"]), &root(), None, None).is_some());
    }

    /// Anything outside the known shells, or with arguments this module does not understand,
    /// launches exactly as written.
    #[test]
    fn unknown_shells_and_arguments_are_untouched() {
        assert_eq!(rewrite("cmd.exe", &[], &root(), None, None), None);
        assert_eq!(rewrite("/bin/sh", &s(&["-l"]), &root(), None, None), None);
        assert_eq!(rewrite("wsl.exe", &s(&["-d", "Ubuntu"]), &root(), None, None), None);
        assert_eq!(rewrite("/bin/bash", &s(&["--rcfile", "/x"]), &root(), None, None), None);
        assert_eq!(rewrite("pwsh", &s(&["-NoProfile"]), &root(), None, None), None);
        assert_eq!(rewrite("/bin/zsh", &s(&["-c", "echo"]), &root(), None, Some("/h")), None);
    }

    /// The scripts reach disk, and a second install over identical files is a no-op.
    #[test]
    fn install_writes_each_script_once() {
        let tmp = std::env::temp_dir().join(format!("cf-shell-integration-{}", uuid::Uuid::new_v4()));
        install(&tmp).unwrap();
        for (rel, body) in SCRIPTS {
            assert_eq!(std::fs::read_to_string(tmp.join(rel)).unwrap(), body.replace("\r\n", "\n"));
        }
        let zshrc = tmp.join("zsh/.zshrc");
        let before = std::fs::metadata(&zshrc).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        install(&tmp).unwrap();
        assert_eq!(std::fs::metadata(&zshrc).unwrap().modified().unwrap(), before);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The scripts print only escape sequences — no stray `echo` — and use no byte that turns a
    /// file binary (see the escape-control-bytes rule: `\033`, never a raw ESC).
    #[test]
    fn scripts_carry_no_raw_control_bytes() {
        for (rel, body) in SCRIPTS {
            assert!(
                !body.bytes().any(|b| b < 0x20 && b != b'\n' && b != b'\t' && b != b'\r'),
                "{rel} contains a raw control byte"
            );
        }
    }

    /// The real thing, on the shells this machine has: start each integrated shell in a pty, run a
    /// command that fails with 3, and read the marks back in order. Skipped where a shell is
    /// missing; zsh and bash are present on every Mac and most Linux boxes.
    #[cfg(unix)]
    #[test]
    fn live_shells_emit_the_marks_in_order() {
        let tmp = std::env::temp_dir().join(format!("cf-shell-integration-live-{}", uuid::Uuid::new_v4()));
        install(&tmp).unwrap();
        let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
        for (shell, args) in [("/bin/zsh", vec!["-l"]), ("/bin/bash", vec!["-l"]), ("/bin/zsh", vec![])] {
            if !Path::new(shell).is_file() {
                continue;
            }
            let launch = rewrite(shell, &s(&args), &tmp, None, home.as_deref()).unwrap();
            let out = run_in_pty(&launch, "echo hi; (exit 3)\r");
            let marks: Vec<&str> = out
                .split("\x1b]")
                .skip(1)
                .filter_map(|chunk| chunk.split('\x07').next())
                .filter(|m| m.starts_with("133;") || m.starts_with("7;") || m.starts_with("633;"))
                .collect();
            let first_a = marks.iter().position(|m| *m == "133;A").expect("no prompt mark");
            assert!(marks[first_a - 1].starts_with("7;file://"), "{shell}: cwd before A: {marks:?}");
            assert!(!marks[..first_a].iter().any(|m| m.starts_with("133;D")), "{shell}: D before the first prompt");
            // bash 3.2 (/bin/bash on macOS) has no PS0, so no C, E or D — only the prompt marks.
            if out.contains("\x1b]133;C") {
                let tail = &marks[first_a + 1..];
                let e = tail.iter().position(|m| m.starts_with("633;E;")).expect("no E");
                assert_eq!(tail[e + 1], "133;C", "{shell}: {marks:?}");
                assert_eq!(tail[e + 2], "133;D;3", "{shell}: {marks:?}");
                assert!(tail[e + 3].starts_with("7;file://"), "{shell}: {marks:?}");
                assert_eq!(tail[e + 4], "133;A", "{shell}: {marks:?}");
                use base64::Engine;
                let line = base64::engine::general_purpose::STANDARD.decode(&tail[e]["633;E;".len()..]).unwrap();
                assert_eq!(String::from_utf8(line).unwrap(), "echo hi; (exit 3)");
            } else {
                assert_eq!(shell, "/bin/bash", "{shell} printed no C mark: {marks:?}");
                assert!(marks[first_a + 1..].iter().any(|m| *m == "133;A"), "{shell}: no second prompt");
            }
            assert!(out.contains("hi"), "{shell}: command did not run: {out:?}");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    fn run_in_pty(launch: &Launch, input: &str) -> String {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new(&launch.program);
        cmd.args(&launch.args);
        cmd.env("TERM", "xterm-256color");
        for (k, v) in &launch.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut out = Vec::new();
        let mut collect = |until: &dyn Fn(&str) -> bool, limit: Duration| {
            let deadline = Instant::now() + limit;
            while Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
                    out.extend(chunk);
                }
                if until(&String::from_utf8_lossy(&out)) {
                    break;
                }
            }
        };
        collect(&|o| o.contains("133;A"), Duration::from_secs(10));
        writer.write_all(input.as_bytes()).unwrap();
        collect(&|o| o.matches("133;A").count() >= 2, Duration::from_secs(10));
        // A little longer, for anything after the second prompt.
        collect(&|_| false, Duration::from_millis(300));
        let _ = writer.write_all(b"exit\r");
        let _ = child.kill();
        String::from_utf8_lossy(&out).into_owned()
    }
}
