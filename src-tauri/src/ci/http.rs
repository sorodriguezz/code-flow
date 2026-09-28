//! Transport for the CI clients.
//!
//! Its own client rather than the one the pull-request clients share (`ado::pr_http_client`: 90 s a
//! request, 15 s to connect), because this screen's traffic is shaped differently from a review's.
//! It polls, and a list that hasn't answered in [`JSON_TIMEOUT`] is better abandoned and asked again
//! on the next tick than waited on for twice as long. Its job logs get a longer budget of their own
//! ([`LOG_TIMEOUT`]). And its artifact downloads get no total budget at all — a gigabyte over a slow
//! link is not a hang — only a read timeout that tells "slow" from "dead" ([`download_client`]).
//!
//! The rest of the module exists because nothing here had a plain-text path. Every `get_json` in
//! the crate ends in `serde_json::from_str`, and a job log is `text/plain` — feeding one to those
//! produces "unexpected response from …", which reads like a bug in CodeFlow rather than like a
//! log.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use super::{JobLog, MAX_LOG_BYTES};

/// Enough time for a slow self-managed GitLab to answer a list query, and short enough that a
/// dead host doesn't leave a spinner running until the user gives up on the app.
const JSON_TIMEOUT: Duration = Duration::from_secs(45);
/// Logs get their own, longer budget: a multi-megabyte trace over a slow link is not a hang.
const LOG_TIMEOUT: Duration = Duration::from_secs(180);
/// How long a download may go without receiving a single byte before it is called dead.
///
/// The only timeout a download has — see [`download_client`] for why there is no total one.
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// How often a download reports how far it has got. Often enough that the bar moves, rarely enough
/// that a fast link isn't spending its time on IPC.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
/// A pipeline definition read from the host rather than from the working copy. Far past any file a
/// person wrote by hand; the cap only exists because the path is the user's pick.
pub(crate) const MAX_DEFINITION_BYTES: u64 = 1024 * 1024;
/// What a download that the user stopped returns, so the caller can tell it apart from a failure.
pub(crate) const DOWNLOAD_CANCELLED: &str = "download cancelled";

/// Which host we are talking to. Only ever used to phrase errors and to switch on the one
/// provider-specific quirk in this file ([`Provider::Azure`]'s 203).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    GitHub,
    GitLab,
    Azure,
    Bitbucket,
}

impl Provider {
    fn label(self) -> &'static str {
        match self {
            Provider::GitHub => "GitHub",
            Provider::GitLab => "GitLab",
            Provider::Azure => "Azure DevOps",
            Provider::Bitbucket => "Bitbucket",
        }
    }
}

/// One client for the process, cloned per call — the same reasoning `github::client` documents:
/// a client per request re-handshakes TLS and shares no connection pool, and this screen makes
/// bursts of requests to one host.
///
/// Redirects are left on the default policy (up to 10 hops) on purpose. GitHub's job-log endpoint
/// answers `302` to a signed blob-storage URL on a different host, and reqwest drops the
/// `Authorization` header on any cross-host hop. That is exactly the behaviour this needs: the
/// signed URL carries its own credentials and rejects requests that also present ours.
pub(crate) fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(JSON_TIMEOUT)
                .connect_timeout(Duration::from_secs(12))
                // GitHub answers 403 to any request without one. The other two don't care.
                .user_agent(crate::github::USER_AGENT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

/// Sends a prepared request and decodes its JSON body.
///
/// The caller builds the request — each provider authenticates differently (`Bearer`,
/// `PRIVATE-TOKEN`, `Basic`) and there is no honest way to abstract that into three characters of
/// shared code.
pub(crate) async fn get_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
    provider: Provider,
) -> Result<T, String> {
    let response = send(request, provider).await?;
    let status = response.status();
    let html = looks_like_html(&response);
    let quota = quota_note(response.headers());
    let body = response
        .text()
        .await
        .map_err(|e| format!("unexpected response from {}: {e}", provider.label()))?;

    if !status.is_success() {
        return Err(describe(provider, Asked::Pipeline, status, &body, quota));
    }
    // Azure's trap, repeated here because this helper cannot reuse `ado::get_json`: a wrong or
    // expired PAT is not a 401. dev.azure.com treats the request as anonymous and serves the
    // sign-in *page* — `203 Non-Authoritative Information`, `text/html` — and 203 passes
    // `is_success()`. Without this the only symptom is a JSON decode failure on `<!DOCTYPE html>`.
    if provider == Provider::Azure && (status.as_u16() == 203 || html) {
        return Err(crate::ado::BAD_CREDENTIALS.to_string());
    }
    serde_json::from_str(&body)
        .map_err(|e| format!("unexpected response from {}: {e}", provider.label()))
}

