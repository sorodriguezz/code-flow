//! The git half of a team run: where each member works, how its work reaches the integration branch,
//! and how the integration branch reaches the branch the user picked.
//!
//! ```text
//!   target (main) ──► integration  codeflow/team-<slug>        (worktree of its own)
//!                        ├──► item  codeflow/team-<slug>-<key>  (worktree per work item)
//!                        ◄── merge --no-ff when the item is done (and reviewed)
//!   target ◄── ff / squash / squash-without-commit, by the policy, once everything is in
//! ```
//!
//! The user's own checkout is never written to except at the very end, and only by a fast-forward
//! or a squash git itself refuses when it would overwrite local changes. A conflict is never left in
//! the integration worktree while other items are still landing: the merge is aborted there and
//! replayed in the item's own worktree, where its author (or whoever the policy names) resolves it.
//!
//! Blocking, all of it: callers run these under `spawn_blocking`, holding the run's own lock so two
//! items of one run never merge at the same time.

use std::path::Path;

use crate::git::cli;

fn git(cwd: &str, args: &[&str]) -> Result<cli::Output, String> {
    cli::run_in(cwd, args, &[])
}

fn git_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git(cwd, args)?;
    if out.success {
        Ok(out.stdout.trim().to_string())
    } else {
        Err(format!("git {}: {}", args.first().copied().unwrap_or(""), out.detail()))
    }
}

/// The branch checked out in `path`, if any.
pub fn current_branch(path: &str) -> Option<String> {
    git_ok(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| !b.is_empty() && b != "HEAD")
}

