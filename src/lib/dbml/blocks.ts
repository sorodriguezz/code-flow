/**
 * A DBML document as its top-level blocks, with the lines each one occupies.
 *
 * Lifted out of `merge.ts`, which has had the splitter since generation was added and needed only
 * the *text* of each block. Editing needs its *place* as well: an edit that inserts a column has to
 * know which line to insert it before, and the only honest answer comes from the same brace-count
 * that found the block.
 *
 * Brace-counting rather than a parse, for two reasons that point the same way. `merge.ts`'s: what
 * is being moved around may well be almost-valid, because it came from a model. And editing's: the
 * model this produces has to survive being handed a document the user is halfway through typing.
 *
 * `from`/`to` are **0-based and half-open** — `lines.slice(from, to)` is the block. Monaco is
 * 1-based, so the one conversion happens where the two meet and nowhere else.
 */

export type BlockKind = "table" | "enum" | "tablegroup" | "ref" | "other";

export interface DbmlBlock {
  kind: BlockKind;
  /** The declared name, unquoted, as written. `""` for `ref` and `other`. */
  name: string;
  /** The `as` alias, unquoted, or `null`. */
  alias: string | null;
  /** First line of the block, 0-based, inclusive. */
  from: number;
  /** One past the last line, 0-based. */
  to: number;
  /** Whether the closing `}` was ever found. A block being typed has not got one yet. */
  closed: boolean;
}

const DECLARATION =
  /^(table|enum|tablegroup|tablepartial)\s+("[^"]*"|[\w.]+)(?:\s+as\s+("[^"]*"|[\w.]+))?/i;

function unquote(text: string): string {
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/** Braces outside strings, so a `{` in a note or a default does not open a block. */
export function braceDelta(line: string): number {
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

/** Every top-level block in `source`, in order. */
export function blocksOf(source: string): DbmlBlock[] {
  const lines = source.split("\n");
  const out: DbmlBlock[] = [];
  let at = 0;

  while (at < lines.length) {
    const trimmed = lines[at].trim();
    if (!trimmed || trimmed.startsWith("//")) {
      at += 1;
      continue;
    }

    const declared = DECLARATION.exec(trimmed);
    if (declared) {
      const from = at;
      let depth = 0;
      let opened = false;
      while (at < lines.length) {
        depth += braceDelta(lines[at]);
        if (depth > 0) opened = true;
        at += 1;
        if (opened && depth <= 0) break;
      }
      const kind = declared[1].toLowerCase();
      out.push({
        kind: kind === "tablepartial" ? "table" : (kind as BlockKind),
        name: unquote(declared[2]),
        alias: declared[3] ? unquote(declared[3]) : null,
        from,
        to: at,
        closed: opened && depth <= 0,
      });
      continue;
    }

    if (/^ref\b/i.test(trimmed)) {
      // A `Ref` may be a one-liner (`Ref: a.b > c.d`) or a braced block. The brace decides.
      const from = at;
      if (trimmed.includes("{")) {
        let depth = 0;
        let opened = false;
        while (at < lines.length) {
          depth += braceDelta(lines[at]);
          if (depth > 0) opened = true;
          at += 1;
          if (opened && depth <= 0) break;
        }
        out.push({ kind: "ref", name: "", alias: null, from, to: at, closed: true });
      } else {
        at += 1;
        out.push({ kind: "ref", name: "", alias: null, from, to: at, closed: true });
      }
      continue;
    }

    out.push({ kind: "other", name: "", alias: null, from: at, to: at + 1, closed: true });
    at += 1;
  }

  return out;
}

/** The block declaring `name` — matched on the alias first, then the name, then its bare half. */
export function findBlock(
  blocks: DbmlBlock[],
  name: string,
  kind?: BlockKind,
): DbmlBlock | undefined {
  const wanted = name.toLowerCase();
  const of = (block: DbmlBlock) => (kind ? block.kind === kind : true);
  return (
    blocks.find((block) => of(block) && block.alias?.toLowerCase() === wanted) ??
    blocks.find((block) => of(block) && block.name.toLowerCase() === wanted) ??
    blocks.find((block) => of(block) && block.name.toLowerCase().split(".").pop() === wanted)
  );
}
