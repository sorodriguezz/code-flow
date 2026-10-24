/**
 * JSON: format, minify, sort and — the part `JSON.parse` does not give on every engine — say
 * *where* a document is broken. WebKit's message carries no position at all ("JSON Parse error:
 * Unexpected identifier"), and the macOS app runs on WebKit, so the position comes from a small
 * scanner of our own that walks the text the way the grammar does.
 */

export interface JsonErrorInfo {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export class JsonSyntaxError extends Error {
  constructor(public info: JsonErrorInfo) {
    super(`${info.message} (line ${info.line}, column ${info.column})`);
  }
}

function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

/** Where `text` stops being JSON, or `null` when it is JSON. */
export function locateJsonError(text: string): JsonErrorInfo | null {
  let i = 0;
  const fail = (message: string): never => {
    throw { message, offset: i };
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === "}" ? "Trailing comma" : "Expected a property name in double quotes");
        string();
        ws();
        if (text[i] !== ":") fail("Expected ':' after the property name");
        i++;
        value();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] === "]") fail("Trailing comma");
        value();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    if (i >= text.length) fail("Unexpected end of input");
    if (c === "'") fail("Strings must use double quotes");
    fail(`Unexpected character '${c}'`);
  };
  const string = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") {
        const n = text[i + 1];
        if (n === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("Bad \\u escape");
          i += 6;
          continue;
        }
        if (!n || !'"\\/bfnrt'.includes(n)) fail("Bad escape");
        i += 2;
        continue;
      }
      if (c < " ") fail("Control character inside a string (escape it)");
      i++;
    }
    fail("Unterminated string");
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m || !m[0] || m[0] === "-") fail("Bad number");
    i += m![0].length;
  };
  try {
    value();
    ws();
    if (i < text.length) fail("Unexpected content after the JSON value");
    return null;
  } catch (err) {
    const e = err as { message: string; offset: number };
    if (typeof e?.offset !== "number") throw err;
    return { message: e.message, offset: e.offset, ...lineCol(text, e.offset) };
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const info = locateJsonError(text);
    if (info) throw new JsonSyntaxError(info);
    throw err;
  }
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function formatJson(text: string, indent: number | "\t" = 2, sortKeys = false): string {
  const value = parseJson(text);
  return JSON.stringify(sortKeys ? sortKeysDeep(value) : value, null, indent);
}

export function minifyJson(text: string): string {
  return JSON.stringify(parseJson(text));
}
