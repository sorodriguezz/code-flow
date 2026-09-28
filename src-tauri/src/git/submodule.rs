//! Submodules: what the superproject records, what is actually checked out, and the way to bring the
//! two together.
//!
//! Listing is libgit2's — it reads `.gitmodules`, the gitlink entries and each submodule's own HEAD
//! without running anything. Initialising and updating is the CLI's (`git submodule update --init`),
//! through `crate::remote`, because it clones and fetches: it needs the user's credentials, ssh
//! setup and the network deadline every other remote operation runs under.

use std::path::Path;

use git2::{SubmoduleIgnore, SubmoduleStatus};
use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubmoduleInfo {
    pub name: String,
    /// Repository-relative, forward slashes — the form the Changes list shows it in.
    pub path: String,
    /// The submodule's own working tree, absolute — what "open as project" adds.
    pub abs_path: String,
    pub url: Option<String>,
    /// The commit the superproject records for it: the index's, which is HEAD's unless a new one was
    /// staged.
    pub recorded_oid: Option<String>,
    /// The commit checked out inside it. `None` until it is initialised and cloned.
    pub checked_out_oid: Option<String>,
    pub initialized: bool,
    /// Checked out at a different commit from the recorded one — what `git status` shows as
    /// "new commits".
    pub out_of_sync: bool,
    /// Modified or untracked files inside it.
    pub dirty: bool,
}

