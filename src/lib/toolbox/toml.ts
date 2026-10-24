/**
 * TOML 1.0 to and from JSON-shaped values — the converter's third format beside JSON and YAML.
 *
 * Written here rather than added as a dependency: the app ships no TOML library, the grammar is
 * small, and the tool only needs values out and values back in. Dates and times are read as their
 * text, since JSON has no date type, and written back as strings (quoted).
 */

type Table = Record<string, unknown>;

const BARE = /^[A-Za-z0-9_-]+$/;

export function parseToml(text: string): Table {
  let i = 0;
  const root: Table = {};
  let current: Table = root;
  // Tables defined by a header, so `[a]` twice is an error but `[a.b]` after `[a]` is not.
  const defined = new Set<Table>();
  const inlineTables = new Set<unknown>();

  const line = () => text.slice(0, i).split("\n").length;
  const fail = (message: string): never => {
    throw new Error(`${message} (line ${line()})`);
  };
  const skipWs = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const skipComment = () => {
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
  };
  const skipAll = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (text[i] === "\n" || text[i] === "\r") i++;
      else break;
    }
  };
  const endOfLine = () => {
    skipWs();
    skipComment();
    if (text[i] === "\r") i++;
    if (i < text.length && text[i] !== "\n") fail("Expected the end of the line");
    i++;
  };

  const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\x1b" };
  const basicString = (multi: boolean): string => {
    i += multi ? 3 : 1;
    if (multi && text[i] === "\n") i++;
    else if (multi && text.startsWith("\r\n", i)) i += 2;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("Unterminated string");
      if (multi ? text.startsWith('"""', i) : text[i] === '"') {
        // Up to two quotes may sit right before the closing three.
        if (multi) {
          let extra = 0;
          while (text[i + 3 + extra] === '"' && extra < 2) extra++;
          out += '"'.repeat(extra);
          i += 3 + extra;
        } else i++;
        return out;
      }
      const c = text[i];
      if (!multi && c === "\n") fail("Newline in a single-line string");
      if (c === "\\") {
        const n = text[i + 1];
        if (multi && /[ \t\r\n]/.test(n)) {
          // Line-ending backslash: trims the break and the indentation after it.
          let j = i + 1;
          while (/[ \t]/.test(text[j])) j++;
          if (text[j] === "\r" || text[j] === "\n") {
            while (/[ \t\r\n]/.test(text[j])) j++;
            i = j;
            continue;
          }
        }
        if (n === "u" || n === "U") {
          const len = n === "u" ? 4 : 8;
          const hex = text.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail("Bad unicode escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + len;
          continue;
        }
        if (!(n in escapes)) fail(`Bad escape \\${n}`);
        out += escapes[n];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
  };
  const literalString = (multi: boolean): string => {
    i += multi ? 3 : 1;
    if (multi && text[i] === "\n") i++;
    else if (multi && text.startsWith("\r\n", i)) i += 2;
    const close = multi ? "'''" : "'";
    const end = text.indexOf(close, i);
    if (end === -1) fail("Unterminated string");
    let stop = end;
    if (multi) while (text[stop + 3] === "'" && stop - end < 2) stop++;
    const value = text.slice(i, stop);
    if (!multi && value.includes("\n")) fail("Newline in a single-line string");
    i = stop + close.length;
    return value;
  };

  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipWs();
      if (text[i] === '"') parts.push(basicString(false));
      else if (text[i] === "'") parts.push(literalString(false));
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (!m) fail("Expected a key");
        parts.push(m![0]);
        i += m![0].length;
      }
      skipWs();
      if (text[i] === ".") {
        i++;
        continue;
      }
      return parts;
    }
  };

  const value = (): unknown => {
    skipWs();
    const rest = text.slice(i);
    if (rest.startsWith('"""')) return basicString(true);
    if (rest.startsWith('"')) return basicString(false);
    if (rest.startsWith("'''")) return literalString(true);
    if (rest.startsWith("'")) return literalString(false);
    if (rest[0] === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skipAll();
        if (text[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        skipAll();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("Expected ',' or ']' in an array");
      }
    }
    if (rest[0] === "{") {
      i++;
      const table: Table = {};
      inlineTables.add(table);
      skipWs();
      if (text[i] === "}") {
        i++;
        return table;
      }
      for (;;) {
        const k = key();
        if (text[i] !== "=") fail("Expected '='");
        i++;
        assign(table, k, value());
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return table;
        }
        fail("Expected ',' or '}' in an inline table");
      }
    }
    let m = /^(true|false)(?![\w-])/.exec(rest);
    if (m) {
      i += m[0].length;
      return m[1] === "true";
    }
    // Dates and times, kept as text.
    m = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/.exec(rest);
    if (m) {
      i += m[0].length;
      return m[0];
    }
    m = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/.exec(rest);
    if (m) {
      i += m[0].length;
      return m[0];
    }
    m = /^[+-]?(inf|nan)(?![\w])/.exec(rest);
    if (m) {
      i += m[0].length;
      return m[1] === "inf" ? (m[0][0] === "-" ? -Infinity : Infinity) : NaN;
    }
    m = /^0x[0-9a-fA-F_]+|^0o[0-7_]+|^0b[01_]+/.exec(rest);
    if (m) {
      i += m[0].length;
      return Number(m[0].replace(/_/g, ""));
    }
    m = /^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?/.exec(rest);
    if (m) {
      i += m[0].length;
      const n = Number(m[0].replace(/_/g, ""));
      if (!m[1] && !m[2] && !Number.isSafeInteger(n)) fail("Integer too large for JSON");
      return n;
    }
    return fail("Expected a value");
  };

  const assign = (table: Table, path: string[], v: unknown) => {
    let node = table;
    for (const part of path.slice(0, -1)) {
      if (node[part] === undefined) node[part] = {};
      const next = node[part];
      if (!next || typeof next !== "object" || Array.isArray(next) || inlineTables.has(next)) fail(`Key ${path.join(".")} conflicts with an existing value`);
      node = next as Table;
    }
    const last = path[path.length - 1];
    if (last in node) fail(`Duplicate key ${path.join(".")}`);
    node[last] = v;
  };

  const tableAt = (path: string[], arrayItem: boolean): Table => {
    let node = root;
    path.forEach((part, idx) => {
      const isLast = idx === path.length - 1;
      let next = node[part];
      if (isLast && arrayItem) {
        if (next === undefined) next = node[part] = [];
        if (!Array.isArray(next)) fail(`${path.join(".")} is not an array of tables`);
        const item: Table = {};
        (next as unknown[]).push(item);
        node = item;
        return;
      }
      if (next === undefined) next = node[part] = {};
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!next || typeof next !== "object" || inlineTables.has(next)) fail(`${path.join(".")} is already a value`);
      node = next as Table;
    });
    if (!arrayItem) {
      if (defined.has(node)) fail(`Table [${path.join(".")}] defined twice`);
      defined.add(node);
    }
    return node;
  };

  while (i < text.length) {
    skipAll();
    if (i >= text.length) break;
    if (text[i] === "[") {
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      const path = key();
      if (!text.startsWith(array ? "]]" : "]", i)) fail("Expected ']'");
      i += array ? 2 : 1;
      current = tableAt(path, array);
      endOfLine();
      continue;
    }
    const k = key();
    if (text[i] !== "=") fail("Expected '='");
    i++;
    assign(current, k, value());
    endOfLine();
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

const quoteKey = (k: string) => (BARE.test(k) ? k : JSON.stringify(k));

function scalar(v: unknown, path: string): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    return String(v);
  }
  if (typeof v === "boolean") return String(v);
  if (v === null || v === undefined) throw new Error(`TOML has no null (at ${path})`);
  if (Array.isArray(v)) return `[${v.map((x, n) => scalar(x, `${path}[${n}]`)).join(", ")}]`;
  return `{ ${Object.entries(v as Table)
    .map(([k, x]) => `${quoteKey(k)} = ${scalar(x, `${path}.${k}`)}`)
    .join(", ")} }`;
}

const isTable = (v: unknown): v is Table => !!v && typeof v === "object" && !Array.isArray(v);
const isTableArray = (v: unknown): v is Table[] => Array.isArray(v) && v.length > 0 && v.every(isTable);

export function stringifyToml(value: unknown): string {
  if (!isTable(value)) throw new Error("TOML documents are tables: the top level must be a JSON object");
  const out: string[] = [];
  const write = (table: Table, path: string[]) => {
    const name = path.map(quoteKey).join(".");
    for (const [k, v] of Object.entries(table)) {
      if (isTable(v) || isTableArray(v)) continue;
      out.push(`${quoteKey(k)} = ${scalar(v, [...path, k].join("."))}`);
    }
    for (const [k, v] of Object.entries(table)) {
      if (isTable(v)) {
        if (out.length) out.push("");
        out.push(`[${name ? `${name}.` : ""}${quoteKey(k)}]`);
        write(v, [...path, k]);
      } else if (isTableArray(v)) {
        for (const item of v) {
          if (out.length) out.push("");
          out.push(`[[${name ? `${name}.` : ""}${quoteKey(k)}]]`);
          write(item, [...path, k]);
        }
      }
    }
  };
  write(value, []);
  return out.join("\n") + "\n";
}
