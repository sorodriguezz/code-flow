/**
 * The Handlebars subset that `pm.visualizer.set(template, data)` templates are rendered with.
 *
 * Postman's visualizer accepts full Handlebars; shipping a real Handlebars runtime here would mean
 * embedding a compiler that builds and evaluates JavaScript from a string the user's test script
 * wrote. `{{value}}`, `{{#each}}` and `{{#if}}` cover what a response visualizer actually does, and
 * a walker over a parsed tree can't execute anything.
 *
 * The output is HTML destined for a sandboxed iframe and never for the app document, but `{{x}}`
 * still escapes on the way out so a value containing markup renders as text rather than silently
 * restructuring the table it sits in. `{{{x}}}` opts out, as in Handlebars.
 */

type Node =
  | { kind: "text"; text: string }
  | { kind: "expr"; path: string; escape: boolean }
  | { kind: "each"; path: string; body: Node[]; empty: Node[] }
  | { kind: "if"; path: string; body: Node[]; alt: Node[] };

/** One level of `#each` nesting: the item plus the `@index`/`@key` that produced it. */
interface Frame {
  value: unknown;
  index?: number;
  key?: string;
}

type Token = { kind: "text"; text: string } | { kind: "tag"; expr: string; escape: boolean };

/** `{{{raw}}}` has to be tried before `{{escaped}}`, or the third brace is eaten as content. */
const TAG = /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g;

export function renderVisualizerTemplate(template: string, data: unknown): string {
  const [nodes] = parse(tokenize(template), 0);
  return render(nodes, [{ value: data }]);
}

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(template); match !== null; match = TAG.exec(template)) {
    if (match.index > last) tokens.push({ kind: "text", text: template.slice(last, match.index) });
    const raw = match[1];
    tokens.push(
      raw === undefined
        ? { kind: "tag", expr: match[2], escape: true }
        : { kind: "tag", expr: raw, escape: false },
    );
    last = match.index + match[0].length;
  }
  if (last < template.length) tokens.push({ kind: "text", text: template.slice(last) });
  return tokens;
}

/**
 * Reads nodes until the token list runs out or a closing/`else` tag is met, and hands the caller
 * back the index it stopped at. An unclosed block therefore renders what it has instead of
 * throwing — a half-rendered table says more about the template than a blank pane does.
 */
function parse(tokens: Token[], start: number): [Node[], number] {
  const nodes: Node[] = [];
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === "text") {
      nodes.push({ kind: "text", text: token.text });
      i += 1;
      continue;
    }
    const expr = token.expr.trim();
    if (expr === "else" || expr.startsWith("/")) return [nodes, i];

    if (expr.startsWith("#each ") || expr.startsWith("#if ")) {
      const isEach = expr.startsWith("#each ");
      const path = expr.slice(isEach ? 6 : 4).trim();
      const [body, afterBody] = parse(tokens, i + 1);
      let alt: Node[] = [];
      let next = afterBody;
      if (isElse(tokens[next])) {
        const [parsed, afterAlt] = parse(tokens, next + 1);
        alt = parsed;
        next = afterAlt;
      }
      // Skip the closing tag when it's there; when it isn't, `next` is already past the end.
      if (next < tokens.length) next += 1;
      nodes.push(isEach ? { kind: "each", path, body, empty: alt } : { kind: "if", path, body, alt });
      i = next;
      continue;
    }

    nodes.push({ kind: "expr", path: expr, escape: token.escape });
    i += 1;
  }
  return [nodes, i];
}

function isElse(token: Token | undefined): boolean {
  return token !== undefined && token.kind === "tag" && token.expr.trim() === "else";
}

function render(nodes: Node[], stack: Frame[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "expr": {
        const text = stringify(lookup(node.path, stack));
        out += node.escape ? escapeHtml(text) : text;
        break;
      }
      case "if": {
        const value = lookup(node.path, stack);
        out += render(truthy(value) ? node.body : node.alt, stack);
        break;
      }
      case "each": {
        const frames = eachFrames(lookup(node.path, stack));
        if (frames.length === 0) {
          out += render(node.empty, stack);
          break;
        }
        for (const frame of frames) out += render(node.body, [...stack, frame]);
        break;
      }
    }
  }
  return out;
}

/** Arrays iterate by `@index`, plain objects by `@key`; anything else iterates zero times. */
function eachFrames(value: unknown): Frame[] {
  if (Array.isArray(value)) return value.map((item, index) => ({ value: item, index }));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).map(([key, item]) => ({ value: item, key }));
  }
  return [];
}

/**
 * Handlebars scoping: a bare name resolves against the innermost `#each` item only, and reaching
 * an enclosing scope needs an explicit `../`. Falling back to the parent when a key is missing
 * would quietly render the wrong row's value.
 */
function lookup(path: string, stack: Frame[]): unknown {
  let expr = path.trim();
  let depth = stack.length - 1;
  while (expr.startsWith("../")) {
    expr = expr.slice(3).trim();
    depth -= 1;
  }
  const frame = stack[Math.max(0, depth)];
  if (expr === "@index") return frame.index;
  if (expr === "@key") return frame.key;
  if (expr === "this" || expr === "." || expr === "") return frame.value;

  let current: unknown = frame.value;
  for (const segment of expr.replace(/^this\./, "").split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Handlebars counts an empty array as falsy; an empty object is still truthy. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/**
 * Objects and arrays print as JSON rather than Handlebars' `[object Object]`: this renders a
 * response someone is trying to read, and the JSON at least shows what was there.
 */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
