//! Fetching a model's weights, resumably, and proving they arrived intact.
//!
//! This is the one place in the app that writes a multi-gigabyte file, and everything here follows
//! from that single fact:
//!
//! - **It never writes to the final name.** Bytes land in `<file>.part` and are renamed into place
//!   only after the digest matches. A `.gguf` that exists is therefore a `.gguf` that is complete
//!   and verified, which is what lets [`super::models::installed`] answer by looking at the
//!   directory instead of keeping a "did it finish?" row that can disagree with the disk.
//! - **It resumes.** Hugging Face answers `accept-ranges: bytes` and honours a Range request with
//!   a 206 (checked against the real endpoint), so an interrupted 8 GB download continues from the
//!   `.part` file rather than starting again. Getting this wrong is not a slow download, it is a
//!   download that can never finish on a connection that drops every twenty minutes.
//! - **It checks the length first.** The digest is authoritative but costs a full re-read of the
//!   file; the expected size is free and catches the overwhelmingly common failure (a truncated
//!   transfer) before the expensive check runs.
//! - **It checks free space before it starts.** Filling the user's disk and *then* failing is the
//!   worst version of this, because the wreckage outlives the error message.
//!
//! Progress reaches the UI the way every other long transfer in this app does — an event emitted
//! on a fixed interval rather than per chunk. See [`crate::remotes::files::pump`], which does the
//! same for SFTP and the cloud transports; this cannot reuse it because that one pumps an
//! `AsyncRead` and reqwest hands out a `Stream<Item = Result<Bytes>>`, and because resuming needs
//! the byte offset threaded through the event.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::catalogue::ModelSpec;

/// The event name the frontend listens on. One event, several phases — see [`Phase`].
pub const EVENT: &str = "localai:download";

/// How often progress is emitted while bytes are moving.
///
/// 250 ms rather than per chunk: a 64 KiB chunk at 50 MB/s is ~760 events a second, each one a
/// serialize plus an IPC hop plus a React render, and none of them tell the user anything the one
/// four frames later would not. Same reasoning and the same order of magnitude as
/// `remotes::files::PROGRESS_INTERVAL`.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Read size. Large enough that the syscall overhead disappears against a gigabit link, small
/// enough that a cancel is noticed promptly.
const CHUNK: usize = 1024 * 1024;

/// Headroom demanded on top of the model's own size before a download is allowed to start.
///
/// A disk with exactly enough room for the file is a disk with no room for anything else — the
/// database, a log, the editor's own buffers — and the failure that produces is not "the download
/// failed", it is the whole app misbehaving in ways nobody connects back to this.
const SPACE_HEADROOM: u64 = 512 * 1024 * 1024;

/// Where a download is in its life. Serialized into [`EVENT`] so one listener can drive the whole
/// row: the bar, the label under it, and the error.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Bytes are moving. `done`/`total` are meaningful.
    Downloading,
    /// The file is complete and is being re-read to check its digest. On an 8 GB model this is not
    /// instant, and a progress bar that sits at 100% for thirty seconds with no explanation reads
    /// as a hang — which is the entire reason this is a phase of its own rather than a silent tail.
    Verifying,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, serde::Serialize)]
pub struct Progress {
    /// The [`ModelSpec::id`] this is about. The settings pane shows every catalogue row at once, so
    /// without this a listener cannot tell which bar to move.
    pub model_id: String,
    pub phase: Phase,
    pub done: u64,
    pub total: u64,
    /// Only on [`Phase::Failed`]. Already a sentence a person can act on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Progress {
    fn new(model_id: &str, phase: Phase, done: u64, total: u64) -> Self {
        Self { model_id: model_id.to_string(), phase, done, total, error: None }
    }
}

