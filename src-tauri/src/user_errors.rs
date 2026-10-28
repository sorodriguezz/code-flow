//! What went wrong, in a form a person can act on and a bug report can carry.
//!
//! [`crate::ai::classify_failure`] already does this for a failed AI run: quota, sign-in, missing CLI.
//! Everything else the app can fail at — a clone over a dead network, a file it may not write, a full
//! disk, a database that is locked — reached the user as whatever string the library threw, which is
//! usually a path and an errno.
//!
//! Two things come out of here:
//!
//! - **A kind**, from a closed list. The kind picks the sentence and the button ("Retry", "Check
//!   permissions"), so the two cannot disagree. Text that looks like technical output — a stack trace,
//!   an `SQLITE_*` code, a long log tail — is never read for a kind: a confident wrong answer is worse
//!   than [`ErrorKind::Unknown`].
//! - **A reference**, a short code like `errno/ECONNREFUSED` or `http/403` that is safe to paste into an
//!   issue. It is built only from a fixed vocabulary (see [`reference`]); a path, a URL or a sentence
//!   from a server can never become one, because the reference is chosen from known identifiers rather
//!   than cut out of the message.

use serde::Serialize;

/// Past this an error is a log, not a message: it is not classified, because a long text that merely
/// mentions "timeout" has said nothing about timeouts.
const MAX_CLASSIFIED_CHARS: usize = 600;

/// What kind of trouble it was. `snake_case` on the wire, like `AiFailureKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The network is down, the host unreachable or the connection dropped.
    Network,
    /// The request took longer than it is allowed to.
    Timeout,
    /// The operating system refused: no permission to read or write that.
    Permission,
    /// A sign-in is missing, expired or refused.
    Auth,
    /// The service is asking to slow down.
    RateLimit,
    /// No space left on the disk, or a quota on it.
    Storage,
    /// The thing is not there: a file, a branch, a record.
    NotFound,
    /// The thing exists but is in use, locked or already there.
    Conflict,
    /// The other side failed: a 5xx, "bad gateway", "service unavailable".
    Service,
    /// Everything else, and anything that looks like technical output.
    Unknown,
}

/// One failure, classified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserError {
    pub kind: ErrorKind,
    /// A code safe to copy into a report — `errno/ENOSPC`, `http/503`, `kind/timeout` — or `None`
    /// when nothing in the message maps to the vocabulary.
    pub reference: Option<String>,
    /// Whether doing the same thing again can work without anyone changing anything.
    pub retryable: bool,
}

/// The errno names this app recognises, with the kind each stands for. A closed list on purpose: it is
/// both the vocabulary of [`reference`] and the allow-list that keeps a message from leaking into it.
const ERRNOS: [(&str, ErrorKind); 24] = [
    ("ECONNREFUSED", ErrorKind::Network),
    ("ECONNRESET", ErrorKind::Network),
    ("ECONNABORTED", ErrorKind::Network),
    ("ENOTFOUND", ErrorKind::Network),
    ("EAI_AGAIN", ErrorKind::Network),
    ("EHOSTUNREACH", ErrorKind::Network),
    ("ENETUNREACH", ErrorKind::Network),
    ("ENETDOWN", ErrorKind::Network),
    ("EPIPE", ErrorKind::Network),
    ("ETIMEDOUT", ErrorKind::Timeout),
    ("ESOCKETTIMEDOUT", ErrorKind::Timeout),
    ("EACCES", ErrorKind::Permission),
    ("EPERM", ErrorKind::Permission),
    ("EROFS", ErrorKind::Permission),
    ("ENOSPC", ErrorKind::Storage),
    ("EDQUOT", ErrorKind::Storage),
    ("EMFILE", ErrorKind::Storage),
    ("ENOENT", ErrorKind::NotFound),
    ("ENOTDIR", ErrorKind::NotFound),
    ("EEXIST", ErrorKind::Conflict),
    ("EBUSY", ErrorKind::Conflict),
    ("ENOTEMPTY", ErrorKind::Conflict),
    ("ELOCKED", ErrorKind::Conflict),
    ("EAGAIN", ErrorKind::Conflict),
];

/// Wording, for the failures that do not print an errno. Lower case; matched as substrings.
const NETWORK_WORDS: [&str; 9] = [
    "could not resolve host",
    "failed to connect",
    "connection refused",
    "connection reset",
    "network is unreachable",
    "no route to host",
    "dns error",
    "error sending request",
    "offline",
];
const TIMEOUT_WORDS: [&str; 4] = ["timed out", "timeout", "deadline exceeded", "took too long"];
const PERMISSION_WORDS: [&str; 5] = [
    "permission denied",
    "operation not permitted",
    "access is denied",
    "read-only file system",
    "not allowed to",
];
const AUTH_WORDS: [&str; 8] = [
    "not signed in",
    "not logged in",
    "unauthorized",
    "authentication failed",
    "authentication required",
    "invalid credentials",
    "token expired",
    "session expired",
];
const RATE_WORDS: [&str; 3] = ["rate limit", "too many requests", "slow down"];
const STORAGE_WORDS: [&str; 3] = ["no space left", "disk full", "disk quota"];
const NOT_FOUND_WORDS: [&str; 4] = ["no such file", "not found", "does not exist", "cannot find"];
const CONFLICT_WORDS: [&str; 5] = ["already exists", "is locked", "database is locked", "in use", "being used by another"];
const SERVICE_WORDS: [&str; 5] = ["bad gateway", "service unavailable", "gateway timeout", "internal server error", "overloaded"];

