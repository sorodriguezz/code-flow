/**
 * The checks a console runs *before* sending a statement.
 *
 * There is exactly one at the moment, and it earns its place: `DELETE FROM t` with no `WHERE` is a
 * single keystroke away from `DELETE FROM t WHERE …` and empties the table instead of removing a
 * row. Every other mistake a console can make is either visible (you read the rows that came back)
 * or recoverable (an `UPDATE` you can invert); this one is neither, and it is the only statement
 * where the *absence* of a clause is what does the damage.
 *
 * It is a refusal rather than a confirmation on purpose. A prompt that appears in front of a
 * statement you meant to run is a prompt you learn to dismiss, and it would be shown most often to
 * the people running the statement deliberately. Deleting every row is still perfectly possible —
 * `WHERE 1=1` says it out loud, which is the point.
 *
 * The analysis is deliberately syntactic and conservative: comments and string literals are blanked
 * first (so a `--` or a `'…WHERE…'` can neither hide a `DELETE` nor fake a `WHERE`), the text is
 * split on statement boundaries, and only a statement that *starts* with `DELETE` is judged. It is
 * not a SQL parser and doesn't try to be — a false "this looks unguarded" is a statement the user
 * rewrites slightly, and the failure it prevents is a table.
 */

/**
 * Replaces every comment and string/identifier literal with spaces, keeping the text's length and
 * line structure so offsets still line up.
 *
 * `$$…$$` dollar quoting is included because a Postgres function body is the one place a `DELETE`
 * without a `WHERE` legitimately appears inside another statement — as text, not as something this
 * console is running.
 */
export function blankQuotedAndComments(sql: string): string {
  let out = "";
  let index = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");

  while (index < sql.length) {
    const rest = sql.slice(index);

    const lineComment = /^--[^\n]*/.exec(rest);
    if (lineComment) {
      out += blank(lineComment[0]);
      index += lineComment[0].length;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", index + 2);
      const chunk = end === -1 ? rest : sql.slice(index, end + 2);
      out += blank(chunk);
      index += chunk.length;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, index + tag.length);
      const chunk = end === -1 ? rest : sql.slice(index, end + tag.length);
      out += blank(chunk);
      index += chunk.length;
      continue;
    }
    const quote = rest[0];
    if (quote === "'" || quote === '"' || quote === "`" || quote === "[") {
      const closing = quote === "[" ? "]" : quote;
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === closing) {
          // Doubled quotes are an escaped quote, not the end of the literal.
          if (sql[cursor + 1] === closing) cursor += 2;
          else break;
        } else {
          cursor += 1;
        }
      }
      const chunk = sql.slice(index, Math.min(cursor + 1, sql.length));
      out += blank(chunk);
      index += chunk.length;
      continue;
    }
    out += sql[index];
    index += 1;
  }
  return out;
}

/**
 * The first `DELETE` in `sql` that has no `WHERE`, or `null` when there is none.
 *
 * Returns the offending statement (trimmed, and shortened if it is long) so the message can name
 * it — with several statements in the box, "one of these has no WHERE" is not an answer.
 */
export function unguardedDelete(sql: string): string | null {
  const masked = blankQuotedAndComments(sql);
  let start = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    // Statement boundaries come from the masked text, so a `;` inside a literal doesn't split one.
    if (index !== masked.length && masked[index] !== ";") continue;
    const maskedStatement = masked.slice(start, index);
    const original = sql.slice(start, index).trim();
    start = index + 1;
    if (!/^\s*delete\b/i.test(maskedStatement)) continue;
    // `RETURNING`/`USING` and any amount of whitespace or newlines are irrelevant: the question is
    // only whether the word appears at all outside a literal.
    if (/\bwhere\b/i.test(maskedStatement)) continue;
    return original.length > 160 ? `${original.slice(0, 160)}…` : original;
  }
  return null;
}
