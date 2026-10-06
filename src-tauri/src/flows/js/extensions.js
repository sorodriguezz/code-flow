// n8n's data transformation functions, for the expressions people bring from there:
// `{{ $json.email.extractEmail() }}`, `{{ $json.rows.pluck('id').unique() }}`,
// `{{ $json.date.toDateTime().format('dd/MM') }}`, `{{ $json.total.round(2) }}` — and `$jmespath`.
//
// n8n rewrites those calls before it evaluates; here they are methods on the prototypes, defined
// non-enumerable inside this run's own QuickJS context — nothing outside it sees them, a `for…in`
// or a JSON.stringify never meets them — and never over a method the language already has:
// `includes`, `trim`, `at`, `keys` stay JavaScript's.
//
// Loaded after Luxon and before `prelude.js`, which binds `$jmespath` from `__cf_jmespath`.
(function (global) {
  "use strict";
  const { DateTime } = global.luxon;

  function define(proto, name, fn) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return;
    Object.defineProperty(proto, name, { value: fn, enumerable: false, configurable: true, writable: true });
  }

  // ------------------------------------------------------------------------------------- text

  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const URL_RE = /https?:\/\/[^\s"'<>()]+/i;
  const DOMAIN = /^(?!-)(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,}$/;

  function utf8(text) {
    const bytes = [];
    for (const char of text) {
      let code = char.codePointAt(0);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return bytes;
  }

  function fromUtf8(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i];
      let code;
      if (b < 0x80) (code = b), (i += 1);
      else if (b < 0xe0) (code = ((b & 31) << 6) | (bytes[i + 1] & 63)), (i += 2);
      else if (b < 0xf0) (code = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)), (i += 3);
      else (code = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)), (i += 4);
      out += String.fromCodePoint(code);
    }
    return out;
  }

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
      out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
      out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
      out += c === undefined ? "=" : B64[c & 63];
    }
    return out;
  }

  function unbase64(text) {
    const clean = String(text).replace(/[^A-Za-z0-9+/_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bytes = [];
    for (let i = 0; i < clean.length; i += 4) {
      const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : -1));
      bytes.push((n[0] << 2) | (n[1] >> 4));
      if (n[2] >= 0) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
      if (n[3] >= 0) bytes.push(((n[2] & 3) << 6) | n[3]);
    }
    return bytes;
  }

  function words(text) {
    return String(text)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9À-ÿ]+/)
      .filter(Boolean);
  }

  /** A date from text: ISO, SQL, RFC 2822, HTTP, epoch digits — or by a Luxon format. */
  function textToDate(text, format) {
    if (format) return DateTime.fromFormat(text, format);
    if (/^\d+$/.test(text)) return text.length > 11 ? DateTime.fromMillis(Number(text)) : DateTime.fromSeconds(Number(text));
    for (const read of [DateTime.fromISO, DateTime.fromSQL, DateTime.fromRFC2822, DateTime.fromHTTP]) {
      const parsed = read.call(DateTime, text.trim());
      if (parsed.isValid) return parsed;
    }
    return DateTime.invalid("unparsable", `"${text}" is not a date`);
  }

  const S = String.prototype;
  define(S, "isEmpty", function () {
    return this.length === 0;
  });
  define(S, "isNotEmpty", function () {
    return this.length > 0;
  });
  define(S, "isBlank", function () {
    return this.trim().length === 0;
  });
  define(S, "extractEmail", function () {
    const found = EMAIL.exec(this);
    return found ? found[0] : undefined;
  });
  define(S, "extractUrl", function () {
    const found = URL_RE.exec(this);
    return found ? found[0] : undefined;
  });
  define(S, "extractDomain", function () {
    const email = EMAIL.exec(this);
    if (email && !/^https?:/i.test(this)) return email[0].split("@")[1];
    const match = /^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:?#]+)/i.exec(this.trim());
    return match ? match[1] : undefined;
  });
  define(S, "extractUrlPath", function () {
    const match = /^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i.exec(this.trim());
    return match ? match[1] || "/" : undefined;
  });
  define(S, "isEmail", function () {
    return new RegExp(`^${EMAIL.source}$`).test(this.trim());
  });
  define(S, "isUrl", function () {
    return /^https?:\/\/[^\s]+$/i.test(this.trim());
  });
  define(S, "isDomain", function () {
    return DOMAIN.test(this.trim());
  });
  define(S, "isNumeric", function () {
    return this.trim() !== "" && !isNaN(Number(this));
  });
  define(S, "toNumber", function () {
    return Number(this.trim());
  });
  define(S, "toInt", function () {
    return parseInt(this, 10);
  });
  define(S, "toFloat", function () {
    return parseFloat(this);
  });
  define(S, "toBoolean", function () {
    return ["true", "1", "yes", "y", "sí", "si", "on"].includes(this.trim().toLowerCase());
  });
  define(S, "toDateTime", function (format) {
    return textToDate(String(this), format);
  });
  define(S, "toTitleCase", function () {
    return this.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_all, lead, first) => lead + first.toUpperCase());
  });
  define(S, "toSentenceCase", function () {
    const lower = this.toLowerCase();
    return lower.replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_all, lead, first) => lead + first.toUpperCase());
  });
  define(S, "toSnakeCase", function () {
    return words(this).map((w) => w.toLowerCase()).join("_");
  });
  define(S, "toKebabCase", function () {
    return words(this).map((w) => w.toLowerCase()).join("-");
  });
  define(S, "toCamelCase", function () {
    return words(this)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join("");
  });
  define(S, "removeTags", function () {
    return this.replace(/<[^>]*>/g, "");
  });
  define(S, "removeMarkdown", function () {
    return this.replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1");
  });
  define(S, "replaceSpecialChars", function () {
    return this.normalize("NFD").replace(/\p{M}/gu, "");
  });
  define(S, "quote", function (mark = '"') {
    return `${mark}${this.split(mark).join(`\\${mark}`)}${mark}`;
  });
  define(S, "urlEncode", function (entire = false) {
    return entire ? encodeURI(this) : encodeURIComponent(this);
  });
  define(S, "urlDecode", function (entire = false) {
    return entire ? decodeURI(this) : decodeURIComponent(this);
  });
  define(S, "base64Encode", function () {
    return base64(utf8(String(this)));
  });
  define(S, "base64Decode", function () {
    return fromUtf8(unbase64(this));
  });
  define(S, "parseJson", function () {
    return JSON.parse(this);
  });
  define(S, "toJsonString", function () {
    return JSON.stringify(String(this));
  });

  // ---------------------------------------------------------------------------------- numbers

  const N = Number.prototype;
  define(N, "round", function (decimals = 0) {
    const factor = Math.pow(10, decimals);
    return Math.round(this * factor) / factor;
  });
  define(N, "floor", function () {
    return Math.floor(this);
  });
  define(N, "ceil", function () {
    return Math.ceil(this);
  });
  define(N, "abs", function () {
    return Math.abs(this);
  });
  define(N, "isEven", function () {
    return Number.isInteger(+this) && this % 2 === 0;
  });
  define(N, "isOdd", function () {
    return Number.isInteger(+this) && Math.abs(this % 2) === 1;
  });
  define(N, "isInteger", function () {
    return Number.isInteger(+this);
  });
  define(N, "toBoolean", function () {
    return +this !== 0;
  });
  define(N, "toDateTime", function (unit = "ms") {
    if (unit === "s") return DateTime.fromSeconds(+this);
    if (unit === "us") return DateTime.fromMillis(+this / 1000);
    if (unit === "excel") return DateTime.fromMillis(Math.round((+this - 25569) * 86400000), { zone: "utc" });
    return DateTime.fromMillis(+this);
  });
  /** Grouped and rounded the way a locale writes it — `es`: 1.234,5; others: 1,234.5. */
  define(N, "format", function (locale, options = {}) {
    const spanish = String(locale || global.__cf_locale || "en").toLowerCase().startsWith("es");
    const percent = options.style === "percent";
    let value = percent ? +this * 100 : +this;
    const max = options.maximumFractionDigits ?? (percent ? 0 : 3);
    const min = Math.min(options.minimumFractionDigits ?? 0, max);
    let text = value.toFixed(max);
    if (text.includes(".")) {
      text = text.replace(/0+$/, "");
      const [, decimals = ""] = text.split(".");
      if (decimals.length < min) text = text.replace(/\.?$/, ".") + "0".repeat(min - decimals.length);
      text = text.replace(/\.$/, "");
    }
    const [whole, fraction] = text.split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, spanish ? "." : ",");
    let out = fraction ? `${grouped}${spanish ? "," : "."}${fraction}` : grouped;
    if (percent) out += spanish ? " %" : "%";
    if (options.style === "currency" && options.currency) out = spanish ? `${out} ${options.currency}` : `${options.currency} ${out}`;
    return out;
  });

  // ----------------------------------------------------------------------------------- arrays

  const A = Array.prototype;
  const plain = (value) => (value && typeof value === "object" && !Array.isArray(value) && !DateTime.isDateTime(value));
  const key = (value) => (value && typeof value === "object" ? JSON.stringify(value) : `${typeof value}:${value}`);
  const numbers = (list) => list.map(Number).filter((n) => !isNaN(n));

  define(A, "first", function () {
    return this[0];
  });
  define(A, "last", function () {
    return this[this.length - 1];
  });
  define(A, "isEmpty", function () {
    return this.length === 0;
  });
  define(A, "isNotEmpty", function () {
    return this.length > 0;
  });
  /** One field of every object — or, with several, objects with only those fields. */
  define(A, "pluck", function (...fields) {
    if (fields.length === 0) return this.slice();
    if (fields.length === 1) return this.filter(plain).map((entry) => entry[fields[0]]).filter((v) => v !== undefined);
    return this.filter(plain).map((entry) => Object.fromEntries(fields.filter((f) => f in entry).map((f) => [f, entry[f]])));
  });
  /** Without repeats — of the whole entry, or of the fields named. */
  define(A, "unique", function (...fields) {
    const seen = new Set();
    return this.filter((entry) => {
      const id = fields.length && plain(entry) ? key(fields.map((f) => entry[f])) : key(entry);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  });
  define(A, "removeDuplicates", function (...fields) {
    return this.unique(...fields);
  });
  define(A, "sum", function () {
    return numbers(this).reduce((a, b) => a + b, 0);
  });
  define(A, "average", function () {
    const list = numbers(this);
    return list.length ? list.reduce((a, b) => a + b, 0) / list.length : undefined;
  });
  define(A, "min", function () {
    const list = numbers(this);
    return list.length ? Math.min(...list) : undefined;
  });
  define(A, "max", function () {
    const list = numbers(this);
    return list.length ? Math.max(...list) : undefined;
  });
  /** Without the empty entries: null, undefined, "", empty lists and objects. */
  define(A, "compact", function () {
    return this.filter((v) => !(v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (plain(v) && !Object.keys(v).length)));
  });
  define(A, "chunk", function (size = 1) {
    const out = [];
    const step = Math.max(1, Math.floor(size));
    for (let i = 0; i < this.length; i += step) out.push(this.slice(i, i + step));
    return out;
  });
  define(A, "difference", function (other = []) {
    const there = new Set(other.map(key));
    return this.filter((v) => !there.has(key(v)));
  });
  define(A, "intersection", function (other = []) {
    const there = new Set(other.map(key));
    return this.filter((v) => there.has(key(v))).unique();
  });
  define(A, "union", function (other = []) {
    return this.concat(other).unique();
  });
  define(A, "randomItem", function () {
    return this[Math.floor(Math.random() * this.length)];
  });
  /** Objects into one, the later ones' fields winning. */
  define(A, "merge", function () {
    return Object.assign({}, ...this.filter(plain));
  });
  /** `[{name: "a", value: 1}]` → `{a: 1}`. */
  define(A, "smartJoin", function (keyField, valueField) {
    return Object.fromEntries(this.filter(plain).map((entry) => [entry[keyField], entry[valueField]]));
  });
  define(A, "toJsonString", function () {
    return JSON.stringify(this);
  });

  // ---------------------------------------------------------------------------------- objects

  const O = Object.prototype;
  define(O, "isEmpty", function () {
    return Object.keys(this).length === 0;
  });
  define(O, "isNotEmpty", function () {
    return Object.keys(this).length > 0;
  });
  define(O, "hasField", function (name) {
    return Object.prototype.hasOwnProperty.call(this, name);
  });
  define(O, "removeField", function (name) {
    const out = Object.assign({}, this);
    delete out[name];
    return out;
  });
  define(O, "removeFieldsContaining", function (value) {
    return Object.fromEntries(Object.entries(this).filter(([, v]) => !(typeof v === "string" && v.includes(String(value)))));
  });
  define(O, "keepFieldsContaining", function (value) {
    return Object.fromEntries(Object.entries(this).filter(([, v]) => typeof v === "string" && v.includes(String(value))));
  });
  define(O, "compact", function () {
    return Object.fromEntries(Object.entries(this).filter(([, v]) => !(v === null || v === undefined || v === "")));
  });
  define(O, "toJsonString", function () {
    return JSON.stringify(this);
  });
  define(O, "urlEncode", function () {
    return Object.entries(this)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === null || v === undefined ? "" : String(v))}`)
      .join("&");
  });

  // ------------------------------------------------------------------------------------ dates

  const D = DateTime.prototype;
  define(D, "format", function (pattern) {
    return this.toFormat(pattern);
  });
  define(D, "beginningOf", function (unit = "week") {
    return this.startOf(unit);
  });
  define(D, "endOfMonth", function () {
    return this.endOf("month");
  });
  define(D, "extract", function (part = "week") {
    if (part === "week") return this.weekNumber;
    if (part === "dayOfWeek" || part === "weekday") return this.weekday;
    if (part === "dayOfYear") return this.ordinal;
    return this.get(part);
  });
  define(D, "isBetween", function (a, b) {
    const from = DateTime.isDateTime(a) ? a : textToDate(String(a));
    const to = DateTime.isDateTime(b) ? b : textToDate(String(b));
    return this > from && this < to;
  });
  define(D, "isWeekend", function () {
    return this.weekday >= 6;
  });
  define(D, "isInLast", function (amount = 1, unit = "days") {
    const now = DateTime.now();
    return this <= now && this >= now.minus({ [unit]: amount });
  });
  define(D, "toDateTime", function () {
    return this;
  });
  define(Date.prototype, "toDateTime", function () {
    return DateTime.fromJSDate(this);
  });

  // ---------------------------------------------------------------------------------- JMESPath

  /** The JMESPath expressions people write: fields, indexes, slices, projections (`[*]`, `.*`,
   *  `[]`, `[?…]`), pipes, multiselects, comparisons, `&&`/`||`/`!`, literals and the common
   *  functions. */
  function tokenize(source) {
    const tokens = [];
    let i = 0;
    const two = ["||", "&&", "==", "!=", "<=", ">="];
    while (i < source.length) {
      const c = source[i];
      if (/\s/.test(c)) {
        i += 1;
      } else if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
        tokens.push({ t: "id", v: source.slice(i, j) });
        i = j;
      } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(source[i + 1] || ""))) {
        let j = i + 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
        tokens.push({ t: "num", v: Number(source.slice(i, j)) });
        i = j;
      } else if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        let text = "";
        while (j < source.length && source[j] !== c) {
          if (source[j] === "\\" && j + 1 < source.length) {
            text += c === '"' ? source.slice(j, j + 2) : source[j + 1];
            j += 2;
          } else {
            text += source[j];
            j += 1;
          }
        }
        if (j >= source.length) throw new Error(`Unclosed ${c} in the JMESPath expression`);
        if (c === '"') tokens.push({ t: "id", v: JSON.parse(`"${text}"`) });
        else if (c === "'") tokens.push({ t: "lit", v: text });
        else {
          let value;
          try {
            value = JSON.parse(text);
          } catch (error) {
            value = text;
          }
          tokens.push({ t: "lit", v: value });
        }
        i = j + 1;
      } else if (two.includes(source.slice(i, i + 2))) {
        tokens.push({ t: source.slice(i, i + 2) });
        i += 2;
      } else if ("[]{}().,:|&!<>@*?".includes(c)) {
        tokens.push({ t: c });
        i += 1;
      } else {
        throw new Error(`Unexpected "${c}" in the JMESPath expression`);
      }
    }
    tokens.push({ t: "eof" });
    return tokens;
  }

  function parse(source) {
    const tokens = tokenize(source);
    let at = 0;
    const peek = (k = 0) => tokens[at + k];
    const take = (type) => {
      const token = tokens[at];
      if (type && token.t !== type) throw new Error(`Expected "${type}" in the JMESPath expression, found "${token.v ?? token.t}"`);
      at += 1;
      return token;
    };

    function expression() {
      let left = orExpr();
      while (peek().t === "|") {
        take("|");
        left = { type: "pipe", left, right: orExpr() };
      }
      return left;
    }
    function orExpr() {
      let left = andExpr();
      while (peek().t === "||") {
        take();
        left = { type: "or", left, right: andExpr() };
      }
      return left;
    }
    function andExpr() {
      let left = notExpr();
      while (peek().t === "&&") {
        take();
        left = { type: "and", left, right: notExpr() };
      }
      return left;
    }
    function notExpr() {
      if (peek().t === "!") {
        take();
        return { type: "not", expr: notExpr() };
      }
      return comparison();
    }
    function comparison() {
      const left = chain();
      const op = peek().t;
      if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
        take();
        return { type: "cmp", op, left, right: chain() };
      }
      return left;
    }

    /** A bracket after a value: an index, a slice, `[*]`, `[]`, `[?…]` — or a multiselect list. */
    function bracket(left) {
      take("[");
      const next = peek();
      if (next.t === "]") {
        take("]");
        return { projection: { type: "projection", kind: "flatten", left } };
      }
      if (next.t === "*" && peek(1).t === "]") {
        take("*");
        take("]");
        return { projection: { type: "projection", kind: "list", left } };
      }
      if (next.t === "?") {
        take("?");
        const cond = expression();
        take("]");
        return { projection: { type: "projection", kind: "filter", left, cond } };
      }
      if (next.t === "num" || next.t === ":") {
        const parts = [null, null, null];
        let slot = 0;
        while (peek().t !== "]") {
          if (peek().t === ":") {
            take(":");
            slot += 1;
          } else parts[slot] = take("num").v;
        }
        take("]");
        if (slot === 0) return { node: { type: "index", left, index: parts[0] } };
        return { projection: { type: "projection", kind: "slice", left, slice: parts } };
      }
      // A multiselect list on the current value.
      const items = [expression()];
      while (peek().t === ",") {
        take(",");
        items.push(expression());
      }
      take("]");
      return { node: { type: "sub", left, right: { type: "list", items } } };
    }

    function hash() {
      take("{");
      const entries = [];
      while (peek().t !== "}") {
        const name = take("id").v;
        take(":");
        entries.push([name, expression()]);
        if (peek().t === ",") take(",");
      }
      take("}");
      return { type: "hash", entries };
    }

    function primary() {
      const token = peek();
      if (token.t === "id") {
        take();
        if (peek().t === "(") {
          take("(");
          const args = [];
          while (peek().t !== ")") {
            if (peek().t === "&") {
              take("&");
              args.push({ type: "expref", expr: expression() });
            } else args.push(expression());
            if (peek().t === ",") take(",");
          }
          take(")");
          return { type: "fn", name: token.v, args };
        }
        return { type: "field", name: token.v };
      }
      if (token.t === "lit") {
        take();
        return { type: "literal", value: token.v };
      }
      if (token.t === "num") {
        take();
        return { type: "literal", value: token.v };
      }
      if (token.t === "@") {
        take();
        return { type: "current" };
      }
      if (token.t === "(") {
        take("(");
        const inner = expression();
        take(")");
        return inner;
      }
      if (token.t === "{") return hash();
      if (token.t === "*") {
        take("*");
        return { type: "projection", kind: "object", left: { type: "current" }, right: rest() };
      }
      if (token.t === "[") {
        const result = bracket({ type: "current" });
        if (result.projection) return Object.assign(result.projection, { right: rest() });
        return result.node;
      }
      throw new Error(`Unexpected "${token.v ?? token.t}" in the JMESPath expression`);
    }

    /** What follows a projection, applied to each element: accessors until something ends it. */
    function rest() {
      let node = { type: "current" };
      for (;;) {
        const token = peek();
        if (token.t === ".") {
          take(".");
          if (peek().t === "*") {
            take("*");
            return { type: "projection", kind: "object", left: node, right: rest() };
          }
          if (peek().t === "[") {
            take("[");
            const items = [expression()];
            while (peek().t === ",") {
              take(",");
              items.push(expression());
            }
            take("]");
            node = { type: "sub", left: node, right: { type: "list", items } };
          } else if (peek().t === "{") node = { type: "sub", left: node, right: hash() };
          else node = { type: "sub", left: node, right: primary() };
        } else if (token.t === "[") {
          const result = bracket(node);
          if (result.projection) return Object.assign(result.projection, { right: rest() });
          node = result.node;
        } else {
          return node;
        }
      }
    }

    function chain() {
      let node = primary();
      if (node.type === "projection") return node;
      for (;;) {
        const token = peek();
        if (token.t === ".") {
          take(".");
          if (peek().t === "*") {
            take("*");
            return { type: "projection", kind: "object", left: node, right: rest() };
          }
          if (peek().t === "[") {
            take("[");
            const items = [expression()];
            while (peek().t === ",") {
              take(",");
              items.push(expression());
            }
            take("]");
            node = { type: "sub", left: node, right: { type: "list", items } };
          } else if (peek().t === "{") node = { type: "sub", left: node, right: hash() };
          else node = { type: "sub", left: node, right: primary() };
        } else if (token.t === "[") {
          const result = bracket(node);
          if (result.projection) return Object.assign(result.projection, { right: rest() });
          node = result.node;
        } else {
          return node;
        }
      }
    }

    const tree = expression();
    if (peek().t !== "eof") throw new Error(`Unexpected "${peek().v ?? peek().t}" in the JMESPath expression`);
    return tree;
  }

  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const truthy = (v) => !(v === null || v === undefined || v === false || v === "" || (Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function evalNode(node, value) {
    switch (node.type) {
      case "current":
        return value;
      case "literal":
        return node.value;
      case "field":
        return isObject(value) && node.name in value ? value[node.name] : null;
      case "sub": {
        const left = evalNode(node.left, value);
        return left === null || left === undefined ? null : evalNode(node.right, left);
      }
      case "index": {
        const list = evalNode(node.left, value);
        if (!Array.isArray(list)) return null;
        const at = node.index < 0 ? list.length + node.index : node.index;
        return list[at] === undefined ? null : list[at];
      }
      case "projection": {
        const base = evalNode(node.left, value);
        let list;
        if (node.kind === "object") {
          if (!isObject(base)) return null;
          list = Object.values(base);
        } else if (!Array.isArray(base)) {
          return null;
        } else if (node.kind === "flatten") {
          list = base.flatMap((v) => (Array.isArray(v) ? v : [v]));
        } else if (node.kind === "filter") {
          list = base.filter((v) => truthy(evalNode(node.cond, v)));
        } else if (node.kind === "slice") {
          const [start, stop, step] = node.slice;
          const by = step || 1;
          const norm = (n, fallback) => (n === null ? fallback : n < 0 ? Math.max(0, base.length + n) : Math.min(n, base.length));
          list = [];
          if (by > 0) for (let i = norm(start, 0); i < norm(stop, base.length); i += by) list.push(base[i]);
          else for (let i = start === null ? base.length - 1 : norm(start, 0); i > (stop === null ? -1 : norm(stop, 0)); i += by) list.push(base[i]);
        } else {
          list = base;
        }
        return list.map((v) => evalNode(node.right, v)).filter((v) => v !== null && v !== undefined);
      }
      case "pipe":
        return evalNode(node.right, evalNode(node.left, value));
      case "or": {
        const left = evalNode(node.left, value);
        return truthy(left) ? left : evalNode(node.right, value);
      }
      case "and": {
        const left = evalNode(node.left, value);
        return truthy(left) ? evalNode(node.right, value) : left;
      }
      case "not":
        return !truthy(evalNode(node.expr, value));
      case "cmp": {
        const a = evalNode(node.left, value);
        const b = evalNode(node.right, value);
        if (node.op === "==") return same(a, b);
        if (node.op === "!=") return !same(a, b);
        if (typeof a !== "number" || typeof b !== "number") return null;
        return node.op === "<" ? a < b : node.op === "<=" ? a <= b : node.op === ">" ? a > b : a >= b;
      }
      case "list":
        return value === null ? null : node.items.map((item) => evalNode(item, value));
      case "hash":
        return value === null ? null : Object.fromEntries(node.entries.map(([name, expr]) => [name, evalNode(expr, value)]));
      case "fn":
        return callFunction(node, value);
      case "expref":
        return node;
      default:
        return null;
    }
  }

  function callFunction(node, value) {
    const args = node.args.map((arg) => (arg.type === "expref" ? arg : evalNode(arg, value)));
    const [a, b] = args;
    const by = (expr) => (item) => evalNode(expr.expr, item);
    switch (node.name) {
      case "length":
        return typeof a === "string" || Array.isArray(a) ? a.length : isObject(a) ? Object.keys(a).length : null;
      case "keys":
        return isObject(a) ? Object.keys(a) : null;
      case "values":
        return isObject(a) ? Object.values(a) : null;
      case "join":
        return Array.isArray(b) ? b.join(a) : null;
      case "contains":
        return typeof a === "string" ? a.includes(b) : Array.isArray(a) ? a.some((v) => same(v, b)) : false;
      case "starts_with":
        return typeof a === "string" && a.startsWith(b);
      case "ends_with":
        return typeof a === "string" && a.endsWith(b);
      case "sort":
        return Array.isArray(a) ? a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)) : null;
      case "sort_by":
        return Array.isArray(a) ? a.slice().sort((x, y) => { const [p, q] = [by(b)(x), by(b)(y)]; return p < q ? -1 : p > q ? 1 : 0; }) : null;
      case "reverse":
        return Array.isArray(a) ? a.slice().reverse() : typeof a === "string" ? [...a].reverse().join("") : null;
      case "min":
        return Array.isArray(a) && a.length ? a.reduce((m, v) => (v < m ? v : m)) : null;
      case "max":
        return Array.isArray(a) && a.length ? a.reduce((m, v) => (v > m ? v : m)) : null;
      case "min_by":
        return Array.isArray(a) && a.length ? a.reduce((m, v) => (by(b)(v) < by(b)(m) ? v : m)) : null;
      case "max_by":
        return Array.isArray(a) && a.length ? a.reduce((m, v) => (by(b)(v) > by(b)(m) ? v : m)) : null;
      case "sum":
        return Array.isArray(a) ? a.reduce((s, v) => s + (Number(v) || 0), 0) : null;
      case "avg":
        return Array.isArray(a) && a.length ? a.reduce((s, v) => s + (Number(v) || 0), 0) / a.length : null;
      case "map":
        return Array.isArray(b) ? b.map(by(a)) : null;
      case "to_string":
        return typeof a === "string" ? a : JSON.stringify(a);
      case "to_number": {
        const n = Number(a);
        return a === null || isNaN(n) ? null : n;
      }
      case "to_array":
        return Array.isArray(a) ? a : [a];
      case "not_null":
        return args.find((v) => v !== null && v !== undefined) ?? null;
      case "type":
        return a === null ? "null" : Array.isArray(a) ? "array" : typeof a === "object" ? "object" : typeof a;
      case "abs":
        return Math.abs(a);
      case "floor":
        return Math.floor(a);
      case "ceil":
        return Math.ceil(a);
      case "merge":
        return Object.assign({}, ...args.filter(isObject));
      default:
        throw new Error(`JMESPath has no function ${node.name}()`);
    }
  }

  const parsed = new Map();
  /** `$jmespath(data, "people[?age > `30`].name")`. */
  global.__cf_jmespath = function (data, expression) {
    let tree = parsed.get(expression);
    if (!tree) {
      tree = parse(String(expression));
      if (parsed.size > 500) parsed.clear();
      parsed.set(expression, tree);
    }
    const plainData = data === undefined ? null : JSON.parse(JSON.stringify(data));
    return evalNode(tree, plainData);
  };
})(globalThis);
