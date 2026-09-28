//! Files on the far side: SMB2/3 — a Windows share, a NAS, or a Mac with File Sharing on.
//!
//! **The second exception in this module, and it is the same exception.** [`super::ftp`]'s header
//! explains why it opens a socket of its own instead of borrowing the user's `ssh`; SMB is that
//! again. A host declares its [`RemoteKind`](super::RemoteKind), the kind decides which
//! capabilities exist, and an SMB host therefore never reaches a code path that would have spawned
//! `ssh` — no shell, no forward, no screen. What is left is files, which is all SMB ever offered.
//!
//! **Why this is `smb2` and not the obvious alternative.** `smb` (the smb-rs crate) is the better
//! known one and it cannot be installed in this tree at all: its auth stack pins `sspi =0.18.7`,
//! which pins `sha2 =0.11.0-rc.2`, and this binary already resolves `sha2 0.11.0` *final* through
//! `tokio-postgres-rustls`. A requirement carrying no pre-release tag does not match a release
//! candidate, so cargo cannot reconcile the two and refuses the lockfile outright. The FFI options
//! (`pavao`, `remotefs-smb`) want `libsmbclient`, which the macOS arm64 build cannot link without
//! shipping Samba. `smb2` is pure Rust, needs no C library, and therefore builds wherever this app
//! builds — which is the requirement that decided it.
//!
//! **A share is the first path segment, and the root is the list of shares.** SMB has no single
//! filesystem to open into: a server offers *shares*, and only inside one is there a directory
//! tree. So `/` lists the shares and `/Documents/reports/q3.pdf` means `reports/q3.pdf` inside
//! `Documents`. That is not an invention here — [`super::cloud::account`] already does exactly
//! this for an Azure account, whose four services are its first segment — and it is what lets one
//! dual-pane browser cross a boundary the protocol draws.
//!
//! **One connection per host, one operation at a time.** SMB2 multiplexes happily, but this
//! crate's operations borrow the client mutably, so the `Mutex` is what the borrow checker was
//! going to insist on anyway. It also keeps the share handles: a session that browsed three shares
//! holds three trees, because re-connecting one per listing is a round trip per click.
//!
//! **And one that can die quietly**, like every held connection here: the client's own
//! disconnected flag is checked before a held one is used, and a lost connection, a timeout or an
//! expired session drops it — see [`super::pool`].

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use smb2::{ErrorKind, SmbClient, Tree};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::files::{
    cancelled, discard_partial_local, join, new_parents, plan_upload, progress, sort_entries, Planned,
    RemoteFile, RemoteListing, CHUNK, PROGRESS_INTERVAL, TRANSFER_CANCELLED,
};
use super::pool::{local, step, Outcome, Pool, Retry};
use super::RemoteHostSpec;

/// One host's connection, and the shares it has opened through it.
struct Session {
    client: SmbClient,
    /// Keyed by share name. A [`Tree`] is a handle the server issued, not a path — dropping one to
    /// re-open it per listing would be a `TREE_CONNECT` per click.
    trees: HashMap<String, Tree>,
}

type Held = Mutex<Session>;

fn pool() -> &'static Pool<Held> {
    static POOL: std::sync::OnceLock<Pool<Held>> = std::sync::OnceLock::new();
    POOL.get_or_init(Pool::default)
}

/// Runs `op` on this host's connection, opening one if there isn't a live one. See [`super::pool`]
/// — the cheap check here is the client's own record of having been disconnected.
async fn with_session<T, F, FF>(host_id: &str, spec: &RemoteHostSpec, retry: Retry, op: F) -> Result<T, String>
where
    F: Fn(Arc<Held>) -> FF,
    FF: Future<Output = Outcome<T>>,
{
    pool()
        .run(
            host_id,
            || async move {
                let client = connect(host_id, spec).await?;
                Ok(Mutex::new(Session { client, trees: HashMap::new() }))
            },
            |session| async move { !session.lock().await.client.is_disconnected() },
            retry,
            op,
        )
        .await
}