/// Sends a prepared request that is expected to change something, and reads nothing back.
///
/// The write counterpart of `get_json`, and it exists because every one of these three APIs answers
/// a successful re-run or cancel with a body nobody wants: GitHub sends `201` and an empty object,
/// GitLab the whole pipeline again, Azure the whole build. The caller re-reads the run afterwards
/// anyway — that is the only way to learn the new status — so decoding the response here would be
/// three wire types maintained for values that are thrown away.
///
/// The error path is the same `describe` every read goes through, so "your token cannot do that"
/// reads the same whether it happened while listing or while cancelling.
pub(crate) async fn send_write(request: reqwest::RequestBuilder, provider: Provider) -> Result<(), String> {
    let response = send(request, provider).await?;
    let status = response.status();
    let html = looks_like_html(&response);
    let quota = quota_note(response.headers());

    // Azure's sign-in-page-instead-of-401 trap, exactly as `get_json` documents it. It matters more
    // here, not less: a 203 that is treated as success is a re-run the user is told happened and
    // that never reached the server.
    if provider == Provider::Azure && (status.as_u16() == 203 || html) {
        return Err(crate::ado::BAD_CREDENTIALS.to_string());
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(describe(provider, Asked::Write, status, &body, quota));
    }
    Ok(())
}

/// [`send_write`] for the writes whose answer is worth keeping — the run a dispatch just started.
///
/// `Ok(None)` for a success with no body **and** for one whose body doesn't decode. Both mean the
/// same thing to the caller: the write happened and its receipt can't say which run it made. The
/// alternative — failing on an unreadable receipt — tells the user a run did not start when it did,
/// and the obvious next click starts it twice.
pub(crate) async fn send_write_for<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
    provider: Provider,
) -> Result<Option<T>, String> {
    let response = send(request, provider).await?;
    let status = response.status();
    let html = looks_like_html(&response);
    let quota = quota_note(response.headers());

    if provider == Provider::Azure && (status.as_u16() == 203 || html) {
        return Err(crate::ado::BAD_CREDENTIALS.to_string());
    }
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe(provider, Asked::Write, status, &body, quota));
    }
    Ok(decode_receipt(&body))
}

/// The body of a successful write, when there is one and it is what was expected.
fn decode_receipt<T: DeserializeOwned>(body: &str) -> Option<T> {
    if body.trim().is_empty() {
        return None;
    }
    serde_json::from_str(body).ok()
}

/// A small text file from the host — a pipeline definition — or `None` when it isn't there.
///
/// A 404 is an answer here, not an error: "that file doesn't exist at that ref" is exactly the
/// question being asked, and the caller has somewhere else to look. Capped like a log, because the
/// path is whatever the user picked and a multi-megabyte file called `.yml` is not a pipeline
/// anybody wrote.
pub(crate) async fn get_text(
    request: reqwest::RequestBuilder,
    provider: Provider,
    cap: u64,
) -> Result<Option<String>, String> {
    let response = send(request, provider).await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let html = looks_like_html(&response);
    let quota = quota_note(response.headers());
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(describe(provider, Asked::Pipeline, status, &body, quota));
    }
    if provider == Provider::Azure && (status.as_u16() == 203 || html) {
        return Err(crate::ado::BAD_CREDENTIALS.to_string());
    }
    let read = read_capped(response, provider, cap).await?;
    Ok(Some(read.text))
}

/// Sends a prepared request and reads its body as a log: plain text, capped, never buffered whole
/// before the cap is applied.
pub(crate) async fn get_log(
    request: reqwest::RequestBuilder,
    provider: Provider,
) -> Result<JobLog, String> {
    let response = send(request.timeout(LOG_TIMEOUT), provider).await?;
    let status = response.status();
    let html = looks_like_html(&response);
    let quota = quota_note(response.headers());

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(describe(provider, Asked::Log, status, &body, quota));
    }
    if provider == Provider::Azure && (status.as_u16() == 203 || html) {
        return Err(crate::ado::BAD_CREDENTIALS.to_string());
    }

    read_capped(response, provider, MAX_LOG_BYTES).await
}

