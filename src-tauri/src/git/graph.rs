use std::collections::HashMap;

use git2::{ErrorCode, Oid, Repository, Sort};
use serde::{Deserialize, Serialize};

use super::repo::open;

/// What a ref pointing at a commit actually *is*.
///
/// git2 knows this while the reference is still in hand, and the shorthand alone throws it away:
/// `v2.0.1` is a release, `main` is a branch and `origin/main` is neither of the two, but as three
/// bare strings they are three bare strings, and the graph drew them as three identical chips. A
/// tag and a branch can even carry the same name, so this cannot be recovered by looking at the
/// text afterwards — it has to be carried across.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    /// A local branch: something you can check out and commit to as it stands.
    Branch,
    /// A remote-tracking branch — where that branch was on the server the last time we looked.
    Remote,
    /// A tag, lightweight or annotated. What a release is, in practice.
    Tag,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRef {
    /// The shorthand: "main", "origin/main", "v1.0".
    pub name: String,
    pub kind: RefKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since epoch, UTC.
    pub timestamp: i64,
    pub parent_ids: Vec<String>,
    /// The branches, remote-tracking branches and tags pointing at this commit, each with its kind.
    pub refs: Vec<CommitRef>,
}

/// Local branches first, then tags, then remotes; alphabetical within each.
///
/// The graph's refs column is narrow and shows the first couple of chips, so this ordering is
/// which ones survive. Local branches say where *you* are, tags say what was released, and
/// remote-tracking refs mostly restate one of the two — `origin/HEAD` in particular is a symbolic
/// ref that always duplicates whichever remote branch is the default. Ordering rather than
/// filtering: nothing is dropped, the noise just queues behind the signal.
///
/// It is also the only stable order available. `references()` yields loose and packed refs in
/// whatever order they happen to sit on disk, so without this the same repository could list the
/// same commit's chips differently after a `git gc`.
fn ref_rank(kind: RefKind) -> u8 {
    match kind {
        RefKind::Branch => 0,
        RefKind::Tag => 1,
        RefKind::Remote => 2,
    }
}

pub(crate) fn build_ref_map(repo: &Repository) -> HashMap<String, Vec<CommitRef>> {
    let mut map: HashMap<String, Vec<CommitRef>> = HashMap::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            // Three disjoint namespaces (`refs/remotes/`, `refs/tags/`, `refs/heads/`), so the
            // order of the arms is only about readability. Anything else — `refs/notes/`, our own
            // `refs/codeflow/checkpoints/` — is not a ref the graph has a chip for.
            let kind = if r.is_remote() {
                RefKind::Remote
            } else if r.is_tag() {
                RefKind::Tag
            } else if r.is_branch() {
                RefKind::Branch
            } else {
                continue;
            };
            let Some(name) = r.shorthand() else { continue };
            // Annotated tags point at a tag object, not a commit; peel to the commit.
            let commit_id = r
                .peel_to_commit()
                .map(|c| c.id())
                .ok()
                .or_else(|| r.target());
            let Some(commit_id) = commit_id else { continue };
            map.entry(commit_id.to_string())
                .or_default()
                .push(CommitRef { name: name.to_string(), kind });
        }
    }
    for refs in map.values_mut() {
        refs.sort_by(|a, b| ref_rank(a.kind).cmp(&ref_rank(b.kind)).then_with(|| a.name.cmp(&b.name)));
    }
    map
}

/// Whether HEAD names a branch that has no commit yet — `git init` and nothing else.
///
/// Every walk that starts from HEAD (`push_head`) fails there with "reference 'refs/heads/main' not
/// found", and that is not an error to show anyone: a repository with no commits has an empty
/// history, which is the answer. Only the unborn case is caught; a HEAD that is broken some other
/// way still reports itself.
fn head_is_unborn(repo: &Repository) -> bool {
    match repo.head() {
        Ok(_) => false,
        Err(e) => matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound),
    }
}

pub(crate) fn build_commit_info(repo: &Repository, oid: Oid, ref_map: &HashMap<String, Vec<CommitRef>>) -> Result<CommitInfo, String> {
    let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
    let author = commit.author();
    let id_str = oid.to_string();

    Ok(CommitInfo {
        short_id: id_str[..7.min(id_str.len())].to_string(),
        summary: commit.summary().unwrap_or("").to_string(),
        author_name: author.name().unwrap_or("").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
        parent_ids: commit.parent_ids().map(|p| p.to_string()).collect(),
        refs: ref_map.get(&id_str).cloned().unwrap_or_default(),
        id: id_str,
    })
}

