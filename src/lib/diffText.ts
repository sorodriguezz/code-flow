import type { FileDiffInfo } from "../types/domain";

/**
 * A cheap identity for "this file's change, as git currently sees it right now" — every added and
 * removed line verbatim plus the hunk headers that place them.
 *
 * Every caller reads the store's `workingDiff`/`stagedDiff`, which the filesystem watcher rebuilds
 * from scratch several times a second, so the diff object has a fresh identity on every tick even
 * when the file has not moved. Keying anything expensive on the object would put that work on every
 * tick; keying it on the content means a tick that found the same change does nothing, and any real
 * edit invalidates.
 *
 * Context lines are left out on purpose: they are precisely what the narrow list diff does not
 * carry, so a signature that included them would depend on what it cannot see.
 *
 * Lives here rather than in one of its callers because there are now three of them — the editor's
 * whole-file diff fetch, the Changes panel's diff pane, and the editor's change-block list, which is
 * what finally earned the move the `EditorPane` copy's own comment asked for.
 */
export function diffSignature(file: FileDiffInfo): string {
  const parts: string[] = [file.status, file.new_path ?? "", file.old_path ?? ""];
  for (const hunk of file.hunks) {
    parts.push(hunk.header);
    for (const line of hunk.lines) {
      if (line.origin !== " ") {
        parts.push(`${line.origin}${line.old_lineno ?? ""}:${line.new_lineno ?? ""}:${line.content}`);
      }
    }
  }
  return parts.join(" ");
}

/**
 * The Tailwind classes for one row of a hand-rendered diff, by its origin character.
 *
 * 14%, which is a *read-only* weight: everywhere this is used the diff is the content — the Changes
 * screen's unified pane, the editor's inline change peek — so the tint is what tells the two sides
 * apart at a glance. The editor's own changed-line background sits at 6% instead (see
 * `.cf-editor-changed-line-*` in `index.css`), because that one lies under code you are typing in.
 *
 * Shared from here rather than imported out of `DiffView`: the peek needs exactly these colours and
 * cross-importing a component for a string function drags a Monaco `DiffEditor` and an
 * `IntersectionObserver` into the editor's bundle graph for no reason.
 */
export function lineClasses(origin: string): string {
  if (origin === "+") return "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-text)]";
  if (origin === "-") return "bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)] text-[var(--cf-text)]";
  return "text-[var(--cf-text-muted)]";
}

/** Rebuilds the two full-text sides of a file's diff from its hunks — the diff commands
 * already run with (near-)unlimited context lines, so for anything but a huge commit-view
 * diff this reproduces the whole original/modified file, which is what a side-by-side
 * Monaco DiffEditor needs (it diffs two full texts itself, not a hunk list).
 *
 * Lives here rather than beside the diff view because both places that show a file
 * side-by-side need it: the Changes screen's split mode, and the editor's own diff tab. */
export function reconstructSides(file: FileDiffInfo): { original: string; modified: string } {
  const original: string[] = [];
  const modified: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.origin === "-") original.push(line.content);
      else if (line.origin === "+") modified.push(line.content);
      else {
        original.push(line.content);
        modified.push(line.content);
      }
    }
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}

/** Reconstructs a human-readable unified-diff-ish text from structured hunks,
 * good enough to feed an LLM prompt — it doesn't need to be git-apply-valid. */
export function diffToText(files: FileDiffInfo[]): string {
  return files
    .map((file) => {
      const path = file.new_path ?? file.old_path ?? "unknown";
      const header = `--- ${file.status}: ${path}`;
      const hunks = file.hunks
        .map((hunk) => {
          const lines = hunk.lines.map((line) => `${line.origin === " " ? " " : line.origin}${line.content}`);
          return [hunk.header, ...lines].join("\n");
        })
        .join("\n");
      return [header, hunks].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Intra-line highlighting
// ---------------------------------------------------------------------------

/** One run of a line, marked as changed or not. */
export interface InlineSpan {
  text: string;
  changed: boolean;
}

/**
 * The parts of a removed/added pair that actually differ.
 *
 * The diff has always been line-level: a line where one character changed was painted end to end in
 * red and green, and finding the change was the reader's job. Every other git client highlights the
 * differing run inside the line, and this is that.
 *
 * **Deliberately a common prefix/suffix trim rather than a word diff.** Two reasons: it is exact —
 * no tokenizer to disagree with the language on screen, and no chance of "highlighting" something
 * that did not change — and it is O(n) per line, which matters when the pane can hold a thousand of
 * them. Where it is weaker than a word diff is a line whose middle was reordered; there it marks
 * the whole middle, which is honest ("something in here") rather than wrong.
 */
export function inlineSpans(before: string, after: string): { before: InlineSpan[]; after: InlineSpan[] } {
  const shorter = Math.min(before.length, after.length);

  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const split = (text: string): InlineSpan[] => {
    const middle = text.slice(prefix, text.length - suffix);
    const spans: InlineSpan[] = [];
    if (prefix > 0) spans.push({ text: text.slice(0, prefix), changed: false });
    if (middle) spans.push({ text: middle, changed: true });
    if (suffix > 0) spans.push({ text: text.slice(text.length - suffix), changed: false });
    // An empty line, or one side of a pure insertion — one unchanged empty span keeps the caller's
    // rendering uniform rather than making it handle an empty array.
    return spans.length > 0 ? spans : [{ text, changed: false }];
  };

  return { before: split(before), after: split(after) };
}

/**
 * Whether two lines are close enough that highlighting inside them tells the truth.
 *
 * A removed line and an added line that share almost nothing are two different lines, not an edit,
 * and marking 95% of both as "changed" is noise dressed as information. The threshold is on the
 * *unchanged* share: below a third in common, the pair is left painted the old way.
 */
export function worthHighlighting(before: string, after: string): boolean {
  if (!before.trim() || !after.trim()) return false;
  const { before: spans } = inlineSpans(before, after);
  const common = spans.filter((span) => !span.changed).reduce((sum, span) => sum + span.text.length, 0);
  return common / Math.max(before.length, after.length) >= 0.34;
}

/**
 * Pairs up the removed and added lines inside one hunk, so each pair can be highlighted against its
 * counterpart.
 *
 * Git emits a hunk as a run of `-` lines followed by a run of `+` lines. Pairing them by position
 * within those runs is what `git --word-diff` does too, and it is right for the overwhelmingly
 * common case (a block of N lines rewritten as N lines). A run where the counts differ pairs as far
 * as it can and leaves the remainder unpaired, which is the honest answer for a line that was
 * genuinely added rather than edited.
 */
export function pairHunkLines(origins: string[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let index = 0;
  while (index < origins.length) {
    if (origins[index] !== "-") {
      index++;
      continue;
    }
    const removedStart = index;
    while (index < origins.length && origins[index] === "-") index++;
    const addedStart = index;
    while (index < origins.length && origins[index] === "+") index++;

    const removed = addedStart - removedStart;
    const added = index - addedStart;
    for (let offset = 0; offset < Math.min(removed, added); offset++) {
      pairs.set(removedStart + offset, addedStart + offset);
      pairs.set(addedStart + offset, removedStart + offset);
    }
  }
  return pairs;
}