/// Streams a response body until `cap` bytes, then stops asking for more.
///
/// Streamed rather than `response.text()` because the cap has to be on the *read*: a job that
/// loops printing can produce hundreds of megabytes, and a limit applied after the whole body is
/// in memory is not a limit, it is a comment.
async fn read_capped(response: reqwest::Response, provider: Provider, cap: u64) -> Result<JobLog, String> {
    let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut total: u64 = 0;
    let mut truncated = false;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| format!("couldn't read what {} sent: {e}", provider.label()))?;
        total += chunk.len() as u64;
        if buffer.len() as u64 >= cap {
            truncated = true;
            break;
        }
        let room = (cap - buffer.len() as u64) as usize;
        if chunk.len() > room {
            buffer.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        buffer.extend_from_slice(&chunk);
    }

    // Lossy rather than strict: a log is whatever bytes the job wrote to a pipe, and one invalid
    // sequence in the middle of ten thousand good lines must not lose the whole thing. Cutting at
    // the byte cap can also split a multi-byte character in half by construction.
    let text = String::from_utf8_lossy(&buffer).into_owned();
    Ok(JobLog { text, truncated, total_bytes: total })
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/// The client artifact downloads go through.
///
/// **No total timeout, deliberately.** [`client`]'s 45 s is a ceiling for a JSON answer; an
/// artifact is as large as the job made it, and a healthy download of a gigabyte on a slow line
/// would be killed half way through by any number that also catches a hang. What catches the hang
/// instead is [`DOWNLOAD_READ_TIMEOUT`]: a minute without a single byte is dead, however long the
/// whole thing has been going. Same reasoning, same shape as the model downloader in
/// `localai::download`.
///
/// Redirects are followed for the same reason [`client`] documents: GitHub and GitLab both answer
/// the archive request with a redirect to signed object storage on another host, and reqwest drops
/// `Authorization` on the cross-host hop — which that storage requires.
pub(crate) fn download_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .read_timeout(DOWNLOAD_READ_TIMEOUT)
                .connect_timeout(Duration::from_secs(12))
                .user_agent(crate::github::USER_AGENT)
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

/// Downloads the ids the user has asked to stop. Checked between chunks by [`write_stream`].
fn cancelled_downloads() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    SET.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Asks a running download to stop. Harmless for an id that isn't running: the mark is cleared
/// the next time a download with that id starts or ends.
pub(crate) fn cancel_download(id: &str) {
    if let Ok(mut set) = cancelled_downloads().lock() {
        set.insert(id.to_string());
    }
}

fn is_cancelled(id: &str) -> bool {
    cancelled_downloads().lock().map(|set| set.contains(id)).unwrap_or(false)
}

fn forget_download(id: &str) {
    if let Ok(mut set) = cancelled_downloads().lock() {
        set.remove(id);
    }
}

/// Where a download is written until it is complete: next to the destination, with `.part` on.
///
/// Next to it rather than in a temporary directory, so the final rename never crosses a volume —
/// which would turn an atomic rename into a copy that can itself fail half way.
fn part_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "artifact".to_string());
    destination.with_file_name(format!("{name}.part"))
}

/// Downloads a response body to `destination`, reporting `(done, total)` as it goes.
///
/// The body is streamed to disk, never held in memory — artifacts are routinely hundreds of
/// megabytes — and it is streamed to `<destination>.part`, renamed into place only once the last
/// byte is on disk. A download that fails or is cancelled therefore never leaves a file under the
/// name the user chose: a truncated zip that *looks* finished is worse than no file, because it
/// fails later, somewhere else, with an error that says nothing about the download.
///
/// `total` is the host's `Content-Length`, falling back to the size the listing reported; `None`
/// when neither says (an Azure container artifact), and the bar is then indeterminate.
pub(crate) async fn download_to_file(
    request: reqwest::RequestBuilder,
    provider: Provider,
    destination: &Path,
    transfer_id: &str,
    expected: Option<u64>,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<u64, String> {
    // The mark is only ever cleared on the way *out*, never on the way in. The frontend mints a
    // fresh id per download, so no earlier transfer can have left one behind — and a Stop pressed
    // in the moment between the click and the request going out has to be kept, not wiped by the
    // start of the very download it was meant to stop.
    let result = async {
        if is_cancelled(transfer_id) {
            return Err(DOWNLOAD_CANCELLED.to_string());
        }
        let response = send(request, provider).await?;
        let status = response.status();
        let html = looks_like_html(&response);
        let quota = quota_note(response.headers());
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(describe(provider, Asked::Artifact, status, &body, quota));
        }
        if provider == Provider::Azure && (status.as_u16() == 203 || html) {
            return Err(crate::ado::BAD_CREDENTIALS.to_string());
        }

        let total = response.content_length().filter(|length| *length > 0).or(expected);
        write_stream(
            response.bytes_stream(),
            destination,
            total,
            || is_cancelled(transfer_id),
            &mut progress,
        )
        .await
    }
    .await;
    forget_download(transfer_id);
    result
}

