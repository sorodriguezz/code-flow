//! Staging, unstaging and discarding **one hunk** — what the editor's inline change peek acts on.
//!
//! Its own file rather than more of `diff.rs` (which is already 730 lines) because this is a
//! different mechanism from diff *collection*: everything below is about libgit2's `git_apply`, its
//! exact-match rule, and the one thing that must never happen — writing bytes into a file the user
//! is editing that don't correspond to a change they pointed at. That warrants a long argument at
//! the top and the heaviest test module in the git layer, and neither of those belongs bolted onto
//! the end of the file that also holds `render_diff_for_prompt`.
//!
//! # Why no patch text is ever built
//!
//! The obvious shape for "stage one hunk" is to render the hunk back into unified-diff text, hand it
//! to `Diff::from_buffer` and apply that. Do not. Every one of these is a way to corrupt a file, and
//! all of them are hazards of the *text*, not of the operation:
//!
//! * the `diff --git` / `---` / `+++` preamble is parsed by a state machine
//!   (`patch_parse.c:399-491`) that has opinions about which lines may be absent;
//! * a missing `index` line lets `apply.c` fall back to a default mode, which silently rewrites a
//!   `100755` file to `100644` (`patch_parse.c:204-217`);
//! * the `@@ -a,b +c,d @@` counts must be exactly right or the parse fails
//!   (`patch_parse.c:669-674`), and they are *not* what the hunk header we were shown says once
//!   earlier hunks are skipped;
//! * every line must end in `\n`, and a bare `"\n"` at the end of the buffer trips the
//!   `remain_len > 1` guard (`patch_parse.c:584`);
//! * `\ No newline at end of file` has to be re-emitted in the right place, from the `=`/`>`/`<`
//!   sigils, or the file gains or loses a final newline;
//! * re-joining lines with `"\n"` when the file is CRLF rewrites every line ending in it.
//!
//! Instead: libgit2 already skips hunks *inside* the apply. `apply_hunk` consults
//! `opts.hunk_cb` first and, on a positive return, adds that hunk's line counts to
//! `skipped_new_lines`/`skipped_old_lines` (`apply.c:196-208`), which are exactly the terms in the
//! positioning arithmetic at `apply.c:243-247`. So "apply hunk 4 of 11" is a supported operation on
//! a **live `Diff`**, with libgit2 doing the offset compensation that a hand-built header would have
//! to fake. `git2` maps `false → 1 → skip` (`git2-0.19.0/src/apply.rs:79-85`).
//!
//! What crosses the wire from the frontend is therefore not a patch but a *fingerprint*: this module
//! recomputes the diff itself and applies its own hunk — the one whose fingerprint matches — or
//! nothing at all. The alternative makes a TypeScript file the author of bytes that land in the
//! user's working tree, and a bug there is a corrupted file with no reflog to get back from.
//!
//! # Why a reversed diff, not reversed text
//!
//! `git_apply` has no apply-in-reverse flag (`apply.c:806-843` takes no such option), so discard and
//! unstage reverse the **diff** via `DiffOptions::reverse` and apply that forwards. Inverting unified
//! text by hand is the part that corrupts files; asking libgit2 for the diff the other way round is
//! free and exact.
//!
//! That leaves one problem, and it is the reason the fingerprint below is shaped the way it is: the
//! frontend only ever sees a *forward* diff, so a forward hunk has to be recognised inside a reversed
//! one. Reversing a hunk's line list is not the relabelling it looks like. libgit2 re-emits each
//! change block with its deletions first, so a one-line-for-two-lines edit that read `-x +a +b`
//! forwards reads `-a -b +x` reversed; and the `\ No newline at end of file` sigils are chosen by
//! position (`>` annotates the old side, `<` the new one) rather than travelling with the line they
//! belong to. So the fingerprint is not the line list at all — it is
//! [`HunkPrint`], the two *file sides* the hunk spans, which is the same pair of facts read from
//! either direction.

use git2::{ApplyLocation, ApplyOptions, Delta, DiffOptions, Patch};
use serde::{Deserialize, Serialize};

use super::diff::{diff_status_label, DiffLine};
use super::repo::open;

/// Marks the one failure the peek has a real answer for: the hunk the user was looking at is not in
/// the file's diff any more, because the file changed between the panel being drawn and the button
/// being pressed. Nothing was modified. The frontend keys off the prefix rather than sniffing our
/// English, the same contract `branch.rs`'s `CHECKOUT_CONFLICT_PREFIX` established — and here the
/// distinction earns its keep twice over, because "nothing happened, look again" and "git could not
/// do this" want opposite things said to the user.
pub const HUNK_STALE_PREFIX: &str = "HUNK_STALE: ";

/// Marks a change that per-hunk operations cannot express at all: an untracked or deleted file
/// (whose one "hunk" is the whole file, which `diff::stage_file` and `diff::discard_file_changes`
/// already handle correctly), a binary delta, a mode-only change, a rename. Not the user's mistake
/// and not a git failure — the frontend turns it into "use the whole-file button" rather than
/// showing libgit2's words. The suffix carries the reason, for the log rather than for the UI.
pub const HUNK_UNSUPPORTED_PREFIX: &str = "HUNK_UNSUPPORTED: ";

/// Marks libgit2 refusing to apply a hunk it had produced itself moments earlier — the exact-match
/// search at `apply.c:102-148` failing against a preimage that had just been read. It should be
/// unreachable (the diff we verify against is the diff we apply), so it gets its own prefix instead
/// of being folded into [`HUNK_STALE_PREFIX`]: a stale hunk is a race the user can retry out of,
/// while this one means an assumption in here is wrong and the honest advice is to fall back to the
/// whole-file button. Nothing is written when it happens — see [`apply_hunk`].
pub const HUNK_APPLY_FAILED_PREFIX: &str = "HUNK_APPLY_FAILED: ";

/// A hunk as the peek has it, used to **find** the hunk rather than to apply it.
///
/// Deliberately the same shape as one entry of [`super::diff::DiffHunkInfo`], because that is where
/// it comes from: the frontend hands back, verbatim, the hunk it drew. Nothing here is trusted as
/// content — it is compared, field by field, against a diff this process computes for itself, and a
/// mismatch refuses the whole operation.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HunkRef {
    /// Repo-relative, POSIX-separated — the form `OpenTab.path` and every other git command here use.
    pub file_path: String,
    /// The `@@` header the peek is showing, verbatim from `DiffHunkInfo::header`.
    pub header: String,
    /// `origin` + `content` of every line of that hunk, in order. `content` has its trailing `'\n'`
    /// stripped, exactly as `collect_diff` produced it (`diff.rs:67-70`) — the comparison below
    /// applies the same transform to its own lines, so the two sides agree by construction rather
    /// than by two places remembering to do the same thing.
    pub lines: Vec<DiffLine>,
}

