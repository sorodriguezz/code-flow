/**
 * What can be written where the caret is, in any field of a node — n8n's expression help, for every
 * field of Flujos — and what a field dragged in from the input becomes there.
 *
 * Pure: it reads a text, a caret and the data the node will see (its input, the other nodes, the
 * variables) and answers with the stretch of text to replace and what could go there. The text
 * inputs (`SmartInput`) and the code editors (Monaco) both ask it, so `$json.` lists the same
 * fields whichever kind of field it is typed in.
 *
 * **A field is read the way the engine reads it** (its dialect):
 * - `expression` — n8n's: text with `{{ js }}` pieces. Every field in expression mode, and the code
 *   fields the engine resolves (a shell script, a JSON body). Inside the braces: `$json`,
 *   `$input`, `$('Nodo')`, `$vars`, `$now`… and the methods `extensions.js` adds.
 * - `jinja` — the Plantilla node: `$json` (or `json`), `$items`, `$vars`, `$now`, the variable of
 *   every `{% for %}` around the caret, `loop`, and the filters after `|`.
 * - `js` — the Code node: an expression's names plus `items`, `item` and `console`.
 * - `python` / `node` — a script fed the items: `items`, and `item` for the first.
 * - `sql` — the SQL node over the items: the table `items`, one column per field.
 */

export type AssistDialect = "expression" | "jinja" | "js" | "python" | "node" | "sql";

export interface AssistField {
  dialect: AssistDialect;
  /** Whether `{{ }}` hold expressions here — every field that can be one, code included. */
  expressions: boolean;
}

export interface AssistNode {
  name: string;
  /** Its output in the newest run, when it is known. */
  output?: unknown[];
}

export interface AssistData {
  /** The node's input items, the newest run's. */
  input: unknown[];
  /** The other nodes, the ones upstream first. */
  nodes: AssistNode[];
  /** The workspace's `$vars`. */
  vars: Record<string, string>;
}

export type SuggestionKind = "field" | "variable" | "function" | "method" | "keyword" | "node" | "snippet";

export interface Suggestion {
  label: string;
  /** What replaces the typed part. */
  insert: string;
  /** Where the caret lands inside `insert`; its end when absent. */
  caret?: number;
  /** A range of its own, when it replaces more than the typed word (`.campo` → `["un campo"]`). */
  from?: number;
  to?: number;
  kind: SuggestionKind;
  /** The value's type mark (`#`, `T`, `[]`…) or a signature. */
  detail?: string;
  /** A field's sample value, short. */
  sample?: string;
  /** Translation key of one line on what it is, and its arguments. */
  doc?: string;
  docArgs?: Record<string, string>;
  /** Ask again right after inserting — the insert leaves a spot meant to be filled. */
  again?: boolean;
}

export interface Completion {
  /** The typed part the suggestions replace, as offsets into the text. */
  from: number;
  to: number;
  items: Suggestion[];
  /** A node the text names whose output is not known yet — fetched, it sharpens the list. */
  wants?: string;
  /** The list is the input's fields, and there is no input yet. */
  noInput?: boolean;
}

const LIMIT = 80;

// ------------------------------------------------------------------------------------- values

export const kindOf = (value: unknown): string =>
  value === null ? "null" : value === undefined ? "undefined" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;

/** The marks the input panel draws beside a field, so a suggestion reads the same. */
export const KIND_MARK: Record<string, string> = {
  string: "T",
  number: "#",
  boolean: "✓",
  object: "{}",
  array: "[]",
  null: "∅",
  undefined: "?",
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function mergeSample(into: unknown, value: unknown, depth: number): unknown {
  if (into === undefined || into === null) return value === undefined ? into : value;
  if (depth > 8) return into;
  if (isRecord(into) && isRecord(value)) {
    const out: Record<string, unknown> = { ...into };
    for (const [key, entry] of Object.entries(value)) out[key] = key in out ? mergeSample(out[key], entry, depth + 1) : entry;
    return out;
  }
  if (Array.isArray(into) && Array.isArray(value) && into.length === 0) return value;
  return into;
}

const samples = new WeakMap<unknown[], unknown>();

/** One value standing for a list's elements: their fields merged, the first sample of each kept. */
export function sampleOf(list: unknown[]): unknown {
  if (samples.has(list)) return samples.get(list);
  let out: unknown = undefined;
  for (const entry of list.slice(0, 25)) out = mergeSample(out, entry, 0);
  samples.set(list, out);
  return out;
}

function preview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A path as JavaScript reads it from `root`: dots where they are safe, brackets where not. */
export function jsPath(root: string, path: (string | number)[]): string {
  let out = root;
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else if (IDENT.test(part)) out += `.${part}`;
    else out += `[${JSON.stringify(part)}]`;
  }
  return out;
}

/** A path as Python reads it from `root`: `item["stats"][0]["base_stat"]`. */
function pyPath(root: string, path: (string | number)[]): string {
  return root + path.map((part) => (typeof part === "number" ? `[${part}]` : `[${JSON.stringify(part)}]`)).join("");
}

// ------------------------------------------------------------------------------------- shapes

/** What a piece of an expression stands for, as far as the help can tell. */
type Shape =
  | { k: "json"; v: unknown; input?: boolean }
  | { k: "obj"; members: Member[] }
  | { k: "list"; of: Shape }
  | { k: "date" }
  | { k: "fn"; ret: (arg: Arg) => Shape | null }
  | { k: "any" };

type Arg = string | number | undefined;

interface Member {
  name: string;
  kind: SuggestionKind;
  /** A property's value. */
  get?: () => Shape | null;
  /** What calling it gives — it is a method or function. */
  call?: (arg: Arg) => Shape | null;
  /** The arguments it takes, shown and inserted (`(decimals)`). */
  sig?: string;
  doc?: string;
  docArgs?: Record<string, string>;
  /** Shown under another label than its name (`$('Nodo')`). */
  label?: string;
  insert?: string;
  caret?: number;
}

const json = (v: unknown): Shape => ({ k: "json", v });
const ANY: Shape = { k: "any" };
const DATE: Shape = { k: "date" };
const STR = json("");
const NUM = json(0);
const BOOL = json(true);

function elementOf(shape: Shape): Shape | null {
  if (shape.k === "list") return shape.of;
  if (shape.k === "json" && Array.isArray(shape.v)) return json(sampleOf(shape.v));
  return null;
}

/** A value's methods: `[name, signature, what it gives]`. `@` is the value itself, `^` its element. */
type MethodRow = [string, string, Shape | "@" | "^"];