/// Returns commits in topological + chronological order (like `git log --graph --all`),
/// with raw parent links and ref names. Lane/layout computation for the graph view
/// happens on the frontend, which keeps this call cheap to re-run and easy to animate.
pub fn list_commits(path: &str, all_refs: bool, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open(path)?;
    let ref_map = build_ref_map(&repo);

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.message().to_string())?;

    if all_refs {
        walk.push_glob("refs/heads/*").map_err(|e| e.message().to_string())?;
        walk.push_glob("refs/remotes/*").map_err(|e| e.message().to_string())?;
    } else if head_is_unborn(&repo) {
        return Ok(vec![]);
    } else {
        walk.push_head().map_err(|e| e.message().to_string())?;
    }

    let mut commits = Vec::with_capacity(limit.min(1024));
    for oid in walk.take(limit) {
        let oid = oid.map_err(|e| e.message().to_string())?;
        commits.push(build_commit_info(&repo, oid, &ref_map)?);
    }

    Ok(commits)
}

/// One page of history, and whether there is more behind it.
///
/// The graph used to ask for a flat 500 commits with no way to ask for the next one, so on any real
/// repository the history simply stopped — with nothing on screen to say that it had. `skip` walks
/// past what the caller already holds rather than re-sending it; `has_more` is what the "load more"
/// row keys off, and it is computed by asking the walk for one commit past the page rather than by
/// counting the whole history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitPage {
    pub commits: Vec<CommitInfo>,
    pub has_more: bool,
}

/// A page of the same walk `list_commits` does.
///
/// Kept beside it rather than replacing it: `list_commits` is still the right call for the fixed
/// windows other screens want (the unpushed strip, the branch comparison), and a caller that wants
/// "the first N" should not have to think about paging.
pub fn list_commits_page(
    path: &str,
    all_refs: bool,
    skip: usize,
    limit: usize,
) -> Result<CommitPage, String> {
    list_commits_page_filtered(path, all_refs, skip, limit, &LogFilter::default())
}

/// What the graph's filters narrow the walk to. Every field is optional and they combine with
/// "and". Applied *in* the walk rather than to a loaded page: a filter over the commits already on
/// screen would answer "which of these five hundred", and the question is "which in the history".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LogFilter {
    /// `git log --first-parent`: each branch's own line, the merged-in work folded into its merge.
    pub first_parent: bool,
    /// A repository-relative file or folder: only commits that changed something under it.
    pub path: Option<String>,
    /// Matched case-insensitively against the author's name and e-mail.
    pub author: Option<String>,
    /// Seconds since the epoch, inclusive at both ends.
    pub since: Option<i64>,
    pub until: Option<i64>,
}

impl LogFilter {
    fn narrows(&self) -> bool {
        self.path.as_deref().is_some_and(|p| !p.trim().is_empty())
            || self.author.as_deref().is_some_and(|a| !a.trim().is_empty())
            || self.since.is_some()
            || self.until.is_some()
    }

    fn keeps(&self, commit: &git2::Commit) -> bool {
        let when = commit.time().seconds();
        if self.since.is_some_and(|since| when < since) || self.until.is_some_and(|until| when > until) {
            return false;
        }
        if let Some(author) = self.author.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            let wanted = author.to_lowercase();
            let sig = commit.author();
            let name = sig.name().unwrap_or("").to_lowercase();
            let email = sig.email().unwrap_or("").to_lowercase();
            if !name.contains(&wanted) && !email.contains(&wanted) {
                return false;
            }
        }
        if let Some(path) = self.path.as_deref().map(|p| p.trim().trim_matches('/')).filter(|p| !p.is_empty()) {
            if !touches_path(commit, std::path::Path::new(path)) {
                return false;
            }
        }
        true
    }
}

/// Whether `commit` changed what sits at `target` — a file's blob or a folder's tree differing from
/// every parent's (the first parent's only, on a merge, would hide what the merge brought in). A
/// root commit counts when it has the path at all.
fn touches_path(commit: &git2::Commit, target: &std::path::Path) -> bool {
    let entry = commit.tree().ok().and_then(|t| t.get_path(target).ok().map(|e| e.id()));
    if commit.parent_count() == 0 {
        return entry.is_some();
    }
    commit.parents().any(|parent| {
        let parent_entry = parent.tree().ok().and_then(|t| t.get_path(target).ok().map(|e| e.id()));
        entry != parent_entry
    })
}