pub fn branch_exists(repo: &str, branch: &str) -> bool {
    git(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok_and(|o| o.success)
}

pub fn head_sha(path: &str) -> Result<String, String> {
    git_ok(path, &["rev-parse", "HEAD"])
}

pub fn handoff_diff(path: &str, base: &str) -> String {
    let status = git_ok(path, &["status", "--short"]).unwrap_or_default();
    let base = if base.is_empty() { "HEAD" } else { base };
    let diff = git_ok(path, &["diff", "--no-ext-diff", base, "--"]).unwrap_or_default();
    format!("{status}\n{diff}").trim().chars().take(12_000).collect()
}

pub fn inspect_impact(path: &str, base: &str, custom: &[String]) -> Result<Option<super::coordination::Impact>, String> {
    inspect_changes(path, base, |file| super::coordination::impact_path(file, custom), true)
}

pub fn work_fingerprint(path: &str, base: &str) -> Result<String, String> {
    Ok(inspect_changes(path, base, |_| true, false)?.map(|changes| changes.version).unwrap_or_default())
}

fn inspect_changes(
    path: &str, base: &str, includes: impl Fn(&str) -> bool, preview: bool,
) -> Result<Option<super::coordination::Impact>, String> {
    let base = if base.is_empty() { "HEAD" } else { base };
    let list = |args: &[&str]| {
        let out = git(path, args)?;
        if out.success { Ok(out.stdout) } else { Err(out.detail()) }
    };
    let changed = list(&["diff", "--no-renames", "--name-only", "-z", base, "--"])?;
    let untracked = list(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut files = changed.split('\0').chain(untracked.split('\0'))
        .filter(|file| !file.is_empty() && includes(file))
        .map(str::to_string).collect::<Vec<_>>();
    files.sort();
    files.dedup();
    if files.is_empty() {
        return Ok(None);
    }
    if !preview && files.len() > 128 {
        return Err("Demasiados archivos para comparar intentos.".into());
    }
    let root = Path::new(path).canonicalize().map_err(|error| error.to_string())?;
    let mut identity = Vec::new();
    let mut previews = Vec::new();
    for file in &files {
        let relative = super::intelligence::relative_path(file).ok_or("Git reportó una ruta inválida.")?;
        let entry = root.join(&relative);
        let hash = match std::fs::symlink_metadata(&entry) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let link = std::fs::read_link(&entry).map_err(|error| error.to_string())?;
                super::coordination::fingerprint(&[&link.to_string_lossy()])
            }
            Ok(meta) if meta.is_file() && entry.canonicalize().is_ok_and(|resolved| resolved.starts_with(&root)) => {
                git_ok(path, &["hash-object", "--no-filters", "--", &relative])?
            }
            Ok(_) => return Err(format!("El cambio en «{relative}» no es un archivo revisable.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => "deleted".into(),
            Err(error) => return Err(error.to_string()),
        };
        identity.extend([relative, hash]);
        if preview && untracked.split('\0').any(|candidate| candidate == file) && entry.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
            use std::io::Read;
            let mut text = Vec::new();
            if std::fs::File::open(&entry).and_then(|source| source.take(4000).read_to_end(&mut text)).is_ok() {
                previews.push(format!("+++ {file}\n{}", String::from_utf8_lossy(&text)));
            }
        }
    }
    let diff = if preview {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", base, "--"];
        args.extend(files.iter().map(String::as_str));
        format!("{}\n{}", list(&args)?, previews.join("\n\n")).chars().take(16_000).collect()
    } else {
        String::new()
    };
    let fingerprints = identity.iter().map(String::as_str).collect::<Vec<_>>();
    Ok(Some(super::coordination::Impact {
        files, diff,
        version: super::coordination::fingerprint(&fingerprints),
    }))
}

pub fn pr_commits(path: &str, target: &str, source: &str) -> Result<String, String> {
    let range = format!("refs/heads/{target}..refs/heads/{source}");
    git_ok(path, &["log", "--no-merges", "--max-count=60", "--format=%h %s", &range, "--"])
}

fn ensure_parent(target: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(target).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A new worktree at `target` on a new `branch` that starts at `start`.
pub fn add_worktree(repo: &str, target: &str, branch: &str, start: &str) -> Result<(), String> {
    ensure_parent(target)?;
    crate::git::worktree::add(repo, target, branch, true, Some(start))
}

/// A worktree at `target` with `start` checked out detached — a place to read a finished run's
/// work again without a branch of its own.
pub fn add_detached(repo: &str, target: &str, start: &str) -> Result<(), String> {
    ensure_parent(target)?;
    let _ = git(repo, &["worktree", "prune"]);
    git_ok(repo, &["worktree", "add", "--detach", target, start]).map(|_| ())
}

/// Removes a worktree when it is clean; a dirty one is left where it is (the same rule tasks follow).
pub fn remove_worktree(repo: &str, target: &str) {
    if !target.is_empty() && Path::new(target).exists() {
        let _ = crate::git::worktree::remove(repo, target, false);
    }
}

/// Deletes `branch` when every commit on it is already in `into` — so nothing can be lost — and it
/// is not checked out anywhere (git refuses that itself). A branch with work of its own stays.
pub fn delete_branch_if_contained(repo: &str, branch: &str, into: &str) -> bool {
    if branch.is_empty() || branch == into || !branch_exists(repo, branch) {
        return false;
    }
    if !git(repo, &["merge-base", "--is-ancestor", branch, into]).is_ok_and(|o| o.success) {
        return false;
    }
    git(repo, &["branch", "-D", branch]).is_ok_and(|o| o.success)
}

/// Paths git reports as unmerged in `path`.
pub fn unmerged_paths(path: &str) -> Vec<String> {
    git_ok(path, &["diff", "--name-only", "--diff-filter=U"])
        .map(|s| s.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

pub fn merge_in_progress(path: &str) -> bool {
    git_ok(path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok()
}

/// Stages everything in `path` and commits it. `Ok(None)` when there was nothing to commit.
pub fn commit_all(path: &str, message: &str) -> Result<Option<String>, String> {
    git_ok(path, &["add", "-A"])?;
    let staged = git(path, &["diff", "--cached", "--quiet"])?;
    if staged.success && !merge_in_progress(path) {
        return Ok(None);
    }
    let out = git(path, &["commit", "-m", message])?;
    if !out.success {
        return Err(format!("git commit: {}", out.detail()));
    }
    head_sha(path).map(Some)
}

/// Whether `branch` has commits that `base` lacks — i.e. whether there is anything to merge.
pub fn has_commits_beyond(path: &str, base: &str, branch: &str) -> bool {
    git_ok(path, &["rev-list", "--count", &format!("{base}..{branch}")]).ok().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0) > 0
}

pub enum Merge {
    /// The integration branch's new tip.
    #[allow(dead_code)]
    Done(String),
    Nothing,
    Conflict(Vec<String>),
}

/// Merges an item's branch into the integration worktree. A conflict is aborted on the spot and
/// reported, so the integration tree stays clean for the items still landing.
pub fn merge_into_integration(integration_path: &str, item_branch: &str, message: &str) -> Result<Merge, String> {
    let base = current_branch(integration_path).unwrap_or_else(|| "HEAD".into());
    if !has_commits_beyond(integration_path, &base, item_branch) {
        return Ok(Merge::Nothing);
    }
    let out = git(integration_path, &["merge", "--no-ff", "-m", message, item_branch])?;
    if out.success {
        return head_sha(integration_path).map(Merge::Done);
    }
    let conflicts = unmerged_paths(integration_path);
    let _ = git(integration_path, &["merge", "--abort"]);
    if conflicts.is_empty() {
        Err(format!("git merge: {}", out.detail()))
    } else {
        Ok(Merge::Conflict(conflicts))
    }
}

/// Replays the integration branch into the item's worktree so its conflicts are there to resolve.
/// `Ok(empty)` when it merged cleanly after all (the integration moved meanwhile).
pub fn bring_conflicts_into(item_path: &str, integration_branch: &str) -> Result<Vec<String>, String> {
    let out = git(item_path, &["merge", "--no-edit", integration_branch])?;
    if out.success {
        return Ok(Vec::new());
    }
    let conflicts = unmerged_paths(item_path);
    if conflicts.is_empty() {
        let _ = git(item_path, &["merge", "--abort"]);
        return Err(format!("git merge: {}", out.detail()));
    }
    Ok(conflicts)
}

/// Lines that still carry a conflict marker, in the files that were conflicted.
pub fn leftover_markers(path: &str, files: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(Path::new(path).join(file)) else { continue };
        if text.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ")) {
            out.push(file.clone());
        }
    }
    out
}

/// Closes a conflict resolution in `path`: refuses while anything is unmerged or still marked, then
/// commits the merge (and whatever else the resolver changed).
pub fn finish_resolution(path: &str, files: &[String], message: &str) -> Result<Option<String>, String> {
    let marked = leftover_markers(path, files);
    if !marked.is_empty() {
        return Err(format!("quedan marcas de conflicto en: {}", marked.join(", ")));
    }
    git_ok(path, &["add", "-A"])?;
    let unmerged = unmerged_paths(path);
    if !unmerged.is_empty() {
        return Err(format!("siguen sin resolver: {}", unmerged.join(", ")));
    }
    if merge_in_progress(path) {
        let out = git(path, &["commit", "--no-edit"])?;
        if !out.success {
            return Err(format!("git commit: {}", out.detail()));
        }
        return head_sha(path).map(Some);
    }
    commit_all(path, message)
}

/// Where `branch` is checked out among `repo`'s worktrees.
pub fn checked_out_at(repo: &str, branch: &str) -> Option<String> {
    let listing = git_ok(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let mut path: Option<String> = None;
    for line in listing.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if b == format!("refs/heads/{branch}") {
                return path;
            }
        }
    }
    None
}

pub enum Landed {
    /// The target now holds the work: how, in a sentence for the channel.
    Done(String),
    /// Bringing the target into the integration branch conflicted: resolve these there first.
    Conflict(Vec<String>),
}

/// Brings the integration branch onto the target, the way the policy says.
///
/// First the target is merged *into* the integration branch, so whatever landed on it while the team
/// worked is accounted for there (and any conflict is resolved there, by a member, not in the user's
/// checkout). Then:
/// - `item`: the target fast-forwards to the integration branch (every item's commit kept);
/// - `squash`: one commit with everything on the target;
/// - `none`: everything on the target as uncommitted changes — which needs the target checked out.
pub fn land(repo: &str, target: &str, integration_path: &str, integration_branch: &str, commit: &str, message: &str, push: bool) -> Result<Landed, String> {
    if branch_exists(repo, target) {
        let out = git(integration_path, &["merge", "--no-edit", target])?;
        if !out.success {
            let conflicts = unmerged_paths(integration_path);
            if conflicts.is_empty() {
                let _ = git(integration_path, &["merge", "--abort"]);
                return Err(format!("git merge {target}: {}", out.detail()));
            }
            return Ok(Landed::Conflict(conflicts));
        }
    }
    let tip = head_sha(integration_path)?;
    let at = checked_out_at(repo, target);
    let summary = match (commit, at.as_deref()) {
        ("item", Some(path)) => {
            git_ok(path, &["merge", "--ff-only", integration_branch])?;
            format!("{target} avanzó hasta la rama del equipo")
        }
        ("item", None) => {
            if branch_exists(repo, target) {
                git_ok(repo, &["update-ref", &format!("refs/heads/{target}"), &tip])?;
            } else {
                git_ok(repo, &["branch", target, &tip])?;
            }
            format!("{target} apunta ahora al trabajo del equipo")
        }
        ("none", Some(path)) => {
            git_ok(path, &["merge", "--squash", integration_branch])?;
            format!("los cambios están en {target} sin commit, para que los revises")
        }
        ("none", None) => {
            return Err(format!("«Sin commit» deja los cambios en una carpeta, y {target} no está abierta en ninguna. Ábrela y vuelve a integrar."));
        }
        (_, Some(path)) => {
            git_ok(path, &["merge", "--squash", integration_branch])?;
            git_ok(path, &["commit", "-m", message])?;
            format!("un commit en {target} con todo el trabajo")
        }
        (_, None) => {
            let temp = format!("{integration_path}-land");
            ensure_parent(&temp)?;
            crate::git::worktree::add(repo, &temp, target, false, None)?;
            let result = (|| {
                git_ok(&temp, &["merge", "--squash", integration_branch])?;
                git_ok(&temp, &["commit", "-m", message])
            })();
            let _ = crate::git::worktree::remove(repo, &temp, true);
            result?;
            format!("un commit en {target} con todo el trabajo")
        }
    };
    if push {
        let from = at.unwrap_or_else(|| repo.to_string());
        git_ok(&from, &["push", "origin", target])?;
        return Ok(Landed::Done(format!("{summary}; publicado en origin")));
    }
    Ok(Landed::Done(summary))
}

/// A commit message in the policy's style.
pub fn commit_message(style: &str, key: &str, title: &str) -> String {
    let title = title.trim();
    if style == "conventional" {
        let lower = title.to_lowercase();
        let kind = if lower.starts_with("fix") || lower.contains("correg") || lower.contains("corrig") || lower.contains("arregl") {
            "fix"
        } else if lower.contains("test") || lower.contains("prueba") {
            "test"
        } else if lower.contains("doc") {
            "docs"
        } else if lower.contains("refactor") {
            "refactor"
        } else {
            "feat"
        };
        let scope = crate::team::protocol::key_slug(key);
        if scope.is_empty() { format!("{kind}: {title}") } else { format!("{kind}({scope}): {title}") }
    } else {
        title.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &str, args: &[&str]) {
        let out = git(dir, args).unwrap();
        assert!(out.success, "git {args:?}: {}", out.detail());
    }

    struct Dir(std::path::PathBuf);
    impl Dir {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repo() -> (Dir, String) {
        let dir = Dir(std::env::temp_dir().join(format!("cf-team-{}", uuid::Uuid::new_v4())));
        let path = dir.path().join("repo").to_string_lossy().into_owned();
        std::fs::create_dir_all(&path).unwrap();
        sh(&path, &["init", "-q", "-b", "main"]);
        sh(&path, &["config", "user.email", "t@example.com"]);
        sh(&path, &["config", "user.name", "T"]);
        std::fs::write(Path::new(&path).join("a.txt"), "uno\n").unwrap();
        sh(&path, &["add", "-A"]);
        sh(&path, &["commit", "-q", "-m", "init"]);
        (dir, path)
    }

    #[test]
    fn items_merge_into_integration_and_land_on_main() {
        let (dir, repo) = repo();
        let integ = dir.path().join("integ").to_string_lossy().into_owned();
        add_worktree(&repo, &integ, "codeflow/team-x", "main").unwrap();
        let a = dir.path().join("a").to_string_lossy().into_owned();
        let b = dir.path().join("b").to_string_lossy().into_owned();
        add_worktree(&repo, &a, "codeflow/team-x-a", "codeflow/team-x").unwrap();
        add_worktree(&repo, &b, "codeflow/team-x-b", "codeflow/team-x").unwrap();
        std::fs::write(Path::new(&a).join("b.txt"), "a\n").unwrap();
        std::fs::write(Path::new(&b).join("c.txt"), "b\n").unwrap();
        assert!(commit_all(&a, "feat: a").unwrap().is_some());
        assert!(commit_all(&b, "feat: b").unwrap().is_some());
        assert!(matches!(merge_into_integration(&integ, "codeflow/team-x-a", "m a").unwrap(), Merge::Done(_)));
        assert!(matches!(merge_into_integration(&integ, "codeflow/team-x-b", "m b").unwrap(), Merge::Done(_)));
        assert!(matches!(merge_into_integration(&integ, "codeflow/team-x-b", "m b").unwrap(), Merge::Nothing));
        let landed = land(&repo, "main", &integ, "codeflow/team-x", "item", "feat: todo", false).unwrap();
        assert!(matches!(landed, Landed::Done(_)));
        assert!(Path::new(&repo).join("b.txt").exists());
        assert!(Path::new(&repo).join("c.txt").exists());
    }

    #[test]
    fn a_conflict_moves_to_the_item_and_resolves_there() {
        let (dir, repo) = repo();
        let integ = dir.path().join("integ").to_string_lossy().into_owned();
        add_worktree(&repo, &integ, "codeflow/team-y", "main").unwrap();
        let a = dir.path().join("a").to_string_lossy().into_owned();
        let b = dir.path().join("b").to_string_lossy().into_owned();
        add_worktree(&repo, &a, "codeflow/team-y-a", "codeflow/team-y").unwrap();
        add_worktree(&repo, &b, "codeflow/team-y-b", "codeflow/team-y").unwrap();
        std::fs::write(Path::new(&a).join("a.txt"), "de a\n").unwrap();
        std::fs::write(Path::new(&b).join("a.txt"), "de b\n").unwrap();
        commit_all(&a, "a").unwrap();
        commit_all(&b, "b").unwrap();
        assert!(matches!(merge_into_integration(&integ, "codeflow/team-y-a", "m a").unwrap(), Merge::Done(_)));
        let Merge::Conflict(files) = merge_into_integration(&integ, "codeflow/team-y-b", "m b").unwrap() else { panic!("expected a conflict") };
        assert_eq!(files, vec!["a.txt".to_string()]);
        assert!(unmerged_paths(&integ).is_empty(), "integration stays clean");
        let files = bring_conflicts_into(&b, "codeflow/team-y").unwrap();
        assert_eq!(files, vec!["a.txt".to_string()]);
        assert!(finish_resolution(&b, &files, "x").is_err(), "markers still there");
        std::fs::write(Path::new(&b).join("a.txt"), "de a y b\n").unwrap();
        assert!(finish_resolution(&b, &files, "x").unwrap().is_some());
        assert!(matches!(merge_into_integration(&integ, "codeflow/team-y-b", "m b").unwrap(), Merge::Done(_)));
    }

    #[test]
    fn none_mode_leaves_changes_uncommitted_on_the_target() {
        let (dir, repo) = repo();
        let integ = dir.path().join("integ").to_string_lossy().into_owned();
        add_worktree(&repo, &integ, "codeflow/team-z", "main").unwrap();
        std::fs::write(Path::new(&integ).join("n.txt"), "n\n").unwrap();
        commit_all(&integ, "n").unwrap();
        land(&repo, "main", &integ, "codeflow/team-z", "none", "x", false).unwrap();
        assert!(Path::new(&repo).join("n.txt").exists());
        let status = git_ok(&repo, &["status", "--porcelain"]).unwrap();
        assert!(status.contains("n.txt"), "{status}");
    }

    #[test]
    fn conventional_messages() {
        assert_eq!(commit_message("conventional", "Login", "Añadir MFA"), "feat(login): Añadir MFA");
        assert_eq!(commit_message("conventional", "", "Corregir bug"), "fix: Corregir bug");
        assert_eq!(commit_message("free", "k", "Hola"), "Hola");
    }
}