const JS_STRING: MethodRow[] = [
  ["toUpperCase", "()", STR],
  ["toLowerCase", "()", STR],
  ["trim", "()", STR],
  ["split", "(separator)", json([""])],
  ["replace", "(find, replaceWith)", STR],
  ["replaceAll", "(find, replaceWith)", STR],
  ["includes", "(text)", BOOL],
  ["startsWith", "(text)", BOOL],
  ["endsWith", "(text)", BOOL],
  ["slice", "(start, end)", STR],
  ["substring", "(start, end)", STR],
  ["indexOf", "(text)", NUM],
  ["padStart", "(length, fill)", STR],
  ["padEnd", "(length, fill)", STR],
  ["repeat", "(count)", STR],
  ["at", "(index)", STR],
  ["match", "(regex)", ANY],
  ["trimStart", "()", STR],
  ["trimEnd", "()", STR],
  ["normalize", "()", STR],
  ["localeCompare", "(other)", NUM],
];
const EXT_STRING: MethodRow[] = [
  ["isEmpty", "()", BOOL],
  ["isNotEmpty", "()", BOOL],
  ["isBlank", "()", BOOL],
  ["extractEmail", "()", STR],
  ["extractUrl", "()", STR],
  ["extractDomain", "()", STR],
  ["extractUrlPath", "()", STR],
  ["isEmail", "()", BOOL],
  ["isUrl", "()", BOOL],
  ["isDomain", "()", BOOL],
  ["isNumeric", "()", BOOL],
  ["toNumber", "()", NUM],
  ["toInt", "()", NUM],
  ["toFloat", "()", NUM],
  ["toBoolean", "()", BOOL],
  ["toDateTime", "(format)", DATE],
  ["toTitleCase", "()", STR],
  ["toSentenceCase", "()", STR],
  ["toSnakeCase", "()", STR],
  ["toKebabCase", "()", STR],
  ["toCamelCase", "()", STR],
  ["removeTags", "()", STR],
  ["removeMarkdown", "()", STR],
  ["replaceSpecialChars", "()", STR],
  ["quote", "(mark)", STR],
  ["urlEncode", "()", STR],
  ["urlDecode", "()", STR],
  ["base64Encode", "()", STR],
  ["base64Decode", "()", STR],
  ["parseJson", "()", ANY],
  ["toJsonString", "()", STR],
];
const JS_NUMBER: MethodRow[] = [
  ["toFixed", "(digits)", STR],
  ["toString", "()", STR],
  ["toLocaleString", "(locale)", STR],
];
const EXT_NUMBER: MethodRow[] = [
  ["round", "(decimals)", NUM],
  ["floor", "()", NUM],
  ["ceil", "()", NUM],
  ["abs", "()", NUM],
  ["isEven", "()", BOOL],
  ["isOdd", "()", BOOL],
  ["isInteger", "()", BOOL],
  ["toBoolean", "()", BOOL],
  ["toDateTime", "(unit)", DATE],
  ["format", "(locale)", STR],
];
const JS_ARRAY: MethodRow[] = [
  ["join", "(separator)", STR],
  ["map", "(item => …)", ANY],
  ["filter", "(item => …)", "@"],
  ["find", "(item => …)", "^"],
  ["some", "(item => …)", BOOL],
  ["every", "(item => …)", BOOL],
  ["includes", "(value)", BOOL],
  ["indexOf", "(value)", NUM],
  ["slice", "(start, end)", "@"],
  ["concat", "(other)", "@"],
  ["reduce", "((total, item) => …, start)", ANY],
  ["sort", "()", "@"],
  ["reverse", "()", "@"],
  ["flat", "()", ANY],
  ["at", "(index)", "^"],
];
const EXT_ARRAY: MethodRow[] = [
  ["first", "()", "^"],
  ["last", "()", "^"],
  ["isEmpty", "()", BOOL],
  ["isNotEmpty", "()", BOOL],
  ["pluck", "(field)", ANY],
  ["unique", "()", "@"],
  ["removeDuplicates", "()", "@"],
  ["sum", "()", NUM],
  ["average", "()", NUM],
  ["min", "()", NUM],
  ["max", "()", NUM],
  ["compact", "()", "@"],
  ["chunk", "(size)", ANY],
  ["difference", "(other)", "@"],
  ["intersection", "(other)", "@"],
  ["union", "(other)", "@"],
  ["randomItem", "()", "^"],
  ["merge", "()", ANY],
  ["smartJoin", "(keyField, valueField)", ANY],
  ["toJsonString", "()", STR],
];
const EXT_OBJECT: MethodRow[] = [
  ["isEmpty", "()", BOOL],
  ["isNotEmpty", "()", BOOL],
  ["hasField", "(name)", BOOL],
  ["removeField", "(name)", "@"],
  ["removeFieldsContaining", "(value)", "@"],
  ["keepFieldsContaining", "(value)", "@"],
  ["compact", "()", "@"],
  ["toJsonString", "()", STR],
  ["urlEncode", "()", STR],
];
const DATE_METHODS: MethodRow[] = [
  ["toFormat", "(format)", STR],
  ["toISO", "()", STR],
  ["toISODate", "()", STR],
  ["plus", "({ days: 1 })", DATE],
  ["minus", "({ days: 1 })", DATE],
  ["startOf", "(unit)", DATE],
  ["endOf", "(unit)", DATE],
  ["setZone", "(zone)", DATE],
  ["diff", "(other, unit)", ANY],
  ["toMillis", "()", NUM],
  ["toSeconds", "()", NUM],
  ["toRelative", "()", STR],
  ["format", "(pattern)", STR],
  ["beginningOf", "(unit)", DATE],
  ["endOfMonth", "()", DATE],
  ["extract", "(part)", NUM],
  ["isBetween", "(start, end)", BOOL],
  ["isWeekend", "()", BOOL],
  ["isInLast", "(amount, unit)", BOOL],
];
const DATE_PROPS = ["year", "month", "day", "hour", "minute", "second", "weekday", "weekdayLong", "monthLong", "zoneName"];

function methodMembers(rows: MethodRow[], self: Shape): Member[] {
  return rows.map(([name, sig, ret]) => ({
    name,
    kind: "method" as const,
    sig,
    call: () => (ret === "@" ? self : ret === "^" ? elementOf(self) : ret),
  }));
}

/** What a value offers after a dot: its fields first, then what can be called on it. */
function membersOf(shape: Shape, dialect: AssistDialect): Member[] {
  const extended = dialect === "expression" || dialect === "js";
  if (shape.k === "obj") return shape.members;
  if (shape.k === "date") {
    return [
      ...DATE_PROPS.map((name): Member => ({ name, kind: "field", get: () => (name.endsWith("Long") || name === "zoneName" ? STR : NUM) })),
      ...methodMembers(extended ? DATE_METHODS : DATE_METHODS.slice(0, 12), shape),
    ];
  }
  if (shape.k === "list") {
    return [{ name: "length", kind: "field", get: () => NUM }, ...methodMembers(extended ? [...EXT_ARRAY.slice(0, 2), ...JS_ARRAY] : JS_ARRAY, shape)];
  }
  if (shape.k !== "json") return [];
  const value = shape.v;
  if (dialect === "jinja" || dialect === "python") {
    return isRecord(value) ? Object.keys(value).map((name) => fieldMember(name, value[name])) : [];
  }
  if (isRecord(value)) {
    return [...Object.keys(value).map((name) => fieldMember(name, value[name])), ...(extended ? methodMembers(EXT_OBJECT, shape) : [])];
  }
  if (Array.isArray(value)) {
    return [{ name: "length", kind: "field", get: () => json(value.length) }, ...methodMembers(extended ? [...EXT_ARRAY, ...JS_ARRAY] : JS_ARRAY, shape)];
  }
  if (typeof value === "string") {
    return [{ name: "length", kind: "field", get: () => json(value.length) }, ...methodMembers(extended ? [...JS_STRING, ...EXT_STRING] : JS_STRING, shape)];
  }
  if (typeof value === "number") return methodMembers(extended ? [...EXT_NUMBER, ...JS_NUMBER] : JS_NUMBER, shape);
  if (typeof value === "boolean") return methodMembers([["toString", "()", STR]], shape);
  return [];
}

