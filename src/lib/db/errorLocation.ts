/**
 * Where in a statement the server says it broke — so the console can underline it instead of
 * leaving the user to count characters.
 *
 * Every engine says it differently, and only in its message text:
 *
 * - PostgreSQL: `pg_error` appends `(at Original(42))` — a 1-based character position.
 * - SQL Server: `tds_error` appends `(line 3)`.
 * - MySQL / MariaDB: `… near 'FROMM users' at line 1`.
 * - Oracle through JDBC, and others: `line 2, column 7` / `Line: 2 Column: 7`.
 * - SQLite (and MySQL's `near`): `near "FROMM": syntax error` — a token to look for.
 *
 * Answers a range *within the statement*, 1-based lines and columns as Monaco counts them, or
 * `null` when the message names no place. A guess that lands on the wrong token would be worse than
 * no underline, so a `near` token that is not found in the statement gives nothing.
 */
export interface ErrorSpot {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export function errorLocation(statement: string, message: string): ErrorSpot | null {
  const position = /\(at (?:Original|Internal\s*\{\s*position:)\s*\(?(\d+)/.exec(message);
  if (position) return spotAtOffset(statement, Number(position[1]) - 1);

  const lineColumn = /line:?\s*(\d+),?\s*column:?\s*(\d+)/i.exec(message);
  if (lineColumn) return wordAt(statement, Number(lineColumn[1]), Number(lineColumn[2]));

  const near = /near ["'`]((?:[^"'`]|["'`](?!:|\s+at line))+?)["'`](?::| at line| |$)/i.exec(message);
  const nearLine = /at line (\d+)/i.exec(message);
  if (near && near[1].trim()) {
    // MySQL quotes the rest of the statement from the failure on; its first word is the culprit.
    const token = near[1].trim().split(/\s+/)[0];
    const from = nearLine ? offsetOfLine(statement, Number(nearLine[1])) : 0;
    const at = statement.indexOf(token, from);
    if (at >= 0) return spotAtOffset(statement, at, token.length);
  }

  const lineOnly = /\(line (\d+)\)|at line (\d+)/i.exec(message);
  if (lineOnly) {
    const line = Number(lineOnly[1] ?? lineOnly[2]);
    const lines = statement.split("\n");
    if (line < 1 || line > lines.length) return null;
    const text = lines[line - 1];
    const first = text.length - text.trimStart().length + 1;
    return { line, column: first, endLine: line, endColumn: Math.max(first + 1, text.trimEnd().length + 1) };
  }
  return null;
}

function offsetOfLine(text: string, line: number): number {
  let at = 0;
  for (let index = 1; index < line; index += 1) {
    const next = text.indexOf("\n", at);
    if (next < 0) return at;
    at = next + 1;
  }
  return at;
}

/** The word starting at `offset` (or the single character, when it isn't one). */
function spotAtOffset(text: string, offset: number, length?: number): ErrorSpot | null {
  if (offset < 0 || offset > text.length) return null;
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1) + 1;
  const word = length ?? Math.max(1, /^[\w$.#]+/.exec(text.slice(offset))?.[0].length ?? 1);
  return { line, column, endLine: line, endColumn: column + word };
}

function wordAt(text: string, line: number, column: number): ErrorSpot | null {
  const lines = text.split("\n");
  if (line < 1 || line > lines.length) return null;
  return spotAtOffset(text, offsetOfLine(text, line) + Math.max(0, column - 1));
}

/** Where a statement that was run sits in the buffer it came from, as a 0-based offset, searching
 *  from `from` so the second of two identical statements is found as the second. */
export function locateStatement(buffer: string, statement: string, from = 0): number {
  const at = buffer.indexOf(statement, from);
  return at >= 0 ? at : buffer.indexOf(statement);
}