/// Which of the three per-hunk operations to perform. Three variants rather than a bool pair
/// because the three differ along two axes that must not be mixed up: *which* diff is recomputed,
/// and *where* the result is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkOp {
    /// The hunk joins the index. Working tree untouched. This is `git add -p`.
    Stage,
    /// The hunk leaves the index. Working tree untouched. This is `git reset -p`.
    Unstage,
    /// The hunk leaves the working tree, restored from the **index** — not from HEAD. Same contract
    /// as `diff::discard_file_changes`, which `diff.rs`'s `discard_all_keeps_staged_content` pins:
    /// a file that is staged *and* then edited keeps its staged part. The index is untouched.
    Discard,
}

/// Which diff a [`HunkOp`] is expressed in terms of. Private: the frontend names an operation, not
/// a diff, and choosing the diff is precisely the part it must not get a say in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    /// `diff_index_to_workdir` — what the "Changes" list shows unstaged.
    Unstaged,
    /// `diff_tree_to_index` — what it shows staged.
    Staged,
}

impl HunkOp {
    /// Whether the diff is generated with `DiffOptions::reverse`. Undoing a change means applying
    /// its inverse, and the inverse of a diff is a diff libgit2 will generate for us.
    fn reverses(self) -> bool {
        matches!(self, HunkOp::Unstage | HunkOp::Discard)
    }

    fn side(self) -> Side {
        match self {
            HunkOp::Unstage => Side::Staged,
            HunkOp::Stage | HunkOp::Discard => Side::Unstaged,
        }
    }

    /// `Index` is `git apply --cached`: the preimage comes from the index and the postimage is
    /// written with `git_index_add` (`apply.c:735-773`), so the working tree is never opened.
    /// `WorkDir` is plain `git apply`: preimage from the working tree, postimage written by
    /// `git_checkout_index` with `GIT_CHECKOUT_DONT_UPDATE_INDEX` (`apply.c:719-723`), so the index
    /// is never written.
    ///
    /// `ApplyLocation::Both` is **unusable here and must never be reached for**: it opens the
    /// preimage reader as `git_reader_for_workdir(repo, /*validate_index=*/true)` (`apply.c:832`),
    /// which fails with `GIT_READER_MISMATCH` → `"%s: does not match index"` (`apply.c:527`) the
    /// moment the working-tree blob differs from the index one — which is the *premise* of every
    /// operation in this file.
    fn location(self) -> ApplyLocation {
        match self {
            HunkOp::Discard => ApplyLocation::WorkDir,
            HunkOp::Stage | HunkOp::Unstage => ApplyLocation::Index,
        }
    }
}

/// `@@ -a,b +c,d @@ …` → `(a, b, c, d)`.
///
/// A missing `,b` means 1, which is what libgit2's own parser does (`patch_parse.c:516-537`), so the
/// two agree about a one-line hunk. `None` on anything else: nothing in this app had ever parsed a
/// hunk header before — `header` is only displayed (`DiffView.tsx`) or concatenated into a prompt
/// (`diff.rs:379`) — so this is the only parser of it and it is deliberately strict rather than
/// forgiving. A header we cannot read is a header we cannot fingerprint, and the safe answer to that
/// is to refuse the operation, not to guess.
fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32)> {
    let body = header.strip_prefix("@@ ")?;
    let (ranges, _tail) = body.split_once(" @@")?;
    let (old, new) = ranges.split_once(' ')?;
    let range = |spec: &str, sigil: char| -> Option<(u32, u32)> {
        let spec = spec.strip_prefix(sigil)?;
        match spec.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((spec.parse().ok()?, 1)),
        }
    };
    let (old_start, old_lines) = range(old, '-')?;
    let (new_start, new_lines) = range(new, '+')?;
    Some((old_start, old_lines, new_start, new_lines))
}

/// The single sigil of a [`DiffLine::origin`] as the wire carries it, or `None` for anything that is
/// not exactly one character — which can only be a caller sending something that did not come out of
/// `collect_diff`, and is therefore a mismatch rather than a panic.
fn origin_char(origin: &str) -> Option<char> {
    let mut chars = origin.chars();
    let first = chars.next()?;
    chars.next().is_none().then_some(first)
}

/// One side of a hunk: the exact lines that side of the file holds across the hunk's span, and
/// whether that side's last line ends without a newline.
#[derive(Debug, Default, PartialEq, Eq)]
struct HunkFace {
    lines: Vec<String>,
    no_final_newline: bool,
}

/// A hunk's identity, as the two sides can agree on it in either direction.
///
/// **Not the line list.** A unified hunk interleaves its two sides, and that interleaving is xdiff's
/// bookkeeping rather than a fact about the file: reverse the diff and a `-x +a +b` block comes back
/// as `-a -b +x`, with the EOF sigils re-chosen by position. Reducing the hunk to "what this region
/// of the file holds on the base side, what it holds on the target side" throws exactly that
/// bookkeeping away and keeps everything that could make an application wrong — which lines, in
/// which order, with which bytes, on both sides.
///
/// **`base_start` is the base side's line number**, i.e. `old_start` of a forward diff and
/// `new_start` of a reversed one — in both cases a line number in the index (or, on the staged side,
/// in HEAD), which nothing the editor does can move. The *working tree* line number is deliberately
/// excluded: every keystroke above the hunk shifts it, and a stage that refused because the user
/// typed somewhere unrelated would be indistinguishable, to them, from one that refused because the
/// hunk itself had changed. What the start line does buy is disambiguation — a file containing the
/// same edit twice produces two byte-identical hunks, and staging the wrong one of those would stage
/// a change the user never pointed at.
#[derive(Debug, PartialEq, Eq)]
struct HunkPrint {
    base_start: u32,
    base: HunkFace,
    target: HunkFace,
}

/// Sorts one diff line onto the file sides it appears on.
///
/// All three EOF sigils are markers rather than lines — `apply.c:216-224` treats them alike, as
/// "strip the newline off the line before me" — and which side each one speaks for is positional:
/// `>` follows a deletion and so annotates the **old** side, `<` follows an addition and annotates
/// the **new** one, `=` follows a context line and so annotates both. That is libgit2's own output in
/// both directions, pinned by `a_hunk_fingerprints_the_same_in_both_directions`; it is emphatically
/// not "`>` means added", which is what the sigil's name (`GIT_DIFF_LINE_ADD_EOFNL`) suggests and
/// what an earlier draft of this module assumed.
///
/// `false` for an origin that cannot appear inside a hunk's lines (`F`, `H`, `B`) or is not a diff
/// origin at all: only a caller sending something `collect_diff` did not produce can do that, and the
/// safe reading of it is "this is not the hunk you claim", never "ignore that line".
fn classify(origin: char, content: &str, old: &mut HunkFace, new: &mut HunkFace) -> bool {
    match origin {
        ' ' => {
            old.lines.push(content.to_string());
            new.lines.push(content.to_string());
        }
        '-' => old.lines.push(content.to_string()),
        '+' => new.lines.push(content.to_string()),
        '>' => old.no_final_newline = true,
        '<' => new.no_final_newline = true,
        '=' => {
            old.no_final_newline = true;
            new.no_final_newline = true;
        }
        _ => return false,
    }
    true
}

