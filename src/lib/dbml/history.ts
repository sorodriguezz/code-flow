/**
 * The last few things that happened to a schema document, and what each of them changed.
 *
 * # Why the text editor's own undo is not this
 *
 * Monaco keeps an undo stack over what was *typed*, and half of what changes a DBML document here
 * is not typed: dragging a box rewrites the layout comment, "tidy up" rewrites every line at once,
 * importing SQL replaces the lot, and an AI answer merges blocks in. None of those go through the
 * editor's buffer as keystrokes, so none of them are on its stack — `⌘Z` after dragging four tables
 * undoes the last word you typed twenty minutes ago instead. This is a record of *document states*,
 * which is the only level at which all of those are the same kind of event.
 *
 * # A revision is a completed change, not a snapshot
 *
 * Each entry carries the document on both sides of it. That is one more copy than a list of
 * snapshots needs — the `before` of one is the `after` of the next — but it makes every entry
 * answer both questions a reader has on its own: "what did this change" is a diff of its two
 * halves, and "put it back" is its `before`. Deriving either from a neighbour means the newest
 * entry is a special case (its `after` is the live document, which is not in the list), and a list
 * where the first row works differently from the rest is a list people misread.
 *
 * A schema document is a few kilobytes; ten of them twice over is not a size worth optimising into
 * a shape nobody can follow.
 *
 * # Coalescing, or the list is ten keystrokes long
 *
 * Typing is a change per character and dragging is a change per frame. Without coalescing, "the
 * last ten changes" is the last ten characters — a history that only ever covers the past four
 * seconds, which is precisely the span the editor's own undo already has covered. So consecutive
 * revisions from the same cause, close together in time, fold into one: `before` from the first,
 * `after` from the last. What lands in the list is what a person would call a change.
 */

import { readLayout } from "./layout";

/** What made a change happen. The list shows this, so it is the vocabulary the reader gets. */
export type RevisionCause =
  | "edited"
  | "moved"
  /**
   * A review mark set or cleared.
   *
   * Its own cause because it is its own activity: triage is what you are doing when you press it,
   * not modelling. It does now touch the DBML — a table's mark is written as the `// ELIMINAR`
   * comment above its declaration as well as into the sidecar — so unlike `moved` it is a change
   * `pushRevision` records.
   */
  | "marked"
  | "formatted"
  | "rearranged"
  | "imported"
  | "merged"
  | "reverted";

export interface Revision {
  id: number;
  cause: RevisionCause;
  /** `Date.now()` when the change settled. */
  at: number;
  before: string;
  after: string;
}

/** How many rows the panel shows before you ask for more. What a popover can list without becoming
 *  a screen of its own. */
export const HISTORY_PAGE = 10;

/**
 * How many are kept in memory.
 *
 * Deliberately far above what is shown. The panel is a page over this list, not the list itself:
 * "the last ten changes" is the right amount to *look* at and the wrong amount to be able to
 * *reach*, because the change you want to undo is often the one before the five you made while
 * working out that it was wrong. Fifty schema documents twice over is a few megabytes at the very
 * worst and typically a hundred kilobytes.
 *
 * Older than this lives in `doc_versions` on the Rust side — snapshots of the saved document rather
 * than of every change — which the panel links out to.
 */
export const HISTORY_LIMIT = 50;

/** Two changes of the same cause closer together than this are one change. */
const COALESCE_MS = 4000;

/**
 * The list with `next` folded in, newest first.
 *
 * Returns the same array when there was nothing to record, so a caller can set state
 * unconditionally without causing a render.
 */