/// [`list_commits_page`] narrowed by `filter`. `skip` counts the commits the filter kept, so the
/// next page of a filtered history follows on from the last one.
pub fn list_commits_page_filtered(
    path: &str,
    all_refs: bool,
    skip: usize,
    limit: usize,
    filter: &LogFilter,
) -> Result<CommitPage, String> {
    let repo = open(path)?;
    let ref_map = build_ref_map(&repo);

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.message().to_string())?;
    if filter.first_parent {
        walk.simplify_first_parent().map_err(|e| e.message().to_string())?;
    }
    if all_refs {
        walk.push_glob("refs/heads/*").map_err(|e| e.message().to_string())?;
        walk.push_glob("refs/remotes/*").map_err(|e| e.message().to_string())?;
    } else if head_is_unborn(&repo) {
        return Ok(CommitPage { commits: vec![], has_more: false });
    } else {
        walk.push_head().map_err(|e| e.message().to_string())?;
    }

    let narrows = filter.narrows();
    let mut commits = Vec::with_capacity(limit.min(1024));
    let mut has_more = false;
    let mut kept = 0usize;
    for oid in walk {
        let oid = oid.map_err(|e| e.message().to_string())?;
        if narrows {
            let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
            if !filter.keeps(&commit) {
                continue;
            }
        }
        kept += 1;
        if kept <= skip {
            continue;
        }
        // One past the page and stop: the extra one is never built into a `CommitInfo`, it only
        // answers whether the walk had anything left.
        if commits.len() == limit {
            has_more = true;
            break;
        }
        commits.push(build_commit_info(&repo, oid, &ref_map)?);
    }

    Ok(CommitPage { commits, has_more })
}

/// Commits touching one path, newest first — "how did this file get here".
///
/// The complement of blame, which answers who wrote a line. A revwalk with a pathspec-shaped filter
/// done by hand: libgit2 has no `--follow`, and this deliberately does not pretend to — a rename is
/// where the history stops, which is honest and is what `git log <path>` does without `--follow`
/// too.
pub fn file_history(path: &str, rel_path: &str, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open(path)?;
    let ref_map = build_ref_map(&repo);
    let target = std::path::Path::new(rel_path);

    // No commits, no history — for this file or any other.
    if head_is_unborn(&repo) {
        return Ok(vec![]);
    }

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.message().to_string())?;
    walk.push_head().map_err(|e| e.message().to_string())?;

    let mut out = Vec::new();
    for oid in walk {
        if out.len() >= limit {
            break;
        }
        let oid = oid.map_err(|e| e.message().to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
        let changed = touches_path(&commit, target);

        if changed {
            out.push(build_commit_info(&repo, oid, &ref_map)?);
        }
    }

    Ok(out)
}

