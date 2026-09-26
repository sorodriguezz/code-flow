import type { Dialect } from "./targets";

/**
 * Turning quicktype's output into something that belongs *in a file that already exists*.
 *
 * quicktype writes whole files: a header comment, a package or namespace, the imports, then the
 * declarations. Pasted at a caret halfway down somebody's file, three of those four are wrong — a
 * second `package` line does not compile, an `import` after a declaration does not compile in Go,
 * Java, Kotlin, Dart or C#, and "generated file, do not modify" is a claim about a file that does not
 * exist. VS Code's extension pastes the whole file anyway and leaves the rest to the reader.
 *
 * So the declarations go to the caret, and everything else goes where the file keeps it: the
 * imports it is missing join its own import block (the ones it has are not repeated), the package
 * line is dropped (the file already says which package it is in), and the header is not written at
 * all. An empty file is the one case where the whole thing is right as written, and gets it — with
 * the package declared from the path for Java and Kotlin, where the directory says what it must be.
 *
 * Everything here is line-based on purpose. Nothing needs a parser: quicktype's output has one
 * shape per language, and what is read of the user's file is only its head — comments, a package
 * line, imports — which every one of these languages keeps as simple, whole lines.
 */

interface Rules {
  /** Line-comment prefix. */
  comment: string;
  /** Whether `/* … *\/` comments exist — everywhere but Python. */
  blockComments: boolean;
  /** The file's own package declaration, which a paste never repeats. */
  packageLine?: RegExp;
  /** How to declare a package derived from the path, for the languages whose directory decides it. */
  declarePackage?: (name: string) => string;
  /** An import, as the head of a file holds one. */
  importLine: RegExp;
  /** Other lines a file's head holds, which the scan for its imports walks past. */
  preamble?: RegExp;
  /** The most blank lines quicktype puts between two declarations — two in Python (PEP 8), one elsewhere. */
  blankRun: number;
}

const RULES: Record<Dialect, Rules> = {
  typescript: { comment: "//", blockComments: true, importLine: /^import\b/, blankRun: 1 },
  python: {
    comment: "#",
    blockComments: false,
    importLine: /^(?:from\s+\S+\s+)?import\s+\S/,
    blankRun: 2,
  },
  go: {
    comment: "//",
    blockComments: true,
    packageLine: /^package\s+\w+/,
    importLine: /^import\b/,
    blankRun: 1,
  },
  rust: {
    comment: "//",
    blockComments: true,
    importLine: /^(?:pub(?:\([^)]*\))?\s+)?use\s+\S/,
    preamble: /^(?:#!\[|extern\s+crate\b|mod\s+\w+\s*;)/,
    blankRun: 1,
  },
  csharp: {
    comment: "//",
    blockComments: true,
    // Indented too: a block-scoped namespace may keep its usings inside the braces. `(?!var\b)` and
    // the name that must follow keep `using var x = …` and `using (…)` — statements — out of it.
    importLine: /^\s*(?:global\s+)?using\s+(?!var\b)(?:static\s+)?[\w.]+(?:\s*=\s*[^;]+)?\s*;\s*$/,
    preamble: /^\s*(?:namespace\s+[\w.]+\s*;?|\{|#.*)\s*$/,
    blankRun: 1,
  },
  java: {
    comment: "//",
    blockComments: true,
    packageLine: /^package\s+[\w.]+\s*;/,
    declarePackage: (name) => `package ${name};`,
    importLine: /^import\s+(?:static\s+)?[\w.]+(?:\.\*)?\s*;\s*$/,
    blankRun: 1,
  },
  kotlin: {
    comment: "//",
    blockComments: true,
    packageLine: /^package\s+[\w.`]+/,
    declarePackage: (name) => `package ${name}`,
    importLine: /^import\s+[\w.`]+(?:\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/,
    preamble: /^@file:/,
    blankRun: 1,
  },
  swift: {
    comment: "//",
    blockComments: true,
    importLine: /^(?:@\w+(?:\([^)]*\))?\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?[\w.]+\s*;?\s*$/,
    blankRun: 1,
  },
  dart: {
    comment: "//",
    blockComments: true,
    // Not a package, but it has to come first the way one does: imports go after a `library` line.
    packageLine: /^library\b/,
    importLine: /^(?:import|export)\s+['"]/,
    preamble: /^part\s+of\b/,
    blankRun: 1,
  },
};

/**
 * Drops the comment quicktype opens a file with.
 *
 * What is in it is a usage example at best, and at worst a sentence that is now false: Swift's says
 * the file "was generated … do not modify it directly", and Go's `// Code generated … DO NOT EDIT.`
 * — had it been left — is the exact line Go's tooling reads to treat a *whole file* as generated.
 */
export function stripLeadingComments(code: string, dialect: Dialect): string {
  const prefix = RULES[dialect].comment;
  const lines = code.split("\n");
  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || lines[start].trimStart().startsWith(prefix))) start++;
  return lines.slice(start).join("\n");
}

/**
 * Whether `code` declares anything at all. For JSON with nothing to type — `[]`, or a bare `42` in
 * C# — quicktype still writes its imports, and pasting those alone would be pasting nothing useful.
 */
export function hasDeclarations(code: string, dialect: Dialect): boolean {
  const rules = RULES[dialect];
  return code.split("\n").some((line) => {
    const text = line.trim();
    return text !== "" && !text.startsWith(rules.comment) && !rules.packageLine?.test(line) && !rules.importLine.test(line);
  });
}

/**
 * C#: takes the classes out of the `namespace QuickType { … }` quicktype wraps them in.
 *
 * The name is a placeholder, and the block is wrong in most files it could land in: a file-scoped
 * `namespace App;` cannot hold another namespace at all, and inside a block-scoped one it would nest
 * the classes one namespace deeper than the code around them. Unwrapped, they belong to whichever
 * namespace the caret is in. The usings that were inside the block come out with it, dedented, and
 * are placed like any other import.
 */
export function unwrapNamespace(code: string, indent: string): string {
  const lines = code.split("\n");
  const open = lines.findIndex((line) => /^namespace\s+[\w.]+\s*$/.test(line));
  if (open < 0 || lines[open + 1]?.trim() !== "{") return code;
  let close = lines.length - 1;
  while (close > open && lines[close].trim() === "") close--;
  if (close <= open + 1 || lines[close].trim() !== "}") return code;
  const inner = lines
    .slice(open + 2, close)
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trim() === "" ? "" : line));
  return [...lines.slice(0, open), ...inner, ...lines.slice(close + 1)].join("\n");
}

