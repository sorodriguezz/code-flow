//! The session worktree: where every participant works during a session, the host included.
//!
//! ```text
//!   checkout (untouched)  ──HEAD = base──►  worktree  codeflow/sesion-<slug>
//!                                             ▲   seed: the host's uncommitted, shareable files
//!                                             │   write_state: files that arrive from the session
//!                                             ▼   close: commit of the shared files on that branch
//! ```
//!
//! **Nothing from another machine is trusted as a path.** Every path that arrives from the session
//! goes through [`safe_relative`] before it touches the disk. The check refuses absolute paths,
//! `..`, drive letters and alternate streams, Windows device names, anything inside `.git` (a
//! hook written there would run on the next commit) and anything [`exclude`] keeps home. A peer
//! that sends `node_modules/…` or `.env` is refused on the receiving side, whatever its own build
//! allowed.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::exclude::{self, Excluded};
use super::manifest::{self, FileState, Manifest};
use crate::git::cli;

/// The short id a session's branches and folders are named after.
pub fn slug(session_id: &str) -> String {
    let clean: String = session_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    if clean.is_empty() { "sesion".to_string() } else { clean.to_ascii_lowercase() }
}

/// The branch a session's worktree sits on.
pub fn branch_name(slug: &str) -> String {
    format!("codeflow/sesion-{slug}")
}

/// Where a repository's session worktree goes by default, beside the agents' worktrees.
pub fn default_dir(repo_name: &str, slug: &str) -> PathBuf {
    crate::paths::agent_worktree_dir(repo_name, &format!("sesion-{slug}"))
}

/// Windows device names, refused as any path segment (with or without an extension) on every OS so
/// a file that a Mac can write never breaks a Windows peer.
const DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A repository-relative path received from the session, checked and turned into a relative
/// [`PathBuf`]. `Err` names what was wrong, in words a log reader understands.
pub fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let out = portable_relative(path)?;
    // Size 0: the size cap is checked against the received bytes in `write_state`.
    match exclude::classify(path, true, 0) {
        Some(Excluded::Dependencies) | Some(Excluded::Secret) => Err(format!("ruta que la sesión nunca comparte: {path}")),
        _ => Ok(out),
    }
}

/// The name checks alone: a relative path that every peer's filesystem can hold, outside `.git`.
/// The scan uses it to keep home, as [`Excluded::Unportable`], a file a peer could never write.
pub fn portable_relative(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("ruta vacía o demasiado larga".into());
    }
    if path.contains('\\') || path.contains(':') || path.chars().any(|c| c.is_control()) {
        return Err(format!("ruta con caracteres no permitidos: {path}"));
    }
    let candidate = Path::new(path);
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str().ok_or_else(|| format!("ruta no UTF-8: {path}"))?;
                let lower = text.to_ascii_lowercase();
                let stem = lower.split('.').next().unwrap_or("");
                if lower == ".git" {
                    return Err(format!("ruta dentro de .git: {path}"));
                }
                if DEVICE_NAMES.contains(&stem) || text.ends_with('.') || text.ends_with(' ') {
                    return Err(format!("nombre de archivo no válido en Windows: {path}"));
                }
                out.push(part);
            }
            Component::CurDir => {}
            _ => return Err(format!("ruta fuera del repositorio: {path}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("ruta vacía".into());
    }
    Ok(out)
}

fn git_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = cli::run_in(cwd, args, &[])?;
    if out.success {
        Ok(out.stdout.trim().to_string())
    } else {
        Err(format!("git {}: {}", args.first().copied().unwrap_or(""), out.detail()))
    }
}

/// A participant's worktree for one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionCopy {
    pub path: String,
    pub branch: String,
    /// It was already there (a rejoin after a restart) rather than created now.
    pub reused: bool,
}

