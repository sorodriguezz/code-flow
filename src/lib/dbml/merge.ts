import { readLayout, writeLayout } from "./layout";
import type { DbmlSchema } from "./types";

/**
 * Adding generated DBML to a document that already has some.
 *
 * The counterpart of `lib/diagrams/mxgraph.ts`'s `appendCells`, and it exists for exactly the same
 * reason: **a generation adds, it never replaces**. Somebody who asks for "an orders table" over a
 * schema they have been working on for an hour must get their schema *plus* orders, and must get it
 * without the possibility of losing the hour.
 *
 * What that costs is a name check. DBML rejects a document with two tables of the same name
 * outright — so appending blindly does not produce a messy schema, it produces one that will not
 * parse at all, and the canvas goes blank on what looked like a successful generation.
 */

/** Table and enum names already declared, lowercased. What an incoming block is checked against. */
function declaredNames(source: string): Set<string> {
  const names = new Set<string>();
  const declaration = /^\s*(table|enum)\s+("[^"]+"|[\w.]+)/gim;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    names.add(match[2].replace(/^"|"$/g, "").toLowerCase());
  }
  return names;
}

/** The `Ref:` lines already declared, normalised so spacing does not make two of one. */
function declaredRefs(source: string): Set<string> {
  const refs = new Set<string>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (/^ref\b/i.test(trimmed)) refs.add(trimmed.replace(/\s+/g, " ").toLowerCase());
  }
  return refs;
}

/**
 * Splits a document into its top-level blocks: `Table … { … }`, `Enum … { … }`, `Ref: …` lines.
 *
 * Brace-counting rather than a parse, because what is being appended may well be *almost* valid —
 * it came from a model — and this has to be able to move it around without understanding it.
 */
function blocks(source: string): { kind: "block" | "ref" | "other"; name: string; text: string }[] {
  const out: { kind: "block" | "ref" | "other"; name: string; text: string }[] = [];
  const lines = source.split("\n");
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    const trimmed = line.trim();
    if (!trimmed) {
      at += 1;
      continue;
    }
    const declaration = trimmed.match(/^(table|enum)\s+("[^"]+"|[\w.]+)/i);
    if (declaration && trimmed.includes("{")) {
      let depth = 0;
      const collected: string[] = [];
      while (at < lines.length) {
        const current = lines[at];
        collected.push(current);
        depth += (current.match(/\{/g) ?? []).length - (current.match(/\}/g) ?? []).length;
        at += 1;
        if (depth <= 0 && collected.length > 0) break;
      }
      out.push({
        kind: "block",
        name: declaration[2].replace(/^"|"$/g, "").toLowerCase(),
        text: collected.join("\n"),
      });
      continue;
    }
    if (/^ref\b/i.test(trimmed)) {
      out.push({ kind: "ref", name: trimmed.replace(/\s+/g, " ").toLowerCase(), text: line });
      at += 1;
      continue;
    }
    out.push({ kind: "other", name: "", text: line });
    at += 1;
  }
  return out;
}

/**
 * `document` with everything from `generated` that it does not already declare.
 *
 * Returns the document unchanged when the generation adds nothing — which is what the caller checks
 * to decide whether anything actually happened. The dragged positions travel through untouched:
 * new tables have none yet and are placed by the layout engine, and the boxes already arranged stay
 * where the user put them.
 */
export function mergeDbml(document: string, generated: string): string {
  const current = readLayout(document);
  const incoming = readLayout(generated);
  if (!incoming.source.trim()) return document;

  const names = declaredNames(current.source);
  const refs = declaredRefs(current.source);
  const additions: string[] = [];

  for (const block of blocks(incoming.source)) {
    if (block.kind === "block") {
      if (names.has(block.name)) continue;
      names.add(block.name);
      additions.push(block.text);
    } else if (block.kind === "ref") {
      if (refs.has(block.name)) continue;
      refs.add(block.name);
      additions.push(block.text);
    }
    // `other` — comments and stray lines from the generation — is dropped rather than appended.
    // The document is the user's; a model's commentary is not part of their schema.
  }

  if (additions.length === 0) return document;
  const body = `${current.source.replace(/\s+$/, "")}\n\n${additions.join("\n\n")}`;
  return writeLayout(body, current.positions);
}

/** How much a merge would add, for the "3 tables, 2 relations" line in the preview. */
export function generatedCounts(schema: DbmlSchema): { tables: number; refs: number; enums: number } {
  return { tables: schema.tables.length, refs: schema.refs.length, enums: schema.enums.length };
}