/// Output that is a machine's, not a person's: a stack, a driver code, a constant. Never classified,
/// and never shown as the sentence — see [`is_technical`].
const TECHNICAL_MARKERS: [&str; 8] = [
    "stack backtrace",
    "\n   at ",
    "thread '",
    "panicked at",
    "sqlite_",
    "err_",
    "traceback (most recent",
    "caused by:",
];

/// Whether `text` reads as technical output rather than a message. The caller shows a generic line
/// instead of it, with the reference as the thing to copy.
pub fn is_technical(text: &str) -> bool {
    let lower = text.to_lowercase();
    text.chars().count() > MAX_CLASSIFIED_CHARS || TECHNICAL_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Classifies one error message.
pub fn classify(text: &str) -> UserError {
    let lower = text.to_lowercase();
    let errno = errno_in(text);
    let status = http_status_in(&lower);
    let technical = is_technical(text);

    // An errno or a status is a machine statement and says what it says at any length; wording is read
    // only from a message short enough to be one.
    let mut kind = errno.map(|(_, kind)| kind);
    if kind.is_none() {
        kind = status.and_then(kind_of_status);
    }
    if kind.is_none() && !technical {
        let says = |words: &[&str]| words.iter().any(|word| lower.contains(word));
        // Order matters: "connection timed out" is a timeout before it is a network problem, and "not
        // found" in "host not found" is a network problem before it is a missing file.
        kind = Some(if says(&TIMEOUT_WORDS) {
            ErrorKind::Timeout
        } else if says(&NETWORK_WORDS) {
            ErrorKind::Network
        } else if says(&STORAGE_WORDS) {
            ErrorKind::Storage
        } else if says(&PERMISSION_WORDS) {
            ErrorKind::Permission
        } else if says(&AUTH_WORDS) {
            ErrorKind::Auth
        } else if says(&RATE_WORDS) {
            ErrorKind::RateLimit
        } else if says(&SERVICE_WORDS) {
            ErrorKind::Service
        } else if says(&CONFLICT_WORDS) {
            ErrorKind::Conflict
        } else if says(&NOT_FOUND_WORDS) {
            ErrorKind::NotFound
        } else {
            ErrorKind::Unknown
        });
    }
    let kind = kind.unwrap_or(ErrorKind::Unknown);

    UserError { kind, reference: reference(errno.map(|(name, _)| name), status, kind), retryable: retryable(kind) }
}

/// Whether trying again unchanged is a reasonable remedy.
fn retryable(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::Network | ErrorKind::Timeout | ErrorKind::RateLimit | ErrorKind::Service | ErrorKind::Conflict)
}

/// The code to copy into a report. Chosen from the vocabulary — an errno from [`ERRNOS`], a status
/// from [`http_status_in`] — never extracted as text, so it cannot carry anything but what is in
/// those lists. With neither, the kind itself, unless it is unknown: `kind/unknown` helps nobody.
pub fn reference(errno: Option<&str>, status: Option<u16>, kind: ErrorKind) -> Option<String> {
    if let Some(name) = errno {
        // Re-checked against the list rather than trusted: this function is public.
        if ERRNOS.iter().any(|(known, _)| *known == name) {
            return Some(format!("errno/{name}"));
        }
    }
    if let Some(code) = status {
        if (100..=599).contains(&code) {
            return Some(format!("http/{code}"));
        }
    }
    if kind == ErrorKind::Unknown {
        return None;
    }
    let name = serde_json::to_value(kind).ok()?.as_str()?.to_string();
    Some(format!("kind/{name}"))
}

/// The first errno name from [`ERRNOS`] in `text`, as a whole word.
fn errno_in(text: &str) -> Option<(&'static str, ErrorKind)> {
    ERRNOS.iter().copied().find(|(name, _)| contains_word(text, name))
}

/// `word` in `text` with no letter, digit or underscore on either side — `EPERM` in "EPERM: …" but not
/// in "EPERMISSION".
fn contains_word(text: &str, word: &str) -> bool {
    let mut from = 0;
    while let Some(at) = text[from..].find(word) {
        let start = from + at;
        let end = start + word.len();
        let before_ok = text[..start].chars().next_back().map_or(true, |c| !c.is_alphanumeric() && c != '_');
        let after_ok = text[end..].chars().next().map_or(true, |c| !c.is_alphanumeric() && c != '_');
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// An HTTP status stated as such: `HTTP 503`, `status: 403`, `503 Service Unavailable`, `returned 429`.
/// Bare three-digit numbers are deliberately not statuses — a line count or a port is not one.
fn http_status_in(lower: &str) -> Option<u16> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?:\bhttp[/ ]?(?:[0-9.]+ )?|\bstatus(?: code)?[:= ]+|\breturned |\bresponse code[:= ]+|\berror code[:= ]+)([1-5][0-9]{2})\b").unwrap()
    });
    re.captures(lower).and_then(|caps| caps.get(1)).and_then(|m| m.as_str().parse().ok())
}

