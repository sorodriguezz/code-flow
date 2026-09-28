//! Files on the far side: SFTP, spoken over the system `ssh`.
//!
//! **How this keeps the module's one rule.** `russh-sftp` is a *protocol* crate — it speaks SFTP
//! over any byte stream and knows nothing about SSH. So the transport is still the user's own `ssh`:
//! this spawns `ssh -s <destination> sftp`, which asks the far end for the SFTP subsystem and hands
//! back a pipe carrying nothing but SFTP packets. Its stdin and stdout, joined, *are* the stream.
//!
//! That matters more than it sounds. The alternative — `russh` for the connection too — would mean
//! a second SSH implementation with its own idea of `~/.ssh/config`, `ProxyJump`, the agent and
//! `known_hosts`, and a file browser that could reach a host the terminal couldn't (or worse, one it
//! shouldn't). Here a host that opens a shell opens a file browser, by construction: same binary,
//! same flags, same config.
//!
//! **One session per host, held open** — and checked, since a held session can die under a sleeping
//! laptop without a word. See [`super::pool`] for the rules; here the cheap check is whether the
//! `ssh` child is still running, and "the connection is gone" is any error that is not the server
//! answering with a status.
//!
//! Reached through [`super::files`], never directly: the browser in front of this also speaks FTP,
//! and which one answers is that module's decision, not the caller's.

use std::future::Future;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use tokio::io::AsyncWriteExt;

use super::files::{
    discard_partial_local, join, mode_string, new_parents, plan_upload, pump, sort_entries, Planned,
    RemoteFile, RemoteListing, TRANSFER_CANCELLED,
};
use super::pool::{local, step, Outcome, Pool, Retry};
use super::RemoteHostSpec;

type SftpError = russh_sftp::client::error::Error;

struct Session {
    sftp: SftpSession,
    /// Held so dropping the session kills the `ssh` (`kill_on_drop` does the rest), and asked
    /// whether it is still running — which is how a session whose `ssh` gave up is noticed before
    /// anything is sent on it.
    child: std::sync::Mutex<tokio::process::Child>,
}

impl Session {
    fn running(&self) -> bool {
        self.child.lock().map(|mut child| matches!(child.try_wait(), Ok(None))).unwrap_or(false)
    }
}

fn pool() -> &'static Pool<Session> {
    static POOL: std::sync::OnceLock<Pool<Session>> = std::sync::OnceLock::new();
    POOL.get_or_init(Pool::default)
}

/// Runs `op` on this host's session, opening one if there isn't a live one. See [`super::pool`].
async fn with_session<T, F, FF>(host_id: &str, spec: &RemoteHostSpec, retry: Retry, op: F) -> Result<T, String>
where
    F: Fn(Arc<Session>) -> FF,
    FF: Future<Output = Outcome<T>>,
{
    pool()
        .run(host_id, || connect(host_id, spec), |session| async move { session.running() }, retry, op)
        .await
}

/// Whether an SFTP error means the channel under it is gone.
///
/// A status packet is the server answering — no such file, permission denied — and says the session
/// is fine. So is a limit the server advertised. Everything else is the stream failing: an I/O error,
/// a reply that never came, a packet out of sequence.
fn lost(error: &SftpError) -> bool {
    !matches!(error, SftpError::Status(_) | SftpError::Limited(_))
}

/// One SFTP call, sorted into the three ways it can end.
fn attempt<T>(operation: &str, result: Result<T, SftpError>) -> Outcome<T> {
    Outcome::of(result, lost, |error| explain(operation, error))
}

/// A copy that stopped part way. The copy's own error has no type left to inspect, so the session is
/// asked instead: an `ssh` that has exited took the connection with it.
fn stopped<T>(session: &Session, error: String) -> Outcome<T> {
    if error != TRANSFER_CANCELLED && !session.running() {
        Outcome::Lost(error)
    } else {
        Outcome::Failed(error)
    }
}

