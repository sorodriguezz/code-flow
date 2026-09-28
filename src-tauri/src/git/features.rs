//! What a repository has set up that libgit2 would silently skip — commit hooks, commit signing and
//! Git LFS — and the git CLI route a commit (and an LFS path's staging) takes when any of it is there.
//!
//! # The failure this exists for
//!
//! Every commit in this app used to be `git_commit_create` and every stage `git_index_add_bypath`.
//! Neither knows that a repository can ask for more:
//!
//! * a **hook** — husky's `pre-commit` running lint-staged, a `commit-msg` enforcing Conventional
//!   Commits, pre-commit.com's whole framework — never ran, so a commit the team's tooling would have
//!   refused went in from here, and the first anyone heard of it was CI;
//! * **signing** (`commit.gpgsign`, with GPG or `gpg.format=ssh`) never happened, so a branch
//!   protected by "require signed commits" rejected the push of a commit made here;
//! * **Git LFS** is a filter *process* named in `.gitattributes`; libgit2 runs only its own built-in
//!   filters, so an LFS-tracked binary was staged whole instead of as a pointer — and then committed,
//!   putting the very bytes LFS exists to keep out straight into history.
//!
//! # The route
//!
//! Detection is cheap (a config read, a few `stat`s, one attributes lookup) and runs per call, so a
//! repository that gains husky mid-session is committed correctly on the next click. When it finds
//! hooks or signing, the commit is `git commit -F <message file>` — git runs the hooks, signs, and
//! handles a merge/revert/cherry-pick in progress on its own terms. When it finds LFS (and LFS is
//! installed), staging an LFS path is `git add`. Everything else stays on libgit2.
//!
//! **A hook refusing the commit is an ordinary outcome, not an error to hide.** It comes back tagged
//! [`HOOK_FAILED_PREFIX`] with everything the hook printed, and the frontend shows that output and
//! keeps the message in the box — the fix is almost always in the files, and retyping the message
//! afterwards is the part that used to be lost.

use std::path::{Path, PathBuf};

use git2::{Config, Repository};
use serde::{Deserialize, Serialize};

use super::cli;
use super::repo::open;

/// A commit hook exited non-zero. What follows the prefix is everything it printed.
pub const HOOK_FAILED_PREFIX: &str = "HOOK_FAILED: ";

/// `git commit` itself failed — signing, an identity git could not work out, nothing to commit.
/// What follows is git's full output.
pub const COMMIT_FAILED_PREFIX: &str = "COMMIT_FAILED: ";

/// The hooks a commit runs, in the order git runs them. `post-commit` cannot refuse anything, but it
/// still runs, and a repository whose only hook is one (`git lfs install` writes a `post-commit`) is
/// still one where a libgit2 commit skips something the user set up.
pub const COMMIT_HOOKS: [&str; 4] = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];

/// What the Changes screen's indicator says, and what decides the commit route.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoFeatures {
    /// Commit hooks that would run, from [`COMMIT_HOOKS`], in git's order.
    pub hooks: Vec<String>,
    /// `core.hooksPath` as configured, when set (husky points it at `.husky/_`). `None` means the
    /// default `.git/hooks`.
    pub hooks_path: Option<String>,
    /// `commit.gpgsign` is on: the format that signs — `openpgp`, `ssh` or `x509`.
    pub signing: Option<String>,
    /// Some path in this repository is stored through `filter=lfs`.
    pub lfs: bool,
    /// `git lfs` is installed here. Without it the CLI stages LFS paths raw too, so the indicator
    /// says so instead of promising pointers.
    pub lfs_available: bool,
}

impl RepoFeatures {
    /// Hooks or signing: the commit has to be git's own.
    pub fn commits_via_cli(&self) -> bool {
        !self.hooks.is_empty() || self.signing.is_some()
    }
}

/// `$GIT_COMMON_DIR` — where hooks, `info/attributes` and bisect state live. For a linked worktree
/// `repo.path()` is `.git/worktrees/<name>/`, and the shared directory is named by the `commondir`
/// file in it (git2 0.19 has no accessor for this).
pub(super) fn common_dir(repo: &Repository) -> PathBuf {
    let own = repo.path().to_path_buf();
    match std::fs::read_to_string(own.join("commondir")) {
        Ok(text) => {
            let pointer = PathBuf::from(text.trim());
            let joined = if pointer.is_absolute() { pointer } else { own.join(pointer) };
            joined.canonicalize().unwrap_or(joined)
        }
        Err(_) => own,
    }
}