fn kind_of_status(status: u16) -> Option<ErrorKind> {
    Some(match status {
        401 => ErrorKind::Auth,
        403 => ErrorKind::Permission,
        404 | 410 => ErrorKind::NotFound,
        408 | 504 => ErrorKind::Timeout,
        409 | 423 => ErrorKind::Conflict,
        429 => ErrorKind::RateLimit,
        500..=599 => ErrorKind::Service,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_errno_picks_the_kind_and_becomes_the_reference() {
        let found = classify("connect ECONNREFUSED 127.0.0.1:5432");
        assert_eq!(found.kind, ErrorKind::Network);
        assert_eq!(found.reference.as_deref(), Some("errno/ECONNREFUSED"));
        assert!(found.retryable);

        let disk = classify("write failed: ENOSPC: no space left on device, write");
        assert_eq!(disk.kind, ErrorKind::Storage);
        assert_eq!(disk.reference.as_deref(), Some("errno/ENOSPC"));
        assert!(!disk.retryable);
    }

    #[test]
    fn an_errno_is_matched_as_a_whole_word() {
        assert_eq!(classify("the EPERMISSION flag was not set").kind, ErrorKind::Unknown);
        assert_eq!(classify("EACCES: permission denied, open 'x'").kind, ErrorKind::Permission);
    }

    #[test]
    fn a_status_is_read_only_when_it_is_stated_as_one() {
        assert_eq!(classify("request failed with HTTP 503").reference.as_deref(), Some("http/503"));
        assert_eq!(classify("status: 429").kind, ErrorKind::RateLimit);
        assert_eq!(classify("the server returned 404").kind, ErrorKind::NotFound);
        // A port, a line count and a year are not statuses.
        assert_eq!(classify("listening on port 503").kind, ErrorKind::Unknown);
        assert_eq!(classify("line 404 of 500").kind, ErrorKind::Unknown);
    }

    #[test]
    fn wording_decides_when_there_is_no_code() {
        assert_eq!(classify("Could not resolve host: github.com").kind, ErrorKind::Network);
        assert_eq!(classify("the operation timed out").kind, ErrorKind::Timeout);
        assert_eq!(classify("Permission denied (publickey)").kind, ErrorKind::Permission);
        assert_eq!(classify("fatal: unauthorized").kind, ErrorKind::Auth);
        assert_eq!(classify("database is locked").kind, ErrorKind::Conflict);
        assert_eq!(classify("no such file or directory").kind, ErrorKind::NotFound);
    }

    #[test]
    fn order_keeps_a_timeout_from_passing_for_a_network_error() {
        assert_eq!(classify("connection timed out").kind, ErrorKind::Timeout);
        assert_eq!(classify("host not found: could not resolve host").kind, ErrorKind::Network);
    }

    #[test]
    fn technical_output_is_never_read_for_a_kind() {
        let trace = "thread 'main' panicked at src/x.rs:1:1: connection refused, timeout";
        assert!(is_technical(trace));
        assert_eq!(classify(trace).kind, ErrorKind::Unknown);
        assert_eq!(classify("SQLITE_BUSY: database is locked").kind, ErrorKind::Unknown);
        // A long log that mentions a timeout has said nothing about timeouts.
        let log = format!("{} timed out", "x ".repeat(400));
        assert_eq!(classify(&log).kind, ErrorKind::Unknown);
    }

    #[test]
    fn a_reference_never_carries_the_message() {
        let found = classify("EACCES: permission denied, open '/Users/someone/secret/key.pem'");
        let code = found.reference.unwrap();
        assert_eq!(code, "errno/EACCES");
        assert!(!code.contains("someone") && !code.contains("pem"));
        // With no known code the kind is the reference, and an unknown kind has none.
        assert_eq!(classify("the operation timed out").reference.as_deref(), Some("kind/timeout"));
        assert_eq!(classify("something odd happened").reference, None);
    }

    #[test]
    fn a_public_reference_rejects_a_name_outside_the_vocabulary() {
        assert_eq!(reference(Some("ENOTAREALCODE"), None, ErrorKind::Unknown), None);
        assert_eq!(reference(Some("../../etc"), None, ErrorKind::Unknown), None);
        assert_eq!(reference(None, Some(999), ErrorKind::Unknown), None);
        assert_eq!(reference(None, Some(418), ErrorKind::Unknown).as_deref(), Some("http/418"));
    }
}
