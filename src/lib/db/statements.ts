import { blankQuotedAndComments } from "./sqlGuards";

/**
 * Where one statement ends and the next begins, on the frontend.
 *
 * The console's Run button executes **one** statement — the first one written, or whatever is
 * highlighted — while the button beside it runs the whole buffer in order. Deciding which text the
 * first of those means is this module's whole job.
 *
 * **It mirrors the backend's own splitter rather than improving on it.** `datasource::split_statements`
 * is what actually cuts the buffer up when the text arrives there, so a frontend that drew the
 * boundaries somewhere else would hand over a fragment the engine then re-split differently — and
 * "run the first statement" would run one and a half. Same scanner, same rules: `;` outside string
 * literals, quoted identifiers, comments and Postgres `$tag$` bodies, plus Mongo's blank line, which
 * is the only separator a shell buffer has.
 *
 * It is not a parser and does not need to be. A dialect terminator it cannot know about (`GO`, a
 * `$$` body on an engine that isn't Postgres) makes the first statement *longer* than it should be,
 * which the engine then rejects or runs as one — the same thing that happens today when the whole
 * buffer is sent.
 */

/** Which grammar the console is typed in — `engineInfo(kind).consoleLanguage`. */
export type ConsoleLanguage = "sql" | "javascript" | "redis";

/**
 * The buffer's statements, in order, trimmed and with the empty ones dropped.
 *
 * A run of text that masks down to nothing — blank lines, or a comment with no statement after it —
 * is not a statement. That distinction is why the mask is consulted rather than the raw slice: a
 * console whose first line is `-- TODO: fix this` must run the query *below* it, not the comment.
 * The text returned is the original, comments included, since a comment above a statement belongs
 * to it.
 */
export function splitStatements(text: string, language: ConsoleLanguage): string[] {
  // A Redis buffer is one command per line and `;` is a legal byte inside a value — the same reason
  // `redis.rs` refuses to use the shared splitter. `#` is the console's own comment marker.
  if (language === "redis") {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  }

  // Mongo's shell has no terminator, so two commands in a scratch buffer are separated by the blank
  // line people already put between them — and by `;` where one was written. Both, in that order,
  // exactly as `split_mongo_statements` does it.
  const blocks = language === "javascript" ? text.split("\n\n") : [text];

  const out: string[] = [];
  for (const block of blocks) {
    const masked = blankQuotedAndComments(block);
    let start = 0;
    for (let index = 0; index <= masked.length; index += 1) {
      // Boundaries come from the masked copy, so a `;` inside a literal or a comment doesn't split
      // one. It keeps the original's length, so the offsets index both strings.
      if (index !== masked.length && masked[index] !== ";") continue;
      const isCode = masked.slice(start, index).trim().length > 0;
      const piece = block.slice(start, index).trim();
      start = index + 1;
      if (isCode && piece) out.push(piece);
    }
  }
  return out;
}

/**
 * The first statement in the buffer, or `null` when there is nothing to run.
 *
 * What the Run button sends when nothing is selected. `null` — rather than falling back to the
 * whole buffer — is the honest answer for a console holding only comments or whitespace: running
 * "everything" there would be running nothing, and the button that *does* mean everything is the
 * one next to it.
 */
export function firstStatement(text: string, language: ConsoleLanguage): string | null {
  return splitStatements(text, language)[0] ?? null;
}
