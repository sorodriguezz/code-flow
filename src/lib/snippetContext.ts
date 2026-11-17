/**
 * Where a snippet can't be what the user wants.
 *
 * Snippets are statements and expressions — `clg` writes `console.log(…)`, `afn` a whole
 * `const name = async (…) => {…}`. Inside a destructuring pattern the only valid things to type are
 * names of the value being taken apart, so a snippet there can only write broken code. Worse, when
 * the compiler has nothing to offer — every property the type is *guaranteed* to have is already
 * written, as with a union whose members share only their tag — the snippets were the whole list,
 * and a list of `afn / cle / clg / fn / tryc` under `const { isRechazado, | }` read as the editor
 * not understanding the code, when the honest answer was "nothing more fits here".
 */

/** Languages whose destructuring syntax this reads. */
const DESTRUCTURING_LANGUAGES = new Set(["typescript", "javascript", "typescriptreact", "javascriptreact"]);

/** How far back to look for the `const {` that opens the pattern — a long multi-line one included. */
const LOOKBACK_LINES = 40;

/**
 * Whether the caret, at the end of `textBefore`, is inside an open `const {…}` / `let […]` /
 * `var {…}` binding pattern. Conservative by construction: it only ever says "inside" for a
 * declaration keyword followed by a bracket that has not been closed yet, so at worst a snippet is
 * offered where it was before.
 */
export function insideDestructuringPattern(textBefore: string): boolean {
  const opener = /\b(?:const|let|var)\s*([{[])/g;
  let last: RegExpExecArray | null = null;
  for (let m = opener.exec(textBefore); m; m = opener.exec(textBefore)) last = m;
  if (!last) return false;
  // Bracket depth from the pattern's own bracket on. Back to zero means the pattern closed — the
  // caret is in the initializer or past the statement.
  let depth = 0;
  for (let i = last.index + last[0].length - 1; i < textBefore.length; i++) {
    const ch = textBefore[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return false;
    }
  }
  return depth > 0;
}

/**
 * Whether snippets should stay out of the completion list at this caret. Reads lines through
 * `lineAt` (1-based) so a keystroke in a large file copies only the lines it looks at.
 */
export function suppressSnippetsAt(
  languageId: string,
  lineAt: (lineNumber: number) => string,
  lineNumber: number,
  column: number,
): boolean {
  if (!DESTRUCTURING_LANGUAGES.has(languageId)) return false;
  const before: string[] = [];
  for (let n = Math.max(1, lineNumber - LOOKBACK_LINES); n < lineNumber; n++) before.push(lineAt(n));
  before.push(lineAt(lineNumber).slice(0, column - 1));
  return insideDestructuringPattern(before.join("\n"));
}