/**
 * Java: one file may hold any number of top-level types, but only one public one — the one it is
 * named after. quicktype writes a file per class, each of them public; pasted together, they would
 * not compile. So only a type named like the file keeps `public`, and the rest become
 * package-private, which is exactly as visible to the code beside them.
 */
export function demotePublicTypes(code: string, keep: string | null): string {
  return code
    .split("\n")
    .map((line) => {
      const match = /^public\s+((?:final\s+|abstract\s+)*(?:class|enum|interface|record)\s+([A-Za-z_$][\w$]*))/.exec(line);
      return match && match[2] !== keep ? line.replace(/^public\s+/, "") : line;
    })
    .join("\n");
}

/** A member of a TypeScript object type as quicktype prints it: `name?:   type;`, one per line. */
const MEMBER = /^\s*([A-Za-z_$][\w$]*)(\??):\s*(.+?);?\s*$/;

/** `*\/` would end the JSDoc comment early — from inside a string-literal type, say. */
const escapeComment = (text: string) => text.replace(/\*\//g, "*\\/");

/**
 * JavaScript: rewrites quicktype's TypeScript `type` aliases into JSDoc `@typedef`s.
 *
 * An object becomes the canonical `@typedef {Object}` with one `@property` per member (an optional
 * one in brackets). A member JSDoc has no way to name — a key that is not an identifier, like
 * `"my-key"` — turns that one typedef into a type literal instead, which TypeScript's checker reads
 * just the same. Everything else (unions, arrays, maps) is already a type expression both accept.
 */
export function toJsdoc(ts: string): string {
  const lines = ts.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    const head = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(line);
    if (!head) throw new Error(`Unexpected TypeScript from quicktype: ${line}`);
    const [, name, rest] = head;
    if (rest.trim() === "{") {
      const members: string[] = [];
      for (i++; i < lines.length && !/^\};?\s*$/.test(lines[i]); i++) {
        if (lines[i].trim()) members.push(lines[i]);
      }
      const parsed = members.map((member) => MEMBER.exec(member));
      if (parsed.every((match): match is RegExpExecArray => match !== null)) {
        out.push(
          "/**",
          ` * @typedef {Object} ${name}`,
          ...parsed.map(([, key, optional, type]) => ` * @property {${escapeComment(type)}} ${optional ? `[${key}]` : key}`),
          " */",
        );
      } else {
        // quicktype pads the types into a column; inside a comment the column only adds noise.
        const literal = members.map((member) => member.trimEnd().replace(/^(\s*)("(?:[^"\\]|\\.)*"|[\w$]+)(\??):\s+/, "$1$2$3: "));
        out.push("/**", " * @typedef {{", ...literal.map((member) => ` * ${escapeComment(member)}`), ` * }} ${name}`, " */");
      }
      continue;
    }
    let expression = rest.trim();
    while (!expression.endsWith(";") && i + 1 < lines.length && lines[i + 1].trim() !== "") {
      expression += ` ${lines[++i].trim()}`;
    }
    out.push("/**", ` * @typedef {${escapeComment(expression.replace(/;$/, ""))}} ${name}`, " */");
  }
  return out.join("\n");
}

