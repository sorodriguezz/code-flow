/**
 * "Go to definition" without a language server.
 *
 * The honest framing: this is a very good guess, not a resolved symbol table. A real answer needs
 * a language server per language, holding the whole project's types — which is a different piece
 * of software. What this does instead is what a developer does by hand: read the import that
 * brought the name in, work out which file that is, and look for the line that declares it.
 *
 * That covers the overwhelming majority of jumps (an imported function, a class, a type, a local
 * helper) across every language the editor opens, at the cost of being defeated by the things a
 * grep is always defeated by: re-exports through several hops, overloads, and two unrelated files
 * declaring the same name. Ambiguity is handled by *ranking* rather than by picking blindly: every
 * survivor is returned, best first, and the editor jumps to the best one instead of asking.
 */

/** Extensions tried when an import omits one, in resolution order. */
const IMPLICIT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".vue",
  ".svelte",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
];

/** Directory roots an aliased import (`@/lib/x`, `~/lib/x`) might be rooted at, in order. */
const ALIAS_ROOTS = ["src", "app", "lib", ""];

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Collapses `.` and `..` the way a module resolver does, so `a/b/../c` is `a/c`. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Turns an import specifier into a repo file, given every file in the repo.
 *
 * Handles the three shapes that actually appear: relative (`./x`, `../x`), alias (`@/x`, `~/x`,
 * `#/x`), and bare-but-internal (`lib/x` — common in Go and Python). A bare specifier that
 * matches nothing is almost certainly a dependency, and returns `null` rather than guessing.
 */