/// Whether an SMB error means the connection is gone: the socket dropped, the server stopped
/// answering, or the session it signed in with has expired. Access denied, not found or a full disk
/// are the server answering.
fn lost(error: &smb2::Error) -> bool {
    matches!(error.kind(), ErrorKind::ConnectionLost | ErrorKind::TimedOut | ErrorKind::SessionExpired)
}

/// One SMB call, sorted into the three ways it can end.
fn attempt<T>(operation: &str, result: Result<T, smb2::Error>) -> Outcome<T> {
    Outcome::of(result, lost, |error| explain(operation, error))
}

async fn connect(host_id: &str, spec: &RemoteHostSpec) -> Result<SmbClient, String> {
    spec.require_host()?;
    let host = spec.host.trim();
    let address = format!("{host}:{}", spec.effective_port());
    let (user, password) = credentials(host_id, spec);

    smb2::connect(&address, &user, &password)
        .await
        .map_err(|e| explain(&format!("connect to {address} as {user}"), e))
}

/// Who to log in as.
///
/// No anonymous mode, unlike FTP: a guest share takes an empty password with whatever user name,
/// and inventing one would only hide which account the server actually refused.
fn credentials(host_id: &str, spec: &RemoteHostSpec) -> (String, String) {
    // The same keychain entry every other kind's password uses — keyed by host id, so a row that
    // changes kind keeps the credential already saved against it.
    let password = crate::secrets::get_secret(&super::password_key(host_id))
        .unwrap_or_default()
        .unwrap_or_default();
    (spec.user.trim().to_string(), password)
}

/// Closes a host's file session. Idempotent — what disconnecting, deleting and editing all call.
///
/// `TREE_DISCONNECT` and `LOGOFF` are not sent, for [`super::ftp::close`]'s reason: they need the
/// lock and a round trip on a socket that may already be dead, and dropping the client closes the
/// connection either way.
pub async fn close(host_id: &str) {
    pool().close(host_id).await;
}

/// Every host currently holding a connection, for [`super::hold`] to report.
pub async fn open_hosts() -> Vec<String> {
    pool().hosts().await
}

/// Drops every host's connection — the exit path's.
pub async fn close_all() {
    pool().close_all().await;
}

// ---------------------------------------------------------------------------
// The seven verbs
// ---------------------------------------------------------------------------

/// Lists a directory, or the shares themselves when `path` names none.
pub async fn list(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
) -> Result<RemoteListing, String> {
    with_session(host_id, spec, Retry::Once, |session| async move {
        let mut guard = session.lock().await;
        let Some((share, inner)) = split_share(path) else {
            return shares(&mut guard.client).await;
        };

        let Session { client, trees } = &mut *guard;
        let tree = step!(tree(client, trees, share).await);
        let found = step!(attempt(&format!("list {path}"), client.list_directory(tree, inner).await));

        let base = join("", share);
        let mut entries = found
            .into_iter()
            // `.` and `..` are the server's, not the user's: the browser has its own way up, and a
            // row that walks into itself is a row that can only confuse.
            .filter(|entry| entry.name != "." && entry.name != "..")
            .map(|entry| RemoteFile {
                path: join(&join(&base, inner), &entry.name),
                is_dir: entry.is_directory,
                size: entry.size,
                modified: seconds(entry.modified),
                // SMB carries DOS attributes, not a POSIX mode. Left empty rather than translated
                // into an `rwxr-xr-x` that would be invented — see `RemoteFile::permissions`.
                name: entry.name,
                ..Default::default()
            })
            .collect::<Vec<_>>();
        sort_entries(&mut entries);

        Outcome::Done(RemoteListing { path: join(&base, inner), entries, ..Default::default() })
    })
    .await
}

