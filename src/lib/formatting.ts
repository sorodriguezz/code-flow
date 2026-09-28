import { invoke } from "@tauri-apps/api/core";
import { lineHunks } from "./liveGutter";
import type { TextEdit } from "./workspaceEdit";

/**
 * Formatting with the repository's own Prettier — the pure half, and the call to the backend.
 *
 * "Formatear documento" used to mean Monaco's formatter for the language: the TypeScript worker's
 * for TS/JS, the CSS and HTML services' for theirs. Those are reasonable, and they are not what the
 * project checks. A repository that has Prettier has decided how its code looks, and a formatter
 * that disagrees with it produces a diff on every file it touches. So when there is one — in the
 * repository's `node_modules`, never bundled — it is what formats; `prettier.rs` runs it on the
 * buffer from the repository root, which is what makes the project's config and `.prettierignore`
 * apply. When there is none, or it has no parser for the file, the editor's own formatter answers
 * exactly as before.
 */

/**
 * The extensions Prettier itself formats, plus the three component formats its plugins cover (an
 * install without the plugin answers "no parser", which falls back like a repository without
 * Prettier). Anything else never spawns a Node process to be told no.
 *
 * `.ipynb` is JSON and deliberately absent: a notebook is saved in Jupyter's own layout (see
 * `lib/notebook`), which Prettier's JSON would rewrite on every save.
 */
const PRETTIER_EXTENSIONS = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "json",
  "jsonc",
  "json5",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "astro",
  "md",
  "markdown",
  "mdx",
  "yaml",
  "yml",
  "graphql",
  "gql",
  "hbs",
  "handlebars",
]);

/** Whether a file is one Prettier would be asked about. */
export function prettierCanFormat(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && PRETTIER_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** What `format_with_prettier` answers. `unavailable` and `unsupported` mean "use the other
 *  formatter"; a failure — a syntax error, a timeout — rejects with Prettier's own first line. */
export type PrettierOutcome = { kind: "formatted"; text: string } | { kind: "unavailable" } | { kind: "unsupported" };

export const formatWithPrettier = (repoPath: string, relPath: string, text: string) =>
  invoke<PrettierOutcome>("format_with_prettier", { repoPath, relPath, text });

/** The line ending a text mostly uses — what a formatter's answer is written back with. */
export function eolOf(text: string): "\n" | "\r\n" {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * A formatter's whole-file answer as edits that only touch the lines it changed.
 *
 * Replacing the whole buffer would work and would cost the caret its place, every decoration its
 * line and the undo stack its granularity: after ⌘S the caret would sit at the end of the file.
 * The diff is the gutter's (`lineHunks`); each changed run of lines becomes one edit, written with
 * `eol`, in `before`'s coordinates, and none of them overlap — so Monaco can apply them together as
 * one undo step.
 *
 * Differences in line endings alone produce no edits: a model has one ending for the whole file,
 * and the caller sets it separately.
 */
export function lineEdits(before: string, after: string, eol: string): TextEdit[] {
  const lines = before.split(/\r\n|\r|\n/);
  const next = after.split(/\r\n|\r|\n/);
  const count = lines.length;
  const endOf = (index: number) => lines[index].length + 1;
  return lineHunks(before, after).map((hunk) => {
    const inserted = next.slice(hunk.bufferStart, hunk.bufferEnd);
    if (hunk.baseEnd < count) {
      // The run is followed by an unchanged line: replace up to that line's start.
      return {
        range: { startLineNumber: hunk.baseStart + 1, startColumn: 1, endLineNumber: hunk.baseEnd + 1, endColumn: 1 },
        text: inserted.map((line) => line + eol).join(""),
      };
    }
    if (hunk.baseStart > 0) {
      // The run reaches the end of the file: start from the end of the line before it, so lines can
      // be removed there without leaving a dangling break.
      return {
        range: {
          startLineNumber: hunk.baseStart,
          startColumn: endOf(hunk.baseStart - 1),
          endLineNumber: count,
          endColumn: endOf(count - 1),
        },
        text: inserted.map((line) => eol + line).join(""),
      };
    }
    return {
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: count, endColumn: endOf(count - 1) },
      text: inserted.join(eol),
    };
  });
}
