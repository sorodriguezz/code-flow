//! Whether two working copies are *the same repository*.
//!
//! A repository's identity is not its path. The same repository reaches a machine by more than one
//! route — imported from wherever it was already checked out, and cloned again by CodeFlow into
//! its own `repos/` directory — and the two copies then share nothing but their remote. Comparing
//! paths therefore answers "different" for exactly the case that matters, which is how a workspace
//! ended up listing one repository twice under two folders.
//!
//! So identity here is: the same folder, **or** the same remote. A workspace holds a repository
//! once; wanting a second copy of it open at the same time is what a second workspace is for.

use serde::Serialize;

use crate::git;

/// Why an incoming repository is the one a workspace already holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DuplicateReason {
    /// Literally the same folder, reached by another spelling of its path.
    Path,
    /// A different folder, but a clone of the same remote.
    Remote,
}

/// A local path reduced to something two spellings of the same folder agree on: symlinks and `..`
/// resolved where the folder exists, separators unified, trailing ones dropped, and case folded
/// everywhere but Linux — `/Users/me/dev/api/` and `/Users/me/Dev/API` are one folder on macOS and
/// two on Linux, and this has to answer the way the filesystem does.
pub fn canonical_path(path: &str) -> String {
    let raw = path.trim();
    let resolved = std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        // A folder that isn't there to resolve — an unplugged drive, or a clone destination that
        // doesn't exist yet — still has to compare against another spelling of itself.
        .unwrap_or_else(|_| raw.to_string());
    // Windows' `canonicalize` hands back the `\\?\C:\…` verbatim form, which nothing else in the
    // database is ever written as.
    let resolved = resolved.strip_prefix(r"\\?\").unwrap_or(&resolved);
    let unified = resolved.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    // A filesystem root has nothing left after trimming, and `""` would match every other empty
    // answer rather than only itself.
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(target_os = "linux") {
        trimmed.to_string()
    } else {
        trimmed.to_lowercase()
    }
}

/// The filesystem path a remote names, for the remotes that *are* paths: `file://` URLs, absolute
/// and relative POSIX paths, and Windows drive paths. `None` for anything addressing a host.
///
/// The drive-letter case is why this exists at all: `C:\repos\api` splits on `:` exactly like the
/// scp-like `git@host:owner/repo` does, and without this it would be read as a host called `C`.
fn as_local_path(url: &str) -> Option<&str> {
    if let Some(rest) = url.strip_prefix("file://") {
        return Some(rest);
    }
    if url.starts_with('/') || url.starts_with("./") || url.starts_with("../") || url.starts_with('~') {
        return Some(url);
    }
    let bytes = url.as_bytes();
    if bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return Some(url);
    }
    None
}

/// Splits a remote into `(host[:port], path)` for the two shapes a git remote comes in: a scheme
/// URL with optional credentials, and the scp-like `[user@]host:owner/repo`.
fn split_host_path(url: &str) -> Option<(&str, &str)> {
    if let Some(idx) = url.find("://") {
        let after = &url[idx + 3..];
        // The *last* `@` wins, so a password that contains one doesn't truncate the host.
        let after = after.rsplit('@').next().unwrap_or(after);
        return after.split_once('/');
    }
    let after = url.rsplit('@').next().unwrap_or(url);
    after.split_once(':')
}

/// A remote URL reduced to the repository it points at.
///
/// Everything that can differ between two remotes of the *same* repository is dropped: the
/// transport (`https://`, `ssh://`, or the scp-like `git@host:owner/repo`), embedded credentials,
/// an SSH port, the `.git` suffix, trailing slashes, and case. All of
/// `https://token@github.com/Acme/API.git`, `git@github.com:acme/api` and
/// `ssh://git@github.com:22/acme/api/` come out as `github.com/acme/api`.
///
/// Lowercased path included, deliberately. GitHub, GitLab and Azure DevOps all treat repository
/// names case-insensitively, so `Acme/API` and `acme/api` are one repository — keeping the case
/// would let through the duplicate this exists to catch.
///
/// `None` for anything with no repository in it to name.
pub fn canonical_remote(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    if trimmed.is_empty() {
        return None;
    }

    // A remote that is a path rather than a URL — a bare repository on a mounted share, or a clone
    // of a clone. It names a repository by where it sits, so that is its identity.
    if let Some(path) = as_local_path(trimmed) {
        return Some(canonical_path(path));
    }

    let (host_port, path) = split_host_path(trimmed)?;
    // `host:22` and `host` are one host reached two ways. Only an all-digit tail is a port — the
    // scp-like form puts the repository *path* in the same position.
    let host = match host_port.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => host_port,
    };
    let path = path.trim_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{}/{}", host.to_lowercase(), path.to_lowercase()))
}

