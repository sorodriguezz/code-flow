use std::collections::HashMap;
use std::path::{Component, Path};

use git2::{Blame, BlameOptions, Oid, Repository};
use serde::{Deserialize, Serialize};

use super::repo::open;

/// One run of consecutive lines that all came from the same commit.
///
/// **Per hunk, not per line**, and that is the whole shape of this module. A 5,000-line file is
/// tens-to-hundreds of hunks; the per-line form would be 5,000 objects with the author's name and
/// email duplicated into every one of them, which is precisely the cost `diff.rs`'s
/// [`FULL_FILE_CONTEXT_LINES`](super::diff) comment documents from the other direction — 19 KB of
/// real diff becoming ~1.8 MB of JSON once every line is an object crossing IPC. The consumer only
/// ever asks "who owns *this* line", and over a list sorted by `start_line` that is a binary search:
/// no expansion, no allocation, O(log n) per caret move.
///
/// There is deliberately no separate commit table either. A flat hunk renders on its own, whereas a
/// hunk-plus-commit-id pair would put a join on the caret path in exchange for saving a few hundred
/// duplicated author strings — the cheap thing made expensive to avoid the expensive thing being
/// slightly larger. What *is* deduplicated is the work: `find_commit` runs once per distinct commit
/// (see `collect_hunks`), not once per hunk, because a file's hunks cluster heavily on a handful of
/// commits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlameHunkInfo {
    /// First line of the run, counting from 1 — libgit2's own convention for `final_start_line`.
    pub start_line: u32,
    pub line_count: u32,
    /// Empty when `uncommitted`: there is no commit to name.
    pub commit_id: String,
    /// First 7 of `commit_id`, sliced exactly as `graph.rs` does, so the two surfaces show a commit
    /// by the same abbreviation.
    pub short_id: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since epoch, UTC — the same unit as `CommitInfo::timestamp`, so one formatter serves
    /// the graph and the annotation. Zero when `uncommitted`.
    pub timestamp: i64,
    pub summary: String,
    /// This run exists only in the buffer that was passed in: nobody has committed it yet. libgit2
    /// marks those with a zero final commit id, and that is the only thing this reports.
    pub uncommitted: bool,
    /// The author is whoever this repository would commit as. Resolved against the *repository's*
    /// signature rather than the global one, because a per-repo `user.email` is the normal way to
    /// keep work and personal identities apart, and getting this wrong renders someone else's name
    /// as "You".
    pub is_me: bool,
}

/// Why the file could not be blamed, or that it could.
///
/// This exists because an empty `hunks` is otherwise ambiguous between two answers the UI has to
/// word differently: a file git has never seen has no authors *yet*, an empty file has no lines at
/// all, and a binary file has lines nobody wants attributed. Following `RefKind`'s enum-over-IPC
/// convention (`graph.rs`) rather than `FileDiffInfo::status`'s stringly label: the set is closed,
/// the frontend switches on it exhaustively, and a typo in a match arm should be a compile error on
/// both sides instead of a branch that silently never fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlameState {
    /// `hunks` is the answer. It may still be empty — that is an empty file.
    Ok,
    /// Not in HEAD's tree: brand new, or deleted there and only present in the working copy.
    Untracked,
    /// In HEAD, but not text. Never handed to libgit2's blame — see [`blame_file`].
    Binary,
    /// A repository with no commits at all. Not an error: it is the first five minutes of a project.
    Nohead,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileBlame {
    pub state: BlameState,
    /// Ascending by `start_line`, contiguous, covering every line of the blamed content — which is
    /// what makes the frontend's binary search total, with no "no hunk for this line" case to word.
    pub hunks: Vec<BlameHunkInfo>,
    /// The commit this was computed against — the frontend keys its cache on it, so a commit,
    /// checkout, reset or rebase invalidates by changing the key rather than by anyone remembering
    /// to fire an event. Empty when `state` is `Nohead`.
    pub head_oid: String,
}

