/**
 * JSON read and written the way Jupyter writes it, so that saving a notebook nobody edited gives
 * back the same bytes.
 *
 * `JSON.parse` + `JSON.stringify` get close and not close enough, in two places:
 *
 * - **Numbers.** Python writes a float as `1.0` and JavaScript has no such number — `1.0` parses to
 *   `1` and comes back as `1`. So does `1e-05` (→ `0.00001`), and a twenty-digit integer loses its
 *   tail. Metadata is full of such values (widget state, plotting config), and every one of them
 *   would be a line in the next `git diff` for a file the user did not touch. A number whose text a
 *   JS number would not reproduce is kept as its text ([`JsonNumber`]) and written back verbatim.
 * - **Layout.** `nbformat` writes `json.dumps(nb, indent=1, sort_keys=True, ensure_ascii=False)` and
 *   a trailing newline. `JSON.stringify(v, null, 1)` matches the indentation and the string escaping
 *   but not the key order, which is Python's: sorted by code point — so this serializer sorts.
 *
 * Everything else is plain JSON: objects, arrays, strings, booleans, `null`.
 */

/** A number kept as the text it was written as — see the module note. */
export class JsonNumber {
  constructor(readonly raw: string) {}
  valueOf(): number {
    return Number(this.raw);
  }
  toString(): string {
    return this.raw;
  }
}

export type JsonValue = null | boolean | number | string | JsonNumber | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber);
}

/** A number or a kept number, as a JS number; anything else is `null`. */
export function jsonNumber(value: JsonValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (value instanceof JsonNumber) return Number(value.raw);
  return null;
}

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

/** Sets a key as an own property — `__proto__` included, which a plain assignment would treat as
 *  the object's prototype instead of as data. */
function setKey(target: JsonObject, key: string, value: JsonValue): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** What JSON forbids unescaped inside a string. */
const CONTROL = /[\x00-\x1f]/;

/**
 * Parses JSON text, keeping numbers whose text matters (see [`JsonNumber`]).
 *
 * Hand-written rather than `JSON.parse` with a reviver: a reviver sees the number after it has been
 * rounded. Strings are sliced between quotes rather than walked character by character when they
 * hold no escape, which is what keeps a notebook's megabytes of base64 image data cheap to read.
 */
export function parseJson(text: string): JsonValue {
  let i = 0;
  const length = text.length;

  const fail = (message: string): never => {
    throw new JsonSyntaxError(`${message} (posición ${i})`, i);
  };

  const skipWhitespace = () => {
    while (i < length) {
      const c = text.charCodeAt(i);
      // space, \t, \n, \r
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };

  /**
   * Where the next backslash is, at or after `from`. Remembered between strings, because `from`
   * only ever moves forward: asking `indexOf` afresh per string would scan to the next backslash in
   * the *document* each time, which for a notebook of a hundred thousand escape-free strings is
   * quadratic. `-1`: none left anywhere.
   */
  let slashAt = -2;
  const nextSlash = (from: number): number => {
    if (slashAt !== -1 && slashAt < from) slashAt = text.indexOf("\\", from);
    return slashAt;
  };

  /** A run of string characters, refused if it holds a raw control character. */
  const plain = (from: number, to: number): string => {
    const chunk = text.slice(from, to);
    const control = CONTROL.exec(chunk);
    if (control) {
      i = from + control.index;
      fail("Carácter de control sin escapar en una cadena");
    }
    return chunk;
  };

  const parseString = (): string => {
    // At the opening quote.
    i++;
    let out = "";
    let start = i;
    for (;;) {
      const quote = text.indexOf('"', i);
      if (quote < 0) fail("Cadena sin cerrar");
      const slash = nextSlash(i);
      if (slash < 0 || slash > quote) {
        out += plain(start, quote);
        i = quote + 1;
        return out;
      }
      out += plain(start, slash);
      i = slash + 1;
      const escape = text[i];
      switch (escape) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Escape \\u no válido");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          fail("Escape no válido en una cadena");
      }
      i++;
      start = i;
    }
  };

  const parseValue = (): JsonValue => {
    skipWhitespace();
    if (i >= length) fail("Fin inesperado");
    const c = text[i];
    if (c === "{") {
      i++;
      const object: JsonObject = {};
      skipWhitespace();
      if (text[i] === "}") {
        i++;
        return object;
      }
      for (;;) {
        skipWhitespace();
        if (text[i] !== '"') fail("Se esperaba una clave");
        const key = parseString();
        skipWhitespace();
        if (text[i] !== ":") fail("Se esperaba «:»");
        i++;
        setKey(object, key, parseValue());
        skipWhitespace();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return object;
        }
        fail("Se esperaba «,» o «}»");
      }
    }
    if (c === "[") {
      i++;
      const array: JsonValue[] = [];
      skipWhitespace();
      if (text[i] === "]") {
        i++;
        return array;
      }
      for (;;) {
        array.push(parseValue());
        skipWhitespace();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return array;
        }
        fail("Se esperaba «,» o «]»");
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match) fail("Valor no válido");
    const raw = match![0];
    i += raw.length;
    const value = Number(raw);
    return String(value) === raw ? value : new JsonNumber(raw);
  };

  const value = parseValue();
  skipWhitespace();
  if (i < length) fail("Texto sobrante después del JSON");
  return value;
}

