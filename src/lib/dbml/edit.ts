import { blocksOf, braceDelta, findBlock, type DbmlBlock } from "./blocks";

/**
 * Changing a DBML document without rewriting it.
 *
 * # Why every operation here is textual
 *
 * The obvious way to implement "add a column" is to change the parsed schema and print it back out.
 * It is also impossible here, for a reason that is a property of the model rather than of this
 * code: **`DbmlSchema` carries no source positions**, and it does not carry comments, blank lines,
 * the order settings were written in, or the shape of a multi-line note either. Printing it back
 * would mean every click that adds a column silently reformats the whole document and deletes a
 * third of what the author wrote.
 *
 * That is the same conclusion `format.ts` reached — its header says the model "does not carry
 * comments, blank lines, the order settings were written in, or the shape of a multi-line note, so
 * 'format' would quietly delete a third of what somebody wrote" — and it applies with more force
 * here, because formatting is something you ask for and adding a column is not.
 *
 * So each function below is `(source, …) => source`: it locates the lines it must change with
 * `blocksOf`, rewrites exactly those, and copies every other byte. The property the tests hold it
 * to is that **the document outside the edited region comes back byte for byte identical**.
 *
 * # What "source" means here
 *
 * The DBML *without* the trailing `// codeflow:layout {…}` comment. Callers split it off with
 * `readLayout` and put it back with `writeLayout`; nothing in this file knows the comment exists,
 * which is what keeps a column edit from ever disturbing the dragged box positions.
 *
 * # Indentation
 *
 * New lines are emitted the way `formatDbml` would leave them — two spaces inside a block — but the
 * document is never reformatted as a side effect. A schema the author has laid out by hand stays
 * laid out by hand; the Format button is still the only thing that touches lines nobody edited.
 */

/** What `formatDbml` indents a block's contents by, restated so an insert matches a tidy file. */
const INDENT = "  ";

/** A column, as the inspector's form collects it. */
export interface FieldEdit {
  name: string;
  type: string;
  pk?: boolean;
  unique?: boolean;
  notNull?: boolean;
  increment?: boolean;
  /** Written verbatim into `[default: …]`. Already quoted or backticked by the caller. */
  default?: string | null;
  note?: string | null;
}

/** One end of a relationship. */
export interface RefEnd {
  table: string;
  column: string;
}

export type Cardinality = "<" | ">" | "-" | "<>";

// ---- helpers ---------------------------------------------------------------

/**
 * `base`, or `base_2`, `base_3`… — the first form `taken` does not already hold.
 *
 * DBML rejects a document with two tables of the same name outright, and the same goes for two
 * columns in one table: the parse fails, the canvas goes blank, and what the user did to cause it
 * was press "Add table" twice. `merge.ts` learned this for generated schemas — its header says
 * appending blindly "does not produce a messy schema, it produces one that will not parse at all" —
 * and a button that adds a default-named thing is the same hazard with a shorter fuse.
 *
 * Compared case-insensitively because that is how DBML compares them.
 */
export function freeName(taken: Iterable<string>, base: string): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** DBML needs quotes only when the name is not a bare identifier. */
export function quoteName(name: string): string {
  return /^[A-Za-z_]\w*$/.test(name) ? name : `"${name}"`;
}

/** `schema.table` stays two quoted halves, not one quoted string containing a dot. */
function quotePath(name: string): string {
  return name.split(".").map(quoteName).join(".");
}

