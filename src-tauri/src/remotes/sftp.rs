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
//! **One session per host, held open.** A directory listing is a round trip on an existing channel;
//! re-establishing SSH for each one would make browsing feel like dialling up. The session lives
//! until the host is disconnected or the workspace changes.
//!
//! Reached through [`super::files`], never directly: the browser in front of this also speaks FTP,
//! and which one answers is that module's decision, not the caller's.

use std::collections::HashMap;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::files::{join, mode_string, plan_upload, pump, sort_entries, Planned, RemoteFile, RemoteListing};
use super::RemoteHostSpec;

struct Session {
    sftp: SftpSession,
    /// Held so dropping the session kills the `ssh`. `kill_on_drop` does the rest.
    _child: tokio::process::Child,
}

type Sessions = Mutex<HashMap<String, Arc<Session>>>;

fn sessions() -> &'static Sessions {
    static SESSIONS: std::sync::OnceLock<Sessions> = std::sync::OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The session for this host, opening one if there isn't a live one.
async fn session(host_id: &str, spec: &RemoteHostSpec) -> Result<Arc<Session>, String> {
    if let Some(existing) = sessions().lock().await.get(host_id).cloned() {
        return Ok(existing);
    }
    let opened = Arc::new(connect(spec).await?);
    sessions().lock().await.insert(host_id.to_string(), opened.clone());
    Ok(opened)
}

async fn connect(spec: &RemoteHostSpec) -> Result<Session, String> {
    spec.require_host()?;

    let mut command = crate::proc::command("ssh");
    command
        // `-s <destination> <subsystem>`: the subsystem name goes where a remote command would.
        // Note `base_args(false)` — no terminal exists here, so a prompt would hang forever;
        // `BatchMode=yes` turns "this key needs a passphrase" into a message instead.
        .args(spec.base_args(false))
        .arg("-s")
        .arg(spec.destination())
        .arg("sftp")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|e| super::explain_missing_ssh(&e))?;
    let stdin = child.stdin.take().ok_or("couldn't open ssh's stdin")?;
    let stdout = child.stdout.take().ok_or("couldn't open ssh's stdout")?;
    let mut stderr = child.stderr.take();

    // Reader and writer as one duplex stream — which is all `russh-sftp` wants.
    let stream = tokio::io::join(stdout, stdin);
    let sftp = match SftpSession::new(stream).await {
        Ok(sftp) => sftp,
        Err(error) => {
            // The SFTP handshake failing almost never means "bad SFTP" — it means `ssh` never got
            // far enough to start it. Its stderr is the actual answer (host key, auth, no route),
            // so it goes in front of the protocol error rather than behind it.
            let said = complaint(&mut stderr).await;
            return Err(format!(
                "Couldn't open a file session on {}.{said} ({error})",
                spec.destination()
            ));
        }
    };

    Ok(Session { sftp, _child: child })
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

/// Closes a host's file session. Idempotent — what disconnecting and deleting both call.
pub async fn close(host_id: &str) {
    sessions().lock().await.remove(host_id);
}

