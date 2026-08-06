import type { FileDiffInfo } from "../types/domain";

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