/// The session worktree of `repo` at `target`, on [`branch_name`]`(slug)`, starting at `base`.
/// Rejoining finds the worktree already there and keeps it, with whatever it holds.
pub fn create(repo: &str, target: &Path, slug: &str, base: &str) -> Result<SessionCopy, String> {
    let branch = branch_name(slug);
    let target_str = target.to_str().ok_or("ruta del worktree no UTF-8")?.to_string();
    if target.join(".git").exists() {
        let current = git_ok(&target_str, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        if current == branch {
            return Ok(SessionCopy { path: target_str, branch, reused: true });
        }
        return Err(format!("{target_str} ya es un worktree, en la rama «{current}»"));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // The base must be in the object store: a guest who cloned before the host's last commit has to
    // fetch first, and that is the caller's job (it knows the remote). Checked here for a clear error.
    git_ok(repo, &["cat-file", "-e", &format!("{base}^{{commit}}")])
        .map_err(|_| format!("el commit base {base} no está en este repositorio: falta un fetch"))?;
    crate::git::worktree::add(repo, &target_str, &branch, true, Some(base))?;
    Ok(SessionCopy { path: target_str, branch, reused: false })
}

/// Copies the host's uncommitted, shareable work from `checkout` into the fresh `worktree`, so the
/// session starts where the host is and not only at the last commit. The returned manifest is the
/// checkout's own: its `skipped` list is what the share dialog shows as staying home.
pub fn seed(checkout: &str, worktree: &str) -> Result<Manifest, String> {
    let scanned = manifest::scan(checkout, "HEAD")?;
    for (path, state) in &scanned.files {
        let rel = safe_relative(path)?;
        let to = Path::new(worktree).join(&rel);
        match state {
            FileState::Present { .. } => {
                if let Some(parent) = to.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(Path::new(checkout).join(&rel), &to).map_err(|e| format!("{path}: {e}"))?;
            }
            FileState::Deleted => remove_if_present(&to)?,
            FileState::Base => {}
        }
    }
    Ok(scanned)
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The bytes of `path` in commit `base`, `None` when the base has no such file.
/// A file's bytes at the session's base, `None` when the base has no such file.
pub fn base_text(worktree: &str, base: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let rel = safe_relative(path)?;
    base_bytes(worktree, base, &rel)
}

fn base_bytes(worktree: &str, base: &str, path: &Path) -> Result<Option<Vec<u8>>, String> {
    let repo = git2::Repository::open(worktree).map_err(|e| e.to_string())?;
    let commit = repo.revparse_single(base).and_then(|o| o.peel_to_commit()).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = match tree.get_path(path) {
        Ok(entry) => entry,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let blob = entry.to_object(&repo).and_then(|o| o.peel_to_blob()).map_err(|e| e.to_string())?;
    Ok(Some(blob.content().to_vec()))
}

/// Writes a state that arrived from the session into `worktree`.
///
/// - `Present`: `bytes` must hash to its sha (a corrupt or tampered blob is refused) and stay under
///   the cap. Written next to the target and renamed over it, so an editor watching the file never
///   reads half of it.
/// - `Deleted`: the file goes.
/// - `Base`: the file goes back to its bytes in `base`, or goes away if the base never had it.
pub fn write_state(worktree: &str, base: &str, path: &str, state: &FileState, bytes: Option<&[u8]>) -> Result<(), String> {
    let rel = safe_relative(path)?;
    let to = Path::new(worktree).join(&rel);
    let restored;
    let content: &[u8] = match state {
        FileState::Deleted => return remove_if_present(&to),
        FileState::Base => match base_bytes(worktree, base, &rel)? {
            None => return remove_if_present(&to),
            Some(b) => {
                restored = b;
                &restored
            }
        },
        FileState::Present { sha, .. } => {
            let bytes = bytes.ok_or_else(|| format!("{path}: faltan los bytes"))?;
            if bytes.len() as u64 > exclude::MAX_FILE_BYTES {
                return Err(format!("{path}: supera el tamaño máximo de la sesión"));
            }
            if manifest::hash_bytes(bytes) != *sha {
                return Err(format!("{path}: el contenido no coincide con su hash"));
            }
            bytes
        }
    };
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = to.with_file_name(format!(
        ".{}.cf-incoming",
        to.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("{path}: {e}"))?;
    std::fs::rename(&tmp, &to).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{path}: {e}")
    })
}

/// How closing a session worktree went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Closed {
    pub branch: String,
    /// The commit with the session's work, `None` when there was nothing to commit.
    pub commit: Option<String>,
    /// The worktree is still on disk: it held files the session never shares (a `.env`, untracked
    /// build output), and removing it would have deleted them. The branch has everything else.
    pub kept: bool,
}

/// Commits the session's shared files onto the worktree's branch and removes the worktree.
///
/// Only the files the session shares are staged, never `git add -A`. A `.env` made inside the
/// worktree must not end up in a commit just because the session ended.
pub fn close(repo: &str, worktree: &str, base: &str, message: &str) -> Result<Closed, String> {
    let branch = git_ok(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let (commit, _) = commit_shared(worktree, base, message)?;
    let kept = crate::git::worktree::remove(repo, worktree, false).is_err();
    Ok(Closed { branch, commit, kept })
}

/// Commits the files the session shares (and only those) on the worktree's branch. Returns the
/// commit, `None` when nothing changed, and the paths it covered.
pub fn commit_shared(worktree: &str, base: &str, message: &str) -> Result<(Option<String>, Vec<String>), String> {
    let scanned = manifest::scan(worktree, base)?;
    let paths: Vec<String> = scanned.files.keys().cloned().collect();
    for chunk in paths.chunks(200) {
        let mut args = vec!["add", "-A", "--"];
        args.extend(chunk.iter().map(String::as_str));
        git_ok(worktree, &args)?;
    }
    let staged = cli::run_in(worktree, &["diff", "--cached", "--quiet"], &[])?;
    if staged.success {
        return Ok((None, paths));
    }
    git_ok(worktree, &["commit", "-m", message])?;
    Ok((Some(git_ok(worktree, &["rev-parse", "HEAD"])?), paths))
}

/// Pushes the session branch, so peers can fetch the commit the base is moving to.
pub fn push_branch(worktree: &str, branch: &str) -> Result<(), String> {
    let remote = crate::git::remotes::default_remote(worktree).unwrap_or_else(|_| "origin".to_string());
    git_ok(worktree, &["push", &remote, &format!("HEAD:refs/heads/{branch}")]).map(|_| ())
}

/// Whether the commit is on some remote-tracking branch. A guest can only fetch a base the host has
/// pushed, so sharing a repository whose HEAD has unpushed commits is refused up front.
pub fn base_is_pushed(checkout: &str, base: &str) -> bool {
    git_ok(checkout, &["branch", "-r", "--contains", base]).is_ok_and(|out| !out.trim().is_empty())
}

/// Fetches from the repository's remote until `base` is in the object store. `Err` when it is
/// still missing (the host has not pushed it).
pub fn fetch_base(checkout: &str, base: &str) -> Result<(), String> {
    let present = |path: &str| git_ok(path, &["cat-file", "-e", &format!("{base}^{{commit}}")]).is_ok();
    if present(checkout) {
        return Ok(());
    }
    let remote = crate::git::remotes::default_remote(checkout).unwrap_or_else(|_| "origin".to_string());
    // A failed fetch is reported through the presence check below, with the clearer message.
    let _ = git_ok(checkout, &["fetch", &remote, "--prune"]);
    if present(checkout) {
        return Ok(());
    }
    // A host's session branch is not a default refspec target on older clones: ask for it directly.
    let _ = git_ok(checkout, &["fetch", &remote, base]);
    if present(checkout) {
        Ok(())
    } else {
        Err(format!("no se pudo traer el commit {base}: el anfitrión todavía no lo subió"))
    }
}

/// Moves a worktree to a new base without touching its files. After a session commit every copy
/// already holds the committed content, so only HEAD and the index move. What still differs from the
/// new base is, by construction, what was not yet committed.
pub fn move_base(worktree: &str, new_base: &str) -> Result<(), String> {
    git_ok(worktree, &["reset", "--mixed", "-q", new_base]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::manifest::tests::repo;
    use std::fs;

    #[test]
    fn slugs_and_branches_are_tame() {
        assert_eq!(slug("7F3A91C2-0000-4000-8000-000000000000"), "7f3a91c2");
        assert_eq!(slug("--"), "sesion");
        assert_eq!(branch_name("7f3a91c2"), "codeflow/sesion-7f3a91c2");
    }

    #[test]
    fn hostile_paths_are_refused() {
        for bad in [
            "",
            "/etc/passwd",
            "../outside.txt",
            "src/../../x",
            "C:/Windows/x",
            "a\\b.txt",
            "file.txt:stream",
            ".git/hooks/pre-commit",
            "sub/.GIT/config",
            "con.txt",
            "dir/NUL",
            "trailing.",
            "node_modules/evil/index.js",
            ".env",
            "deploy/server.pem",
            "tab\there",
        ] {
            assert!(safe_relative(bad).is_err(), "{bad:?} should be refused");
        }
        for good in ["a.txt", "src/transport/service.ts", "assets/logo.png", ".env.example", "docs/con-text.md", "./a.txt"] {
            assert!(safe_relative(good).is_ok(), "{good:?} should pass");
        }
    }

    fn worktree_for(dir: &Path, base: &str) -> (String, PathBuf) {
        let target = std::env::temp_dir().join(format!("cf-sesion-{}", uuid::Uuid::new_v4())).join("repo");
        let copy = create(dir.to_str().unwrap(), &target, "abc12345", base).unwrap();
        assert_eq!(copy.branch, "codeflow/sesion-abc12345");
        (copy.path, target)
    }

    #[test]
    fn a_worktree_is_created_on_the_base_and_found_again() {
        let (dir, base) = repo();
        let (path, target) = worktree_for(&dir, &base);
        assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "one\n");
        let again = create(dir.to_str().unwrap(), &target, "abc12345", &base).unwrap();
        assert!(again.reused);
        assert_eq!(again.path, path);
        assert!(create(dir.to_str().unwrap(), &target, "other999", &base).is_err());
    }

    #[test]
    fn a_missing_base_asks_for_a_fetch() {
        let (dir, _) = repo();
        let target = std::env::temp_dir().join(format!("cf-sesion-{}", uuid::Uuid::new_v4()));
        let err = create(dir.to_str().unwrap(), &target, "abc12345", "0123456789abcdef0123456789abcdef01234567").unwrap_err();
        assert!(err.contains("fetch"), "{err}");
    }

    #[test]
    fn seeding_carries_shareable_work_and_leaves_secrets_home() {
        let (dir, base) = repo();
        fs::write(dir.join("a.txt"), "host edit\n").unwrap();
        fs::remove_file(dir.join("keep.txt")).unwrap();
        fs::write(dir.join("new.txt"), "new\n").unwrap();
        fs::write(dir.join(".env"), "TOKEN=1").unwrap();
        let (path, target) = worktree_for(&dir, &base);

        let scanned = seed(dir.to_str().unwrap(), &path).unwrap();
        assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "host edit\n");
        assert_eq!(fs::read_to_string(target.join("new.txt")).unwrap(), "new\n");
        assert!(!target.join("keep.txt").exists());
        assert!(!target.join(".env").exists());
        assert!(scanned.skipped.iter().any(|s| s.path == ".env"));
        // The worktree now has the same session state as the checkout.
        assert_eq!(manifest::scan(&path, &base).unwrap().files, scanned.files);
    }

    #[test]
    fn incoming_states_are_written_checked_and_reverted() {
        let (dir, base) = repo();
        let (path, target) = worktree_for(&dir, &base);

        let bytes = b"from the session\n";
        let present = FileState::Present { sha: manifest::hash_bytes(bytes), size: bytes.len() as u64, binary: false };
        write_state(&path, &base, "deep/new.txt", &present, Some(bytes)).unwrap();
        assert_eq!(fs::read(target.join("deep/new.txt")).unwrap(), bytes);

        let tampered = FileState::Present { sha: manifest::hash_bytes(b"other"), size: 5, binary: false };
        assert!(write_state(&path, &base, "x.txt", &tampered, Some(bytes)).is_err());
        assert!(!target.join("x.txt").exists());

        write_state(&path, &base, "a.txt", &FileState::Deleted, None).unwrap();
        assert!(!target.join("a.txt").exists());
        write_state(&path, &base, "a.txt", &FileState::Base, None).unwrap();
        assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "one\n");
        write_state(&path, &base, "deep/new.txt", &FileState::Base, None).unwrap();
        assert!(!target.join("deep/new.txt").exists());

        assert!(write_state(&path, &base, ".git/hooks/post-commit", &present, Some(bytes)).is_err());
        assert!(write_state(&path, &base, "../escape.txt", &present, Some(bytes)).is_err());
        assert!(!target.parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn closing_commits_only_shared_files_and_keeps_a_tree_with_secrets() {
        let (dir, base) = repo();
        let (path, target) = worktree_for(&dir, &base);
        fs::write(target.join("a.txt"), "session work\n").unwrap();
        fs::write(target.join(".env"), "TOKEN=1").unwrap();

        let closed = close(dir.to_str().unwrap(), &path, &base, "sesión compartida").unwrap();
        assert_eq!(closed.branch, "codeflow/sesion-abc12345");
        let commit = closed.commit.expect("a commit");
        let files = git_ok(dir.to_str().unwrap(), &["show", "--name-only", "--format=", &commit]).unwrap();
        assert_eq!(files.lines().collect::<Vec<_>>(), vec!["a.txt"]);
        assert!(closed.kept, "the .env must not be deleted with the worktree");
        assert!(target.join(".env").exists());
    }

    #[test]
    fn closing_a_clean_session_removes_the_worktree() {
        let (dir, base) = repo();
        let (path, target) = worktree_for(&dir, &base);
        let closed = close(dir.to_str().unwrap(), &path, &base, "nada").unwrap();
        assert_eq!(closed.commit, None);
        assert!(!closed.kept);
        assert!(!target.exists());
    }
}