async fn connect(host_id: &str, spec: &RemoteHostSpec) -> Result<Session, String> {
    spec.require_host()?;

    // A host that signs in with a password gets it handed over once, through `SSH_ASKPASS` — see
    // `askpass`. Everything else stays under `BatchMode=yes`: no terminal exists here, so a prompt
    // would hang forever, and batch mode turns "this key needs a passphrase" into a message instead.
    let password = super::background_password(host_id, spec);
    let mut command = crate::proc::command("ssh");
    command
        // `-s <destination> <subsystem>`: the subsystem name goes where a remote command would.
        .args(spec.background_args(password.is_some()))
        .arg("-s")
        .arg(spec.destination())
        .arg("sftp")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Held until the handshake is over, one way or the other: that is the whole window in which
    // `ssh` can ask, and dropping it takes the password back if nothing did.
    let handoff = match &password {
        Some(password) => Some(super::askpass::Handoff::arm(&mut command, password)?),
        None => None,
    };

    let mut child = command.spawn().map_err(|e| super::explain_missing_ssh(&e))?;
    let stdin = child.stdin.take().ok_or("couldn't open ssh's stdin")?;
    let stdout = child.stdout.take().ok_or("couldn't open ssh's stdout")?;
    let mut stderr = child.stderr.take();

    // Reader and writer as one duplex stream — which is all `russh-sftp` wants.
    let stream = tokio::io::join(stdout, stdin);
    let sftp = match SftpSession::new(stream).await {
        Ok(sftp) => sftp,
        Err(error) => {
            drop(handoff);
            // The SFTP handshake failing almost never means "bad SFTP" — it means `ssh` never got
            // far enough to start it. Its stderr is the actual answer (host key, auth, no route),
            // so it goes in front of the protocol error rather than behind it.
            let said = complaint(&mut stderr).await;
            // The one failure the app can fix — a host not in `known_hosts` yet — is marked so the
            // browser can offer the trust dialog; a *changed* key is only explained.
            if let Some(explained) = super::host_key_failure(spec, &said) {
                return Err(explained);
            }
            return Err(format!(
                "Couldn't open a file session on {}.{said}{} ({error})",
                spec.destination(),
                super::password_note(spec, password.is_some()),
            ));
        }
    };
    drop(handoff);

    Ok(Session { sftp, child: std::sync::Mutex::new(child) })
}

/// What `ssh` wrote to stderr, bounded by a short timeout — on the failure path the process may
/// still be alive, and an unbounded read would hang exactly where the message is needed.
async fn complaint(stderr: &mut Option<tokio::process::ChildStderr>) -> String {
    let Some(pipe) = stderr.as_mut() else { return String::new() };
    let mut buffer = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        tokio::io::AsyncReadExt::read_to_end(pipe, &mut buffer),
    )
    .await;
    let text = String::from_utf8_lossy(&buffer);
    let said = text.trim();
    if said.is_empty() {
        String::new()
    } else {
        format!(" ssh said: {said}")
    }
}

/// Closes a host's file session. Idempotent — what disconnecting, deleting and editing all call.
pub async fn close(host_id: &str) {
    pool().close(host_id).await;
}

/// Every host currently holding a session, for [`super::hold`] to report.
///
/// Keys rather than a count: the caller is building a per-host answer, and a total would tell it
/// nothing about which row to light.
pub async fn open_hosts() -> Vec<String> {
    pool().hosts().await
}

/// Drops every host's session — the exit path's. See [`super::forward::close_all`] for why a
/// `static` map needs an explicit drain at all.
pub async fn close_all() {
    pool().close_all().await;
}

/// Lists a directory. An empty `path` means the login directory, which is where a browser should
/// open — `.` resolved by the server, not a guess at `/home/<user>`.
pub async fn list(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<RemoteListing, String> {
    let target = if path.trim().is_empty() { "." } else { path };
    with_session(host_id, spec, Retry::Once, |session| async move {
        // Canonicalized first, so the reply carries an absolute path even when asked for `.` or a
        // path with `..` in it — the frontend builds its breadcrumb from this and must never have
        // to guess.
        let resolved = step!(attempt(&format!("read {target}"), session.sftp.canonicalize(target).await));
        let listing = step!(attempt(&format!("read {resolved}"), session.sftp.read_dir(&resolved).await));
        let mut entries: Vec<RemoteFile> = listing
            .map(|entry| {
                let metadata = entry.metadata();
                let name = entry.file_name();
                RemoteFile {
                    path: join(&resolved, &name),
                    is_dir: entry.file_type() == FileType::Dir,
                    is_link: entry.file_type() == FileType::Symlink,
                    size: metadata.size.unwrap_or(0),
                    modified: metadata.mtime.unwrap_or(0) as u64,
                    permissions: permissions(&metadata),
                    name,
                    ..Default::default()
                }
            })
            .collect();
        sort_entries(&mut entries);
        Outcome::Done(RemoteListing { path: resolved, entries, ..Default::default() })
    })
    .await
}

/// One file or one whole directory, from the far side to here.
///
/// Recursive when `remote_path` is a directory: the tree is walked first so `total` is the real
/// byte count before a single byte moves, which is what makes the bar mean something. The walk is a
/// read and may be repeated on a fresh session; the copy writes a local file and is not.
pub async fn download(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let files = with_session(host_id, spec, Retry::Once, |session| async move {
        plan_download(&session, remote_path, local_path).await
    })
    .await?;
    let files = &files;
    with_session(host_id, spec, Retry::Never, |session| async move {
        let total: u64 = files.iter().map(|file| file.size).sum();
        let mut done = 0u64;
        for (index, file) in files.iter().enumerate() {
            if let Some(parent) = std::path::Path::new(&file.local).parent() {
                step!(local(
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))
                ));
            }
            let mut source = step!(attempt(&format!("open {}", file.remote), session.sftp.open(&file.remote).await));
            let mut target = step!(local(
                tokio::fs::File::create(&file.local)
                    .await
                    .map_err(|e| format!("Couldn't write {}: {e}", file.local))
            ));
            let copied =
                pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
                    .await;
            if let Err(error) = copied {
                drop(target);
                discard_partial_local(&file.local, &error).await;
                return stopped(&session, error);
            }
        }
        Outcome::Done(())
    })
    .await
}

