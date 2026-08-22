//! Transport for the CI clients.
//!
//! Its own client rather than the three the PR clients share, for one reason: `ado::client`,
//! `github::client` and `gitlab::client` are all `reqwest::Client::new()` with **no timeout of any
//! kind**. That has been survivable because those clients are only ever driven by a user pressing
//! a button. This screen polls, and it downloads job logs — a hung read there parks a request
//! forever and the UI has no way to know. Giving the three shared clients a timeout would change
//! the behaviour of the pull-request paths too, which is a decision for a different change than
//! this one.
//!
//! The rest of the module exists because nothing here had a plain-text path. Every `get_json` in
//! the crate ends in `serde_json::from_str`, and a job log is `text/plain` — feeding one to those
//! produces "unexpected response from …", which reads like a bug in CodeFlow rather than like a
//! log.

use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;

use super::{JobLog, MAX_LOG_BYTES};

/// Enough time for a slow self-managed GitLab to answer a list query, and short enough that a
/// dead host doesn't leave a spinner running until the user gives up on the app.
const JSON_TIMEOUT: Duration = Duration::from_secs(45);
/// Logs get their own, longer budget: a multi-megabyte trace over a slow link is not a hang.
const LOG_TIMEOUT: Duration = Duration::from_secs(180);

/// Which host we are talking to. Only ever used to phrase errors and to switch on the one
/// provider-specific quirk in this file ([`Provider::Azure`]'s 203).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    GitHub,
    GitLab,
    Azure,
}

impl Provider {
    fn label(self) -> &'static str {
        match self {
            Provider::GitHub => "GitHub",
            Provider::GitLab => "GitLab",
            Provider::Azure => "Azure DevOps",
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

    read_capped(response, provider).await
}

/// Streams a response body until [`MAX_LOG_BYTES`], then stops asking for more.
///
/// Streamed rather than `response.text()` because the cap has to be on the *read*: a job that
/// loops printing can produce hundreds of megabytes, and a limit applied after the whole body is
/// in memory is not a limit, it is a comment.
async fn read_capped(response: reqwest::Response, provider: Provider) -> Result<JobLog, String> {
    let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut total: u64 = 0;
    let mut truncated = false;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| format!("couldn't read the log from {}: {e}", provider.label()))?;
        total += chunk.len() as u64;
        if buffer.len() as u64 >= MAX_LOG_BYTES {
            truncated = true;
            break;
        }
        let room = (MAX_LOG_BYTES - buffer.len() as u64) as usize;
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
        };
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return missing_scope(provider);
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
            Asked::Pipeline => format!(
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
    let excerpt: String = body.trim().chars().take(300).collect();
    if excerpt.is_empty() {
        format!("{} returned {status}", provider.label())
    } else {
        format!("{} returned {status}: {excerpt}", provider.label())
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
}
