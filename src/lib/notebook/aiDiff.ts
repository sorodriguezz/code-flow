import { collapseUnchanged, diffLines, type DiffLine } from "../textDiff";

/**
 * What an AI answer for a cell would change, as the lines a reviewer reads: the cell as it is now
 * against the answer, unchanged runs folded to a few lines of context either side.
 *
 * `before` is the cell's source *now*, not when it was asked about — the question on screen is
 * "what will Accept do to this cell", and Accept writes the answer over whatever the cell holds.
 * An empty `before` (a generated cell) shows every line as added.
 */
export function proposalDiff(before: string, after: string): (DiffLine | null)[] {
  const trimmedBefore = before.replace(/\n+$/, "");
  const trimmedAfter = after.replace(/\n+$/, "");
  if (trimmedBefore === "") {
    return trimmedAfter === "" ? [] : trimmedAfter.split("\n").map((text) => ({ kind: "added" as const, text }));
  }
  return collapseUnchanged(diffLines(trimmedBefore, trimmedAfter), 3);
}

/** Whether an answer would leave the cell exactly as it is — nothing to accept. */
export function changesNothing(before: string, after: string): boolean {
  return before.replace(/\s+$/, "") === after.replace(/\s+$/, "");
}