/// Rejects a `file_path` that is not repository-relative before libgit2 sees it.
///
/// `git2::util::path_to_repo_path` refuses these too, but with a message about repository paths that
/// reads as a git failure rather than as what it is: a caller bug, and only ever a caller bug, since
/// every path in the editor's tab registry is already repo-relative. Being explicit here is the
/// difference between a bug report that says "blame is broken on Windows" and one that points at the
/// line that built the path.
fn require_repo_relative(file_path: &str) -> Result<(), String> {
    const MSG: &str = "blame path must be repository-relative";
    if file_path.is_empty() {
        return Err(MSG.to_string());
    }
    let path = Path::new(file_path);
    // `Components` normalises `.` away *except* at the start of the path, which is exactly the
    // position that matters here — `./a` and `../a` keep their leading component.
    match path.components().next() {
        Some(Component::Prefix(_))
        | Some(Component::RootDir)
        | Some(Component::CurDir)
        | Some(Component::ParentDir) => Err(MSG.to_string()),
        _ => Ok(()),
    }
}

/// Everything about a commit the annotation needs, held once per commit instead of once per hunk.
struct CommitMeta {
    short_id: String,
    author_name: String,
    author_email: String,
    timestamp: i64,
    summary: String,
    is_me: bool,
}

fn collect_hunks(
    repo: &Repository,
    blame: &Blame<'_>,
    my_email: Option<&str>,
) -> Result<Vec<BlameHunkInfo>, String> {
    let mut meta: HashMap<Oid, CommitMeta> = HashMap::new();
    let mut out: Vec<BlameHunkInfo> = Vec::with_capacity(blame.len());

    for hunk in blame.iter() {
        let start_line = hunk.final_start_line() as u32;
        let line_count = hunk.lines_in_hunk() as u32;
        let oid = hunk.final_commit_id();

        // A zero final commit id is how `git_blame_buffer` marks lines that differ from the
        // committed version. `final_signature()` is deliberately *not* read in this branch: whatever
        // libgit2 synthesises for a line nobody has committed is an implementation detail, and the
        // UI renders a fixed "uncommitted" string for these anyway, so depending on it would buy
        // nothing and could break on a libgit2 bump.
        if oid.is_zero() {
            out.push(BlameHunkInfo {
                start_line,
                line_count,
                commit_id: String::new(),
                short_id: String::new(),
                author_name: String::new(),
                author_email: String::new(),
                timestamp: 0,
                summary: String::new(),
                uncommitted: true,
                is_me: false,
            });
            continue;
        }

        if !meta.contains_key(&oid) {
            let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
            let author = commit.author();
            let id_str = oid.to_string();
            let email = author.email().unwrap_or("").to_string();
            meta.insert(
                oid,
                CommitMeta {
                    short_id: id_str[..7.min(id_str.len())].to_string(),
                    author_name: author.name().unwrap_or("").to_string(),
                    timestamp: commit.time().seconds(),
                    summary: commit.summary().unwrap_or("").to_string(),
                    is_me: my_email
                        .is_some_and(|mine| !email.is_empty() && email.eq_ignore_ascii_case(mine)),
                    author_email: email,
                },
            );
        }
        let m = &meta[&oid];
        out.push(BlameHunkInfo {
            start_line,
            line_count,
            commit_id: oid.to_string(),
            short_id: m.short_id.clone(),
            author_name: m.author_name.clone(),
            author_email: m.author_email.clone(),
            timestamp: m.timestamp,
            summary: m.summary.clone(),
            uncommitted: false,
            is_me: m.is_me,
        });
    }

    Ok(out)
}