/** Python's `sorted()` order for keys: by code point, which differs from JavaScript's UTF-16 order
 *  only once a key holds characters beyond the Basic Multilingual Plane. */
export function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  const simple = !/[\ud800-\udfff]/.test(a) && !/[\ud800-\udfff]/.test(b);
  if (simple) return a < b ? -1 : 1;
  const ca = Array.from(a, (ch) => ch.codePointAt(0) ?? 0);
  const cb = Array.from(b, (ch) => ch.codePointAt(0) ?? 0);
  for (let k = 0; k < Math.min(ca.length, cb.length); k++) {
    if (ca[k] !== cb[k]) return ca[k] - cb[k];
  }
  return ca.length - cb.length;
}

/** A finite JS number as JSON; what Python's `json` writes for the other two is not JSON at all. */
function numberText(value: number): string {
  return Number.isFinite(value) ? String(value) : "null";
}

/**
 * Serializes like `json.dumps(value, indent=…, sort_keys=True, ensure_ascii=False)`.
 *
 * `JSON.stringify` of a string escapes exactly what Python's does with `ensure_ascii=False` — the
 * quote, the backslash, and control characters (`\n`, `\t`… and `\u00XX` in lowercase hex) — so
 * strings go through it. `depth` is how far in the value starts, for splicing into a larger
 * document.
 */
export function serializeJson(value: JsonValue, indent: string, depth = 0): string {
  if (value === null) return "null";
  if (value instanceof JsonNumber) return value.raw;
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return numberText(value);
    case "string":
      return JSON.stringify(value);
  }
  const inner = indent.repeat(depth + 1);
  const outer = indent.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => inner + serializeJson(item, indent, depth + 1));
    return `[\n${items.join(",\n")}\n${outer}]`;
  }
  const keys = Object.keys(value).sort(compareKeys);
  if (keys.length === 0) return "{}";
  const items = keys.map((key) => `${inner}${JSON.stringify(key)}: ${serializeJson(value[key], indent, depth + 1)}`);
  return `{\n${items.join(",\n")}\n${outer}}`;
}

/**
 * The indentation a JSON document was written with — Jupyter's one space, VS Code's one, two or
 * four spaces from other tools — so a re-save does not re-indent every line. `null` for a document
 * written on one line (then the caller picks).
 */
export function detectIndent(text: string): string | null {
  const match = /^[{[]\r?\n([ \t]+)\S/.exec(text);
  return match ? match[1] : null;
}
