//! Object storage, as a file browser sees it: S3 and the Azure Storage services.
//!
//! **These are not filesystems, and the browser in front of them is.** That gap is what this module
//! exists to close, and it closes it the same way every storage explorer does — including
//! Microsoft's, which this was asked to behave like. The rules are worth stating once, here, rather
//! than being rediscovered in each transport:
//!
//! - **There are no directories.** A bucket holds a flat set of keys, and `a/b/c.txt` contains two
//!   slashes that mean nothing to the service. Asking for a listing with `delimiter=/` makes the
//!   service group everything under a shared prefix and report the prefixes separately; those
//!   become the folders. A folder therefore *exists only while something is under it*, and one that
//!   is emptied disappears — which is the single behaviour most likely to surprise someone who
//!   thinks they are looking at a disk.
//! - **Creating a folder writes an object.** A zero-byte key ending in `/`, which is the convention
//!   every tool in this space agreed on precisely so that an empty folder can be made to persist.
//! - **Renaming copies and deletes.** There is no rename verb. Both services can copy server-side,
//!   so no bytes come through this machine, but it is two operations and it is not atomic.
//! - **Deleting is not recursive**, the same rule [`super::files::remove`] states for SFTP and FTP,
//!   and for a sharper reason here: a recursive delete on a prefix is an unbounded number of
//!   irreversible operations with no trash on the far side.
//! - **The root lists containers.** A host is an *account*, and its root is that account's buckets,
//!   containers or shares drawn as folders. This is what makes one row enough for a whole account.
//!
//! **What is shared and what is not.** Everything above is transport-independent and lives here,
//! along with the path arithmetic ([`Location`]) and the HTTP client. Signing does not: AWS uses
//! SigV4 ([`crate::sigv4`], shared with the API client) and Azure uses Shared Key, a different
//! canonical form with a different set of things it refuses to sign. Each cloud gets its own module
//! for that, and the services within a cloud share it.

pub mod account;
pub mod arm;
pub mod aws;
pub mod azure;
pub mod blob;
pub mod queue;
pub mod s3;
pub mod share;
pub mod table;

use std::time::Duration;

/// How long a single request may take before it is assumed lost.
///
/// Generous by HTTP standards because a listing of a large prefix is one request, and a cold
/// storage tier can take seconds to answer the first byte. Transfers are streamed, so this bounds
/// the *response headers*, not the download.
const TIMEOUT: Duration = Duration::from_secs(60);

/// The HTTP client every cloud transport uses.
///
/// One for the process, unlike the API client's per-request build: nothing here varies the
/// transport per call — no per-request proxy, no "trust this certificate" toggle — so the
/// connection pool is pure gain. A listing walk is a dozen requests to one host, and re-handshaking
/// TLS for each would dominate the time.
pub fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("a client with no TLS overrides always builds")
    })
}

/// Does this account answer, with this credential?
///
/// **Why a cloud row needs this at all.** Every other kind proves itself by connecting: a shell
/// opens or it doesn't, a screen appears or the viewer says why. A storage account has no session
/// to open — the first thing that ever touches the network is a listing inside a panel, so a wrong
/// key looked exactly like an empty account, and pressing Connect looked like nothing happening.
///
/// The cheapest request that proves all three things at once (the account exists, the credential
/// signs, the network reaches it) is the account root: containers on Azure, buckets on S3. It is one
/// signed GET and it is the same call the panel is about to make anyway.
///
/// Returns how many things are at that root, which is what tells an empty account from a working
/// one — the count is the only part of the answer worth showing when nothing appears in the panel.
pub async fn check(host_id: &str, spec: &super::RemoteHostSpec) -> Result<usize, String> {
    // `/blob` rather than `/` for Azure: the account root is a synthesised listing of the two file
    // services (see [`account`]), which would answer "2" without a single request leaving here.
    let root = if spec.kind.is_azure() { "/blob" } else { "/" };
    Ok(super::files::list(host_id, spec, root, &super::files::ListPage::default())
        .await?
        .entries
        .len())
}

/// Where a browser path points inside an account.
///
/// The browser hands down `/`-rooted paths — `/`, `/photos`, `/photos/2024/cat.jpg` — because that
/// is what a file browser deals in, and both panes of a dual-pane view have to speak one language.
/// This is the translation into what the services actually take: a container and a key.
///
/// The distinction that matters is [`Location::container`] being empty. That is the *account root*,
/// and it is the one listing that enumerates containers rather than objects — a different API call
/// on both clouds, not a listing with an empty prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    /// The bucket, container or share. Empty at the account root.
    pub container: String,
    /// Everything after it, with no leading slash. Empty at the root of a container.
    pub key: String,
}