/** The package a Java or Kotlin file's directory implies: what follows `…/java/` or `…/kotlin/`. */
export function packageFromPath(path: string): string | null {
  const dirs = path.split(/[\\/]/).slice(0, -1);
  const root = Math.max(dirs.lastIndexOf("java"), dirs.lastIndexOf("kotlin"));
  if (root < 0) return null;
  const parts = dirs.slice(root + 1);
  return parts.length > 0 && parts.every((part) => /^[A-Za-z_]\w*$/.test(part)) ? parts.join(".") : null;
}

/** Opening minus closing brackets — how far an import spread over several lines still has to go. */
function depth(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === "(" || ch === "{") n++;
    else if (ch === ")" || ch === "}") n--;
  }
  return n;
}

/** Index of the last line of the import starting at `start`: Go's and Python's `(…)`, Rust's and
 *  TypeScript's `{…}`, Python's trailing backslash. */
function importEnd(lines: string[], start: number): number {
  let end = start;
  let open = depth(lines[start]);
  while ((open > 0 || lines[end].trimEnd().endsWith("\\")) && end + 1 < lines.length) {
    end++;
    open += depth(lines[end]);
  }
  return end;
}

/**
 * What an import is, for telling whether the file already has it. Go's by path — the file's
 * `import (…)` block and a pasted `import "time"` are the same import written differently — and
 * everything else by its text, whitespace aside.
 */
function importKeys(text: string, dialect: Dialect): string[] {
  if (dialect === "go") return [...text.matchAll(/"([^"]+)"/g)].map((match) => `go:${match[1]}`);
  return [text.replace(/\s+/g, " ").replace(/\s*;\s*$/, "").trim()];
}

interface Head {
  /** 1-based; 0 when the file declares none. */
  packageLine: number;
  /** 1-based last line of the last import; 0 when there are none. */
  lastImport: number;
  /** That import's indentation, which the ones added after it take. */
  importIndent: string;
  /** Last line of the comment the file opens with (a licence header); 0 when it opens with code. */
  commentEnd: number;
  imports: Set<string>;
}

