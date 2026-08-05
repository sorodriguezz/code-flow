//! The file browser's one entry point, and the vocabulary every transport answers in.
//!
//! **Why this file exists.** There are now two ways to reach a file on another machine — SFTP over
//! the user's `ssh` ([`super::sftp`]) and FTP/FTPS over a socket of its own ([`super::ftp`]) — and
//! exactly one dual-pane browser in front of them. Without a layer here, that browser would carry
//! an `if kind == ftp` at every one of its seven call sites, and the two transports would drift
//! apart in the small ways that make a UI feel different depending on what it is pointed at.
//!
//! So the split is: the types and the transport-independent work live here, each transport
//! implements the same seven verbs, and [`list`]/[`download`]/[`upload`]/[`make_dir`]/[`remove`]/
//! [`rename`]/[`close`] pick one by [`RemoteKind`]. The command layer — and therefore the
//! frontend — only ever sees this module.
//!
//! **What is shared is not an accident.** [`RemoteFile`] is deliberately the shape *both* remote
//! transports and the local pane produce ([`list_local`]): one shape means one renderer, and a
//! dual-pane browser whose halves are drawn by different code is a dual-pane browser whose halves
//! drift. [`pump`] is shared for the sharper reason that a progress bar that behaves differently
//! per protocol is a progress bar the user learns to distrust.

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{RemoteHostSpec, RemoteKind};

/// One entry in a directory, wherever that directory is.
///
/// `permissions` is the `drwxr-xr-x` string rather than a mode integer: it is what the user reads,
/// it is what `ls -l` shows them, and rendering it here means the frontend never has to know about
/// octal modes. FTP servers that report no mode at all leave it empty rather than inventing one.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteFile {
    pub name: String,
    /// Absolute path on the far side, so the frontend never has to join paths itself and get the
    /// separator wrong.
    pub path: String,
    pub is_dir: bool,
    /// A symlink is neither, and saying so matters: following one into a directory works, but
    /// downloading one copies the link's target, not the link.
    pub is_link: bool,
    pub size: u64,
    /// Unix epoch seconds, or 0 when the server didn't say.
    pub modified: u64,
    pub permissions: String,
}

/// A directory, and where it is.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteListing {
    pub path: String,
    pub entries: Vec<RemoteFile>,
}

/// How much of a transfer is done, as the UI sees it.
///
/// `total` is the *whole* transfer, not the current file: a folder of two hundred files should
/// show one bar that fills once, and a bar that resets per file is a bar that lies about how long
/// this will take.
#[derive(Clone, Serialize)]
pub struct TransferProgress {
    /// Which transfer this belongs to — the frontend runs one at a time, but an event that didn't
    /// say would be indistinguishable from a stale one arriving late.
    pub id: String,
    /// The file currently moving, for the label.
    pub name: String,
    pub done: u64,
    pub total: u64,
    /// Files finished so far, and how many there are. Meaningless for a single file, which is why
    /// the UI only shows it when `files > 1`.
    pub file_index: u64,
    pub files: u64,
}

/// How often progress is emitted while a file is moving.
///
/// Every chunk would be thousands of events for a large file — each one an IPC hop and a React
/// render — for a bar that cannot move by a visible amount that often.
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

/// The size of one read/write. Large enough that the syscall overhead disappears, small enough that
/// progress still moves smoothly on a slow link.
const CHUNK: usize = 64 * 1024;