/// Lists a directory. An empty `path` means the login directory, which is where a browser should
/// open — `.` resolved by the server, not a guess at `/home/<user>`.
pub async fn list(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<RemoteListing, String> {
    let session = session(host_id, spec).await?;
    let target = if path.trim().is_empty() { "." } else { path };

    // Canonicalized first, so the reply carries an absolute path even when asked for `.` or a path
    // with `..` in it — the frontend builds its breadcrumb from this and must never have to guess.
    let resolved = session
        .sftp
        .canonicalize(target)
        .await
        .map_err(|e| explain(&format!("read {target}"), e))?;

    let mut entries: Vec<RemoteFile> = session
        .sftp
        .read_dir(&resolved)
        .await
        .map_err(|e| explain(&format!("read {resolved}"), e))?
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

    Ok(RemoteListing { path: resolved, entries, ..Default::default() })
}

/// One file or one whole directory, from the far side to here.
///
/// Recursive when `remote_path` is a directory: the tree is walked first so `total` is the real
/// byte count before a single byte moves, which is what makes the bar mean something.
pub async fn download(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let files = plan_download(&session, remote_path, local_path).await?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        if let Some(parent) = std::path::Path::new(&file.local).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let mut source = session
            .sftp
            .open(&file.remote)
            .await
            .map_err(|e| explain(&format!("open {}", file.remote), e))?;
        let mut target = tokio::fs::File::create(&file.local)
            .await
            .map_err(|e| format!("Couldn't write {}: {e}", file.local))?;
        pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
            .await?;
    }
    Ok(())
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
    let session = session(host_id, spec).await?;
    let files = plan_upload(local_path, remote_path)?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        // Created before the file that goes in it, and a directory that already exists is not an
        // error — an interrupted transfer resumed by re-running it must not fail on its own
        // leftovers.
        if let Some(parent) = file.remote.rsplit_once('/').map(|(head, _)| head) {
            if !parent.is_empty() {
                let _ = session.sftp.create_dir(parent).await;
            }
        }
        let mut source = tokio::fs::File::open(&file.local)
            .await
            .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;
        let mut target = session
            .sftp
            .create(&file.remote)
            .await
            .map_err(|e| explain(&format!("create {}", file.remote), e))?;
        pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
            .await?;
        // Explicit: `create` returns a handle whose writes are only guaranteed flushed on close,
        // and dropping it silently would make a truncated upload look like a finished one.
        target.shutdown().await.map_err(|e| format!("Couldn't finish {}: {e}", file.remote))?;
    }
    Ok(())
}

/// Walks the far side, breadth-first, collecting every file under `remote_path`.
///
/// Iterative rather than recursive: `async fn` recursion needs boxing, and a deep tree would be a
/// stack of futures. Symlinks are copied as whatever they point at and never followed as
/// directories — which is what stops a link back to `/` from becoming an infinite walk.
async fn plan_download(
    session: &Session,
    remote_path: &str,
    local_path: &str,
) -> Result<Vec<Planned>, String> {
    let resolved = session
        .sftp
        .canonicalize(remote_path)
        .await
        .map_err(|e| explain(&format!("read {remote_path}"), e))?;
    let metadata = session
        .sftp
        .metadata(&resolved)
        .await
        .map_err(|e| explain(&format!("read {resolved}"), e))?;

    if metadata.file_type() != FileType::Dir {
        let name = resolved.rsplit('/').next().unwrap_or(&resolved).to_string();
        return Ok(vec![Planned {
            remote: resolved,
            local: local_path.to_string(),
            name,
            size: metadata.size.unwrap_or(0),
        }]);
    }

    let mut planned = Vec::new();
    let mut queue = vec![(resolved.clone(), local_path.to_string())];
    while let Some((dir, into)) = queue.pop() {
        let entries = session
            .sftp
            .read_dir(&dir)
            .await
            .map_err(|e| explain(&format!("read {dir}"), e))?;
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
    Ok(planned)
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    session.sftp.create_dir(path).await.map_err(|e| explain(&format!("create {path}"), e))
}

/// Deletes a file or an empty directory.
///
/// Deliberately not recursive. A recursive remote delete is the single most destructive thing a
/// file browser can offer, it cannot be undone, and there is no trash on the far side to fall back
/// on — so removing a tree stays something the user does in the shell they already have open.
pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    if is_dir {
        session.sftp.remove_dir(path).await.map_err(|e| explain(&format!("remove {path}"), e))
    } else {
        session.sftp.remove_file(path).await.map_err(|e| explain(&format!("remove {path}"), e))
    }
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    session.sftp.rename(from, to).await.map_err(|e| explain(&format!("rename {from}"), e))
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
fn explain(operation: &str, error: russh_sftp::client::error::Error) -> String {
    format!("Couldn't {operation}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

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

        std::fs::remove_dir_all(&dir).ok();
    }

    fn sftp_server_path() -> Option<&'static str> {
        ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server"]
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file())
    }
}