/** A `'…'` string with the quotes DBML uses and the escape it needs. */
function quoteText(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The settings list for a column, in the order DBML documents them. `""` when there are none. */
function settingsOf(field: FieldEdit): string {
  const parts: string[] = [];
  if (field.pk) parts.push("pk");
  if (field.increment) parts.push("increment");
  if (field.unique && !field.pk) parts.push("unique");
  if (field.notNull && !field.pk) parts.push("not null");
  if (field.default !== undefined && field.default !== null && field.default !== "") {
    parts.push(`default: ${field.default}`);
  }
  if (field.note) parts.push(`note: ${quoteText(field.note)}`);
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

/**
 * One column line, indented and settled.
 *
 * A column with no type is not legal DBML — the parser reads the next line's first word as this
 * column's type and unravels from there — so the type is required rather than optional. The callers
 * that could supply an empty one (the inspector's form) refuse before getting here; this is the
 * backstop, and `addField`/`updateField` decline the edit rather than emit the broken line.
 */
export function fieldLine(field: FieldEdit, indent = INDENT): string {
  return `${indent}${quoteName(field.name)} ${field.type.trim()}${settingsOf(field)}`;
}

/** A column the document can actually hold: it needs both halves. */
function usable(field: FieldEdit): boolean {
  return field.name.trim().length > 0 && field.type.trim().length > 0;
}

/** Splices `replacement` in for lines `[from, to)`, leaving every other byte alone. */
function splice(source: string, from: number, to: number, replacement: string[]): string {
  const lines = source.split("\n");
  lines.splice(from, to - from, ...replacement);
  return lines.join("\n");
}

/**
 * The lines of a block that are its *contents*, as a half-open range.
 *
 * The declaration line and the closing brace are excluded, so an insert at `end` lands as the last
 * column rather than after the `}`. A block still being typed has no closing brace, and then `end`
 * is the end of the block — which is where a new line belongs anyway.
 */
function bodyRange(source: string, block: DbmlBlock): { start: number; end: number } {
  const lines = source.split("\n");
  let start = block.from;
  let depth = 0;
  // The `{` may be on the declaration line or on one after it.
  for (let at = block.from; at < block.to; at += 1) {
    depth += braceDelta(lines[at]);
    if (depth > 0) {
      start = at + 1;
      break;
    }
  }
  let end = block.to;
  for (let at = block.to - 1; at >= start; at -= 1) {
    if (lines[at].trim().startsWith("}")) {
      end = at;
      break;
    }
  }
  return { start, end: Math.max(start, end) };
}

/** The indentation the block's own lines use, so an insert matches its neighbours. */
function indentOf(source: string, block: DbmlBlock): string {
  const lines = source.split("\n");
  const { start, end } = bodyRange(source, block);
  for (let at = start; at < end; at += 1) {
    const match = /^[ \t]+/.exec(lines[at]);
    if (match && lines[at].trim()) return match[0];
  }
  return INDENT;
}

/**
 * The line inside `block` that declares column `name`, or `-1`.
 *
 * Depth-aware: a name that also appears inside the block's `indexes { … }` is not that column's
 * declaration, and matching it would rewrite an index when asked to rewrite a field.
 */
function fieldLineIn(source: string, block: DbmlBlock, name: string): number {
  const lines = source.split("\n");
  const { start, end } = bodyRange(source, block);
  const wanted = name.toLowerCase();
  let depth = 0;
  for (let at = start; at < end; at += 1) {
    const text = lines[at].trim();
    const here = depth;
    depth += braceDelta(lines[at]);
    if (here !== 0 || !text || text.startsWith("//")) continue;
    const declared = /^("[^"]*"|[\w]+)/.exec(text);
    if (!declared) continue;
    const found = declared[1].replace(/^"|"$/g, "").toLowerCase();
    // `note:` and `indexes` open blocks of their own and are not columns.
    if (found === "note" || found === "indexes") continue;
    if (found === wanted) return at;
  }
  return -1;
}

/** Appends a top-level block, separated by one blank line, with the trailing newline preserved. */
function append(source: string, text: string): string {
  const trimmed = source.replace(/\s+$/, "");
  const tail = /\n\s*$/.test(source) ? "\n" : "";
  return trimmed ? `${trimmed}\n\n${text}\n${tail}` : `${text}\n${tail}`;
}

// ---- tables ----------------------------------------------------------------

/** A new table with one primary key, appended at the end of the document. */
export function addTable(source: string, name: string): string {
  return append(
    source,
    [`Table ${quotePath(name)} {`, `${INDENT}id integer [pk, increment]`, "}"].join("\n"),
  );
}

/**
 * Renames a table, and every `Ref:` that names it.
 *
 * The refs are the whole reason this is not a text replace: renaming `orders` by replacing the word
 * would also rewrite a column called `orders`, a note that mentions one, and the word inside
 * `order_items`. Each site is found structurally instead — the declaration from `blocksOf`, the
 * endpoints from the `Ref` lines' own shape.
 */
export function renameTable(source: string, from: string, to: string): string {
  const blocks = blocksOf(source);
  const block = findBlock(blocks, from, "table") ?? findBlock(blocks, from, "enum");
  if (!block) return source;

  const lines = source.split("\n");
  // The declaration: replace only the name token, so `as`, the settings and any trailing comment
  // survive exactly as written.
  lines[block.from] = lines[block.from].replace(
    /^(\s*(?:table|enum|tablepartial)\s+)("[^"]*"|[\w.]+)/i,
    (_all, head: string) => `${head}${quotePath(to)}`,
  );

  const source2 = lines.join("\n");
  return rewriteRefEndpoints(source2, block.name, to);
}

/** Removes a table and every relationship that mentions it. */
export function dropTable(source: string, name: string): string {
  const blocks = blocksOf(source);
  const block = findBlock(blocks, name, "table") ?? findBlock(blocks, name, "enum");
  if (!block) return source;

  const withoutRefs = dropRefsTouching(source, block.name, block.alias);
  const after = blocksOf(withoutRefs);
  const target = findBlock(after, name, block.kind);
  if (!target) return withoutRefs;
  return trimBlank(splice(withoutRefs, target.from, target.to, []));
}

/** Sets, replaces or clears a table's `note`. */
export function setTableNote(source: string, name: string, note: string): string {
  const block = findBlock(blocksOf(source), name, "table");
  if (!block) return source;

  const lines = source.split("\n");
  const { start, end } = bodyRange(source, block);
  const indent = indentOf(source, block);

  let at = -1;
  let stop = -1;
  let depth = 0;
  for (let line = start; line < end; line += 1) {
    const text = lines[line].trim();
    const here = depth;
    depth += braceDelta(lines[line]);
    if (here !== 0) continue;
    if (/^note\s*:/i.test(text)) {
      at = line;
      // A `'''` note runs until its closing delimiter; a `'…'` one ends on its own line.
      if (text.includes("'''") && text.split("'''").length % 2 === 0) {
        for (let scan = line + 1; scan < end; scan += 1) {
          if (lines[scan].includes("'''")) {
            stop = scan + 1;
            break;
          }
        }
      }
      if (stop < 0) stop = line + 1;
      break;
    }
  }

  const written = note.trim()
    ? [
        note.includes("\n")
          ? `${indent}note: '''\n${note
              .split("\n")
              .map((line) => `${indent}${line}`)
              .join("\n")}\n${indent}'''`
          : `${indent}note: ${quoteText(note)}`,
      ]
    : [];

  if (at >= 0) return splice(source, at, stop, written);
  if (written.length === 0) return source;

  // A *new* note goes at the end of the block, never at the start.
  //
  // This is not a matter of taste. `@dbml/core` accepts `note:` inside a table only once every
  // column has been declared — measured against the bundled parser: note-last parses, note-first and
  // note-between-two-columns both fail with `Expected " " but ":" found`, because the parser reads
  // `note` as a column name and then wants a type. Inserting at `start` (which is what this did)
  // produced a document that would not parse from a button whose whole job is to be safe to press.
  //
  // After `indexes { … }` is fine too — both orders parse — so the end of the block is the one
  // position that is always legal without having to find where the columns stop.
  return splice(source, end, end, written);
}

// ---- columns ---------------------------------------------------------------

/** Adds a column at the end of a table's body. */
export function addField(source: string, table: string, field: FieldEdit): string {
  if (!usable(field)) return source;
  const block = findBlock(blocksOf(source), table, "table");
  if (!block) return source;
  const { end } = bodyRange(source, block);
  return splice(source, end, end, [fieldLine(field, indentOf(source, block))]);
}

/**
 * Replaces one column's line.
 *
 * The whole line, deliberately. A column is a name, a type and a settings list, and the form that
 * produced `field` holds all three — so rewriting the parts individually would mean parsing the
 * settings back out of the line to preserve the ones the form does not model, and the form models
 * all of them. What it does not preserve is a trailing `//` comment on that column, which is the
 * one loss here and is why this rewrites a *column* rather than a table.
 */
export function updateField(
  source: string,
  table: string,
  name: string,
  field: FieldEdit,
): string {
  if (!usable(field)) return source;
  const block = findBlock(blocksOf(source), table, "table");
  if (!block) return source;
  const at = fieldLineIn(source, block, name);
  if (at < 0) return source;

  const lines = source.split("\n");
  const indent = /^[ \t]*/.exec(lines[at])?.[0] ?? INDENT;
  const next = splice(source, at, at + 1, [fieldLine(field, indent)]);
  // A renamed column is named by any ref that points at it.
  return name === field.name ? next : rewriteRefColumns(next, block.name, name, field.name);
}

/** Removes a column, and any relationship that was drawn to it. */
export function dropField(source: string, table: string, name: string): string {
  const block = findBlock(blocksOf(source), table, "table");
  if (!block) return source;
  const at = fieldLineIn(source, block, name);
  if (at < 0) return source;
  const withoutRefs = dropRefsOn(source, block.name, block.alias, name);
  const after = findBlock(blocksOf(withoutRefs), table, "table");
  if (!after) return withoutRefs;
  const line = fieldLineIn(withoutRefs, after, name);
  return line < 0 ? withoutRefs : splice(withoutRefs, line, line + 1, []);
}

// ---- relationships ---------------------------------------------------------

/**
 * Appends a `Ref:` line.
 *
 * A standalone `Ref:` rather than a `ref:` setting inside the column's brackets, though DBML allows
 * both. The line is the form that survives being read: it names both ends in one place, it is what
 * the inspector prints back, and it is a whole line — so removing the relationship later is
 * deleting a line rather than editing inside somebody's settings list.
 */
export function addRef(
  source: string,
  from: RefEnd,
  to: RefEnd,
  cardinality: Cardinality = ">",
): string {
  const line = `Ref: ${refSide(from)} ${cardinality} ${refSide(to)}`;
  // A ref that is already there, however it was spaced, is not added twice.
  const normalised = line.replace(/\s+/g, " ").toLowerCase();
  for (const block of blocksOf(source)) {
    if (block.kind !== "ref") continue;
    const text = source.split("\n").slice(block.from, block.to).join(" ").trim();
    if (text.replace(/\s+/g, " ").toLowerCase() === normalised) return source;
  }
  // And the same relationship written the other way — as a setting on the column. Missing this
  // declares the join twice, which DBML rejects outright.
  for (const ref of inlineRefs(source)) {
    const near = { table: ref.table, column: ref.column };
    if (
      (same(near, from) && same(ref.target, to)) ||
      (same(near, to) && same(ref.target, from))
    ) {
      return source;
    }
  }
  return append(source, line);
}

/**
 * Removes the relationship whose two ends are exactly these, whichever way round it was written.
 *
 * Checks the inline form first: a relationship declared as a column setting has no `Ref` block to
 * delete, and before this the inspector's delete button and the canvas menu simply did nothing on
 * those — a control that silently no-ops is worse than one that is disabled.
 */
export function dropRef(source: string, from: RefEnd, to: RefEnd): string {
  const inline = stripInlineRefs(source, (ref) => {
    const near = { table: ref.table, column: ref.column };
    return (
      (same(near, from) && same(ref.target, to)) || (same(near, to) && same(ref.target, from))
    );
  });
  if (inline !== source) return inline;

  const lines = source.split("\n");
  for (const block of blocksOf(source)) {
    if (block.kind !== "ref") continue;
    const ends = refEndsOf(lines.slice(block.from, block.to).join(" "));
    if (!ends) continue;
    const matches =
      (same(ends.left, from) && same(ends.right, to)) ||
      (same(ends.left, to) && same(ends.right, from));
    if (matches) return trimBlank(splice(source, block.from, block.to, []));
  }
  return source;
}

/** Rewrites a relationship's arrow in place, leaving both ends where they are. */
export function setRefCardinality(
  source: string,
  from: RefEnd,
  to: RefEnd,
  cardinality: Cardinality,
): string {
  // The inline form again — same reasoning as `dropRef`.
  const inlineLines = source.split("\n");
  for (const ref of inlineRefs(source)) {
    const near = { table: ref.table, column: ref.column };
    const forwards = same(near, from) && same(ref.target, to);
    const backwards = same(near, to) && same(ref.target, from);
    if (!forwards && !backwards) continue;
    const wanted = forwards ? cardinality : flip(cardinality);
    inlineLines[ref.line] = inlineLines[ref.line].replace(
      INLINE_REF,
      (all: string) => all.replace(/(?<=ref\s*:\s*)(<>|[<>-])/i, wanted),
    );
    return inlineLines.join("\n");
  }

  const lines = source.split("\n");
  for (const block of blocksOf(source)) {
    if (block.kind !== "ref") continue;
    const joined = lines.slice(block.from, block.to).join(" ");
    const ends = refEndsOf(joined);
    if (!ends) continue;
    if (!((same(ends.left, from) && same(ends.right, to)) || (same(ends.left, to) && same(ends.right, from)))) {
      continue;
    }
    for (let at = block.from; at < block.to; at += 1) {
      if (!ARROW.test(lines[at])) continue;
      lines[at] = lines[at].replace(ARROW, (all: string) =>
        all.replace(/[<>-]+/, same(ends.left, from) ? cardinality : flip(cardinality)),
      );
      break;
    }
    return lines.join("\n");
  }
  return source;
}

// ---- enums -----------------------------------------------------------------

/** A new enum with one placeholder value, appended at the end of the document. */
export function addEnum(source: string, name: string, values: string[] = []): string {
  const body = (values.length > 0 ? values : ["value"]).map((value) => `${INDENT}${quoteName(value)}`);
  return append(source, [`Enum ${quotePath(name)} {`, ...body, "}"].join("\n"));
}

// ---- the `Ref` line's own shape --------------------------------------------

/**
 * The arrow between two endpoints. Its own regex because three things rewrite it.
 *
 * The group is **non-capturing**, and that is load-bearing rather than tidiness: `refEndsOf` splits
 * on this, and `String.split` with a capturing group interleaves the captures into the result — so
 * a capturing version returns `[left, ">", right]` and every caller that reads `parts[1]` gets the
 * arrow where it expected the second endpoint. Every relationship operation in this file goes
 * through that split.
 */
const ARROW = /(?<=[\w"\].])\s*(?:<>|[<>-])\s*(?=[\w"])/;

/**
 * Relationships written *inside* a column, and why they need their own pass.
 *
 * DBML has two ways to say the same thing:
 *
 *     Ref: historias.usuario_id > usuarios.id      // a block, at the top level
 *     usuario_id integer [ref: > usuarios.id]      // a setting, inside the column
 *
 * `blocksOf` only sees the first — the second is not a block, it is three words inside a column
 * line. Everything below used to work only on blocks, which meant `dropTable`, `dropField` and
 * `renameTable` all left inline refs pointing at something that no longer existed. That is not a
 * cosmetic miss: an orphan `ref:` makes the whole document stop parsing, so deleting a table on a
 * schema written this way blanked the canvas.
 *
 * Both forms are equally idiomatic and the AI panel emits the inline one, so neither can be treated
 * as the odd case.
 */
interface InlineRef {
  /** Line the setting is on. */
  line: number;
  /** The table the column belongs to. */
  table: string;
  /** The column carrying the setting — the near end of the relationship. */
  column: string;
  /** The far end, as written. */
  target: RefEnd;
  cardinality: string;
}

/** `[ref: > users.id]`, wherever it appears in a column's settings. */
const INLINE_REF = /\bref\s*:\s*(<>|[<>-])\s*((?:"[^"]*"|[\w]+)(?:\.(?:"[^"]*"|[\w]+))+)/i;

/** Every inline ref in the document, with the column each one hangs off. */
function inlineRefs(source: string): InlineRef[] {
  const lines = source.split("\n");
  const out: InlineRef[] = [];
  for (const block of blocksOf(source)) {
    if (block.kind !== "table") continue;
    const { start, end } = bodyRange(source, block);
    let depth = 0;
    for (let at = start; at < end; at += 1) {
      const text = lines[at].trim();
      const here = depth;
      depth += braceDelta(lines[at]);
      if (here !== 0 || !text || text.startsWith("//")) continue;
      const match = INLINE_REF.exec(text);
      if (!match) continue;
      const owner = /^("[^"]*"|[\w]+)/.exec(text);
      if (!owner) continue;
      const parts = [...match[2].matchAll(/"[^"]*"|[\w]+/g)].map((part) =>
        part[0].replace(/^"|"$/g, ""),
      );
      if (parts.length < 2) continue;
      out.push({
        line: at,
        table: block.name,
        column: owner[1].replace(/^"|"$/g, ""),
        target: { table: parts.slice(0, -1).join("."), column: parts[parts.length - 1] },
        cardinality: match[1],
      });
    }
  }
  return out;
}

/**
 * The same line with its `ref:` setting taken out, and the brackets dropped if nothing else is left.
 *
 * Surgical rather than a re-emit of the settings, so `[not null, ref: > a.b, default: 1]` keeps its
 * spacing and its order and comes back as `[not null, default: 1]`.
 */
function withoutRefSetting(line: string): string {
  const open = line.indexOf("[");
  const close = line.lastIndexOf("]");
  if (open < 0 || close < open) return line;
  const kept = splitSettings(line.slice(open + 1, close)).filter(
    (setting) => !/^ref\s*:/i.test(setting.trim()),
  );
  const head = line.slice(0, open).replace(/\s+$/, "");
  const tail = line.slice(close + 1);
  return kept.length === 0 ? head + tail : `${head} [${kept.map((s) => s.trim()).join(", ")}]${tail}`;
}

/** Splits a settings body on the commas that are not inside brackets, quotes or backticks. */
function splitSettings(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      out.push(body.slice(start, at));
      start = at + 1;
    }
  }
  out.push(body.slice(start));
  return out.filter((setting) => setting.trim().length > 0);
}