/// The server's shares, as the root directory.
///
/// Administrative shares are left out: `IPC$` is not a filesystem at all, and `C$`/`ADMIN$` are
/// whole-disk back doors that need an admin session and answer with an error for everyone else. A
/// row nobody can open is worse than no row.
async fn shares(client: &mut SmbClient) -> Outcome<RemoteListing> {
    let found = step!(attempt("list the server's shares", client.list_shares().await));
    let mut entries = found
        .into_iter()
        .filter(|share| {
            // The low half of `share_type` is the kind; the top bit marks a special share. The
            // crate keeps its own mask private, so this names it rather than borrowing it.
            const KIND: u32 = 0x0000_FFFF;
            share.share_type & KIND == smb2::rpc::srvsvc::STYPE_DISKTREE
                && share.share_type & smb2::rpc::srvsvc::STYPE_SPECIAL == 0
        })
        .map(|share| RemoteFile {
            path: join("", &share.name),
            name: share.name,
            is_dir: true,
            ..Default::default()
        })
        .collect::<Vec<_>>();
    sort_entries(&mut entries);
    Outcome::Done(RemoteListing { path: "/".into(), entries, ..Default::default() })
}

/// One file or one whole directory, from the far side to here.
pub async fn download(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let (share, inner) = split_share(remote_path)
        .ok_or_else(|| "Pick a share to download from — the root is the list of them.".to_string())?;
    let files = with_session(host_id, spec, Retry::Once, |session| async move {
        let mut guard = session.lock().await;
        let Session { client, trees } = &mut *guard;
        plan_download(client, trees, share, inner, local_path).await
    })
    .await?;
    let files = &files;
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut guard = session.lock().await;
        let Session { client, trees } = &mut *guard;
        // Opened here as well as by the plan: when the session under the plan died, this is a new
        // one with no shares open yet.
        step!(tree(client, trees, share).await);
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
            let mut target = step!(local(
                tokio::fs::File::create(&file.local)
                    .await
                    .map_err(|e| format!("Couldn't write {}: {e}", file.local))
            ));

            // The crate's own chunking rather than a `pump` over an `AsyncRead`: a download here is
            // a sliding window of overlapping READs (that is the crate's whole point), and an
            // `AsyncRead` facade would serialize it back into one request at a time.
            let tree = step!(local(trees.get(share).ok_or_else(|| format!("{share} is not open"))));
            let mut stream =
                step!(attempt(&format!("open {}", file.remote), client.download(tree, &file.remote).await));
            let mut last = std::time::Instant::now();
            while let Some(chunk) = stream.next_chunk().await {
                if cancelled(id) {
                    drop(stream);
                    drop(target);
                    discard_partial_local(&file.local, TRANSFER_CANCELLED).await;
                    // Reads were still in flight when it stopped, and whether the client settles
                    // them cleanly is not something to find out on the next listing — the
                    // connection goes, and the next operation opens a fresh one.
                    return Outcome::Lost(TRANSFER_CANCELLED.to_string());
                }
                let bytes = step!(attempt(&format!("read {}", file.remote), chunk));
                step!(local(
                    target.write_all(&bytes).await.map_err(|e| format!("Couldn't write {}: {e}", file.local))
                ));
                done += bytes.len() as u64;
                if last.elapsed() >= PROGRESS_INTERVAL {
                    last = std::time::Instant::now();
                    progress(app, id, &file.name, done, total, index as u64, files.len() as u64);
                }
            }
            // Flushed before the next file, so a transfer that dies half way leaves what it claimed.
            step!(local(target.flush().await.map_err(|e| format!("Couldn't write {}: {e}", file.local))));
            progress(app, id, &file.name, done, total, index as u64 + 1, files.len() as u64);
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
    let (share, inner) = split_share(remote_path)
        .ok_or_else(|| "Pick a share to upload into — the root is the list of them.".to_string())?;
    let files = plan_upload(local_path, inner)?;
    let files = &files;
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut guard = session.lock().await;
        let Session { client, trees } = &mut *guard;
        let tree = step!(tree(client, trees, share).await);
        let total: u64 = files.iter().map(|file| file.size).sum();
        let mut done = 0u64;
        let mut made = std::collections::HashSet::new();

        for (index, file) in files.iter().enumerate() {
            // Every missing directory between the transfer's root and this file, outermost first;
            // an existing one is not an error — an interrupted transfer resumed by re-running it
            // must not fail on its own leftovers.
            for dir in new_parents(inner, &file.remote, &mut made) {
                let _ = client.create_directory(tree, &dir).await;
            }
            let mut source = step!(local(
                tokio::fs::File::open(&file.local)
                    .await
                    .map_err(|e| format!("Couldn't read {}: {e}", file.local))
            ));

            // `create_file_writer` and not `upload`, which takes the file as one `&[u8]`: that would
            // read a 40 GB disk image into memory to send it.
            let mut writer =
                step!(attempt(&format!("create {}", file.remote), client.create_file_writer(tree, &file.remote).await));
            let mut buffer = vec![0u8; CHUNK];
            let mut last = std::time::Instant::now();
            loop {
                if cancelled(id) {
                    // Closed, then removed: a file cut short under the real name is
                    // indistinguishable from a finished one to whoever opens it next.
                    let closed = writer.finish().await;
                    if closed.is_ok() {
                        let _ = client.delete_file(tree, &file.remote).await;
                        return Outcome::Failed(TRANSFER_CANCELLED.to_string());
                    }
                    return Outcome::Lost(TRANSFER_CANCELLED.to_string());
                }
                let read = step!(local(
                    source.read(&mut buffer).await.map_err(|e| format!("Couldn't read {}: {e}", file.local))
                ));
                if read == 0 {
                    break;
                }
                step!(attempt(&format!("write {}", file.remote), writer.write_chunk(&buffer[..read]).await));
                done += read as u64;
                if last.elapsed() >= PROGRESS_INTERVAL {
                    last = std::time::Instant::now();
                    progress(app, id, &file.name, done, total, index as u64, files.len() as u64);
                }
            }
            // Mandatory, not tidiness: this is what flushes and closes the handle, and a writer
            // dropped without it leaves a truncated file that looks finished.
            step!(attempt(&format!("finish {}", file.remote), writer.finish().await));
            progress(app, id, &file.name, done, total, index as u64 + 1, files.len() as u64);
        }
        Outcome::Done(())
    })
    .await
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let (share, inner) = split_share(path)
        .ok_or_else(|| "A folder goes inside a share — the root is the list of them.".to_string())?;
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut guard = session.lock().await;
        let Session { client, trees } = &mut *guard;
        let tree = step!(tree(client, trees, share).await);
        attempt(&format!("create {path}"), client.create_directory(tree, inner).await)
    })
    .await
}

