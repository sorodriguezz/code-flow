//! Fetching one archive, resumably, and keeping it only if it is the one that was pinned.
//!
//! The same three rules as `localai::download`, which writes the only other gigabyte-scale file in
//! the app, for the same reasons:
//!
//! - bytes land in `<file>.part` and are renamed into place only after the digest matches, so a file
//!   that exists is a file that was verified — nothing records "finished" separately from the disk;
//! - an interrupted transfer resumes from the `.part` with a `Range` request (SonarSource's binaries
//!   host answers `accept-ranges: bytes`), because a 900 MB download that restarts from zero never
//!   finishes on a connection that drops;
//! - free space is checked before the first byte, not discovered at the last one.
//!
//! It is its own small copy rather than a call into `localai::download` because that one is shaped
//! around a model spec and emits the model pane's event; what is shared — the space check — is.

use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// How often progress is reported while bytes move. One event per chunk would be hundreds a second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Writes are batched to this size; reqwest hands out whatever the socket produced.
const CHUNK: usize = 1024 * 1024;

/// Why a fetch did not produce the file.
#[derive(Debug)]
pub enum FetchError {
    /// The user stopped it. The `.part` is kept so the next attempt resumes.
    Cancelled,
    Failed(String),
}

pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // A read timeout, not a total one: a large archive on a slow line is slow, not dead.
        .read_timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent(concat!("CodeFlow/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Couldn't create the HTTP client: {e}"))
}

/// Downloads `url` to `dest`, verifying `sha256`. `size` is the expected length when it is known
/// (0 when it isn't). `progress(done, total)` is called on an interval while bytes move.
pub async fn fetch(
    url: &str,
    size: u64,
    sha256: &str,
    dest: &Path,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), FetchError> {
    if dest.is_file() {
        progress(size, size);
        return Ok(());
    }
    let dir = dest.parent().ok_or_else(|| FetchError::Failed("a download needs a folder".into()))?;
    std::fs::create_dir_all(dir)
        .map_err(|e| FetchError::Failed(format!("Couldn't create {}: {e}", dir.display())))?;
    let part = dest.with_file_name(format!(
        "{}.part",
        dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));

    // A `.part` at least as long as the whole file is from another pin or corrupted; resuming from it
    // can only end in a digest mismatch.
    let resume_from = match std::fs::metadata(&part) {
        Ok(meta) if size == 0 || meta.len() < size => meta.len(),
        Ok(_) => {
            let _ = std::fs::remove_file(&part);
            0
        }
        Err(_) => 0,
    };
    crate::localai::download::ensure_space(dir, size.saturating_sub(resume_from)).map_err(FetchError::Failed)?;

    let client = client().map_err(FetchError::Failed)?;
    let mut request = client.get(url);
    if resume_from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(FetchError::Cancelled),
        response = request.send() => response.map_err(|e| FetchError::Failed(format!("Couldn't download {url}: {e}")))?,
    };
    let status = response.status();
    if !status.is_success() {
        return Err(FetchError::Failed(format!("The server answered {status} for {url}.")));
    }
    // A server that ignored the Range header sends the whole file again: start over rather than
    // append it to the partial one.
    let append = resume_from > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut done = if append { resume_from } else { 0 };
    let total = if size > 0 { size } else { done + response.content_length().unwrap_or(0) };

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!append)
        .open(&part)
        .await
        .map_err(|e| FetchError::Failed(format!("Couldn't write {}: {e}", part.display())))?;
    if append {
        file.seek(std::io::SeekFrom::Start(done))
            .await
            .map_err(|e| FetchError::Failed(format!("Couldn't resume the download: {e}")))?;
    }

    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::with_capacity(CHUNK);
    let mut last = Instant::now();
    progress(done, total);
    loop {
        let chunk = tokio::select! {
            // Biased so a cancel that arrives while bytes are also ready wins.
            biased;
            () = cancel.cancelled() => {
                // What is buffered is written first, so the `.part` is as long as `done` says and the
                // next attempt resumes from the right offset.
                let _ = file.write_all(&pending).await;
                let _ = file.flush().await;
                return Err(FetchError::Cancelled);
            }
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        let bytes = chunk.map_err(|e| {
            FetchError::Failed(format!(
                "The download was interrupted after {} MB: {e}. Starting it again resumes from there.",
                done / 1_048_576
            ))
        })?;
        pending.extend_from_slice(&bytes);
        done += bytes.len() as u64;
        if pending.len() >= CHUNK {
            file.write_all(&pending)
                .await
                .map_err(|e| FetchError::Failed(format!("Couldn't write {}: {e}", part.display())))?;
            pending.clear();
        }
        if last.elapsed() >= PROGRESS_INTERVAL {
            last = Instant::now();
            progress(done, total);
        }
    }
    file.write_all(&pending)
        .await
        .map_err(|e| FetchError::Failed(format!("Couldn't write {}: {e}", part.display())))?;
    file.flush().await.map_err(|e| FetchError::Failed(e.to_string()))?;
    drop(file);
    progress(done, total);

    let written = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if size > 0 && written != size {
        let _ = std::fs::remove_file(&part);
        return Err(FetchError::Failed(format!(
            "The download ended early — {written} bytes of {size}. Try again; it resumes from there."
        )));
    }
    let digest = sha256_of(&part).await.map_err(FetchError::Failed)?;
    if !digest.eq_ignore_ascii_case(sha256) {
        // Deleted rather than kept: a wrong prefix can never be resumed into a right file.
        let _ = std::fs::remove_file(&part);
        return Err(FetchError::Failed(
            "The downloaded file didn't match its checksum, so it was discarded rather than run. This \
             is usually a proxy or a captive portal rewriting the download."
                .to_string(),
        ));
    }
    std::fs::rename(&part, dest).map_err(|e| FetchError::Failed(format!("Couldn't finish {}: {e}", dest.display())))?;
    Ok(())
}

/// The SHA-256 of a file, read in chunks so a gigabyte never sits in memory.
pub async fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = file.read(&mut buffer).await.map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_existing_file_is_taken_as_already_verified() {
        let dir = std::env::temp_dir().join(format!("cf-reviewer-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("archive.zip");
        std::fs::write(&dest, b"already here").unwrap();
        let mut calls = 0;
        // An unreachable URL proves no request is made.
        let result = fetch("http://127.0.0.1:9/never", 12, "00", &dest, &CancellationToken::new(), |_, _| calls += 1).await;
        assert!(result.is_ok());
        assert_eq!(calls, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_digest_is_hex_sha256() {
        let dir = std::env::temp_dir().join(format!("cf-reviewer-sha-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("x");
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(
            sha256_of(&file).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