impl Location {
    /// Splits a browser path. Leading and trailing slashes are tolerated on the way in because the
    /// browser produces both, depending on whether the user typed the path or clicked into it.
    pub fn parse(path: &str) -> Self {
        let trimmed = path.trim().trim_start_matches('/');
        match trimmed.split_once('/') {
            None => Self { container: trimmed.to_string(), key: String::new() },
            Some((container, key)) => Self {
                container: container.to_string(),
                // Trailing slashes are dropped here and put back by whoever needs a prefix, so that
                // `/bucket/dir` and `/bucket/dir/` are the same place — which, to a user clicking a
                // folder, they obviously are.
                key: key.trim_end_matches('/').to_string(),
            },
        }
    }

    pub fn is_account_root(&self) -> bool {
        self.container.is_empty()
    }

    /// The key with a trailing `/`, which is what a listing has to ask for: without it, prefix
    /// `photos` would also match `photographs.zip`. Empty stays empty — the root of a container is
    /// the empty prefix, not `/`.
    pub fn prefix(&self) -> String {
        if self.key.is_empty() {
            String::new()
        } else {
            format!("{}/", self.key)
        }
    }

    /// The browser path this points at, which is what goes back in [`super::files::RemoteFile`].
    pub fn path(&self) -> String {
        match (self.container.as_str(), self.key.as_str()) {
            ("", _) => "/".to_string(),
            (container, "") => format!("/{container}"),
            (container, key) => format!("/{container}/{key}"),
        }
    }
}

/// The browser path for something inside `at`.
pub fn child_path(at: &Location, name: &str) -> String {
    Location {
        container: at.container.clone(),
        key: if at.key.is_empty() { name.to_string() } else { format!("{}/{name}", at.key) },
    }
    .path()
}

/// The last segment of a key, which is what the row is called.
///
/// Trailing slashes are stripped first: a folder prefix arrives as `photos/2024/`, and its name is
/// `2024`, not the empty string after the final separator.
pub fn leaf(key: &str) -> String {
    key.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string()
}

/// A container, as a row in the account root's listing.
///
/// Containers are drawn as folders because that is what they behave like from here — you open one
/// and there are files inside — and because the alternative is a second kind of row that the
/// browser, the transfer planner and the context menu would all need to learn about.
pub fn container_row(name: &str, modified: u64) -> super::files::RemoteFile {
    super::files::RemoteFile {
        name: name.to_string(),
        path: format!("/{name}"),
        is_dir: true,
        is_link: false,
        size: 0,
        modified,
        // Deliberately blank rather than a plausible `drwxr-xr-x`. There are no POSIX modes here,
        // and inventing one would put a number in a column that no operation respects.
        permissions: String::new(),
        ..Default::default()
    }
}

/// A synthesised folder — one of the `CommonPrefixes` a delimited listing reported.
pub fn folder_row(at: &Location, key: &str) -> super::files::RemoteFile {
    let name = leaf(key);
    super::files::RemoteFile {
        path: child_path(at, &name),
        name,
        is_dir: true,
        is_link: false,
        size: 0,
        // A prefix has no timestamp of its own: it is not an object, it is the fact that objects
        // share a beginning. 0 is the contract's "the server didn't say".
        modified: 0,
        permissions: String::new(),
        ..Default::default()
    }
}

/// One object, as a row.
pub fn object_row(at: &Location, key: &str, size: u64, modified: u64) -> super::files::RemoteFile {
    let name = leaf(key);
    super::files::RemoteFile {
        path: child_path(at, &name),
        name,
        is_dir: false,
        is_link: false,
        size,
        modified,
        permissions: String::new(),
        ..Default::default()
    }
}

/// Whether a listed key is the folder marker for the prefix being listed.
///
/// A zero-byte `photos/2024/` object is how [`make_dir`](s3::make_dir) makes an empty folder
/// persist. Listing `photos/2024/` returns it as a member of itself, and showing it would put an
/// unnamed zero-byte row inside every folder that was created rather than implied.
pub fn is_own_marker(key: &str, prefix: &str) -> bool {
    key == prefix || (key.ends_with('/') && key == prefix)
}

/// Parses an RFC 1123 date — `Wed, 21 Oct 2015 07:28:00 GMT` — into epoch seconds.
///
/// What both clouds put in `Last-Modified` headers and in the `Last-Modified` element of a listing.
/// S3's *listing* uses ISO 8601 instead, which [`iso8601_seconds`] handles; a service answering in
/// a form neither recognises gets 0, the contract's "didn't say", rather than a wrong date.
pub fn rfc1123_seconds(value: &str) -> u64 {
    chrono::DateTime::parse_from_rfc2822(value)
        .map(|at| at.timestamp().max(0) as u64)
        .unwrap_or(0)
}

