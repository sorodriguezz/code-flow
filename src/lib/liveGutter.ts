import type { GutterMark } from "./diffBlocks";

/**
 * The editor's change marks, drawn from the buffer as it is typed — the way VS Code draws them.
 *
 * The marks used to come only from git's diff of the file **on disk**, so a line typed and not yet
 * saved had no mark at all until ⌘S, and the watcher, caught up (the user's report, 2026-09-25: "al
 * agregar nuevas líneas no me sale una marca"). This diffs the buffer against the file's quick-diff
 * base — the index copy, `git::diff::quick_diff_base` — in memory, so the mark is there on the next
 * keystroke. The shapes and the three kinds are `diffBlocks`' exactly, so the decorations and their
 * styling did not have to change.
 *
 * **A line diff, Myers's, with the common ends trimmed first.** An edit touches a handful of lines of
 * a file, so after trimming the middle left to diff is small and the diff costs about as much as
 * splitting the text did. The line comparison is by interned id, not string by string, and it
 * ignores line endings: `\r\n` and `\n` are the same line, so switching a file's endings does not
 * paint every line of it as changed — which is also what VS Code does.
 */

/** Past this many lines on either side, no live marks: the gutter keeps its marks from disk. */
const MAX_LINES = 100_000;

/**
 * How many single-line edits the diff will look for before giving up on an exact answer. A buffer
 * that differs from its base by more than this — a pasted-over file — gets its whole changed region
 * marked as one change, which is honest and costs nothing, instead of an exact diff that could take
 * a noticeable pause on every keystroke. The trace kept for the backtrack is quadratic in it.
 */
const MAX_EDITS = 1_000;

const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;
type Op = typeof EQUAL | typeof DELETE | typeof INSERT;

/** Lines as Monaco numbers them: any of the three line endings breaks one. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Both sides as ids into one table, so equality is one integer comparison. */
function intern(a: string[], b: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const toIds = (lines: string[]) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i += 1) {
      let id = ids.get(lines[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[i], id);
      }
      out[i] = id;
    }
    return out;
  };
  return [toIds(a), toIds(b)];
}

/**
 * Myers's O(ND) edit script between `a` and `b`, or `null` past `maxEdits`.
 *
 * Each step's furthest-reaching points are kept (only the `2d + 1` diagonals step `d` can reach, so
 * the trace is quadratic in the number of edits, not in the file), and the move that reached each —
 * a deletion (right, from diagonal `k - 1`) or an insertion (down, from `k + 1`) — beside it, so the
 * backtrack replays the choices the forward pass made instead of re-deriving them. A move that would
 * step outside either sequence is not a move; a diagonal neither neighbour can legally reach is
 * marked `-1` and never chosen.
 */
function editScript(a: Int32Array, b: Int32Array, maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const reach: Int32Array[] = [];
  const moves: Uint8Array[] = [];
  for (let d = 0; d <= maxEdits; d += 1) {
    const prev = d > 0 ? reach[d - 1] : null;
    const cur = new Int32Array(2 * d + 1);
    const how = new Uint8Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      let move: Op = EQUAL;
      if (prev === null) {
        x = 0;
      } else {
        // `prev` is indexed `k + (d - 1)`; its diagonals run from -(d - 1) to d - 1.
        const fromBelow = k + 1 <= d - 1 ? prev[k + 1 + d - 1] : -1;
        const fromLeft = k - 1 >= -(d - 1) ? prev[k - 1 + d - 1] : -1;
        const down = fromBelow >= 0 && fromBelow - k <= m ? fromBelow : -1;
        const right = fromLeft >= 0 && fromLeft + 1 <= n ? fromLeft + 1 : -1;
        if (down < 0 && right < 0) {
          cur[k + d] = -1;
          continue;
        }
        if (down >= right) {
          x = down;
          move = INSERT;
        } else {
          x = right;
          move = DELETE;
        }
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      cur[k + d] = x;
      how[k + d] = move;
      if (x === n && y === m) {
        reach.push(cur);
        moves.push(how);
        return backtrack(reach, moves, n, m);
      }
    }
    reach.push(cur);
    moves.push(how);
  }
  return null;
}

function backtrack(reach: Int32Array[], moves: Uint8Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = reach.length - 1; d > 0; d -= 1) {
    const k = x - y;
    const move = moves[d][k + d] as Op;
    const prevK = move === INSERT ? k + 1 : k - 1;
    const prevX = reach[d - 1][prevK + d - 1];
    // Where the move landed, before the snake of equal lines that followed it.
    const landedX = move === INSERT ? prevX : prevX + 1;
    while (x > landedX) {
      ops.push(EQUAL);
      x -= 1;
      y -= 1;
    }
    ops.push(move);
    x = prevX;
    y = prevX - prevK;
  }
  while (x > 0) {
    ops.push(EQUAL);
    x -= 1;
  }
  return ops.reverse();
}

/**
 * Runs of edits as `diffBlocks`' three kinds, in the buffer's 1-based line numbers: an insertion
 * after a deletion is one rewrite (**modified**, on the lines that replaced), an insertion alone is
 * **added**, and a deletion alone is **deleted**, anchored on the line that now follows it — the line
 * past the end when nothing does, which the decoration effect clamps.
 *
 * `blockIndex` is `-1`: these are not git's hunks, and there is nothing on disk for a click to peek
 * at yet. The pane hands each mark its hunk once the buffer is saved and the two agree.
 */
function marksOf(ops: Op[], firstLine: number): GutterMark[] {
  const marks: GutterMark[] = [];
  let line = firstLine;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === EQUAL) {
      line += 1;
      i += 1;
      continue;
    }
    let deleted = 0;
    let inserted = 0;
    while (i < ops.length && ops[i] !== EQUAL) {
      if (ops[i] === DELETE) deleted += 1;
      else inserted += 1;
      i += 1;
    }
    if (inserted > 0) {
      marks.push({ kind: deleted > 0 ? "modified" : "added", start: line + 1, end: line + inserted, blockIndex: -1 });
    } else {
      marks.push({ kind: "deleted", start: line + 1, end: line + 1, blockIndex: -1 });
    }
    line += inserted;
  }
  return marks;
}

/**
 * The marks for `buffer` measured against `base`, or `null` when the file is too long to diff live
 * (the caller keeps its marks from disk then).
 */
export function liveGutterMarks(base: string, buffer: string): GutterMark[] | null {
  if (base === buffer) return [];
  const before = splitLines(base);
  const after = splitLines(buffer);
  if (before.length > MAX_LINES || after.length > MAX_LINES) return null;
  const [a, b] = intern(before, after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.subarray(start, endA);
  const midB = b.subarray(start, endB);
  if (midA.length === 0 && midB.length === 0) return [];

  const ops = editScript(midA, midB, MAX_EDITS);
  if (ops) return marksOf(ops, start);
  // Too different to diff exactly on a keystroke: the changed region as one change.
  if (midB.length === 0) return [{ kind: "deleted", start: start + 1, end: start + 1, blockIndex: -1 }];
  return [{ kind: midA.length === 0 ? "added" : "modified", start: start + 1, end: start + midB.length, blockIndex: -1 }];
}
