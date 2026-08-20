/**
 * Tidying a DBML document, in place.
 *
 * # Why this is textual rather than a re-emit of the parsed model
 *
 * The obvious formatter parses the document and prints the model back out. It is also the wrong
 * one: the model does not carry comments, blank lines, the order settings were written in, or the
 * shape of a multi-line note — so "format" would quietly delete a third of what somebody wrote.
 * This one never throws anything away. It re-indents, aligns and normalises the separators of the
 * lines it *recognises*, and copies every line it does not verbatim. A document with a syntax error
 * in it still formats, which matters because that is exactly when people press the button.
 *
 * # What "formatted" means here
 *
 * - Two-space indentation inside a block, four inside `indexes`.
 * - The columns of one table aligned with each other: name, type, then settings. Alignment is per
 *   table, never document-wide — one 40-character column name in one table should not push every
 *   other table's types across the screen.
 * - Settings normalised to `[pk, not null, default: 'x']`: one space after each comma, none inside
 *   the brackets, and the settings themselves untouched otherwise.
 * - Exactly one blank line between blocks, none at the top, one newline at the end.
 * - Comments, notes and anything unrecognised preserved as written.
 *
 * It is **idempotent**: formatting formatted output returns it unchanged. That is the property that
 * makes it safe to run on every save, and the one a naive aligner loses first.
 */

/** Past this, one long name stops being a column to align to and starts being a hole in the page. */
const MAX_NAME_PAD = 28;
const MAX_TYPE_PAD = 22;

const INDENT = "  ";