/// Where git looks for hooks: `core.hooksPath` (relative to the working tree root, which is where
/// hooks run — githooks(5)), or `hooks/` in the common directory.
fn hooks_dir(repo: &Repository, config: &Config) -> (PathBuf, Option<String>) {
    if let Ok(configured) = config.get_path("core.hooksPath") {
        let raw = config.get_string("core.hooksPath").unwrap_or_else(|_| configured.display().to_string());
        let dir = if configured.is_absolute() {
            configured
        } else {
            repo.workdir().map(|w| w.join(&configured)).unwrap_or(configured)
        };
        return (dir, Some(raw));
    }
    (common_dir(repo).join("hooks"), None)
}

/// A hook git would run: a file at exactly that name (`pre-commit`, never `pre-commit.sample`),
/// executable where executability is a thing. On Windows git runs any file at the name through its
/// own shell, so existing is enough there.
fn is_active_hook(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn signing_format(config: &Config) -> Option<String> {
    if !config.get_bool("commit.gpgsign").unwrap_or(false) {
        return None;
    }
    Some(config.get_string("gpg.format").unwrap_or_else(|_| "openpgp".to_string()))
}

/// Whether the repository's attributes route anything through LFS: the root `.gitattributes` (where
/// `git lfs track` writes) and `info/attributes`. A nested `.gitattributes` that is the only one to
/// mention LFS is missed — rare enough, and the per-path check in [`stage_needs_cli`] still asks
/// libgit2's full attribute lookup for the path actually being staged.
fn has_lfs_attributes(repo: &Repository) -> bool {
    let mentions = |path: PathBuf| {
        std::fs::read_to_string(path)
            .map(|text| text.lines().any(|line| !line.trim_start().starts_with('#') && line.contains("filter=lfs")))
            .unwrap_or(false)
    };
    repo.workdir().is_some_and(|w| mentions(w.join(".gitattributes")))
        || mentions(common_dir(repo).join("info").join("attributes"))
}

pub fn detect_repo(repo: &Repository) -> Result<RepoFeatures, String> {
    let config = repo.config().map_err(|e| e.message().to_string())?;
    let (dir, hooks_path) = hooks_dir(repo, &config);
    let hooks = COMMIT_HOOKS
        .iter()
        .filter(|name| is_active_hook(&dir.join(name)))
        .map(|name| name.to_string())
        .collect();
    let lfs = has_lfs_attributes(repo);
    Ok(RepoFeatures {
        hooks,
        hooks_path,
        signing: signing_format(&config),
        lfs,
        // Only asked when it matters: it is a process spawn, cached, but still not free the first time.
        lfs_available: lfs && cli::lfs_available(),
    })
}

pub fn detect(path: &str) -> Result<RepoFeatures, String> {
    detect_repo(&open(path)?)
}

/// Whether staging `rel` has to go through `git add`: it is an LFS path and LFS is installed.
pub fn stage_needs_cli(repo: &Repository, rel: &str) -> bool {
    has_lfs_attributes(repo) && super::lines::is_lfs_path(repo, rel) && cli::lfs_available()
}

/// Whether staging everything has to go through `git add -A`.
pub fn stage_all_needs_cli(repo: &Repository) -> bool {
    has_lfs_attributes(repo) && cli::lfs_available()
}

/// `git add -- <paths>`, for the LFS route. Plain `add` also stages a deletion since git 2.0.
pub fn cli_add(repo_path: &str, paths: &[&str]) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    args.extend_from_slice(paths);
    let out = cli::run_in(repo_path, &args, &[])?;
    if out.success {
        Ok(())
    } else {
        Err(out.detail())
    }
}

/// `git add -A`, for the LFS route of "stage all".
pub fn cli_add_all(repo_path: &str) -> Result<(), String> {
    let out = cli::run_in(repo_path, &["add", "-A"], &[])?;
    if out.success {
        Ok(())
    } else {
        Err(out.detail())
    }
}

/// How a commit made through the CLI is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliCommit {
    /// A new commit — or, while a merge, revert or cherry-pick is stopped, that operation's commit,
    /// which `git commit` finishes on its own (parents, `CHERRY_PICK_HEAD`'s author, cleanup).
    New,
    /// `--amend`: the author is kept, as `git commit --amend` keeps it.
    Amend,
}

