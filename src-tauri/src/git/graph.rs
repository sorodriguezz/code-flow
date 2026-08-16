use std::collections::HashMap;

use git2::{Oid, Repository, Sort};
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

fn build_ref_map(repo: &Repository) -> HashMap<String, Vec<CommitRef>> {
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

fn build_commit_info(repo: &Repository, oid: Oid, ref_map: &HashMap<String, Vec<CommitRef>>) -> Result<CommitInfo, String> {
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
}