/// Deletes a file or an empty directory. Not recursive, for the reason [`super::files::remove`]
/// gives.
pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let Some((share, inner)) = split_share(path) else {
        // A share is the server's configuration, not a directory entry. Saying so is the point:
        // `DELETE` on the root would otherwise fail with something about a path.
        return Err("A share can't be deleted from here — it's set up on the server.".into());
    };
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut guard = session.lock().await;
        let Session { client, trees } = &mut *guard;
        let tree = step!(tree(client, trees, share).await);
        let removed = if is_dir {
            client.delete_directory(tree, inner).await
        } else {
            client.delete_file(tree, inner).await
        };
        attempt(&format!("remove {path}"), removed)
    })
    .await
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let (Some((share, source)), Some((target_share, target))) = (split_share(from), split_share(to))
    else {
        return Err("A share can't be renamed from here — it's set up on the server.".into());
    };
    // SMB renames within one tree handle. Across shares it is a copy and a delete, which is not
    // what the user asked for and not what they would want done silently.
    if share != target_share {
        return Err(format!(
            "Moving between shares isn't a rename — copy it into {target_share} instead."
        ));
    }
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut guard = session.lock().await;
        let Session { client, trees } = &mut *guard;
        let tree = step!(tree(client, trees, share).await);
        attempt(&format!("rename {from}"), client.rename(tree, source, target).await)
    })
    .await
}

// ---------------------------------------------------------------------------
// Paths, shares and errors
// ---------------------------------------------------------------------------

/// Splits `/share/some/path` into the share and the path inside it. `None` for the root, which is
/// the list of shares and belongs to no share.
///
/// Its own function, and tested, because every verb above starts with it: an off-by-one here would
/// send a listing of `Documents` the path `Documents/…` and get back "object name not found" from
/// a server that was perfectly willing.
pub(super) fn split_share(path: &str) -> Option<(&str, &str)> {
    let trimmed = path.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.split_once('/') {
        Some((share, rest)) => Some((share, rest.trim_end_matches('/'))),
        None => Some((trimmed, "")),
    }
}

