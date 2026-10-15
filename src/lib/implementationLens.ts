/**
 * "N implementations" / "Implements X" / "Overrides X.m" — the pure half of the editor's
 * implementation lenses (the Monaco half is `components/editor/implementationLens.ts`).
 *
 * Two questions, asked per type and per member, the way VS Code draws them:
 *
 * - **Down**: on an interface, an abstract class or a class something extends — and on each of its
 *   members — how many implementations there are, and where.
 * - **Up**: on a class that `extends`/`implements` something — and on each member that matches one
 *   of the base's by name — which type or member it implements or overrides.
 *
 * What a *type* resolves to (its subtypes, the declaration an `extends` name points at) is the
 * engine's to answer: tsserver, a language server, or a repo-wide text search when neither is
 * running. Everything else is here and is text: where the types and members of a file are, and
 * what its heritage clauses name. That is what keeps one engine-agnostic computation working for
 * TypeScript, Java, Kotlin, C#, PHP, Dart, Swift, Scala, C++, Rust traits and Go interfaces alike —
 * and what makes "a member implements the base's member" a name match, which is what it is in
 * every one of those languages short of overloads.
 */

export interface Loc {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export type TypeKind = "interface" | "abstract" | "class" | "impl";

export interface MemberDecl {
  name: string;
  line: number;
  column: number;
}

export interface HeritageRef {
  /** The last segment of the name as written — `Base` in `ns.Base<T>`. */
  name: string;
  /** `inherits` is the `:` form (Kotlin, C#, Swift, C++), which does not say which of the two. */
  relation: "extends" | "implements" | "inherits";
  line: number;
  column: number;
}

export interface TypeDecl {
  name: string;
  kind: TypeKind;
  /** The line of the declaring keyword — where the lens goes. */
  line: number;
  nameLine: number;
  nameColumn: number;
  /** The line of the body's opening brace: the heritage clauses are on `line..headerEndLine`. */
  headerEndLine: number;
  endLine: number;
  heritage: HeritageRef[];
  members: MemberDecl[];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Whether `'…'` is a string in this file's language — otherwise it is a char literal at most, and a
 *  lone `'` (a Rust lifetime) is just a character. */
export function singleQuoteStringsFor(path: string): boolean {
  return /\.(m?[jt]sx?|c[jt]s|php|dart|py|rb|lua|sh)$/i.test(path);
}

/**
 * The text with every comment and string literal replaced by spaces, newlines kept — so offsets,
 * lines and columns still match the original and a `{` inside a string balances nothing.
 */
export function blankNonCode(text: string, singleQuoteStrings: boolean): string {
  const out = text.split("");
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      const j = end < 0 ? n : end + 3;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "`" || (c === "'" && singleQuoteStrings)) {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n" && c !== "`") break;
        j++;
      }
      j = Math.min(n, j + 1);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'") {
      const literal = /^'(?:\\[^'\n]{1,8}|[^\\'\n])'/.exec(text.slice(i, i + 12));
      if (literal) {
        blank(i, i + literal[0].length);
        i += literal[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** 1-based line and column of an offset. */
function locate(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

/** Same length, with everything inside `(...)` and `<...>` blanked — Kotlin's `B()`, generics. */
function blankGroups(header: string): string {
  let paren = 0;
  let angle = 0;
  let out = "";
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    const inside = paren > 0 || angle > 0;
    if (c === "(") paren++;
    else if (c === ")" && paren > 0) paren--;
    else if (c === "<") angle++;
    else if (c === ">" && angle > 0 && header[i - 1] !== "=") angle--;
    out += inside || c === "(" || c === ")" || c === "<" || c === ">" ? (c === "\n" ? "\n" : " ") : c;
  }
  return out;
}

const HERITAGE_SKIP = new Set(["public", "private", "protected", "virtual", "internal", "open", "final"]);

/**
 * The names a declaration header inherits from, with their offsets in `header` — everything between
 * the type's name and its `{`: `extends A implements B, C`, `: Base(), IFoo`, `: public Base`.
 */
export function parseHeritage(header: string): { name: string; relation: HeritageRef["relation"]; offset: number }[] {
  const flat = blankGroups(header);
  const found: { name: string; relation: HeritageRef["relation"]; offset: number }[] = [];
  const keyword = /\b(extends|implements|with)\b|:/g;
  const marks: { relation: HeritageRef["relation"]; start: number; end: number }[] = [];
  for (const m of flat.matchAll(keyword)) {
    const relation = m[1] === "extends" ? "extends" : m[1] === undefined ? "inherits" : "implements";
    marks.push({ relation, start: m.index! + m[0].length, end: flat.length });
    if (marks.length > 1) marks[marks.length - 2].end = m.index!;
  }
  for (const mark of marks) {
    const clause = flat.slice(mark.start, mark.end);
    // `where T : …` (C#) and `permits …` (Java) end a clause.
    const stop = clause.search(/\b(where|permits|throws)\b/);
    const body = stop < 0 ? clause : clause.slice(0, stop);
    let cursor = 0;
    for (const part of body.split(",")) {
      const words = [...part.matchAll(/[A-Za-z_$][\w$]*(?:\s*(?:\.|::)\s*[A-Za-z_$][\w$]*)*/g)].filter(
        (w) => !HERITAGE_SKIP.has(w[0]),
      );
      const path = words[0];
      if (path) {
        const segments = [...path[0].matchAll(/[A-Za-z_$][\w$]*/g)];
        const last = segments[segments.length - 1];
        found.push({ name: last[0], relation: mark.relation, offset: mark.start + cursor + path.index! + last.index! });
      }
      cursor += part.length + 1;
    }
  }
  return found;
}

const TYPE_RE =
  /\b(class|interface|trait|protocol|struct|record|object|enum|extension)\s+(?!(?:class|interface|struct)\b)([A-Za-z_$][\w$]*)|\bimpl\b(?:\s*<[^{]*?>)?\s+((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)(?:\s*<[^{]*?>)?\s+for\s+([A-Za-z_]\w*)|\btype\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+interface\b/g;

const NOT_A_MEMBER = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "super", "this", "function", "fun", "func", "fn", "def",
  "typeof", "sizeof", "await", "yield", "throw", "else", "do", "try", "constructor", "init", "synchronized",
  "foreach", "using", "lock", "when", "assert", "match", "loop", "decltype", "static_assert", "operator",
]);

/** The method a body line declares, or its property when the type is an interface. */
function memberOnLine(segment: string, typeName: string, isInterface: boolean): { name: string; index: number } | null {
  const trimmed = segment.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("#[") || trimmed.startsWith("@")) {
    // Attributes and decorators: `@Override public void x()` keeps its member after the annotation.
    const after = trimmed.match(/^@[\w.]+(?:\s*\([^)]*\))?\s+(.*)$/);
    if (!after) return null;
    const offset = segment.length - after[1].length;
    const inner = memberOnLine(after[1], typeName, isInterface);
    return inner ? { name: inner.name, index: inner.index + offset } : null;
  }
  const equals = segment.search(/(?<![=!<>])=(?![=>])/);
  const method = /(?<![\w$@.~])([A-Za-z_$][\w$]*)\s*(?:<[^()=;]*?>)?\s*\(/g;
  for (const m of segment.matchAll(method)) {
    if (equals >= 0 && m.index! + m[0].length > equals) break;
    const name = m[1];
    if (NOT_A_MEMBER.has(name) || name === typeName) continue;
    return { name, index: m.index! };
  }
  if (isInterface) {
    const property = /^(\s*(?:(?:readonly|val|var|abstract|override|public|static)\s+)*)([A-Za-z_$][\w$]*)\??\s*:(?!:)/.exec(
      segment,
    );
    if (property && !NOT_A_MEMBER.has(property[2])) return { name: property[2], index: property[1].length };
  }
  return null;
}

/**
 * Every type a file declares — classes, interfaces, traits, protocols, Rust `impl Trait for T`
 * blocks and Go interfaces — with its heritage and its members.
 *
 * A reading, not a parse: what it finds is good enough to *match names against*, which is all it is
 * used for. A member is the first identifier directly before a `(` on a line of the body at the
 * body's own depth (before any `=`), or, in an interface, a `name:` property.
 */
export function outlineTypes(text: string, singleQuoteStrings: boolean): TypeDecl[] {
  const clean = blankNonCode(text, singleQuoteStrings);
  const starts = lineStarts(clean);
  const decls: TypeDecl[] = [];
  for (const m of clean.matchAll(TYPE_RE)) {
    const at = m.index!;
    let name: string;
    let nameOffset: number;
    let kind: TypeKind;
    /** Where the header starts — after the name, or after Go's `interface` keyword. */
    let headerFrom: number | null = null;
    let heritage: { name: string; relation: HeritageRef["relation"]; offset: number }[] = [];
    if (m[2]) {
      name = m[2];
      nameOffset = at + m[0].lastIndexOf(name);
      const keyword = m[1];
      const lineStart = clean.lastIndexOf("\n", at) + 1;
      const before = clean.slice(lineStart, at);
      kind =
        keyword === "interface" || keyword === "trait" || keyword === "protocol"
          ? "interface"
          : /\b(abstract|sealed)\b/.test(before)
            ? "abstract"
            : "class";
    } else if (m[4]) {
      name = m[4];
      nameOffset = at + m[0].lastIndexOf(name);
      kind = "impl";
      const trait = m[3];
      const segment = trait.split("::").pop()!;
      heritage = [{ name: segment, relation: "implements", offset: at + m[0].indexOf(trait) + trait.length - segment.length }];
    } else {
      name = m[5];
      nameOffset = at + m[0].indexOf(name, 4);
      kind = "interface";
      headerFrom = at + m[0].length;
    }
    // The header: from the name to the body's `{`, at depth 0 of parentheses and generics.
    const afterName = headerFrom ?? nameOffset + name.length;
    let j = afterName;
    let paren = 0;
    let angle = 0;
    let open = -1;
    while (j < clean.length && j - afterName < 2000) {
      const c = clean[j];
      if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (c === "<") angle++;
      else if (c === ">" && angle > 0 && clean[j - 1] !== "=") angle--;
      else if (paren <= 0 && angle <= 0) {
        if (c === "{") {
          open = j;
          break;
        }
        if (c === ";" || c === "}" || (c === "=" && clean[j + 1] !== ">")) break;
      }
      j++;
    }
    if (open < 0) continue;
    const header = clean.slice(afterName, open);
    // A Kotlin class without a body runs on into the next declaration — that header is not this one's.
    if (/\b(class|interface|fun|val|var|def|func|fn|struct|trait|object)\b/.test(blankGroups(header))) continue;
    if (kind !== "impl") {
      heritage = parseHeritage(header).map((h) => ({ ...h, offset: afterName + h.offset }));
    }
    // The body's end, by brace depth.
    let depth = 0;
    let close = clean.length - 1;
    for (let k = open; k < clean.length; k++) {
      if (clean[k] === "{") depth++;
      else if (clean[k] === "}" && --depth === 0) {
        close = k;
        break;
      }
    }
    // Members: the body's own lines with everything nested blanked.
    const members: MemberDecl[] = [];
    const seen = new Set<string>();
    let nested = 0;
    let paren2 = 0;
    let lineText = "";
    let lineOffset = open + 1;
    let parenAtLineStart = 0;
    const flush = () => {
      if (parenAtLineStart === 0) {
        const found = memberOnLine(lineText, name, kind === "interface");
        if (found && !seen.has(found.name)) {
          seen.add(found.name);
          const where = locate(starts, lineOffset + found.index);
          members.push({ name: found.name, line: where.line, column: where.column });
        }
      }
    };
    for (let k = open + 1; k < close; k++) {
      const c = clean[k];
      if (c === "\n") {
        flush();
        lineText = "";
        lineOffset = k + 1;
        parenAtLineStart = paren2;
        continue;
      }
      if (c === "{") nested++;
      const visible = nested === 0;
      if (c === "}") nested = Math.max(0, nested - 1);
      if (visible) {
        if (c === "(") paren2++;
        else if (c === ")") paren2 = Math.max(0, paren2 - 1);
        else if (c === ";" && paren2 === 0) {
          // Two members on one line: the second one starts a line of its own.
          flush();
          lineText = " ".repeat(k + 1 - lineOffset);
          parenAtLineStart = 0;
          continue;
        }
      }
      lineText += visible ? c : " ";
    }
    flush();
    const keywordAt = locate(starts, at);
    const nameAt = locate(starts, nameOffset);
    decls.push({
      name,
      kind,
      line: keywordAt.line,
      nameLine: nameAt.line,
      nameColumn: nameAt.column,
      headerEndLine: locate(starts, open).line,
      endLine: locate(starts, close).line,
      heritage: heritage.map((h) => {
        const where = locate(starts, h.offset);
        return { name: h.name, relation: h.relation, line: where.line, column: where.column };
      }),
      members,
    });
  }
  return decls;
}

/** The type a location points into — a span from an engine may start on the declaration, its name,
 *  or a decorator a few lines above it. Innermost wins. */
export function typeAt(decls: readonly TypeDecl[], line: number): TypeDecl | null {
  let inside: TypeDecl | null = null;
  let above: TypeDecl | null = null;
  for (const decl of decls) {
    if (decl.line <= line && line <= decl.endLine) {
      if (!inside || decl.line > inside.line) inside = decl;
    } else if (decl.line > line && decl.line - 3 <= line) {
      if (!above || decl.line < above.line) above = decl;
    }
  }
  return inside ?? above;
}

/** The type whose *header* (declaration line through its `{`) is on `line` — what a text search
 *  hit on an `implements` line belongs to. */
export function typeWithHeaderOn(decls: readonly TypeDecl[], line: number): TypeDecl | null {
  return decls.find((decl) => decl.line <= line && line <= decl.headerEndLine) ?? null;
}

/** Candidates ordered by how near they are to `fromPath`: the same file, then the same directory,
 *  then the longest shared path. */
export function byProximity<T extends { path: string }>(items: readonly T[], fromPath: string): T[] {
  const shared = (a: string, b: string) => {
    const x = a.split("/");
    const y = b.split("/");
    let k = 0;
    while (k < x.length - 1 && k < y.length - 1 && x[k] === y[k]) k++;
    return k;
  };
  const score = (path: string) => (path === fromPath ? 1000 : shared(path, fromPath));
  return [...items].sort((a, b) => score(b.path) - score(a.path));
}

// ---------------------------------------------------------------------------
// The lenses
// ---------------------------------------------------------------------------

export type LensTitle =
  | { kind: "implementations"; count: number; name: string }
  | { kind: "base"; relation: "implements" | "extends" | "overrides"; name: string };

export interface ImplLens {
  line: number;
  title: LensTitle;
  targets: Loc[];
}

export interface LensDeps {
  /** The file the lenses are for, repo-relative. */
  path: string;
  decls: TypeDecl[];
  /** Where `decl` is implemented or extended — the declarations of its subtypes. */
  subtypes: (decl: TypeDecl) => Promise<Loc[]>;
  /** A real engine's implementations of the member at a position. Absent, members are matched by
   *  name in the subtypes' own outlines. */
  memberImplementations?: (member: MemberDecl) => Promise<Loc[] | null>;
  /** The declaration a heritage name resolves to. */
  definition: (ref: HeritageRef, decl: TypeDecl) => Promise<Loc | null>;
  /** Another file's outline. */
  outlineOf: (path: string) => Promise<TypeDecl[] | null>;
}

/** What one file costs at most: types looked at, and member lookups made. */
export const LENS_LIMITS = { types: 25, memberLookups: 60, heritage: 6, subtypes: 40 };

const key = (loc: Loc) => `${loc.path}:${loc.line}`;

function unique(locs: Loc[]): Loc[] {
  const seen = new Map<string, Loc>();
  for (const loc of locs) if (!seen.has(key(loc))) seen.set(key(loc), loc);
  return [...seen.values()];
}

/** Whether `loc` is the declaration at `line` of this file itself — what an engine's answer about a
 *  concrete class or method includes along with the real implementations. */
const isSelf = (loc: Loc, path: string, line: number, nameLine: number) =>
  loc.path === path && loc.line >= line - 3 && loc.line <= nameLine;

export async function computeLenses(deps: LensDeps): Promise<ImplLens[]> {
  const lenses: ImplLens[] = [];
  const outlines = new Map<string, Promise<TypeDecl[] | null>>();
  outlines.set(deps.path, Promise.resolve(deps.decls));
  const outlineOf = (path: string) => {
    let found = outlines.get(path);
    if (!found) {
      found = deps.outlineOf(path).catch(() => null);
      outlines.set(path, found);
    }
    return found;
  };
  let memberBudget = LENS_LIMITS.memberLookups;

  for (const decl of deps.decls.slice(0, LENS_LIMITS.types)) {
    // ── Down: who implements this, and each member.
    if (decl.kind !== "impl") {
      const raw = await deps.subtypes(decl).catch(() => [] as Loc[]);
      const subs = unique(raw.filter((loc) => !isSelf(loc, deps.path, decl.line, decl.nameLine))).slice(
        0,
        LENS_LIMITS.subtypes,
      );
      // Pointed at each subtype's name where its outline knows it.
      const subDecls = await Promise.all(
        subs.map(async (loc) => {
          const found = typeAt((await outlineOf(loc.path)) ?? [], loc.line);
          return { loc, decl: found };
        }),
      );
      if (subs.length > 0) {
        lenses.push({
          line: decl.line,
          title: { kind: "implementations", count: subs.length, name: decl.name },
          targets: subDecls.map(({ loc, decl: sub }) =>
            sub ? { path: loc.path, line: sub.nameLine, column: sub.nameColumn } : loc,
          ),
        });
        for (const member of decl.members) {
          let targets: Loc[];
          if (deps.memberImplementations) {
            if (memberBudget-- <= 0) break;
            const found = await deps.memberImplementations(member).catch(() => null);
            targets = unique((found ?? []).filter((loc) => !isSelf(loc, deps.path, member.line, member.line)));
          } else {
            targets = subDecls.flatMap(({ loc, decl: sub }) => {
              const hit = sub?.members.find((m) => m.name === member.name);
              return hit ? [{ path: loc.path, line: hit.line, column: hit.column }] : [];
            });
          }
          if (targets.length > 0) {
            lenses.push({
              line: member.line,
              title: { kind: "implementations", count: targets.length, name: `${decl.name}.${member.name}` },
              targets,
            });
          }
        }
      }
    }

    // ── Up: what this implements or extends, and which members come from there.
    const claimed = new Set<string>();
    for (const ref of decl.heritage.slice(0, LENS_LIMITS.heritage)) {
      const found = await deps.definition(ref, decl).catch(() => null);
      if (!found) continue;
      const base = typeAt((await outlineOf(found.path)) ?? [], found.line);
      const target = base ? { path: found.path, line: base.nameLine, column: base.nameColumn } : found;
      if (target.path === deps.path && target.line === decl.nameLine) continue;
      const relation: "implements" | "extends" = base
        ? base.kind === "interface"
          ? decl.kind === "interface"
            ? "extends"
            : "implements"
          : "extends"
        : ref.relation === "implements"
          ? "implements"
          : "extends";
      lenses.push({ line: decl.line, title: { kind: "base", relation, name: ref.name }, targets: [target] });
      if (!base) continue;
      for (const member of decl.members) {
        if (claimed.has(member.name)) continue;
        const hit = base.members.find((m) => m.name === member.name);
        if (!hit) continue;
        claimed.add(member.name);
        lenses.push({
          line: member.line,
          title: {
            kind: "base",
            relation: relation === "implements" ? "implements" : "overrides",
            name: `${ref.name}.${member.name}`,
          },
          targets: [{ path: found.path, line: hit.line, column: hit.column }],
        });
      }
    }
  }
  // Monaco draws a line's lenses in the order given: what this is first, then what it comes from.
  return lenses;
}
