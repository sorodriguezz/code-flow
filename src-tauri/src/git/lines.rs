//! Staging, unstaging and discarding **individual lines** — the gutter selection in the Changes
//! screen's diff.
//!
//! `hunk.rs` is the whole-hunk version of this, and the reason it cannot simply be reused is the
//! mechanism it rests on: libgit2's `git_apply` can *skip* a hunk (`hunk_cb`) but never split one. A
//! selection of three lines out of a twelve-line hunk is a change libgit2 has never been shown, so
//! something here has to express it. `hunk.rs` explains at length why that something must not be
//! unified-diff text built in this process — the `@@` counts, the preamble state machine, the
//! `\ No newline at end of file` placement, re-joined CRLF lines. All of those are hazards of the
//! *text*, and this module never produces any.
//!
//! # The result is built, not a patch
//!
//! Instead of describing the change, this builds the **file the change produces**, whole, from two
//! things libgit2 hands over exactly:
//!
//! * the *base* side, as a blob — the index copy for staging and discarding (what `git diff` measures
//!   from), HEAD's copy for unstaging;
//! * the change lines of a **zero-context** diff of that one path, each with its raw bytes — line
//!   terminator included, `\r` included, and no terminator at all on a last line that has none.
//!
//! Every line of the result is then either a base line, copied byte for byte, or a changed line's own
//! bytes. Nothing is re-joined, re-encoded or re-terminated, so a CRLF file stays CRLF and a file with
//! no final newline keeps not having one — except in the one case where that is impossible, see
//! [`close_open_lines`].
//!
//! Zero context is not a shortcut. Which lines are added and removed is decided by xdiff's edit
//! script (`xdl_do_diff` + `xdl_change_compact`), and context only affects how those are *grouped*
//! into hunks afterwards (`xdl_get_hunk`), so the line numbers of the changed lines are the same at
//! zero context as at the full-file context the Changes screen draws them at. That is what lets the
//! selection travel as `(origin, line number, content)` triples.
//!
//! # Nothing the user did not point at is written
//!
//! The same contract as `hunk.rs`: the frontend sends what it drew, never what to write. This module
//! recomputes the diff, and every selected line must be found in it — same side, same number, same
//! text — or the whole operation is refused with [`LINES_STALE_PREFIX`] before anything is opened for
//! writing. A line the user was not shown cannot be staged by accident, because it cannot be named.
//!
//! # Where the result goes
//!
//! * **Stage / unstage** write the index, and only the index: one blob, one entry, with its stat data
//!   zeroed so both libgit2 and the git CLI re-hash the working file instead of trusting a cached
//!   "unchanged" — the same shape `merge::restore_path` writes and `git apply --cached` leaves.
//! * **Discard** writes the working tree, and not by `fs::write`: the result is in the object
//!   database's form (after `core.autocrlf` and friends), and writing it raw would turn a CRLF checkout
//!   into an LF one. So it goes through libgit2's own apply against a throwaway index holding the
//!   result, which checks it out through the to-worktree filters *and* under `GIT_CHECKOUT_SAFE`
//!   against the preimage it just read — a file that changed on disk in between is refused, not
//!   clobbered. The repository's index is not modified.

use std::collections::HashSet;
use std::path::Path;

use git2::{AttrCheckFlags, Delta, DiffOptions, FileMode, IndexEntry, IndexTime, Patch, Repository};
use serde::{Deserialize, Serialize};

use super::diff::DiffLine;
use super::repo::open;

/// The selection names a line the recomputed diff does not have — the file moved between the diff
/// being drawn and the button being pressed. Nothing was written.
pub const LINES_STALE_PREFIX: &str = "LINES_STALE: ";

/// A change that line selection cannot express: binary, a submodule, a symlink or type change, a
/// conflicted path, an LFS-tracked file (whose index copy is a pointer, not the text on screen). The
/// suffix says which, for the log; the UI routes these to the whole-file buttons.
pub const LINES_UNSUPPORTED_PREFIX: &str = "LINES_UNSUPPORTED: ";

/// What the gutter selection sends: the path, and the changed lines as the diff drew them.
///
/// `lines` are [`DiffLine`]s verbatim — the same objects `collect_diff` produced, content with its
/// trailing `'\n'` stripped — so the comparison below applies the same transform to its own lines and
/// the two agree by construction. Only `+` and `-` lines are meaningful; anything else is refused.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LineSelection {
    pub file_path: String,
    pub lines: Vec<DiffLine>,
}

