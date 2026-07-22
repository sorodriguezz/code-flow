import type { FileDiffInfo } from "../types/domain";

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