/// The part of [`download_to_file`] that touches the disk, over any stream of chunks — so the
/// rules that matter (the `.part` file, the rename, the clean-up on failure and on cancel) are
/// testable without a server.
async fn write_stream<S, B, E>(
    mut stream: S,
    destination: &Path,
    total: Option<u64>,
    cancelled: impl Fn() -> bool,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<u64, String>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let part = part_path(destination);
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("Couldn't write to {}: {e}", destination.display()))?;

    let mut done: u64 = 0;
    let mut last = Instant::now();
    let copied: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            if cancelled() {
                return Err(DOWNLOAD_CANCELLED.to_string());
            }
            let chunk = chunk.map_err(|e| {
                format!("The download was interrupted after {} KB: {e}", done / 1024)
            })?;
            let bytes = chunk.as_ref();
            file.write_all(bytes)
                .await
                .map_err(|e| format!("Couldn't write to {}: {e}", destination.display()))?;
            done += bytes.len() as u64;
            if last.elapsed() >= PROGRESS_INTERVAL {
                last = Instant::now();
                progress(done, total);
            }
        }
        // A cancel that arrived with the last chunk still counts: the user asked for no file.
        if cancelled() {
            return Err(DOWNLOAD_CANCELLED.to_string());
        }
        file.flush()
            .await
            .map_err(|e| format!("Couldn't write to {}: {e}", destination.display()))
    }
    .await;
    drop(file);

    if let Err(error) = copied {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(error);
    }
    // On failure the `.part` stays where it is and the message names it: every byte arrived, and
    // deleting a finished download because a rename hit a locked file would throw that away.
    tokio::fs::rename(&part, destination).await.map_err(|e| {
        format!(
            "Downloaded to {}, but couldn't rename it to {}: {e}",
            part.display(),
            destination.display()
        )
    })?;
    // One last report at the real end, so the bar finishes rather than stopping wherever the last
    // interval happened to land.
    progress(done, total.or(Some(done)));
    Ok(done)
}

async fn send(
    request: reqwest::RequestBuilder,
    provider: Provider,
) -> Result<reqwest::Response, String> {
    request.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{} didn't answer in time", provider.label())
        } else {
            format!("couldn't reach {}: {e}", provider.label())
        }
    })
}

fn looks_like_html(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim_start().starts_with("text/html"))
}

/// What the host's rate-limit headers say, when they say anything.
///
/// Nothing else in this backend reads these — a 403 for an exhausted quota currently reaches the
/// user as `GitHub returned 403 Forbidden: {the entire body}`. This screen is the first thing in
/// the app that polls three third-party APIs, so it is also the first that can plausibly run into
/// one, and "you are rate limited" is a different problem from "your token is wrong" even though
/// both arrive as a 403.
fn quota_note(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());

    if let Some(seconds) = get("retry-after") {
        return Some(format!("rate limited — retry in {seconds}s"));
    }
    // GitHub sends these on every response; only zero remaining is worth saying anything about.
    let remaining = get("x-ratelimit-remaining").and_then(|v| v.parse::<u64>().ok())?;
    if remaining > 0 {
        return None;
    }
    match get("x-ratelimit-reset") {
        Some(reset) => Some(format!("API rate limit exhausted (resets at {reset} epoch seconds)")),
        None => Some("API rate limit exhausted".to_string()),
    }
}

/// What the request was after.
///
/// The only thing that separates two 404s that mean entirely different things — see [`describe`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Asked {
    /// A run, or the jobs of a run.
    Pipeline,
    /// One job's log.
    Log,
    /// A change: re-run, cancel, start, approve, play. A 403 here is a missing *write* permission,
    /// which is a different fix from a missing read one.
    Write,
    /// An artifact's archive.
    Artifact,
}