/// Which failure a `git commit` that did not succeed is, from what it printed.
///
/// A hook that refuses prints its own words and exits; git adds nothing — no `fatal:`, no `error:`
/// of its own. git's own refusals always carry one of those. So with hooks installed, output with no
/// line of git's own is the hook's.
pub fn classify_commit_failure(output: &str, hooks_active: bool) -> String {
    let lower = output.to_lowercase();
    if lower.contains("author identity unknown")
        || lower.contains("please tell me who you are")
        || lower.contains("empty ident name")
        || lower.contains("unable to auto-detect email address")
    {
        return format!("{}{}", super::identity::IDENTITY_MISSING_PREFIX, output.trim());
    }
    let gits_own = output.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("fatal:") || line.starts_with("error:")
    });
    if hooks_active && !gits_own {
        format!("{HOOK_FAILED_PREFIX}{}", output.trim())
    } else {
        format!("{COMMIT_FAILED_PREFIX}{}", output.trim())
    }
}

/// `git commit -F <file>`, with the same guards the libgit2 commit keeps. Returns the new HEAD.
///
/// `message: None` is `--no-edit` — finishing a merge, revert or cherry-pick with the message git
/// prepared, which is what the conflicts banner's Continue means when the box was left as it was.
///
/// `author` overrides who is committing, as the libgit2 commit's `author_name`/`author_email` do. For
/// an amend only the committer changes; the author is the original's, which is what `--amend` keeps.
pub fn commit_via_cli(
    repo_path: &str,
    message: Option<&str>,
    kind: CliCommit,
    author: Option<(String, String)>,
) -> Result<String, String> {
    let repo = open(repo_path)?;
    {
        let index = repo.index().map_err(|e| e.message().to_string())?;
        if index.has_conflicts() {
            return Err(format!("{}resolve the conflicts first", super::merge::UNRESOLVED_CONFLICTS_PREFIX));
        }
    }
    // The lock keeps a merge commit off a locked branch from every route — see
    // `merge::commit_in_progress`, which this stands in for.
    if repo.state() == git2::RepositoryState::Merge {
        super::branch::guard_head_unlocked(&repo)?;
    }
    let hooks_active = !detect_repo(&repo)?.hooks.is_empty();

    // A file rather than `-m`: a message is multi-line and may start with `-`, and neither survives
    // an argument vector as reliably as bytes in a file do. Removed whatever happens.
    let message_file = std::env::temp_dir().join(format!("codeflow-commit-{}.txt", uuid::Uuid::new_v4()));
    let message_arg = message_file.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["commit"];
    if kind == CliCommit::Amend {
        // `--allow-empty` for parity with the libgit2 amend, which never refused a message-only
        // amend of an empty commit.
        args.extend(["--amend", "--allow-empty"]);
    }
    match message.map(str::trim_end).filter(|m| !m.trim().is_empty()) {
        Some(text) => {
            std::fs::write(&message_file, text).map_err(|e| e.to_string())?;
            args.extend(["-F", message_arg.as_str()]);
        }
        None => args.push("--no-edit"),
    }

    let mut env: Vec<(&str, String)> = Vec::new();
    if let Some((name, email)) = &author {
        if kind == CliCommit::New {
            env.push(("GIT_AUTHOR_NAME", name.clone()));
            env.push(("GIT_AUTHOR_EMAIL", email.clone()));
        }
        env.push(("GIT_COMMITTER_NAME", name.clone()));
        env.push(("GIT_COMMITTER_EMAIL", email.clone()));
    }
    let env_refs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let result = cli::run_in(repo_path, &args, &env_refs);
    let _ = std::fs::remove_file(&message_file);
    let out = result?;

    if !out.success {
        if out.timed_out {
            return Err(format!("{COMMIT_FAILED_PREFIX}git commit was stopped after {} minutes", cli::LOCAL_TIMEOUT.as_secs() / 60));
        }
        return Err(classify_commit_failure(&out.combined(), hooks_active));
    }
    let repo = open(repo_path)?;
    let head = repo.head().map_err(|e| e.message().to_string())?;
    head.target()
        .map(|oid| oid.to_string())
        .ok_or_else(|| "HEAD has no commit".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A repository with one commit, configured so the machine's global git config cannot steer the
    /// test: hooks come from this repository's own `.git/hooks`, nothing signs, bytes are bytes.
    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-features-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@example.com").unwrap();
            config.set_bool("core.autocrlf", false).unwrap();
            config.set_bool("commit.gpgsign", false).unwrap();
            config.set_str("core.hooksPath", &dir.join(".git").join("hooks").to_string_lossy()).unwrap();
        }
        fs::create_dir_all(dir.join(".git").join("hooks")).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();
        dir
    }

    fn hook(dir: &Path, name: &str, body: &str) {
        let path = dir.join(".git").join("hooks").join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn stage(dir: &Path, rel: &str, content: &str) {
        fs::write(dir.join(rel), content).unwrap();
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(rel)).unwrap();
        index.write().unwrap();
    }

    fn head_message(dir: &Path) -> String {
        let repo = Repository::open(dir).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        commit.message().unwrap().to_string()
    }

    fn head_id(dir: &Path) -> git2::Oid {
        Repository::open(dir).unwrap().head().unwrap().target().unwrap()
    }

    #[test]
    fn a_plain_repository_needs_nothing_special() {
        let dir = fixture();
        let features = detect(dir.to_str().unwrap()).unwrap();
        assert!(features.hooks.is_empty());
        assert_eq!(features.signing, None);
        assert!(!features.lfs);
        assert!(!features.commits_via_cli());
        fs::remove_dir_all(&dir).ok();
    }

    /// Samples and non-executable files are not hooks; an executable file at the exact name is.
    #[test]
    fn only_executable_hooks_at_their_exact_name_count() {
        let dir = fixture();
        let hooks = dir.join(".git").join("hooks");
        fs::write(hooks.join("pre-commit.sample"), "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(hooks.join("pre-commit.sample"), fs::Permissions::from_mode(0o755)).unwrap();
            fs::write(hooks.join("commit-msg"), "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(hooks.join("commit-msg"), fs::Permissions::from_mode(0o644)).unwrap();
            assert!(detect(dir.to_str().unwrap()).unwrap().hooks.is_empty());
        }
        hook(&dir, "pre-commit", "exit 0");
        let features = detect(dir.to_str().unwrap()).unwrap();
        assert_eq!(features.hooks, vec!["pre-commit".to_string()]);
        assert!(features.commits_via_cli());
        fs::remove_dir_all(&dir).ok();
    }

    /// `core.hooksPath` relative to the working tree — husky's `.husky/_` shape.
    #[test]
    fn a_relative_hooks_path_is_read_from_the_working_tree() {
        let dir = fixture();
        {
            let repo = Repository::open(&dir).unwrap();
            repo.config().unwrap().set_str("core.hooksPath", ".husky").unwrap();
        }
        fs::create_dir_all(dir.join(".husky")).unwrap();
        let path = dir.join(".husky").join("commit-msg");
        fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let features = detect(dir.to_str().unwrap()).unwrap();
        assert_eq!(features.hooks, vec!["commit-msg".to_string()]);
        assert_eq!(features.hooks_path.as_deref(), Some(".husky"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn signing_is_detected_with_its_format() {
        let dir = fixture();
        {
            let repo = Repository::open(&dir).unwrap();
            let mut config = repo.config().unwrap();
            config.set_bool("commit.gpgsign", true).unwrap();
            config.set_str("gpg.format", "ssh").unwrap();
        }
        let features = detect(dir.to_str().unwrap()).unwrap();
        assert_eq!(features.signing.as_deref(), Some("ssh"));
        assert!(features.commits_via_cli());
        fs::remove_dir_all(&dir).ok();
    }

    /// LFS is detected from the attributes alone; whether it is *installed* is a separate fact, and
    /// the per-path check agrees with libgit2's attribute lookup.
    #[test]
    fn lfs_is_detected_from_the_attributes() {
        let dir = fixture();
        fs::write(dir.join(".gitattributes"), "# art\n*.psd filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        let features = detect(dir.to_str().unwrap()).unwrap();
        assert!(features.lfs);
        assert_eq!(features.lfs_available, cli::lfs_available());
        let repo = Repository::open(&dir).unwrap();
        assert!(super::super::lines::is_lfs_path(&repo, "cover.psd"));
        assert!(!super::super::lines::is_lfs_path(&repo, "a.txt"));
        fs::remove_dir_all(&dir).ok();
    }

    /// A pre-commit hook that refuses: nothing is committed, the error carries what the hook said,
    /// and the staged change is still staged.
    #[test]
    fn a_failing_pre_commit_hook_blocks_and_reports() {
        let dir = fixture();
        hook(&dir, "pre-commit", "echo 'lint: 2 problems in a.txt' >&2\nexit 1");
        stage(&dir, "a.txt", "two\n");
        let before = head_id(&dir);

        let err = commit_via_cli(dir.to_str().unwrap(), Some("feat: change"), CliCommit::New, None).unwrap_err();
        assert!(err.starts_with(HOOK_FAILED_PREFIX), "{err}");
        assert!(err.contains("lint: 2 problems in a.txt"), "{err}");
        assert_eq!(head_id(&dir), before, "nothing was committed");
        let repo = Repository::open(&dir).unwrap();
        assert!(repo.status_file(Path::new("a.txt")).unwrap().is_index_modified(), "still staged");
        fs::remove_dir_all(&dir).ok();
    }

    /// A `commit-msg` hook that rewrites the message: the commit carries the rewritten one.
    #[test]
    fn a_commit_msg_hook_that_rewrites_the_message_is_honoured() {
        let dir = fixture();
        hook(&dir, "commit-msg", "printf 'rewritten by the hook\\n' > \"$1\"");
        stage(&dir, "a.txt", "two\n");

        let oid = commit_via_cli(dir.to_str().unwrap(), Some("original"), CliCommit::New, None).unwrap();
        assert_eq!(oid, head_id(&dir).to_string());
        assert_eq!(head_message(&dir), "rewritten by the hook\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// With a passing hook the message goes in as written, multi-line and all.
    #[test]
    fn a_passing_hook_commits_the_message_as_written() {
        let dir = fixture();
        hook(&dir, "pre-commit", "exit 0");
        stage(&dir, "a.txt", "two\n");
        commit_via_cli(dir.to_str().unwrap(), Some("-leading dash\n\nbody line"), CliCommit::New, None).unwrap();
        assert_eq!(head_message(&dir), "-leading dash\n\nbody line\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// An amend through the CLI keeps the original author and replaces the commit.
    #[test]
    fn an_amend_keeps_the_author() {
        let dir = fixture();
        hook(&dir, "pre-commit", "exit 0");
        let before = head_id(&dir);
        stage(&dir, "a.txt", "amended\n");
        commit_via_cli(
            dir.to_str().unwrap(),
            Some("initial, amended"),
            CliCommit::Amend,
            Some(("Someone Else".into(), "else@example.com".into())),
        )
        .unwrap();
        let repo = Repository::open(&dir).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(commit.id(), before);
        assert_eq!(commit.parent_count(), 0, "the root commit was replaced, not built on");
        assert_eq!(commit.author().name(), Some("Test"));
        assert_eq!(commit.committer().name(), Some("Someone Else"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failures_are_told_apart() {
        assert!(classify_commit_failure("lint failed", true).starts_with(HOOK_FAILED_PREFIX));
        assert!(classify_commit_failure("error: gpg failed to sign the data\nfatal: failed to write commit object", true)
            .starts_with(COMMIT_FAILED_PREFIX));
        assert!(classify_commit_failure("lint failed", false).starts_with(COMMIT_FAILED_PREFIX));
        assert!(classify_commit_failure("Author identity unknown\n\n*** Please tell me who you are.", true)
            .starts_with(super::super::identity::IDENTITY_MISSING_PREFIX));
    }

    /// The app's own commit button (`diff::commit`) takes the CLI route when a hook is installed —
    /// the hook's side effect is the proof it ran.
    #[test]
    fn the_commit_button_runs_hooks_when_there_are_any() {
        let dir = fixture();
        hook(&dir, "pre-commit", "touch \"$(git rev-parse --git-dir)/hook-ran\"");
        stage(&dir, "a.txt", "two\n");
        let oid = crate::git::diff::commit(dir.to_str().unwrap(), "through the button", None, None).unwrap();
        assert_eq!(oid, head_id(&dir).to_string());
        assert!(dir.join(".git").join("hook-ran").exists(), "the pre-commit hook did not run");
        assert_eq!(head_message(&dir), "through the button\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// Finishing a stopped merge with hooks installed: `git commit` makes the merge commit (two
    /// parents, state cleaned up); a refusing hook leaves the merge exactly where it was.
    #[test]
    fn continuing_a_merge_goes_through_the_hooks() {
        // The fixture's branch is `master`, which the default lock rules cover — and a lock keeps a
        // merge commit off a branch, from this route too. Not what this test is about.
        let _pinned = crate::git::lock_rules::pin_for_test(&[]);
        let dir = fixture();
        let run = |args: &[&str]| cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(run(&["checkout", "-q", "-b", "feature"]).success);
        fs::write(dir.join("a.txt"), "feature\n").unwrap();
        assert!(run(&["commit", "-q", "-am", "feature"]).success);
        assert!(run(&["checkout", "-q", "-"]).success);
        fs::write(dir.join("a.txt"), "main\n").unwrap();
        assert!(run(&["commit", "-q", "-am", "main"]).success);
        assert!(!run(&["merge", "feature"]).success, "the merge should conflict");
        fs::write(dir.join("a.txt"), "resolved\n").unwrap();
        assert!(run(&["add", "a.txt"]).success);

        hook(&dir, "pre-commit", "echo 'not yet' >&2\nexit 1");
        let err = crate::git::merge::continue_operation(dir.to_str().unwrap(), Some("Merge feature")).unwrap_err();
        assert!(err.starts_with(HOOK_FAILED_PREFIX), "{err}");
        assert_eq!(Repository::open(&dir).unwrap().state(), git2::RepositoryState::Merge);

        hook(&dir, "pre-commit", "exit 0");
        crate::git::merge::continue_operation(dir.to_str().unwrap(), Some("Merge feature")).unwrap();
        let repo = Repository::open(&dir).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(head.message(), Some("Merge feature\n"));
        fs::remove_dir_all(&dir).ok();
    }

    /// The branch lock keeps a merge commit off a locked branch on the CLI route as well — the guard
    /// `merge::commit_in_progress` keeps on the libgit2 one.
    #[test]
    fn a_locked_branch_refuses_the_merge_commit_on_this_route_too() {
        let _pinned = crate::git::lock_rules::pin_for_test(&["master", "main"]);
        let dir = fixture();
        let run = |args: &[&str]| cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(run(&["checkout", "-q", "-b", "feature"]).success);
        fs::write(dir.join("a.txt"), "feature\n").unwrap();
        assert!(run(&["commit", "-q", "-am", "feature"]).success);
        assert!(run(&["checkout", "-q", "-"]).success);
        fs::write(dir.join("a.txt"), "main\n").unwrap();
        assert!(run(&["commit", "-q", "-am", "main"]).success);
        assert!(!run(&["merge", "feature"]).success);
        fs::write(dir.join("a.txt"), "resolved\n").unwrap();
        assert!(run(&["add", "a.txt"]).success);
        hook(&dir, "pre-commit", "exit 0");

        let err = commit_via_cli(dir.to_str().unwrap(), Some("Merge"), CliCommit::New, None).unwrap_err();
        assert!(err.starts_with(super::super::branch::BRANCH_LOCKED_PREFIX), "{err}");
        assert_eq!(Repository::open(&dir).unwrap().state(), git2::RepositoryState::Merge);
        fs::remove_dir_all(&dir).ok();
    }

    /// The LFS route end to end, when LFS is installed: the index gets a pointer, not the bytes.
    #[test]
    fn an_lfs_path_is_staged_as_a_pointer() {
        if !cli::lfs_available() {
            eprintln!("skipped: git lfs is not installed");
            return;
        }
        let dir = fixture();
        let out = cli::run_in(dir.to_str().unwrap(), &["lfs", "install", "--local"], &[]).unwrap();
        assert!(out.success, "{}", out.combined());
        fs::write(dir.join(".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        fs::write(dir.join("big.bin"), [7u8; 2048]).unwrap();
        let repo = Repository::open(&dir).unwrap();
        assert!(stage_needs_cli(&repo, "big.bin"));
        cli_add(dir.to_str().unwrap(), &["big.bin"]).unwrap();
        let repo = Repository::open(&dir).unwrap();
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("big.bin"), 0).unwrap();
        let blob = repo.find_blob(entry.id).unwrap();
        assert!(String::from_utf8_lossy(blob.content()).starts_with("version https://git-lfs.github.com/spec/v1"));
        fs::remove_dir_all(&dir).ok();
    }
}