function fieldMember(name: string, value: unknown): Member {
  return { name, kind: "field", get: () => json(value) };
}

/** A member read on a shape: a field of a sample, a virtual member, or a method about to be called. */
function access(shape: Shape, name: string, dialect: AssistDialect): Shape | null {
  if (shape.k === "json" && isRecord(shape.v) && name in shape.v) return json(shape.v[name]);
  const member = membersOf(shape, dialect).find((m) => m.name === name);
  if (!member) return shape.k === "json" && isRecord(shape.v) ? json(undefined) : null;
  if (member.get) return member.get();
  if (member.call) return { k: "fn", ret: member.call };
  return null;
}

function index(shape: Shape, key: Arg): Shape | null {
  if (typeof key === "string") {
    if (shape.k === "json" && isRecord(shape.v)) return json(shape.v[key]);
    if (shape.k === "obj") return access(shape, key, "expression");
    return null;
  }
  return elementOf(shape);
}

// ----------------------------------------------------------------------------------- tokens

interface Token {
  k: "id" | "num" | "str" | "punct";
  v: string;
  /** Offset of its first character. */
  at: number;
  /** A string's text, unquoted. */
  text?: string;
}

interface Scan {
  tokens: Token[];
  /** The text ends inside a string: where its quote is, and what it holds so far. */
  open?: { quote: string; at: number; text: string };
  /** The text ends inside a comment. */
  comment?: boolean;
}

/**
 * The code before the caret as tokens — enough of JavaScript (and of Jinja's and Python's
 * expressions, which read the same at this grain) to find the chain being typed and to know when
 * the caret is inside a string or a comment.
 */