export function formatDbml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  /** Where we are: the top level, inside a block, or inside an `indexes { }` within one. */
  let depth = 0;
  /** The unclosed triple-quoted note delimiter, or `null`. Everything inside one is copied as-is. */
  let inNote: string | null = null;
  /**
   * The lines of the block being read, held back until its `}` so they can be aligned together.
   *
   * `verbatim` marks the inside of a multi-line note. Those lines are prose, and prose is shaped
   * like a column often enough to matter — `  keep   this` parses as a name and a type, and comes
   * out of the aligner with its spacing rewritten. Marking them is what stops the formatter from
   * editing the contents of a note.
   */
  let block: { text: string; verbatim: boolean }[] = [];

  const flushBlock = () => {
    if (block.length > 0) {
      out.push(...alignBlock(block));
      block = [];
    }
  };

  /** Adds a line to the block being read, or straight to the output at the top level. */
  const emit = (text: string, verbatim = false) => {
    if (depth > 0) block.push({ text, verbatim });
    else out.push(text);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();

    // Inside a multi-line note the document is not DBML, it is prose. Not re-indented: the
    // whitespace in a note is the author's and shows up in whatever reads the note later.
    if (inNote !== null) {
      emit(line, true);
      if (trimmed.includes(inNote)) inNote = null;
      continue;
    }
    const noteOpen = trimmed.match(/(''')|(""")/);
    if (noteOpen && !isClosedNote(trimmed)) {
      inNote = noteOpen[0];
      emit(depth > 0 ? indent(depth) + trimmed : trimmed, true);
      continue;
    }

    if (trimmed === "") {
      // Blank lines are kept inside a block — people group columns with them — but collapsed, and
      // never left leading or trailing. At the top level they are dropped entirely: the spacing
      // between blocks is decided below, so keeping these too would double it.
      if (depth > 0 && block.length > 0 && block[block.length - 1].text !== "") {
        block.push({ text: "", verbatim: false });
      }
      continue;
    }

    if (trimmed === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        flushBlock();
        out.push("}");
        out.push("");
      } else {
        block.push({ text: indent(depth) + "}", verbatim: false });
      }
      continue;
    }

    // An `indexes {` (or any other nested opener) inside a block.
    if (depth > 0) {
      // Pushed as written. Settings are normalised in `alignBlock`, which is the only place that
      // knows whether this line is a column — and a column's `[` is not always a settings bracket:
      // `meta json[]` ends in one that belongs to the *type*, and normalising it here turned the
      // array marker into an empty settings list.
      block.push({ text: indent(depth) + trimmed, verbatim: false });
      if (opensBlock(trimmed)) depth += 1;
      continue;
    }

    // Top level.
    if (opensBlock(trimmed)) {
      out.push(normaliseHeader(trimmed));
      depth = 1;
      continue;
    }
    // A standalone `Ref:`, a `//` comment, a `Project` one-liner — anything that is its own line.
    out.push(normaliseLine(trimmed));
    if (isRef(trimmed)) out.push("");
  }

  flushBlock();

  // One trailing newline, no leading blank, and never two blanks in a row — the last of which can
  // only happen where a comment sat between two blocks.
  const tidied: string[] = [];
  for (const line of out) {
    if (line === "" && (tidied.length === 0 || tidied[tidied.length - 1] === "")) continue;
    tidied.push(line);
  }
  while (tidied.length > 0 && tidied[tidied.length - 1] === "") tidied.pop();
  // An empty document formats to an empty document, not to a newline: this runs on save, and a
  // blank diagram that grows a byte every time it is opened is a diagram that is never clean.
  return tidied.length === 0 ? "" : tidied.join("\n") + "\n";
}

function indent(depth: number): string {
  return INDENT.repeat(depth);
}

/** A line that opens a `{ … }` block, as opposed to one that opens and closes it on itself. */
function opensBlock(line: string): boolean {
  const opens = (line.match(/\{/g) ?? []).length;
  const closes = (line.match(/\}/g) ?? []).length;
  return opens > closes;
}

function isRef(line: string): boolean {
  return /^ref\b/i.test(line);
}

/** Whether a line's triple quotes open *and* close on it, which is not a multi-line note at all. */
function isClosedNote(line: string): boolean {
  const single = (line.match(/'''/g) ?? []).length;
  const double = (line.match(/"""/g) ?? []).length;
  return single % 2 === 0 && double % 2 === 0;
}

/** `Table  users   as  U {` → `Table users as U {`. Keywords keep their case; names keep theirs. */
function normaliseHeader(line: string): string {
  return line.replace(/\s+/g, " ").replace(/\s*\{$/, " {");
}

/**
 * A line that is not a field: a `Ref:`, a `Note:`, a comment, an `indexes {`.
 *
 * Only the settings brackets are touched, because that is the one piece of punctuation this
 * formatter has an opinion about. Everything else on such a line is the author's.
 */
function normaliseLine(line: string): string {
  const settings = line.match(/\[([\s\S]*)\]\s*$/);
  if (!settings || /^\/\//.test(line)) return line;
  const head = line.slice(0, settings.index).replace(/\s+$/, "");
  return `${head} ${normaliseSettings(settings[1])}`;
}

/**
 * `[ pk,not null ]` → `[pk, not null]`.
 *
 * Split at the top level only: a `note: 'a, b'` and a `default: fn(1, 2)` both carry commas that
 * are not separators, and a naive `split(",")` turns either into two broken settings.
 */
function normaliseSettings(body: string): string {
  const parts: string[] = [];
  let current = "";
  let depthParen = 0;
  let quote: string | null = null;
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (quote) {
      current += char;
      if (char === quote && body[at - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depthParen += 1;
    if (char === ")") depthParen = Math.max(0, depthParen - 1);
    if (char === "," && depthParen === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return `[${parts.filter(Boolean).join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

interface Column {
  name: string;
  type: string;
  settings: string;
  /** A trailing `// …`, kept and re-attached after the alignment padding. */
  comment: string;
  indent: string;
}

/**
 * Aligns the field lines of one block and leaves everything else in it alone.
 *
 * The padding is computed from the *fields at the same indent*, so an `indexes` block nested inside
 * a table does not drag the table's own columns out to meet it.
 */
function alignBlock(lines: { text: string; verbatim: boolean }[]): string[] {
  const parsed = lines.map(({ text, verbatim }) => ({
    line: text,
    field: verbatim ? null : splitField(text),
    verbatim,
  }));

  const widths = new Map<string, { name: number; type: number }>();
  for (const { field } of parsed) {
    if (!field) continue;
    const current = widths.get(field.indent) ?? { name: 0, type: 0 };
    widths.set(field.indent, {
      name: Math.max(current.name, Math.min(field.name.length, MAX_NAME_PAD)),
      type: Math.max(current.type, Math.min(field.type.length, MAX_TYPE_PAD)),
    });
  }

  return parsed.map(({ line, field, verbatim }) => {
    if (verbatim) return line;
    // Not a column: an `indexes {`, a `Note:`, a comment, a blank. Its settings — an index has
    // them — are still tidied, but nothing about it is aligned.
    if (!field) return normaliseLine(line);
    const width = widths.get(field.indent) ?? { name: 0, type: 0 };
    // `padEnd` is a no-op for anything past the cap, so a long name simply pushes its own type one
    // space along instead of everyone else's.
    const name = field.type ? field.name.padEnd(width.name) : field.name;
    const type = field.settings || field.comment ? field.type.padEnd(width.type) : field.type;
    const parts = [name, type, field.settings].filter((part) => part.length > 0);
    const body = parts.join(" ").replace(/\s+$/, "");
    return `${field.indent}${body}${field.comment ? `  ${field.comment}` : ""}`;
  });
}

/**
 * A field line as its three pieces, or `null` when the line is something else.
 *
 * Hand-written rather than a regular expression because the type can carry parentheses
 * (`decimal(10,2)`), brackets (`text[]`) and quotes (`"user defined"`), and the settings are
 * bracketed too — telling `varchar(100)[]` from `varchar(100) [pk]` is a scan, not a pattern.
 */
function splitField(line: string): Column | null {
  const indentMatch = line.match(/^\s*/);
  const lead = indentMatch ? indentMatch[0] : "";
  let rest = line.slice(lead.length);
  if (!rest || rest.startsWith("//") || rest.startsWith("}") || opensBlock(rest)) return null;
  if (/^(note|indexes|ref|primary key)\b/i.test(rest)) return null;

  const name = readToken(rest);
  if (!name) return null;
  rest = rest.slice(name.length).trimStart();
  if (!rest) return null;

  const type = readType(rest);
  if (!type) return null;
  rest = rest.slice(type.length).trimStart();

  let settings = "";
  if (rest.startsWith("[")) {
    const close = matchingBracket(rest);
    if (close === -1) return null;
    settings = normaliseSettings(rest.slice(1, close));
    rest = rest.slice(close + 1).trimStart();
  }

  const comment = rest.startsWith("//") ? rest : "";
  // Anything else left over means this line is not the simple `name type [settings]` this can
  // safely rearrange, so it is copied instead.
  if (rest && !comment) return null;
  return { name, type, settings, comment, indent: lead };
}

/** A quoted or bare identifier at the head of `text`, as written. */
function readToken(text: string): string {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    const end = text.indexOf(quote, 1);
    return end === -1 ? "" : text.slice(0, end + 1);
  }
  const match = text.match(/^[A-Za-z_][\w.]*/);
  return match ? match[0] : "";
}

/** A type, arguments and array marker included: `varchar(100)`, `decimal(10,2)`, `text[]`. */
function readType(text: string): string {
  const base = readToken(text);
  if (!base) return "";
  let at = base.length;
  if (text[at] === "(") {
    let depth = 0;
    while (at < text.length) {
      if (text[at] === "(") depth += 1;
      if (text[at] === ")") {
        depth -= 1;
        at += 1;
        if (depth === 0) break;
        continue;
      }
      at += 1;
    }
  }
  // An array marker, which is the one case where `[` does not begin the settings.
  if (text.slice(at, at + 2) === "[]") at += 2;
  return text.slice(0, at);
}

/** The index of the `]` that closes the `[` at position 0, or -1. Quote-aware. */
function matchingBracket(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (char === quote && text[at - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}
