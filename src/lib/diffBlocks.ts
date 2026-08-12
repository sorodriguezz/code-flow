import type { DiffLine, FileDiffInfo } from "../types/domain";

/**
 * What kind of change a gutter mark is standing for.
 *
 * Three states rather than the one the editor drew before, because a single "changed" stripe answers
 * the wrong question: it said *something here is new*, which for a rewritten line is only half true
 * and for a removed one is not sayable at all. The old collector kept `origin === "+"` lines only,
 * so a pure deletion drew nothing whatsoever — a change you could not see and therefore could not
 * click.
 */
export type MarkKind = "added" | "modified" | "deleted";

/**
 * One gutter mark: a run of buffer lines inside a hunk that all changed the same way.
 *
 * A run rather than a line so a 40-line insertion is one decoration instead of 40, which is the same
 * bargain the effect this replaces already struck.
 */
export interface GutterMark {
  kind: MarkKind;
  /**
   * 1-based lines in the buffer on screen — i.e. `new_lineno` space, because that is what Monaco
   * numbers.
   *
   * For `deleted` both ends are the *anchor*: the line that followed what was removed, whose top
   * edge the wedge is drawn against. A deletion has no line of its own and every Monaco decoration
   * has to attach to one, so the boundary is the only honest place to put it — which is also where
   * VS Code puts it.
   */
  start: number;
  end: number;
  /** Which peek this mark opens — an index into the sibling `blocks` array. */
  blockIndex: number;
}

/**
 * One hunk: the unit the peek shows, the unit the counter counts, and the unit stage/discard act on.
 *
 * Deliberately **not** "a run of changed lines", which is what VS Code counts and what the obvious
 * reading of the gutter suggests. At three lines of context two edits four lines apart are one hunk,
 * and the hunk is libgit2's action unit — `ApplyOptions::hunk_callback` can skip a hunk and nothing
 * finer. Counting runs would put "4 of 11" above a panel whose `+` button silently staged run 5 as
 * well, which is the one thing a destructive control must never do.
 *
 * The price is named rather than hidden: navigation stops once where VS Code stops twice.
 */
export interface ChangeBlock {
  /** Index into `FileDiffInfo.hunks`, so the `HunkRef` sent to Rust can be built from the source. */
  hunkIndex: number;
  header: string;
  lines: DiffLine[];
  /**
   * First and last buffer line the hunk's *changes* touch — where the peek anchors and what the
   * discard dialog names. For a hunk that is only deletions both are the anchor line, since there is
   * no surviving line to point at.
   */
  firstLine: number;
  lastLine: number;
}

/**
 * The origins that are not lines of either side but markers about the final newline —
 * `GIT_DIFF_LINE_CONTEXT_EOFNL` / `ADD_EOFNL` / `DEL_EOFNL`, which libgit2 emits as `=`, `>` and `<`
 * and `collect_diff` passes through verbatim.
 *
 * Dropped before the walk below rather than handled inside it, and that is load-bearing: a `>` sits
 * *between* a `-` run and the `+` run that replaced it, so treating it as an ordinary line would
 * break the adjacency test and report a rewritten last line as a deletion plus an unrelated
 * addition. They carry no information the gutter can draw.
 */
function isEofMarker(origin: string): boolean {
  return origin === "=" || origin === ">" || origin === "<";
}

/**
 * Turns a file's diff into the two things the editor needs: the hunk list the peek pages through,
 * and the gutter marks that open it.
 *
 * One pass produces both because they have to agree by construction — a mark whose `blockIndex`
 * pointed at the wrong hunk would open a panel about a change somewhere else in the file, and a
 * `+` button in that panel would then act on it.
 *
 * Classification inside a hunk is three rules, applied to runs of same-origin lines with context
 * lines as the separator:
 *
 * - a `+` run immediately preceded by a `-` run is a **rewrite**, and the `+` run carries the bar
 *   (the `-` run adds no mark of its own — the lines it names are gone, and marking the survivor
 *   twice would draw an orange bar under a red wedge for one edit);
 * - a `+` run with no `-` run in front of it is an **insertion**;
 * - a `-` run with no `+` run after it is a **deletion**, and gets the boundary.
 *
 * `undefined` in, empty arrays out: a clean file is the overwhelmingly common case and the caller
 * should not have to branch on it.
 */