function scan(code: string, comments: "js" | "python" | "none"): Scan {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (comments === "js" && c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      if (end < 0) return { tokens, comment: true };
      i = end + 1;
      continue;
    }
    if (comments === "js" && c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return { tokens, comment: true };
      i = end + 2;
      continue;
    }
    if (comments === "python" && c === "#") {
      const end = code.indexOf("\n", i);
      if (end < 0) return { tokens, comment: true };
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let text = "";
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\" && j + 1 < code.length) {
          text += code[j + 1];
          j += 2;
          continue;
        }
        text += code[j];
        j += 1;
      }
      if (j >= code.length) return { tokens, open: { quote: c, at: i, text } };
      tokens.push({ k: "str", v: code.slice(i, j + 1), at: i, text });
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 200));
    if (id) {
      tokens.push({ k: "id", v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(code.slice(i, i + 50));
    if (num) {
      tokens.push({ k: "num", v: num[0], at: i });
      i += num[0].length;
      continue;
    }
    tokens.push({ k: "punct", v: c, at: i });
    i += 1;
  }
  return { tokens };
}

/** One step of a chain after its root. */
type Step = { k: "name"; name: string } | { k: "index"; key: Arg } | { k: "call"; arg: Arg };

interface Chain {
  root: string;
  steps: Step[];
}

/** The first literal among some tokens — a call's or a bracket's argument. */
function literal(tokens: Token[]): Arg {
  const first = tokens[0];
  if (!first) return undefined;
  if (first.k === "str") return first.text;
  if (first.k === "num" && tokens.length === 1) return Number(first.v);
  return undefined;
}

/** Index of the bracket that opens the one closing at `end`, walking back. */
function opening(tokens: Token[], end: number): number {
  const close = tokens[end].v;
  const open = close === ")" ? "(" : "[";
  let depth = 0;
  for (let j = end; j >= 0; j--) {
    if (tokens[j].k !== "punct") continue;
    if (tokens[j].v === close) depth += 1;
    else if (tokens[j].v === open) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** The chain of names, indexes and calls that ends at token `end` (`$json.stats[0]`, `$('X').item`). */
function chainEndingAt(tokens: Token[], end: number): Chain | null {
  const steps: Step[] = [];
  let j = end;
  while (j >= 0) {
    const token = tokens[j];
    if (token.k === "punct" && (token.v === ")" || token.v === "]")) {
      const start = opening(tokens, j);
      if (start < 0) return null;
      const inner = tokens.slice(start + 1, j);
      steps.unshift(token.v === ")" ? { k: "call", arg: literal(inner) } : { k: "index", key: literal(inner) });
      j = start - 1;
      continue;
    }
    if (token.k === "id") {
      const dotted = j > 0 && tokens[j - 1].k === "punct" && tokens[j - 1].v === ".";
      if (dotted) {
        steps.unshift({ k: "name", name: token.v });
        // `?.` reads as `.`.
        j -= tokens[j - 2]?.k === "punct" && tokens[j - 2].v === "?" ? 3 : 2;
        continue;
      }
      return { root: token.v, steps };
    }
    return null;
  }
  return null;
}

// ------------------------------------------------------------------------------------- scopes

interface Resolve {
  dialect: AssistDialect;
  data: AssistData;
  /** The names of this field, beyond the ones every field of its dialect has — a loop's variable. */
  extra: Map<string, Bound>;
  wants?: string;
}

interface Bound {
  shape: Shape;
  doc?: string;
  docArgs?: Record<string, string>;
}

function inputShape(data: AssistData): Shape {
  return { k: "json", v: sampleOf(data.input), input: true };
}

function nodeOutput(name: string, r: Resolve): Shape {
  const node = r.data.nodes.find((n) => n.name === name);
  if (node?.output) return json(sampleOf(node.output));
  if (node && !r.wants) r.wants = name;
  return ANY;
}

const wrap = (shape: Shape): Shape => ({ k: "obj", members: [{ name: "json", kind: "field", get: () => shape }] });

function nodeProxy(name: string, r: Resolve): Shape {
  const out = () => nodeOutput(name, r);
  const item = () => wrap(out());
  return {
    k: "obj",
    members: [
      { name: "item", kind: "field", get: item, doc: "flows.assist.nodeItem" },
      { name: "first", kind: "method", sig: "()", call: item },
      { name: "last", kind: "method", sig: "()", call: item },
      { name: "all", kind: "method", sig: "()", call: () => ({ k: "list", of: item() }) },
      { name: "itemMatching", kind: "method", sig: "(index)", call: item },
      { name: "json", kind: "field", get: out },
      { name: "isExecuted", kind: "field", get: () => BOOL },
    ],
  };
}

const quoteName = (name: string) => (name.includes("'") ? JSON.stringify(name) : `'${name}'`);

/** The names an expression (or the Code node) starts from, in the order they are worth offering. */
function expressionRoots(r: Resolve): Member[] {
  const { data } = r;
  const input = () => inputShape(data);
  const inputObject: Shape = {
    k: "obj",
    members: [
      { name: "item", kind: "field", get: () => wrap(input()) },
      { name: "all", kind: "method", sig: "()", call: () => ({ k: "list", of: wrap(input()) }) },
      { name: "first", kind: "method", sig: "()", call: () => wrap(input()) },
      { name: "last", kind: "method", sig: "()", call: () => wrap(input()) },
    ],
  };
  const vars: Shape = { k: "obj", members: Object.entries(data.vars).map(([name, value]) => ({ name, kind: "variable", get: () => json(value) })) };
  const nodes: Member[] = data.nodes.map((node) => ({
    name: `$('${node.name}')`,
    label: `$(${quoteName(node.name)})`,
    insert: `$(${quoteName(node.name)})`,
    kind: "node",
    get: () => nodeProxy(node.name, r),
    doc: "flows.assist.node",
  }));
  const fn = (name: string, sig: string, doc: string, ret: Shape): Member => ({ name, kind: "function", sig, doc, call: () => ret });
  const object = (name: string, members: Member[], doc?: string): Member => ({ name, kind: "variable", doc, get: () => ({ k: "obj", members }) });
  const method = (name: string, sig: string, ret: Shape): Member => ({ name, kind: "method", sig, call: () => ret });
  const code = r.dialect === "js";
  const head: Member[] = code
    ? [
        { name: "$input", kind: "variable", doc: "flows.assist.input", get: () => inputObject },
        { name: "$json", kind: "variable", doc: "flows.assist.json", get: input },
        { name: "items", kind: "variable", doc: "flows.assist.items", get: () => ({ k: "list", of: wrap(input()) }) },
        { name: "item", kind: "variable", doc: "flows.assist.item", get: () => wrap(input()) },
      ]
    : [
        { name: "$json", kind: "variable", doc: "flows.assist.json", get: input },
        { name: "$input", kind: "variable", doc: "flows.assist.input", get: () => inputObject },
      ];
  return [
    ...head,
    ...nodes,
    { name: "$vars", kind: "variable", doc: "flows.assist.vars", get: () => vars },
    { name: "$now", kind: "variable", doc: "flows.assist.now", get: () => DATE },
    { name: "$today", kind: "variable", doc: "flows.assist.today", get: () => DATE },
    fn("$if", "(condition, whenTrue, whenFalse)", "flows.assist.if", ANY),
    fn("$ifEmpty", "(value, fallback)", "flows.assist.ifEmpty", ANY),
    fn("$jmespath", "(value, query)", "flows.assist.jmespath", ANY),
    object("$execution", [fieldMember("id", ""), fieldMember("mode", "manual")], "flows.assist.execution"),
    object("$flow", [fieldMember("id", ""), fieldMember("name", ""), fieldMember("active", true)], "flows.assist.flow"),
    { name: "$itemIndex", kind: "variable", doc: "flows.assist.itemIndex", get: () => NUM },
    { name: "$runIndex", kind: "variable", doc: "flows.assist.runIndex", get: () => NUM },
    object("$prevNode", [fieldMember("name", ""), fieldMember("outputIndex", 0), fieldMember("runIndex", 0)], "flows.assist.prevNode"),
    {
      name: "$node",
      kind: "variable",
      doc: "flows.assist.nodeLegacy",
      get: () => ({ k: "obj", members: data.nodes.map((node) => ({ name: node.name, kind: "node" as const, get: () => wrap(nodeOutput(node.name, r)) })) }),
    },
    fn("$min", "(…values)", "flows.assist.min", NUM),
    fn("$max", "(…values)", "flows.assist.max", NUM),
    object(
      "DateTime",
      [
        method("now", "()", DATE),
        method("fromISO", "(text)", DATE),
        method("fromFormat", "(text, format)", DATE),
        method("fromMillis", "(ms)", DATE),
        method("fromSeconds", "(seconds)", DATE),
        method("fromSQL", "(text)", DATE),
        method("local", "(year, month, day)", DATE),
        method("utc", "(year, month, day)", DATE),
      ],
      "flows.assist.dateTime",
    ),
    object("Math", [method("round", "(n)", NUM), method("floor", "(n)", NUM), method("ceil", "(n)", NUM), method("abs", "(n)", NUM), method("min", "(…n)", NUM), method("max", "(…n)", NUM), method("random", "()", NUM)]),
    object("JSON", [method("stringify", "(value)", STR), method("parse", "(text)", ANY)]),
    object("Object", [method("keys", "(object)", json([""])), method("values", "(object)", ANY), method("entries", "(object)", ANY)]),
    ...(code
      ? [object("console", [method("log", "(…values)", ANY), method("warn", "(…values)", ANY), method("error", "(…values)", ANY)])]
      : []),
  ];
}

/** Every name a root can be read by — the offered ones plus the spellings that resolve too. */
function rootShape(name: string, r: Resolve): Shape | null {
  const extra = r.extra.get(name);
  if (extra) return extra.shape;
  if (r.dialect === "jinja") {
    const bare = name.startsWith("$") ? name.slice(1) : name;
    if (bare === "json") return inputShape(r.data);
    if (bare === "items") return json(r.data.input);
    if (bare === "vars") return json(r.data.vars);
    if (bare === "now") return STR;
    return null;
  }
  if (r.dialect === "python") {
    if (name === "item") return inputShape(r.data);
    if (name === "items") return json(r.data.input);
    if (name === "json") return { k: "obj", members: [{ name: "dumps", kind: "method", sig: "(value)", call: () => STR }, { name: "loads", kind: "method", sig: "(text)", call: () => ANY }] };
    return null;
  }
  if (r.dialect === "node") {
    if (name === "item") return inputShape(r.data);
    if (name === "items") return json(r.data.input);
    return null;
  }
  if (r.dialect === "sql") return null;
  if (name === "$") return { k: "fn", ret: (arg) => (typeof arg === "string" ? nodeProxy(arg, r) : null) };
  if (name === "$workflow") name = "$flow";
  const member = expressionRoots(r).find((m) => m.name === name);
  if (!member) return null;
  if (member.get) return member.get();
  if (member.call) return { k: "fn", ret: member.call };
  return null;
}

function resolve(chain: Chain, r: Resolve): Shape | null {
  let shape = rootShape(chain.root, r);
  for (const step of chain.steps) {
    if (!shape) return null;
    if (step.k === "name") shape = access(shape, step.name, r.dialect);
    else if (step.k === "index") shape = index(shape, step.key);
    else shape = shape.k === "fn" ? shape.ret(step.arg) : null;
  }
  return shape;
}

// ------------------------------------------------------------------------------------- ranking

/** The members whose name starts with the typed part, then the ones that hold it. */
function rank<T extends { name: string; label?: string }>(entries: T[], typed: string): T[] {
  if (!typed) return entries.slice(0, LIMIT);
  const needle = typed.toLowerCase();
  const bare = needle.replace(/^\$/, "");
  const key = (entry: T) => (entry.label ?? entry.name).toLowerCase();
  const starts = entries.filter((entry) => key(entry).startsWith(needle) || (bare && key(entry).replace(/^\$\(?'?/, "").startsWith(bare)));
  const holds = entries.filter((entry) => !starts.includes(entry) && bare !== "" && key(entry).includes(bare));
  return [...starts, ...holds].slice(0, LIMIT);
}

function suggestion(member: Member, _dialect: AssistDialect): Suggestion {
  const call = !!member.call && !member.get;
  const sig = member.sig ?? "";
  const takes = call && sig !== "()" && sig !== "";
  const insert = member.insert ?? (call ? `${member.name}()` : member.name);
  const caret = member.caret ?? (member.insert ? undefined : takes ? insert.length - 1 : undefined);
  let detail = sig || undefined;
  let sample: string | undefined;
  if (member.kind === "field" && member.get) {
    const shape = member.get();
    if (shape?.k === "json") {
      detail = KIND_MARK[kindOf(shape.v)];
      sample = preview(shape.v);
    }
  }
  if (member.kind === "variable" && member.get) {
    const shape = member.get();
    if (shape?.k === "json" && shape.v !== undefined) {
      detail = KIND_MARK[kindOf(shape.v)];
      sample = preview(shape.v);
    }
  }
  return { label: member.label ?? member.name, insert, caret, kind: member.kind, detail, sample, doc: member.doc, docArgs: member.docArgs };
}

// ------------------------------------------------------------------------------- the entry point

/** What could go at `caret` in `text`, a field read as `field`. `null` when nothing is worth offering. */
export function complete(text: string, caret: number, field: AssistField, data: AssistData): Completion | null {
  if (field.expressions || field.dialect === "expression") {
    const segment = expressionAt(text, caret);
    if (segment) return completeCode(text, segment.start, caret, { dialect: "expression", data, extra: new Map() });
    if (field.dialect === "expression") return null;
  }
  switch (field.dialect) {
    case "jinja":
      return completeJinja(text, caret, data);
    case "js":
    case "node":
      return completeCode(text, 0, caret, { dialect: field.dialect, data, extra: new Map() });
    case "python":
      return completeCode(text, 0, caret, { dialect: "python", data, extra: pythonLoops(text.slice(0, caret), data) });
    case "sql":
      return completeSql(text, caret, data);
    default:
      return null;
  }
}

/** The end of the word under the caret — a suggestion replaces all of it, not just what is before. */
function wordEnd(text: string, caret: number): number {
  let end = caret;
  while (end < text.length && /[\w$]/.test(text[end])) end += 1;
  return end;
}

/** Where `}}` closes the `{{` opened just before `from` — braces and strings stepped over, as the engine does. */
function findClose(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      if (depth === 0 && text[i + 1] === "}") return i;
      if (depth > 0) depth -= 1;
    }
    i += 1;
  }
  return -1;
}

/** The `{{ … }}` the caret is inside, as the offset its code starts at — `null` outside every one. */
export function expressionAt(text: string, caret: number): { start: number; end: number } | null {
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === "{" && text[i + 1] === "{") {
      const close = findClose(text, i + 2);
      if (close < 0) return caret >= i + 2 ? { start: i + 2, end: text.length } : null;
      if (caret >= i + 2 && caret <= close) return { start: i + 2, end: close };
      i = close + 2;
      continue;
    }
    i += 1;
  }
  return null;
}

/** Code completion: `text` from `start` to `caret` is the code, read in `r.dialect`. */
function completeCode(text: string, start: number, caret: number, r: Resolve): Completion | null {
  const code = text.slice(start, caret);
  const scanned = scan(code, r.dialect === "python" ? "python" : r.dialect === "expression" || r.dialect === "js" || r.dialect === "node" ? "js" : "none");
  if (scanned.comment) return null;
  const { tokens } = scanned;
  const to = wordEnd(text, caret);

  if (scanned.open) {
    // Inside a string: `$('` and `$node["` name a node, `x["` a field of x. Nothing else.
    const open = scanned.open;
    const from = start + open.at + 1;
    const before = tokens.length - 1;
    const closing = (suffix: string) => (text.slice(caret).startsWith(open.quote + suffix) ? "" : open.quote + suffix);
    const last = tokens[before];
    if (last?.k === "punct" && last.v === "(" && tokens[before - 1]?.v === "$" && nodesCallable(r)) {
      const names = rank(r.data.nodes.map((node) => ({ name: node.name })), open.text);
      const tail = closing(")");
      return {
        from,
        to: caret,
        items: names.map((node) => ({ label: node.name, insert: node.name + tail, kind: "node" as const, doc: "flows.assist.node" })),
      };
    }
    if (last?.k === "punct" && last.v === "[") {
      const chain = chainEndingAt(tokens, before - 1);
      const shape = chain ? resolve(chain, r) : null;
      if (!shape) return r.wants ? { from, to: caret, items: [], wants: r.wants } : null;
      const keys = shape.k === "obj" ? shape.members.map((m) => m.name) : shape.k === "json" && isRecord(shape.v) ? Object.keys(shape.v) : [];
      const fields = keys.map((name) => ({ name, member: shape.k === "obj" ? shape.members.find((m) => m.name === name)! : fieldMember(name, (shape as { v: Record<string, unknown> }).v[name]) }));
      const tail = closing("]");
      return {
        from,
        to: caret,
        items: rank(fields, open.text).map(({ member }) => ({ ...suggestion(member, r.dialect), insert: member.name + tail, caret: undefined })),
        wants: r.wants,
        noInput: shape.k === "json" && shape.input && shape.v === undefined,
      };
    }
    return null;
  }

  // The word being typed, and what is before it.
  const lastToken = tokens[tokens.length - 1];
  const typing = lastToken && lastToken.k === "id" && lastToken.at + lastToken.v.length === code.length ? lastToken : null;
  const typed = typing?.v ?? "";
  const from = typing ? start + typing.at : caret;
  const head = typing ? tokens.length - 2 : tokens.length - 1;
  const prev = tokens[head];

  if (prev?.k === "punct" && prev.v === "." && head > 0 && r.dialect !== "sql") {
    const chain = chainEndingAt(tokens, tokens[head - 1].k === "punct" && tokens[head - 1].v === "?" ? head - 2 : head - 1);
    const shape = chain ? resolve(chain, r) : null;
    if (!shape) return r.wants ? { from, to, items: [], wants: r.wants } : null;
    const dot = start + prev.at;
    const members = rank(membersOf(shape, r.dialect), typed);
    const items: Suggestion[] = [];
    // A list's first element, written where the dot is: `stats.` → `stats[0]`.
    if (elementOf(shape) && (!typed || "[0]".includes(typed))) items.push({ label: "[0]", insert: "[0]", from: dot, to, kind: "field", detail: KIND_MARK.object, again: false });
    for (const member of members) {
      const s = suggestion(member, r.dialect);
      if (member.kind === "field" && (r.dialect === "python" || !IDENT.test(member.name)) && shape.k === "json") {
        // Python reads a dict by its key, and a name JavaScript cannot dot needs brackets too.
        items.push({ ...s, insert: `[${JSON.stringify(member.name)}]`, from: dot, to });
      } else {
        items.push(s);
      }
    }
    return { from, to, items, wants: r.wants, noInput: shape.k === "json" && shape.input === true && shape.v === undefined };
  }

  // `$(` with no quote yet: the nodes, quoted.
  if (prev?.k === "punct" && prev.v === "(" && tokens[head - 1]?.v === "$" && !typing && nodesCallable(r)) {
    const tail = text.slice(caret).startsWith(")") ? "" : ")";
    return {
      from: caret,
      to: caret,
      items: r.data.nodes.map((node) => ({ label: node.name, insert: quoteName(node.name) + tail, kind: "node" as const, doc: "flows.assist.node" })),
    };
  }
  if (prev?.k === "punct" && prev.v === "[" && !typing && r.dialect === "python") {
    const chain = chainEndingAt(tokens, head - 1);
    const shape = chain ? resolve(chain, r) : null;
    if (shape?.k === "json" && isRecord(shape.v)) {
      const tail = text.slice(caret).startsWith("]") ? "" : "]";
      return {
        from: caret,
        to: caret,
        items: Object.keys(shape.v).map((name) => ({ ...suggestion(fieldMember(name, (shape.v as Record<string, unknown>)[name]), "python"), insert: JSON.stringify(name) + tail, caret: undefined })),
      };
    }
    return null;
  }

  // A root: only where an operand can start — not right after one, where an operator goes.
  const operand = prev && (prev.k === "num" || prev.k === "str" || (prev.k === "id" && !KEYWORDS.has(prev.v)) || (prev.k === "punct" && (prev.v === ")" || prev.v === "]" || prev.v === ".")));
  if (operand) return null;
  return rootCompletion(typed, from, to, r);
}

/** Words after which an operand starts, in the languages read here. */
const KEYWORDS = new Set(["return", "typeof", "await", "new", "of", "in", "case", "delete", "void", "yield", "else", "do", "throw", "instanceof", "not", "and", "or", "is", "if", "elif", "while", "for", "lambda", "assert", "print"]);

/** Whether `$('Nodo')` means anything here — in an expression or the Code node, not in Jinja or a script. */
const nodesCallable = (r: Resolve) => r.dialect === "expression" || r.dialect === "js";

function rootCompletion(typed: string, from: number, to: number, r: Resolve): Completion | null {
  const roots: Member[] = [];
  for (const [name, bound] of r.extra) roots.push({ name, kind: "variable", get: () => bound.shape, doc: bound.doc, docArgs: bound.docArgs });
  if (r.dialect === "jinja") {
    roots.push(
      { name: "$json", kind: "variable", doc: "flows.assist.json", get: () => inputShape(r.data) },
      { name: "$items", kind: "variable", doc: "flows.assist.jItems", get: () => json(r.data.input) },
      { name: "$vars", kind: "variable", doc: "flows.assist.vars", get: () => json(r.data.vars) },
      { name: "$now", kind: "variable", doc: "flows.assist.jNow", get: () => STR },
    );
  } else if (r.dialect === "python") {
    roots.push(
      { name: "item", kind: "variable", doc: "flows.assist.pyItem", get: () => inputShape(r.data) },
      { name: "items", kind: "variable", doc: "flows.assist.pyItems", get: () => json(r.data.input) },
    );
  } else if (r.dialect === "node") {
    roots.push(
      { name: "item", kind: "variable", doc: "flows.assist.pyItem", get: () => inputShape(r.data) },
      { name: "items", kind: "variable", doc: "flows.assist.pyItems", get: () => json(r.data.input) },
    );
  } else {
    roots.push(...expressionRoots(r));
  }
  const items = rank(roots, typed).map((member) => suggestion(member, r.dialect));
  // A field of the item by its own name: typing `name` offers `$json.name`.
  const bare = typed.replace(/^\$/, "").toLowerCase();
  const sample = sampleOf(r.data.input);
  if (bare && isRecord(sample)) {
    const root = r.dialect === "python" ? "item" : r.dialect === "node" ? "item" : "$json";
    for (const name of Object.keys(sample)) {
      if (!name.toLowerCase().includes(bare)) continue;
      const path = r.dialect === "python" ? pyPath(root, [name]) : jsPath(root, [name]);
      items.push({ label: path, insert: path, kind: "field", detail: KIND_MARK[kindOf(sample[name])], sample: preview(sample[name]) });
    }
  }
  if (!items.length) return null;
  return { from, to, items: items.slice(0, LIMIT) };
}

// ------------------------------------------------------------------------------------- python

/** `for X in <chain>:` lines before the caret: X is an element of the chain. */
function pythonLoops(before: string, data: AssistData): Map<string, Bound> {
  const out = new Map<string, Bound>();
  const r: Resolve = { dialect: "python", data, extra: out };
  for (const match of before.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^:\n]+):/g)) {
    const { tokens } = scan(match[2], "python");
    const chain = tokens.length ? chainEndingAt(tokens, tokens.length - 1) : null;
    const shape = chain ? resolve(chain, r) : null;
    const element = shape ? elementOf(shape) : null;
    if (element) out.set(match[1], { shape: element, doc: "flows.assist.loopVar", docArgs: { list: match[2].trim() } });
  }
  return out;
}