/// The three verbs, as in `hunk::HunkOp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineOp {
    /// Selected changes join the index; the working tree is not touched.
    Stage,
    /// Selected staged changes leave the index; the working tree is not touched.
    Unstage,
    /// Selected unstaged changes leave the working tree, back to the **index** copy — the contract
    /// `diff::discard_file_changes` and `hunk::HunkOp::Discard` keep. The index is not touched.
    Discard,
}

impl LineOp {
    /// Whether the diff is HEAD → index (the staged side) rather than index → working tree.
    fn staged_side(self) -> bool {
        self == LineOp::Unstage
    }

    /// Staging *applies* the selected changes to the base; unstaging and discarding *revert* them
    /// out of the target. Both are computed from the base plus the change lines.
    fn applies(self) -> bool {
        self == LineOp::Stage
    }
}

/// One changed line of the recomputed diff, with its bytes exactly as the file holds them.
#[derive(Debug)]
struct Change {
    origin: char,
    old_lineno: Option<u32>,
    new_lineno: Option<u32>,
    bytes: Vec<u8>,
}

/// One zero-context hunk: where it sits on the base side, and its lines in order.
#[derive(Debug)]
struct ChangeHunk {
    old_start: u32,
    old_lines: u32,
    lines: Vec<Change>,
}

/// A base blob split into lines, each keeping its terminator; the last one may have none. The same
/// counting libgit2 uses for line numbers — a final line without `'\n'` is still a line, and an empty
/// file has none.
fn split_lines(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            lines.push(bytes[start..=i].to_vec());
            start = i + 1;
        }
    }
    if start < bytes.len() {
        lines.push(bytes[start..].to_vec());
    }
    lines
}

/// Terminates every line but the last.
///
/// The one place bytes are invented, and the case that forces it: a base whose last line has no
/// newline, with lines *added after it* selected while the change to that last line is not. The
/// result would otherwise run the old last line straight into the first added one — `bc` for `b`
/// and `c` — which is a corruption, not a partial stage. Git itself cannot express this selection
/// either (`git add -p`'s edit mode produces an unappliable patch for it). Terminating the line is
/// the only reading that keeps every line the user can see as a line; the terminator matches the
/// rest of the file, CRLF if that is what most of its lines end with.
fn close_open_lines(lines: &mut [Vec<u8>]) {
    let Some(last) = lines.len().checked_sub(1) else { return };
    let terminated = lines.iter().filter(|l| l.ends_with(b"\n")).count();
    let crlf = lines.iter().filter(|l| l.ends_with(b"\r\n")).count();
    let eol: &[u8] = if terminated > 0 && crlf * 2 > terminated { b"\r\n" } else { b"\n" };
    for line in &mut lines[..last] {
        if !line.ends_with(b"\n") {
            line.extend_from_slice(eol);
        }
    }
}

/// The file the selection produces.
///
/// `applies` → base with the selected changes applied (stage). Otherwise → the target with the
/// selected changes reverted (unstage, discard), which is the same walk read the other way: an
/// unselected change stays as the target has it, a selected one goes back to the base.
///
/// Positions come from the hunk headers, and every removed line is checked against the base line it
/// claims to remove — both the line number and the bytes. They can only disagree if the base blob and
/// the diff describe different files, which would mean an assumption in here is wrong; the answer is
/// then to refuse, never to write a guess.
fn build(
    base: &[u8],
    hunks: &[ChangeHunk],
    selected: &HashSet<(usize, usize)>,
    applies: bool,
) -> Result<Vec<u8>, String> {
    let base_lines = split_lines(base);
    let mut out: Vec<Vec<u8>> = Vec::with_capacity(base_lines.len() + 16);
    let mut cursor = 0usize;
    let broken = || format!("{LINES_UNSUPPORTED_PREFIX}the diff does not match the base");

    for (h, hunk) in hunks.iter().enumerate() {
        // A hunk that removes nothing inserts *after* line `old_start` (`xdl_emit_hunk_hdr` prints
        // `s1 - 1` when the old count is zero); one that removes lines starts *at* `old_start`.
        let until = if hunk.old_lines == 0 { hunk.old_start as usize } else { (hunk.old_start as usize).saturating_sub(1) };
        if until < cursor || until > base_lines.len() {
            return Err(broken());
        }
        out.extend(base_lines[cursor..until].iter().cloned());
        cursor = until;

        for (l, change) in hunk.lines.iter().enumerate() {
            let chosen = selected.contains(&(h, l));
            match change.origin {
                ' ' | '-' => {
                    let Some(line) = base_lines.get(cursor) else { return Err(broken()) };
                    if change.old_lineno != Some(cursor as u32 + 1) || *line != change.bytes {
                        return Err(broken());
                    }
                    // Context always stays. A removed line stays when staging leaves it alone, or
                    // when unstaging/discarding takes its removal back.
                    let keep = change.origin == ' ' || chosen != applies;
                    if keep {
                        out.push(line.clone());
                    }
                    cursor += 1;
                }
                '+' => {
                    // An added line lands when staging picks it, or when unstaging/discarding
                    // leaves it where it is.
                    if chosen == applies {
                        out.push(change.bytes.clone());
                    }
                }
                _ => {}
            }
        }
    }
    out.extend(base_lines[cursor..].iter().cloned());
    close_open_lines(&mut out);
    Ok(out.concat())
}

