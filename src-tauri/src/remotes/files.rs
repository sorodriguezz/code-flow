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
///
/// **The last two fields are what a filesystem has no answer for.** A directory listing over SFTP
/// has a mode and no content type; an object store has a content type, a storage tier and no mode
/// at all. Rather than two shapes and two browsers, every source fills what it knows and leaves the
/// rest empty — and the browser draws a column only when something in the listing filled it.
#[derive(Debug, Clone, Default, Serialize)]
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
    /// The MIME type the store has recorded — `application/json`, `image/png`. Empty for anything
    /// that keeps no such thing, which is every real filesystem.
    pub content_type: String,
    /// The storage tier: `Hot`, `Cool`, `Archive`. Empty where the concept does not exist. Worth a
    /// column of its own because it is the field that decides what a download *costs* — an archived
    /// blob cannot be read at all until it is rehydrated.
    pub tier: String,
    /// `BlockBlob`, `PageBlob`, `AppendBlob`. Not decoration: a page blob is a VM disk and an
    /// append blob is a log, and neither takes the ordinary overwrite this browser's upload does.
    pub blob_type: String,
    /// `available`, `leased`, `broken`… A leased blob refuses writes with a 412 that says nothing
    /// about a lease, so the column is the only warning there is before trying.
    pub lease_state: String,
}

/// A directory, and where it is.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RemoteListing {
    pub path: String,
    pub entries: Vec<RemoteFile>,
    /// Where the next page starts, opaque and belonging to whoever issued it. Empty means this was
    /// the whole directory.
    ///
    /// **A store is not a directory and cannot be read like one.** A container can hold millions of
    /// blobs; the browser used to follow every continuation token before drawing a single row, so a
    /// real container was a hang with no progress and no way out. One page at a time is the only
    /// honest shape, and it is why every object browser ever written has a "load more".
    pub next: String,
}

/// Which slice of a directory to fetch.
///
/// Both fields are the *service's* job wherever the service has one: a prefix filter run here would
/// mean paging through a million names to show three, which is the failure this type exists to
/// prevent. Transports with no such thing (SFTP, FTP) get the prefix applied by the dispatcher and
/// ignore the marker, because a directory listing over SFTP arrives whole or not at all.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct ListPage {
    /// Only entries whose name starts with this, within the directory being listed.
    pub prefix: String,
    /// The `next` of the page before this one. Empty starts at the beginning.
    pub marker: String,
}

/// How many entries one page holds.
///
/// Storage Explorer shows 100. 200 is the same idea with fewer round trips on the wide grid this
/// app draws — small enough that the first page is instant on any container.
pub const PAGE: usize = 200;

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

/// Which of the two file transports a kind lands on — and whether it has one at all.
///
/// Six entry points below ask the same question, so it is answered once, and this is also the whole
/// of the files half of the capability table (the other three live on [`RemoteKind`] itself). A
/// screen host has pixels and no filesystem behind them, and this is the line it stops at — in the
/// backend, where a wrong `if` in the UI cannot get past it.
enum Transport {
    /// SSH's SFTP subsystem — [`RemoteKind::Ssh`] and [`RemoteKind::Sftp`].
    Sftp,
    /// A socket of its own — [`RemoteKind::Ftp`] and [`RemoteKind::Ftps`].
    Ftp,
    /// Signed HTTPS against a bucket — [`RemoteKind::S3`].
    S3,
    /// Signed HTTPS against an Azure Storage account — every Azure kind.
    ///
    /// One arm for all of them, not one per service: [`super::cloud::account`] picks blob storage
    /// or a file share from the first segment of the path, so the kind no longer decides which
    /// filesystem a request lands on. The legacy single-service kinds come through here too — the
    /// credential is the *account's* either way, and routing them separately would leave a row
    /// saved as `azure_blob` unable to open the account panel it now opens into.
    Azure,
}

fn transport(spec: &RemoteHostSpec) -> Result<Transport, String> {
    match spec.kind {
        RemoteKind::Ssh | RemoteKind::Sftp => Ok(Transport::Sftp),
        RemoteKind::Ftp | RemoteKind::Ftps => Ok(Transport::Ftp),
        RemoteKind::S3 => Ok(Transport::S3),
        RemoteKind::Azure
        | RemoteKind::AzureBlob
        | RemoteKind::AzureFiles
        | RemoteKind::AzureQueue
        | RemoteKind::AzureTable => Ok(Transport::Azure),
        // Spelled out rather than left to a `_`, so a kind added later is a compile error here
        // instead of a host quietly inheriting somebody else's file transport.
        RemoteKind::Vnc | RemoteKind::Rdp => Err(spec.kind.refuses("browse files")),
    }
}

