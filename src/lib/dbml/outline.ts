/**
 * What a DBML document declares, read without parsing it.
 *
 * # Why not `parseDbml`
 *
 * Two reasons, and the second is the one that matters.
 *
 * `@dbml/core` is ~15 MB and arrives through a deliberate `import()` — `lib/dbml/index.ts` must
 * never re-export `parse.ts`, or the whole parser lands in the startup bundle and nothing visibly
 * breaks. This runs inside a Monaco completion provider, which is registered at startup and asked
 * on a keystroke, so it cannot be the thing that drags the parser in.
 *
 * The real reason is that **a document being completed is a document mid-sentence**. The parser
 * answers all-or-nothing: one unclosed brace and it throws, and the schema the editor holds goes
 * empty. That is exactly the state you are in while typing the table you want completions for. A
 * scan that reads what it recognises and skips what it does not keeps answering right up to the
 * caret, which is the only place the answer is wanted.
 *
 * So this is regex over lines, in the same spirit as `format.ts` (which formats a document with a
 * syntax error in it, because that is when people press the button) and `merge.ts` (whose
 * `declaredNames` is the same idea at a quarter of the size).
 *
 * # What it deliberately does not do
 *
 * No settings, no notes, no cardinality, no `Ref:` lines, no groups. This exists to answer "what may
 * I type here" — table names, their column names, the enums in scope — and every field it does not
 * carry is a field nothing has asked it for. The canvas and the inspector read the real parse.
 */

/** One column, as much of it as a completion list needs. */
export interface OutlineColumn {
  name: string;
  /** `""` when the line names no type — a half-typed column, which is the common case here. */
  type: string;
}

export interface OutlineTable {
  /** As written, minus quotes. May be `schema.name`. */
  name: string;
  /** The `as` alias, which is a legal way to name this table in a `Ref:`. */
  alias: string | null;
  columns: OutlineColumn[];
}

export interface DbmlOutline {
  tables: OutlineTable[];
  enums: string[];
  /**
   * The table whose block was still open when the scan ran out of text, or `null`.
   *
   * This is the "where am I" half, and it falls out of the scan for free — it is the block variable
   * at the moment the loop ends. Deriving it afterwards from "the last table, if the braces don't
   * balance" is the obvious version and it is wrong: a caret inside an `Enum` that follows a table
   * leaves the braces unbalanced too, and that rule would answer with the table above it.
   */
  open: OutlineTable | null;
}

const EMPTY: DbmlOutline = { tables: [], enums: [], open: null };

/** `Table "my table" as t {` / `Enum status {` / `TableGroup x {`. */
const DECLARATION = /^(table|enum|tablegroup|project|tablepartial)\s+("[^"]*"|[\w.]+)(?:\s+as\s+("[^"]*"|[\w.]+))?/i;

/** A column line: a name, then a type, then whatever settings follow. */
const COLUMN = /^("[^"]*"|[\w]+)(?:\s+("[^"]*"|[\w]+(?:\s*\([^)]*\))?(?:\s*\[\s*\])?))?/;

/** Lines that open a nested block inside a table and are not columns. */
const NESTED = /^(indexes|note)\b/i;

function unquote(text: string): string {
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/**
 * Scans `source` for its tables, their columns and its enums.
 *
 * Brace depth rather than a grammar, exactly like `merge.ts`'s block splitter: depth 1 inside a
 * declaration is where columns live, and anything deeper is an `indexes` or a note block whose
 * lines are not columns. A trailing unclosed block — the one being typed — is kept, because it is
 * the one being completed.
 */
export function outlineOf(source: string): DbmlOutline {
  if (!source) return EMPTY;

  const tables: OutlineTable[] = [];
  const enums: string[] = [];

  let depth = 0;
  /** The table being read, or `null` when the open block is an enum, a group or nothing. */
  let current: OutlineTable | null = null;
  /**
   * Inside a `'''…'''` note, whose lines are prose and must not be read as columns.
   *
   * Toggled at the *end* of a line rather than the start, and counted rather than tested for
   * presence. Both matter: the line that opens a block note is `note: '''`, which is also the line
   * that must still be seen as an ordinary `note` line, and a line holding two delimiters
   * (`note: '''one line'''`) opens and closes in place and must not toggle anything.
   */
  let inNote = false;

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    /** Odd means this line changes the note state; even means it opened and closed, or neither. */
    const toggles = line.split("'''").length % 2 === 0;

    if (inNote) {
      if (toggles) inNote = false;
      continue;
    }
    if (!line || line.startsWith("//")) continue;
    // Block comments are skipped a line at a time rather than tracked: a `/* … */` spanning lines
    // can only cost this a few phantom columns in a document nobody is completing inside.
    if (line.startsWith("/*") || line.startsWith("*")) {
      if (toggles) inNote = true;
      continue;
    }

    if (depth === 0) {
      const declared = DECLARATION.exec(line);
      if (declared) {
        const kind = declared[1].toLowerCase();
        const name = unquote(declared[2]);
        if (kind === "table" || kind === "tablepartial") {
          current = { name, alias: declared[3] ? unquote(declared[3]) : null, columns: [] };
          tables.push(current);
        } else {
          if (kind === "enum") enums.push(name);
          current = null;
        }
        // A declaration whose `{` is on the next line still opens on that brace, so depth is
        // counted from the braces on the line rather than assumed from the keyword.
        depth += countBraces(line);
      } else {
        depth = Math.max(0, depth + countBraces(line));
      }
      if (toggles) inNote = true;
      continue;
    }

    const before = depth;
    depth = Math.max(0, depth + countBraces(line));
    if (toggles) inNote = true;
    if (depth === 0) {
      current = null;
      continue;
    }

    // Only depth 1 holds columns. `indexes { … }` and a note block sit at 2.
    if (current && before === 1 && !NESTED.test(line)) {
      const column = COLUMN.exec(line);
      if (column) {
        const name = unquote(column[1]);
        // `}` and settings-only continuations are not columns, and neither is a repeat.
        if (name && !current.columns.some((entry) => entry.name === name)) {
          current.columns.push({ name, type: column[2] ? unquote(column[2].trim()) : "" });
        }
      }
    }
  }

  return { tables, enums, open: depth > 0 ? current : null };
}

function countBraces(line: string): number {
  let count = 0;
  let inString: string | null = null;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (inString) {
      if (char === inString) inString = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") inString = char;
    else if (char === "{") count += 1;
    else if (char === "}") count -= 1;
  }
  return count;
}

/**
 * The table the caret is inside, or `null`.
 *
 * Scans the document down to `lineNumber` and reads `open` off the result, so "inside a table" and
 * "inside the enum below it" cannot be confused for each other. `lineNumber` is Monaco's, i.e.
 * 1-based and inclusive of the line the caret is on.
 */
export function tableAtLine(source: string, lineNumber: number): OutlineTable | null {
  return outlineOf(source.split("\n").slice(0, lineNumber).join("\n")).open;
}
