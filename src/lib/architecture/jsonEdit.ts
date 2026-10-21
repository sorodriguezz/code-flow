/**
 * Edits to the document's text that touch only what changed.
 *
 * A visual edit (the inspector, a drag, an accepted AI proposal) must not re-print the whole file:
 * the user's comments, ordering and line breaks are theirs, and a diff in git should show the one
 * value that moved. So the text is parsed once into a tree of offsets — every value's start and
 * end, every property's key — and an edit is a splice at those offsets, formatted to the
 * indentation around it. JSONC throughout: comments and trailing commas are skipped, never lost.
 */

export type JsonPath = Array<string | number>;

interface Node {
  kind: "object" | "array" | "value";
  start: number;
  end: number;
  props?: Prop[];
  items?: Node[];
}
interface Prop { key: string; start: number; value: Node }

class Scanner {
  i = 0;
  constructor(readonly s: string) {}
  ws() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
      if (s[this.i] === "/" && s[this.i + 1] === "/") { while (this.i < s.length && s[this.i] !== "\n") this.i++; continue; }
      if (s[this.i] === "/" && s[this.i + 1] === "*") { const e = s.indexOf("*/", this.i + 2); this.i = e < 0 ? s.length : e + 2; continue; }
      break;
    }
  }
  string(): string {
    const s = this.s;
    const start = this.i;
    this.i++;
    while (this.i < s.length && s[this.i] !== '"') { if (s[this.i] === "\\") this.i++; this.i++; }
    this.i++;
    return JSON.parse(s.slice(start, this.i));
  }
  value(): Node {
    this.ws();
    const s = this.s, start = this.i, c = s[this.i];
    if (c === "{") {
      this.i++;
      const props: Prop[] = [];
      for (;;) {
        this.ws();
        if (s[this.i] === "}") { this.i++; break; }
        if (s[this.i] === ",") { this.i++; continue; }
        if (s[this.i] !== '"') throw new Error("bad key");
        const kstart = this.i;
        const key = this.string();
        this.ws();
        if (s[this.i] !== ":") throw new Error("missing colon");
        this.i++;
        const value = this.value();
        props.push({ key, start: kstart, value });
      }
      return { kind: "object", start, end: this.i, props };
    }
    if (c === "[") {
      this.i++;
      const items: Node[] = [];
      for (;;) {
        this.ws();
        if (s[this.i] === "]") { this.i++; break; }
        if (s[this.i] === ",") { this.i++; continue; }
        items.push(this.value());
      }
      return { kind: "array", start, end: this.i, items };
    }
    if (c === '"') { this.string(); return { kind: "value", start, end: this.i }; }
    while (this.i < s.length && /[^\s,}\]/]/.test(s[this.i])) this.i++;
    if (this.i === start) throw new Error("unexpected token");
    return { kind: "value", start, end: this.i };
  }
}

function parseTree(text: string): Node {
  return new Scanner(text).value();
}

function find(root: Node, path: JsonPath): Node | null {
  let n: Node | null = root;
  for (const k of path) {
    if (!n) return null;
    if (typeof k === "number") n = n.kind === "array" ? n.items![k] ?? null : null;
    else n = n.kind === "object" ? n.props!.find((p) => p.key === k)?.value ?? null : null;
  }
  return n;
}

const lineIndent = (text: string, offset: number) => {
  const ls = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))![0];
};

const WIDTH = 96;
function inline(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(", ")}]` : "[]";
  const ks = Object.keys(v as object);
  return ks.length ? `{ ${ks.map((k) => `${JSON.stringify(k)}: ${inline((v as Record<string, unknown>)[k])}`).join(", ")} }` : "{}";
}

/** Pretty-prints like the documents the app writes: a value fits on one line when it can, else one entry per line. */
export function formatJson(v: unknown, indent = "", used = indent.length): string {
  const one = inline(v);
  if (v === null || typeof v !== "object" || used + one.length <= WIDTH) return one;
  const pad = indent + "  ";
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + formatJson(x, pad)).join(",\n")}\n${indent}]`;
  const obj = v as Record<string, unknown>;
  return `{\n${Object.keys(obj).map((k) => { const pre = `${JSON.stringify(k)}: `; return pad + pre + formatJson(obj[k], pad, pad.length + pre.length); }).join(",\n")}\n${indent}}`;
}

export const formatDoc = (doc: unknown) => formatJson(doc) + "\n";

const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end);
const multiline = (text: string, n: Node) => text.slice(n.start, n.end).includes("\n");

/** Sets the value at `path`, creating missing object keys along the way. */
export function setAt(text: string, path: JsonPath, value: unknown): string {
  const root = parseTree(text);
  const node = find(root, path);
  if (node) {
    const indent = lineIndent(text, node.start);
    const col = node.start - (text.lastIndexOf("\n", node.start - 1) + 1);
    return splice(text, node.start, node.end, formatJson(value, indent, col));
  }
  // Walk up to the deepest existing parent and insert the rest as one nested value.
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const parent = find(root, path.slice(0, depth));
    if (!parent) continue;
    const key = path[depth];
    let nested: unknown = value;
    for (let k = path.length - 1; k > depth; k--) nested = typeof path[k] === "number" ? [nested] : { [path[k] as string]: nested };
    if (parent.kind === "object" && typeof key === "string") return insertProp(text, parent, key, nested);
    if (parent.kind === "array" && typeof key === "number") return insertItem(text, parent, nested);
    return text;
  }
  return text;
}