export function pushRevision(list: Revision[], next: Revision): Revision[] {
  /**
   * **Only the schema counts.** A stored document is the DBML plus trailing `// codeflow:` comments
   * holding box positions and review marks, and dragging a box rewrites nothing but those.
   * Recording them made the recovery list mostly furniture: five drags between two edits pushed the
   * edit off the end, so the list you reach for after breaking a table is full of the arrangement
   * you did on the way there.
   *
   * So the guard is on the DBML halves rather than on the whole documents. Movements still happen,
   * still autosave, still travel — they are simply not *versions to recover*, because there is
   * nothing about the model to recover from them. Marking a table now falls on the other side of
   * this line, because it writes a comment into the schema itself; a run of marks made in one go
   * folds into one revision through the coalescing above rather than through this guard.
   *
   * The revision itself still carries the whole document on both sides: reverting has to put the
   * positions back too, or undoing a rename would silently scatter the boxes.
   */
  if (readLayout(next.before).source === readLayout(next.after).source) return list;

  const head = list[0];
  if (head && head.cause === next.cause && next.at - head.at <= COALESCE_MS) {
    // The first one's `before`, the last one's `after`: the pair still describes exactly the span
    // between them, so the diff a reader sees is the whole burst rather than its final keystroke.
    return [{ ...head, at: next.at, after: next.after }, ...list.slice(1)];
  }
  return [next, ...list].slice(0, HISTORY_LIMIT);
}

/** One line that is only on one side of a change. */
export interface LineChange {
  kind: "add" | "remove";
  /** 1-based, in the side it belongs to. */
  line: number;
  text: string;
}

export interface LineDiff {
  added: number;
  removed: number;
  /** The changed lines, in document order, capped at `limit`. */
  lines: LineChange[];
  /** How many changed lines `lines` left out. */
  truncated: number;
}

/** Above this many differing lines on a side, the exact edit script is not worth computing — see
 *  `changedLines`. */
const EXACT_LIMIT = 400;

/**
 * Which lines differ between two documents.
 *
 * The common prefix and suffix are stripped first, and that is what makes this cheap enough to run
 * on every row of the panel: an edit to one line of a four-hundred-line schema leaves two one-line
 * sequences to compare, whatever the size of the file. Only what is left over goes through the
 * quadratic part, and a change big enough to survive the trim at both ends — a full reformat, an
 * import that replaced everything — is reported as a wholesale replacement rather than diffed line
 * by line, because for those two the line-level answer is "all of them" either way.
 */
export function changedLines(before: string, after: string, limit = 40): LineDiff {
  const left = before === "" ? [] : before.split("\n");
  const right = after === "" ? [] : after.split("\n");

  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }

  const a = left.slice(head, left.length - tail);
  const b = right.slice(head, right.length - tail);
  const script: LineChange[] =
    a.length > EXACT_LIMIT || b.length > EXACT_LIMIT
      ? [
          ...a.map((text, at) => ({ kind: "remove" as const, line: head + at + 1, text })),
          ...b.map((text, at) => ({ kind: "add" as const, line: head + at + 1, text })),
        ]
      : editScript(a, b, head);

  const added = script.filter((change) => change.kind === "add").length;
  const removed = script.length - added;
  return {
    added,
    removed,
    lines: script.slice(0, limit),
    truncated: Math.max(0, script.length - limit),
  };
}

/**
 * The exact set of added and removed lines between two short sequences.
 *
 * A longest-common-subsequence table, walked back into an edit script. `O(n·m)` in both time and
 * memory, which is why `changedLines` trims the ends before calling it and refuses outright above
 * `EXACT_LIMIT` — the interesting case after trimming is a handful of lines on each side, and the
 * uninteresting one does not need an exact answer.
 */
function editScript(a: string[], b: string[], offset: number): LineChange[] {
  const rows = a.length;
  const cols = b.length;
  if (rows === 0 && cols === 0) return [];
  if (rows === 0) return b.map((text, at) => ({ kind: "add", line: offset + at + 1, text }));
  if (cols === 0) return a.map((text, at) => ({ kind: "remove", line: offset + at + 1, text }));

  // `table[i][j]` is the length of the longest common subsequence of `a[i…]` and `b[j…]`.
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const script: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      script.push({ kind: "remove", line: offset + i + 1, text: a[i] });
      i += 1;
    } else {
      script.push({ kind: "add", line: offset + j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < rows) {
    script.push({ kind: "remove", line: offset + i + 1, text: a[i] });
    i += 1;
  }
  while (j < cols) {
    script.push({ kind: "add", line: offset + j + 1, text: b[j] });
    j += 1;
  }
  return script;
}
