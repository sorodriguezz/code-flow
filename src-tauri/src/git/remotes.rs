use serde::{Deserialize, Serialize};

use super::repo::open;

/// Marks the refusal every push, fetch and publish runs into in a repository that has no remote at
/// all — the frontend answers it by asking for a URL instead of showing git's
/// "'origin' does not appear to be a git repository".
pub const NO_REMOTE_PREFIX: &str = "NO_REMOTE: ";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

pub fn list_remotes(path: &str) -> Result<Vec<RemoteInfo>, String> {
    let repo = open(path)?;
    let names = repo.remotes().map_err(|e| e.message().to_string())?;
    let mut result = Vec::new();
    for name in names.iter().flatten() {
        if let Ok(remote) = repo.find_remote(name) {
            result.push(RemoteInfo {
                name: name.to_string(),
                url: remote.url().unwrap_or("").to_string(),
            });
        }
    }
    Ok(result)
}

pub fn set_remote_url(path: &str, name: &str, url: &str) -> Result<(), String> {
    let repo = open(path)?;
    repo.remote_set_url(name, url).map_err(|e| e.message().to_string())?;
    repo.remote_set_pushurl(name, Some(url))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Adds a remote — `git remote add <name> <url>`.
///
/// The name is checked against git's own rule before anything is written, because libgit2's
/// refusal for a bad one ("'my remote' is not a valid remote name") arrives only after the fact and
/// a name with a space in it is the likely mistake.
pub fn add_remote(path: &str, name: &str, url: &str) -> Result<(), String> {
    let (name, url) = (name.trim(), url.trim());
    if url.is_empty() {
        return Err("the remote needs a URL".to_string());
    }
    if !git2::Remote::is_valid_name(name) {
        return Err(format!("'{name}' is not a valid remote name"));
    }
    let repo = open(path)?;
    if repo.find_remote(name).is_ok() {
        return Err(format!("a remote named '{name}' already exists"));
    }
    repo.remote(name, url).map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Removes a remote — `git remote remove <name>`: its config, its remote-tracking branches, and the
/// upstream setting of every local branch that tracked it. The local branches themselves stay.
pub fn remove_remote(path: &str, name: &str) -> Result<(), String> {
    let repo = open(path)?;
    repo.remote_delete(name).map_err(|e| e.message().to_string())
}

/// The remote a push or fetch aimed at "the remote" means, in the order git itself would reach for
/// one: the current branch's upstream remote, then `origin`, then — when the repository has exactly
/// one — that one, whatever it is called.
///
/// `origin` used to be hardcoded, so a repository whose only remote is `upstream` could not publish
/// a branch at all. Several remotes with none of them `origin` and nothing tracked is genuinely
/// ambiguous, and is refused rather than guessed.
pub fn default_remote(path: &str) -> Result<String, String> {
    let repo = open(path)?;
    let names: Vec<String> = repo
        .remotes()
        .map_err(|e| e.message().to_string())?
        .iter()
        .flatten()
        .map(str::to_string)
        .collect();
    if names.is_empty() {
        return Err(format!("{NO_REMOTE_PREFIX}this repository has no remote"));
    }
    let tracked = repo.head().ok().filter(|h| h.is_branch()).and_then(|h| {
        let branch = h.shorthand()?.to_string();
        repo.config().ok()?.get_string(&format!("branch.{branch}.remote")).ok()
    });
    if let Some(remote) = tracked.filter(|r| names.contains(r)) {
        return Ok(remote);
    }
    if names.iter().any(|n| n == "origin") {
        return Ok("origin".to_string());
    }
    if names.len() == 1 {
        return Ok(names[0].clone());
    }
    Err(format!("several remotes and none is 'origin': {}", names.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn empty_repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-remotes-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        dir
    }

    #[test]
    fn a_remote_can_be_added_listed_and_removed() {
        let dir = empty_repo();
        let path = dir.to_str().unwrap();

        add_remote(path, "origin", "https://example.com/owner/repo.git").unwrap();
        let remotes = list_remotes(path).unwrap();
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url, "https://example.com/owner/repo.git");

        remove_remote(path, "origin").unwrap();
        assert!(list_remotes(path).unwrap().is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn adding_refuses_a_bad_name_a_taken_name_and_an_empty_url() {
        let dir = empty_repo();
        let path = dir.to_str().unwrap();

        assert!(add_remote(path, "my remote", "https://example.com/r.git").is_err());
        assert!(add_remote(path, "origin", "   ").is_err());
        add_remote(path, "origin", "https://example.com/r.git").unwrap();
        let err = add_remote(path, "origin", "https://example.com/other.git").unwrap_err();
        assert!(err.contains("already exists"), "{err}");

        fs::remove_dir_all(&dir).ok();
    }

    /// No remote is the tagged case the publish flow turns into a URL prompt; one remote is used
    /// whatever its name; `origin` wins over the others.
    #[test]
    fn the_default_remote_is_origin_or_the_only_one() {
        let dir = empty_repo();
        let path = dir.to_str().unwrap();

        let err = default_remote(path).unwrap_err();
        assert!(err.starts_with(NO_REMOTE_PREFIX), "{err}");

        add_remote(path, "upstream", "https://example.com/up.git").unwrap();
        assert_eq!(default_remote(path).unwrap(), "upstream");

        add_remote(path, "fork", "https://example.com/fork.git").unwrap();
        assert!(default_remote(path).is_err(), "two remotes, neither origin: ambiguous");

        add_remote(path, "origin", "https://example.com/origin.git").unwrap();
        assert_eq!(default_remote(path).unwrap(), "origin");

        fs::remove_dir_all(&dir).ok();
    }
}