export function resolveModuleFile(spec: string, fromPath: string, files: readonly string[]): string | null {
  const known = new Set(files);
  const candidatesFor = (base: string): string[] => [
    base,
    ...IMPLICIT_EXTENSIONS.map((ext) => `${base}${ext}`),
    // A directory import resolves to its index/mod file — `./common` meaning `./common/index.ts`.
    ...IMPLICIT_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    `${base}/mod.rs`,
    `${base}/__init__.py`,
  ];

  const bases: string[] = [];
  if (spec.startsWith(".")) {
    bases.push(normalize(`${dirOf(fromPath)}/${spec}`));
  } else {
    const aliased = spec.replace(/^[@~#]\//, "");
    // An alias is a project convention this can't read without a tsconfig, so every plausible
    // root is tried and the ranking below decides.
    for (const root of ALIAS_ROOTS) bases.push(normalize(root ? `${root}/${aliased}` : aliased));
  }

  for (const base of bases) {
    for (const candidate of candidatesFor(base)) {
      if (known.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The module a symbol was imported from in this file, or `null` when it wasn't imported — in
 * which case it's declared locally or somewhere else in the project.
 *
 * Covers ES imports (named, default, namespace), CommonJS destructuring, Python's `from x import
 * y`, and Rust's `use a::b::c`. Deliberately regex-level: parsing four languages properly to
 * answer "where did this name come from" is not worth it when the import line is right there.
 */
export function findImportSource(text: string, symbol: string): string | null {
  const name = escapeRegExp(symbol);

  // import { a, b as c } from "x" / import a from "x" / import * as a from "x"
  const es = new RegExp(
    String.raw`import\s+(?:type\s+)?(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))\s+from\s*['"]([^'"]+)['"]`,
    "g",
  );
  for (const m of text.matchAll(es)) {
    const [, sideDefault, named, namespace, bareDefault, spec] = m;
    if (sideDefault === symbol || namespace === symbol || bareDefault === symbol) return spec;
    // `as` renames: the *local* name is what was clicked, so match the right-hand side.
    if (named) {
      const locals = named.split(",").map((entry) => {
        const parts = entry.trim().split(/\s+as\s+/);
        return (parts[1] ?? parts[0] ?? "").trim().replace(/^type\s+/, "");
      });
      if (locals.includes(symbol)) return spec;
    }
  }

  // const { a } = require("x") / const a = require("x")
  const cjs = new RegExp(String.raw`(?:\{[^}]*\b${name}\b[^}]*\}|\b${name}\b)\s*=\s*require\(\s*['"]([^'"]+)['"]`);
  const cjsMatch = cjs.exec(text);
  if (cjsMatch) return cjsMatch[1];

  // from .module import name  /  from package.module import name
  const py = new RegExp(String.raw`from\s+([\w./]+)\s+import\s+[^\n]*\b${name}\b`);
  const pyMatch = py.exec(text);
  if (pyMatch) return pyMatch[1].replace(/\./g, "/");

  // use crate::a::b::Symbol;
  const rust = new RegExp(String.raw`use\s+([\w:]*)::${name}\b`);
  const rustMatch = rust.exec(text);
  if (rustMatch) return rustMatch[1].replace(/^(crate|self|super)::/, "").replace(/::/g, "/");

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex matching the *declaration* of `symbol`, in syntax the Rust `regex` crate accepts (the
 * repo-search backend compiles it): no lookaround, no backreferences.
 *
 * One pattern across all languages rather than one per language. A declaration keyword followed
 * by the name is a strong enough signal on its own, and a single pattern means a jump works in
 * files this app has no other knowledge of.
 */
export function declarationPattern(symbol: string): string {
  const name = escapeRegExp(symbol);
  return [
    // function/class/const/type/… Symbol — the C-family, TS, Rust, Go, Java, C#, PHP, Swift.
    String.raw`\b(?:function|class|interface|type|enum|struct|trait|impl|record|def|fn|const|let|var|val|static|public|private|protected|abstract|final|module|namespace|package|object|proc|sub)\s+[\w<>\[\],\s]*\b${name}\b`,
    // Symbol = (…) => / Symbol = function / Symbol: (…) => — assigned callables and object members.
    String.raw`\b${name}\s*[:=]\s*(?:async\s+)?(?:function|\(|<)`,
    // export default Symbol / export { Symbol }
    String.raw`export\s+(?:default\s+)?[\w\s{,]*\b${name}\b`,
    // Symbol(…) { — a method or a Go func with a receiver.
    String.raw`\b${name}\s*\([^)]*\)\s*\{`,
  ].join("|");
}

export interface DefinitionHit {
  path: string;
  /** 1-based. */
  line: number;
  /** The matched source line, used only for ranking. */
  text: string;
}

/**
 * Orders candidates so the first one is the jump a developer would have made.
 *
 * The ranking *is* the feature: a grep for a common name returns noise, and picking the first
 * result would send you somewhere arbitrary — and the editor jumps to the top-ranked hit rather
 * than asking, so this order is the answer, not a suggestion. In order of weight: the file the
 * symbol was actually imported from beats everything; then a declaration in the file you're
 * already in, because a name that resolves locally resolves locally; then a real declaration
 * keyword over a bare assignment; then an exported one; then proximity. `self` matches — the line
 * the cursor is already on — are dropped, since "go to definition" that doesn't move is a dead end.
 */
export function rankDefinitions(
  hits: readonly DefinitionHit[],
  options: { symbol: string; fromPath: string; fromLine: number; importedFrom: string | null },
): DefinitionHit[] {
  const declarationKeyword = new RegExp(
    String.raw`\b(?:function|class|interface|type|enum|struct|trait|record|def|fn|impl)\s`,
  );
  const fromDir = dirOf(options.fromPath);

  const scored = hits
    .filter((hit) => !(hit.path === options.fromPath && hit.line === options.fromLine))
    .map((hit) => {
      let score = 0;
      if (options.importedFrom && hit.path === options.importedFrom) score += 100;
      if (declarationKeyword.test(hit.text)) score += 40;
      if (/\bexport\b|\bpub\b|\bpublic\b/.test(hit.text)) score += 15;
      // Big, because scope beats popularity: a helper declared right here is the answer even when
      // some other file exports a better-looking declaration of the same name, and at the old
      // weight it lost to one (`export function x` elsewhere outscored a local `function x`).
      // Deliberately below the import bonus — an explicit `import { x }` means x is *not* declared
      // in this file, so a same-file match is then a coincidence and the import still wins.
      if (hit.path === options.fromPath) score += 70;
      else if (dirOf(hit.path) === fromDir) score += 5;
      // An import line naming the symbol is where it was *brought in*, not declared — useful as
      // a last resort, actively wrong as a first answer.
      if (/^\s*(?:import|from|use)\b/.test(hit.text)) score -= 60;
      // A bare `index` re-export is a hop, not a destination.
      if (/\bexport\s+\*/.test(hit.text)) score -= 30;
      return { hit, score };
    })
    .sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path) || a.hit.line - b.hit.line);

  return scored.map((entry) => entry.hit);
}

/** The module specifier under the cursor when the click landed on an import path, so clicking the
 * `'@/lib/supabase/server'` in an import line opens that file. */
export function moduleSpecifierAt(lineText: string, column: number): string | null {
  if (!/\b(?:import|require|from|use)\b/.test(lineText)) return null;
  for (const match of lineText.matchAll(/['"]([^'"]+)['"]/g)) {
    const start = match.index + 1;
    const end = start + match[1].length;
    // `column` is 1-based and may sit just past the last character.
    if (column >= start && column <= end + 1) return match[1];
  }
  return null;
}