/// The `origin` of the repository at `path`, falling back to its first remote — a working copy set
/// up with only an `upstream` still has something to be identified by. `None` for a repository with
/// no remotes, or a folder that can't be opened at all.
///
/// **`origin` alone, not every remote.** A fork checked out with `origin` at the fork and
/// `upstream` at the repository it was forked from is a genuinely different repository from that
/// upstream, and people keep both open side by side. Matching on any shared remote would call
/// those two the same and refuse the second — so identity is the one remote that says which
/// repository this working copy *is*, not every repository it can reach.
pub fn primary_remote(path: &str) -> Option<String> {
    let remotes = git::remotes::list_remotes(path).ok()?;
    remotes
        .iter()
        .find(|remote| remote.name == "origin")
        .or_else(|| remotes.first())
        .map(|remote| remote.url.clone())
        .filter(|url| !url.is_empty())
}

/// A repository as the duplicate check sees it: where it sits, and which repository it is.
#[derive(Debug, Clone)]
pub struct RepoIdentity {
    path: String,
    remote: Option<String>,
}

impl RepoIdentity {
    /// Reads the repository at `path`. `declared` is a remote URL the caller already knows — the
    /// URL a clone is about to run, or the one stored on a project row — and stands in for the
    /// working copy when the working copy can't answer.
    ///
    /// The folder is read first rather than the database trusted, on purpose. A project imported
    /// from a folder recorded no remote at all until this check existed, so most existing rows
    /// have `remote_url` set to `NULL`; and a repository whose remote was re-pointed since would
    /// be compared against a URL that is no longer true. A folder that has moved, gone, or hasn't
    /// been cloned yet falls back to `declared` rather than failing the check that asked.
    pub fn read(path: &str, declared: Option<&str>) -> Self {
        let on_disk = primary_remote(path);
        let remote = on_disk.as_deref().or(declared).and_then(canonical_remote);
        RepoIdentity { path: canonical_path(path), remote }
    }