/// Whether the path is stored through Git LFS. Its index copy is then a pointer, and a selection
/// drawn from the file's text would write text where git expects a pointer.
pub(super) fn is_lfs_path(repo: &Repository, rel: &str) -> bool {
    repo.get_attr(Path::new(rel), "filter", AttrCheckFlags::FILE_THEN_INDEX)
        .ok()
        .flatten()
        == Some("lfs")
}

/// Zeroed stat data, so the entry is re-hashed rather than trusted — see the module note.
fn index_entry(rel: &str, mode: u32, id: git2::Oid, size: usize) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: size as u32,
        id,
        flags: 0,
        flags_extended: 0,
        path: rel.as_bytes().to_vec(),
    }
}

/// Makes the index hold `content` for `rel` — or not hold `rel` at all, for `None`.
fn write_index(repo: &Repository, rel: &str, content: Option<(&[u8], u32)>) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    match content {
        Some((bytes, mode)) => {
            let id = repo.blob(bytes).map_err(|e| e.message().to_string())?;
            index
                .add(&index_entry(rel, mode, id, bytes.len()))
                .map_err(|e| e.message().to_string())?;
        }
        None => index.remove_path(Path::new(rel)).map_err(|e| e.message().to_string())?,
    }
    index.write().map_err(|e| e.message().to_string())
}