/// Fetches `spec` into `dir`, resuming an interrupted attempt, and verifies it before it counts.
///
/// `cancel` is the receiver half of this app's standard cancellation channel — see
/// `crate::api::ApiRegistry::register_cancel`, whose shape this deliberately copies. Firing it
/// stops the transfer and leaves the `.part` file exactly where it is, because the next attempt
/// resumes from it: deleting on cancel would turn "I'll finish this tonight" into "start the eight
/// gigabytes again".
///
/// Returns the path of the finished file.
pub async fn fetch(
    app: &AppHandle,
    spec: &ModelSpec,
    dir: &Path,
    cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<PathBuf, String> {
    let final_path = dir.join(spec.file);
    let part_path = dir.join(format!("{}.part", spec.file));

    // Already there and already verified — `final_path` only ever exists post-verification.
    if final_path.is_file() {
        emit(app, Progress::new(spec.id, Phase::Done, spec.size_bytes, spec.size_bytes));
        return Ok(final_path);
    }

    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Couldn't create the models folder ({}): {e}", dir.display()))?;

    // How much is already on disk from a previous attempt. A `.part` longer than the model is a
    // `.part` from a different build of the catalogue, or a corrupted one; either way resuming
    // from it would produce a file that can only fail its digest, so it is discarded.
    let resume_from = match std::fs::metadata(&part_path) {
        Ok(meta) if meta.len() < spec.size_bytes => meta.len(),
        Ok(_) => {
            let _ = std::fs::remove_file(&part_path);
            0
        }
        Err(_) => 0,
    };

    ensure_space(dir, spec.size_bytes.saturating_sub(resume_from))?;

    let mut done = resume_from;
    emit(app, Progress::new(spec.id, Phase::Downloading, done, spec.size_bytes));

    let outcome = stream_to_file(app, spec, &part_path, resume_from, &mut done, cancel).await;

    match outcome {
        Err(Interrupted::Cancelled) => {
            emit(app, Progress::new(spec.id, Phase::Cancelled, done, spec.size_bytes));
            return Err("Download cancelled".to_string());
        }
        Err(Interrupted::Failed(message)) => {
            return Err(fail(app, spec, done, message));
        }
        Ok(()) => {}
    }

    // The cheap check first. A short file is the ordinary way a transfer goes wrong, and saying so
    // costs one `metadata` call rather than a full re-read.
    let written = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    if written != spec.size_bytes {
        let _ = std::fs::remove_file(&part_path);
        return Err(fail(
            app,
            spec,
            done,
            format!(
                "The download ended early — {written} bytes of {}. Try again; it will resume.",
                spec.size_bytes
            ),
        ));
    }

    emit(app, Progress::new(spec.id, Phase::Verifying, spec.size_bytes, spec.size_bytes));
    let digest = sha256_of(&part_path).await.map_err(|e| fail(app, spec, done, e))?;
    if digest != spec.sha256 {
        // Deleted rather than kept. A file whose digest is wrong cannot be resumed into a right
        // one — every subsequent attempt would append to the same bad prefix and fail identically,
        // which is a download that can never succeed until someone finds the file by hand.
        let _ = std::fs::remove_file(&part_path);
        return Err(fail(
            app,
            spec,
            done,
            "The downloaded file didn't match its checksum, so it has been discarded. This is \
             usually a proxy or a captive portal rewriting the download."
                .to_string(),
        ));
    }

    std::fs::rename(&part_path, &final_path)
        .map_err(|e| fail(app, spec, done, format!("Couldn't finish writing the model: {e}")))?;

    emit(app, Progress::new(spec.id, Phase::Done, spec.size_bytes, spec.size_bytes));
    Ok(final_path)
}

/// Why [`stream_to_file`] stopped early. Split from `Result<_, String>` so the caller can tell a
/// cancellation — which is a normal thing the user did and must not surface as an error toast —
/// from an actual failure.
enum Interrupted {
    Cancelled,
    Failed(String),
}

async fn stream_to_file(
    app: &AppHandle,
    spec: &ModelSpec,
    part_path: &Path,
    resume_from: u64,
    done: &mut u64,
    cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), Interrupted> {
    let client = reqwest::Client::builder()
        // No overall timeout: this request legitimately runs for an hour. The read timeout below
        // is what distinguishes "slow" from "dead", and it is the only one that can tell them
        // apart — a total timeout would kill a healthy download of a large model on a slow line.
        .read_timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(30))
        // The `resolve/main/...` URL 302s to a CDN host, so this is load-bearing rather than a
        // default worth inheriting silently.
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| Interrupted::Failed(format!("Couldn't create the HTTP client: {e}")))?;

    let mut request = client.get(spec.url());
    if resume_from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }

    let response = request
        .send()
        .await
        .map_err(|e| Interrupted::Failed(format!("Couldn't reach Hugging Face: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(Interrupted::Failed(format!(
            "Hugging Face answered {status} for {}. The model may have been moved or renamed in \
             a newer release of CodeFlow.",
            spec.url()
        )));
    }

    // A server that ignored the Range header answers 200 with the whole file. Appending that to a
    // partial file would produce a corrupt one that only the digest would catch, after the whole
    // download — so the partial start is dropped instead and the write begins at zero.
    let append = resume_from > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let start = if append { resume_from } else { 0 };
    *done = start;

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!append)
        .open(part_path)
        .await
        .map_err(|e| Interrupted::Failed(format!("Couldn't open {}: {e}", part_path.display())))?;
    if append {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|e| Interrupted::Failed(format!("Couldn't resume the download: {e}")))?;
    }

    let mut stream = response.bytes_stream();
    let mut last = Instant::now();
    let mut pending: Vec<u8> = Vec::with_capacity(CHUNK);
    // Pinned once, outside the loop, and polled by reference inside it. `super::cancelled` parks
    // forever when the sender is dropped rather than resolving instantly, which is what keeps this
    // `select!` from spinning at full speed instead of reading the socket.
    let cancelled = std::pin::pin!(super::cancelled(cancel));
    let mut cancelled = cancelled;

    loop {
        let chunk = tokio::select! {
            // Biased so a cancel that arrives while bytes are also ready wins. Without it the
            // select is random and a fast link keeps the download alive for several more chunks
            // after the user pressed Cancel, which reads as the button not working.
            biased;
            () = &mut cancelled => {
                // Whatever is buffered is written before returning, so the `.part` file is as long
                // as `done` claims and the next attempt resumes from the right offset.
                let _ = file.write_all(&pending).await;
                let _ = file.flush().await;
                return Err(Interrupted::Cancelled);
            }
            chunk = stream.next() => chunk,
        };

        let Some(chunk) = chunk else { break };

        let bytes = chunk.map_err(|e| {
            Interrupted::Failed(format!(
                "The download was interrupted after {} MB: {e}. Starting it again will resume \
                 from here.",
                *done / 1_048_576
            ))
        })?;

        pending.extend_from_slice(&bytes);
        *done += bytes.len() as u64;

        // Batched into CHUNK-sized writes rather than writing each frame the stream yields:
        // reqwest hands out whatever the socket produced, often a few kilobytes, and a
        // gigabyte-scale file written in 8 KB `write_all` calls spends most of its time in the
        // kernel rather than on the wire.
        if pending.len() >= CHUNK {
            file.write_all(&pending)
                .await
                .map_err(|e| Interrupted::Failed(format!("Couldn't write the model file: {e}")))?;
            pending.clear();
        }

        if last.elapsed() >= PROGRESS_INTERVAL {
            last = Instant::now();
            emit(app, Progress::new(spec.id, Phase::Downloading, *done, spec.size_bytes));
        }
    }

    file.write_all(&pending)
        .await
        .map_err(|e| Interrupted::Failed(format!("Couldn't write the model file: {e}")))?;
    file.flush()
        .await
        .map_err(|e| Interrupted::Failed(format!("Couldn't flush the model file: {e}")))?;
    Ok(())
}

