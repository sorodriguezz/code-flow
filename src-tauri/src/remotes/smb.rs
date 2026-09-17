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

use std::collections::HashMap;
use std::sync::Arc;

use smb2::{SmbClient, Tree};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::files::{
    join, plan_upload, progress, sort_entries, Planned, RemoteFile, RemoteListing, CHUNK,
    PROGRESS_INTERVAL,
};
use super::RemoteHostSpec;

/// One host's connection, and the shares it has opened through it.
struct Session {
    client: SmbClient,
    /// Keyed by share name. A [`Tree`] is a handle the server issued, not a path — dropping one to
    /// re-open it per listing would be a `TREE_CONNECT` per click.
    trees: HashMap<String, Tree>,
}

type Sessions = Mutex<HashMap<String, Arc<Mutex<Session>>>>;

fn sessions() -> &'static Sessions {
    static SESSIONS: std::sync::OnceLock<Sessions> = std::sync::OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The session for this host, opening one if there isn't a live one.
async fn session(host_id: &str, spec: &RemoteHostSpec) -> Result<Arc<Mutex<Session>>, String> {
    if let Some(existing) = sessions().lock().await.get(host_id).cloned() {
        return Ok(existing);
    }
    let opened = Arc::new(Mutex::new(Session {
        client: connect(host_id, spec).await?,
        trees: HashMap::new(),
    }));
    sessions().lock().await.insert(host_id.to_string(), opened.clone());
    Ok(opened)
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

/// Closes a host's file session. Idempotent — what disconnecting and deleting both call.
///
/// `TREE_DISCONNECT` and `LOGOFF` are not sent, for [`super::ftp::close`]'s reason: they need the
/// lock and a round trip on a socket that may already be dead, and dropping the client closes the
/// connection either way.
pub async fn close(host_id: &str) {
    sessions().lock().await.remove(host_id);
}

/// Every host currently holding a connection, for [`super::hold`] to report.
pub async fn open_hosts() -> Vec<String> {
    sessions().lock().await.keys().cloned().collect()
}

/// Drops every host's connection — the exit path's.
pub async fn close_all() {
    sessions().lock().await.clear();
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
    let session = session(host_id, spec).await?;
    let mut guard = session.lock().await;

    let Some((share, inner)) = split_share(path) else {
        return shares(&mut guard.client).await;
    };

    let Session { client, trees } = &mut *guard;
    let tree = tree(client, trees, share).await?;
    let found = client
        .list_directory(tree, inner)
        .await
        .map_err(|e| explain(&format!("list {path}"), e))?;

    let base = join("", share);
    let mut entries = found
        .into_iter()
        // `.` and `..` are the server's, not the user's: the browser has its own way up, and a row
        // that walks into itself is a row that can only confuse.
        .filter(|entry| entry.name != "." && entry.name != "..")
        .map(|entry| RemoteFile {
            path: join(&join(&base, inner), &entry.name),
            is_dir: entry.is_directory,
            size: entry.size,
            modified: seconds(entry.modified),
            // SMB carries DOS attributes, not a POSIX mode. Left empty rather than translated into
            // an `rwxr-xr-x` that would be invented — see `RemoteFile::permissions`.
            name: entry.name,
            ..Default::default()
        })
        .collect::<Vec<_>>();
    sort_entries(&mut entries);

    Ok(RemoteListing { path: join(&base, inner), entries, ..Default::default() })
}

/// The server's shares, as the root directory.
///
/// Administrative shares are left out: `IPC$` is not a filesystem at all, and `C$`/`ADMIN$` are
/// whole-disk back doors that need an admin session and answer with an error for everyone else. A
/// row nobody can open is worse than no row.
async fn shares(client: &mut SmbClient) -> Result<RemoteListing, String> {
    let found = client.list_shares().await.map_err(|e| explain("list the server's shares", e))?;
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
    Ok(RemoteListing { path: "/".into(), entries, ..Default::default() })
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
    let session = session(host_id, spec).await?;
    let mut guard = session.lock().await;
    let Session { client, trees } = &mut *guard;

    let (share, inner) = split_share(remote_path)
        .ok_or_else(|| "Pick a share to download from — the root is the list of them.".to_string())?;
    let files = plan_download(client, trees, share, inner, local_path).await?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        if let Some(parent) = std::path::Path::new(&file.local).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let mut target = tokio::fs::File::create(&file.local)
            .await
            .map_err(|e| format!("Couldn't write {}: {e}", file.local))?;

        // The crate's own chunking rather than a `pump` over an `AsyncRead`: a download here is a
        // sliding window of overlapping READs (that is the crate's whole point), and an
        // `AsyncRead` facade would serialize it back into one request at a time.
        let tree = trees.get(share).ok_or_else(|| format!("{share} is not open"))?;
        let mut stream = client
            .download(tree, &file.remote)
            .await
            .map_err(|e| explain(&format!("open {}", file.remote), e))?;
        let mut last = std::time::Instant::now();
        while let Some(chunk) = stream.next_chunk().await {
            let bytes = chunk.map_err(|e| explain(&format!("read {}", file.remote), e))?;
            target
                .write_all(&bytes)
                .await
                .map_err(|e| format!("Couldn't write {}: {e}", file.local))?;
            done += bytes.len() as u64;
            if last.elapsed() >= PROGRESS_INTERVAL {
                last = std::time::Instant::now();
                progress(app, id, &file.name, done, total, index as u64, files.len() as u64);
            }
        }
        // Flushed before the next file, so a transfer that dies half way leaves what it claimed.
        target.flush().await.map_err(|e| format!("Couldn't write {}: {e}", file.local))?;
        progress(app, id, &file.name, done, total, index as u64 + 1, files.len() as u64);
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
    let mut guard = session.lock().await;
    let Session { client, trees } = &mut *guard;

    let (share, inner) = split_share(remote_path)
        .ok_or_else(|| "Pick a share to upload into — the root is the list of them.".to_string())?;
    let tree = tree(client, trees, share).await?;
    let files = plan_upload(local_path, inner)?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        // Created before the file that goes in it, and an existing directory is not an error — an
        // interrupted transfer resumed by re-running it must not fail on its own leftovers.
        if let Some((parent, _)) = file.remote.rsplit_once('/') {
            if !parent.is_empty() {
                let _ = client.create_directory(tree, parent).await;
            }
        }
        let mut source = tokio::fs::File::open(&file.local)
            .await
            .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;

        // `create_file_writer` and not `upload`, which takes the file as one `&[u8]`: that would
        // read a 40 GB disk image into memory to send it.
        let mut writer = client
            .create_file_writer(tree, &file.remote)
            .await
            .map_err(|e| explain(&format!("create {}", file.remote), e))?;
        let mut buffer = vec![0u8; CHUNK];
        let mut last = std::time::Instant::now();
        loop {
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;
            if read == 0 {
                break;
            }
            writer
                .write_chunk(&buffer[..read])
                .await
                .map_err(|e| explain(&format!("write {}", file.remote), e))?;
            done += read as u64;
            if last.elapsed() >= PROGRESS_INTERVAL {
                last = std::time::Instant::now();
                progress(app, id, &file.name, done, total, index as u64, files.len() as u64);
            }
        }
        // Mandatory, not tidiness: this is what flushes and closes the handle, and a writer dropped
        // without it leaves a truncated file that looks finished.
        writer
            .finish()
            .await
            .map_err(|e| explain(&format!("finish {}", file.remote), e))?;
        progress(app, id, &file.name, done, total, index as u64 + 1, files.len() as u64);
    }
    Ok(())
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut guard = session.lock().await;
    let Session { client, trees } = &mut *guard;

    let (share, inner) = split_share(path)
        .ok_or_else(|| "A folder goes inside a share — the root is the list of them.".to_string())?;
    let tree = tree(client, trees, share).await?;
    client
        .create_directory(tree, inner)
        .await
        .map_err(|e| explain(&format!("create {path}"), e))
}