/** Reads the head of a file — comments, package, imports — and stops at its first declaration. */
function scanHead(lines: string[], dialect: Dialect): Head {
  const rules = RULES[dialect];
  const head: Head = { packageLine: 0, lastImport: 0, importIndent: "", commentEnd: 0, imports: new Set() };
  /** Whether anything but comments has been seen — past that, a comment no longer opens the file. */
  let opened = false;
  let closer: string | null = null;
  /** Where the run of comment lines the file opens with last began (0-based), and whether that run is
   *  a doc comment (`///`, `/**`) — which belongs to the declaration under it, not to the file. */
  let run = -1;
  let doc = false;
  let previousBlank = true;
  const note = (i: number, text: string) => {
    if (opened) return;
    if (previousBlank) {
      run = i;
      doc = text.startsWith("///") || text.startsWith("/**");
    }
    head.commentEnd = i + 1;
  };
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const text = line.trim();
    if (closer) {
      if (text.includes(closer)) closer = null;
      note(i, text);
      previousBlank = false;
      continue;
    }
    if (text === "") {
      previousBlank = true;
      continue;
    }
    if (text.startsWith(rules.comment)) {
      note(i, text);
      previousBlank = false;
      continue;
    }
    if (rules.blockComments && text.startsWith("/*")) {
      note(i, text);
      if (!text.includes("*/", 2)) closer = "*/";
      previousBlank = false;
      continue;
    }
    // A module docstring is Python's licence-header slot, and may span lines.
    const docstring = dialect === "python" ? /^[rRuU]?("""|''')/.exec(text) : null;
    if (docstring) {
      if (!text.slice(docstring[0].length).includes(docstring[1])) closer = docstring[1];
      note(i, text);
      previousBlank = false;
      continue;
    }
    previousBlank = false;
    if (rules.packageLine?.test(line)) {
      head.packageLine = i + 1;
      opened = true;
      continue;
    }
    if (rules.importLine.test(line)) {
      const end = importEnd(lines, i);
      for (const key of importKeys(lines.slice(i, end + 1).join("\n"), dialect)) head.imports.add(key);
      head.lastImport = end + 1;
      head.importIndent = /^\s*/.exec(line)?.[0] ?? "";
      opened = true;
      i = end;
      continue;
    }
    if (rules.preamble?.test(line)) {
      opened = true;
      continue;
    }
    break;
  }
  // A doc comment resting on the first declaration documents that declaration: imports put between
  // the two would leave it documenting nothing (C# even warns about it). They go above it instead.
  if (!opened && doc && head.commentEnd === i) head.commentEnd = run;
  return head;
}

/** Blank lines at the edges gone, and no run of them longer than the language's own spacing. */
function tidy(lines: string[], run: number): string[] {
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks++;
      if (out.length > 0 && blanks <= run) out.push("");
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export interface PasteFile {
  dialect: Dialect;
  /** The whole buffer, as it is now. */
  text: string;
  /** 1-based line the selection starts on — where the declarations go. */
  line: number;
  /** What precedes the selection on that line: indentation to carry, or code to break away from. */
  before: string;
  /** The file's path — a package to declare in an empty Java or Kotlin file comes from it. */
  path: string;
}

export interface Placement {
  /** Imports the file is missing, for its import block: whole lines, inserted after line `after`
   *  (0 = above the first). `null` when there are none, or when they travel with `body`. */
  header: { after: number; lines: string[] } | null;
  /** What replaces the selection. */
  body: string;
}

/**
 * Splits quicktype's file into the part that goes at the caret and the imports that go at the top.
 * See the comment at the head of this file.
 */
export function placeGenerated(code: string, file: PasteFile): Placement {
  const rules = RULES[file.dialect];
  const lines = code.split("\n");
  const packages: string[] = [];
  const imports: string[] = [];
  const known = new Set<string>();
  const declarations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Column 0 only: an indented line is inside a declaration, whatever it looks like.
    if (/^\s/.test(line)) {
      declarations.push(line);
      continue;
    }
    if (rules.packageLine?.test(line)) {
      packages.push(line.trim());
      continue;
    }
    if (rules.importLine.test(line)) {
      const end = importEnd(lines, i);
      const text = lines.slice(i, end + 1).join("\n");
      const keys = importKeys(text, file.dialect);
      // Java repeats its imports once per class; one of each is enough.
      if (keys.some((key) => !known.has(key))) {
        keys.forEach((key) => known.add(key));
        imports.push(text);
      }
      i = end;
      continue;
    }
    declarations.push(line);
  }
  const body = tidy(declarations, rules.blankRun);

  if (file.text.trim() === "") {
    // A new file: the whole file, as written — bar a placeholder package (`io.quicktype`), which is
    // replaced by the one the path implies, or left out when the path implies none.
    const derived = rules.declarePackage ? packageFromPath(file.path) : null;
    const pkg = rules.declarePackage ? (derived ? rules.declarePackage(derived) : null) : (packages[0] ?? null);
    const whole = [...(pkg ? [pkg, ""] : []), ...(imports.length > 0 ? [...imports, ""] : []), ...body];
    return { header: null, body: finish(whole, file.before) };
  }

  const fileLines = file.text.split(/\r?\n/);
  const head = scanHead(fileLines, file.dialect);
  const missing = imports.filter((text) => importKeys(text, file.dialect).some((key) => !head.imports.has(key)));
  if (missing.length === 0) return { header: null, body: finish(body, file.before) };

  // After the file's own imports; failing those, after its package line; failing that, at the top,
  // below a licence header. Always the head of the file — even in the languages that would accept an
  // import further down (Python, Rust, Swift), since the caret may well be inside a class body, where
  // none of them would.
  const anchor: { after: number; kind: "imports" | "package" | "top" } =
    head.lastImport > 0
      ? { after: head.lastImport, kind: "imports" }
      : head.packageLine > 0
        ? { after: head.packageLine, kind: "package" }
        : { after: head.commentEnd, kind: "top" };
  // A caret up in the head of the file already: the imports go with the declarations, above them.
  if (file.line <= anchor.after) {
    return { header: null, body: finish([...missing, "", ...body], file.before) };
  }
  const added = missing.flatMap((text) => text.split("\n"));
  if (anchor.kind === "imports") {
    return { header: { after: anchor.after, lines: added.map((line) => head.importIndent + line) }, body: finish(body, file.before) };
  }
  // After a package line or a licence comment: a blank line on either side, as the file's own
  // imports would have had — unless the file already has one there.
  const previous = anchor.after > 0 ? fileLines[anchor.after - 1] : "";
  const next = fileLines[anchor.after] ?? "";
  const padded = [...(previous.trim() === "" ? [] : [""]), ...added, ...(next.trim() === "" ? [] : [""])];
  return { header: { after: anchor.after, lines: padded }, body: finish(body, file.before) };
}

/**
 * The text for the caret, ending in a newline so whatever followed the caret starts on its own line.
 *
 * With only indentation before the caret, every line after the first is indented to match — a paste
 * into a class body stays inside it. With code before the caret, the declarations start on a fresh
 * line instead of being glued onto the end of it.
 */
function finish(lines: string[], before: string): string {
  if (before.trim() !== "") return `\n${lines.join("\n")}\n`;
  if (before === "") return `${lines.join("\n")}\n`;
  return `${lines.map((line, i) => (i === 0 || line === "" ? line : before + line)).join("\n")}\n`;
}
