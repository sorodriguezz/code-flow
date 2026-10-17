/**
 * JSONPath over an already-parsed value — the response panel's filter, the no-code assertions and
 * «Guardar en variable…» all read a body through this one evaluator.
 *
 * The dialect is the common subset every client agrees on: `$`, `.key`, `['key']`, `[n]` (negative
 * counts from the end), `[*]` / `.*`, `..key` (recursive), unions `[0,2]` / `['a','b']`, slices
 * `[1:3]` / `[::2]`, and filters `[?(@.price < 10 && @.tags)]` with `== != < <= > >= =~`. A jq-style
 * path (`.data[].id`) is accepted too: it is the same walk spelled the way people type it in a
 * terminal, so it is translated rather than refused.
 *
 * Errors are thrown as `JsonPathError` with a message meant for the user — the filter shows it under
 * the field.
 */

export class JsonPathError extends Error {}

type Segment =
  | { kind: "child"; names: (string | number)[] }
  | { kind: "wildcard" }
  | { kind: "slice"; start: number | null; end: number | null; step: number | null }
  | { kind: "filter"; expr: FilterExpr }
  | { kind: "descend"; then: Segment };

type FilterExpr =
  | { kind: "or"; left: FilterExpr; right: FilterExpr }
  | { kind: "and"; left: FilterExpr; right: FilterExpr }
  | { kind: "not"; inner: FilterExpr }
  | { kind: "compare"; op: CompareOp; left: Operand; right: Operand }
  | { kind: "truthy"; operand: Operand };

type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "=~";

type Operand = { kind: "literal"; value: unknown } | { kind: "path"; segments: Segment[]; root: "@" | "$" };

/** `.data[].id` → `$.data[*].id`; a path that already starts at `$` is left alone. */
export function normalizePath(input: string): string {
  const text = input.trim();
  if (text === "" || text === "$") return "$";
  if (text.startsWith("$")) return text;
  let rest = text === "." ? "" : text;
  if (!rest.startsWith(".") && !rest.startsWith("[")) rest = `.${rest}`;
  // jq's iterator `[]` is JSONPath's wildcard (an empty bracket means nothing else in JSONPath).
  return `$${rest.replace(/\[\]/g, "[*]")}`;
}

/** Every value `path` selects in `root`, in document order. */
export function queryJsonPath(root: unknown, path: string): unknown[] {
  const segments = parsePath(normalizePath(path));
  return evaluate(segments, [root], root);
}

/** `queryJsonPath` folded to one value: the match itself when there is exactly one, every match as
 *  an array otherwise, `undefined` when nothing matched. */
