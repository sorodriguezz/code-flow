/**
 * A line diff between two blocks of prose, for showing what somebody changed in a prompt.
 *
 * Deliberately not the git diff machinery next door: that one reads `FileDiffInfo` hunks produced
 * by libgit2 in Rust and is about files on disk. This is two strings already in memory, both short
 * — the longest built-in prompt is around 120 lines — so the classic O(n·m) LCS table is not just
 * acceptable here, it is the right call: it produces a minimal, stable diff with no heuristics to
 * explain, and at these sizes the table is a few thousand cells.
 *
 * The guard below is what keeps that promise honest if the assumption ever breaks.
 */

export type DiffKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Above this many lines on either side the LCS table stops being cheap (a million cells), and a
 * prompt that long is not one anybody is reading a diff of anyway. Past it, fall back to "the whole
 * thing changed", which is honest rather than slow.
 */
const MAX_LCS_LINES = 600;

/**
 * The changed and unchanged lines between `before` and `after`, in order.
 *
 * Both texts are compared line by line with trailing whitespace kept: a prompt where somebody added
 * two spaces at the end of a line is a prompt that differs, and hiding that would make "edited"
 * and "shows no changes" disagree.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text): DiffLine => ({ kind: "removed", text })),
      ...b.map((text): DiffLine => ({ kind: "added", text })),
    ];
  }

  // `table[i][j]` is the length of the longest common subsequence of `a[i..]` and `b[j..]`. Built
  // backwards so the walk below can go forwards, which is the order the result has to come out in.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      // Removals before additions on a changed line, so a rewrite reads as "was this, is now that".
      out.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] });
  while (j < b.length) out.push({ kind: "added", text: b[j++] });

  return out;
}

/** How many lines differ, for the "12 líneas cambiadas" line above the diff. */
export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}

/**
 * Drops long runs of unchanged lines, keeping `context` of them either side of each change.
 *
 * A prompt diff is usually three edited lines inside ninety identical ones, and showing all ninety
 * is showing nothing. Elided runs come back as a `null` gap the renderer draws as a separator, so
 * the reader can see that something was skipped rather than believing the file is shorter than it
 * is.
 */
export function collapseUnchanged(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) {
      keep[i] = true;
    }
  });

  const out: (DiffLine | null)[] = [];
  let eliding = false;
  lines.forEach((line, index) => {
    if (keep[index]) {
      out.push(line);
      eliding = false;
      return;
    }
    // One separator per run, however long the run is.
    if (!eliding) {
      out.push(null);
      eliding = true;
    }
  });
  return out;
}
