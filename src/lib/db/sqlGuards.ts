/**
 * The checks a console runs *before* sending a statement.
 *
 * There is one, and it earns its place: a `DELETE` or an `UPDATE` with no `WHERE` is a single
 * keystroke away from the one with a `WHERE`, and it rewrites the whole table instead of a row. Most
 * mistakes a console can make are visible (you read the rows that came back) or recoverable; these
 * two are neither. A `DELETE` takes the rows with it. An `UPDATE` is no more reversible — it
 * *overwrites*: after `UPDATE users SET email = 'x'` the old values are gone just as surely, it only
 * looks gentler because the rows are still there. This file used to exempt `UPDATE` on the grounds
 * that it could be inverted; it cannot, without the values it replaced.
 *
 * What it does about them is ask, naming the statement: the answer has to be given against the text
 * that is about to run, not against a generic warning. It used to refuse outright and make the user
 * write `WHERE 1=1`, which protected nothing — people typed it and moved on — and left a rewritten
 * statement in the history that no longer said what they had meant.
 *
 * The analysis is syntactic and conservative: comments and string literals are blanked first (so a
 * `--` or a `'…WHERE…'` can neither hide a verb nor fake a `WHERE`), and a `WHERE` only counts at the
 * statement's own nesting level — the one inside `SET a = (SELECT … WHERE …)` filters the subquery,
 * not the rows being updated. A verb counts wherever it starts a statement, which includes the body
 * of a `WITH d AS (DELETE …)` and the statement after the CTEs. It is not a SQL parser and doesn't
 * try to be: a false alarm costs one click, and the failure it prevents is a table.
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

/** One word or bracket of a masked statement, with where it sits. */
interface GuardWord {
  /** Upper-cased word, or `(`, `)`, `;`. */
  text: string;
  /** Parenthesis depth: 0 at the statement's own level. */
  depth: number;
  /** Offset into the masked (and therefore the original) text. */
  at: number;
}

function guardWords(masked: string): GuardWord[] {
  const words: GuardWord[] = [];
  let depth = 0;
  const pattern = /[A-Za-z_][A-Za-z0-9_$#@]*|[();]/g;
  for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
    const text = match[0].toUpperCase();
    if (text === "(") {
      words.push({ text, depth, at: match.index });
      depth += 1;
    } else if (text === ")") {
      depth = Math.max(0, depth - 1);
      words.push({ text, depth, at: match.index });
    } else {
      words.push({ text, depth, at: match.index });
    }
  }
  return words;
}

/** What `unguardedWrite` found: the verb, and the statement it belongs to (trimmed, and shortened
 *  when long) so the question can quote it. */
export interface UnguardedWrite {
  verb: "DELETE" | "UPDATE";
  statement: string;
}

/**
 * Every `DELETE` and `UPDATE` in `sql` that has no `WHERE` of its own, in order.
 *
 * Several statements can be in the box and several can be unguarded; the question names each one,
 * because "one of these has no WHERE" is not something anyone can answer.
 */
export function unguardedWrites(sql: string): UnguardedWrite[] {
  const masked = blankQuotedAndComments(sql);
  const found: UnguardedWrite[] = [];
  let start = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    // Statement boundaries come from the masked text, so a `;` inside a literal doesn't split one.
    if (index !== masked.length && masked[index] !== ";") continue;
    const maskedStatement = masked.slice(start, index);
    const original = sql.slice(start, index).trim();
    start = index + 1;
    const words = guardWords(maskedStatement);
    words.forEach((word, position) => {
      const verb = word.text;
      if (verb !== "DELETE" && verb !== "UPDATE") return;
      // A verb only where a statement can begin: first, after `(` (a CTE body or a subquery), or
      // after `)` (the statement that follows a `WITH` list, or the next one in a T-SQL batch).
      // That is what keeps `FOR UPDATE`, `ON DELETE CASCADE`, `ON CONFLICT DO UPDATE` and `MERGE …
      // THEN DELETE` — all scoped by something other than a `WHERE` — from reading as unguarded.
      const previous = words[position - 1]?.text;
      if (position > 0 && previous !== "(" && previous !== ")") return;
      for (const later of words.slice(position + 1)) {
        if (later.depth < word.depth) break;
        if (later.depth !== word.depth) continue;
        if (later.text === "WHERE") return;
        // The next statement of a batch — its `WHERE` is not this one's.
        if (["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(later.text)) break;
      }
      const shown = original.length > 160 ? `${original.slice(0, 160)}…` : original;
      found.push({ verb, statement: shown });
    });
  }
  return found;
}

/**
 * The first `DELETE` in `sql` that has no `WHERE`, or `null` when there is none. Kept for the
 * callers that only ever asked about deletes; `unguardedWrites` is the whole answer.
 */
export function unguardedDelete(sql: string): string | null {
  return unguardedWrites(sql).find((write) => write.verb === "DELETE")?.statement ?? null;
}