export function selectJsonPath(root: unknown, path: string): unknown {
  const matches = queryJsonPath(root, path);
  if (matches.length === 0) return undefined;
  return matches.length === 1 ? matches[0] : matches;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

class Cursor {
  constructor(
    readonly text: string,
    public at = 0,
  ) {}
  peek(offset = 0): string {
    return this.text[this.at + offset] ?? "";
  }
  done(): boolean {
    return this.at >= this.text.length;
  }
  skipSpace(): void {
    while (/\s/.test(this.peek())) this.at += 1;
  }
  eat(token: string): boolean {
    if (this.text.startsWith(token, this.at)) {
      this.at += token.length;
      return true;
    }
    return false;
  }
  expect(token: string): void {
    if (!this.eat(token)) throw new JsonPathError(`Se esperaba «${token}» en la posición ${this.at + 1}`);
  }
}

function parsePath(path: string): Segment[] {
  const cursor = new Cursor(path);
  cursor.expect("$");
  const segments = parseSegments(cursor, false);
  if (!cursor.done()) throw new JsonPathError(`Sobra «${path.slice(cursor.at)}»`);
  return segments;
}

/** Segments until the end, or — inside a filter — until something that is not a segment. */
function parseSegments(cursor: Cursor, inFilter: boolean): Segment[] {
  const out: Segment[] = [];
  for (;;) {
    if (inFilter) cursor.skipSpace();
    if (cursor.eat("..")) {
      if (cursor.peek() === "[") out.push({ kind: "descend", then: parseBracket(cursor) });
      else if (cursor.eat("*")) out.push({ kind: "descend", then: { kind: "wildcard" } });
      else out.push({ kind: "descend", then: { kind: "child", names: [readName(cursor)] } });
      continue;
    }
    if (cursor.peek() === ".") {
      cursor.at += 1;
      if (cursor.eat("*")) out.push({ kind: "wildcard" });
      else out.push({ kind: "child", names: [readName(cursor)] });
      continue;
    }
    if (cursor.peek() === "[") {
      out.push(parseBracket(cursor));
      continue;
    }
    return out;
  }
}

function readName(cursor: Cursor): string {
  const start = cursor.at;
  while (!cursor.done() && /[^\s.[\]()=!<>&|,'"~]/.test(cursor.peek())) cursor.at += 1;
  if (cursor.at === start) throw new JsonPathError(`Falta un nombre de campo en la posición ${start + 1}`);
  return cursor.text.slice(start, cursor.at);
}

function parseBracket(cursor: Cursor): Segment {
  cursor.expect("[");
  cursor.skipSpace();
  if (cursor.eat("*")) {
    cursor.skipSpace();
    cursor.expect("]");
    return { kind: "wildcard" };
  }
  if (cursor.peek() === "?") {
    cursor.at += 1;
    cursor.skipSpace();
    const wrapped = cursor.eat("(");
    const expr = parseOr(cursor);
    cursor.skipSpace();
    if (wrapped) cursor.expect(")");
    cursor.skipSpace();
    cursor.expect("]");
    return { kind: "filter", expr };
  }
  // A slice, or a union of names / indexes.
  const names: (string | number)[] = [];
  const sliceParts: (number | null)[] = [];
  let isSlice = false;
  for (;;) {
    cursor.skipSpace();
    const quote = cursor.peek();
    if (quote === "'" || quote === '"') {
      names.push(readQuoted(cursor));
    } else if (cursor.peek() === ":") {
      isSlice = true;
      sliceParts.push(null);
      cursor.at += 1;
      continue;
    } else if (/[-\d]/.test(cursor.peek())) {
      const value = readNumber(cursor);
      cursor.skipSpace();
      if (cursor.peek() === ":") {
        isSlice = true;
        sliceParts.push(value);
        cursor.at += 1;
        continue;
      }
      if (isSlice) sliceParts.push(value);
      else names.push(value);
    } else if (cursor.peek() === "]" && isSlice) {
      sliceParts.push(null);
    } else {
      names.push(readName(cursor));
    }
    cursor.skipSpace();
    if (cursor.eat(",")) continue;
    cursor.expect("]");
    break;
  }
  if (isSlice) {
    const [start = null, end = null, step = null] = sliceParts;
    return { kind: "slice", start, end, step };
  }
  return { kind: "child", names };
}

function readQuoted(cursor: Cursor): string {
  const quote = cursor.peek();
  cursor.at += 1;
  let out = "";
  while (!cursor.done() && cursor.peek() !== quote) {
    if (cursor.peek() === "\\") {
      cursor.at += 1;
      const next = cursor.peek();
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
    } else {
      out += cursor.peek();
    }
    cursor.at += 1;
  }
  cursor.expect(quote);
  return out;
}

function readNumber(cursor: Cursor): number {
  const match = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(cursor.text.slice(cursor.at));
  if (!match) throw new JsonPathError(`Número no válido en la posición ${cursor.at + 1}`);
  cursor.at += match[0].length;
  return Number(match[0]);
}

function parseOr(cursor: Cursor): FilterExpr {
  let left = parseAnd(cursor);
  for (;;) {
    cursor.skipSpace();
    if (!cursor.eat("||")) return left;
    left = { kind: "or", left, right: parseAnd(cursor) };
  }
}

function parseAnd(cursor: Cursor): FilterExpr {
  let left = parseUnary(cursor);
  for (;;) {
    cursor.skipSpace();
    if (!cursor.eat("&&")) return left;
    left = { kind: "and", left, right: parseUnary(cursor) };
  }
}

function parseUnary(cursor: Cursor): FilterExpr {
  cursor.skipSpace();
  if (cursor.peek() === "!" && cursor.peek(1) !== "=") {
    cursor.at += 1;
    return { kind: "not", inner: parseUnary(cursor) };
  }
  if (cursor.peek() === "(") {
    cursor.at += 1;
    const inner = parseOr(cursor);
    cursor.skipSpace();
    cursor.expect(")");
    return inner;
  }
  const left = parseOperand(cursor);
  cursor.skipSpace();
  for (const op of ["==", "!=", "<=", ">=", "=~", "<", ">"] as CompareOp[]) {
    if (cursor.eat(op)) {
      cursor.skipSpace();
      return { kind: "compare", op, left, right: parseOperand(cursor) };
    }
  }
  return { kind: "truthy", operand: left };
}

function parseOperand(cursor: Cursor): Operand {
  cursor.skipSpace();
  const head = cursor.peek();
  if (head === "@" || head === "$") {
    cursor.at += 1;
    return { kind: "path", root: head, segments: parseSegments(cursor, true) };
  }
  if (head === "'" || head === '"') return { kind: "literal", value: readQuoted(cursor) };
  if (head === "/") {
    // A regex literal: `/pattern/flags`.
    cursor.at += 1;
    let source = "";
    while (!cursor.done() && cursor.peek() !== "/") {
      if (cursor.peek() === "\\") {
        source += cursor.peek();
        cursor.at += 1;
      }
      source += cursor.peek();
      cursor.at += 1;
    }
    cursor.expect("/");
    const flags = /^[a-z]*/.exec(cursor.text.slice(cursor.at))?.[0] ?? "";
    cursor.at += flags.length;
    try {
      return { kind: "literal", value: new RegExp(source, flags) };
    } catch (e) {
      throw new JsonPathError(`Expresión regular no válida: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (/[-\d]/.test(head)) return { kind: "literal", value: readNumber(cursor) };
  for (const [word, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    if (cursor.eat(word)) return { kind: "literal", value };
  }
  throw new JsonPathError(`No se entiende «${cursor.text.slice(cursor.at, cursor.at + 12)}» en el filtro`);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evaluate(segments: Segment[], start: unknown[], root: unknown): unknown[] {
  let current = start;
  for (const segment of segments) {
    current = current.flatMap((value) => step(segment, value, root));
  }
  return current;
}

function step(segment: Segment, value: unknown, root: unknown): unknown[] {
  switch (segment.kind) {
    case "child":
      return segment.names.flatMap((name) => childOf(value, name));
    case "wildcard":
      return childrenOf(value);
    case "slice":
      return Array.isArray(value) ? slice(value, segment.start, segment.end, segment.step) : [];
    case "filter":
      return childrenOf(value).filter((item) => test(segment.expr, item, root));
    case "descend":
      return descendants(value).flatMap((node) => step(segment.then, node, root));
  }
}

function childOf(value: unknown, name: string | number): unknown[] {
  if (Array.isArray(value)) {
    const index = typeof name === "number" ? name : /^-?\d+$/.test(name) ? Number(name) : NaN;
    if (Number.isNaN(index)) return name === "length" ? [value.length] : [];
    const at = index < 0 ? value.length + index : index;
    return at >= 0 && at < value.length ? [value[at]] : [];
  }
  if (value !== null && typeof value === "object") {
    const key = String(name);
    return Object.prototype.hasOwnProperty.call(value, key) ? [(value as Record<string, unknown>)[key]] : [];
  }
  return [];
}

function childrenOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.values(value as Record<string, unknown>);
  return [];
}

/** The node itself and everything under it, depth first. */
function descendants(value: unknown): unknown[] {
  const out: unknown[] = [value];
  for (const child of childrenOf(value)) out.push(...descendants(child));
  return out;
}

function slice(list: unknown[], start: number | null, end: number | null, stepBy: number | null): unknown[] {
  const stride = stepBy ?? 1;
  if (stride === 0) throw new JsonPathError("El paso de un rango no puede ser 0");
  const length = list.length;
  const clamp = (n: number) => (n < 0 ? Math.max(0, length + n) : Math.min(n, length));
  const out: unknown[] = [];
  if (stride > 0) {
    for (let i = start === null ? 0 : clamp(start); i < (end === null ? length : clamp(end)); i += stride) out.push(list[i]);
  } else {
    const from = start === null ? length - 1 : Math.min(clamp(start), length - 1);
    const to = end === null ? -1 : clamp(end);
    for (let i = from; i > to; i += stride) out.push(list[i]);
  }
  return out;
}

function test(expr: FilterExpr, item: unknown, root: unknown): boolean {
  switch (expr.kind) {
    case "or":
      return test(expr.left, item, root) || test(expr.right, item, root);
    case "and":
      return test(expr.left, item, root) && test(expr.right, item, root);
    case "not":
      return !test(expr.inner, item, root);
    case "truthy": {
      const values = resolveOperand(expr.operand, item, root);
      return values.length > 0 && values.some((value) => value !== false && value !== null && value !== undefined);
    }
    case "compare": {
      const left = resolveOperand(expr.left, item, root);
      const right = resolveOperand(expr.right, item, root);
      if (left.length === 0 || right.length === 0) return expr.op === "!=" && left.length !== right.length;
      return compare(expr.op, left[0], right[0]);
    }
  }
}

function resolveOperand(operand: Operand, item: unknown, root: unknown): unknown[] {
  if (operand.kind === "literal") return [operand.value];
  return evaluate(operand.segments, [operand.root === "@" ? item : root], root);
}

function compare(op: CompareOp, left: unknown, right: unknown): boolean {
  if (op === "=~") {
    const pattern = right instanceof RegExp ? right : new RegExp(String(right));
    return typeof left === "string" && pattern.test(left);
  }
  if (op === "==") return deepEqual(left, right);
  if (op === "!=") return !deepEqual(left, right);
  if (typeof left === "number" && typeof right === "number") {
    return op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : left >= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : left >= right;
  }
  return false;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

// ---------------------------------------------------------------------------
// Paths as values — what «Guardar en variable…» writes back out
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `["data", 0, "first name"]` → `$.data[0]['first name']`. */
export function pathToJsonPath(path: (string | number)[]): string {
  return path.reduce<string>((out, part) => {
    if (typeof part === "number") return `${out}[${part}]`;
    if (IDENTIFIER.test(part)) return `${out}.${part}`;
    return `${out}['${part.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
  }, "$");
}

/** The same path as a JavaScript accessor chain: `.data[0]["first name"]`. */
export function pathToAccessor(path: (string | number)[]): string {
  return path
    .map((part) => (typeof part === "number" ? `[${part}]` : IDENTIFIER.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`))
    .join("");
}
