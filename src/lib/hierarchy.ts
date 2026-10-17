import { codemapFind, codemapOutline, type FileOutline, type OutlineSymbol, type SymbolHit } from "./tauri/codemapCommands";
import { readFileText, searchRepo, type SearchOptions } from "./tauri/commands";

/**
 * Call and type hierarchies for the editor's «Jerarquía» panel — VS Code's two trees, worked out
 * from what this app already has for every language rather than from one language server:
 *
 * - the repo map's index (`codemap_*`): where a name is declared, and each file's outline (which
 *   function a line sits in);
 * - the project search (`search_repo`): every line that names it.
 *
 * So it is by name, as the map is: two unrelated functions called `load` answer for each other. A
 * language server would know better; this works the same in TypeScript, Python, Go, Rust or Java,
 * and needs nothing running.
 */

export interface HierarchyNode {
  /** Unique within its tree: path, line and name. */
  id: string;
  name: string;
  path: string;
  /** 1-based. */
  line: number;
  /** What the row says beside the name — how many calls, which kind of declaration. */
  detail?: string;
}

export type HierarchyMode = "incoming" | "outgoing" | "supertypes" | "subtypes";

const WORD: SearchOptions = { caseSensitive: true, wholeWord: true, regex: false, include: "", exclude: "" };
const REGEX: SearchOptions = { caseSensitive: true, wholeWord: false, regex: true, include: "", exclude: "" };

/** Words that sit before `(` without being a call. */
const NOT_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "sizeof", "await", "new", "super", "this",
  "def", "fn", "func", "elif", "with", "match", "print", "assert", "lambda", "yield", "throw", "delete", "void", "in",
]);

function nodeOf(name: string, path: string, line: number, detail?: string): HierarchyNode {
  return { id: `${path}:${line}:${name}`, name, path, line, detail };
}

/** Outlines are read once per tree: expanding ten callers in one file asks for it once. */
const outlines = new Map<string, Promise<FileOutline | null>>();
function outlineOf(repo: string, path: string): Promise<FileOutline | null> {
  const key = `${repo}\u0000${path}`;
  let cached = outlines.get(key);
  if (!cached) {
    cached = codemapOutline(repo, path).catch(() => null);
    outlines.set(key, cached);
  }
  return cached;
}

/** A new tree reads the files again: they may have changed since the last one. */
export function resetHierarchyCache() {
  outlines.clear();
}

/** The innermost function, method or class around `line`. */
function enclosing(outline: FileOutline | null, line: number): OutlineSymbol | null {
  if (!outline) return null;
  let best: OutlineSymbol | null = null;
  for (const symbol of outline.symbols) {
    if (symbol.start <= line && line <= symbol.end && (!best || symbol.end - symbol.start <= best.end - best.start)) best = symbol;
  }
  return best;
}

/**
 * Where the tree starts for the word under the caret: its declaration when the index has one — the
 * same file's first — else the caret's own line.
 */
export async function hierarchyRoot(repo: string, word: string, path: string, line: number): Promise<HierarchyNode> {
  const hits = await codemapFind(repo, word).catch(() => [] as SymbolHit[]);
  const exact = hits.filter((hit) => hit.name === word);
  const own = exact.find((hit) => hit.path === path && hit.start <= line && line <= hit.end) ?? exact.find((hit) => hit.path === path) ?? exact[0];
  return own ? nodeOf(own.name, own.path, own.start, own.kind) : nodeOf(word, path, line);
}

/** Who calls `node`: every line calling the name, grouped by the function it sits in. */
async function incoming(repo: string, node: HierarchyNode): Promise<HierarchyNode[]> {
  const found = await searchRepo(repo, node.name, WORD, 2000);
  const call = new RegExp(`\\b${node.name.replace(/[$]/g, "\\$")}\\s*(<[^>()]*>)?\\s*\\(`);
  const groups = new Map<string, { node: HierarchyNode; lines: number[] }>();
  for (const hit of found.hits) {
    if (hit.path === node.path && hit.line_no === node.line) continue;
    if (!call.test(hit.line)) continue;
    // A declaration of the same name (`function load(`, `def load(`) is not a call of it.
    if (new RegExp(`\\b(function|def|fn|func|fun|void|public|private|protected|static)\\s+${node.name}\\b`).test(hit.line)) continue;
    const around = enclosing(await outlineOf(repo, hit.path), hit.line_no);
    const name = around?.name ?? hit.path.split("/").pop() ?? hit.path;
    const line = around?.start ?? hit.line_no;
    const key = `${hit.path}:${line}:${name}`;
    const entry = groups.get(key) ?? { node: nodeOf(name, hit.path, line), lines: [] };
    entry.lines.push(hit.line_no);
    groups.set(key, entry);
  }
  return [...groups.values()].map(({ node: caller, lines }) => ({
    ...caller,
    detail: lines.length === 1 ? `:${lines[0]}` : `${lines.length}× :${lines.join(", :")}`,
  }));
}