function insertProp(text: string, obj: Node, key: string, value: unknown): string {
  const props = obj.props!;
  if (!props.length) {
    const indent = lineIndent(text, obj.start);
    const pad = indent + "  ";
    return splice(text, obj.start, obj.end, `{\n${pad}${JSON.stringify(key)}: ${formatJson(value, pad, pad.length + key.length + 4)}\n${indent}}`);
  }
  const last = props[props.length - 1];
  if (!multiline(text, obj)) return splice(text, last.value.end, last.value.end, `, ${JSON.stringify(key)}: ${inline(value)}`);
  const pad = lineIndent(text, last.start);
  return splice(text, last.value.end, last.value.end, `,\n${pad}${JSON.stringify(key)}: ${formatJson(value, pad, pad.length + key.length + 4)}`);
}

function insertItem(text: string, arr: Node, value: unknown): string {
  const items = arr.items!;
  if (!items.length) {
    const indent = lineIndent(text, arr.start);
    const one = inline(value);
    if (one.length + indent.length < WIDTH) return splice(text, arr.start, arr.end, `[${one}]`);
    const pad = indent + "  ";
    return splice(text, arr.start, arr.end, `[\n${pad}${formatJson(value, pad)}\n${indent}]`);
  }
  const last = items[items.length - 1];
  if (!multiline(text, arr)) return splice(text, last.end, last.end, `, ${inline(value)}`);
  const pad = lineIndent(text, last.start);
  return splice(text, last.end, last.end, `,\n${pad}${formatJson(value, pad)}`);
}

/** Appends to the array at `path` (creating it when missing). */
export function appendAt(text: string, path: JsonPath, value: unknown): string {
  const root = parseTree(text);
  const arr = find(root, path);
  if (arr && arr.kind === "array") return insertItem(text, arr, value);
  if (!arr) return setAt(text, path, [value]);
  return text;
}

/** Removes the property or array item at `path`, with its comma. */
export function removeAt(text: string, path: JsonPath): string {
  if (!path.length) return text;
  const root = parseTree(text);
  const parent = find(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent) return text;
  const entries: Array<{ start: number; end: number }> =
    parent.kind === "object" ? parent.props!.map((p) => ({ start: p.start, end: p.value.end })) : parent.kind === "array" ? parent.items!.map((n) => ({ start: n.start, end: n.end })) : [];
  const idx = parent.kind === "object" ? parent.props!.findIndex((p) => p.key === key) : typeof key === "number" ? key : -1;
  if (idx < 0 || idx >= entries.length) return text;
  const cur = entries[idx];
  if (idx < entries.length - 1) {
    // Up to the next entry's start, taking the comma and the line break with it.
    const next = entries[idx + 1];
    const ls = text.lastIndexOf("\n", cur.start - 1) + 1;
    const start = /^\s*$/.test(text.slice(ls, cur.start)) && text.slice(cur.end, next.start).includes("\n") ? ls : cur.start;
    const nls = text.lastIndexOf("\n", next.start - 1) + 1;
    const end = start === ls && /^\s*$/.test(text.slice(nls, next.start)) ? nls : next.start;
    return splice(text, start, end, "");
  }
  if (idx > 0) {
    const prev = entries[idx - 1];
    return splice(text, prev.end, cur.end, "");
  }
  // The only entry: leave the container empty.
  const open = parent.start + 1, close = parent.end - 1;
  return splice(text, open, close, "");
}

/** The [start, end) offsets of the value at `path` — for revealing it in the editor. */
export function rangeOf(text: string, path: JsonPath): { start: number; end: number; keyStart?: number } | null {
  try {
    const root = parseTree(text);
    const node = find(root, path);
    if (!node) return null;
    let keyStart: number | undefined;
    if (path.length && typeof path[path.length - 1] === "string") {
      const parent = find(root, path.slice(0, -1));
      keyStart = parent?.props?.find((p) => p.key === path[path.length - 1])?.start;
    }
    return { start: node.start, end: node.end, keyStart };
  } catch {
    return null;
  }
}

/** The deepest path whose value contains `offset` — for "what is the caret inside". */
export function pathAt(text: string, offset: number): JsonPath {
  let root: Node;
  try { root = parseTree(text); } catch { return []; }
  const path: JsonPath = [];
  let n: Node | undefined = root;
  for (;;) {
    if (!n) break;
    if (n.kind === "object") {
      const p: Prop | undefined = n.props!.find((x) => offset >= x.start && offset <= x.value.end);
      if (!p) break;
      path.push(p.key);
      n = p.value;
    } else if (n.kind === "array") {
      const idx: number = n.items!.findIndex((x) => offset >= x.start && offset <= x.end);
      if (idx < 0) break;
      path.push(idx);
      n = n.items![idx];
    } else break;
  }
  return path;
}