/// The open tree for a share, connecting on first use.
async fn tree<'a>(
    client: &mut SmbClient,
    trees: &'a mut HashMap<String, Tree>,
    share: &str,
) -> Outcome<&'a mut Tree> {
    if !trees.contains_key(share) {
        let opened = step!(attempt(&format!("open the share {share}"), client.connect_share(share).await));
        trees.insert(share.to_string(), opened);
    }
    local(trees.get_mut(share).ok_or_else(|| format!("{share} is not open")))
}

/// Every file under `remote`, paired with where it lands locally. A plain file is one entry.
async fn plan_download(
    client: &mut SmbClient,
    trees: &mut HashMap<String, Tree>,
    share: &str,
    remote: &str,
    local_path: &str,
) -> Outcome<Vec<Planned>> {
    // `handle`, not `tree`: a binding of that name would shadow the function of that name, and the
    // second call below — inside the loop — would then be calling a `&mut Tree`.
    let handle = step!(tree(client, trees, share).await);
    let info = step!(attempt(&format!("read {remote}"), client.stat(handle, remote).await));
    let name = remote.rsplit('/').next().unwrap_or(remote).to_string();

    if !info.is_directory {
        return Outcome::Done(vec![Planned {
            remote: remote.to_string(),
            local: local_path.to_string(),
            name,
            size: info.size,
        }]);
    }

    let mut planned = Vec::new();
    let mut queue = vec![(remote.to_string(), std::path::PathBuf::from(local_path))];
    while let Some((dir, into)) = queue.pop() {
        let handle = step!(tree(client, trees, share).await);
        let entries = step!(attempt(&format!("list {dir}"), client.list_directory(handle, &dir).await));
        for entry in entries {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let remote = join(&dir, &entry.name);
            let local = into.join(&entry.name);
            if entry.is_directory {
                queue.push((remote, local));
            } else {
                planned.push(Planned {
                    remote,
                    local: local.to_string_lossy().to_string(),
                    name: entry.name,
                    size: entry.size,
                });
            }
        }
    }
    Outcome::Done(planned)
}

/// Unix epoch seconds from an SMB `FILETIME`, or 0 when the server left it unset.
fn seconds(time: smb2::pack::filetime::FileTime) -> u64 {
    time.to_system_time()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// The library's error in a sentence that names what was being done.
///
/// `smb2`'s `Display` is accurate and bare — "STATUS_ACCESS_DENIED" tells a user nothing about
/// which of their two hosts refused what. The operation is the half only the caller knows.
fn explain(operation: &str, error: smb2::Error) -> String {
    format!("Couldn't {operation}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lost connection or an expired session is a session to drop; the server refusing is not.
    #[test]
    fn only_a_connection_that_is_gone_is_dropped() {
        assert!(lost(&smb2::Error::Disconnected));
        assert!(lost(&smb2::Error::Timeout));
        assert!(lost(&smb2::Error::SessionExpired));
        assert!(!lost(&smb2::Error::Auth { message: "logon failure".into() }));
        assert!(!lost(&smb2::Error::invalid_data("bad name")));
    }

    #[test]
    fn the_root_belongs_to_no_share() {
        assert_eq!(split_share(""), None);
        assert_eq!(split_share("/"), None);
    }

    #[test]
    fn a_bare_share_has_an_empty_path_inside_it() {
        assert_eq!(split_share("/Documents"), Some(("Documents", "")));
    }

    #[test]
    fn a_path_keeps_its_separators_inside_the_share() {
        assert_eq!(split_share("/Documents/reports/q3.pdf"), Some(("Documents", "reports/q3.pdf")));
    }

    /// The browser hands back whatever it was given, and a directory row it built by joining ends
    /// in a separator often enough that the server must never see one.
    #[test]
    fn a_trailing_separator_is_not_part_of_the_path() {
        assert_eq!(split_share("/Documents/reports/"), Some(("Documents", "reports")));
    }
}