pub fn list(path: &str) -> Result<Vec<SubmoduleInfo>, String> {
    let repo = open(path)?;
    let workdir = repo.workdir().ok_or("bare repository")?.to_path_buf();
    // A repository without submodules answers this from a missing `.gitmodules`, which is the case
    // this runs in almost every time — so it has to stay a cheap no.
    let submodules = repo.submodules().map_err(|e| e.message().to_string())?;
    let mut out = Vec::with_capacity(submodules.len());
    for sm in submodules {
        let name = sm.name().unwrap_or("").to_string();
        let rel = sm.path().to_string_lossy().replace('\\', "/");
        // `IgnoreNone` so a dirty submodule reads as dirty whatever `submodule.<name>.ignore` says:
        // the question here is "what is in there", not "what does `git status` choose to mention".
        let status = repo
            .submodule_status(&name, SubmoduleIgnore::None)
            .unwrap_or(SubmoduleStatus::empty());
        let recorded = sm.index_id().or_else(|| sm.head_id());
        let checked_out = sm.workdir_id();
        out.push(SubmoduleInfo {
            abs_path: workdir.join(Path::new(&rel)).to_string_lossy().into_owned(),
            path: rel,
            url: sm.url().map(str::to_string),
            recorded_oid: recorded.map(|id| id.to_string()),
            checked_out_oid: checked_out.map(|id| id.to_string()),
            initialized: !status.contains(SubmoduleStatus::WD_UNINITIALIZED) && checked_out.is_some(),
            out_of_sync: status.contains(SubmoduleStatus::WD_MODIFIED),
            dirty: status.intersects(
                SubmoduleStatus::WD_INDEX_MODIFIED | SubmoduleStatus::WD_WD_MODIFIED | SubmoduleStatus::WD_UNTRACKED,
            ),
            name,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// `git submodule update --init [--recursive] [-- <path>]`: clones what is missing and checks every
/// submodule (or the one named) out at the commit the superproject records. `--init` always, because
/// "update" on an uninitialised submodule silently does nothing, and that is the one the user is
/// most likely to be pressing it for.
pub fn update_args(path: Option<&str>, recursive: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["submodule".into(), "update".into(), "--init".into()];
    if recursive {
        args.push("--recursive".into());
    }
    if let Some(path) = path {
        args.push("--".into());
        args.push(path.to_string());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli;
    use std::fs;
    use std::path::PathBuf;

    fn ok(dir: &Path, args: &[&str]) -> String {
        let out = cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.combined());
        out.stdout
    }

    fn repo_at(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        ok(dir, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            ok(dir, &["config", key, value]);
        }
    }

    /// A superproject with `lib/` as a submodule of a local library repository. `file://` submodules
    /// are refused by default since git 2.38, hence the one-off `-c`.
    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cf-submodule-{}", uuid::Uuid::new_v4()));
        let lib = root.join("library");
        let sup = root.join("super");
        repo_at(&lib);
        fs::write(lib.join("lib.txt"), "v1\n").unwrap();
        ok(&lib, &["add", "-A"]);
        ok(&lib, &["commit", "-q", "-m", "lib v1"]);
        repo_at(&sup);
        fs::write(sup.join("app.txt"), "app\n").unwrap();
        ok(&sup, &["add", "-A"]);
        ok(&sup, &["commit", "-q", "-m", "app"]);
        ok(&sup, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.to_str().unwrap(), "lib"]);
        ok(&sup, &["commit", "-q", "-m", "add lib"]);
        (root, sup)
    }

    #[test]
    fn a_fresh_submodule_is_listed_in_sync() {
        let (root, sup) = fixture();
        let list = list(sup.to_str().unwrap()).unwrap();
        assert_eq!(list.len(), 1);
        let sm = &list[0];
        assert_eq!(sm.path, "lib");
        assert!(sm.initialized);
        assert!(!sm.out_of_sync && !sm.dirty);
        assert_eq!(sm.recorded_oid, sm.checked_out_oid);
        assert!(sm.abs_path.ends_with("lib"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn edits_and_new_commits_inside_it_are_reported() {
        let (root, sup) = fixture();
        let lib = sup.join("lib");
        fs::write(lib.join("scratch.txt"), "untracked\n").unwrap();
        assert!(list(sup.to_str().unwrap()).unwrap()[0].dirty);

        repo_at_config(&lib);
        ok(&lib, &["add", "-A"]);
        ok(&lib, &["commit", "-q", "-m", "moved on"]);
        let sm = &list(sup.to_str().unwrap()).unwrap()[0];
        assert!(sm.out_of_sync, "checked out past what the superproject records");
        assert!(!sm.dirty);
        assert_ne!(sm.recorded_oid, sm.checked_out_oid);
        fs::remove_dir_all(&root).ok();
    }

    fn repo_at_config(dir: &Path) {
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")] {
            ok(dir, &["config", key, value]);
        }
    }

    /// A clone without `--recurse-submodules` has the submodule uninitialised; the update arguments
    /// bring it in.
    #[test]
    fn update_initialises_a_missing_submodule() {
        let (root, sup) = fixture();
        let clone = root.join("clone");
        ok(&root, &["clone", "-q", sup.to_str().unwrap(), clone.to_str().unwrap()]);
        let before = &list(clone.to_str().unwrap()).unwrap()[0];
        assert!(!before.initialized);
        assert!(before.checked_out_oid.is_none());

        let mut args: Vec<String> = vec!["-c".into(), "protocol.file.allow=always".into()];
        args.extend(update_args(Some("lib"), true));
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        ok(&clone, &refs);
        let after = &list(clone.to_str().unwrap()).unwrap()[0];
        assert!(after.initialized);
        assert_eq!(after.recorded_oid, after.checked_out_oid);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn update_args_spell_out_the_options() {
        assert_eq!(update_args(None, false), vec!["submodule", "update", "--init"]);
        assert_eq!(
            update_args(Some("vendor/x"), true),
            vec!["submodule", "update", "--init", "--recursive", "--", "vendor/x"]
        );
    }

    #[test]
    fn a_repository_without_submodules_lists_none() {
        let root = std::env::temp_dir().join(format!("cf-submodule-none-{}", uuid::Uuid::new_v4()));
        repo_at(&root);
        assert!(list(root.to_str().unwrap()).unwrap().is_empty());
        fs::remove_dir_all(&root).ok();
    }
}
