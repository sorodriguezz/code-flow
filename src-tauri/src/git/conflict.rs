//! What the three-way conflict editor reads and writes.
//!
//! `merge.rs` owns the operations that *leave* conflicts behind — merge, continue, abort — and has
//! always had two ways to settle one file: take a side wholesale (`resolve_conflict_side`) or stage
//! whatever is on disk (`mark_conflict_resolved`). The editor needs three more things, which are here:
//!
//! * [`detail`] — every version of the file at once: the index's three stages (base, ours, theirs),
//!   the working copy with git's markers and whatever the user already typed into it, and what kind of
//!   conflict it is. A modify/delete or a binary conflict has no text to merge, and the editor offers
//!   whole-file choices for those instead of a result pane that would be a lie.
//! * [`merged_text`] — the file re-merged from the stages with base sections (`git merge-file
//!   --diff3`), for "start over" and for a working copy whose markers were already edited away. The
//!   markers libgit2 writes during a merge carry no base section, which is the half of a three-way
//!   merge that says *what each side changed*.
//! * [`resolve_with_text`] / [`resolve_deleted`] — write the result and stage it, the way
//!   `git add` / `git rm` settle a path. Refused when the path is no longer conflicted, so a stale
//!   editor can never write over a file somebody already resolved.

use std::path::Path;

use git2::{IndexConflict, Repository};
use serde::{Deserialize, Serialize};

use super::cli;
use super::repo::open;

/// The path the editor was opened on is not conflicted any more — resolved from the banner, from a
/// terminal, or by an abort. Nothing was written.
pub const CONFLICT_GONE_PREFIX: &str = "CONFLICT_GONE: ";

/// Everything the editor draws for one conflicted path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictDetail {
    pub path: String,
    /// `text`, `binary`, `deleted_by_us` (we deleted it, they changed it), `deleted_by_them`.
    pub kind: String,
    /// Stage 1, 2 and 3 as text — `None` when that stage is absent (added on both sides has no base;
    /// a deleted side has nothing) or when the file is not text.
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub base_present: bool,
    pub ours_present: bool,
    pub theirs_present: bool,
    /// The working copy as it is right now, when it is text: git's markers, plus any resolution the
    /// user already started. What the result pane opens on.
    pub working: Option<String>,
}

fn find_conflict(repo: &Repository, rel: &str) -> Result<Option<IndexConflict>, String> {
    let index = repo.index().map_err(|e| e.message().to_string())?;
    if !index.has_conflicts() {
        return Ok(None);
    }
    let conflicts = index.conflicts().map_err(|e| e.message().to_string())?;
    // Bound rather than returned inline: the iterator borrows `index`, and as the tail expression its
    // temporary would outlive it.
    let found = conflicts.flatten().find(|c| {
        [&c.our, &c.their, &c.ancestor]
            .iter()
            .filter_map(|entry| entry.as_ref())
            .any(|entry| entry.path == rel.as_bytes())
    });
    Ok(found)
}

/// A stage's content as text, or `None` for absent — and `Err(())` for present-but-not-text, which is
/// the fact that decides the conflict is binary.
fn stage_text(repo: &Repository, entry: &Option<git2::IndexEntry>) -> Result<Option<String>, ()> {
    let Some(entry) = entry else { return Ok(None) };
    let blob = repo.find_blob(entry.id).map_err(|_| ())?;
    if blob.is_binary() {
        return Err(());
    }
    String::from_utf8(blob.content().to_vec()).map(Some).map_err(|_| ())
}

pub fn detail(path: &str, rel: &str) -> Result<ConflictDetail, String> {
    let repo = open(path)?;
    let conflict = find_conflict(&repo, rel)?.ok_or_else(|| format!("{CONFLICT_GONE_PREFIX}{rel}"))?;
    let (base_present, ours_present, theirs_present) =
        (conflict.ancestor.is_some(), conflict.our.is_some(), conflict.their.is_some());

    let base = stage_text(&repo, &conflict.ancestor);
    let ours = stage_text(&repo, &conflict.our);
    let theirs = stage_text(&repo, &conflict.their);
    let binary = base.is_err() || ours.is_err() || theirs.is_err();

    let kind = if !ours_present {
        "deleted_by_us"
    } else if !theirs_present {
        "deleted_by_them"
    } else if binary {
        "binary"
    } else {
        "text"
    };

    // Read as bytes and kept only when it is text: a working copy that is not UTF-8 would come back
    // from the editor re-encoded, and "resolve" would then write different bytes than it showed.
    let working = repo
        .workdir()
        .and_then(|w| std::fs::read(w.join(rel)).ok())
        .filter(|bytes| !bytes.contains(&0))
        .and_then(|bytes| String::from_utf8(bytes).ok());

    Ok(ConflictDetail {
        path: rel.to_string(),
        kind: kind.to_string(),
        base: base.unwrap_or(None),
        ours: ours.unwrap_or(None),
        theirs: theirs.unwrap_or(None),
        base_present,
        ours_present,
        theirs_present,
        working: if binary { None } else { working },
    })
}