// -------------------------------------------------------------------------------------- jinja

interface JinjaTag {
  kind: "{" | "%" | "#";
  /** The offset of the code inside it. */
  start: number;
  /** Where its closing pair is (the text's end when it never closes). */
  end: number;
}

/** The tags of a template, in order — strings stepped over, raw blocks read as text. */
function jinjaTags(text: string): JinjaTag[] {
  const tags: JinjaTag[] = [];
  let raw = false;
  let i = 0;
  while (i < text.length - 1) {
    const kind = text[i + 1];
    if (text[i] !== "{" || (kind !== "{" && kind !== "%" && kind !== "#") || (raw && kind !== "%")) {
      i += 1;
      continue;
    }
    const close = kind === "{" ? "}" : kind;
    let j = i + 2;
    let depth = 0;
    let end = -1;
    while (j < text.length) {
      const c = text[j];
      if (!raw && kind !== "#" && (c === '"' || c === "'")) {
        j += 1;
        while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
        j += 1;
        continue;
      }
      if (!raw && kind !== "#" && c === "{") depth += 1;
      else if (c === "}" && depth > 0) depth -= 1;
      else if (c === close && text[j + 1] === "}") {
        end = j;
        break;
      }
      j += 1;
    }
    const tag: JinjaTag = { kind: kind as JinjaTag["kind"], start: i + 2, end: end < 0 ? text.length : end };
    const word = statementWord(text.slice(tag.start, tag.end));
    if (kind === "%" && word === (raw ? "endraw" : "raw")) raw = !raw;
    else if (!raw) tags.push(tag);
    if (end < 0) break;
    i = end + 2;
  }
  return tags;
}

