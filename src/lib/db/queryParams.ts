import { blankQuotedAndComments } from "./sqlGuards";

/**
 * Placeholders in a console statement, filled in before it is sent.
 *
 * Every value crosses to the backend as text and there is no parameter binding (see the database
 * workspace's first invariant), so "parameters" here are a console convenience: the placeholders
 * are found, a dialog asks for each value, and the statement is sent with the values written in as
 * literals. Three spellings, the ones people bring from other tools:
 *
 * - `:name` — DataGrip, Oracle, JDBC named. Not `::type` (a Postgres cast) and not `:=`.
 * - `${name}` — DBeaver and shell scripts.
 * - `?` — positional, one prompt per occurrence. SQL only: in a Mongo or Redis buffer `?` means
 *   nothing special and is left alone.
 *
 * Found on the masked text, so a placeholder-looking run inside a string literal or a comment —
 * `'10:30'`, `-- why?` — is never one.
 */
export interface QueryParam {
  /** `name` for the named spellings, `?1`, `?2`… for the positional ones. */
  key: string;
  /** How it is written, for the dialog's label. */
  token: string;
}

interface Occurrence {
  key: string;
  start: number;
  end: number;
}

function occurrences(sql: string, positional: boolean): Occurrence[] {
  const masked = blankQuotedAndComments(sql);
  const found: Occurrence[] = [];
  const pattern = /\$\{([A-Za-z_][\w.]*)\}|(?<![:\w]):([A-Za-z_]\w*)|\?/g;
  let ordinal = 0;
  for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
    if (match[1]) found.push({ key: match[1], start: match.index, end: match.index + match[0].length });
    else if (match[2]) {
      // `:=` is assignment (PL/SQL, MySQL variables); `a ? b` inside a Postgres JSON operator
      // (`?|`, `?&`, `jsonb ? 'key'`) is an operator, not a placeholder.
      found.push({ key: match[2], start: match.index, end: match.index + match[0].length });
    } else if (positional) {
      const next = masked[match.index + 1] ?? "";
      const prev = masked.slice(0, match.index).trimEnd().slice(-1);
      if (next === "|" || next === "&" || /[\w)'"]/.test(prev)) continue;
      ordinal += 1;
      found.push({ key: `?${ordinal}`, start: match.index, end: match.index + 1 });
    }
  }
  return found;
}

/** The distinct placeholders in `sql`, in the order they first appear. */
export function findParams(sql: string, language: "sql" | "javascript" | "redis"): QueryParam[] {
  if (language === "redis") return [];
  const seen = new Map<string, QueryParam>();
  for (const occurrence of occurrences(sql, language === "sql")) {
    if (seen.has(occurrence.key)) continue;
    seen.set(occurrence.key, { key: occurrence.key, token: sql.slice(occurrence.start, occurrence.end) });
  }
  return [...seen.values()];
}

/** A value as the dialog collected it: what was typed, and whether to write it in unquoted. */
export interface ParamValue {
  value: string;
  raw: boolean;
}

/**
 * The literal a typed value becomes. Numbers, `NULL`, `TRUE`/`FALSE` go in as they are; anything
 * else is quoted with its quotes doubled. `raw` skips all of that — for a list (`1, 2, 3`), a
 * function call, a column name.
 */
export function literalFor(input: ParamValue, language: "sql" | "javascript" | "redis"): string {
  const value = input.value;
  if (input.raw) return value;
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return trimmed;
  if (/^(null|true|false)$/i.test(trimmed)) return language === "javascript" ? trimmed.toLowerCase() : trimmed.toUpperCase();
  if (language === "javascript") return JSON.stringify(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/** `sql` with every placeholder replaced by its value's literal. */
export function fillParams(
  sql: string,
  values: Record<string, ParamValue>,
  language: "sql" | "javascript" | "redis",
): string {
  if (language === "redis") return sql;
  let out = "";
  let at = 0;
  for (const occurrence of occurrences(sql, language === "sql")) {
    const value = values[occurrence.key];
    if (!value) continue;
    out += sql.slice(at, occurrence.start) + literalFor(value, language);
    at = occurrence.end;
  }
  return out + sql.slice(at);
}