/// Commits reachable from HEAD but not yet on its upstream — i.e. what `git push` would
/// send. Empty if the current branch has no upstream configured (nothing to compare against).
pub fn list_unpushed_commits(path: &str) -> Result<Vec<CommitInfo>, String> {
    let repo = open(path)?;
    // A repository whose first commit hasn't happened yet has no HEAD to resolve — and nothing to
    // push either, so the answer is "none" rather than a failure. `blame`, `branch`, `checkpoint`
    // and `repo` all already read an unborn HEAD as a state; this was the one place on the refresh
    // path that read it as an error, and one error there was enough to strand the sidebar's
    // loading skeleton for the rest of the session. See `setRepoPath` for the other half.
    let Ok(head) = repo.head() else {
        return Ok(vec![]);
    };
    if !head.is_branch() {
        return Ok(vec![]);
    }
    let head_oid = head.target().ok_or("HEAD has no target")?;
    let branch_name = head.shorthand().ok_or("invalid branch name")?;

    let branch = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    let Ok(upstream) = branch.upstream() else {
        return Ok(vec![]);
    };
    let Some(upstream_oid) = upstream.get().target() else {
        return Ok(vec![]);
    };

    let ref_map = build_ref_map(&repo);
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.message().to_string())?;
    walk.push(head_oid).map_err(|e| e.message().to_string())?;
    walk.hide(upstream_oid).map_err(|e| e.message().to_string())?;

    let mut commits = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.message().to_string())?;
        commits.push(build_commit_info(&repo, oid, &ref_map)?);
    }

    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A repository whose first commit hasn't happened yet — `git init` and nothing else, which is
    /// what importing a freshly scaffolded project looks like.
    ///
    /// `repo.head()` fails there. Reading that as an error made this call reject, and because it
    /// runs inside the `Promise.all` behind `setRepoPath`, one rejection left the sidebar's whole
    /// section for that repository on loading placeholders until the app was restarted.
    #[test]
    fn a_repository_with_no_commits_has_nothing_unpushed_rather_than_an_error() {
        let dir = std::env::temp_dir().join(format!("cf-graph-empty-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Repository::init(&dir).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();

        let unpushed = list_unpushed_commits(dir.to_str().unwrap()).unwrap();
        assert!(unpushed.is_empty());

        // And the graph itself is empty rather than broken — it walks the refs, of which there are
        // none yet, so it never had the same problem and must not acquire one.
        let commits = list_commits(dir.to_str().unwrap(), true, 500).unwrap();
        assert!(commits.is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    /// Each filter narrows the walk itself, and `skip` counts what the filter kept.
    #[test]
    fn the_filtered_walk_narrows_by_path_author_date_and_first_parent() {
        let dir = std::env::temp_dir().join(format!("cf-graph-filter-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("src")).unwrap();
        let repo = Repository::init(&dir).unwrap();
        let commit = |files: &[(&str, &str)], who: &str, when: i64, message: &str, extra: Option<Oid>| -> Oid {
            let mut index = repo.index().unwrap();
            for (name, body) in files {
                fs::write(dir.join(name), body).unwrap();
                index.add_path(std::path::Path::new(name)).unwrap();
            }
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git2::Signature::new(who, &format!("{}@example.com", who.to_lowercase()), &git2::Time::new(when, 0)).unwrap();
            let mut parents = Vec::new();
            if let Ok(head) = repo.head() {
                parents.push(head.peel_to_commit().unwrap());
            }
            if let Some(oid) = extra {
                parents.push(repo.find_commit(oid).unwrap());
            }
            let refs: Vec<&git2::Commit> = parents.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &refs).unwrap()
        };
        let first = commit(&[("a.txt", "1")], "Ana", 1_000, "first", None);
        commit(&[("src/b.txt", "1")], "Ben", 2_000, "second", None);
        // A side commit off `first`, merged back in: first-parent hides it.
        let side = {
            let tree = repo.find_commit(first).unwrap().tree().unwrap();
            let sig = git2::Signature::new("Ana", "ana@example.com", &git2::Time::new(2_500, 0)).unwrap();
            let parent = repo.find_commit(first).unwrap();
            repo.commit(None, &sig, &sig, "side", &tree, &[&parent]).unwrap()
        };
        commit(&[("src/b.txt", "2")], "Ana", 3_000, "merge", Some(side));
        let path = dir.to_str().unwrap();
        let summaries = |filter: LogFilter, skip: usize| -> Vec<String> {
            list_commits_page_filtered(path, false, skip, 10, &filter)
                .unwrap()
                .commits
                .into_iter()
                .map(|c| c.summary)
                .collect()
        };

        assert_eq!(summaries(LogFilter { path: Some("src".into()), ..Default::default() }, 0), vec!["merge", "second"]);
        assert_eq!(summaries(LogFilter { author: Some("BEN".into()), ..Default::default() }, 0), vec!["second"]);
        assert_eq!(summaries(LogFilter { since: Some(1_500), until: Some(2_600), ..Default::default() }, 0).len(), 2);
        assert!(!summaries(LogFilter { first_parent: true, ..Default::default() }, 0).contains(&"side".to_string()));
        assert!(summaries(LogFilter::default(), 0).contains(&"side".to_string()));
        assert_eq!(summaries(LogFilter { path: Some("src".into()), ..Default::default() }, 1), vec!["second"]);

        fs::remove_dir_all(&dir).ok();
    }

    /// The walks that start from HEAD rather than from every ref — HEAD-only history, its paged
    /// twin and a file's history — failed outright before the first commit ("reference not
    /// found"). An unborn HEAD has an empty history, not a broken one.
    #[test]
    fn head_walks_are_empty_before_the_first_commit() {
        let dir = std::env::temp_dir().join(format!("cf-graph-unborn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Repository::init(&dir).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        let path = dir.to_str().unwrap();

        assert!(list_commits(path, false, 500).unwrap().is_empty());
        let page = list_commits_page(path, false, 0, 500).unwrap();
        assert!(page.commits.is_empty() && !page.has_more);
        assert!(list_commits_page(path, true, 0, 500).unwrap().commits.is_empty());
        assert!(file_history(path, "a.txt", 100).unwrap().is_empty());

        fs::remove_dir_all(&dir).ok();
    }
}