function statementWord(code: string): string {
  return /^[-+]?\s*([A-Za-z_]\w*)/.exec(code)?.[1] ?? "";
}

/** Where the filters of an expression start: the last `|` outside strings and brackets. */
function lastPipe(code: string): number {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "|" && depth === 0) at = i;
  }
  return at;
}

/** A Jinja expression with its filters cut off — what a `for` walks. */
function jinjaChain(code: string): Chain | null {
  const { tokens, open } = scan(code.slice(0, firstPipe(code)), "none");
  if (open || !tokens.length) return null;
  return chainEndingAt(tokens, tokens.length - 1);
}

function firstPipe(code: string): number {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "|" && depth === 0) return i;
  }
  return code.length;
}

interface JinjaBlock {
  word: "for" | "if";
  /** A `for`'s variables and what they walk. */
  vars?: string[];
  source?: string;
}

/** The blocks still open at `caret`, outermost first, and the names `{% set %}` gave before it. */
function jinjaScope(text: string, caret: number, data: AssistData): { open: JinjaBlock[]; names: Map<string, Bound> } {
  const open: JinjaBlock[] = [];
  const names = new Map<string, Bound>();
  const r: Resolve = { dialect: "jinja", data, extra: names };
  for (const tag of jinjaTags(text)) {
    if (tag.end + 2 > caret || tag.kind !== "%") {
      if (tag.start >= caret) break;
      continue;
    }
    const code = text.slice(tag.start, tag.end).replace(/^[-+]/, "").replace(/[-+]$/, "").trim();
    const word = statementWord(code);
    if (word === "for") {
      const match = /^for\s+([\w\s,]+?)\s+in\s+([\s\S]+?)(?:\s+if\s+[\s\S]*)?(?:\s+recursive)?$/.exec(code);
      const vars = match ? match[1].split(",").map((v) => v.trim()).filter(Boolean) : [];
      open.push({ word: "for", vars, source: match?.[2] });
      if (match) bindLoop(vars, match[2], r);
    } else if (word === "endfor") {
      const at = open.map((b) => b.word).lastIndexOf("for");
      if (at >= 0) {
        for (const name of open[at].vars ?? []) names.delete(name);
        open.splice(at);
      }
    } else if (word === "if") {
      open.push({ word: "if" });
    } else if (word === "endif") {
      const at = open.map((b) => b.word).lastIndexOf("if");
      if (at >= 0) open.splice(at);
    } else if (word === "set") {
      const match = /^set\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(code);
      const chain = match ? jinjaChain(match[2]) : null;
      const shape = chain ? resolve(chain, r) : null;
      if (match && shape) names.set(match[1], { shape });
    }
  }
  return { open, names };
}

