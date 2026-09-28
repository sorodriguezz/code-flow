//! Handing a saved password to a *background* `ssh` — the file browser's, a forward's — exactly once.
//!
//! **Why this is needed.** A background `ssh` has no terminal, so it runs with `BatchMode=yes`, which
//! turns every prompt into a failure. For a host that signs in with a password that meant an SFTP
//! row offering a Password field that could never work: every attempt ended in "Permission denied".
//! `ssh` will not read a password from an argument, a file or a pipe on stdin — deliberately — and
//! the one door it leaves is `SSH_ASKPASS`: a program it runs to ask.
//!
//! **The design, and what it exposes.**
//!
//! - The helper is a four-line `sh` script, written once per run into a directory of its own
//!   (mode 0700) under the temp dir. **It holds no secret.** It refuses host-key questions and key
//!   passphrases and, for anything else, `cat`s a named pipe whose path it is given in the
//!   environment.
//! - Each connection gets its own **FIFO** (mode 0600) in that directory, and a thread that waits
//!   for a reader to open it, writes the password once, closes it and deletes it. A FIFO has no
//!   content on disk: the bytes go through a kernel buffer from this process to the helper's `cat`.
//!   So the password is never written to disk in clear at all.
//! - **One-shot.** A second prompt finds no pipe and gets nothing, so a wrong password is tried once
//!   (`NumberOfPasswordPrompts=1` too) rather than three times against a server counting failures.
//!   When the connection comes up without asking — the agent had a key after all — [`Handoff`]'s
//!   drop removes the pipe and the writer leaves with the password unwritten.
//!
//! The exposure that remains, stated plainly: between the pipe's creation and `ssh` reading it —
//! the length of a handshake — another process *running as the same user* could open the pipe and
//! take the password first (the connection then fails, visibly). The directory's mode keeps every
//! other user out. The pipe's path is in `ssh`'s environment, readable by the same user. Anything
//! running as the same user can already read far more than this, but it is a window, and it is why
//! the pipe lives only as long as the handshake.
//!
//! **Where it works.** `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+) makes `ssh` use the helper even
//! with a terminal around. Older OpenSSH only asks a helper when it has no terminal and `DISPLAY` is
//! set, so for those this sets a placeholder `DISPLAY` and starts `ssh` in a session of its own —
//! no controlling terminal — which gets the same result. Windows has no FIFOs and its OpenSSH port
//! predates the variable on most installs, so [`supported`] says no there, and the UI does not offer
//! a password for a host kind whose only transport is a background `ssh`.

/// Whether this machine's `ssh` can be handed a password this way. Asked once per run.
pub fn supported() -> bool {
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SUPPORTED.get_or_init(detect)
}

#[cfg(unix)]
fn detect() -> bool {
    openssh_version().is_some() && imp::helper().is_ok()
}

#[cfg(not(unix))]
fn detect() -> bool {
    false
}

/// `ssh -V`'s version, when it is OpenSSH. Printed on stderr: `OpenSSH_9.8p1, LibreSSL 3.3.6`.
#[cfg_attr(not(unix), allow(dead_code))]
fn openssh_version() -> Option<(u32, u32)> {
    static VERSION: std::sync::OnceLock<Option<(u32, u32)>> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        let output = crate::proc::std_command("ssh").arg("-V").stdin(std::process::Stdio::null()).output().ok()?;
        let said = format!("{}{}", String::from_utf8_lossy(&output.stderr), String::from_utf8_lossy(&output.stdout));
        parse_version(&said)
    })
}