/// Who last changed each line of one file, as runs of lines.
///
/// `contents` is `git blame`'s `--contents -`: the editor's unsaved buffer, blamed through
/// `git_blame_buffer` so that lines the user has just typed come back marked `uncommitted` instead
/// of silently inheriting the attribution of whatever line now sits at that number. Passing `None`
/// blames the file as committed, which makes the result a pure function of (repo, path, HEAD) and
/// therefore cacheable — which is the whole reason the two cases are one function with an `Option`
/// rather than two commands: the caller flips between them on every keystroke and every save.
///
/// **The whole file, always.** `BlameOptions` has `min_line`/`max_line` and they go unused, because
/// the cost of a blame is the revwalk, not the per-commit diff that a line range shrinks. Measured
/// on this repository (151 commits, warm cache): `git blame --porcelain` over the 9,483-line
/// `translations.ts` takes ~0.09 s (~0.22 s cold), and the *same file restricted to 40 lines* takes
/// ~0.07 s — no real saving. So one whole-file blame is cached and answers every subsequent caret
/// move by binary search, where a range blame would cost nearly a full blame again on every caret
/// move that stepped outside the previous range. libgit2's blame is generally slower than git's, so
/// budget 0.2–0.6 s for a large file and never await this on the caret path.
pub fn blame_file(path: &str, file_path: &str, contents: Option<&str>) -> Result<FileBlame, String> {
    let repo = open(path)?;
    require_repo_relative(file_path)?;

    // No commits yet: there is nothing to attribute, and that is an answer rather than a failure.
    let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) else {
        return Ok(FileBlame { state: BlameState::Nohead, hunks: Vec::new(), head_oid: String::new() });
    };
    let head_oid = head.id().to_string();

    // Resolve the blob in HEAD's tree first — the same lookup `diff::file_at_ref` makes. This is
    // what keeps libgit2's blame off the two inputs it has no useful answer for: a path HEAD has
    // never heard of, and a 5 MB binary that would be walked line by line. Answering both from the
    // tree means we never have to parse libgit2's error text to tell them apart, and never pay for
    // the mistake.
    let Ok(entry) = head.tree().and_then(|tree| tree.get_path(Path::new(file_path))) else {
        return Ok(FileBlame { state: BlameState::Untracked, hunks: Vec::new(), head_oid });
    };
    let object = entry.to_object(&repo).map_err(|e| e.message().to_string())?;
    let Some(blob) = object.as_blob() else {
        // A tree, a submodule gitlink — in HEAD, but not a file with lines.
        return Ok(FileBlame { state: BlameState::Untracked, hunks: Vec::new(), head_oid });
    };
    if blob.is_binary() {
        return Ok(FileBlame { state: BlameState::Binary, hunks: Vec::new(), head_oid });
    }

    let mut opts = BlameOptions::new();
    // The annotation is a person's name, so showing the alias a `.mailmap` exists to correct is a
    // visible wrong answer. One extra file read.
    opts.use_mailmap(true);
    // HEAD is already the default; pinning it is what makes the `head_oid` returned below honest. A
    // checkout landing mid-call then yields one consistent slightly-old answer that the frontend's
    // cache key will invalidate, rather than a blame stitched across two heads.
    opts.newest_commit(head.id());
    // All four `track_copies_*` flags stay off, matching plain `git blame` with no `-M`/`-C`. They
    // are also the expensive ones, but that is the smaller reason: an annotation that credits
    // differently from what the user gets in their terminal is worse than one that fails to follow
    // a block someone moved between files. `ignore_whitespace` and `first_parent` likewise default
    // off — `first_parent(true)` is the escape hatch if merge-heavy history ever makes this slow.

    let base = repo
        .blame_file(Path::new(file_path), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let my_email = repo.signature().ok().and_then(|s| s.email().map(str::to_string));

    // Two calls rather than one `&Blame` picked out of an `Option`, so the buffer blame's borrow of
    // `base` stays inside its own arm. libgit2 reuses the revwalk's hunk list here and only re-diffs
    // the buffer against it, so the dirty path costs one text diff on top of the walk we just did,
    // not a second walk.
    let hunks = match contents {
        Some(text) => {
            let buffered = base
                .blame_buffer(text.as_bytes())
                .map_err(|e| e.message().to_string())?;
            collect_hunks(&repo, &buffered, my_email.as_deref())?
        }
        None => collect_hunks(&repo, &base, my_email.as_deref())?,
    };

    Ok(FileBlame { state: BlameState::Ok, hunks, head_oid })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::fs;

    /// A repo whose one file was written by two different people, in two commits: `a.txt` has three
    /// lines, the middle one rewritten afterwards by someone else. That is the smallest tree in
    /// which "who owns this line" has more than one answer.
    fn fixture() -> (std::path::PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("cf-blame-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "First Author").unwrap();
            config.set_str("user.email", "first@example.com").unwrap();
            // Keep the checked-out bytes identical to the committed ones whatever `core.autocrlf`
            // the machine running the tests has set globally — a blame is per line.
            config.set_bool("core.autocrlf", false).unwrap();
        }

        let commit = |content: &str, message: &str, who: (&str, &str)| {
            fs::write(dir.join("a.txt"), content).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = Signature::now(who.0, who.1).unwrap();
            let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<_> = parent.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap()
        };

        commit("one\ntwo\nthree\n", "initial", ("First Author", "first@example.com"));
        commit("one\nSECOND\nthree\n", "rewrite the middle", ("Second Author", "second@example.com"));

        (dir, repo)
    }

    /// The shape the frontend's binary search depends on: hunks ascending by `start_line`, and every
    /// line of the file covered by exactly one of them. Asserted rather than assumed because the
    /// search has no "no hunk here" branch — a gap would silently annotate the line above.
    #[test]
    fn hunks_come_back_in_line_order_and_cover_every_line() {
        let (dir, _repo) = fixture();
        let blame = blame_file(dir.to_str().unwrap(), "a.txt", None).unwrap();

        assert_eq!(blame.state, BlameState::Ok);
        let mut expected_line = 1u32;
        for hunk in &blame.hunks {
            assert_eq!(hunk.start_line, expected_line, "hunks must be contiguous and ascending");
            assert!(hunk.line_count >= 1);
            expected_line += hunk.line_count;
        }
        assert_eq!(expected_line, 4, "three lines, all covered");

        fs::remove_dir_all(&dir).ok();
    }

    /// The point of the feature: two commits by two people leave two different names on the file.
    #[test]
    fn each_line_is_credited_to_the_commit_that_last_touched_it() {
        let (dir, _repo) = fixture();
        let blame = blame_file(dir.to_str().unwrap(), "a.txt", None).unwrap();

        let author_of = |line: u32| -> String {
            blame
                .hunks
                .iter()
                .find(|h| line >= h.start_line && line < h.start_line + h.line_count)
                .map(|h| h.author_name.clone())
                .expect("every line has a hunk")
        };
        assert_eq!(author_of(1), "First Author");
        assert_eq!(author_of(2), "Second Author");
        assert_eq!(author_of(3), "First Author");

        // Metadata the annotation and its hover render, on the hunk that has a real commit.
        let rewritten = blame.hunks.iter().find(|h| h.start_line == 2).unwrap();
        assert_eq!(rewritten.summary, "rewrite the middle");
        assert_eq!(rewritten.author_email, "second@example.com");
        assert_eq!(rewritten.short_id.len(), 7);
        assert!(rewritten.commit_id.starts_with(&rewritten.short_id));
        assert!(rewritten.timestamp > 0);
        assert!(!rewritten.uncommitted);

        fs::remove_dir_all(&dir).ok();
    }

    /// `is_me` is what lets the annotation say "You". It is resolved against the *repository's*
    /// signature, so the fixture's per-repo `user.email` decides it — not whatever the machine
    /// running the tests has in its global config.
    #[test]
    fn the_repositorys_own_signature_is_the_one_that_counts_as_me() {
        let (dir, _repo) = fixture();
        let blame = blame_file(dir.to_str().unwrap(), "a.txt", None).unwrap();

        let first = blame.hunks.iter().find(|h| h.author_email == "first@example.com").unwrap();
        let second = blame.hunks.iter().find(|h| h.author_email == "second@example.com").unwrap();
        assert!(first.is_me, "the fixture commits as first@example.com");
        assert!(!second.is_me);

        fs::remove_dir_all(&dir).ok();
    }

    /// The dirty-buffer path, which is why `contents` exists. A line inserted in the editor and not
    /// yet saved belongs to nobody, and must not inherit the attribution of the line that used to
    /// sit at that number.
    #[test]
    fn a_line_nobody_has_committed_is_reported_as_uncommitted() {
        let (dir, _repo) = fixture();
        let buffer = "one\nSECOND\nbrand new line\nthree\n";
        let blame = blame_file(dir.to_str().unwrap(), "a.txt", Some(buffer)).unwrap();

        assert_eq!(blame.state, BlameState::Ok);
        let hunk_for = |line: u32| {
            blame
                .hunks
                .iter()
                .find(|h| line >= h.start_line && line < h.start_line + h.line_count)
                .expect("every line has a hunk")
        };
        let inserted = hunk_for(3);
        assert!(inserted.uncommitted, "the unsaved line has no commit");
        assert_eq!(inserted.commit_id, "");
        assert_eq!(inserted.short_id, "");
        assert_eq!(inserted.timestamp, 0);
        assert_eq!(inserted.author_name, "");
        assert!(!inserted.is_me);
        // The lines around it keep their real authors: the buffer blame re-diffs, it does not reset.
        assert_eq!(hunk_for(1).author_name, "First Author");
        assert!(!hunk_for(4).uncommitted);
        assert_eq!(hunk_for(4).author_name, "First Author");

        fs::remove_dir_all(&dir).ok();
    }

    /// **`contents: None` is a blame of HEAD, not of the file on disk** — the fact the caller's
    /// dirty/clean decision turns on, and the one place it is written down as an executable claim.
    ///
    /// This is where libgit2 and the `git` command part company. `git blame a.txt` on a modified
    /// working copy implicitly blames the working copy and reports the changed lines as "Not Committed
    /// Yet"; `git_blame_file` reads the blob at `newest_commit` and never looks at the working tree, so
    /// the answer is numbered against HEAD. A caller that decides "the editor buffer matches what I read
    /// from disk, so the committed blame will do" is therefore wrong for every file with uncommitted
    /// changes: the hunks stop short of the file on screen and everything after the first divergence is
    /// credited to whichever commit owns the line that now sits at that number. `blame_file` is not the
    /// place to fix that — the whole cacheability of the `None` path is that it is a pure function of
    /// (repo, path, HEAD) — so the frontend passes `contents` whenever the file can differ from HEAD,
    /// and this test is what stops that rule being read as belt-and-braces and simplified away.
    #[test]
    fn the_committed_blame_is_of_head_and_never_of_the_working_copy() {
        let (dir, _repo) = fixture();
        // Committed: three lines. On disk: four, with the new one first, staged nowhere.
        fs::write(dir.join("a.txt"), "inserted at the top\none\nSECOND\nthree\n").unwrap();

        let committed = blame_file(dir.to_str().unwrap(), "a.txt", None).unwrap();
        let covered: u32 = committed.hunks.iter().map(|h| h.line_count).sum();
        assert_eq!(covered, 3, "the committed blame covers HEAD's line count, not the file's");
        assert!(
            !committed.hunks.iter().any(|h| h.uncommitted),
            "and it cannot report an uncommitted line at all: it never saw the working copy"
        );

        // The same file blamed as the caller must ask for it once it can differ from HEAD.
        let on_disk = blame_file(
            dir.to_str().unwrap(),
            "a.txt",
            Some("inserted at the top\none\nSECOND\nthree\n"),
        )
        .unwrap();
        let covered: u32 = on_disk.hunks.iter().map(|h| h.line_count).sum();
        assert_eq!(covered, 4, "the buffer blame covers the text that is on screen");
        let hunk_for = |line: u32| {
            on_disk
                .hunks
                .iter()
                .find(|h| line >= h.start_line && line < h.start_line + h.line_count)
                .expect("every line has a hunk")
        };
        assert!(hunk_for(1).uncommitted, "the added line belongs to nobody");
        assert_eq!(hunk_for(2).author_name, "First Author");
        assert_eq!(hunk_for(3).author_name, "Second Author");
        assert_eq!(hunk_for(4).author_name, "First Author");

        fs::remove_dir_all(&dir).ok();
    }

    /// An untracked file is not an error and not an empty blame: those read differently on screen,
    /// which is the reason `BlameState` exists at all. It is also answered from HEAD's tree, so
    /// libgit2's blame never runs on it.
    #[test]
    fn a_file_head_has_never_seen_is_untracked_rather_than_an_error() {
        let (dir, _repo) = fixture();
        fs::write(dir.join("brand-new.txt"), "hello\n").unwrap();

        let blame = blame_file(dir.to_str().unwrap(), "brand-new.txt", None).unwrap();
        assert_eq!(blame.state, BlameState::Untracked);
        assert!(blame.hunks.is_empty());
        // Still keyed on HEAD, so the entry invalidates once the file is committed.
        assert!(!blame.head_oid.is_empty());

        // A path that does not exist anywhere is the same answer, not a failure.
        assert_eq!(
            blame_file(dir.to_str().unwrap(), "nowhere/at/all.txt", None).unwrap().state,
            BlameState::Untracked
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// Binary content is recognised from the blob in HEAD, before any line-by-line work happens.
    #[test]
    fn a_binary_file_is_reported_as_binary_without_being_blamed() {
        let (dir, repo) = fixture();
        fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0, 3, 4, 0]).unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("blob.bin")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "add a binary", &tree, &[&parent]).unwrap();
        }

        let blame = blame_file(dir.to_str().unwrap(), "blob.bin", None).unwrap();
        assert_eq!(blame.state, BlameState::Binary);
        assert!(blame.hunks.is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    /// A repository whose first commit hasn't happened yet. `repo.head()` fails there, and treating
    /// that as an error would put a red toast in front of every file in a fresh project.
    #[test]
    fn a_repository_with_no_commits_reports_nohead_instead_of_failing() {
        let dir = std::env::temp_dir().join(format!("cf-blame-empty-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Repository::init(&dir).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();

        let blame = blame_file(dir.to_str().unwrap(), "a.txt", None).unwrap();
        assert_eq!(blame.state, BlameState::Nohead);
        assert!(blame.hunks.is_empty());
        assert_eq!(blame.head_oid, "");

        fs::remove_dir_all(&dir).ok();
    }

    /// `head_oid` is the frontend's cache key, so it has to be the commit the hunks were actually
    /// computed against — not "whatever HEAD is when you next look".
    #[test]
    fn the_head_it_was_computed_against_comes_back_with_the_hunks() {
        let (dir, repo) = fixture();
        let blame = blame_file(dir.to_str().unwrap(), "a.txt", None).unwrap();
        assert_eq!(blame.head_oid, repo.head().unwrap().peel_to_commit().unwrap().id().to_string());
        fs::remove_dir_all(&dir).ok();
    }

    /// The wire shape, pinned because the TypeScript mirror in `src/types/domain.ts` is written by
    /// hand and there is no codegen between the two. Field names stay snake_case (no
    /// `serde(rename_all)` on these structs, matching `FileDiffInfo` and `CommitInfo`) and the state
    /// goes over as a lowercase string, which is what makes the `BlameState` union on the other side
    /// a union of literals rather than of guesses. Renaming a field here without renaming it there
    /// would compile on both sides and read as `undefined` at runtime; this test is the only thing
    /// standing in the way of that.
    #[test]
    fn the_json_field_names_are_the_ones_the_frontend_reads() {
        let (dir, _repo) = fixture();
        let blame = blame_file(dir.to_str().unwrap(), "a.txt", None).unwrap();
        let json = serde_json::to_value(&blame).unwrap();

        assert_eq!(json["state"], "ok");
        assert!(json["head_oid"].is_string());
        let hunk = &json["hunks"][0];
        for field in [
            "start_line",
            "line_count",
            "commit_id",
            "short_id",
            "author_name",
            "author_email",
            "timestamp",
            "summary",
            "uncommitted",
            "is_me",
        ] {
            assert!(!hunk[field].is_null(), "hunks[0].{field} missing from the JSON");
        }

        let untracked = blame_file(dir.to_str().unwrap(), "nope.txt", None).unwrap();
        assert_eq!(serde_json::to_value(&untracked).unwrap()["state"], "untracked");

        fs::remove_dir_all(&dir).ok();
    }

    /// Only ever a caller bug, so it gets a message that says so rather than libgit2's.
    #[test]
    fn a_path_that_is_not_repository_relative_is_rejected_by_name() {
        let (dir, _repo) = fixture();
        let path = dir.to_str().unwrap();
        let absolute = dir.join("a.txt").display().to_string();

        for bad in [absolute.as_str(), "", "./a.txt", "../a.txt"] {
            let err = blame_file(path, bad, None).unwrap_err();
            assert!(
                err.contains("repository-relative"),
                "expected the caller-bug message for {bad:?}, got {err:?}"
            );
        }

        fs::remove_dir_all(&dir).ok();
    }
}