/// Lists a directory. An empty `path` means the login directory, which is where a browser should
/// open — resolved by the server, not a guess at `/home/<user>`.
pub async fn list(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    page: &ListPage,
) -> Result<RemoteListing, String> {
    match transport(spec)? {
        // The two that arrive whole. The prefix is honoured here rather than refused, so the
        // browser's search box means the same thing on every kind of host — it is only the *cost*
        // that differs, and on a directory that already came over the wire the cost is nothing.
        Transport::Sftp => filtered(super::sftp::list(host_id, spec, path).await?, page),
        Transport::Ftp => filtered(super::ftp::list(host_id, spec, path).await?, page),
        Transport::S3 => super::cloud::s3::list(host_id, spec, path, page).await,
        Transport::Azure => super::cloud::account::list(host_id, spec, path, page).await,
    }
}

/// Applies a prefix to a listing that arrived whole. Case-insensitive, unlike the services' own —
/// which are not, and cannot be asked to be.
fn filtered(mut listing: RemoteListing, page: &ListPage) -> Result<RemoteListing, String> {
    let prefix = page.prefix.trim().to_lowercase();
    if !prefix.is_empty() {
        listing.entries.retain(|entry| entry.name.to_lowercase().starts_with(&prefix));
    }
    Ok(listing)
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
    match transport(spec)? {
        Transport::Sftp => super::sftp::download(app, id, host_id, spec, remote_path, local_path).await,
        Transport::Ftp => super::ftp::download(app, id, host_id, spec, remote_path, local_path).await,
        Transport::S3 => super::cloud::s3::download(app, id, host_id, spec, remote_path, local_path).await,
        Transport::Azure => super::cloud::account::download(app, id, host_id, spec, remote_path, local_path).await,
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
    match transport(spec)? {
        Transport::Sftp => super::sftp::upload(app, id, host_id, spec, local_path, remote_path).await,
        Transport::Ftp => super::ftp::upload(app, id, host_id, spec, local_path, remote_path).await,
        Transport::S3 => super::cloud::s3::upload(app, id, host_id, spec, local_path, remote_path).await,
        Transport::Azure => super::cloud::account::upload(app, id, host_id, spec, local_path, remote_path).await,
    }
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    match transport(spec)? {
        Transport::Sftp => super::sftp::make_dir(host_id, spec, path).await,
        Transport::Ftp => super::ftp::make_dir(host_id, spec, path).await,
        Transport::S3 => super::cloud::s3::make_dir(host_id, spec, path).await,
        Transport::Azure => super::cloud::account::make_dir(host_id, spec, path).await,
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
    match transport(spec)? {
        Transport::Sftp => super::sftp::remove(host_id, spec, path, is_dir).await,
        Transport::Ftp => super::ftp::remove(host_id, spec, path, is_dir).await,
        Transport::S3 => super::cloud::s3::remove(host_id, spec, path, is_dir).await,
        Transport::Azure => super::cloud::account::remove(host_id, spec, path, is_dir).await,
    }
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    match transport(spec)? {
        Transport::Sftp => super::sftp::rename(host_id, spec, from, to).await,
        Transport::Ftp => super::ftp::rename(host_id, spec, from, to).await,
        Transport::S3 => super::cloud::s3::rename(host_id, spec, from, to).await,
        Transport::Azure => super::cloud::account::rename(host_id, spec, from, to).await,
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
    // The cloud transports hold nothing, so these are no-ops — called anyway, so that adding state
    // to one of them later is a change in that module rather than a bug here.
    super::cloud::s3::close(host_id).await;
    super::cloud::blob::close(host_id).await;
    super::cloud::share::close(host_id).await;
}

// ---------------------------------------------------------------------------
// Shared work
// ---------------------------------------------------------------------------

/// Emits one progress event.
///
/// [`pump`] does this on a timer while it copies, which covers every transport that can hand its
/// bytes to a stream. Azure Files cannot: its writes are ranged, capped at four mebibytes each, so
/// the unit of progress is a completed request rather than a chunk read. This is the same event in
/// the same shape, reported by whoever *does* know a piece has landed — which is what keeps one bar
/// meaning one thing across five transports.
#[allow(clippy::too_many_arguments)]
pub(super) fn report(
    app: &tauri::AppHandle,
    id: &str,
    name: &str,
    done: u64,
    total: u64,
    file_index: u64,
    files: u64,
) {
    use tauri::Emitter;
    let _ = app.emit(
        "remote:transfer",
        TransferProgress {
            id: id.to_string(),
            name: name.to_string(),
            done,
            total,
            file_index,
            files,
        },
    );
}

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
            ..Default::default()
        });
    }
    sort_entries(&mut entries);

    Ok(RemoteListing { path: target.to_string_lossy().to_string(), entries, ..Default::default() })
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