/// A failure the user can act on.
///
/// The three cases worth separating are the three that need different actions: the token is not
/// allowed to read CI (fix the scopes), the quota is gone (wait), or something else (read it).
/// The body is trimmed rather than concatenated whole — `res.text().await.unwrap_or_default()`
/// with a large error page behind it produces an unreadable toast.
fn describe(
    provider: Provider,
    asked: Asked,
    status: reqwest::StatusCode,
    body: &str,
    quota: Option<String>,
) -> String {
    if let Some(note) = quota {
        return format!("{}: {note}", provider.label());
    }
    // 401 and 403 are different problems with different fixes, and sending someone to check
    // permissions that are already correct sends them looking in the wrong place. A 401 is the
    // credential itself — expired, revoked or deleted — and all three hosts say so in the body.
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return match provider {
            Provider::Azure => crate::ado::BAD_CREDENTIALS.to_string(),
            Provider::GitLab => crate::gitlab::describe(status, body),
            Provider::GitHub => "Your GitHub token was rejected — it has most likely expired or \
                 been revoked. Reconnect it in Settings → Integrations."
                .to_string(),
            Provider::Bitbucket => crate::bitbucket::BAD_CREDENTIALS.to_string(),
        };
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return match asked {
            Asked::Write => missing_write_permission(provider, body),
            _ => missing_scope(provider),
        };
    }
    // GitHub answers an artifact past its retention with 410 Gone, and one that was deleted with a
    // 404. Either way the thing to say is the same: there is nothing left to download.
    if asked == Asked::Artifact
        && (status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE)
    {
        return format!(
            "{} no longer has that artifact — it expired or was deleted",
            provider.label()
        );
    }
    // A write that finds nothing has usually lost a race rather than hit a bug: the approval was
    // answered in the browser a minute ago, the manual job was already started, the workflow file
    // was renamed. The host's own words say which, when it sends any.
    if asked == Asked::Write && status == reqwest::StatusCode::NOT_FOUND {
        return match host_message(body) {
            Some(message) => format!("{}: {message}", provider.label()),
            None => format!(
                "{} can't find that any more — it may have been answered or removed already",
                provider.label()
            ),
        };
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        // A missing *log* is routine and a missing *run* is not, so they cannot share a sentence.
        // A host has nothing to hand over for a job that has not written anything yet — GitHub
        // answers a queued or freshly started job with a 404 — and it has nothing for a job whose
        // log has aged out of retention either. Told that "the pipeline doesn't exist any more"
        // while the pipeline is on screen and visibly running, the reader concludes the app is
        // broken, and they are not being unreasonable. (The panel goes further and doesn't show
        // this at all while the job is live: see `JobLogPane`.)
        return match asked {
            Asked::Log => format!(
                "{} has no log for that job — it may not have started writing one yet, or the log \
                 may have aged out of the host's retention window",
                provider.label()
            ),
            // `Write` and `Artifact` answered above; this arm keeps the match exhaustive.
            Asked::Pipeline | Asked::Write | Asked::Artifact => format!(
                "{} doesn't have that pipeline any more — it may have been deleted or the \
                 repository re-linked",
                provider.label()
            ),
        };
    }
    // GitLab phrases its own errors well enough to be worth reusing.
    if provider == Provider::GitLab {
        return crate::gitlab::describe(status, body);
    }
    // Bitbucket's sentence sits one level down, in `error.message` — a refused manual run says
    // exactly why there ("the custom pipeline wasn't found", a variable that isn't declared).
    if provider == Provider::Bitbucket {
        if let Some(message) = crate::bitbucket::message_of(body) {
            return format!("Bitbucket returned {status}: {message}");
        }
    }
    // GitHub and Azure both put a sentence in `message` — GitHub's 422 for a dispatch says exactly
    // which input was wrong — and that sentence beats the raw JSON around it.
    if let Some(message) = host_message(body) {
        return format!("{} returned {status}: {message}", provider.label());
    }
    let excerpt: String = body.trim().chars().take(300).collect();
    if excerpt.is_empty() {
        format!("{} returned {status}", provider.label())
    } else {
        format!("{} returned {status}: {excerpt}", provider.label())
    }
}

/// The sentence out of a GitHub or Azure DevOps error body — both use `{"message": …}` — capped so
/// a stack trace in it can't fill a toast.
fn host_message(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let message = value.get("message")?.as_str()?.trim();
    if message.is_empty() {
        return None;
    }
    Some(message.chars().take(300).collect())
}

/// The 403 on a write, which is a different missing permission from the 403 on a read.
///
/// The token that lists runs happily is routinely one that cannot start them: GitHub's
/// fine-grained tokens split Actions into read and write, and GitLab's `read_api` reads everything
/// and changes nothing. The host's own words are kept alongside, because a 403 on a write is just
/// as often *not* a scope at all — a reviewer who isn't on the environment's list, a protected
/// branch — and only the host knows which.
fn missing_write_permission(provider: Provider, body: &str) -> String {
    let scope = match provider {
        Provider::GitHub => {
            "Your GitHub token can't do that. A classic token needs the `repo` scope; a \
             fine-grained one needs `Actions: Read and write`, and `Deployments: Read and write` to \
             answer an approval."
        }
        Provider::GitLab => {
            "Your GitLab token can't do that. It needs the `api` scope — `read_api` only reads — \
             and a role on the project that allows it."
        }
        Provider::Azure => {
            "Your Azure DevOps token can't do that. It needs the `Build (Read & execute)` scope."
        }
        Provider::Bitbucket => {
            "Your Bitbucket credential can't do that. An API token needs \
             `write:pipeline:bitbucket`; an access token needs `pipeline:write` — and the account \
             write access to the repository."
        }
    };
    let said = match provider {
        Provider::GitLab => crate::gitlab::describe(reqwest::StatusCode::FORBIDDEN, body)
            .strip_prefix("GitLab: ")
            .map(str::to_string),
        Provider::Bitbucket => crate::bitbucket::message_of(body),
        _ => host_message(body),
    };
    match said {
        Some(message) => format!("{scope} {}: “{message}”", provider.label()),
        None => format!("{scope} Reconnect it in Settings → Integrations."),
    }
}

