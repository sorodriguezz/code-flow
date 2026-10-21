/**
 * Reading an Arquitectura document: lenient on syntax, strict on references.
 *
 * The text is JSONC — `//` and block comments and trailing commas are accepted, since people annotate
 * these files and models leave a comma behind. Both are blanked to spaces rather than removed, so a
 * position the JSON parser reports still points at the character the user sees.
 *
 * A syntax error never costs the drawing: the caller keeps the last document that parsed and shows
 * the error beside it. Everything past syntax is a warning, not an error — an unknown id draws as a
 * red placeholder card, and the warning names it.
 */
import { isGroup, isZone, resolveComponents, type ArchDoc, type LayoutNode, type ResolvedComponents } from "./types";

export interface ParseError {
  /** 1-based, or null when the engine's message carried no position. */
  line: number | null;
  column: number | null;
  /** A code the UI translates (`arch.parse.<code>`). */
  code: "missingComma" | "missingBracket" | "propertyName" | "unexpectedEnd" | "unterminatedString" | "controlCharacter" | "unexpectedToken" | "notAnObject" | "invalid";
}

export type ParseResult = { ok: true; doc: ArchDoc } | { ok: false; error: ParseError };

/** Comments and trailing commas → spaces, everything else byte for byte (newlines kept). */
export function jsoncToJson(src: string): string {
  const out = src.split("");
  const n = src.length;
  let inString = false;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      out[i] = out[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] !== "\n") out[i] = " "; i++; }
      if (i < n) { out[i] = out[i + 1] = " "; i++; }
    }
  }
  const s = out.join("");
  const res = s.split("");
  inString = false;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") res[i] = " ";
    }
  }
  return res.join("");
}

export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

const CODES: Array<[RegExp, ParseError["code"]]> = [
  [/Expected ',' or '}'/i, "missingComma"],
  [/Expected ',' or ']'/i, "missingBracket"],
  [/double-quoted property name|property name/i, "propertyName"],
  [/Unexpected end|end of (JSON )?(input|data)/i, "unexpectedEnd"],
  [/Unterminated string/i, "unterminatedString"],
  [/Bad control character|control character/i, "controlCharacter"],
  [/Unexpected token|Unexpected non-whitespace|unexpected character/i, "unexpectedToken"],
];

export function parseArchText(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(jsoncToJson(text));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    let line: number | null = null;
    let column: number | null = null;
    let m: RegExpMatchArray | null;
    if ((m = msg.match(/line (\d+) column (\d+)/i))) { line = Number(m[1]); column = Number(m[2]); }
    else if ((m = msg.match(/position (\d+)/i))) ({ line, column } = lineColumnAt(text, Number(m[1])));
    else if (/Unexpected end|end of/i.test(msg)) ({ line, column } = lineColumnAt(text, text.length));
    const code = CODES.find(([re]) => re.test(msg))?.[1] ?? "invalid";
    return { ok: false, error: { line, column, code } };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: { line: 1, column: 1, code: "notAnObject" } };
  return { ok: true, doc: value as ArchDoc };
}

export interface ArchWarning {
  /** `arch.warn.<code>` in the translations. */
  code:
    | "unknownInLayout"
    | "placedTwice"
    | "zoneTwice"
    | "notPlaced"
    | "unknownEndpoint"
    | "stepWithoutText"
    | "noteTarget"
    | "unknownCategory"
    | "decisionTarget";
  params: Record<string, string | number>;
}

const CATEGORIES = new Set(["actor", "compute", "data", "messaging", "network", "identity", "security", "observability", "external"]);

/** Every reference the drawing can't honour, as translatable warnings. */
export function validateDoc(doc: ArchDoc, components: ResolvedComponents = resolveComponents(doc)): ArchWarning[] {
  const out: ArchWarning[] = [];
  const placed = new Set<string>();
  const zones = new Set<string>();
  const walk = (node: LayoutNode) => {
    if (typeof node === "string") {
      if (!components[node]) out.push({ code: "unknownInLayout", params: { id: node } });
      else if (placed.has(node)) out.push({ code: "placedTwice", params: { id: node } });
      placed.add(node);
      return;
    }
    if (isZone(node)) {
      if (zones.has(node.id)) out.push({ code: "zoneTwice", params: { id: node.id } });
      zones.add(node.id);
      node.children.forEach(walk);
    } else if (isGroup(node)) (node.row ?? node.column ?? []).forEach(walk);
  };
  (doc.layout ?? []).forEach(walk);
  for (const [id, c] of Object.entries(doc.components ?? {})) {
    if (!placed.has(id)) out.push({ code: "notPlaced", params: { id } });
    if (c.category && !CATEGORIES.has(c.category)) out.push({ code: "unknownCategory", params: { id, category: c.category } });
  }
  (doc.connections ?? []).forEach((e, i) => {
    for (const end of [e.from, e.to]) if (!components[end]) out.push({ code: "unknownEndpoint", params: { n: i + 1, id: String(end) } });
    if (e.step && !(doc.flow ?? [])[e.step - 1]) out.push({ code: "stepWithoutText", params: { step: e.step } });
  });
  for (const note of doc.notes ?? []) if (!components[note.on] && !zones.has(note.on)) out.push({ code: "noteTarget", params: { id: note.id, target: note.on } });
  for (const d of doc.decisions ?? []) for (const id of d.affects ?? []) if (!components[id]) out.push({ code: "decisionTarget", params: { id: d.id, target: id } });
  return out;
}

/** Ids of the zones in a layout, in drawing order. */
export function zoneIds(layout: LayoutNode[] | undefined): string[] {
  const ids: string[] = [];
  const walk = (n: LayoutNode) => {
    if (isZone(n)) { ids.push(n.id); n.children.forEach(walk); }
    else if (isGroup(n)) (n.row ?? n.column ?? []).forEach(walk);
  };
  (layout ?? []).forEach(walk);
  return ids;
}

/** Finds the zone with `id` (for edits that add a card to it). */
export function findZone(layout: LayoutNode[] | undefined, id: string): import("./types").Zone | null {
  for (const n of layout ?? []) {
    if (isZone(n)) {
      if (n.id === id) return n;
      const inner = findZone(n.children, id);
      if (inner) return inner;
    } else if (isGroup(n)) {
      const inner = findZone(n.row ?? n.column, id);
      if (inner) return inner;
    }
  }
  return null;
}
