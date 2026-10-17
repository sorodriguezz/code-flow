import { blankQuotedAndComments } from "./sqlGuards";

/**
 * Where one statement ends and the next begins, on the frontend.
 *
 * The console's Run button executes **one** statement — the one under the caret (or the first one
 * written, per the setting), or whatever is highlighted — while the button beside it runs the whole
 * buffer in order. Deciding which text the first of those means is this module's whole job.
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
  return statementRanges(text, language).map((range) => range.text);
}

/** One statement of the buffer and where it sits in it: `start`/`end` are offsets into the text
 *  (end exclusive, the terminator not included), `text` is that slice trimmed. */
export interface StatementRange {
  start: number;
  end: number;
  text: string;
}

/** `splitStatements` with the offsets kept — what "the statement under the cursor" is found in. */
export function statementRanges(text: string, language: ConsoleLanguage): StatementRange[] {
  const out: StatementRange[] = [];
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const piece = raw.trim();
    if (piece) out.push({ start: from + lead, end: from + lead + piece.length, text: piece });
  };

  // A Redis buffer is one command per line and `;` is a legal byte inside a value — the same reason
  // `redis.rs` refuses to use the shared splitter. `#` is the console's own comment marker.
  if (language === "redis") {
    let at = 0;
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("#")) push(at, at + line.length);
      at += line.length + 1;
    }
    return out;
  }

  // Mongo's shell has no terminator, so two commands in a scratch buffer are separated by the blank
  // line people already put between them — and by `;` where one was written. Both, in that order,
  // exactly as `split_mongo_statements` does it.
  const blocks: { from: number; body: string }[] = [];
  if (language === "javascript") {
    let at = 0;
    for (const body of text.split("\n\n")) {
      blocks.push({ from: at, body });
      at += body.length + 2;
    }
  } else {
    blocks.push({ from: 0, body: text });
  }

  for (const { from, body } of blocks) {
    const masked = blankQuotedAndComments(body);
    let start = 0;
    for (let index = 0; index <= masked.length; index += 1) {
      // Boundaries come from the masked copy, so a `;` inside a literal or a comment doesn't split
      // one. It keeps the original's length, so the offsets index both strings.
      if (index !== masked.length && masked[index] !== ";") continue;
      const isCode = masked.slice(start, index).trim().length > 0;
      if (isCode) push(from + start, from + index);
      start = index + 1;
    }
  }
  return out;
}

/**
 * The statement the caret is in — what ⌘↵ runs when nothing is selected.
 *
 * Inside a statement (or right after its `;` on the same line) it is that one. In the gap between
 * two, the one that ends on the caret's line or the line above wins over the next — the caret sits
 * where you stopped typing, under what you just wrote — and failing that the nearest one.
 */
export function statementAt(text: string, offset: number, language: ConsoleLanguage): StatementRange | null {
  const ranges = statementRanges(text, language);
  if (ranges.length === 0) return null;
  const inside = ranges.find((range) => offset >= range.start && offset <= range.end);
  if (inside) return inside;
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const caretLine = lineOf(offset);
  const before = [...ranges].reverse().find((range) => range.end <= offset);
  if (before && caretLine - lineOf(before.end) <= 1) return before;
  const after = ranges.find((range) => range.start >= offset);
  if (!before) return after ?? null;
  if (!after) return before;
  return offset - before.end <= after.start - offset ? before : after;
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
