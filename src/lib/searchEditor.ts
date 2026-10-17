import type * as Monaco from "monaco-editor";
import { modelPathFor } from "./editorModel";
import { definitionProject, openDefinitionTarget } from "./goToDefinition";

/**
 * VS Code's search editor: the results of a project search as a tab — a `.code-search` scratch
 * buffer anyone can scroll, search inside, edit down and save — instead of only the sidebar's list.
 *
 * The text is VS Code's own layout, so a saved one reads the same in both editors:
 *
 * ```
 * # Query: fetchUser
 * # Flags: CaseSensitive
 * # Including: src
 *
 * 3 results - 2 files
 *
 * src/api.ts:
 *   11    // the line before
 *   12:   export async function fetchUser(id: string) {
 *   13    const response = await http.get(`/users/${id}`);
 * ```
 *
 * A line with `:` after its number is a match, one with spaces is context. Double-clicking a result
 * line, or ⌘/Ctrl+click and F12 on it, opens the file there — through the same editor opener
 * go-to-definition uses.
 */

export const SEARCH_RESULT_LANGUAGE = "search-result";

export interface SearchEditorInput {
  query: string;
  flags: { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
  include: string;
  exclude: string;
  /** Repo-relative path → its hit lines (1-based) in order. */
  files: [string, { line_no: number; line: string }[]][];
  /** A file's whole text, for the context lines around each hit. Absent: hits only. */
  textOf?: (path: string) => string | null;
  /** Lines shown before and after each hit. */
  context: number;
  truncated: boolean;
}

export function formatSearchResults(input: SearchEditorInput): string {
  const out: string[] = [`# Query: ${input.query}`];
  const flags = [
    input.flags.regex ? "RegExp" : null,
    input.flags.caseSensitive ? "CaseSensitive" : null,
    input.flags.wholeWord ? "WordMatch" : null,
  ].filter(Boolean);
  if (flags.length > 0) out.push(`# Flags: ${flags.join(" ")}`);
  if (input.include.trim()) out.push(`# Including: ${input.include.trim()}`);
  if (input.exclude.trim()) out.push(`# Excluding: ${input.exclude.trim()}`);
  out.push("");
  const total = input.files.reduce((n, [, hits]) => n + hits.length, 0);
  out.push(`${total} result${total === 1 ? "" : "s"} - ${input.files.length} file${input.files.length === 1 ? "" : "s"}${input.truncated ? " (truncated)" : ""}`);

  for (const [path, hits] of input.files) {
    out.push("", `${path}:`);
    const text = input.textOf?.(path) ?? null;
    const lines = text === null ? null : text.split(/\r\n|\r|\n/);
    const matched = new Set(hits.map((hit) => hit.line_no));
    const shown = new Map<number, string>();
    for (const hit of hits) {
      shown.set(hit.line_no, hit.line);
      if (!lines) continue;
      for (let n = hit.line_no - input.context; n <= hit.line_no + input.context; n++) {
        if (n >= 1 && n <= lines.length && !shown.has(n)) shown.set(n, lines[n - 1]);
      }
    }
    const numbers = [...shown.keys()].sort((a, b) => a - b);
    const width = String(numbers[numbers.length - 1] ?? 0).length;
    let previous = 0;
    for (const n of numbers) {
      // A gap between two runs of context, as VS Code draws it.
      if (previous && n > previous + 1) out.push("  ...");
      const label = String(n).padStart(width, " ");
      out.push(`  ${label}${matched.has(n) ? ":" : " "} ${shown.get(n) ?? ""}`);
      previous = n;
    }
  }
  return `${out.join("\n")}\n`;
}

/** The file and line a line of a search-results buffer points at, or `null` for a header, a gap
 *  or a comment. `lineAt(n)` reads line `n` (1-based) of the buffer. */
export function searchResultTarget(lineAt: (n: number) => string, lineNumber: number): { path: string; line: number } | null {
  const own = /^\s+(\d+)[: ] /.exec(lineAt(lineNumber));
  if (!own) return null;
  for (let n = lineNumber - 1; n >= 1; n--) {
    const text = lineAt(n);
    if (/^\s/.test(text) || text === "") continue;
    if (text.startsWith("#")) return null;
    const header = /^(.*):$/.exec(text);
    return header ? { path: header[1], line: Number(own[1]) } : null;
  }
  return null;
}

/**
 * `text` with every match replaced, the way the backend's replace will do it — for the per-file
 * preview before anything is written. A JS `RegExp` stands in for Rust's `regex`, which agree on the
 * patterns a search box sees (classes, groups, anchors, `$1` in the replacement); `null` when the
 * pattern is one JavaScript refuses.
 */
export function previewReplace(
  text: string,
  query: string,
  replacement: string,
  flags: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
): string | null {
  const source = flags.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern: RegExp;
  try {
    pattern = new RegExp(flags.wholeWord ? `\\b(?:${source})\\b` : source, flags.caseSensitive ? "gm" : "gim");
  } catch {
    return null;
  }
  // Literal unless the search is a regex: a `$` in a plain replacement is a dollar sign.
  return flags.regex ? text.replace(pattern, replacement) : text.replace(pattern, () => replacement);
}

let installed = false;

export function installSearchEditor(monaco: typeof Monaco): void {
  if (installed) return;
  installed = true;
  monaco.languages.register({ id: SEARCH_RESULT_LANGUAGE, extensions: [".code-search"], aliases: ["Search Result"] });
  monaco.languages.setMonarchTokensProvider(SEARCH_RESULT_LANGUAGE, {
    tokenizer: {
      root: [
        [/^#.*$/, "comment"],
        [/^\d+ results? - \d+ files?.*$/, "comment"],
        [/^\S.*:$/, "type.identifier"],
        [/^(\s+)(\d+)(:)/, ["", "number", "keyword"]],
        [/^(\s+)(\d+)/, ["", "comment"]],
        [/^\s+\.\.\.$/, "comment"],
      ],
    },
  });

  const target = (model: Monaco.editor.ITextModel, lineNumber: number) =>
    searchResultTarget((n) => (n >= 1 && n <= model.getLineCount() ? model.getLineContent(n) : ""), lineNumber);

  // ⌘/Ctrl+click and F12: a location in the file, which the app's editor opener takes from here.
  monaco.languages.registerDefinitionProvider(SEARCH_RESULT_LANGUAGE, {
    provideDefinition: (model, position) => {
      const hit = target(model, position.lineNumber);
      const project = definitionProject();
      if (!hit || !project) return null;
      return {
        uri: monaco.Uri.parse(modelPathFor(project, hit.path)),
        range: new monaco.Range(hit.line, 1, hit.line, 1),
      };
    },
  });

  // Double-click, as in VS Code's search editor.
  monaco.editor.onDidCreateEditor((editor) => {
    editor.onMouseDown((event) => {
      if (event.event.detail !== 2) return;
      const model = editor.getModel();
      const line = event.target.position?.lineNumber;
      if (!model || !line || model.getLanguageId() !== SEARCH_RESULT_LANGUAGE) return;
      const hit = target(model, line);
      if (hit) openDefinitionTarget(hit.path, hit.line);
    });
  });
}