/// Emits [`Phase::Failed`] and hands the message straight back, so a call site can
/// `return Err(fail(...))` without saying the same sentence twice.
fn fail(app: &AppHandle, spec: &ModelSpec, done: u64, message: String) -> String {
    let mut progress = Progress::new(spec.id, Phase::Failed, done, spec.size_bytes);
    progress.error = Some(message.clone());
    emit(app, progress);
    message
}

fn emit(app: &AppHandle, progress: Progress) {
    let _ = app.emit(EVENT, progress);
}

/// Refuses the download when the volume holding `dir` cannot take `needed` plus [`SPACE_HEADROOM`].
///
/// Silent when the volume cannot be identified. `sysinfo` lists mount points and this picks the
/// longest one that prefixes `dir`, which is right on both platforms but not guaranteed to match
/// anything — a network path on Windows, or a volume that appeared after the list was taken. A
/// check that cannot answer must not block the user; the download will fail on `ENOSPC` with a
/// clear message anyway, and that is the worse-but-still-honest path.
fn ensure_space(dir: &Path, needed: u64) -> Result<(), String> {
    use sysinfo::Disks;

    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if dir.starts_with(mount) {
            let depth = mount.components().count();
            let deeper = match best {
                None => true,
                Some((seen, _)) => depth > seen,
            };
            if deeper {
                best = Some((depth, disk.available_space()));
            }
        }
    }
    let Some((_, available)) = best else { return Ok(()) };

    let required = needed.saturating_add(SPACE_HEADROOM);
    if available < required {
        return Err(format!(
            "Not enough space on the volume holding {}: this needs about {} GB free and there is \
             {} GB.",
            dir.display(),
            required / 1_073_741_824,
            available / 1_073_741_824,
        ));
    }
    Ok(())
}

/// SHA-256 of a file, read in blocking chunks on the blocking pool.
///
/// `spawn_blocking` rather than tokio's async file API: this is a straight CPU-and-syscall grind
/// over up to eight gigabytes with no waiting in it, and running it on a runtime worker would stall
/// every other async task in the process — including the editor's own IPC — for the duration.
async fn sha256_of(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)
            .map_err(|e| format!("Couldn't read the downloaded file back: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; CHUNK];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| format!("Couldn't read the downloaded file back: {e}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| format!("Checksum task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sha256_matches_a_known_value() {
        let dir = std::env::temp_dir().join("codeflow-localai-sha-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("hello.bin");
        std::fs::write(&path, b"abc").expect("write");
        // The canonical SHA-256 of "abc".
        assert_eq!(
            sha256_of(&path).await.expect("digest"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The digest is compared with `==` against the catalogue's lowercase literal, so the encoder
    /// has to produce lowercase. `hex::encode` does; `hex::encode_upper` also exists and is one
    /// autocomplete away.
    #[tokio::test]
    async fn digests_come_back_lowercase() {
        let dir = std::env::temp_dir().join("codeflow-localai-sha-case");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("x.bin");
        std::fs::write(&path, b"\xff\xee\xdd").expect("write");
        let digest = sha256_of(&path).await.expect("digest");
        assert_eq!(digest, digest.to_lowercase());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A volume that cannot be identified must not block the download. Passing a path under no
    /// listed mount point is the closest reachable stand-in for that case.
    #[test]
    fn unknown_volume_does_not_refuse() {
        let nowhere = Path::new("\u{0}not-a-real-mount");
        assert!(ensure_space(nowhere, u64::MAX / 2).is_ok());
    }
}