export function changeBlocksOf(file: FileDiffInfo | undefined): {
  blocks: ChangeBlock[];
  marks: GutterMark[];
} {
  if (!file) return { blocks: [], marks: [] };
  const blocks: ChangeBlock[] = [];
  const marks: GutterMark[] = [];

  file.hunks.forEach((hunk, hunkIndex) => {
    const lines = hunk.lines.filter((line) => !isEofMarker(line.origin));
    const blockIndex = blocks.length;
    const hunkMarks: GutterMark[] = [];
    /**
     * The highest buffer line seen so far in this hunk, from a context or added line. It is the
     * fallback anchor for a deletion with nothing after it — a hunk that runs to the end of the
     * file — where "the line after what was removed" is one past the last line there is. The
     * decoration effect clamps against the model's line count, which is what makes that safe.
     */
    let lastNewLine = 0;

    let i = 0;
    while (i < lines.length) {
      const origin = lines[i].origin;
      if (origin === "-") {
        while (i < lines.length && lines[i].origin === "-") i += 1;
        const addedStart = i;
        while (i < lines.length && lines[i].origin === "+") i += 1;
        if (i > addedStart) {
          // A `-` run answered by a `+` run: one edit, drawn on the lines that survived it.
          const first = lines[addedStart].new_lineno ?? lastNewLine + 1;
          const last = lines[i - 1].new_lineno ?? first;
          lastNewLine = Math.max(lastNewLine, last);
          hunkMarks.push({ kind: "modified", start: first, end: last, blockIndex });
        } else {
          // Nothing replaced these lines. The anchor is the next line that still exists — normally
          // the trailing context — and only failing that the line past the end.
          let anchor = lastNewLine + 1;
          for (let j = i; j < lines.length; j += 1) {
            const candidate = lines[j].new_lineno;
            if (candidate !== null) {
              anchor = candidate;
              break;
            }
          }
          hunkMarks.push({ kind: "deleted", start: anchor, end: anchor, blockIndex });
        }
      } else if (origin === "+") {
        const addedStart = i;
        while (i < lines.length && lines[i].origin === "+") i += 1;
        const first = lines[addedStart].new_lineno ?? lastNewLine + 1;
        const last = lines[i - 1].new_lineno ?? first;
        lastNewLine = Math.max(lastNewLine, last);
        hunkMarks.push({ kind: "added", start: first, end: last, blockIndex });
      } else {
        const line = lines[i].new_lineno;
        if (line !== null) lastNewLine = Math.max(lastNewLine, line);
        i += 1;
      }
    }

    // A hunk with no `+`/`-` line at all cannot happen from git, but it would produce a block with
    // no anchor to place the peek at — so it is skipped rather than defended against downstream.
    if (hunkMarks.length === 0) return;
    blocks.push({
      hunkIndex,
      header: hunk.header,
      lines: hunk.lines,
      firstLine: Math.min(...hunkMarks.map((mark) => mark.start)),
      lastLine: Math.max(...hunkMarks.map((mark) => mark.end)),
    });
    marks.push(...hunkMarks);
  });

  return { blocks, marks };
}

/**
 * Whether two blocks are the same hunk — used to decide whether an open peek survives a watcher
 * tick, or has to close because the change it is offering to stage no longer exists.
 *
 * Line *numbers* are excluded on purpose, exactly as the Rust fingerprint excludes `new_start`
 * (`src-tauri/src/git/hunk.rs`). Typing anywhere above a hunk shifts every number in it without
 * changing the hunk at all, and a peek that closed itself because the user pressed Enter twenty
 * lines higher up would be indistinguishable, to them, from one that closed because their change had
 * really gone. What *is* compared is everything that could make an application wrong: which lines, in
 * which order, added or removed, plus the base-side start — the only coordinate nothing the editor
 * does can move, since it is a line number in the index.
 *
 * Stricter than the backend's check, which is the right direction for it to be wrong in: this closing
 * a peek that would in fact have applied costs a click, where leaving one open over a hunk the
 * backend will refuse costs a failed action the user cannot explain.
 */
export function sameHunk(a: ChangeBlock, b: ChangeBlock): boolean {
  if (baseStartOf(a) !== baseStartOf(b)) return false;
  if (a.lines.length !== b.lines.length) return false;
  for (let i = 0; i < a.lines.length; i += 1) {
    if (a.lines[i].origin !== b.lines[i].origin) return false;
    if (a.lines[i].content !== b.lines[i].content) return false;
  }
  return true;
}

/** The hunk's first line number on the *old* side — its `@@ -a` — read off the lines rather than
 *  parsed out of the header, so this needs no second `@@` parser to keep in step with Rust's. */
function baseStartOf(block: ChangeBlock): number | null {
  for (const line of block.lines) {
    if (line.old_lineno !== null) return line.old_lineno;
  }
  return null;
}