/// The one message that saves a support round trip.
///
/// The tab's gate can tell whether a connection exists; it cannot tell whether the saved token
/// carries the CI scope, because finding that out costs either a request or a keychain read, and
/// the keychain is off-limits on that path. So the 403 is not avoidable — it is only worth
/// answering well.
fn missing_scope(provider: Provider) -> String {
    match provider {
        Provider::GitHub => "Your GitHub token can't read Actions. A classic token needs the \
             `repo` scope; a fine-grained one needs the `Actions: Read` permission. Reconnect it \
             in Settings → Integrations."
            .to_string(),
        Provider::GitLab => "Your GitLab token can't read pipelines. It needs the `read_api` \
             scope, and your account needs at least the Reporter role on the project to read job \
             logs. Reconnect it in Settings → Integrations."
            .to_string(),
        Provider::Azure => "Your Azure DevOps token can't read builds. It needs the \
             `Build (Read)` scope. Reconnect it in Settings → Integrations."
            .to_string(),
        Provider::Bitbucket => "Your Bitbucket credential can't read Pipelines. An API token needs \
             the `read:pipeline:bitbucket` scope; an access token needs `pipeline`. Reconnect it in \
             Settings → Integrations."
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two 404s. Same status, same provider, two different facts about the world — and the one
    /// that used to be sent for both is the alarming one.
    #[test]
    fn a_missing_log_and_a_missing_run_do_not_share_a_sentence() {
        let not_found = reqwest::StatusCode::NOT_FOUND;
        let log = describe(Provider::GitHub, Asked::Log, not_found, "", None);
        let run = describe(Provider::GitHub, Asked::Pipeline, not_found, "", None);

        assert!(log.contains("no log for that job"), "{log}");
        assert!(!log.contains("deleted"), "a job still starting up has not been deleted: {log}");
        assert!(run.contains("deleted or the repository re-linked"), "{run}");
    }

    /// Everything that isn't a 404 answers the same way whichever it was asked for: the fix for a
    /// missing scope or an exhausted quota doesn't depend on what you happened to be fetching.
    #[test]
    fn the_other_failures_read_the_same_either_way() {
        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert_eq!(
                describe(Provider::GitHub, Asked::Log, status, "boom", None),
                describe(Provider::GitHub, Asked::Pipeline, status, "boom", None),
                "{status}"
            );
        }
        assert_eq!(
            describe(Provider::GitHub, Asked::Log, reqwest::StatusCode::FORBIDDEN, "", Some("rate limited".into())),
            "GitHub: rate limited"
        );
    }

    /// The token that reads runs is routinely one that can't start them, and "can't read Actions"
    /// said about a token that just listed fifty runs sends the reader to the wrong setting.
    #[test]
    fn a_forbidden_write_names_the_write_permission_and_keeps_the_hosts_words() {
        let forbidden = reqwest::StatusCode::FORBIDDEN;
        let read = describe(Provider::GitHub, Asked::Pipeline, forbidden, "", None);
        let write = describe(
            Provider::GitHub,
            Asked::Write,
            forbidden,
            r#"{"message":"Resource not accessible by personal access token"}"#,
            None,
        );
        assert!(read.contains("can't read Actions"), "{read}");
        assert!(write.contains("Actions: Read and write"), "{write}");
        assert!(write.contains("Resource not accessible by personal access token"), "{write}");

        // GitLab's `read_api` is the classic trap: it reads everything and changes nothing.
        let gitlab = describe(Provider::GitLab, Asked::Write, forbidden, r#"{"message":"403 Forbidden"}"#, None);
        assert!(gitlab.contains("`read_api` only reads"), "{gitlab}");
        assert!(gitlab.contains("“403 Forbidden”"), "{gitlab}");

        // No body: the reconnect hint instead of an empty quote.
        let azure = describe(Provider::Azure, Asked::Write, forbidden, "", None);
        assert!(azure.contains("Build (Read & execute)"), "{azure}");
        assert!(azure.ends_with("Reconnect it in Settings → Integrations."), "{azure}");
    }

    #[test]
    fn a_gone_artifact_says_so_whichever_way_the_host_puts_it() {
        for status in [reqwest::StatusCode::GONE, reqwest::StatusCode::NOT_FOUND] {
            let message = describe(Provider::GitHub, Asked::Artifact, status, "", None);
            assert!(message.contains("no longer has that artifact"), "{status}: {message}");
        }
    }

    /// Bitbucket's reads and writes need different scopes in two vocabularies, and its own sentence
    /// sits in `error.message`.
    #[test]
    fn bitbucket_failures_name_its_scopes_and_keep_its_words() {
        let forbidden = reqwest::StatusCode::FORBIDDEN;
        let read = describe(Provider::Bitbucket, Asked::Pipeline, forbidden, "", None);
        assert!(read.contains("read:pipeline:bitbucket") && read.contains("`pipeline`"), "{read}");
        let body = r#"{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes.","detail":{"granted":["pipeline"],"required":["pipeline:write"]}}}"#;
        let write = describe(Provider::Bitbucket, Asked::Write, forbidden, body, None);
        assert!(write.contains("write:pipeline:bitbucket"), "{write}");
        assert!(write.contains("required: pipeline:write"), "{write}");

        assert_eq!(
            describe(Provider::Bitbucket, Asked::Pipeline, reqwest::StatusCode::UNAUTHORIZED, "", None),
            crate::bitbucket::BAD_CREDENTIALS
        );
        let refused = r#"{"type":"error","error":{"message":"The selected pipeline was not found in the bitbucket-pipelines.yml file."}}"#;
        assert_eq!(
            describe(Provider::Bitbucket, Asked::Write, reqwest::StatusCode::BAD_REQUEST, refused, None),
            "Bitbucket returned 400 Bad Request: The selected pipeline was not found in the bitbucket-pipelines.yml file."
        );
    }

    /// A write that finds nothing has usually lost a race — the approval was answered in the
    /// browser — and must not claim the whole pipeline is gone.
    #[test]
    fn a_write_that_finds_nothing_does_not_say_the_pipeline_was_deleted() {
        let not_found = reqwest::StatusCode::NOT_FOUND;
        let bare = describe(Provider::Azure, Asked::Write, not_found, "", None);
        assert!(bare.contains("answered or removed already"), "{bare}");
        assert!(!bare.contains("re-linked"), "{bare}");

        let worded = describe(
            Provider::GitHub,
            Asked::Write,
            not_found,
            r#"{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}"#,
            None,
        );
        assert_eq!(worded, "GitHub: Not Found");
    }

    /// GitHub's 422 on a dispatch names the bad input in `message`; the JSON around it is noise.
    #[test]
    fn the_hosts_own_sentence_wins_over_the_raw_body() {
        let body = r#"{"message":"Required input 'environment' not provided","documentation_url":"https://docs.github.com/rest"}"#;
        assert_eq!(
            describe(Provider::GitHub, Asked::Write, reqwest::StatusCode::UNPROCESSABLE_ENTITY, body, None),
            "GitHub returned 422 Unprocessable Entity: Required input 'environment' not provided"
        );
        // Azure's error envelope carries its sentence in the same field.
        let azure = r#"{"$id":"1","innerException":null,"message":"Unexpected parameter 'image'","typeName":"x","typeKey":"x","errorCode":0,"eventId":3000}"#;
        assert_eq!(
            describe(Provider::Azure, Asked::Write, reqwest::StatusCode::BAD_REQUEST, azure, None),
            "Azure DevOps returned 400 Bad Request: Unexpected parameter 'image'"
        );
        // Not JSON: the excerpt, as before.
        assert_eq!(
            describe(Provider::GitHub, Asked::Write, reqwest::StatusCode::BAD_GATEWAY, "upstream down", None),
            "GitHub returned 502 Bad Gateway: upstream down"
        );
    }

    /// A write that happened is never reported as failed because its receipt was unreadable.
    #[test]
    fn an_unreadable_receipt_is_no_receipt_not_an_error() {
        #[derive(serde::Deserialize, Debug, PartialEq)]
        struct Receipt {
            id: i64,
        }
        assert_eq!(decode_receipt::<Receipt>(""), None);
        assert_eq!(decode_receipt::<Receipt>("   \n"), None);
        assert_eq!(decode_receipt::<Receipt>("<html>"), None);
        assert_eq!(decode_receipt::<Receipt>(r#"{"other":1}"#), None);
        assert_eq!(decode_receipt::<Receipt>(r#"{"id":7}"#), Some(Receipt { id: 7 }));
    }

    #[test]
    fn a_download_is_written_beside_its_destination_under_a_part_name() {
        let destination = Path::new("/tmp/example/dist.zip");
        assert_eq!(part_path(destination), Path::new("/tmp/example/dist.zip.part"));
    }

    /// A folder of its own under the system temp dir, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir()
                .join(format!("codeflow-ci-download-{label}-{}-{unique}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn chunks(parts: Vec<Result<Vec<u8>, String>>) -> impl futures_util::Stream<Item = Result<Vec<u8>, String>> + Unpin {
        futures_util::stream::iter(parts)
    }

    #[tokio::test]
    async fn a_finished_download_lands_under_its_name_and_reports_the_end() {
        let scratch = Scratch::new("ok");
        let destination = scratch.0.join("dist.zip");
        let mut reports: Vec<(u64, Option<u64>)> = Vec::new();

        let written = write_stream(
            chunks(vec![Ok(b"PK\x03\x04".to_vec()), Ok(vec![7u8; 1000])]),
            &destination,
            Some(1004),
            || false,
            &mut |done, total| reports.push((done, total)),
        )
        .await
        .expect("download");

        assert_eq!(written, 1004);
        assert_eq!(std::fs::read(&destination).expect("file").len(), 1004);
        assert!(!part_path(&destination).exists(), "the .part must be renamed away");
        // The bar always gets its last step, whatever the interval did before it.
        assert_eq!(reports.last(), Some(&(1004, Some(1004))));
    }

    #[tokio::test]
    async fn an_unknown_size_finishes_at_what_arrived() {
        let scratch = Scratch::new("unknown");
        let destination = scratch.0.join("drop.zip");
        let mut last = None;
        write_stream(chunks(vec![Ok(vec![1u8; 10])]), &destination, None, || false, &mut |d, t| {
            last = Some((d, t))
        })
        .await
        .expect("download");
        assert_eq!(last, Some((10, Some(10))));
    }

    /// A zip that stops half way and still sits under the chosen name fails later, somewhere
    /// else, with an error that says nothing about the download.
    #[tokio::test]
    async fn an_interrupted_download_leaves_no_file_behind() {
        let scratch = Scratch::new("broken");
        let destination = scratch.0.join("dist.zip");

        let error = write_stream(
            chunks(vec![Ok(vec![1u8; 2048]), Err("connection reset".to_string())]),
            &destination,
            Some(10_000),
            || false,
            &mut |_, _| {},
        )
        .await
        .expect_err("a broken stream is a failed download");

        assert!(error.contains("interrupted after 2 KB"), "{error}");
        assert!(error.contains("connection reset"), "{error}");
        assert!(!destination.exists());
        assert!(!part_path(&destination).exists());
    }

    #[tokio::test]
    async fn a_cancelled_download_leaves_no_file_behind_and_says_it_was_cancelled() {
        let scratch = Scratch::new("cancel");
        let destination = scratch.0.join("dist.zip");
        let seen = std::cell::Cell::new(0);

        let error = write_stream(
            chunks(vec![Ok(vec![1u8; 10]), Ok(vec![2u8; 10]), Ok(vec![3u8; 10])]),
            &destination,
            None,
            // Cancelled once the first chunk has been written.
            || {
                seen.set(seen.get() + 1);
                seen.get() > 1
            },
            &mut |_, _| {},
        )
        .await
        .expect_err("cancelled");

        assert_eq!(error, DOWNLOAD_CANCELLED);
        assert!(!destination.exists());
        assert!(!part_path(&destination).exists());
    }

    /// The save dialog already asked about overwriting; the download must then actually replace
    /// the old file rather than fail on it.
    #[tokio::test]
    async fn a_download_replaces_the_file_the_user_chose_to_overwrite() {
        let scratch = Scratch::new("replace");
        let destination = scratch.0.join("dist.zip");
        std::fs::write(&destination, b"old").expect("old file");

        write_stream(chunks(vec![Ok(b"new contents".to_vec())]), &destination, None, || false, &mut |_, _| {})
            .await
            .expect("download");
        assert_eq!(std::fs::read(&destination).expect("file"), b"new contents");
    }

    /// Stop pressed between the click and the request: honoured, and nothing is even sent.
    #[tokio::test]
    async fn a_stop_pressed_before_the_request_goes_out_is_kept() {
        let scratch = Scratch::new("early");
        let destination = scratch.0.join("dist.zip");
        cancel_download("transfer-early");
        // Nothing listens on the discard port; a request that went out would come back as
        // "couldn't reach", not as a cancellation.
        let request = download_client().get("http://127.0.0.1:9/never");
        let error = download_to_file(request, Provider::GitHub, &destination, "transfer-early", None, |_, _| {})
            .await
            .expect_err("cancelled");
        assert_eq!(error, DOWNLOAD_CANCELLED);
        assert!(!destination.exists());
        // The transfer has ended, so its mark is gone.
        assert!(!is_cancelled("transfer-early"));
    }

    #[test]
    fn a_cancel_mark_is_per_transfer_and_cleared_when_forgotten() {
        cancel_download("transfer-a");
        assert!(is_cancelled("transfer-a"));
        assert!(!is_cancelled("transfer-b"));
        forget_download("transfer-a");
        assert!(!is_cancelled("transfer-a"));
    }
}