/// Makes the working tree hold `content` (object-database form) for `rel`, through libgit2's apply —
/// see the module note for why not `fs::write`.
///
/// The throwaway index holds the result; a *reversed* diff of it against the working tree is then
/// "from what is on disk to the result", which is exactly the patch to apply there. A file already
/// holding the result yields no delta and nothing is written.
fn write_worktree(repo: &Repository, rel: &str, content: &[u8], mode: u32) -> Result<(), String> {
    let id = repo.blob(content).map_err(|e| e.message().to_string())?;
    let mut target = git2::Index::new().map_err(|e| e.message().to_string())?;
    target
        .add(&index_entry(rel, mode, id, content.len()))
        .map_err(|e| e.message().to_string())?;

    let mut opts = DiffOptions::new();
    opts.pathspec(rel).disable_pathspec_match(true).reverse(true);
    let diff = repo
        .diff_index_to_workdir(Some(&target), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    if diff.deltas().count() == 0 {
        return Ok(());
    }
    repo.apply(&diff, git2::ApplyLocation::WorkDir, None)
        .map_err(|e| format!("{}{}", super::hunk::HUNK_APPLY_FAILED_PREFIX, e.message()))
}

/// Stages, unstages or discards the selected lines of one file. See the module note for the whole
/// argument; in short: recompute, verify every selected line, build the resulting file, write it to
/// the one place the verb names.
pub fn apply_lines(path: &str, selection: &LineSelection, op: LineOp) -> Result<(), String> {
    if selection.lines.is_empty() {
        return Err("no lines selected".to_string());
    }
    let repo = open(path)?;
    let rel = selection.file_path.as_str();
    if is_lfs_path(&repo, rel) {
        return Err(format!("{LINES_UNSUPPORTED_PREFIX}lfs"));
    }

    let mut opts = DiffOptions::new();
    // Zero context and zero inter-hunk merging: every hunk is exactly one run of changes, and the
    // lines the base contributes around it come from the base blob itself — see `build`.
    // `disable_pathspec_match` for the reason `hunk::apply_hunk` gives: this writes, so "this exact
    // path or nothing" is the only acceptable rule.
    opts.context_lines(0)
        .interhunk_lines(0)
        .pathspec(rel)
        .disable_pathspec_match(true);
    let diff = if op.staged_side() {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
    } else {
        // An untracked file is a change too — all of it added — and its lines can be staged or
        // discarded one by one like any other's.
        opts.include_untracked(true).show_untracked_content(true).recurse_untracked_dirs(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
    .map_err(|e| e.message().to_string())?;

    let Some(index) = diff.deltas().position(|delta| {
        let names = |file: git2::DiffFile| file.path().is_some_and(|p| p == Path::new(rel));
        names(delta.new_file()) || names(delta.old_file())
    }) else {
        return Err(format!("{LINES_STALE_PREFIX}{rel}"));
    };
    let delta = diff.get_delta(index).ok_or_else(|| format!("{LINES_STALE_PREFIX}{rel}"))?;
    let status = delta.status();
    if !matches!(status, Delta::Modified | Delta::Added | Delta::Deleted | Delta::Untracked) {
        return Err(format!("{LINES_UNSUPPORTED_PREFIX}{}", super::diff::diff_status_label(status)));
    }
    let special = |mode: FileMode| matches!(mode, FileMode::Commit | FileMode::Link | FileMode::Tree);
    if special(delta.old_file().mode()) || special(delta.new_file().mode()) {
        return Err(format!("{LINES_UNSUPPORTED_PREFIX}not a regular file"));
    }
    let patch = Patch::from_diff(&diff, index)
        .map_err(|e| e.message().to_string())?
        .ok_or_else(|| format!("{LINES_UNSUPPORTED_PREFIX}binary"))?;
    // Asked of the patch, not of the delta above: libgit2 only knows a file is binary once it has
    // loaded the content, which building the patch is what does.
    if patch.delta().flags().is_binary() || delta.flags().is_binary() {
        return Err(format!("{LINES_UNSUPPORTED_PREFIX}binary"));
    }
    let mut hunks = Vec::with_capacity(patch.num_hunks());
    for h in 0..patch.num_hunks() {
        let (hunk, count) = patch.hunk(h).map_err(|e| e.message().to_string())?;
        let mut lines = Vec::with_capacity(count);
        for l in 0..count {
            let line = patch.line_in_hunk(h, l).map_err(|e| e.message().to_string())?;
            // The three end-of-file sigils are markers about the line before them, not lines — and
            // the bytes of that line already carry (or lack) its terminator.
            if !matches!(line.origin(), '+' | '-' | ' ') {
                continue;
            }
            lines.push(Change {
                origin: line.origin(),
                old_lineno: line.old_lineno(),
                new_lineno: line.new_lineno(),
                bytes: line.content().to_vec(),
            });
        }
        hunks.push(ChangeHunk { old_start: hunk.old_start(), old_lines: hunk.old_lines(), lines });
    }

    // Every selected line must be one of these, exactly. The comparison applies `collect_diff`'s own
    // transform to this side, so the two agree by construction — including a CRLF line's `'\r'`.
    let mut selected: HashSet<(usize, usize)> = HashSet::new();
    for want in &selection.lines {
        let origin = match want.origin.as_str() {
            "+" => '+',
            "-" => '-',
            _ => return Err(format!("{LINES_UNSUPPORTED_PREFIX}only added and removed lines can be selected")),
        };
        let found = hunks.iter().enumerate().find_map(|(h, hunk)| {
            hunk.lines.iter().position(|change| {
                change.origin == origin
                    && match origin {
                        '+' => change.new_lineno == want.new_lineno,
                        _ => change.old_lineno == want.old_lineno,
                    }
                    && String::from_utf8_lossy(&change.bytes).trim_end_matches('\n') == want.content
            })
            .map(|l| (h, l))
        });
        match found {
            Some(at) => {
                selected.insert(at);
            }
            None => return Err(format!("{LINES_STALE_PREFIX}{rel}")),
        }
    }

    let read_blob = |id: git2::Oid| -> Result<Vec<u8>, String> {
        if id.is_zero() {
            return Ok(Vec::new());
        }
        repo.find_blob(id).map(|b| b.content().to_vec()).map_err(|e| e.message().to_string())
    };
    let base = read_blob(delta.old_file().id())?;
    let result = build(&base, &hunks, &selected, op.applies())?;
    let total = hunks.iter().map(|h| h.lines.iter().filter(|c| c.origin != ' ').count()).sum::<usize>();
    let everything = selected.len() == total;
    let old_mode = u32::from(delta.old_file().mode());
    let new_mode = u32::from(delta.new_file().mode());

    match op {
        LineOp::Stage => match status {
            // Every removed line of a file deleted on disk: that is staging the deletion.
            Delta::Deleted if everything => write_index(&repo, rel, None),
            Delta::Deleted => write_index(&repo, rel, Some((&result, old_mode))),
            // A new file enters the index with the mode it has on disk, executable bit included.
            Delta::Untracked | Delta::Added => write_index(&repo, rel, Some((&result, new_mode))),
            _ => write_index(&repo, rel, Some((&result, old_mode))),
        },
        LineOp::Unstage => match status {
            // Every line of a staged new file: the file leaves the index and is untracked again.
            Delta::Added if everything => write_index(&repo, rel, None),
            Delta::Deleted => write_index(&repo, rel, Some((&result, old_mode))),
            _ => write_index(&repo, rel, Some((&result, new_mode))),
        },
        LineOp::Discard => match status {
            // An untracked file has no index copy to go back to: discarding all of it is deleting
            // it, which is what the whole-file discard does too.
            Delta::Untracked | Delta::Added if everything => {
                let workdir = repo.workdir().ok_or("bare repository")?;
                match std::fs::remove_file(workdir.join(rel)) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(format!("{rel}: {e}")),
                }
            }
            // Deleted on disk: bring back the selected lines, with the index copy's mode.
            Delta::Deleted => write_worktree(&repo, rel, &result, old_mode),
            _ => write_worktree(&repo, rel, &result, new_mode),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::{get_file_diff, FileDiffInfo};
    use git2::Signature;
    use std::fs;
    use std::path::PathBuf;

    /// A repository with `file.txt` committed as `base`, `core.autocrlf` off so bytes are bytes.
    fn fixture(base: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-lines-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@example.com").unwrap();
            config.set_bool("core.autocrlf", false).unwrap();
        }
        fs::write(dir.join("file.txt"), base).unwrap();
        commit_all(&dir);
        dir
    }

    fn commit_all(dir: &Path) {
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, "commit", &tree, &parents).unwrap();
    }

    fn stage_path(dir: &Path, rel: &str) {
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        if dir.join(rel).exists() {
            index.add_path(Path::new(rel)).unwrap();
        } else {
            index.remove_path(Path::new(rel)).unwrap();
        }
        index.write().unwrap();
    }

    fn index_blob(dir: &Path, rel: &str) -> Option<Vec<u8>> {
        let repo = Repository::open(dir).unwrap();
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new(rel), 0)?;
        let bytes = repo.find_blob(entry.id).unwrap().content().to_vec();
        Some(bytes)
    }

    /// Only a Unix index records a mode worth asserting on; its one caller is gated the same way.
    #[cfg(unix)]
    fn index_mode(dir: &Path, rel: &str) -> u32 {
        let repo = Repository::open(dir).unwrap();
        let index = repo.index().unwrap();
        index.get_path(Path::new(rel), 0).unwrap().mode
    }

    /// The diff the Changes screen draws — full file context — so the selection is built from the
    /// same producer the app uses, not from a hand-written guess.
    fn drawn(dir: &Path, rel: &str, staged: bool) -> FileDiffInfo {
        get_file_diff(dir.to_str().unwrap(), rel, staged, None).unwrap().expect("a diff")
    }

    /// The drawn lines matching `pick` among the changed ones.
    fn select(file: &FileDiffInfo, rel: &str, pick: impl Fn(&DiffLine) -> bool) -> LineSelection {
        let lines: Vec<DiffLine> = file
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| (l.origin == "+" || l.origin == "-") && pick(l))
            .cloned()
            .collect();
        assert!(!lines.is_empty(), "the selection picked nothing");
        LineSelection { file_path: rel.to_string(), lines }
    }

    fn run(dir: &Path, selection: &LineSelection, op: LineOp) -> Result<(), String> {
        apply_lines(dir.to_str().unwrap(), selection, op)
    }

    /// Three lines added in one block; stage the middle one. The index gets exactly that line in
    /// exactly that place, and the working tree keeps all three.
    #[test]
    fn stage_one_added_line_out_of_a_block() {
        let dir = fixture("a\nb\nc\n");
        let edited = "a\nb\nx1\nx2\nx3\nc\n";
        fs::write(dir.join("file.txt"), edited).unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "x2");
        run(&dir, &sel, LineOp::Stage).unwrap();

        assert_eq!(index_blob(&dir, "file.txt").unwrap(), b"a\nb\nx2\nc\n");
        assert_eq!(fs::read(dir.join("file.txt")).unwrap(), edited.as_bytes());
        fs::remove_dir_all(&dir).ok();
    }

    /// A one-line modification is a removed line and an added one. Staging only the removal stages a
    /// deletion; staging only the addition stages both lines side by side.
    #[test]
    fn half_of_a_modification_stages_as_what_it_is() {
        let dir = fixture("one\ntwo\nthree\n");
        fs::write(dir.join("file.txt"), "one\nTWO\nthree\n").unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.origin == "-");
        run(&dir, &sel, LineOp::Stage).unwrap();
        assert_eq!(index_blob(&dir, "file.txt").unwrap(), b"one\nthree\n");

        // Back to the committed index, then the other half.
        stage_path(&dir, "file.txt");
        let repo = Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.reset_default(Some(head.as_object()), ["file.txt"]).unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.origin == "+");
        run(&dir, &sel, LineOp::Stage).unwrap();
        assert_eq!(index_blob(&dir, "file.txt").unwrap(), b"one\ntwo\nTWO\nthree\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// Two separate edits, staged, then one line of one of them unstaged: the index keeps the other
    /// edit whole and the working tree is not written.
    #[test]
    fn unstage_one_line_of_a_staged_change() {
        let dir = fixture(&(1..=20).map(|i| format!("line {i}\n")).collect::<String>());
        let edited: String = (1..=20)
            .map(|i| match i {
                3 => "three\n".to_string(),
                15 => "fifteen\n".to_string(),
                _ => format!("line {i}\n"),
            })
            .collect();
        fs::write(dir.join("file.txt"), &edited).unwrap();
        stage_path(&dir, "file.txt");

        let sel = select(&drawn(&dir, "file.txt", true), "file.txt", |l| {
            l.content == "fifteen" || l.content == "line 15"
        });
        run(&dir, &sel, LineOp::Unstage).unwrap();

        let expected: String = (1..=20)
            .map(|i| if i == 3 { "three\n".to_string() } else { format!("line {i}\n") })
            .collect();
        assert_eq!(index_blob(&dir, "file.txt").unwrap(), expected.as_bytes());
        assert_eq!(fs::read_to_string(dir.join("file.txt")).unwrap(), edited);
        fs::remove_dir_all(&dir).ok();
    }

    /// Discard one added line: it leaves the working tree, every other edit stays, and the index is
    /// exactly what it was.
    #[test]
    fn discard_one_line_keeps_the_rest_and_the_index() {
        let dir = fixture("a\nb\nc\n");
        fs::write(dir.join("file.txt"), "a\nnew 1\nb\nnew 2\nc\n").unwrap();
        let index_before = index_blob(&dir, "file.txt");

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "new 2");
        run(&dir, &sel, LineOp::Discard).unwrap();

        assert_eq!(fs::read_to_string(dir.join("file.txt")).unwrap(), "a\nnew 1\nb\nc\n");
        assert_eq!(index_blob(&dir, "file.txt"), index_before);
        fs::remove_dir_all(&dir).ok();
    }

    /// Discard a *removal*: the removed line comes back, in its place, and the other removal stays.
    #[test]
    fn discarding_a_removed_line_brings_it_back_in_place() {
        let dir = fixture("a\nb\nc\nd\n");
        fs::write(dir.join("file.txt"), "a\nd\n").unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "c");
        run(&dir, &sel, LineOp::Discard).unwrap();

        assert_eq!(fs::read_to_string(dir.join("file.txt")).unwrap(), "a\nc\nd\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// Every `\r\n` survives a partial stage, and no lone `\n` appears — the bytes come from the
    /// file, never from re-joining.
    #[test]
    fn a_crlf_file_stays_crlf() {
        let dir = fixture("a\r\nb\r\nc\r\n");
        fs::write(dir.join("file.txt"), "a\r\nb\r\nX\r\nY\r\nc\r\n").unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "Y\r");
        run(&dir, &sel, LineOp::Stage).unwrap();

        let staged = index_blob(&dir, "file.txt").unwrap();
        assert_eq!(staged, b"a\r\nb\r\nY\r\nc\r\n");
        let lf = staged.iter().filter(|b| **b == b'\n').count();
        let crlf = staged.windows(2).filter(|w| w == b"\r\n").count();
        assert_eq!(lf, crlf, "a lone \\n appeared");
        fs::remove_dir_all(&dir).ok();
    }

    /// The last line has no newline and is edited: staging the edit keeps it without one.
    #[test]
    fn a_missing_final_newline_stays_missing() {
        let dir = fixture("a\nb\nlast");
        fs::write(dir.join("file.txt"), "a\nb\nlast edited").unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |_| true);
        run(&dir, &sel, LineOp::Stage).unwrap();
        assert_eq!(index_blob(&dir, "file.txt").unwrap(), b"a\nb\nlast edited");

        // And discarding that edit restores the committed bytes exactly — no newline invented.
        fs::write(dir.join("file.txt"), "a\nb\nlast edited again").unwrap();
        stage_path(&dir, "file.txt");
        let repo = Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.reset_default(Some(head.as_object()), ["file.txt"]).unwrap();
        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |_| true);
        run(&dir, &sel, LineOp::Discard).unwrap();
        assert_eq!(fs::read(dir.join("file.txt")).unwrap(), b"a\nb\nlast");
        fs::remove_dir_all(&dir).ok();
    }

    /// The one case that forces a byte: lines added after a last line that had no newline, staged
    /// without the change that gives it one. The old last line is terminated rather than run into
    /// the first added line.
    #[test]
    fn lines_added_after_an_unterminated_last_line_are_kept_apart() {
        let dir = fixture("a\nb");
        fs::write(dir.join("file.txt"), "a\nb\nc\nd\n").unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "d");
        run(&dir, &sel, LineOp::Stage).unwrap();
        assert_eq!(index_blob(&dir, "file.txt").unwrap(), b"a\nb\nd\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// A brand-new file: stage two of its lines. It enters the index holding exactly those, with the
    /// executable bit it has on disk, and stays whole in the working tree.
    #[test]
    fn stage_some_lines_of_an_untracked_file() {
        let dir = fixture("a\n");
        fs::write(dir.join("new.sh"), "#!/bin/sh\necho one\necho two\necho three\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.join("new.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        }

        let sel = select(&drawn(&dir, "new.sh", false), "new.sh", |l| {
            l.content == "#!/bin/sh" || l.content == "echo two"
        });
        run(&dir, &sel, LineOp::Stage).unwrap();

        assert_eq!(index_blob(&dir, "new.sh").unwrap(), b"#!/bin/sh\necho two\n");
        #[cfg(unix)]
        assert_eq!(index_mode(&dir, "new.sh"), 0o100755);
        assert_eq!(
            fs::read_to_string(dir.join("new.sh")).unwrap(),
            "#!/bin/sh\necho one\necho two\necho three\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// A file deleted on disk: staging some of its removed lines leaves the rest in the index;
    /// staging all of them stages the deletion itself.
    #[test]
    fn a_deleted_file_stages_partly_or_as_a_deletion() {
        let dir = fixture("a\nb\nc\n");
        fs::remove_file(dir.join("file.txt")).unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "b");
        run(&dir, &sel, LineOp::Stage).unwrap();
        assert_eq!(index_blob(&dir, "file.txt").unwrap(), b"a\nc\n");

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |_| true);
        run(&dir, &sel, LineOp::Stage).unwrap();
        assert_eq!(index_blob(&dir, "file.txt"), None, "the deletion itself is staged");
        fs::remove_dir_all(&dir).ok();
    }

    /// Unstaging every line of a staged new file takes it out of the index, and leaves it on disk as
    /// untracked — `git rm --cached`.
    #[test]
    fn unstaging_all_of_a_new_file_untracks_it() {
        let dir = fixture("a\n");
        fs::write(dir.join("new.txt"), "x\ny\n").unwrap();
        stage_path(&dir, "new.txt");

        let sel = select(&drawn(&dir, "new.txt", true), "new.txt", |_| true);
        run(&dir, &sel, LineOp::Unstage).unwrap();

        assert_eq!(index_blob(&dir, "new.txt"), None);
        assert_eq!(fs::read_to_string(dir.join("new.txt")).unwrap(), "x\ny\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// Discarding part of an untracked file keeps the rest; discarding all of it deletes it, as the
    /// whole-file discard does.
    #[test]
    fn discarding_lines_of_an_untracked_file() {
        let dir = fixture("a\n");
        fs::write(dir.join("new.txt"), "keep\ndrop\n").unwrap();

        let sel = select(&drawn(&dir, "new.txt", false), "new.txt", |l| l.content == "drop");
        run(&dir, &sel, LineOp::Discard).unwrap();
        assert_eq!(fs::read_to_string(dir.join("new.txt")).unwrap(), "keep\n");

        let sel = select(&drawn(&dir, "new.txt", false), "new.txt", |_| true);
        run(&dir, &sel, LineOp::Discard).unwrap();
        assert!(!dir.join("new.txt").exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// Discarding one removed line of a file deleted on disk brings the file back holding that line.
    #[test]
    fn discarding_a_line_of_a_deleted_file_recreates_it() {
        let dir = fixture("a\nb\nc\n");
        fs::remove_file(dir.join("file.txt")).unwrap();

        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "b");
        run(&dir, &sel, LineOp::Discard).unwrap();
        assert_eq!(fs::read_to_string(dir.join("file.txt")).unwrap(), "b\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// The corruption guard: a selection naming a line the file no longer has is refused, and nothing
    /// is written anywhere.
    #[test]
    fn a_stale_selection_writes_nothing() {
        let dir = fixture("a\nb\nc\n");
        fs::write(dir.join("file.txt"), "a\nnew\nb\nc\n").unwrap();
        let sel = select(&drawn(&dir, "file.txt", false), "file.txt", |l| l.content == "new");

        // The user kept typing: the same line now says something else.
        fs::write(dir.join("file.txt"), "a\nnewer\nb\nc\n").unwrap();
        let before = index_blob(&dir, "file.txt");

        let err = run(&dir, &sel, LineOp::Stage).unwrap_err();
        assert!(err.starts_with(LINES_STALE_PREFIX), "{err}");
        assert_eq!(index_blob(&dir, "file.txt"), before);

        let err = run(&dir, &sel, LineOp::Discard).unwrap_err();
        assert!(err.starts_with(LINES_STALE_PREFIX), "{err}");
        assert_eq!(fs::read_to_string(dir.join("file.txt")).unwrap(), "a\nnewer\nb\nc\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_binary_file_is_refused() {
        let dir = fixture("a\n");
        fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0]).unwrap();
        commit_all(&dir);
        fs::write(dir.join("blob.bin"), [0u8, 9, 9, 0]).unwrap();
        let sel = LineSelection {
            file_path: "blob.bin".into(),
            lines: vec![DiffLine { origin: "+".into(), content: "x".into(), old_lineno: None, new_lineno: Some(1) }],
        };
        let err = run(&dir, &sel, LineOp::Stage).unwrap_err();
        assert!(err.starts_with(LINES_UNSUPPORTED_PREFIX), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_lfs_path_is_refused() {
        let dir = fixture("a\n");
        fs::write(dir.join(".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        fs::write(dir.join("art.psd"), "not really a psd\n").unwrap();
        let sel = LineSelection {
            file_path: "art.psd".into(),
            lines: vec![DiffLine {
                origin: "+".into(),
                content: "not really a psd".into(),
                old_lineno: None,
                new_lineno: Some(1),
            }],
        };
        let err = run(&dir, &sel, LineOp::Stage).unwrap_err();
        assert_eq!(err, format!("{LINES_UNSUPPORTED_PREFIX}lfs"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn close_open_lines_matches_the_files_line_endings() {
        let mut lf = vec![b"a".to_vec(), b"b\n".to_vec(), b"c".to_vec()];
        close_open_lines(&mut lf);
        assert_eq!(lf.concat(), b"a\nb\nc");
        let mut crlf = vec![b"a\r\n".to_vec(), b"b".to_vec(), b"c\r\n".to_vec(), b"d".to_vec()];
        close_open_lines(&mut crlf);
        assert_eq!(crlf.concat(), b"a\r\nb\r\nc\r\nd");
    }

    #[test]
    fn split_lines_counts_like_libgit2() {
        assert!(split_lines(b"").is_empty());
        assert_eq!(split_lines(b"a\n"), vec![b"a\n".to_vec()]);
        assert_eq!(split_lines(b"a\nb"), vec![b"a\n".to_vec(), b"b".to_vec()]);
        assert_eq!(split_lines(b"\n\n"), vec![b"\n".to_vec(), b"\n".to_vec()]);
    }
}