/// One file's worth of a transfer, resolved before any byte moves.
pub(super) struct Planned {
    pub remote: String,
    pub local: String,
    pub name: String,
    pub size: u64,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Lists a directory. An empty `path` means the login directory, which is where a browser should
/// open — resolved by the server, not a guess at `/home/<user>`.
pub async fn list(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
) -> Result<RemoteListing, String> {
    match spec.kind {
        RemoteKind::Ssh | RemoteKind::Sftp => super::sftp::list(host_id, spec, path).await,
        RemoteKind::Ftp | RemoteKind::Ftps => super::ftp::list(host_id, spec, path).await,
    }
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
    match spec.kind {
        RemoteKind::Ssh | RemoteKind::Sftp => {
            super::sftp::download(app, id, host_id, spec, remote_path, local_path).await
        }
        RemoteKind::Ftp | RemoteKind::Ftps => {
            super::ftp::download(app, id, host_id, spec, remote_path, local_path).await
        }
    }
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
    match spec.kind {
        RemoteKind::Ssh | RemoteKind::Sftp => {
            super::sftp::upload(app, id, host_id, spec, local_path, remote_path).await
        }
        RemoteKind::Ftp | RemoteKind::Ftps => {
            super::ftp::upload(app, id, host_id, spec, local_path, remote_path).await
        }
    }
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    match spec.kind {
        RemoteKind::Ssh | RemoteKind::Sftp => super::sftp::make_dir(host_id, spec, path).await,
        RemoteKind::Ftp | RemoteKind::Ftps => super::ftp::make_dir(host_id, spec, path).await,
    }
}

/// Deletes a file or an empty directory.
///
/// Deliberately not recursive, on either transport. A recursive remote delete is the single most
/// destructive thing a file browser can offer, it cannot be undone, and there is no trash on the
/// far side to fall back on.
pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    match spec.kind {
        RemoteKind::Ssh | RemoteKind::Sftp => super::sftp::remove(host_id, spec, path, is_dir).await,
        RemoteKind::Ftp | RemoteKind::Ftps => super::ftp::remove(host_id, spec, path, is_dir).await,
    }
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    match spec.kind {
        RemoteKind::Ssh | RemoteKind::Sftp => super::sftp::rename(host_id, spec, from, to).await,
        RemoteKind::Ftp | RemoteKind::Ftps => super::ftp::rename(host_id, spec, from, to).await,
    }
}

/// Drops whatever session this host was holding.
///
/// Both transports rather than the one the current spec names, and on purpose: this is called when
/// a tab closes or a host is edited, and editing is exactly when the kind may have *just* changed.
/// Closing only the new kind's session would strand the old one open until the process exits.
pub async fn close(host_id: &str) {
    super::sftp::close(host_id).await;
    super::ftp::close(host_id).await;
}

// ---------------------------------------------------------------------------
// Shared work
// ---------------------------------------------------------------------------

/// Copies one stream to another, emitting progress on a timer rather than per chunk.
#[allow(clippy::too_many_arguments)]
pub(super) async fn pump<R, W>(
    app: &tauri::AppHandle,
    id: &str,
    source: &mut R,
    target: &mut W,
    name: &str,
    done: &mut u64,
    total: u64,
    file_index: u64,
    files: u64,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tauri::Emitter;
    let mut buffer = vec![0u8; CHUNK];
    let mut last = std::time::Instant::now();
    loop {
        let read = source.read(&mut buffer).await.map_err(|e| format!("Couldn't read {name}: {e}"))?;
        if read == 0 {
            break;
        }
        target
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Couldn't write {name}: {e}"))?;
        *done += read as u64;
        if last.elapsed() >= PROGRESS_INTERVAL {
            last = std::time::Instant::now();
            let _ = app.emit(
                "remote:transfer",
                TransferProgress {
                    id: id.to_string(),
                    name: name.to_string(),
                    done: *done,
                    total,
                    file_index,
                    files,
                },
            );
        }
    }
    // A final event on every file, so the bar reaches the end rather than stopping wherever the
    // last tick happened to land.
    let _ = app.emit(
        "remote:transfer",
        TransferProgress {
            id: id.to_string(),
            name: name.to_string(),
            done: *done,
            total,
            file_index: file_index + 1,
            files,
        },
    );
    Ok(())
}