/// The fingerprint of the hunk the frontend sent. Always read as a *forward* diff, because a forward
/// diff is the only kind the frontend ever sees — `repoStore`'s two arrays are
/// `diff_index_to_workdir` and `diff_tree_to_index`, neither reversed.
fn print_of_ref(want: &HunkRef) -> Result<HunkPrint, String> {
    let (old_start, ..) = parse_hunk_header(&want.header)
        .ok_or_else(|| format!("{HUNK_UNSUPPORTED_PREFIX}unreadable hunk header"))?;
    let mut old = HunkFace::default();
    let mut new = HunkFace::default();
    for line in &want.lines {
        let origin = origin_char(&line.origin)
            .filter(|origin| classify(*origin, &line.content, &mut old, &mut new));
        if origin.is_none() {
            return Err(format!("{HUNK_UNSUPPORTED_PREFIX}unreadable line origin"));
        }
    }
    Ok(HunkPrint { base_start: old_start, base: old, target: new })
}

/// The same fingerprint for one hunk of a diff this process just computed. `reversed` says which way
/// round that diff was generated, and therefore which of its two sides is the base — the whole point
/// of the reduction being that this is the only place direction has to be thought about.
fn print_of_patch(patch: &Patch<'_>, idx: usize, reversed: bool) -> Result<HunkPrint, String> {
    let (hunk, _lines) = patch.hunk(idx).map_err(|e| e.message().to_string())?;
    let mut old = HunkFace::default();
    let mut new = HunkFace::default();
    let count = patch.num_lines_in_hunk(idx).map_err(|e| e.message().to_string())?;
    for i in 0..count {
        let line = patch.line_in_hunk(idx, i).map_err(|e| e.message().to_string())?;
        // The same `trim_end_matches('\n')` `collect_diff` applies (`diff.rs:68-70`), so the two sides
        // of the comparison agree by construction. Note what it does *not* strip: a CRLF line keeps
        // its `'\r'`, so a line-ending change reads as a mismatch rather than as a silent match.
        let content = String::from_utf8_lossy(line.content());
        if !classify(line.origin(), content.trim_end_matches('\n'), &mut old, &mut new) {
            return Err(format!("{HUNK_UNSUPPORTED_PREFIX}unexpected diff line origin"));
        }
    }
    Ok(if reversed {
        HunkPrint { base_start: hunk.new_start(), base: new, target: old }
    } else {
        HunkPrint { base_start: hunk.old_start(), base: old, target: new }
    })
}