function bindLoop(vars: string[], source: string, r: Resolve): void {
  const chain = jinjaChain(source);
  const shape = chain ? resolve(chain, r) : null;
  if (!shape) return;
  const filters = source.slice(firstPipe(source));
  const docArgs = { list: source.trim() };
  if (vars.length === 2 && shape.k === "json" && isRecord(shape.v) && /\|\s*(items|dictsort)\b/.test(filters)) {
    r.extra.set(vars[0], { shape: STR, doc: "flows.assist.loopKey", docArgs });
    r.extra.set(vars[1], { shape: json(sampleOf(Object.values(shape.v))), doc: "flows.assist.loopVar", docArgs });
    return;
  }
  const element = elementOf(shape);
  if (element && vars[0]) r.extra.set(vars[0], { shape: element, doc: "flows.assist.loopVar", docArgs });
}

/** Jinja's filters, as written after `|`. */
const FILTERS: [string, string, number?][] = [
  ["length", "length"],
  ["upper", "upper"],
  ["lower", "lower"],
  ["title", "title"],
  ["capitalize", "capitalize"],
  ["trim", "trim"],
  ["default", 'default("")', 9],
  ["join", 'join(", ")'],
  ["replace", 'replace("", "")', 9],
  ["round", "round(2)"],
  ["int", "int"],
  ["float", "float"],
  ["string", "string"],
  ["first", "first"],
  ["last", "last"],
  ["sort", "sort"],
  ["reverse", "reverse"],
  ["unique", "unique"],
  ["sum", "sum"],
  ["min", "min"],
  ["max", "max"],
  ["abs", "abs"],
  ["list", "list"],
  ["items", "items"],
  ["dictsort", "dictsort"],
  ["map", 'map(attribute="")', 15],
  ["selectattr", 'selectattr("")', 12],
  ["rejectattr", 'rejectattr("")', 12],
  ["groupby", 'groupby("")', 9],
  ["select", 'select("odd")'],
  ["reject", 'reject("odd")'],
  ["batch", "batch(3)"],
  ["slice", "slice(3)"],
  ["split", 'split(" ")'],
  ["lines", "lines"],
  ["indent", "indent(2)"],
  ["attr", 'attr("")', 6],
  ["bool", "bool"],
  ["count", "count"],
  ["escape", "escape"],
  ["safe", "safe"],
  ["pprint", "pprint"],
];

const TESTS = ["defined", "undefined", "none", "number", "string", "mapping", "sequence", "odd", "even", "true", "false", "in", "startingwith", "endingwith"];

function completeJinja(text: string, caret: number, data: AssistData): Completion | null {
  const tags = jinjaTags(text);
  const tag = tags.find((t) => caret >= t.start && caret <= t.end);
  const { open, names } = jinjaScope(text, caret, data);
  const r: Resolve = { dialect: "jinja", data, extra: names };
  const inFor = open.some((block) => block.word === "for");
  if (inFor) names.set("loop", { shape: loopShape(), doc: "flows.assist.loop" });

  if (!tag) {
    // Text, right after a `{`: the three ways a template says something.
    if (text[caret - 1] !== "{" || text[caret - 2] === "{") return null;
    const swallow = text[caret] === "}" ? 1 : 0;
    const items: Suggestion[] = [
      { label: "{{ … }}", insert: "{{  }}", caret: 3, kind: "snippet", doc: "flows.assist.exprSnippet", again: true },
      { label: "{% for … %}", insert: "{% for x in  %}\n\n{% endfor %}", caret: 12, kind: "snippet", doc: "flows.assist.forSnippet", again: true },
      { label: "{% if … %}", insert: "{% if  %}\n\n{% endif %}", caret: 6, kind: "snippet", doc: "flows.assist.ifSnippet", again: true },
    ];
    return { from: caret - 1, to: caret + swallow, items };
  }
  if (tag.kind === "#") return null;
  const code = text.slice(tag.start, caret);
  if (tag.kind === "%") {
    const body = code.replace(/^[-+]/, "");
    // The statement's first word.
    const keyword = /^\s*([A-Za-z_]\w*)?$/.exec(body);
    if (keyword) {
      const typed = keyword[1] ?? "";
      const from = caret - typed.length;
      const inside = (word: string) => open.length > 0 && open[open.length - 1].word === word;
      const words: Suggestion[] = [
        ...(inside("for") ? [kw("endfor")] : []),
        ...(inside("if") ? [kw("elif "), kw("else"), kw("endif")] : []),
        { label: "for … in …", insert: "for x in ", kind: "keyword", doc: "flows.assist.forSnippet", again: true },
        { label: "if …", insert: "if ", kind: "keyword", doc: "flows.assist.ifSnippet", again: true },
        kw("set "),
        ...(inside("for") ? [] : [kw("endfor")]),
        ...(inside("if") ? [] : [kw("elif "), kw("else"), kw("endif")]),
        kw("raw"),
        kw("endraw"),
      ];
      const items = words.filter((w) => w.label.startsWith(typed) || w.insert.startsWith(typed));
      return items.length ? { from, to: wordEnd(text, caret), items } : null;
    }
    // After `for x in`, `if`, `elif`, `set x =`: an expression.
    const lead = /^\s*(?:for\s+[\w\s,]+?\s+in\s|if\s|elif\s|set\s+[A-Za-z_]\w*\s*=)/.exec(body);
    if (!lead) return null;
    return jinjaExpression(text, caret - body.length + lead[0].length, caret, r);
  }
  return jinjaExpression(text, tag.start, caret, r);
}