/// Walks *this* side, collecting every file under `local_path` and where each one lands.
///
/// Shared by both transports because it never touches either: it reads the local filesystem and
/// joins remote paths with `/`, which is true of SFTP and FTP alike. Synchronous — `std::fs` is
/// fast enough locally that making it async buys nothing but a `spawn_blocking`.
pub(super) fn plan_upload(local_path: &str, remote_path: &str) -> Result<Vec<Planned>, String> {
    let path = std::path::Path::new(local_path);
    let metadata = std::fs::metadata(path).map_err(|e| format!("Couldn't read {local_path}: {e}"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

    if !metadata.is_dir() {
        return Ok(vec![Planned {
            remote: remote_path.to_string(),
            local: local_path.to_string(),
            name,
            size: metadata.len(),
        }]);
    }

    let mut planned = Vec::new();
    let mut queue = vec![(path.to_path_buf(), remote_path.to_string())];
    while let Some((dir, into)) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            let remote = join(&into, &name);
            let local = entry.path().to_string_lossy().to_string();
            if metadata.is_dir() {
                queue.push((entry.path(), remote));
            } else {
                planned.push(Planned { remote, local, name, size: metadata.len() });
            }
        }
    }
    Ok(planned)
}

/// Sorts a listing the way every file browser does: directories first, then by name.
///
/// Applied in the backend rather than the UI so both panes of a dual-pane view agree without
/// coordinating — and so a listing from FTP arrives in the same order as one from SFTP, whatever
/// order the server happened to send it in.
pub(super) fn sort_entries(entries: &mut [RemoteFile]) {
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// Joins a directory and a name with `/`.
///
/// Always `/`, never the host platform's separator: this is a *remote* path, and both SFTP and FTP
/// paths are `/`-separated even when the server is Windows — OpenSSH for Windows serves
/// `C:/Users/...`, and an IIS FTP server serves `/`-rooted paths regardless of the drive behind it.
pub(super) fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The `drwxr-xr-x` string from a Unix mode, with `kind` as the leading character.
pub(super) fn mode_string(kind: char, mode: u32) -> String {
    let bit = |shift: u32, ch: char| if mode >> shift & 1 == 1 { ch } else { '-' };
    format!(
        "{kind}{}{}{}{}{}{}{}{}{}",
        bit(8, 'r'), bit(7, 'w'), bit(6, 'x'),
        bit(5, 'r'), bit(4, 'w'), bit(3, 'x'),
        bit(2, 'r'), bit(1, 'w'), bit(0, 'x'),
    )
}

// ---------------------------------------------------------------------------
// The local pane
// ---------------------------------------------------------------------------

/// The *local* side of the dual pane, in the same shape as the remote side.
///
/// One shape rather than two, so a single component renders both columns. The alternative — a local
/// type and a remote type that happen to have the same fields — is two renderers that drift, and a
/// dual-pane browser whose halves look subtly different is worse than one that looks the same.
///
/// `fsops::list_dir` is repo-scoped and can't serve this: the local half of a file transfer starts
/// at your home directory and goes anywhere.
pub fn list_local(path: &str) -> Result<RemoteListing, String> {
    let target = if path.trim().is_empty() {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
    } else {
        std::path::PathBuf::from(path)
    };
    // Canonicalized for the same reason the remote side is: the breadcrumb is built from the reply,
    // so a `..` must be resolved here rather than guessed at by the UI. `dunce` undoes Windows'
    // verbatim `\\?\C:\…` prefix, which is a path Rust reads happily and nothing else does.
    let target = dunce::canonicalize(&target)
        .map_err(|e| format!("Couldn't read {}: {e}", target.display()))?;

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&target).map_err(|e| format!("Couldn't read {}: {e}", target.display()))? {
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(RemoteFile {
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            is_link: entry.file_type().map(|t| t.is_symlink()).unwrap_or(false),
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            permissions: local_permissions(&metadata),
            name,
        });
    }
    sort_entries(&mut entries);

    Ok(RemoteListing { path: target.to_string_lossy().to_string(), entries })
}