/// The file re-merged from its three stages, conflicts marked with base sections — `git merge-file -p
/// --diff3`, run on copies of the stages in a temporary directory so nothing in the repository is
/// touched. The labels are the words the editor's buttons use, so a marker and the button that
/// resolves it say the same thing.
pub fn merged_text(path: &str, rel: &str) -> Result<String, String> {
    let detail = detail(path, rel)?;
    if detail.kind != "text" {
        return Err(format!("{} has no text to merge ({})", rel, detail.kind));
    }
    let scratch = std::env::temp_dir().join(format!("codeflow-merge-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let write = |name: &str, text: &Option<String>| -> Result<String, String> {
        let file = scratch.join(name);
        std::fs::write(&file, text.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
        Ok(file.to_string_lossy().into_owned())
    };
    let result = (|| {
        let ours = write("ours", &detail.ours)?;
        let base = write("base", &detail.base)?;
        let theirs = write("theirs", &detail.theirs)?;
        let args = ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", &ours, &base, &theirs];
        let out = cli::run(&scratch, &args, &[], std::time::Duration::from_secs(60))?;
        // The exit status is the number of conflicts, so anything from 0 to 127 is an answer; only a
        // negative one (git's -1, 255 as a byte) or a run that printed nothing to stdout failed.
        if out.timed_out || (!out.success && out.stdout.is_empty() && !out.stderr.is_empty()) {
            return Err(out.detail());
        }
        Ok(out.stdout)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// Writes `text` as the resolution of `rel` and stages it — `git add` after editing the file.
pub fn resolve_with_text(path: &str, rel: &str, text: &str) -> Result<(), String> {
    let repo = open(path)?;
    if find_conflict(&repo, rel)?.is_none() {
        return Err(format!("{CONFLICT_GONE_PREFIX}{rel}"));
    }
    let workdir = repo.workdir().ok_or("bare repository")?;
    let full = workdir.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
    }
    std::fs::write(&full, text).map_err(|e| format!("{rel}: {e}"))?;
    stage_resolution(path, &repo, rel)
}

/// Resolves `rel` as deleted — `git rm`: gone from disk and from every stage of the index.
pub fn resolve_deleted(path: &str, rel: &str) -> Result<(), String> {
    let repo = open(path)?;
    if find_conflict(&repo, rel)?.is_none() {
        return Err(format!("{CONFLICT_GONE_PREFIX}{rel}"));
    }
    let workdir = repo.workdir().ok_or("bare repository")?;
    match std::fs::remove_file(workdir.join(rel)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{rel}: {e}")),
    }
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index.remove_path(Path::new(rel)).map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())
}

/// Stages the file on disk as the resolution. Through `git add` for an LFS path, whose index copy has
/// to be a pointer — see `features.rs`.
fn stage_resolution(path: &str, repo: &Repository, rel: &str) -> Result<(), String> {
    if super::features::stage_needs_cli(repo, rel) {
        return super::features::cli_add(path, &[rel]);
    }
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index.add_path(Path::new(rel)).map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())
}

/// Keeps one side of an LFS conflict through the CLI — `git checkout --ours|--theirs` runs the smudge
/// filter, so the working tree gets the real file rather than the pointer the stage holds — and
/// stages it. `None` when the path is not an LFS one, for the caller to take the libgit2 route.
pub fn resolve_side_via_cli(path: &str, rel: &str, side: &str) -> Result<Option<()>, String> {
    let repo = open(path)?;
    if !super::features::stage_needs_cli(&repo, rel) {
        return Ok(None);
    }
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err("side must be 'ours' or 'theirs'".to_string()),
    };
    let out = cli::run_in(path, &["checkout", flag, "--", rel], &[])?;
    if !out.success {
        return Err(out.detail());
    }
    super::features::cli_add(path, &[rel]).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn git(dir: &Path, args: &[&str]) -> cli::Output {
        cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap()
    }

    fn ok(dir: &Path, args: &[&str]) {
        let out = git(dir, args);
        assert!(out.success, "git {args:?}: {}", out.combined());
    }

    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-conflict-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        ok(&dir, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", "/dev/null"),
            ("merge.conflictStyle", "merge"),
        ] {
            ok(&dir, &["config", key, value]);
        }
        dir
    }

    fn commit(dir: &Path, message: &str) {
        ok(dir, &["add", "-A"]);
        ok(dir, &["commit", "-q", "-m", message]);
    }

    /// `a.txt` edited on the same line on two branches, merged: a text conflict.
    fn text_conflict() -> PathBuf {
        let dir = fixture();
        fs::write(dir.join("a.txt"), "top\nshared\nbottom\n").unwrap();
        commit(&dir, "base");
        ok(&dir, &["checkout", "-q", "-b", "feature"]);
        fs::write(dir.join("a.txt"), "top\ntheirs line\nbottom\n").unwrap();
        commit(&dir, "theirs");
        ok(&dir, &["checkout", "-q", "main"]);
        fs::write(dir.join("a.txt"), "top\nours line\nbottom\n").unwrap();
        commit(&dir, "ours");
        assert!(!git(&dir, &["merge", "feature"]).success, "the merge should conflict");
        dir
    }

    #[test]
    fn a_text_conflict_reads_every_version() {
        let dir = text_conflict();
        let d = detail(dir.to_str().unwrap(), "a.txt").unwrap();
        assert_eq!(d.kind, "text");
        assert_eq!(d.base.as_deref(), Some("top\nshared\nbottom\n"));
        assert_eq!(d.ours.as_deref(), Some("top\nours line\nbottom\n"));
        assert_eq!(d.theirs.as_deref(), Some("top\ntheirs line\nbottom\n"));
        let working = d.working.unwrap();
        assert!(working.contains("<<<<<<<") && working.contains(">>>>>>>"), "{working}");
        fs::remove_dir_all(&dir).ok();
    }

    /// The re-merge carries the base section the working copy's markers lack.
    #[test]
    fn the_merged_text_has_base_sections() {
        let dir = text_conflict();
        let text = merged_text(dir.to_str().unwrap(), "a.txt").unwrap();
        assert!(text.contains("<<<<<<< ours\nours line\n||||||| base\nshared\n=======\ntheirs line\n>>>>>>> theirs\n"), "{text}");
        fs::remove_dir_all(&dir).ok();
    }

    /// Resolving writes the text and stages it; the conflict is gone and the index holds the text.
    #[test]
    fn resolving_with_text_writes_and_stages() {
        let dir = text_conflict();
        let path = dir.to_str().unwrap();
        resolve_with_text(path, "a.txt", "top\nours line\ntheirs line\nbottom\n").unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "top\nours line\ntheirs line\nbottom\n");
        let repo = Repository::open(&dir).unwrap();
        let index = repo.index().unwrap();
        assert!(!index.has_conflicts());
        let entry = index.get_path(Path::new("a.txt"), 0).unwrap();
        assert_eq!(repo.find_blob(entry.id).unwrap().content(), b"top\nours line\ntheirs line\nbottom\n");
        // A second resolve finds nothing to resolve and says so, rather than writing again.
        let err = resolve_with_text(path, "a.txt", "anything").unwrap_err();
        assert!(err.starts_with(CONFLICT_GONE_PREFIX), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    /// Deleted on their side, changed on ours: no text to merge, and deleting resolves it.
    #[test]
    fn a_modify_delete_conflict_is_named_and_resolvable_as_deleted() {
        let dir = fixture();
        fs::write(dir.join("gone.txt"), "v1\n").unwrap();
        commit(&dir, "base");
        ok(&dir, &["checkout", "-q", "-b", "feature"]);
        ok(&dir, &["rm", "-q", "gone.txt"]);
        commit(&dir, "delete it");
        ok(&dir, &["checkout", "-q", "main"]);
        fs::write(dir.join("gone.txt"), "v2\n").unwrap();
        commit(&dir, "change it");
        assert!(!git(&dir, &["merge", "feature"]).success);

        let path = dir.to_str().unwrap();
        let d = detail(path, "gone.txt").unwrap();
        assert_eq!(d.kind, "deleted_by_them");
        assert!(d.ours_present && !d.theirs_present);
        assert!(merged_text(path, "gone.txt").is_err());

        resolve_deleted(path, "gone.txt").unwrap();
        assert!(!dir.join("gone.txt").exists());
        let repo = Repository::open(&dir).unwrap();
        let index = repo.index().unwrap();
        assert!(!index.has_conflicts());
        assert!(index.get_path(Path::new("gone.txt"), 0).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_binary_conflict_offers_no_text() {
        let dir = fixture();
        fs::write(dir.join("img.bin"), [0u8, 1, 2, 3]).unwrap();
        commit(&dir, "base");
        ok(&dir, &["checkout", "-q", "-b", "feature"]);
        fs::write(dir.join("img.bin"), [0u8, 9, 9, 9]).unwrap();
        commit(&dir, "theirs");
        ok(&dir, &["checkout", "-q", "main"]);
        fs::write(dir.join("img.bin"), [0u8, 7, 7, 7]).unwrap();
        commit(&dir, "ours");
        assert!(!git(&dir, &["merge", "feature"]).success);

        let d = detail(dir.to_str().unwrap(), "img.bin").unwrap();
        assert_eq!(d.kind, "binary");
        assert!(d.ours.is_none() && d.theirs.is_none() && d.working.is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_path_that_is_not_conflicted_is_refused() {
        let dir = fixture();
        fs::write(dir.join("a.txt"), "x\n").unwrap();
        commit(&dir, "base");
        let err = detail(dir.to_str().unwrap(), "a.txt").unwrap_err();
        assert!(err.starts_with(CONFLICT_GONE_PREFIX), "{err}");
        fs::remove_dir_all(&dir).ok();
    }
}