    /// Why this is the same repository as `other`, or `None` if it isn't.
    pub fn duplicate_of(&self, other: &RepoIdentity) -> Option<DuplicateReason> {
        if self.path == other.path {
            return Some(DuplicateReason::Path);
        }
        match (&self.remote, &other.remote) {
            // Two working copies with no remote between them are two repositories, not one
            // unnamed one — otherwise every second local-only repository in a workspace would be
            // refused as a duplicate of the first.
            (Some(mine), Some(theirs)) if mine == theirs => Some(DuplicateReason::Remote),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point: one repository reached by every transport is one identity.
    #[test]
    fn every_transport_of_one_repository_reduces_to_the_same_key() {
        let expected = Some("github.com/acme/api".to_string());
        for url in [
            "https://github.com/acme/api.git",
            "https://github.com/acme/api",
            "https://github.com/acme/api/",
            "https://token@github.com/acme/api.git",
            "https://user:p@ss@github.com/acme/api.git",
            "git@github.com:acme/api.git",
            "ssh://git@github.com/acme/api.git",
            "ssh://git@github.com:22/acme/api/",
            "  https://GitHub.com/Acme/API.git  ",
        ] {
            assert_eq!(canonical_remote(url), expected, "{url}");
        }
    }

    #[test]
    fn different_repositories_stay_different() {
        assert_ne!(canonical_remote("https://github.com/acme/api"), canonical_remote("https://github.com/acme/web"));
        assert_ne!(canonical_remote("https://github.com/acme/api"), canonical_remote("https://gitlab.com/acme/api"));
        // A GitLab path nests, and the nesting is part of which repository it is.
        assert_ne!(
            canonical_remote("git@gitlab.com:acme/backend/auth.git"),
            canonical_remote("git@gitlab.com:acme/auth.git"),
        );
    }

    /// `C:\repos\api` splits on `:` exactly like `git@host:owner/repo` does. Read as a URL it
    /// would name a host called `C` — and every drive path would then collide with every other.
    #[test]
    fn a_windows_drive_path_is_a_path_and_not_a_host() {
        let c = canonical_remote(r"C:\repos\api.git").unwrap();
        let d = canonical_remote(r"D:\repos\api.git").unwrap();
        assert!(c.contains("repos/api"), "{c}");
        assert_ne!(c, d, "two drives are two places");
    }

    #[test]
    fn a_path_remote_is_identified_by_where_it_is() {
        assert_eq!(canonical_remote("file:///srv/git/api.git"), canonical_remote("/srv/git/api"));
        assert_ne!(canonical_remote("/srv/git/api"), canonical_remote("/srv/git/web"));
    }

    #[test]
    fn nothing_to_name_is_no_key_rather_than_an_empty_one() {
        assert_eq!(canonical_remote(""), None);
        assert_eq!(canonical_remote("   "), None);
        assert_eq!(canonical_remote("github.com"), None);
    }

    #[test]
    fn a_path_is_stripped_of_the_ways_it_can_be_written() {
        assert_eq!(canonical_path("/tmp/dev/api/"), canonical_path("/tmp/dev/api"));
        assert_eq!(canonical_path(r"C:\dev\api"), canonical_path("C:/dev/api"));
        assert_ne!(canonical_path("/tmp/dev/api"), canonical_path("/tmp/dev/web"));
    }

    /// A root must not reduce to `""`, which would make every unresolvable empty path match it.
    #[test]
    fn a_root_keeps_a_separator() {
        assert_eq!(canonical_path("/"), "/");
    }

    fn identity(path: &str, remote: Option<&str>) -> RepoIdentity {
        RepoIdentity { path: canonical_path(path), remote: remote.and_then(canonical_remote) }
    }

    /// The reported bug: `~/dev/api` imported, then the same repository cloned into CodeFlow's own
    /// `repos/api`. Two folders, one repository — and comparing paths called them different.
    #[test]
    fn two_clones_of_one_remote_are_the_same_repository() {
        let imported = identity("/tmp/dev/api", Some("git@github.com:acme/api.git"));
        let cloned = identity("/tmp/codeflow/repos/api", Some("https://github.com/acme/api.git"));
        assert_eq!(imported.duplicate_of(&cloned), Some(DuplicateReason::Remote));
        assert_eq!(cloned.duplicate_of(&imported), Some(DuplicateReason::Remote));
    }

    #[test]
    fn the_same_folder_spelled_differently_is_the_same_repository() {
        let a = identity("/tmp/dev/api", None);
        let b = identity("/tmp/dev/api/", None);
        assert_eq!(a.duplicate_of(&b), Some(DuplicateReason::Path));
    }

    /// Two repositories with no remote between them are two repositories. Without this the check
    /// would refuse every second local-only repository in a workspace.
    #[test]
    fn remoteless_repositories_are_told_apart_by_their_folders() {
        let a = identity("/tmp/dev/api", None);
        let b = identity("/tmp/dev/web", None);
        assert_eq!(a.duplicate_of(&b), None);
    }

    #[test]
    fn unrelated_repositories_are_not_duplicates() {
        let a = identity("/tmp/dev/api", Some("git@github.com:acme/api.git"));
        let b = identity("/tmp/dev/web", Some("git@github.com:acme/web.git"));
        assert_eq!(a.duplicate_of(&b), None);
    }

    /// A fork and the repository it was forked from are two repositories people keep open side by
    /// side. The fork's working copy can *reach* the upstream — that's what its `upstream` remote
    /// is for — so identity has to be the one remote saying which repository this copy is, and not
    /// every remote it points at, or the second of the pair would be refused as a duplicate.
    #[test]
    fn a_fork_is_not_a_duplicate_of_its_upstream() {
        let fork = identity("/tmp/dev/my-api", Some("git@github.com:me/api.git"));
        let upstream = identity("/tmp/dev/api", Some("git@github.com:acme/api.git"));
        assert_eq!(fork.duplicate_of(&upstream), None);
    }
}