/// Applies exactly one hunk of one file — the peek's `+`, `−` and discard buttons.
///
/// `context_lines` must be the context the caller *read the hunk at*, which is why it crosses the
/// wire instead of being a constant duplicated on both sides: the hunk boundaries in a diff are a
/// function of the context, so a mismatch here would make every fingerprint fail. It is
/// `LIST_DIFF_CONTEXT_LINES` in `src/state/repoStore.ts`; change it there and this follows.
///
/// # What stops this corrupting a file
///
/// 1. **The fingerprint.** One `Diff` object is generated, verified against, and applied. If
///    anything about the hunk differs from what the user was shown, `target` stays `None` and this
///    returns before any writer, index lock or checkout has been opened.
/// 2. **The write is one atomic pass against a measured baseline.** `apply_deltas` builds the whole
///    postimage in memory and only then does a single `git_checkout_index`/`git_index_add` pass
///    (`apply.c:870-885`), so a failure part-way through writes nothing — there is no window in
///    which a half-applied file exists on disk. The checkout runs `GIT_CHECKOUT_SAFE` with
///    `baseline_index` set to the preimage that was actually read moments earlier
///    (`apply.c:700-730`), so a file that changed on disk in between makes checkout *refuse* rather
///    than clobber. `git_indexwriter_cleanup` releases the index lock on every path (`apply.c:889`),
///    so a failure leaves no stale `index.lock` either.
/// 3. **Filter symmetry.** No text is reconstructed anywhere in here. The diff is read through the
///    `GIT_FILTER_TO_ODB` list (`reader.c:113-125` — "patch application uses the filtered version of
///    the working directory data to match git") and written back through the to-worktree list, so
///    whatever `core.autocrlf` the user has set round-trips in both directions without this code
///    ever touching a `'\r'`.
///
/// There is deliberately **no `ApplyOptions::check(true)` dry run** first. It would double the work
/// over the whole file to produce a message we can already produce, and point 2 is what makes it
/// unnecessary: a failed apply has written nothing.
pub fn apply_hunk(
    path: &str,
    want: &HunkRef,
    op: HunkOp,
    context_lines: u32,
) -> Result<(), String> {
    let repo = open(path)?;
    let reversed = op.reverses();

    let mut opts = DiffOptions::new();
    // `disable_pathspec_match`, which `diff::get_file_diff` does not set: a pathspec is fnmatch'd by
    // default, so a file genuinely named `a[1].tsx` would match nothing while a sibling might match
    // by accident. For a read that only decides what to draw, guessing wide is harmless; for a write
    // that lands in the user's working tree, "this exact path or refuse" is the only acceptable rule.
    opts.context_lines(context_lines)
        .pathspec(&want.file_path)
        .disable_pathspec_match(true);
    if reversed {
        opts.reverse(true);
    }

    let diff = match op.side() {
        Side::Unstaged => {
            // `include_untracked` without `show_untracked_content`, unlike `diff::get_working_diff`:
            // enough for a brand-new file to arrive as a delta this can refuse *by name* below,
            // without paying to diff its entire content for an answer we throw away.
            opts.include_untracked(true).recurse_untracked_dirs(true);
            repo.diff_index_to_workdir(None, Some(&mut opts))
        }
        Side::Staged => {
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        }
    }
    .map_err(|e| e.message().to_string())?;

    // Exactly one delta, or refuse — and the two ways that can fail want different words. No delta at
    // all means the file has no changes on this side any more: it was staged, discarded or committed
    // between the peek being drawn and the button being pressed, which is the stale case exactly. More
    // than one is a shape this command was not designed for: rename detection is never turned on in
    // this crate (`find_similar` is called nowhere), so the only way a single exact path yields two
    // deltas is something the fingerprint search below would silently count across.
    match diff.deltas().count() {
        1 => {}
        0 => return Err(format!("{HUNK_STALE_PREFIX}{}", want.file_path)),
        n => return Err(format!("{HUNK_UNSUPPORTED_PREFIX}{n} deltas for one path")),
    }
    let delta = diff
        .get_delta(0)
        .ok_or_else(|| format!("{HUNK_STALE_PREFIX}{}", want.file_path))?;
    if delta.status() != Delta::Modified {
        // Untracked, deleted, typechange, conflicted, renamed: one "hunk" that is the whole file,
        // which `diff::stage_file` and `diff::discard_file_changes` already do correctly and this
        // cannot do better. The frontend routes those to the whole-file buttons instead of drawing a
        // per-hunk one, so reaching this is a race, not a bug.
        return Err(format!(
            "{HUNK_UNSUPPORTED_PREFIX}{}",
            diff_status_label(delta.status())
        ));
    }

    // `Ok(None)` is libgit2's answer for a binary delta, and a mode-only change comes back as a
    // patch with no hunks at all. `collect_diff` reports both with `hunks: []`, so the peek never
    // draws a button for either — this is the belt to that braces.
    let patch = Patch::from_diff(&diff, 0).map_err(|e| e.message().to_string())?;
    let patch = match patch {
        Some(patch) if patch.num_hunks() > 0 => patch,
        _ => {
            let why = if delta.flags().is_binary() { "binary" } else { "no textual change" };
            return Err(format!("{HUNK_UNSUPPORTED_PREFIX}{why}"));
        }
    };

    let want_print = print_of_ref(want)?;
    let mut target: Option<usize> = None;
    for i in 0..patch.num_hunks() {
        if print_of_patch(&patch, i, reversed)? == want_print {
            target = Some(i);
            break;
        }
    }
    // The file moved between the peek being drawn and the button being pressed. Nothing has been
    // opened for writing at this point — no index lock, no checkout — so this returns with the
    // working tree and the index exactly as they were, which is what lets the caller just re-read
    // and let the user try again.
    //
    // A reversed diff reaches here for one further reason worth naming: xdiff's hunk *grouping* is
    // computed on whichever pair of sides it was handed, and while `A→B` reversed and `B→A` agree in
    // practice (see `a_hunk_fingerprints_the_same_in_both_directions`), nothing in libgit2 promises
    // they always will. If they ever disagree the fingerprint fails to match and the user gets a
    // refusal — never a hunk applied in the wrong place.
    let Some(target) = target else {
        return Err(format!("{HUNK_STALE_PREFIX}{}", want.file_path));
    };

    // `seen` is declared before `apply_opts` so it outlives the closure that borrows it, and
    // `apply_opts` is never moved after `hunk_callback`: that method stores `self as *mut _` as
    // libgit2's callback payload (`git2-0.19.0/src/apply.rs:127`), so moving the value afterwards
    // would hand libgit2 a dangling pointer with no compile error to show for it.
    let mut seen = 0usize;
    let mut apply_opts = ApplyOptions::new();
    apply_opts.hunk_callback(|_hunk| {
        let idx = seen;
        seen += 1;
        idx == target
    });

    repo.apply(&diff, op.location(), Some(&mut apply_opts))
        .map_err(|e| format!("{HUNK_APPLY_FAILED_PREFIX}{}", e.message()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::{get_staged_diff_with_context, get_working_diff_with_context};
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;

    /// The context every test here reads hunks at — the same 3 the frontend's store uses
    /// (`LIST_DIFF_CONTEXT_LINES` in `src/state/repoStore.ts`) and the same 3 it passes back down.
    /// A test that used a different number on the two sides would pass while proving nothing.
    const CONTEXT: u32 = 3;

    /// A repo with one committed 60-line file, in a throwaway directory.
    ///
    /// Sixty lines rather than `diff.rs`'s fixture's one, because everything here is about *which*
    /// hunk: three edits twenty lines apart is the smallest file in which "stage hunk 2" is a
    /// different statement from "stage the file". The config block is `blame.rs`'s rather than
    /// `diff.rs`'s — the diff fixture does not pin `core.autocrlf`, and byte identity across a
    /// CRLF round trip is exactly what several of these tests exist to prove.
    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-hunk-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@example.com").unwrap();
            // Keep the checked-out bytes identical to the committed ones whatever `core.autocrlf` the
            // machine running the tests has set globally — the whole point here is byte identity.
            config.set_bool("core.autocrlf", false).unwrap();
        }
        write(&dir, "file.txt", &numbered(60, "\n"));
        commit_all(&dir, "initial");
        dir
    }

    /// `"line 1<eol>line 2<eol>…line n<eol>"`. The `eol` parameter is what lets the CRLF test use
    /// the same body as every other test.
    fn numbered(n: usize, eol: &str) -> String {
        (1..=n).map(|i| format!("line {i}{eol}")).collect()
    }

    /// The same lines with `replacements` applied by 1-based line number — the "expected" side of
    /// every round-trip assertion below, built independently of anything git said.
    fn numbered_with(n: usize, eol: &str, replacements: &[(usize, &str)]) -> String {
        (1..=n)
            .map(|i| match replacements.iter().find(|(line, _)| *line == i) {
                Some((_, text)) => format!("{text}{eol}"),
                None => format!("line {i}{eol}"),
            })
            .collect()
    }

    fn write(dir: &Path, file_path: &str, content: &str) {
        fs::write(dir.join(file_path), content).unwrap();
    }

    /// Every helper opens its own `Repository`, on purpose. `apply_hunk` opens the repository itself
    /// and writes the index file from *that* handle; a long-lived handle in the test would keep
    /// serving its own cached, now-stale index and quietly assert against the wrong thing.
    fn stage_all(dir: &Path) {
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
    }

    fn commit_all(dir: &Path, message: &str) {
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
    }

    /// What the index actually holds for a path, as bytes. Bytes and not a `String` throughout: the
    /// point of most of these tests is that no byte changed, and `read_to_string` would hide exactly
    /// the `'\r'` and trailing-`'\n'` differences that matter.
    fn index_blob(dir: &Path, file_path: &str) -> Vec<u8> {
        let repo = Repository::open(dir).unwrap();
        let index = repo.index().unwrap();
        let entry = index
            .get_path(Path::new(file_path), 0)
            .unwrap_or_else(|| panic!("{file_path} is not in the index"));
        let blob = repo.find_blob(entry.id).unwrap();
        blob.content().to_vec()
    }

    fn index_tree_oid(dir: &Path) -> git2::Oid {
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.write_tree().unwrap()
    }

    /// The `HunkRef` the peek would send for hunk `idx`, built out of the same narrow diff the
    /// frontend's store holds. Going through the real producer rather than hand-writing a
    /// fingerprint is the point: it means these tests exercise the round trip the app performs,
    /// including the `trim_end_matches('\n')` both sides depend on agreeing about.
    fn hunk_ref(dir: &Path, file_path: &str, staged: bool, idx: usize) -> HunkRef {
        let path = dir.to_str().unwrap();
        let files = if staged {
            get_staged_diff_with_context(path, Some(CONTEXT)).unwrap()
        } else {
            get_working_diff_with_context(path, Some(CONTEXT)).unwrap()
        };
        let file = files
            .iter()
            .find(|f| {
                f.new_path.as_deref() == Some(file_path) || f.old_path.as_deref() == Some(file_path)
            })
            .unwrap_or_else(|| panic!("{file_path} has no diff on that side"));
        let hunk = file
            .hunks
            .get(idx)
            .unwrap_or_else(|| panic!("{file_path} has {} hunks, wanted #{idx}", file.hunks.len()));
        HunkRef {
            file_path: file_path.to_string(),
            header: hunk.header.clone(),
            lines: hunk.lines.clone(),
        }
    }

    fn cleanup(dir: &Path) {
        fs::remove_dir_all(dir).ok();
    }

    /// The round trip, and the test the whole feature stands on. Three edits far enough apart to be
    /// three hunks; stage the middle one; the index must hold the original file with *only* that
    /// edit, byte for byte, and the working tree must still hold all three.
    #[test]
    fn stage_one_hunk_of_three_leaves_the_others_unstaged() {
        let dir = fixture();
        let edits = [(10, "line 10 edited"), (30, "line 30 edited"), (50, "line 50 edited")];
        write(&dir, "file.txt", &numbered_with(60, "\n", &edits));

        let want = hunk_ref(&dir, "file.txt", false, 1);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        assert_eq!(
            index_blob(&dir, "file.txt"),
            numbered_with(60, "\n", &[(30, "line 30 edited")]).into_bytes(),
            "the index must hold exactly the staged hunk and nothing else"
        );
        assert_eq!(
            fs::read(dir.join("file.txt")).unwrap(),
            numbered_with(60, "\n", &edits).into_bytes(),
            "all three edits must still be in the working tree"
        );
        cleanup(&dir);
    }

    /// Staging is `git apply --cached`: `ApplyLocation::Index` never opens the working tree
    /// (`apply.c:835`). Its own test with its own assertion because this is the promise the peek's
    /// `+` button makes to someone who is still typing in the file.
    #[test]
    fn staging_a_hunk_never_touches_the_working_tree() {
        let dir = fixture();
        write(&dir, "file.txt", &numbered_with(60, "\n", &[(10, "a"), (30, "b"), (50, "c")]));
        let before = fs::read(dir.join("file.txt")).unwrap();

        let want = hunk_ref(&dir, "file.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        assert_eq!(fs::read(dir.join("file.txt")).unwrap(), before);
        cleanup(&dir);
    }

    /// The first and the last hunk both apply — the two ends of `apply.c:243-247`'s
    /// `skipped_new_lines`/`skipped_old_lines` arithmetic, which is the part that would go wrong if
    /// this module tried to rewrite `@@` numbers itself.
    #[test]
    fn the_first_and_the_last_hunk_apply() {
        for (idx, expect) in [(0usize, (10usize, "line 10 edited")), (2, (50, "line 50 edited"))] {
            let dir = fixture();
            let edits = [(10, "line 10 edited"), (30, "line 30 edited"), (50, "line 50 edited")];
            write(&dir, "file.txt", &numbered_with(60, "\n", &edits));

            let want = hunk_ref(&dir, "file.txt", false, idx);
            apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

            assert_eq!(
                index_blob(&dir, "file.txt"),
                numbered_with(60, "\n", &[expect]).into_bytes(),
                "staging hunk #{idx} staged the wrong region"
            );
            cleanup(&dir);
        }
    }

    /// Three inserted lines and no removed ones — the shape whose gutter mark is "added" rather than
    /// "modified", and the one where a hand-built `@@` header's `old_lines` count would be wrong.
    #[test]
    fn a_pure_addition_hunk_stages_alone() {
        let dir = fixture();
        let mut lines: Vec<String> = (1..=60).map(|i| format!("line {i}\n")).collect();
        lines[49] = "line 50 edited\n".to_string();
        lines.splice(20..20, ["new a\n", "new b\n", "new c\n"].map(String::from));
        write(&dir, "file.txt", &lines.concat());

        let want = hunk_ref(&dir, "file.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        let mut expected: Vec<String> = (1..=60).map(|i| format!("line {i}\n")).collect();
        expected.splice(20..20, ["new a\n", "new b\n", "new c\n"].map(String::from));
        assert_eq!(index_blob(&dir, "file.txt"), expected.concat().into_bytes());
        cleanup(&dir);
    }

    /// Three removed lines and no added ones — the case the editor's old `changedLineRanges` could
    /// not even draw a marker for, and the one whose postimage is *shorter* than its preimage.
    #[test]
    fn a_pure_deletion_hunk_stages_alone() {
        let dir = fixture();
        let mut lines: Vec<String> = (1..=60).map(|i| format!("line {i}\n")).collect();
        lines[49] = "line 50 edited\n".to_string();
        lines.drain(19..22);
        write(&dir, "file.txt", &lines.concat());

        let want = hunk_ref(&dir, "file.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        let mut expected: Vec<String> = (1..=60).map(|i| format!("line {i}\n")).collect();
        expected.drain(19..22);
        assert_eq!(index_blob(&dir, "file.txt"), expected.concat().into_bytes());
        cleanup(&dir);
    }

    /// Discard restores one region and leaves the other two edits alone, and it does not touch the
    /// index — `ApplyLocation::WorkDir` sets `GIT_CHECKOUT_DONT_UPDATE_INDEX` (`apply.c:722-723`).
    #[test]
    fn discard_one_hunk_restores_that_region_and_keeps_the_rest() {
        let dir = fixture();
        let edits = [(10, "line 10 edited"), (30, "line 30 edited"), (50, "line 50 edited")];
        write(&dir, "file.txt", &numbered_with(60, "\n", &edits));
        let index_before = index_tree_oid(&dir);

        let want = hunk_ref(&dir, "file.txt", false, 1);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Discard, CONTEXT).unwrap();

        assert_eq!(
            fs::read(dir.join("file.txt")).unwrap(),
            numbered_with(60, "\n", &[(10, "line 10 edited"), (50, "line 50 edited")]).into_bytes(),
            "only the discarded region should have gone back"
        );
        assert_eq!(index_before, index_tree_oid(&dir), "discard must not write the index");
        let repo = Repository::open(&dir).unwrap();
        assert!(
            repo.status_file(Path::new("file.txt")).unwrap().is_wt_modified(),
            "the two surviving edits must still read as unstaged changes"
        );
        cleanup(&dir);
    }

    /// The `diff.rs:708-731` contract at hunk scope: discard restores from the **index**, not from
    /// HEAD. Stage an edit, edit again on top of it, discard — what comes back is the staged text,
    /// and the index still holds it.
    #[test]
    fn discard_a_hunk_restores_from_the_index_not_head() {
        let dir = fixture();
        write(&dir, "file.txt", &numbered_with(60, "\n", &[(30, "line 30 staged")]));
        stage_all(&dir);
        write(&dir, "file.txt", &numbered_with(60, "\n", &[(30, "line 30 edited again")]));

        let want = hunk_ref(&dir, "file.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Discard, CONTEXT).unwrap();

        assert_eq!(
            fs::read(dir.join("file.txt")).unwrap(),
            numbered_with(60, "\n", &[(30, "line 30 staged")]).into_bytes(),
            "the region must come back as it was staged, not as HEAD has it"
        );
        assert_eq!(
            index_blob(&dir, "file.txt"),
            numbered_with(60, "\n", &[(30, "line 30 staged")]).into_bytes(),
            "the staged content must survive untouched"
        );
        cleanup(&dir);
    }

    /// Unstaging one of two staged hunks: the index keeps the other, and the working tree — which
    /// here is identical to the index — is not written at all.
    #[test]
    fn unstage_one_hunk_of_two() {
        let dir = fixture();
        let edits = [(10, "line 10 edited"), (50, "line 50 edited")];
        write(&dir, "file.txt", &numbered_with(60, "\n", &edits));
        stage_all(&dir);
        let workdir_before = fs::read(dir.join("file.txt")).unwrap();

        let want = hunk_ref(&dir, "file.txt", true, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Unstage, CONTEXT).unwrap();

        assert_eq!(
            index_blob(&dir, "file.txt"),
            numbered_with(60, "\n", &[(50, "line 50 edited")]).into_bytes(),
            "only the unstaged hunk should have left the index"
        );
        assert_eq!(
            fs::read(dir.join("file.txt")).unwrap(),
            workdir_before,
            "unstaging must not write the working tree"
        );
        cleanup(&dir);
    }

    /// Every `\r\n` survives and no lone `\n` appears anywhere. This is the test that would fail
    /// first if anything in here ever started rebuilding line text instead of letting libgit2 do it.
    #[test]
    fn a_crlf_file_round_trips_byte_for_byte() {
        let dir = fixture();
        write(&dir, "crlf.txt", &numbered(40, "\r\n"));
        commit_all(&dir, "add a crlf file");

        let edits = [(10, "line 10 edited"), (30, "line 30 edited")];
        write(&dir, "crlf.txt", &numbered_with(40, "\r\n", &edits));
        let workdir_before = fs::read(dir.join("crlf.txt")).unwrap();

        let want = hunk_ref(&dir, "crlf.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        let staged = index_blob(&dir, "crlf.txt");
        assert_eq!(staged, numbered_with(40, "\r\n", &[(10, "line 10 edited")]).into_bytes());
        let newlines = staged.iter().filter(|b| **b == b'\n').count();
        let crlfs = staged.windows(2).filter(|w| w == b"\r\n").count();
        assert_eq!(newlines, crlfs, "a lone \\n appeared in the staged blob");
        assert_eq!(fs::read(dir.join("crlf.txt")).unwrap(), workdir_before);
        cleanup(&dir);
    }

    /// A file whose last line has no newline keeps not having one when that very line is staged —
    /// the `\ No newline at end of file` path (`apply.c:216-224`) in the direction where getting it
    /// wrong *adds* a byte to the file.
    #[test]
    fn a_file_with_no_trailing_newline_keeps_not_having_one() {
        let dir = fixture();
        let base = format!("{}line 20", numbered(19, "\n"));
        write(&dir, "nonl.txt", &base);
        commit_all(&dir, "add a file with no trailing newline");

        let edited = format!("{}line 20 edited", numbered(19, "\n"));
        write(&dir, "nonl.txt", &edited);

        let want = hunk_ref(&dir, "nonl.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        let staged = index_blob(&dir, "nonl.txt");
        assert_eq!(staged, edited.as_bytes());
        assert_ne!(staged.last(), Some(&b'\n'), "a trailing newline was invented");
        cleanup(&dir);
    }

    /// The same EOFNL path from the other direction: stage a hunk near the *top* of a file whose
    /// last line has no newline, and the untouched last line must still be the committed one and
    /// must still have no newline.
    #[test]
    fn staging_an_earlier_hunk_leaves_the_missing_final_newline_alone() {
        let dir = fixture();
        let base = format!("{}line 30", numbered(29, "\n"));
        write(&dir, "nonl.txt", &base);
        commit_all(&dir, "add a file with no trailing newline");

        let edited = format!(
            "{}line 30 edited",
            numbered_with(29, "\n", &[(5, "line 5 edited")])
        );
        write(&dir, "nonl.txt", &edited);

        let want = hunk_ref(&dir, "nonl.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        let expected = format!("{}line 30", numbered_with(29, "\n", &[(5, "line 5 edited")]));
        let staged = index_blob(&dir, "nonl.txt");
        assert_eq!(staged, expected.as_bytes());
        assert_ne!(staged.last(), Some(&b'\n'), "the missing final newline came back");
        cleanup(&dir);
    }

    /// **The corruption test.** Take the fingerprint the peek would send, then change that very
    /// region on disk. The apply must refuse, and both the working tree and the index must be
    /// exactly as they were — the whole reason nothing is opened for writing until a hunk has
    /// matched.
    #[test]
    fn a_hunk_that_moved_on_disk_is_refused_and_changes_nothing() {
        let dir = fixture();
        write(
            &dir,
            "file.txt",
            &numbered_with(60, "\n", &[(10, "a"), (30, "b"), (50, "c")]),
        );
        let want = hunk_ref(&dir, "file.txt", false, 1);

        // The user kept typing: the same hunk is still there, saying something else.
        let moved = numbered_with(60, "\n", &[(10, "a"), (30, "something else entirely"), (50, "c")]);
        write(&dir, "file.txt", &moved);
        let index_before = index_tree_oid(&dir);

        let err = apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap_err();
        assert!(err.starts_with(HUNK_STALE_PREFIX), "unexpected error: {err}");
        assert_eq!(fs::read(dir.join("file.txt")).unwrap(), moved.into_bytes());
        assert_eq!(index_before, index_tree_oid(&dir), "a refused apply must write nothing");
        cleanup(&dir);
    }

    /// The other half of the fingerprint's design: an edit somewhere *else* in the file moves the
    /// hunk's working-tree line number, and that is deliberately not part of its identity. Refusing
    /// here would be indistinguishable, to the user, from refusing because their hunk had changed.
    #[test]
    fn an_edit_elsewhere_in_the_file_does_not_make_a_hunk_stale() {
        let dir = fixture();
        write(&dir, "file.txt", &numbered_with(60, "\n", &[(30, "line 30 edited")]));
        let want = hunk_ref(&dir, "file.txt", false, 0);

        // An inserted line at the top: every line below it, including the whole hunk above, moves.
        write(
            &dir,
            "file.txt",
            &format!("brand new first line\n{}", numbered_with(60, "\n", &[(30, "line 30 edited")])),
        );

        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap();

        assert_eq!(
            index_blob(&dir, "file.txt"),
            numbered_with(60, "\n", &[(30, "line 30 edited")]).into_bytes(),
            "the hunk should have staged, and the unrelated insertion should not have"
        );
        cleanup(&dir);
    }

    /// An untracked file's one "hunk" is the whole file, which `diff::stage_file` already does
    /// correctly — so this refuses by name rather than trying. It must stay refused: `apply.c:517`
    /// skips the preimage read for `GIT_DELTA_ADDED` but not for `GIT_DELTA_UNTRACKED`, so what
    /// `git_apply` would do with one is untested territory nobody needs to enter.
    #[test]
    fn an_untracked_file_is_refused() {
        let dir = fixture();
        write(&dir, "brand-new.txt", "one\ntwo\nthree\n");
        let want = hunk_ref(&dir, "brand-new.txt", false, 0);

        let err = apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap_err();
        assert_eq!(err, format!("{HUNK_UNSUPPORTED_PREFIX}untracked"));
        cleanup(&dir);
    }

    /// A deleted file is the same story from the other end: `diff::stage_file`'s `index.remove_path`
    /// branch (`diff.rs:398-399`) is the right operation, and there is no per-hunk version of it.
    #[test]
    fn a_deleted_file_is_refused() {
        let dir = fixture();
        fs::remove_file(dir.join("file.txt")).unwrap();

        let want = HunkRef {
            file_path: "file.txt".to_string(),
            header: "@@ -1,60 +0,0 @@".to_string(),
            lines: vec![],
        };
        let err = apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap_err();
        assert_eq!(err, format!("{HUNK_UNSUPPORTED_PREFIX}deleted"));
        cleanup(&dir);
    }

    /// A binary delta has no hunks to offer, so there is nothing per-hunk to do with it — and
    /// `collect_diff` reports it with `hunks: []`, so the peek never draws a button for one either.
    #[test]
    fn a_binary_file_is_refused() {
        let dir = fixture();
        fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0, 3, 4]).unwrap();
        commit_all(&dir, "add a binary file");
        fs::write(dir.join("blob.bin"), [0u8, 9, 9, 0, 3, 4]).unwrap();
        let before = fs::read(dir.join("blob.bin")).unwrap();

        let want = HunkRef {
            file_path: "blob.bin".to_string(),
            header: "@@ -1 +1 @@".to_string(),
            lines: vec![],
        };
        let err = apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Stage, CONTEXT).unwrap_err();
        assert!(err.starts_with(HUNK_UNSUPPORTED_PREFIX), "unexpected error: {err}");
        assert_eq!(fs::read(dir.join("blob.bin")).unwrap(), before);
        cleanup(&dir);
    }

    /// One hunk of the recomputed diff, fingerprinted — the test-side view of what `apply_hunk` does
    /// between generating the diff and applying it.
    fn patch_print(dir: &Path, file_path: &str, idx: usize, reversed: bool) -> HunkPrint {
        let repo = Repository::open(dir).unwrap();
        let mut opts = DiffOptions::new();
        opts.context_lines(CONTEXT).pathspec(file_path);
        if reversed {
            opts.reverse(true);
        }
        let diff = repo.diff_index_to_workdir(None, Some(&mut opts)).unwrap();
        let patch = Patch::from_diff(&diff, 0).unwrap().expect("a textual delta");
        print_of_patch(&patch, idx, reversed).unwrap()
    }

    /// **The invariant every reversed operation rests on.** The peek fingerprints a hunk out of a
    /// forward diff; discard and unstage have to find that hunk inside a *reversed* one. Reducing a
    /// hunk to its two file sides is what makes the fingerprint direction-blind.
    ///
    /// This is not a formality. libgit2 does not merely relabel lines when a diff is reversed: it
    /// re-emits each change block deletions-first, so the one-line-for-two-lines edit below reads
    /// `-x +a +b` forwards and `-a -b +x` reversed; and the `\ No newline at end of file` sigil is
    /// chosen by position, so a file whose *working* copy alone lacks the newline is marked `<`
    /// forwards and `>` reversed. An earlier draft swapped origins in place, reordered nothing and
    /// swapped the sigils — every discard and every unstage refused itself as stale.
    #[test]
    fn a_hunk_fingerprints_the_same_in_both_directions() {
        let dir = fixture();
        // Two shapes in one hunk: a one-for-one edit and a one-for-two replacement, close enough
        // together that three lines of context merge them.
        let mut lines: Vec<String> = (1..=60).map(|i| format!("line {i}\n")).collect();
        lines[9] = "line 10 edited\n".to_string();
        lines[14] = "fifteen a\nfifteen b\n".to_string();
        write(&dir, "file.txt", &lines.concat());

        let forward = print_of_ref(&hunk_ref(&dir, "file.txt", false, 0)).unwrap();
        assert_ne!(forward.base, forward.target, "a fingerprint of nothing would match anything");
        assert_eq!(forward, patch_print(&dir, "file.txt", 0, false));
        assert_eq!(forward, patch_print(&dir, "file.txt", 0, true), "reversed diff, same hunk");

        // The EOF sigil, asymmetrically: committed *with* a final newline, edited to drop it.
        write(&dir, "eol.txt", &format!("{}last\n", numbered(10, "\n")));
        commit_all(&dir, "add a file that ends in a newline");
        write(&dir, "eol.txt", &format!("{}last edited", numbered(10, "\n")));

        let forward = print_of_ref(&hunk_ref(&dir, "eol.txt", false, 0)).unwrap();
        assert!(!forward.base.no_final_newline, "the index copy still ends in a newline");
        assert!(forward.target.no_final_newline, "the working copy no longer does");
        assert_eq!(forward, patch_print(&dir, "eol.txt", 0, true));
        cleanup(&dir);
    }

    /// A one-line hunk header omits the `,count`, and libgit2's own parser reads that as 1
    /// (`patch_parse.c:516-537`). Both sides of the fingerprint have to agree about it or a
    /// single-line change could never be staged.
    #[test]
    fn a_hunk_header_without_a_count_means_one_line() {
        assert_eq!(parse_hunk_header("@@ -3 +3 @@"), Some((3, 1, 3, 1)));
        assert_eq!(parse_hunk_header("@@ -7,3 +7,4 @@ fn thing"), Some((7, 3, 7, 4)));
        assert_eq!(parse_hunk_header("@@ -0,0 +1,5 @@"), Some((0, 0, 1, 5)));
        // Anything else is refused rather than guessed at.
        assert_eq!(parse_hunk_header("@@ -3 +3"), None);
        assert_eq!(parse_hunk_header("not a header"), None);
        assert_eq!(parse_hunk_header("@@ 3 3 @@"), None);
    }

    /// The wire shape, pinned because the TypeScript mirror in `src/types/domain.ts` is written by
    /// hand and there is no codegen between the two. `HunkRef` goes *into* a command rather than
    /// coming out of one, which makes a rename worse than usual: serde would reject the payload at
    /// the boundary and the user would see a deserialization error instead of a staged hunk. Same
    /// reasoning, and the same shape, as `blame.rs`'s field-name test.
    #[test]
    fn the_wire_shape_matches_the_hand_written_typescript() {
        let want = HunkRef {
            file_path: "src/main.rs".to_string(),
            header: "@@ -1,3 +1,4 @@".to_string(),
            lines: vec![DiffLine {
                origin: "+".to_string(),
                content: "added".to_string(),
                old_lineno: None,
                new_lineno: Some(2),
            }],
        };
        let json = serde_json::to_value(&want).unwrap();
        for field in ["file_path", "header", "lines"] {
            assert!(!json[field].is_null(), "{field} missing from the JSON");
        }
        let line = &json["lines"][0];
        assert_eq!(line["origin"], "+");
        assert_eq!(line["content"], "added");
        assert!(line.get("old_lineno").is_some(), "old_lineno missing from the JSON");
        assert_eq!(line["new_lineno"], 2);

        // And it deserializes back from exactly those names — the direction the commands use.
        let round_trip: HunkRef = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip.file_path, want.file_path);
        assert_eq!(round_trip.lines.len(), 1);
    }

    /// **What `base_start` is for**, which nothing above could show: two hunks whose line lists are
    /// byte-for-byte identical, so the only thing that tells them apart is the base-side start line.
    ///
    /// A file with the same seven-line neighbourhood twice — three identical context lines, the edited
    /// line, three more identical context lines — produces two hunks that differ in no other field.
    /// Drop `base_start` from [`HunkPrint`] and the search below matches the *first* of them for both,
    /// so staging the second silently stages the first: a change the user never pointed at, in the one
    /// operation where that is unrecoverable.
    #[test]
    fn two_byte_identical_hunks_are_told_apart_by_their_start_line() {
        let dir = fixture();
        let mut lines: Vec<String> = Vec::new();
        let neighbourhood = |lines: &mut Vec<String>| {
            lines.extend((0..3).map(|_| "same\n".to_string()));
            lines.push("target\n".to_string());
            lines.extend((0..3).map(|_| "same\n".to_string()));
        };
        neighbourhood(&mut lines);
        lines.extend((0..20).map(|i| format!("filler {i}\n")));
        neighbourhood(&mut lines);
        write(&dir, "twin.txt", &lines.concat());
        commit_all(&dir, "the same neighbourhood twice");

        let edited = lines.concat().replace("target", "edited");
        write(&dir, "twin.txt", &edited);

        let first = hunk_ref(&dir, "twin.txt", false, 0);
        let second = hunk_ref(&dir, "twin.txt", false, 1);
        let shape = |want: &HunkRef| {
            want.lines.iter().map(|l| format!("{}{}", l.origin, l.content)).collect::<Vec<_>>()
        };
        assert_eq!(shape(&first), shape(&second), "the two hunks must be identical to prove anything");

        apply_hunk(dir.to_str().unwrap(), &second, HunkOp::Stage, CONTEXT).unwrap();

        let mut expected = lines.clone();
        let last = expected.len() - 4;
        expected[last] = "edited\n".to_string();
        assert_eq!(
            index_blob(&dir, "twin.txt"),
            expected.concat().into_bytes(),
            "the wrong twin was staged"
        );
        cleanup(&dir);
    }

    /// The byte-identity tests above all run `Stage`. **Discard is the direction that reverses the
    /// diff**, which is where the `-`/`+` reordering and the repositioned EOFNL sigil actually happen —
    /// so the two file shapes most likely to lose or gain a byte get their round trip from that side
    /// too. A CRLF file must come back with every `\r\n` intact, and a file whose last line has no
    /// newline must not acquire one.
    #[test]
    fn discard_restores_crlf_and_a_missing_final_newline_byte_for_byte() {
        let dir = fixture();
        write(&dir, "crlf.txt", &numbered(40, "\r\n"));
        let nonl = format!("{}line 20", numbered(19, "\n"));
        write(&dir, "nonl.txt", &nonl);
        commit_all(&dir, "a crlf file and one with no final newline");

        // CRLF: discard the second of two hunks, keep the first.
        write(&dir, "crlf.txt", &numbered_with(40, "\r\n", &[(10, "ten"), (30, "thirty")]));
        let want = hunk_ref(&dir, "crlf.txt", false, 1);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Discard, CONTEXT).unwrap();
        let got = fs::read(dir.join("crlf.txt")).unwrap();
        assert_eq!(got, numbered_with(40, "\r\n", &[(10, "ten")]).into_bytes());
        assert_eq!(
            got.iter().filter(|b| **b == b'\n').count(),
            got.windows(2).filter(|w| w == b"\r\n").count(),
            "a lone \\n appeared in the working tree"
        );

        // The last line has no newline, and the edit is to that very line.
        write(&dir, "nonl.txt", &format!("{}line 20 edited", numbered(19, "\n")));
        let want = hunk_ref(&dir, "nonl.txt", false, 0);
        apply_hunk(dir.to_str().unwrap(), &want, HunkOp::Discard, CONTEXT).unwrap();
        let got = fs::read(dir.join("nonl.txt")).unwrap();
        assert_eq!(got, nonl.as_bytes(), "the restored bytes are not the committed ones");
        assert_ne!(got.last(), Some(&b'\n'), "discard invented a trailing newline");
        cleanup(&dir);
    }
}