/// `OpenSSH_9.8p1, …` → `(9, 8)`. Also reads the Windows port's `OpenSSH_for_Windows_9.5p1`.
pub(crate) fn parse_version(text: &str) -> Option<(u32, u32)> {
    let at = text.find("OpenSSH_")?;
    let rest = &text[at + "OpenSSH_".len()..];
    let rest = rest.strip_prefix("for_Windows_").unwrap_or(rest);
    let number: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let mut parts = number.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|minor| minor.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// The first OpenSSH that honours `SSH_ASKPASS_REQUIRE`.
#[cfg_attr(not(unix), allow(dead_code))]
const FORCE_SINCE: (u32, u32) = (8, 4);

/// A password waiting for one `ssh` to ask for it. Dropping it takes the password back if nobody
/// did, and removes the pipe.
pub struct Handoff {
    /// Never read — held for its drop, which is what takes the password back.
    #[cfg(unix)]
    _pending: imp::Pending,
}

impl Handoff {
    /// Sets `command` up to be handed `password` once, through the helper.
    #[cfg(unix)]
    pub fn arm(command: &mut tokio::process::Command, password: &str) -> Result<Self, String> {
        let helper = imp::helper()?;
        let inner = imp::Pending::new(&helper.dir, password)?;
        command
            .env("SSH_ASKPASS", &helper.script)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("CODEFLOW_ASKPASS_FIFO", &inner.fifo);
        if openssh_version().is_some_and(|version| version < FORCE_SINCE) {
            // Before 8.4 a helper is only asked when there is no terminal and a display is set.
            // The display is never used — no `-X`, and `ForwardX11=no` rides along — it is only the
            // switch older `ssh` reads.
            if std::env::var_os("DISPLAY").is_none() {
                command.env("DISPLAY", ":0");
            }
            // A session of its own has no controlling terminal, so `ssh` cannot open `/dev/tty` and
            // falls through to the helper. Only matters when CodeFlow itself was started from a
            // terminal; a launch from the Dock has none to inherit.
            // SAFETY: `setsid` is async-signal-safe and touches nothing but the child's own session.
            unsafe {
                command.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        Ok(Self { _pending: inner })
    }

    #[cfg(not(unix))]
    pub fn arm(_command: &mut tokio::process::Command, _password: &str) -> Result<Self, String> {
        Err("This system's ssh can't be handed a saved password.".into())
    }
}

/// Removes the helper's directory — the exit path's, through [`super::hold::release_all`]. Anything
/// still waiting in it belongs to an `ssh` that is being killed on the same path.
pub fn cleanup() {
    // Not in the test binary, where tests share one helper and run in parallel: one of them
    // releasing everything must not pull it out from under another that is mid-handoff.
    #[cfg(all(unix, not(test)))]
    imp::cleanup();
}

#[cfg(unix)]
mod imp {
    use std::io::Write as _;
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, OnceLock};

    /// The helper. No secret in it, and nothing specific to one connection: the pipe it reads is
    /// named by the environment of the `ssh` that runs it.
    ///
    /// `SSH_ASKPASS_PROMPT=confirm` is a yes/no question (an unknown host key, above all), which is
    /// answered "no" so `ssh` fails with the message the host-key dialog is offered from; `none` is
    /// a notice with nothing to answer. The two `case` patterns that follow cover an OpenSSH too old
    /// to set that variable. A key's passphrase is not this host's password, so it is refused too.
    pub(super) const SCRIPT: &str = "#!/bin/sh\n\
# CodeFlow's SSH_ASKPASS helper: passes one saved password from a pipe to one ssh prompt.\n\
case \"$SSH_ASKPASS_PROMPT\" in confirm|none) exit 1 ;; esac\n\
case \"$1\" in *assphrase*|*'continue connecting'*|*'yes/no'*) exit 1 ;; esac\n\
[ -p \"$CODEFLOW_ASKPASS_FIFO\" ] || exit 1\n\
exec cat \"$CODEFLOW_ASKPASS_FIFO\"\n";

    pub(super) struct Helper {
        pub dir: PathBuf,
        pub script: PathBuf,
    }

    static HELPER: OnceLock<Result<Helper, String>> = OnceLock::new();

    pub(super) fn helper() -> Result<&'static Helper, String> {
        HELPER.get_or_init(create).as_ref().map_err(Clone::clone)
    }

    /// A fresh 0700 directory with the script in it. Created, never reused: a directory left by an
    /// earlier run — or planted by somebody else — is not one to trust with a script `ssh` executes.
    fn create() -> Result<Helper, String> {
        for _ in 0..8 {
            let dir = std::env::temp_dir().join(format!("codeflow-askpass-{}", random_hex()));
            match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => {
                    let script = dir.join("askpass");
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o700)
                        .open(&script)
                        .map_err(|e| format!("couldn't write the askpass helper: {e}"))?;
                    file.write_all(SCRIPT.as_bytes()).map_err(|e| format!("couldn't write the askpass helper: {e}"))?;
                    return Ok(Helper { dir, script });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("couldn't create the askpass directory: {e}")),
            }
        }
        Err("couldn't create the askpass directory".into())
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(super) fn cleanup() {
        if let Some(Ok(helper)) = HELPER.get() {
            let _ = std::fs::remove_dir_all(&helper.dir);
        }
    }

    fn random_hex() -> String {
        let bytes: [u8; 8] = rand::random();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// One armed pipe and the thread waiting to write into it.
    pub(super) struct Pending {
        pub fifo: PathBuf,
        withdrawn: Arc<AtomicBool>,
    }

    impl Pending {
        pub(super) fn new(dir: &Path, password: &str) -> Result<Self, String> {
            let fifo = dir.join(format!("h-{}", random_hex()));
            let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
            // SAFETY: a valid NUL-terminated path; `mkfifo` only reads it.
            if unsafe { libc::mkfifo(name.as_ptr(), 0o600) } != 0 {
                return Err(format!("couldn't create the askpass pipe: {}", std::io::Error::last_os_error()));
            }
            let withdrawn = Arc::new(AtomicBool::new(false));
            let writer = Writer { fifo: fifo.clone(), withdrawn: withdrawn.clone(), password: password.to_string() };
            std::thread::Builder::new()
                .name("askpass".into())
                .spawn(move || writer.run())
                .map_err(|e| {
                    let _ = std::fs::remove_file(&fifo);
                    format!("couldn't start the askpass writer: {e}")
                })?;
            Ok(Self { fifo, withdrawn })
        }
    }

    impl Drop for Pending {
        fn drop(&mut self) {
            // The writer notices within one poll and leaves without writing; the pipe goes now, so
            // nothing can open it in the meantime.
            self.withdrawn.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(&self.fifo);
        }
    }

    /// How often the writer looks for a reader, and for how long before giving up. A handshake
    /// that has not asked within the limit is not going to; the limit only bounds a thread whose
    /// `Handoff` was somehow never dropped.
    const POLL: std::time::Duration = std::time::Duration::from_millis(25);
    const GIVE_UP: std::time::Duration = std::time::Duration::from_secs(120);

    struct Writer {
        fifo: PathBuf,
        withdrawn: Arc<AtomicBool>,
        password: String,
    }

    impl Writer {
        fn run(self) {
            let started = std::time::Instant::now();
            // Polled rather than blocking. A blocking open waits for a reader that may never come —
            // the agent had a key and nobody asks — and a thread parked in `open` cannot be told to
            // give up. Non-blocking, it fails with ENXIO until the helper's `cat` has the other end.
            while !self.withdrawn.load(Ordering::SeqCst) && started.elapsed() < GIVE_UP {
                match std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&self.fifo) {
                    Ok(mut pipe) => {
                        // A password fits a pipe's buffer many times over, so this does not meet
                        // the would-block a non-blocking descriptor can return for a large write.
                        let _ = pipe.write_all(self.password.as_bytes());
                        let _ = pipe.write_all(b"\n");
                        break;
                    }
                    Err(e) if e.raw_os_error() == Some(libc::ENXIO) => std::thread::sleep(POLL),
                    // Gone — withdrawn and removed between two polls — or unusable: either way there
                    // is nothing left to hand over.
                    Err(_) => break,
                }
            }
            // Gone the moment it has been read once — the second prompt finds nothing to `cat`.
            let _ = std::fs::remove_file(&self.fifo);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_is_read_from_what_ssh_v_prints() {
        assert_eq!(parse_version("OpenSSH_9.8p1, LibreSSL 3.3.6"), Some((9, 8)));
        assert_eq!(parse_version("OpenSSH_8.2p1 Ubuntu-4ubuntu0.11, OpenSSL 1.1.1f"), Some((8, 2)));
        assert_eq!(parse_version("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2"), Some((9, 5)));
        assert_eq!(parse_version("OpenSSH_10.3p1, LibreSSL 3.3.6"), Some((10, 3)));
        assert_eq!(parse_version("Dropbear SSH client v2022.83"), None);
        assert!((8, 2) < FORCE_SINCE && (8, 4) >= FORCE_SINCE && (10, 0) >= FORCE_SINCE);
    }

    /// The whole handoff, end to end, with the real helper script standing in for `ssh`: the first
    /// prompt gets the password, the second gets nothing, a passphrase or a yes/no question is
    /// refused — and the pipe is gone afterwards.
    #[cfg(unix)]
    #[test]
    fn the_helper_answers_one_password_prompt_once_and_refuses_the_rest() {
        let helper = imp::helper().expect("the helper is created in the temp dir");
        let script = std::fs::read_to_string(&helper.script).unwrap();
        assert!(!script.contains("hunter2"), "the script never holds the secret");

        let ask = |fifo: &std::path::Path, prompt: &str, kind: Option<&str>| {
            let mut command = std::process::Command::new(&helper.script);
            command.arg(prompt).env("CODEFLOW_ASKPASS_FIFO", fifo).env_remove("SSH_ASKPASS_PROMPT");
            if let Some(kind) = kind {
                command.env("SSH_ASKPASS_PROMPT", kind);
            }
            let output = command.output().unwrap();
            (output.status.success(), String::from_utf8_lossy(&output.stdout).to_string())
        };

        let pending = imp::Pending::new(&helper.dir, "hunter2").unwrap();
        let fifo = pending.fifo.clone();
        // Refused without touching the pipe, so the password is still there for the real prompt.
        assert_eq!(ask(&fifo, "Enter passphrase for key '/k':", None), (false, String::new()));
        assert_eq!(ask(&fifo, "Are you sure you want to continue connecting (yes/no)?", None).0, false);
        assert_eq!(ask(&fifo, "anything", Some("confirm")).0, false);

        assert_eq!(ask(&fifo, "deploy@web-01's password:", None), (true, "hunter2\n".to_string()));
        // Removed by the writer once read; give its thread a moment.
        for _ in 0..50 {
            if !fifo.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!fifo.exists(), "read once, then gone");
        assert_eq!(ask(&fifo, "deploy@web-01's password:", None).0, false, "a second prompt gets nothing");
        drop(pending);
    }

    /// A connection that never asked — the agent had a key — must not leave a thread blocked on the
    /// pipe or the pipe on disk.
    #[cfg(unix)]
    #[test]
    fn a_password_nobody_asked_for_is_taken_back_on_drop() {
        let helper = imp::helper().unwrap();
        let pending = imp::Pending::new(&helper.dir, "hunter2").unwrap();
        let fifo = pending.fifo.clone();
        assert!(fifo.exists());
        drop(pending);
        assert!(!fifo.exists());
    }
}