/// Deletes a file or an empty directory. Not recursive, for the reason [`super::files::remove`]
/// gives.
pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut guard = session.lock().await;
    let Session { client, trees } = &mut *guard;

    let Some((share, inner)) = split_share(path) else {
        // A share is the server's configuration, not a directory entry. Saying so is the point:
        // `DELETE` on the root would otherwise fail with something about a path.
        return Err("A share can't be deleted from here — it's set up on the server.".into());
    };
    let tree = tree(client, trees, share).await?;
    if is_dir {
        client.delete_directory(tree, inner).await
    } else {
        client.delete_file(tree, inner).await
    }
    .map_err(|e| explain(&format!("remove {path}"), e))
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut guard = session.lock().await;
    let Session { client, trees } = &mut *guard;

    let (Some((share, source)), Some((target_share, target))) =
        (split_share(from), split_share(to))
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
    let tree = tree(client, trees, share).await?;
    client
        .rename(tree, source, target)
        .await
        .map_err(|e| explain(&format!("rename {from}"), e))
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
) -> Result<&'a mut Tree, String> {
    if !trees.contains_key(share) {
        let opened = client
            .connect_share(share)
            .await
            .map_err(|e| explain(&format!("open the share {share}"), e))?;
        trees.insert(share.to_string(), opened);
    }
    trees.get_mut(share).ok_or_else(|| format!("{share} is not open"))
}

/// Every file under `remote`, paired with where it lands locally. A plain file is one entry.
async fn plan_download(
    client: &mut SmbClient,
    trees: &mut HashMap<String, Tree>,
    share: &str,
    remote: &str,
    local: &str,
) -> Result<Vec<Planned>, String> {
    // `handle`, not `tree`: a binding of that name would shadow the function of that name, and the
    // second call below — inside the loop — would then be calling a `&mut Tree`.
    let handle = tree(client, trees, share).await?;
    let info = client
        .stat(handle, remote)
        .await
        .map_err(|e| explain(&format!("read {remote}"), e))?;
    let name = remote.rsplit('/').next().unwrap_or(remote).to_string();

    if !info.is_directory {
        return Ok(vec![Planned {
            remote: remote.to_string(),
            local: local.to_string(),
            name,
            size: info.size,
        }]);
    }

    let mut planned = Vec::new();
    let mut queue = vec![(remote.to_string(), std::path::PathBuf::from(local))];
    while let Some((dir, into)) = queue.pop() {
        let handle = tree(client, trees, share).await?;
        let entries = client
            .list_directory(handle, &dir)
            .await
            .map_err(|e| explain(&format!("list {dir}"), e))?;
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
    Ok(planned)
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
