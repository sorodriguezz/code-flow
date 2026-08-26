use git2::Config;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Reads/writes the global git identity (`git config --global user.name/user.email`),
/// which is what `repo.signature()` falls back to for any repo that doesn't override it.
pub fn get_identity() -> Result<GitIdentity, String> {
    let config = Config::open_default().map_err(|e| e.message().to_string())?;
    Ok(GitIdentity {
        name: config.get_string("user.name").ok(),
        email: config.get_string("user.email").ok(),
    })
}

pub fn set_identity(name: &str, email: &str) -> Result<(), String> {
    let mut config = Config::open_default().map_err(|e| e.message().to_string())?;
    config.set_str("user.name", name).map_err(|e| e.message().to_string())?;
    config.set_str("user.email", email).map_err(|e| e.message().to_string())?;
    Ok(())
}

/// The config key that records *who* wrote a repository's local identity.
///
/// Without it this feature cannot tell its own writes apart from a person's. Somebody who set
/// `user.email` by hand in one repository has said something specific and deliberate, and a
/// workspace identity that silently overwrote it would be the worst possible behaviour for a
/// feature whose entire purpose is keeping two identities apart. So every write CodeFlow makes is
/// stamped, and only a stamped identity is ever replaced or removed.
const OWNER_KEY: &str = "codeflow.identityworkspace";

/// Writes a workspace's identity into one repository's own `.git/config`.
///
/// **Repo-local config, not an author passed at commit time**, and the choice matters more than it
/// looks. `diff::commit` is far from the only thing that needs an identity: `merge` signs the merge
/// commit, `stash_save` signs the stash, `checkpoint` signs its snapshots, and `blame` resolves
/// "who is You" from `repo.signature()`. The built-in terminal and every AI agent that shells out
/// to `git` cannot be handed a `Signature` at all. Threading an author through one call site would
/// leave all of those disagreeing with each other — five visible inconsistencies for a feature
/// whose whole premise is that two identities stay apart. Repo-local config *is* git's mechanism
/// for this, and using it makes every one of those correct without touching them.
///
/// `None` clears an identity this app wrote, and leaves one it did not alone.
pub fn apply_to_repo(repo_path: &str, workspace_id: &str, identity: Option<&GitIdentity>) -> Result<(), String> {
    let repo = git2::Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    // The repository's own config explicitly. The multi-level config a repo hands back is free to
    // land a write in ~/.gitconfig, where it would leak across every repository on the machine —
    // the exact opposite of what "per workspace" means.
    let mut config = repo
        .config()
        .and_then(|c| c.open_level(git2::ConfigLevel::Local))
        .map_err(|e| e.message().to_string())?;

    let owner = config.get_string(OWNER_KEY).ok();
    let has_local_name = config.get_string("user.name").is_ok();

    match identity {
        Some(identity) => {
            let (Some(name), Some(email)) = (identity.name.as_deref(), identity.email.as_deref())
            else {
                return Ok(());
            };
            // Someone set this by hand. Their repository, their decision.
            if has_local_name && owner.is_none() {
                return Ok(());
            }
            config.set_str("user.name", name).map_err(|e| e.message().to_string())?;
            config.set_str("user.email", email).map_err(|e| e.message().to_string())?;
            config.set_str(OWNER_KEY, workspace_id).map_err(|e| e.message().to_string())?;
        }
        None => {
            // Only ever removes what this app put there, so "inherit the global identity again"
            // cannot delete a hand-written override.
            if owner.is_none() {
                return Ok(());
            }
            let _ = config.remove("user.name");
            let _ = config.remove("user.email");
            let _ = config.remove(OWNER_KEY);
        }
    }
    Ok(())
}

/// What a repository would actually commit as, and where that came from.
///
/// Resolved through git's own lookup rather than reimplemented, so the answer is the one that will
/// really be used: `repo.signature()` reads the multi-level config exactly as the CLI does.
pub fn effective_for_repo(repo_path: &str) -> Result<EffectiveIdentity, String> {
    let repo = git2::Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let config = repo.config().map_err(|e| e.message().to_string())?;
    let local = config.open_level(git2::ConfigLevel::Local).ok();
    let owner = local.as_ref().and_then(|c| c.get_string(OWNER_KEY).ok());
    let has_local = local.as_ref().is_some_and(|c| c.get_string("user.name").is_ok());

    let signature = repo.signature().ok();
    Ok(EffectiveIdentity {
        name: signature.as_ref().and_then(|s| s.name().map(str::to_string)),
        email: signature.as_ref().and_then(|s| s.email().map(str::to_string)),
        source: match (has_local, owner.is_some()) {
            (true, true) => "workspace",
            (true, false) => "repository",
            _ => "global",
        }
        .to_string(),
    })
}

/// The identity a repository will commit as, plus which level of config supplied it — so the
/// settings screen can say "commits here will be authored as X, because of Y" rather than showing
/// a value with no provenance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectiveIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    /// `"workspace"` (this app wrote it), `"repository"` (a human did), or `"global"`.
    pub source: String,
}