/// One file or one whole directory, from here to the far side.
pub async fn upload(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    let files = plan_upload(local_path, remote_path)?;
    let files = &files;
    with_session(host_id, spec, Retry::Never, |session| async move {
        let total: u64 = files.iter().map(|file| file.size).sum();
        let mut done = 0u64;
        let mut made = std::collections::HashSet::new();
        for (index, file) in files.iter().enumerate() {
            // Every missing directory between the transfer's root and this file, outermost first —
            // a folder whose only content is another folder has no file of its own to create it.
            // One that already exists is not an error: an interrupted transfer resumed by
            // re-running it must not fail on its own leftovers.
            for dir in new_parents(remote_path, &file.remote, &mut made) {
                let _ = session.sftp.create_dir(dir).await;
            }
            let mut source = step!(local(
                tokio::fs::File::open(&file.local)
                    .await
                    .map_err(|e| format!("Couldn't read {}: {e}", file.local))
            ));
            let mut target =
                step!(attempt(&format!("create {}", file.remote), session.sftp.create(&file.remote).await));
            let copied =
                pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
                    .await;
            if let Err(error) = copied {
                let _ = target.shutdown().await;
                // A cancelled upload leaves nothing behind: a file cut short under the real name is
                // indistinguishable from a finished one to whoever reads it next.
                if error == TRANSFER_CANCELLED {
                    let _ = session.sftp.remove_file(&file.remote).await;
                }
                return stopped(&session, error);
            }
            // Explicit: `create` returns a handle whose writes are only guaranteed flushed on close,
            // and dropping it silently would make a truncated upload look like a finished one.
            if let Err(e) = target.shutdown().await {
                return stopped(&session, format!("Couldn't finish {}: {e}", file.remote));
            }
        }
        Outcome::Done(())
    })
    .await
}

/// Walks the far side, breadth-first, collecting every file under `remote_path`.
///
/// Iterative rather than recursive: `async fn` recursion needs boxing, and a deep tree would be a
/// stack of futures. Symlinks are copied as whatever they point at and never followed as
/// directories — which is what stops a link back to `/` from becoming an infinite walk.
async fn plan_download(session: &Session, remote_path: &str, local_path: &str) -> Outcome<Vec<Planned>> {
    let resolved =
        step!(attempt(&format!("read {remote_path}"), session.sftp.canonicalize(remote_path).await));
    let metadata = step!(attempt(&format!("read {resolved}"), session.sftp.metadata(&resolved).await));

    if metadata.file_type() != FileType::Dir {
        let name = resolved.rsplit('/').next().unwrap_or(&resolved).to_string();
        return Outcome::Done(vec![Planned {
            local: local_path.to_string(),
            name,
            size: metadata.size.unwrap_or(0),
            remote: resolved,
        }]);
    }

    let mut planned = Vec::new();
    let mut queue = vec![(resolved.clone(), local_path.to_string())];
    while let Some((dir, into)) = queue.pop() {
        let entries = step!(attempt(&format!("read {dir}"), session.sftp.read_dir(&dir).await));
        for entry in entries {
            let name = entry.file_name();
            let remote = join(&dir, &name);
            let local = format!("{into}{}{name}", std::path::MAIN_SEPARATOR);
            if entry.file_type() == FileType::Dir {
                queue.push((remote, local));
            } else {
                planned.push(Planned { remote, local, name, size: entry.metadata().size.unwrap_or(0) });
            }
        }
    }
    Outcome::Done(planned)
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    with_session(host_id, spec, Retry::Never, |session| async move {
        attempt(&format!("create {path}"), session.sftp.create_dir(path).await)
    })
    .await
}

/// Deletes a file or an empty directory.
///
/// Deliberately not recursive. A recursive remote delete is the single most destructive thing a
/// file browser can offer, it cannot be undone, and there is no trash on the far side to fall back
/// on — so removing a tree stays something the user does in the shell they already have open.
pub async fn remove(host_id: &str, spec: &RemoteHostSpec, path: &str, is_dir: bool) -> Result<(), String> {
    with_session(host_id, spec, Retry::Never, |session| async move {
        let operation = format!("remove {path}");
        if is_dir {
            attempt(&operation, session.sftp.remove_dir(path).await)
        } else {
            attempt(&operation, session.sftp.remove_file(path).await)
        }
    })
    .await
}