/// Parses an ISO 8601 instant — `2015-10-21T07:28:00.000Z` — into epoch seconds.
pub fn iso8601_seconds(value: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|at| at.timestamp().max(0) as u64)
        .unwrap_or(0)
}

/// Turns a failed response into something worth showing a user.
///
/// Both clouds answer with an XML error document carrying a code (`NoSuchBucket`,
/// `AuthenticationFailed`) and often a sentence of prose. The status alone is nearly useless here —
/// a 403 might be a wrong key, an expired SAS, a clock skew or a bucket policy, and the body is
/// where the service says which.
pub async fn explain(operation: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = xml_text(&body, "Message")
        .or_else(|| xml_text(&body, "Code"))
        .or_else(|| xml_text(&body, "AuthenticationErrorDetail"))
        .unwrap_or_else(|| body.chars().take(200).collect());
    if detail.trim().is_empty() {
        format!("Couldn't {operation}: {status}")
    } else {
        format!("Couldn't {operation}: {status} — {}", detail.trim())
    }
}

/// The text of the first `<name>` element in a document.
///
/// A scan rather than a parse because it is only ever used on error documents, which are small and
/// whose shape differs between the two clouds and between services within one of them. The real
/// listings are parsed properly, with a pull parser, in each transport.
pub fn xml_text(document: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = document.find(&open)? + open.len();
    let end = document[start..].find(&close)? + start;
    Some(unescape(&document[start..end]))
}

/// The five XML entities, expanded. Enough for the fields these services put in error documents and
/// listings — key names, which may contain `&` and `<`, and prose messages.
pub fn unescape(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_browser_path_splits_into_a_container_and_a_key() {
        assert_eq!(Location::parse("/"), Location { container: "".into(), key: "".into() });
        assert_eq!(
            Location::parse("/photos"),
            Location { container: "photos".into(), key: "".into() }
        );
        assert_eq!(
            Location::parse("/photos/2024/cat.jpg"),
            Location { container: "photos".into(), key: "2024/cat.jpg".into() }
        );
    }

    /// Clicking into a folder and typing its path produce the same place. The browser does both.
    #[test]
    fn a_trailing_slash_is_the_same_place_as_without_one() {
        assert_eq!(Location::parse("/bucket/dir/"), Location::parse("/bucket/dir"));
        assert_eq!(Location::parse("bucket/dir"), Location::parse("/bucket/dir"));
    }

    #[test]
    fn a_prefix_ends_in_a_slash_so_it_cannot_match_a_longer_sibling() {
        assert_eq!(Location::parse("/b/photos").prefix(), "photos/");
        // The root of a container is the empty prefix, not "/" — a listing asking for "/" would
        // match only keys that literally begin with a slash.
        assert_eq!(Location::parse("/b").prefix(), "");
    }

    #[test]
    fn a_location_round_trips_through_its_browser_path() {
        for path in ["/", "/bucket", "/bucket/a", "/bucket/a/b/c.txt"] {
            assert_eq!(Location::parse(path).path(), path);
        }
    }

    #[test]
    fn a_row_is_named_after_the_last_segment_of_its_key() {
        assert_eq!(leaf("2024/cat.jpg"), "cat.jpg");
        assert_eq!(leaf("photos/2024/"), "2024");
        assert_eq!(leaf("top.txt"), "top.txt");
    }

    #[test]
    fn the_folder_marker_is_not_listed_inside_itself() {
        assert!(is_own_marker("photos/2024/", "photos/2024/"));
        assert!(!is_own_marker("photos/2024/cat.jpg", "photos/2024/"));
    }

    #[test]
    fn an_error_document_is_read_for_the_sentence_the_service_wrote() {
        let body = "<?xml version=\"1.0\"?><Error><Code>NoSuchBucket</Code>\
                    <Message>The specified bucket does not exist</Message></Error>";
        assert_eq!(xml_text(body, "Message").as_deref(), Some("The specified bucket does not exist"));
        assert_eq!(xml_text(body, "Code").as_deref(), Some("NoSuchBucket"));
        assert_eq!(xml_text(body, "Nothing"), None);
    }

    #[test]
    fn timestamps_come_back_as_epoch_seconds_or_zero() {
        assert_eq!(rfc1123_seconds("Wed, 21 Oct 2015 07:28:00 GMT"), 1445412480);
        assert_eq!(iso8601_seconds("2015-10-21T07:28:00.000Z"), 1445412480);
        assert_eq!(iso8601_seconds("not a date"), 0);
    }
}
