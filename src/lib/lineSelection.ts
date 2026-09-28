import type { DiffHunkInfo, DiffLine, FileDiffInfo } from "../types/domain";
import type { LineSelection } from "./tauri/gitCommands";

/**
 * The Changes screen's line selection, as data: which rows can be picked, what a shift-click range
 * covers, what is sent to `stage_lines` / `unstage_lines` / `discard_lines`, and where each narrow
 * hunk's buttons go in a diff drawn at full context.
 *
 * **A row is named by what it is, not where it sits.** `+:42:text` — its sign, the line number on
 * the side it belongs to, and its text. The diff pane is rebuilt on every watcher tick, so an index
 * into it names a different line the moment an edit above lands; the identity survives a refresh
 * whenever the line itself did, and silently drops out of the selection when it did not. The text
 * is part of it on purpose: a line the user picked and then edited is not the line they picked, and
 * staging its new text would stage something they never selected.
 */

export function isChange(line: DiffLine): boolean {
  return line.origin === "+" || line.origin === "-";
}

/** A changed row's identity — see the module note. Only `+` and `-` rows have one. */
export function lineId(line: DiffLine): string | null {
  if (line.origin === "+") return `+:${line.new_lineno ?? ""}:${line.content}`;
  if (line.origin === "-") return `-:${line.old_lineno ?? ""}:${line.content}`;
  return null;
}

/** Every changed row of the file, in the order the diff draws them. */
export function changedLines(file: FileDiffInfo): DiffLine[] {
  const out: DiffLine[] = [];
  for (const hunk of file.hunks) for (const line of hunk.lines) if (isChange(line)) out.push(line);
  return out;
}

/**
 * The ids from `fromId` to `toId`, inclusive, in drawing order — a shift-click or a drag. Either end
 * may be above the other. An end that is no longer in the diff makes the range just the other end.
 */
export function rangeIds(file: FileDiffInfo, fromId: string, toId: string): string[] {
  const ids = changedLines(file).map((line) => lineId(line) as string);
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a === -1 || b === -1) return b === -1 ? (a === -1 ? [] : [fromId]) : [toId];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return ids.slice(lo, hi + 1);
}

/** The selection minus whatever the current diff no longer has. */
export function pruneSelection(file: FileDiffInfo | null | undefined, selected: ReadonlySet<string>): Set<string> {
  if (!file || selected.size === 0) return new Set();
  const present = new Set(changedLines(file).map((line) => lineId(line) as string));
  return new Set([...selected].filter((id) => present.has(id)));
}

/** What crosses the wire: the selected rows, verbatim, in drawing order. */
export function selectionPayload(file: FileDiffInfo, path: string, selected: ReadonlySet<string>): LineSelection {
  return {
    file_path: path,
    lines: changedLines(file).filter((line) => selected.has(lineId(line) as string)),
  };
}

/** How many of the selected rows are added and how many removed — the action bar's counter. */
export function selectionCounts(file: FileDiffInfo, selected: ReadonlySet<string>): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of changedLines(file)) {
    if (!selected.has(lineId(line) as string)) continue;
    if (line.origin === "+") added += 1;
    else removed += 1;
  }
  return { added, removed };
}

/** A row's position in the drawn diff, for anchoring things next to it. */
export interface RowRef {
  hunk: number;
  line: number;
}

function sameRow(a: DiffLine, b: DiffLine): boolean {
  return a.origin === b.origin && a.old_lineno === b.old_lineno && a.new_lineno === b.new_lineno && a.content === b.content;
}

/**
 * Where each of the file's *narrow* hunks starts in the full-context diff the pane draws.
 *
 * The pane shows the whole file (one big hunk, so the split view can rebuild both sides), while
 * `stage_hunk` needs the hunks git produces at `LIST_DIFF_CONTEXT_LINES` — the store's
 * `workingDiff`/`stagedDiff`. Each narrow hunk is placed at the full-view row identical to its first
 * line. A hunk whose first row cannot be found (the two diffs are from different moments) is left
 * out: no button is better than a button that would be refused as stale.
 */
export function hunkAnchors(full: FileDiffInfo, narrow: FileDiffInfo | null | undefined): Map<string, number> {
  const anchors = new Map<string, number>();
  if (!narrow) return anchors;
  narrow.hunks.forEach((hunk: DiffHunkInfo, index) => {
    const first = hunk.lines[0];
    if (!first) return;
    for (let h = 0; h < full.hunks.length; h += 1) {
      const at = full.hunks[h].lines.findIndex((line) => sameRow(line, first));
      if (at !== -1) {
        anchors.set(`${h}:${at}`, index);
        return;
      }
    }
  });
  return anchors;
}

/** The ids of one narrow hunk's changed rows — what "select this hunk" adds to the selection. */
export function hunkLineIds(hunk: DiffHunkInfo): string[] {
  return hunk.lines.filter(isChange).map((line) => lineId(line) as string);
}