/** What `node` calls: the names followed by `(` in its body that the index declares somewhere. */
async function outgoing(repo: string, node: HierarchyNode): Promise<HierarchyNode[]> {
  const outline = await outlineOf(repo, node.path);
  const own = outline?.symbols.find((symbol) => symbol.start === node.line && symbol.name === node.name) ?? enclosing(outline, node.line);
  const text = await readFileText(repo, node.path).catch(() => "");
  const lines = text.split(/\r\n|\r|\n/);
  const body = lines.slice(Math.max(0, (own?.start ?? node.line) - 1), own ? own.end : node.line + 60).join("\n");
  const names: string[] = [];
  for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
    const name = match[1];
    if (name !== node.name && !NOT_CALLS.has(name) && !names.includes(name)) names.push(name);
    if (names.length >= 60) break;
  }
  const out: HierarchyNode[] = [];
  for (const name of names) {
    const hits = (await codemapFind(repo, name).catch(() => [] as SymbolHit[])).filter((hit) => hit.name === name);
    const target = hits.find((hit) => hit.path === node.path) ?? hits[0];
    if (target) out.push(nodeOf(target.name, target.path, target.start, target.kind));
  }
  return out;
}

/** The names in a declaration's heritage clause: `extends A implements B, C`, `class X(A, B)`,
 *  `class X : A, B`, `struct X : A`. */
export function heritageNames(header: string, own: string): string[] {
  const after = header.replace(/\{[\s\S]*$/, "");
  const clauses: string[] = [];
  for (const match of after.matchAll(/\b(?:extends|implements)\b([^{]*)/g)) clauses.push(match[1]);
  const python = new RegExp(`\\bclass\\s+${own}\\s*\\(([^)]*)\\)`).exec(after);
  if (python) clauses.push(python[1]);
  const colon = new RegExp(`\\b(?:class|struct|interface|record|object)\\s+${own}\\b[^:{(]*:([^{]*)`).exec(after);
  if (colon) clauses.push(colon[1]);
  const names: string[] = [];
  for (const clause of clauses) {
    for (const match of clause.replace(/<[^>]*>/g, "").matchAll(/\b([A-Za-z_][\w]*)\b/g)) {
      const name = match[1];
      if (name !== own && !["extends", "implements", "public", "private", "protected", "virtual", "object", "metaclass"].includes(name) && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/** What `node` extends or implements, from its declaration's own line(s), found in the index. */
async function supertypes(repo: string, node: HierarchyNode): Promise<HierarchyNode[]> {
  const text = await readFileText(repo, node.path).catch(() => "");
  const header = text.split(/\r\n|\r|\n/).slice(node.line - 1, node.line + 5).join(" ");
  const names = heritageNames(header, node.name);
  // Rust: the traits implemented for the type, wherever the `impl` is.
  const impls = await searchRepo(repo, `impl(<[^>]*>)?\\s+(\\w+)(<[^>]*>)?\\s+for\\s+${node.name}\\b`, REGEX, 200).catch(() => null);
  for (const hit of impls?.hits ?? []) {
    const trait = /impl(?:<[^>]*>)?\s+(\w+)/.exec(hit.line)?.[1];
    if (trait && !names.includes(trait)) names.push(trait);
  }
  const out: HierarchyNode[] = [];
  for (const name of names) {
    const hits = (await codemapFind(repo, name).catch(() => [] as SymbolHit[])).filter((hit) => hit.name === name);
    const target = hits[0];
    out.push(target ? nodeOf(target.name, target.path, target.start, target.kind) : nodeOf(name, node.path, node.line, "?"));
  }
  return out;
}

/** What extends or implements `node`: declarations whose heritage names it. */
async function subtypes(repo: string, node: HierarchyNode): Promise<HierarchyNode[]> {
  const name = node.name;
  const pattern = [
    `(class|interface|struct|record|object|enum)\\s+\\w+[^{;]*\\b(extends|implements)\\b[^{;]*\\b${name}\\b`,
    `(class|struct|record|interface)\\s+\\w+[^:{;(]*:[^{;]*\\b${name}\\b`,
    `class\\s+\\w+\\s*\\([^)]*\\b${name}\\b`,
    `impl(<[^>]*>)?\\s+${name}(<[^>]*>)?\\s+for\\s+\\w+`,
  ].join("|");
  const found = await searchRepo(repo, pattern, REGEX, 500).catch(() => null);
  const out: HierarchyNode[] = [];
  for (const hit of found?.hits ?? []) {
    const sub = /\bfor\s+(\w+)/.exec(hit.line)?.[1] ?? /\b(?:class|interface|struct|record|object|enum)\s+(\w+)/.exec(hit.line)?.[1];
    if (!sub || sub === name) continue;
    const id = `${hit.path}:${hit.line_no}:${sub}`;
    if (!out.some((n) => n.id === id)) out.push(nodeOf(sub, hit.path, hit.line_no));
  }
  return out;
}

export function hierarchyChildren(repo: string, mode: HierarchyMode, node: HierarchyNode): Promise<HierarchyNode[]> {
  switch (mode) {
    case "incoming":
      return incoming(repo, node);
    case "outgoing":
      return outgoing(repo, node);
    case "supertypes":
      return supertypes(repo, node);
    case "subtypes":
      return subtypes(repo, node);
  }
}