pub async fn rename(host_id: &str, spec: &RemoteHostSpec, from: &str, to: &str) -> Result<(), String> {
    with_session(host_id, spec, Retry::Never, |session| async move {
        attempt(&format!("rename {from}"), session.sftp.rename(from, to).await)
    })
    .await
}

/// The `drwxr-xr-x` string, from the mode the server reported. Empty when it reported none, which
/// is the honest answer — an invented mode would be indistinguishable from a real one.
fn permissions(metadata: &russh_sftp::protocol::FileAttributes) -> String {
    let Some(mode) = metadata.permissions else { return String::new() };
    let kind = match metadata.file_type() {
        FileType::Dir => 'd',
        FileType::Symlink => 'l',
        _ => '-',
    };
    mode_string(kind, mode)
}

/// SFTP status codes are numbers; this puts the operation in front of one so the message names what
/// was being attempted rather than only what the server thought of it.
fn explain(operation: &str, error: SftpError) -> String {
    format!("Couldn't {operation}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What decides whether a held session is kept or dropped: the server *answering* keeps it.
    #[test]
    fn a_status_from_the_server_keeps_the_session_and_a_broken_stream_does_not() {
        let status = russh_sftp::protocol::Status {
            id: 1,
            status_code: russh_sftp::protocol::StatusCode::NoSuchFile,
            error_message: "No such file".into(),
            language_tag: "en".into(),
        };
        assert!(!lost(&SftpError::Status(status)));
        assert!(!lost(&SftpError::Limited("packet too long".into())));
        assert!(lost(&SftpError::IO("broken pipe".into())));
        assert!(lost(&SftpError::Timeout));
        assert!(lost(&SftpError::UnexpectedBehavior("RecvError: channel closed".into())));
    }

    /// The load-bearing mechanism, exercised for real.
    ///
    /// What `ssh -s host sftp` produces is a process whose stdin/stdout carry SFTP and nothing else
    /// — and `sftp-server` is that same process without the network in front of it. Driving it
    /// directly tests the part that could actually be wrong: whether `tokio::io::join` of a child's
    /// stdout and stdin is a stream `russh-sftp` can complete a handshake over, and whether the
    /// listing, upload and delete calls are wired to the right API.
    ///
    /// Skipped where the binary isn't present rather than failed: its path differs across distros,
    /// and a unit test that fails on the packaging of a machine tells nobody anything.
    #[tokio::test]
    async fn sftp_over_a_pipe_can_list_upload_and_delete() {
        let Some(server) = sftp_server_path() else {
            eprintln!("no sftp-server on this machine; skipping the live SFTP test");
            return;
        };

        let dir = std::env::temp_dir().join(format!("cf-sftp-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("present.txt"), b"already here").unwrap();

        let mut child = tokio::process::Command::new(server)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("sftp-server should start");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let sftp = SftpSession::new(tokio::io::join(stdout, stdin))
            .await
            .expect("the handshake must complete over a plain pipe");

        // List: the file written above has to come back, with its size.
        let base = dir.to_string_lossy().to_string();
        let entries: Vec<_> = sftp.read_dir(&base).await.unwrap().collect();
        let found = entries
            .iter()
            .find(|entry| entry.file_name() == "present.txt")
            .expect("the seeded file must be listed");
        assert_eq!(found.metadata().size.unwrap_or(0), 12);

        // Write, then read back through the operating system — which is the real assertion: the
        // bytes went where the protocol said they did.
        let uploaded = format!("{base}/uploaded.txt");
        {
            use tokio::io::AsyncWriteExt;
            let mut handle = sftp.create(&uploaded).await.unwrap();
            handle.write_all(b"from the client").await.unwrap();
            handle.shutdown().await.unwrap();
        }
        assert_eq!(std::fs::read(&uploaded).unwrap(), b"from the client");

        // And delete removes it for real.
        sftp.remove_file(&uploaded).await.unwrap();
        assert!(!std::path::Path::new(&uploaded).exists());

        // A session whose process is gone reports itself dead, which is what lets the pool replace
        // it before anything is sent — the laptop-sleep case without the laptop.
        let session = Session { sftp, child: std::sync::Mutex::new(child) };
        assert!(session.running());
        session.child.lock().unwrap().start_kill().unwrap();
        for _ in 0..100 {
            if !session.running() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(!session.running());

        std::fs::remove_dir_all(&dir).ok();
    }

    fn sftp_server_path() -> Option<&'static str> {
        ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server"]
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file())
    }
}