function kw(word: string): Suggestion {
  return { label: word.trim(), insert: word, kind: "keyword" };
}

function loopShape(): Shape {
  const n = (name: string): Member => ({ name, kind: "field", get: () => NUM });
  const b = (name: string): Member => ({ name, kind: "field", get: () => BOOL });
  return { k: "obj", members: [n("index"), n("index0"), b("first"), b("last"), n("length"), n("revindex"), n("revindex0"), { name: "previtem", kind: "field", get: () => ANY }, { name: "nextitem", kind: "field", get: () => ANY }, n("depth")] };
}

function jinjaExpression(text: string, start: number, caret: number, r: Resolve): Completion | null {
  const code = text.slice(start, caret);
  const pipe = lastPipe(code);
  if (pipe >= 0) {
    // Typing a filter: `x|up` — the word right after the last `|`, nothing else since.
    const after = code.slice(pipe + 1);
    const filter = /^\s*([A-Za-z_]\w*)?$/.exec(after);
    if (filter) {
      const typed = filter[1] ?? "";
      const from = caret - typed.length;
      const items = FILTERS.filter(([name]) => name.startsWith(typed)).map(([name, insert, at]) => ({
        label: name,
        insert,
        caret: at,
        kind: "function" as const,
        detail: insert.includes("(") ? insert.slice(name.length) : undefined,
      }));
      return items.length ? { from, to: wordEnd(text, caret), items } : null;
    }
  }
  const test = /\bis\s+(not\s+)?([A-Za-z_]\w*)?$/.exec(code);
  if (test) {
    const typed = test[2] ?? "";
    const items = TESTS.filter((name) => name.startsWith(typed)).map((name) => ({ label: name, insert: name, kind: "keyword" as const }));
    return items.length ? { from: caret - typed.length, to: wordEnd(text, caret), items } : null;
  }
  return completeCode(text, start, caret, r);
}

// ---------------------------------------------------------------------------------------- sql

function completeSql(text: string, caret: number, data: AssistData): Completion | null {
  const before = text.slice(0, caret);
  // Inside a string or after `--`: nothing.
  if ((before.match(/'/g)?.length ?? 0) % 2 === 1 || /--[^\n]*$/.test(before)) return null;
  const typed = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? "";
  const from = caret - typed.length;
  const sample = sampleOf(data.input);
  const columns = isRecord(sample) ? Object.keys(sample) : [];
  const quote = (name: string) => (/^[A-Za-z_]\w*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
  const items: Suggestion[] = [];
  const dotted = before.slice(0, from).endsWith(".");
  if (!dotted) items.push({ label: "items", insert: "items", kind: "variable", doc: "flows.assist.table" });
  for (const name of columns) {
    const value = (sample as Record<string, unknown>)[name];
    items.push({ label: name, insert: quote(name), kind: "field", detail: KIND_MARK[kindOf(value)], sample: preview(value) });
  }
  const ranked = rank(items.map((item) => ({ ...item, name: item.label })), typed);
  return ranked.length ? { from, to: wordEnd(text, caret), items: ranked, noInput: columns.length === 0 && data.input.length === 0 } : null;
}

// --------------------------------------------------------------------------------------- drops

/**
 * What a field dragged in from the input becomes at `at` in `text`: the same path, written the way
 * the field reads it. `expression` says it opened a `{{ }}` — a field that is not one yet must
 * become one for it to mean anything.
 */
export function dropText(path: (string | number)[], field: AssistField, text: string, at: number): { insert: string; expression: boolean } | null {
  const inBraces = (field.expressions || field.dialect === "expression") && expressionAt(text, at) !== null;
  if (inBraces) return { insert: jsPath("$json", path), expression: false };
  switch (field.dialect) {
    case "expression":
      return { insert: `{{ ${jsPath("$json", path)} }}`, expression: true };
    case "js":
      return { insert: jsPath("$json", path), expression: false };
    case "node":
      return { insert: jsPath("item", path), expression: false };
    case "python":
      return { insert: pyPath("item", path), expression: false };
    case "sql": {
      const [column, ...rest] = path;
      if (typeof column !== "string") return null;
      const name = /^[A-Za-z_]\w*$/.test(column) ? column : `"${column.replace(/"/g, '""')}"`;
      if (!rest.length) return { insert: name, expression: false };
      return { insert: `json_extract(${name}, '${jsPath("$", rest)}')`, expression: false };
    }
    case "jinja": {
      const tags = jinjaTags(text);
      const inside = tags.some((tag) => tag.kind !== "#" && at >= tag.start && at <= tag.end);
      const written = jinjaPath(path, text, at);
      return { insert: inside ? written : `{{ ${written} }}`, expression: false };
    }
  }
}

/** A path inside a template — through the variable of a `{% for %}` that walks part of it, if one does. */
function jinjaPath(path: (string | number)[], text: string, at: number): string {
  const { open } = jinjaScope(text, at, { input: [], nodes: [], vars: {} });
  for (let i = open.length - 1; i >= 0; i--) {
    const block = open[i];
    if (block.word !== "for" || !block.source || !block.vars?.length || block.vars.length > 1) continue;
    const chain = jinjaChain(block.source);
    // `{% for i in $items %}`: inside it, a field of the item is the variable's.
    if (chain && (chain.root === "$items" || chain.root === "items") && !chain.steps.length) return jsPath(block.vars[0], path);
    const walked = chain && (chain.root === "$json" || chain.root === "json") ? chainPath(chain) : null;
    if (!walked) continue;
    const covers = walked.every((part, k) => path[k] === part) && typeof path[walked.length] === "number";
    if (covers) return jsPath(block.vars[0], path.slice(walked.length + 1));
  }
  return jsPath("$json", path);
}

function chainPath(chain: Chain): (string | number)[] | null {
  const out: (string | number)[] = [];
  for (const step of chain.steps) {
    if (step.k === "name") out.push(step.name);
    else if (step.k === "index" && step.key !== undefined) out.push(step.key);
    else return null;
  }
  return out;
}

/**
 * The `}}` that `{{` should come with: typing the second brace of `{{` in a field, the caret lands
 * between `{{ ` and ` }}`, as in n8n. `null` when the text after it already closes.
 */
export function autoClose(text: string, caret: number): { text: string; caret: number } | null {
  if (text.slice(caret - 2, caret) !== "{{" || text[caret - 3] === "{") return null;
  if (/^\s*\}\}/.test(text.slice(caret))) return null;
  return { text: `${text.slice(0, caret)}  }}${text.slice(caret)}`, caret: caret + 1 };
}