/// The permission string for a local entry.
///
/// Unix has a mode to render; Windows has no such thing, so it gets the one bit it does have. A
/// fabricated `drwxr-xr-x` on Windows would be a lie dressed as detail.
#[cfg(unix)]
fn local_permissions(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    mode_string(
        if metadata.is_dir() { 'd' } else { '-' },
        metadata.permissions().mode(),
    )
}

#[cfg(not(unix))]
fn local_permissions(metadata: &std::fs::Metadata) -> String {
    if metadata.permissions().readonly() { "read-only".into() } else { String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_join_with_a_forward_slash_whatever_this_machine_uses() {
        assert_eq!(join("/srv", "app"), "/srv/app");
        assert_eq!(join("/", "etc"), "/etc");
        // An OpenSSH-for-Windows server serves paths in this shape, and they are still `/`-joined.
        assert_eq!(join("C:/Users/sam", "Desktop"), "C:/Users/sam/Desktop");
    }

    #[test]
    fn a_mode_renders_the_string_ls_would_have_printed() {
        assert_eq!(mode_string('d', 0o755), "drwxr-xr-x");
        assert_eq!(mode_string('-', 0o644), "-rw-r--r--");
        assert_eq!(mode_string('l', 0o777), "lrwxrwxrwx");
        assert_eq!(mode_string('-', 0o000), "----------");
    }

    #[test]
    fn the_local_pane_lists_directories_first_then_by_name() {
        let dir = std::env::temp_dir().join(format!("cf-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("zeta")).unwrap();
        std::fs::create_dir_all(dir.join("alpha")).unwrap();
        std::fs::write(dir.join("Beta.txt"), b"hello").unwrap();
        std::fs::write(dir.join("aardvark.txt"), b"hi").unwrap();

        let listing = list_local(&dir.to_string_lossy()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["alpha", "zeta", "aardvark.txt", "Beta.txt"]);

        let file = listing.entries.iter().find(|e| e.name == "Beta.txt").unwrap();
        assert_eq!(file.size, 5);
        assert!(!file.is_dir);
        assert!(file.path.ends_with("Beta.txt"));
        #[cfg(unix)]
        assert!(file.permissions.starts_with('-'), "{}", file.permissions);
        #[cfg(unix)]
        assert!(
            listing.entries[0].permissions.starts_with('d'),
            "{}",
            listing.entries[0].permissions
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_path_means_the_home_directory_not_the_process_cwd() {
        let listing = list_local("").unwrap();
        let home = dunce::canonicalize(dirs::home_dir().unwrap()).unwrap();
        assert_eq!(listing.path, home.to_string_lossy());
    }

    #[test]
    fn an_upload_plan_of_a_tree_names_every_file_and_where_it_lands() {
        let dir = std::env::temp_dir().join(format!("cf-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("top.txt"), b"1234").unwrap();
        std::fs::write(dir.join("nested/deep.txt"), b"12345").unwrap();

        let mut planned = plan_upload(&dir.to_string_lossy(), "/srv/app").unwrap();
        planned.sort_by(|a, b| a.remote.cmp(&b.remote));
        let remotes: Vec<&str> = planned.iter().map(|p| p.remote.as_str()).collect();
        assert_eq!(remotes, ["/srv/app/nested/deep.txt", "/srv/app/top.txt"]);
        assert_eq!(planned.iter().map(|p| p.size).sum::<u64>(), 9);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A single file uploads to the path it was given, not into it — the difference between
    /// `put a.txt /srv/b.txt` and `put a.txt /srv/b.txt/a.txt`.
    #[test]
    fn a_single_file_plan_targets_the_path_it_was_given() {
        let dir = std::env::temp_dir().join(format!("cf-plan1-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("one.txt");
        std::fs::write(&file, b"hi").unwrap();

        let planned = plan_upload(&file.to_string_lossy(), "/srv/renamed.txt").unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].remote, "/srv/renamed.txt");
        assert_eq!(planned[0].name, "one.txt");

        std::fs::remove_dir_all(&dir).ok();
    }
}