/** `table.column`, quoted only where DBML needs it. */
function refSide(end: RefEnd): string {
  return `${quotePath(end.table)}.${quoteName(end.column)}`;
}

function flip(cardinality: Cardinality): Cardinality {
  if (cardinality === "<") return ">";
  if (cardinality === ">") return "<";
  return cardinality;
}

function same(a: RefEnd, b: RefEnd): boolean {
  const bare = (name: string) => name.toLowerCase().split(".").pop();
  return bare(a.table) === bare(b.table) && a.column.toLowerCase() === b.column.toLowerCase();
}

/** The two ends of a `Ref`, however it was written. `null` when the line does not parse as one. */
function refEndsOf(text: string): { left: RefEnd; right: RefEnd } | null {
  // Everything after the first `:` that is not part of a name — `Ref name: a.b > c.d`.
  const body = /:(.*)$/s.exec(text.replace(/^\s*ref\b/i, ""))?.[1];
  if (!body) return null;
  const parts = body.split(ARROW);
  if (parts.length < 2) return null;
  const left = endpointOf(parts[0]);
  const right = endpointOf(parts[1]);
  return left && right ? { left, right } : null;
}

/** `"my schema".orders.(a, b)` → its table and its first column. */
function endpointOf(text: string): RefEnd | null {
  const cleaned = text.replace(/\[[^\]]*\]/g, "").trim();
  const match = /^((?:"[^"]*"|[\w]+)(?:\.(?:"[^"]*"|[\w]+))*?)\.(?:\(\s*)?("[^"]*"|[\w]+)/.exec(cleaned);
  if (!match) return null;
  return {
    table: match[1].replace(/"/g, ""),
    column: match[2].replace(/"/g, ""),
  };
}

/** Every relationship naming `table` gets `next` in its place — blocks and inline settings alike. */
function rewriteRefEndpoints(source: string, table: string, next: string): string {
  const inline = mapInlineRefs(
    source,
    (ref) => bare(ref.target.table).toLowerCase() === bare(table).toLowerCase(),
    (ref) => ({ table: next, column: ref.target.column }),
  );
  return rewriteRefBlocks(inline, table, next);
}

function rewriteRefBlocks(source: string, table: string, next: string): string {
  return mapRefs(source, (line, end) =>
    same(end, { table, column: end.column })
      ? line.replace(
          new RegExp(`(^|[\\s:<>-])("?)${escape(bare(table))}\\2(\\.)`, "gi"),
          (_all, head: string, _quote: string, dot: string) => `${head}${quotePath(next)}${dot}`,
        )
      : line,
  );
}

/** A renamed column, everywhere a relationship on `table` names it. */
function rewriteRefColumns(source: string, table: string, from: string, to: string): string {
  const inline = mapInlineRefs(
    source,
    (ref) => same(ref.target, { table, column: from }),
    () => ({ table, column: to }),
  );
  return rewriteRefColumnBlocks(inline, table, from, to);
}

function rewriteRefColumnBlocks(source: string, table: string, from: string, to: string): string {
  return mapRefs(source, (line, end) =>
    same(end, { table, column: from })
      ? line.replace(
          new RegExp(`("?)${escape(bare(table))}\\1\\.("?)${escape(from)}\\2`, "gi"),
          `${quotePath(table)}.${quoteName(to)}`,
        )
      : line,
  );
}

/** Drops every relationship with `table` at either end — blocks and inline settings alike. */
function dropRefsTouching(source: string, table: string, alias: string | null): string {
  const names = [table, alias].filter(Boolean) as string[];
  const blocksGone = filterRefs(source, (ends) =>
    !names.some(
      (name) => same(ends.left, { table: name, column: ends.left.column }) ||
        same(ends.right, { table: name, column: ends.right.column }),
    ),
  );
  // An inline ref on a column of the table being dropped goes with the table; one *pointing at* it
  // from elsewhere has to be stripped, or it outlives its target and the document stops parsing.
  return stripInlineRefs(blocksGone, (ref) =>
    names.some(
      (name) =>
        bare(name) === bare(ref.target.table).toLowerCase() ||
        bare(name) === bare(ref.table).toLowerCase(),
    ),
  );
}

/** Drops every relationship that lands on one particular column, in either form. */
function dropRefsOn(source: string, table: string, alias: string | null, column: string): string {
  const names = [table, alias].filter(Boolean) as string[];
  const blocksGone = filterRefs(source, (ends) =>
    !names.some(
      (name) => same(ends.left, { table: name, column }) || same(ends.right, { table: name, column }),
    ),
  );
  return stripInlineRefs(blocksGone, (ref) =>
    names.some((name) => same(ref.target, { table: name, column })),
  );
}

/** Removes the `ref:` setting from every inline ref `hit` selects, back to front. */
function stripInlineRefs(source: string, hit: (ref: InlineRef) => boolean): string {
  const lines = source.split("\n");
  for (const ref of inlineRefs(source)) {
    if (hit(ref)) lines[ref.line] = withoutRefSetting(lines[ref.line]);
  }
  return lines.join("\n");
}

/** Rewrites the far end of every inline ref `hit` selects. */
function mapInlineRefs(
  source: string,
  hit: (ref: InlineRef) => boolean,
  next: (ref: InlineRef) => RefEnd,
): string {
  const lines = source.split("\n");
  for (const ref of inlineRefs(source)) {
    if (!hit(ref)) continue;
    const end = next(ref);
    lines[ref.line] = lines[ref.line].replace(
      INLINE_REF,
      (all: string) => all.replace(/((?:"[^"]*"|[\w]+)(?:\.(?:"[^"]*"|[\w]+))+)$/, refSide(end)),
    );
  }
  return lines.join("\n");
}

/** Rewrites the `Ref` blocks whose ends `edit` cares about, one line at a time. */
function mapRefs(source: string, edit: (line: string, end: RefEnd) => string): string {
  const lines = source.split("\n");
  for (const block of blocksOf(source)) {
    if (block.kind !== "ref") continue;
    const ends = refEndsOf(lines.slice(block.from, block.to).join(" "));
    if (!ends) continue;
    for (let at = block.from; at < block.to; at += 1) {
      lines[at] = edit(edit(lines[at], ends.left), ends.right);
    }
  }
  return lines.join("\n");
}

/** Keeps the `Ref` blocks `keep` returns true for and removes the rest. */
function filterRefs(source: string, keep: (ends: { left: RefEnd; right: RefEnd }) => boolean): string {
  let result = source;
  // Back to front, so removing one block does not move the ones not yet looked at.
  const blocks = blocksOf(source).filter((block) => block.kind === "ref");
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const ends = refEndsOf(source.split("\n").slice(block.from, block.to).join(" "));
    if (ends && !keep(ends)) result = splice(result, block.from, block.to, []);
  }
  return trimBlank(result);
}

/** The last segment of a possibly schema-qualified name, lowercased for comparison. */
function bare(name: string): string {
  return (name.split(".").pop() ?? name).toLowerCase();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collapses the run of blank lines a removal leaves behind, and nothing else. */
function trimBlank(source: string): string {
  return source.replace(/\n{3,}/g, "\n\n");
}
