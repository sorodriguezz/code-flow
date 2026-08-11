import {
  defaultAuth,
  defaultRequestSpec,
  type ApiProtocol,
  type ApiRequestSpec,
  type ApiVariable,
  type AuthConfig,
  type ImportedCollection,
  type ImportedItem,
  type ImportFormat,
  type ImportOptions,
  type ImportResult,
  type JwtAlgorithm,
  type KeyValue,
  type OAuth2GrantType,
  type RawLanguage,
  type SavedExample,
} from "../../types/api";
import type { NativeExport } from "./exporters";

/**
 * Readers for every format a user is likely to paste or drop on the import panel.
 *
 * Two rules hold across all of them:
 *
 * 1. **Nothing throws.** A half-parsed collection is useful; an exception is not. Anything that
 *    can't be mapped lands in `warnings` and the rest of the tree still comes through. That is
 *    what makes "paste whatever Chrome DevTools gave you" a viable interaction.
 * 2. **`{{var}}` is opaque.** No importer interpolates, decodes or re-encodes a value that could
 *    hold a template — a URL-decoded `{{token}}` stops being a variable reference.
 */

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function objs(v: unknown): Json[] {
  return arr(v).filter(isObj);
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function parseJsonSafe(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Non-string values become JSON so an example never renders as `[object Object]`. */
function scalarText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function kv(key: string, value: string, extra: Partial<KeyValue> = {}): KeyValue {
  return {
    id: crypto.randomUUID(),
    key,
    value,
    description: "",
    enabled: true,
    type: "text",
    ...extra,
  };
}

function variable(key: string, value: string, extra: Partial<ApiVariable> = {}): ApiVariable {
  return {
    id: crypto.randomUUID(),
    key,
    initialValue: value,
    currentValue: value,
    secret: false,
    enabled: true,
    description: "",
    ...extra,
  };
}

function decodeSafe(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, " "));
  } catch {
    return v;
  }
}

/**
 * Query strings live in `params`, never in `url` — the resolver folds them back in on send, so
 * keeping both would double every parameter. Values stay percent-encoded exactly as written.
 */
function splitQuery(rawUrl: string): { url: string; params: KeyValue[] } {
  const hashAt = rawUrl.indexOf("#");
  const fragment = hashAt >= 0 ? rawUrl.slice(hashAt) : "";
  const withoutHash = hashAt >= 0 ? rawUrl.slice(0, hashAt) : rawUrl;
  const qAt = withoutHash.indexOf("?");
  if (qAt < 0) return { url: withoutHash + fragment, params: [] };
  const params = withoutHash
    .slice(qAt + 1)
    .split("&")
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? kv(pair, "") : kv(pair.slice(0, eq), pair.slice(eq + 1));
    });
  return { url: withoutHash.slice(0, qAt) + fragment, params };
}

function headerValue(headers: KeyValue[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.key.toLowerCase() === lower)?.value ?? "";
}

function languageFor(contentType: string, sample: string): RawLanguage {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("html")) return "html";
  if (ct.includes("javascript")) return "javascript";
  if (ct.includes("text/")) return "text";
  const head = sample.trimStart();
  if ((head.startsWith("{") || head.startsWith("[")) && parseJsonSafe(sample) !== undefined) {
    return "json";
  }
  if (head.startsWith("<")) return "xml";
  return "text";
}

/** `a=1&b=2` shaped payloads, which curl and HAR both leave as an opaque string. */
function looksLikeFormBody(text: string): boolean {
  return /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(text.trim()) && text.includes("=");
}

function formRows(text: string): KeyValue[] {
  return text
    .split("&")
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? kv(pair, "") : kv(pair.slice(0, eq), pair.slice(eq + 1));
    });
}

/** Percent-encodes a value while leaving `{{template}}` spans intact. */
function encodePreservingVars(value: string): string {
  return value
    .split(/(\{\{[^}]*\}\})/g)
    .map((segment) => (segment.startsWith("{{") ? segment : encodeURIComponent(segment)))
    .join("");
}

function requestItem(name: string, spec: ApiRequestSpec): ImportedItem {
  return { kind: "request", name, spec };
}

function emptyCollection(name: string): ImportedCollection {
  return {
    name,
    description: "",
    auth: null,
    variables: [],
    preScript: "",
    postScript: "",
    items: [],
  };
}

function nameFromUrl(method: string, url: string): string {
  const withoutQuery = url.split("?")[0];
  const path = withoutQuery.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, "");
  return `${method} ${path || withoutQuery || "/"}`.trim();
}

function hostOf(url: string): string {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(url);
  return match ? match[1] : "";
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Sniffs the format from structure alone — never from a filename, and never by attempting a full
 * parse. A wrong guess sends the user's collection through the wrong mapper and produces silent
 * nonsense, so anything ambiguous returns `null` and the UI asks.
 */
export function detectFormat(text: string): ImportFormat | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (looksLikeCurl(trimmed)) return "curl";

  const doc = parseJsonSafe(trimmed);
  if (!isObj(doc)) {
    // A YAML spec is still recognizably OpenAPI; `importAny` explains why it can't read it.
    if (/^\s*(?:openapi|swagger)\s*:\s*["']?\d/m.test(trimmed)) return "openapi";
    return null;
  }

  if (str(doc.format) === "codeflow-api") return "codeflow";
  if (isObj(doc.log) && Array.isArray(doc.log.entries)) return "har";
  if (str(doc._type) === "export" && Array.isArray(doc.resources)) return "insomnia";
  if (typeof doc.openapi === "string" || typeof doc.swagger === "string") return "openapi";

  const info = isObj(doc.info) ? doc.info : null;
  if (info && /schema\.getpostman\.com|collection\/v2/.test(str(info.schema))) return "postman";
  if (Array.isArray(doc.values) && ("_postman_variable_scope" in doc || typeof doc.name === "string")) {
    return "postman";
  }
  if (info && Array.isArray(doc.item)) return "postman";
  if (info && isObj(doc.paths)) return "openapi";
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Async only because of the YAML fallback — see `parseDocument`. Everything downstream of it is
 * still ordinary synchronous work, so a JSON document resolves on the first microtask; nothing here
 * waits on I/O. Callers that awaited a file read already were unaffected; the one that runs on a
 * keystroke debounce (`ImportModal`) has to guard against an out-of-order resolve, and does.
 */
export async function importAny(text: string, options: ImportOptions = {}): Promise<ImportResult> {
  const warnings: string[] = [];
  const format = detectFormat(text);
  const result = await runImport(text, format, warnings, options);
  // The same unmapped construct usually repeats once per request; one line per distinct problem
  // is a report, one per occurrence is a wall.
  result.warnings = [...new Set(result.warnings)];
  return result;
}

/**
 * JSON first, YAML second.
 *
 * YAML is a superset of JSON, so `parseYaml` alone would read both — but it is an order of
 * magnitude slower, and the documents that arrive here are routinely several megabytes and get
 * re-parsed on a keystroke debounce. The fast path stays the common one.
 *
 * The `yaml` package is also ~40 kB of the API chunk that a Postman/HAR/Insomnia/cURL/JSON-OpenAPI
 * import never touches, so it is imported *inside* the fallback — after the JSON fast path has
 * already returned. That is the whole reason this function (and `runImport`, and `importAny`) are
 * async; nothing else in the import pipeline awaits anything. `detectFormat` deliberately stays
 * synchronous: it only regex-sniffs YAML, never parses it, and it runs on every keystroke.
 */
async function parseDocument(text: string): Promise<unknown> {
  const json = parseJsonSafe(text);
  if (json !== undefined) return json;
  try {
    const { parse: parseYaml } = await import("yaml");
    return parseYaml(text, { maxAliasCount: 1000 });
  } catch {
    return undefined;
  }
}

async function runImport(
  text: string,
  format: ImportFormat | null,
  warnings: string[],
  options: ImportOptions,
): Promise<ImportResult> {
  const empty = (f: ImportFormat): ImportResult => ({
    format: f,
    collections: [],
    environments: [],
    warnings,
  });

  if (format === "curl") return importCurl(text, warnings);
  if (format === null) {
    warnings.push(
      "Unrecognized format — expected a Postman, OpenAPI/Swagger, HAR, Insomnia or CodeFlow export, or a cURL command.",
    );
    return empty("codeflow");
  }

  const doc = await parseDocument(text);
  if (!isObj(doc)) {
    warnings.push("The document isn't valid JSON or YAML.");
    return empty(format);
  }

  try {
    switch (format) {
      case "postman":
        return importPostman(doc, warnings);
      case "openapi":
        return importOpenApi(doc, warnings, options);
      case "har":
        return importHar(doc, warnings);
      case "insomnia":
        return importInsomnia(doc, warnings);
      case "codeflow":
        return importNative(doc, warnings);
    }
  } catch (e) {
    // A defect in a mapper must not cost the user the whole import dialog.
    warnings.push(`Import stopped early: ${e instanceof Error ? e.message : String(e)}`);
    return empty(format);
  }
}

// ---------------------------------------------------------------------------
// cURL
// ---------------------------------------------------------------------------

const CURL_WORD = /^(?:[\w.\\/-]*[\\/])?curl(?:\.exe)?$/i;

export function looksLikeCurl(text: string): boolean {
  return /^\s*(?:[\w.\\/-]*[\\/])?curl(?:\.exe)?(?:\s|$)/i.test(text);
}

/** Short options and the long name each maps to; the long name is the only thing acted on. */
const CURL_SHORT: Record<string, string> = {
  A: "user-agent",
  b: "cookie",
  c: "cookie-jar",
  C: "continue-at",
  d: "data",
  D: "dump-header",
  e: "referer",
  E: "cert",
  f: "fail",
  F: "form",
  g: "globoff",
  G: "get",
  h: "help",
  H: "header",
  i: "include",
  I: "head",
  j: "junk-session-cookies",
  J: "remote-header-name",
  k: "insecure",
  K: "config",
  l: "list-only",
  L: "location",
  m: "max-time",
  M: "manual",
  n: "netrc",
  N: "no-buffer",
  o: "output",
  O: "remote-name",
  p: "proxytunnel",
  P: "ftp-port",
  q: "disable",
  Q: "quote",
  r: "range",
  R: "remote-time",
  s: "silent",
  S: "show-error",
  t: "telnet-option",
  T: "upload-file",
  u: "user",
  U: "proxy-user",
  v: "verbose",
  V: "version",
  w: "write-out",
  x: "proxy",
  X: "request",
  y: "speed-time",
  Y: "speed-limit",
  z: "time-cond",
  Z: "parallel",
  "#": "progress-bar",
  "0": "http1.0",
  "1": "tlsv1",
  "2": "sslv2",
  "3": "sslv3",
  "4": "ipv4",
  "6": "ipv6",
};

const CURL_VALUE_FLAGS = new Set([
  "aws-sigv4",
  "cacert",
  "capath",
  "cert",
  "cert-type",
  "ciphers",
  "config",
  "connect-timeout",
  "continue-at",
  "cookie",
  "cookie-jar",
  "data",
  "data-ascii",
  "data-binary",
  "data-raw",
  "data-urlencode",
  "dns-servers",
  "dump-header",
  "expect100-timeout",
  "form",
  "form-string",
  "ftp-port",
  "header",
  "interface",
  "json",
  "key",
  "key-type",
  "limit-rate",
  "local-port",
  "mail-from",
  "mail-rcpt",
  "max-filesize",
  "max-redirs",
  "max-time",
  "netrc-file",
  "noproxy",
  "oauth2-bearer",
  "output",
  "output-dir",
  "pass",
  "proto",
  "proto-default",
  "proto-redir",
  "proxy",
  "proxy-user",
  "pubkey",
  "quote",
  "range",
  "referer",
  "request",
  "request-target",
  "resolve",
  "retry",
  "retry-delay",
  "retry-max-time",
  "service-name",
  "socks4",
  "socks4a",
  "socks5",
  "socks5-hostname",
  "speed-limit",
  "speed-time",
  "stderr",
  "telnet-option",
  "time-cond",
  "tls13-ciphers",
  "trace",
  "trace-ascii",
  "unix-socket",
  "upload-file",
  "url",
  "user",
  "user-agent",
  "write-out",
]);

const CURL_BOOL_FLAGS = new Set([
  "anyauth",
  "append",
  "basic",
  "compressed",
  "create-dirs",
  "digest",
  "disable",
  "fail",
  "fail-with-body",
  "get",
  "globoff",
  "head",
  "help",
  "http0.9",
  "http1.0",
  "http1.1",
  "http2",
  "http2-prior-knowledge",
  "http3",
  "include",
  "insecure",
  "ipv4",
  "ipv6",
  "junk-session-cookies",
  "list-only",
  "location",
  "location-trusted",
  "manual",
  "negotiate",
  "netrc",
  "next",
  "no-alpn",
  "no-buffer",
  "no-keepalive",
  "no-progress-meter",
  "no-sessionid",
  "ntlm",
  "parallel",
  "path-as-is",
  "progress-bar",
  "proxytunnel",
  "raw",
  "remote-header-name",
  "remote-name",
  "remote-time",
  "show-error",
  "silent",
  "ssl",
  "ssl-no-revoke",
  "ssl-reqd",
  "sslv2",
  "sslv3",
  "styled-output",
  "suppress-connect-headers",
  "tcp-nodelay",
  "tlsv1",
  "tlsv1.0",
  "tlsv1.1",
  "tlsv1.2",
  "tlsv1.3",
  "tr-encoding",
  "trace-time",
  "use-ascii",
  "verbose",
  "version",
  "xattr",
]);

const SHELL_OPERATORS = new Set(["&&", "||", "|", ";", "&", "(", ")", "{", "}"]);

function readSingleQuoted(input: string, start: number): { text: string; next: number } {
  const end = input.indexOf("'", start);
  if (end < 0) return { text: input.slice(start), next: input.length };
  return { text: input.slice(start, end), next: end + 1 };
}

function readDoubleQuoted(input: string, start: number): { text: string; next: number } {
  let out = "";
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') return { text: out, next: i + 1 };
    if (ch === "\\") {
      const next = input[i + 1];
      // In double quotes the shell only honours a handful of escapes; everything else, notably
      // `\p` in a Windows path, keeps its backslash.
      if (next === '"' || next === "\\" || next === "$" || next === "`") {
        out += next;
        i += 2;
        continue;
      }
      if (next === "\n") {
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { text: out, next: i };
}

function readAnsiCQuoted(input: string, start: number): { text: string; next: number } {
  let out = "";
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'") return { text: out, next: i + 1 };
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const esc = input[i + 1];
    i += 2;
    switch (esc) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "e":
      case "E":
        out += "\x1b";
        break;
      case "x":
      case "u":
      case "U": {
        const width = esc === "x" ? 2 : esc === "u" ? 4 : 8;
        const digits = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(input.slice(i));
        if (digits) {
          out += String.fromCodePoint(parseInt(digits[0], 16));
          i += digits[0].length;
        } else {
          out += esc;
        }
        break;
      }
      default:
        if (esc === undefined) return { text: out, next: i };
        out += esc;
    }
  }
  return { text: out, next: i };
}

/**
 * Splits a pasted command the way a POSIX shell would, plus the two things a paste actually
 * carries that a shell wouldn't: `$'…'` from DevTools' "Copy as cURL (bash)" and `^`-continued
 * lines from its cmd.exe variant.
 */
function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let i = 0;
  const flush = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  while (i < input.length) {
    const ch = input[i];
    if ((ch === "\\" || ch === "^") && (input[i + 1] === "\n" || input[i + 1] === "\r")) {
      i += input[i + 1] === "\r" && input[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < input.length) {
        current += input[i + 1];
        started = true;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "$" && input[i + 1] === "'") {
      const read = readAnsiCQuoted(input, i + 2);
      current += read.text;
      started = true;
      i = read.next;
      continue;
    }
    if (ch === "$" && input[i + 1] === '"') {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const read = readSingleQuoted(input, i + 1);
      current += read.text;
      started = true;
      i = read.next;
      continue;
    }
    if (ch === '"') {
      const read = readDoubleQuoted(input, i + 1);
      current += read.text;
      started = true;
      i = read.next;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  flush();
  return tokens;
}

/** One command per `curl` word: quoting already swallowed any `curl` that was really a value. */
function splitCurlCommands(tokens: string[]): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (CURL_WORD.test(token)) {
      if (current.length) commands.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) commands.push(current);
  return commands;
}

interface CurlDataPart {
  /** Set only for `--data-urlencode name=value`, where the name is known separately. */
  key: string | null;
  value: string;
  /** Path from an `@file` argument. */
  file: string | null;
  urlencode: boolean;
}

/**
 * Parses one cURL invocation. Returns `null` when no URL could be found — every other problem
 * degrades to a warning, because the realistic failure is one unrecognized flag in an otherwise
 * perfectly good DevTools paste.
 */
export function parseCurl(command: string): ApiRequestSpec | null {
  const commands = splitCurlCommands(tokenizeShell(command));
  const tokens = commands[0];
  if (!tokens) return null;
  return parseCurlTokens(tokens, []);
}

function parseCurlTokens(tokens: string[], warnings: string[]): ApiRequestSpec | null {
  const spec = defaultRequestSpec("http");
  const headers: KeyValue[] = [];
  const form: KeyValue[] = [];
  const data: CurlDataPart[] = [];
  const urls: string[] = [];
  let method = "";
  let user = "";
  let authScheme: "basic" | "digest" = "basic";
  let uploadFile = "";
  let asGet = false;
  let asHead = false;
  let compressed = false;

  const setHeader = (raw: string) => {
    const colon = raw.indexOf(":");
    if (colon < 0) {
      // `-H "X-Empty;"` is curl's way of sending a header with no value.
      const bare = raw.replace(/;$/, "").trim();
      if (bare) headers.push(kv(bare, ""));
      return;
    }
    headers.push(kv(raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()));
  };

  const addData = (value: string, opts: { allowFile: boolean; urlencode?: boolean }) => {
    if (opts.urlencode) {
      const at = value.indexOf("@");
      const eq = value.indexOf("=");
      if (at >= 0 && (eq < 0 || at < eq)) {
        warnings.push(`--data-urlencode reading from a file isn't supported: ${value}`);
        return;
      }
      if (eq < 0) {
        data.push({ key: null, value, file: null, urlencode: true });
        return;
      }
      data.push({
        key: value.slice(0, eq),
        value: value.slice(eq + 1),
        file: null,
        urlencode: true,
      });
      return;
    }
    if (opts.allowFile && value.startsWith("@")) {
      const path = value.slice(1);
      if (path === "-") {
        warnings.push("Body read from stdin (@-) can't be imported.");
        return;
      }
      data.push({ key: null, value: "", file: path, urlencode: false });
      return;
    }
    data.push({ key: null, value, file: null, urlencode: false });
  };

  const addForm = (raw: string) => {
    const eq = raw.indexOf("=");
    if (eq < 0) {
      warnings.push(`Ignored malformed --form value: ${raw}`);
      return;
    }
    const name = raw.slice(0, eq);
    let rest = raw.slice(eq + 1);
    let contentType = "";
    let filename = "";
    const parts = rest.split(";");
    if (parts.length > 1) {
      rest = parts[0];
      for (const attr of parts.slice(1)) {
        const [attrKey, ...attrRest] = attr.split("=");
        const attrValue = attrRest.join("=");
        if (attrKey.trim() === "type") contentType = attrValue;
        else if (attrKey.trim() === "filename") filename = attrValue;
      }
    }
    if (rest.startsWith("@") || rest.startsWith("<")) {
      form.push(
        kv(name, "", {
          type: "file",
          src: rest.slice(1),
          // `;type=` has no column of its own, so it survives where a human will still see it.
          description: [contentType && `Content-Type: ${contentType}`, filename && `filename: ${filename}`]
            .filter(Boolean)
            .join(", "),
        }),
      );
      return;
    }
    form.push(kv(name, rest, { description: contentType ? `Content-Type: ${contentType}` : "" }));
  };

  const applyFlag = (name: string, value: string | null): void => {
    switch (name) {
      case "request":
        method = (value ?? "").toUpperCase();
        return;
      case "header":
        if (value !== null) setHeader(value);
        return;
      case "url":
        if (value) urls.push(value);
        return;
      case "data":
      case "data-ascii":
        addData(value ?? "", { allowFile: true });
        return;
      case "data-raw":
        addData(value ?? "", { allowFile: false });
        return;
      case "data-binary":
        addData(value ?? "", { allowFile: true });
        return;
      case "data-urlencode":
        addData(value ?? "", { allowFile: false, urlencode: true });
        return;
      case "json":
        addData(value ?? "", { allowFile: true });
        if (!headerValue(headers, "content-type")) headers.push(kv("Content-Type", "application/json"));
        if (!headerValue(headers, "accept")) headers.push(kv("Accept", "application/json"));
        return;
      case "form":
      case "form-string":
        if (value !== null) addForm(value);
        return;
      case "user":
        user = value ?? "";
        return;
      case "oauth2-bearer":
        spec.auth = defaultAuth("bearer");
        spec.auth.bearer.token = value ?? "";
        return;
      case "aws-sigv4": {
        // `aws:amz:<region>:<service>` — the keys themselves arrive through `-u`.
        const parts = (value ?? "").split(":");
        spec.auth = defaultAuth("awsv4");
        spec.auth.awsv4.region = parts[2] ?? "";
        spec.auth.awsv4.service = parts[3] ?? "";
        return;
      }
      case "digest":
        authScheme = "digest";
        return;
      case "basic":
        authScheme = "basic";
        return;
      case "user-agent":
        headers.push(kv("User-Agent", value ?? ""));
        return;
      case "referer":
        headers.push(kv("Referer", value ?? ""));
        return;
      case "cookie":
        if (value && value.includes("=")) headers.push(kv("Cookie", value));
        else if (value) warnings.push(`Cookies read from a file aren't imported: ${value}`);
        return;
      case "upload-file":
        uploadFile = value ?? "";
        return;
      case "get":
        asGet = true;
        return;
      case "head":
        asHead = true;
        return;
      case "insecure":
        spec.settings.verifySsl = false;
        return;
      case "location":
        spec.settings.followRedirects = true;
        return;
      case "location-trusted":
        spec.settings.followRedirects = true;
        spec.settings.keepAuthOnRedirect = true;
        return;
      case "max-redirs":
        spec.settings.maxRedirects = num(value, 10);
        return;
      case "max-time":
        spec.settings.timeoutMs = Math.round(num(value, 0) * 1000) || null;
        return;
      case "path-as-is":
        spec.settings.encodeUrl = false;
        return;
      case "compressed":
        compressed = true;
        return;
      case "proxy":
      case "proxy-user":
        warnings.push("Proxy settings are configured globally in CodeFlow, not per request.");
        return;
      case "cert":
      case "key":
      case "cacert":
      case "capath":
        warnings.push("Client certificates are configured in the API settings, not per request.");
        return;
      case "next":
        warnings.push("--next isn't supported; only the first request in the command was imported.");
        return;
      default:
        if (!CURL_BOOL_FLAGS.has(name) && !CURL_VALUE_FLAGS.has(name)) {
          warnings.push(`Ignored unsupported cURL option: --${name}`);
        }
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SHELL_OPERATORS.has(token)) continue;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = (eq > 0 ? token.slice(2, eq) : token.slice(2)).toLowerCase();
      const inlineValue = eq > 0 ? token.slice(eq + 1) : null;
      if (CURL_VALUE_FLAGS.has(name)) {
        applyFlag(name, inlineValue ?? tokens[++i] ?? "");
      } else if (CURL_BOOL_FLAGS.has(name) || name.startsWith("no-")) {
        applyFlag(name, inlineValue);
      } else if (inlineValue !== null) {
        applyFlag(name, inlineValue);
      } else {
        // Unknown option: only steal the next token if it can't be the URL.
        const next = tokens[i + 1];
        const consumable = next !== undefined && !next.startsWith("-") && !isLikelyUrl(next);
        applyFlag(name, consumable ? tokens[++i] : null);
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const cluster = token.slice(1);
      for (let c = 0; c < cluster.length; c++) {
        const long = CURL_SHORT[cluster[c]];
        if (!long) {
          warnings.push(`Ignored unsupported cURL option: -${cluster[c]}`);
          continue;
        }
        if (CURL_VALUE_FLAGS.has(long)) {
          const attached = cluster.slice(c + 1);
          applyFlag(long, attached.length ? attached : (tokens[++i] ?? ""));
          break;
        }
        applyFlag(long, null);
      }
      continue;
    }

    urls.push(token);
  }

  if (!urls.length) return null;
  if (urls.length > 1) {
    warnings.push(`Only the first of ${urls.length} URLs in the command was imported.`);
  }

  const split = splitQuery(normalizeUrl(urls[0]));
  spec.url = split.url;
  spec.params = split.params;
  spec.headers = headers;

  if (compressed && !headerValue(headers, "accept-encoding")) {
    headers.push(kv("Accept-Encoding", "gzip, deflate, br"));
  }
  if (user) {
    const colon = user.indexOf(":");
    const username = colon < 0 ? user : user.slice(0, colon);
    const password = colon < 0 ? "" : user.slice(colon + 1);
    if (spec.auth.type === "awsv4") {
      spec.auth.awsv4.accessKey = username;
      spec.auth.awsv4.secretKey = password;
    } else {
      spec.auth = defaultAuth(authScheme);
      // Checked off the freshly-built config rather than off `authScheme`: the flag is assigned
      // inside the option-parsing callback, which TypeScript can't follow, so `authScheme` is
      // still narrowed to its initializer here.
      if (spec.auth.type === "digest") spec.auth.digest = { username, password };
      else spec.auth.basic = { username, password };
    }
  }

  if (asGet && data.length) {
    for (const part of data) {
      if (part.file) {
        warnings.push("`-G` with a file body isn't supported.");
        continue;
      }
      if (part.key !== null) spec.params.push(kv(part.key, part.value));
      else spec.params.push(...formRows(part.value));
    }
  } else {
    applyCurlBody(spec, data, form, uploadFile, headers, warnings);
  }

  spec.method =
    method ||
    (asHead
      ? "HEAD"
      : uploadFile
        ? "PUT"
        : spec.body.mode !== "none" && !asGet
          ? "POST"
          : "GET");
  return spec;
}

function applyCurlBody(
  spec: ApiRequestSpec,
  data: CurlDataPart[],
  form: KeyValue[],
  uploadFile: string,
  headers: KeyValue[],
  warnings: string[],
): void {
  if (form.length) {
    spec.body.mode = "formdata";
    spec.body.formdata = form;
    return;
  }
  if (uploadFile) {
    spec.body.mode = "binary";
    spec.body.binaryPath = uploadFile;
    return;
  }
  if (!data.length) return;

  const fileParts = data.filter((d) => d.file);
  if (fileParts.length) {
    if (fileParts.length > 1 || data.length > fileParts.length) {
      warnings.push("Only the first file body of the command was imported.");
    }
    spec.body.mode = "binary";
    spec.body.binaryPath = fileParts[0].file ?? "";
    return;
  }

  const contentType = headerValue(headers, "content-type").toLowerCase();
  const allNamedUrlencode = data.every((d) => d.urlencode && d.key !== null);
  if (allNamedUrlencode) {
    spec.body.mode = "urlencoded";
    spec.body.urlencoded = data.map((d) => kv(d.key ?? "", d.value));
    return;
  }

  const joined = data
    .map((d) =>
      d.urlencode
        ? d.key
          ? `${d.key}=${encodePreservingVars(d.value)}`
          : encodePreservingVars(d.value)
        : d.value,
    )
    .join("&");

  if (
    contentType.includes("x-www-form-urlencoded") ||
    (!contentType && looksLikeFormBody(joined))
  ) {
    spec.body.mode = "urlencoded";
    spec.body.urlencoded = formRows(joined);
    return;
  }
  spec.body.mode = "raw";
  spec.body.raw = joined;
  spec.body.rawLanguage = languageFor(contentType, joined);
}

function isLikelyUrl(token: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token) || /^[\w.-]+\.[a-zA-Z]{2,}(?:[:/?]|$)/.test(token);
}

/** curl accepts a schemeless host; loopback gets http because nothing serves TLS there by default. */
function normalizeUrl(url: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) || url.startsWith("{{")) return url;
  const host = url.split(/[/?#]/)[0];
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(host);
  return `${local ? "http" : "https"}://${url}`;
}

function importCurl(text: string, warnings: string[]): ImportResult {
  const commands = splitCurlCommands(tokenizeShell(text));
  const collection = emptyCollection("cURL import");
  for (const tokens of commands) {
    const spec = parseCurlTokens(tokens, warnings);
    if (!spec) {
      warnings.push("Skipped a command with no URL.");
      continue;
    }
    collection.items.push(requestItem(nameFromUrl(spec.method, spec.url), spec));
  }
  return {
    format: "curl",
    collections: collection.items.length ? [collection] : [],
    environments: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Postman
// ---------------------------------------------------------------------------

/** Postman writes descriptions either as a string or as `{ content, type }`. */
function pmDescription(v: unknown): string {
  if (typeof v === "string") return v;
  if (isObj(v)) return str(v.content);
  return "";
}

function pmKeyValues(v: unknown): KeyValue[] {
  return objs(v).map((row) =>
    kv(str(row.key ?? row.name), str(row.value), {
      description: pmDescription(row.description),
      enabled: row.disabled !== true,
    }),
  );
}

/** `header` may arrive as the raw block a user pasted into Postman's bulk editor. */
function pmHeaders(v: unknown): KeyValue[] {
  if (typeof v === "string") {
    return v
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const colon = line.indexOf(":");
        return colon < 0 ? kv(line, "") : kv(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      });
  }
  return pmKeyValues(v);
}

function pmAuthParams(node: Json, kind: string): Record<string, string> {
  const raw = node[kind];
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of objs(raw)) out[str(entry.key)] = str(entry.value);
  } else if (isObj(raw)) {
    for (const [key, value] of Object.entries(raw)) out[key] = str(value);
  }
  return out;
}

const JWT_ALGORITHMS: JwtAlgorithm[] = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
];

function pmAuth(node: unknown, warnings: string[]): AuthConfig | null {
  if (!isObj(node)) return null;
  const type = str(node.type);
  if (!type) return null;
  const params = pmAuthParams(node, type);
  switch (type) {
    case "noauth":
      return defaultAuth("none");
    case "basic": {
      const auth = defaultAuth("basic");
      auth.basic = { username: params.username ?? "", password: params.password ?? "" };
      return auth;
    }
    case "bearer": {
      const auth = defaultAuth("bearer");
      auth.bearer = { token: params.token ?? "" };
      return auth;
    }
    case "apikey": {
      const auth = defaultAuth("apikey");
      auth.apikey = {
        key: params.key ?? "",
        value: params.value ?? "",
        addTo: params.in === "query" ? "query" : "header",
      };
      return auth;
    }
    case "digest": {
      const auth = defaultAuth("digest");
      auth.digest = { username: params.username ?? "", password: params.password ?? "" };
      return auth;
    }
    case "awsv4": {
      const auth = defaultAuth("awsv4");
      auth.awsv4 = {
        accessKey: params.accessKey ?? "",
        secretKey: params.secretKey ?? "",
        sessionToken: params.sessionToken ?? "",
        region: params.region ?? "",
        service: params.service ?? "",
      };
      return auth;
    }
    case "jwt": {
      const auth = defaultAuth("jwt");
      const algorithm = params.algorithm as JwtAlgorithm | undefined;
      auth.jwt = {
        ...auth.jwt,
        algorithm: algorithm && JWT_ALGORITHMS.includes(algorithm) ? algorithm : "HS256",
        secret: params.secret ?? "",
        secretBase64: params.isSecretBase64Encoded === "true",
        headerJson: params.header || "{}",
        payloadJson: params.payload || "{}",
        addTo: params.addTokenTo === "queryParams" ? "query" : "header",
        headerPrefix: params.headerPrefix || "Bearer",
        queryParamName: params.queryParamKey || "token",
      };
      return auth;
    }
    case "oauth2": {
      const auth = defaultAuth("oauth2");
      const grant = params.grant_type ?? "";
      const grantType: OAuth2GrantType =
        grant === "authorization_code_with_pkce"
          ? "authorization_code_pkce"
          : grant === "password_credentials"
            ? "password"
            : grant === "authorization_code" || grant === "implicit" || grant === "client_credentials"
              ? grant
              : "client_credentials";
      auth.oauth2 = {
        ...auth.oauth2,
        grantType,
        authUrl: params.authUrl ?? "",
        accessTokenUrl: params.accessTokenUrl ?? "",
        clientId: params.clientId ?? "",
        clientSecret: params.clientSecret ?? "",
        scope: params.scope ?? "",
        state: params.state ?? "",
        username: params.username ?? "",
        password: params.password ?? "",
        redirectUri: params.redirect_uri || auth.oauth2.redirectUri,
        audience: params.audience ?? "",
        resource: params.resource ?? "",
        clientAuth: params.client_authentication === "body" ? "body" : "header",
        accessToken: params.accessToken ?? "",
        refreshToken: params.refreshToken ?? "",
        headerPrefix: params.headerPrefix || "Bearer",
        addTo: params.addTokenTo === "queryParams" ? "query" : "header",
      };
      return auth;
    }
    default:
      warnings.push(`Postman auth type "${type}" isn't supported; the request was left with no auth.`);
      return defaultAuth("none");
  }
}

function pmScripts(node: Json): { pre: string; post: string } {
  let pre = "";
  let post = "";
  for (const event of objs(node.event)) {
    const script = isObj(event.script) ? event.script : {};
    const exec = script.exec;
    const code = Array.isArray(exec) ? exec.map((line) => str(line)).join("\n") : str(exec);
    if (!code.trim()) continue;
    if (str(event.listen) === "prerequest") pre = code;
    else if (str(event.listen) === "test") post = code;
  }
  return { pre, post };
}

function pmVariables(v: unknown): ApiVariable[] {
  return objs(v).map((row) =>
    variable(str(row.key), str(row.value), {
      secret: str(row.type) === "secret",
      enabled: row.disabled !== true && row.enabled !== false,
      description: pmDescription(row.description),
    }),
  );
}

function pmUrl(v: unknown): { url: string; params: KeyValue[]; pathVars: KeyValue[] } {
  if (typeof v === "string") {
    const split = splitQuery(v);
    return { ...split, pathVars: [] };
  }
  if (!isObj(v)) return { url: "", params: [], pathVars: [] };

  const pathVars = objs(v.variable)
    .filter((entry) => str(entry.key))
    .map((entry) =>
      kv(str(entry.key), str(entry.value), { description: pmDescription(entry.description) }),
    );

  const structuredQuery = Array.isArray(v.query) ? pmKeyValues(v.query) : null;
  const raw = str(v.raw);
  if (raw) {
    const split = splitQuery(raw);
    return { url: split.url, params: structuredQuery ?? split.params, pathVars };
  }

  const protocol = str(v.protocol);
  const host = Array.isArray(v.host) ? v.host.map((h) => str(h)).join(".") : str(v.host);
  const port = str(v.port);
  const path = Array.isArray(v.path) ? v.path.map((p) => str(p)).join("/") : str(v.path);
  const authority = port ? `${host}:${port}` : host;
  const url = `${protocol ? `${protocol}://` : ""}${authority}${path ? `/${path.replace(/^\//, "")}` : ""}`;
  return { url, params: structuredQuery ?? [], pathVars };
}

function pmBody(spec: ApiRequestSpec, node: unknown, warnings: string[]): void {
  if (!isObj(node)) return;
  const mode = str(node.mode);
  switch (mode) {
    case "raw": {
      spec.body.mode = "raw";
      spec.body.raw = str(node.raw);
      const options = isObj(node.options) && isObj(node.options.raw) ? node.options.raw : {};
      const language = str(options.language);
      spec.body.rawLanguage =
        language === "json" ||
        language === "xml" ||
        language === "text" ||
        language === "javascript" ||
        language === "html"
          ? language
          : languageFor(headerValue(spec.headers, "content-type"), spec.body.raw);
      return;
    }
    case "formdata":
      spec.body.mode = "formdata";
      spec.body.formdata = objs(node.formdata).map((row) => {
        const src = Array.isArray(row.src) ? str(row.src[0]) : str(row.src);
        const isFile = str(row.type) === "file";
        return kv(str(row.key), isFile ? "" : str(row.value), {
          type: isFile ? "file" : "text",
          src: isFile ? src : "",
          description: pmDescription(row.description),
          enabled: row.disabled !== true,
        });
      });
      return;
    case "urlencoded":
      spec.body.mode = "urlencoded";
      spec.body.urlencoded = pmKeyValues(node.urlencoded);
      return;
    case "file":
      spec.body.mode = "binary";
      spec.body.binaryPath = isObj(node.file) ? str(node.file.src) : "";
      return;
    case "graphql": {
      const gql = isObj(node.graphql) ? node.graphql : {};
      spec.protocol = "graphql";
      spec.body.mode = "graphql";
      spec.body.graphql = {
        query: str(gql.query),
        variables: typeof gql.variables === "string" ? gql.variables : JSON.stringify(gql.variables ?? {}, null, 2),
        operationName: str(gql.operationName),
      };
      return;
    }
    case "":
      return;
    default:
      warnings.push(`Postman body mode "${mode}" isn't supported.`);
  }
}

function pmExamples(v: unknown): SavedExample[] {
  return objs(v).map((response) => ({
    id: crypto.randomUUID(),
    name: str(response.name) || str(response.code) || "Example",
    status: num(response.code, 200),
    statusText: str(response.status),
    headers: pmKeyValues(response.header),
    body: str(response.body),
  }));
}

function pmRequestSpec(node: Json, warnings: string[]): ApiRequestSpec {
  const spec = defaultRequestSpec("http");
  const request = node.request;
  if (typeof request === "string") {
    const split = splitQuery(request);
    spec.url = split.url;
    spec.params = split.params;
    spec.method = "GET";
    return spec;
  }
  if (!isObj(request)) return spec;

  spec.method = (str(request.method) || "GET").toUpperCase();
  spec.headers = pmHeaders(request.header);
  const url = pmUrl(request.url);
  spec.url = url.url;
  spec.params = url.params;
  spec.pathVars = url.pathVars;
  spec.description = pmDescription(request.description);
  pmBody(spec, request.body, warnings);

  const auth = pmAuth(request.auth, warnings);
  spec.auth = auth ?? defaultAuth("inherit");

  const scripts = pmScripts(node);
  spec.preScript = scripts.pre;
  spec.postScript = scripts.post;
  spec.examples = pmExamples(node.response);
  return spec;
}

function pmItems(nodes: Json[], warnings: string[]): ImportedItem[] {
  const items: ImportedItem[] = [];
  for (const node of nodes) {
    if (Array.isArray(node.item)) {
      const scripts = pmScripts(node);
      items.push({
        kind: "folder",
        name: str(node.name) || "Folder",
        description: pmDescription(node.description),
        auth: pmAuth(node.auth, warnings),
        preScript: scripts.pre,
        postScript: scripts.post,
        items: pmItems(objs(node.item), warnings),
      });
      continue;
    }
    if (node.request !== undefined) {
      items.push(requestItem(str(node.name) || "Request", pmRequestSpec(node, warnings)));
      continue;
    }
    warnings.push(`Skipped a Postman item with neither requests nor children: ${str(node.name)}`);
  }
  return items;
}

function importPostman(doc: Json, warnings: string[]): ImportResult {
  // Environment and Globals exports share the collection format's file extension but not its shape.
  if (Array.isArray(doc.values)) {
    return {
      format: "postman",
      collections: [],
      environments: [
        {
          name: str(doc.name) || (str(doc._postman_variable_scope) === "globals" ? "Globals" : "Environment"),
          variables: objs(doc.values).map((row) =>
            variable(str(row.key), str(row.value), {
              secret: str(row.type) === "secret",
              enabled: row.enabled !== false,
              description: pmDescription(row.description),
            }),
          ),
        },
      ],
      warnings,
    };
  }

  const info = isObj(doc.info) ? doc.info : {};
  if (!Array.isArray(doc.item) && Array.isArray(doc.requests)) {
    warnings.push("Postman Collection v1 isn't supported. Re-export the collection as v2.1.");
    return { format: "postman", collections: [], environments: [], warnings };
  }

  const scripts = pmScripts(doc);
  const collection: ImportedCollection = {
    name: str(info.name) || "Imported collection",
    description: pmDescription(info.description),
    auth: pmAuth(doc.auth, warnings),
    variables: pmVariables(doc.variable),
    preScript: scripts.pre,
    postScript: scripts.post,
    items: pmItems(objs(doc.item), warnings),
  };
  return { format: "postman", collections: [collection], environments: [], warnings };
}

// ---------------------------------------------------------------------------
// OpenAPI 3.x / Swagger 2.0
// ---------------------------------------------------------------------------

const OAS_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

interface OasContext {
  doc: Json;
  swagger: boolean;
  warnings: string[];
  /** Whether documented responses are mapped to saved examples. */
  examples: boolean;
  /** `ImportOptions.sourceUrl` — what a declared server is relative *to*, and the host when none. */
  sourceUrl: string;
  /** Variable names the imported auth blocks reference, collected as the operations are walked. */
  credentials: Set<string>;
}

/** Local `$ref` only. A remote document can't be fetched from here, so it becomes a warning and
 * an empty schema rather than a failed import. */
function deref(ctx: OasContext, node: unknown, depth = 0): unknown {
  if (!isObj(node) || typeof node.$ref !== "string" || depth > 16) return node;
  const ref = node.$ref;
  if (!ref.startsWith("#/")) {
    ctx.warnings.push(`Remote $ref not resolved: ${ref}`);
    return {};
  }
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => decodeSafe(s).replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor: unknown = ctx.doc;
  for (const segment of segments) {
    if (isObj(cursor)) cursor = cursor[segment];
    else if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
    else {
      ctx.warnings.push(`Unresolvable $ref: ${ref}`);
      return {};
    }
  }
  if (cursor === undefined) {
    ctx.warnings.push(`Unresolvable $ref: ${ref}`);
    return {};
  }
  return deref(ctx, cursor, depth + 1);
}

function stringExampleFor(format: string): string {
  switch (format) {
    case "date":
      return "2024-01-01";
    case "date-time":
      return "2024-01-01T00:00:00Z";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "email":
      return "user@example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "hostname":
      return "example.com";
    case "ipv4":
      return "127.0.0.1";
    case "password":
      return "password";
    case "byte":
    case "binary":
      return "";
    default:
      return "string";
  }
}

/** Builds the request body a user can actually edit: literal examples win, otherwise the schema
 * is walked into a skeleton. */
function synthesize(ctx: OasContext, schema: unknown, seen: Set<Json>, depth: number): unknown {
  const s = deref(ctx, schema);
  if (!isObj(s) || depth > 8) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (seen.has(s)) return {};
  seen.add(s);
  try {
    if (Array.isArray(s.allOf)) {
      const merged: Json = {};
      for (const part of s.allOf) {
        const value = synthesize(ctx, part, seen, depth + 1);
        if (isObj(value)) Object.assign(merged, value);
      }
      return merged;
    }
    const variant = Array.isArray(s.oneOf) ? s.oneOf[0] : Array.isArray(s.anyOf) ? s.anyOf[0] : null;
    if (variant) return synthesize(ctx, variant, seen, depth + 1);

    const type = Array.isArray(s.type) ? str(s.type[0]) : str(s.type);
    if (type === "array" || s.items !== undefined) {
      return [synthesize(ctx, s.items, seen, depth + 1)];
    }
    if (type === "object" || isObj(s.properties)) {
      const out: Json = {};
      for (const [key, value] of Object.entries(isObj(s.properties) ? s.properties : {})) {
        out[key] = synthesize(ctx, value, seen, depth + 1);
      }
      return out;
    }
    if (type === "integer" || type === "number") return 0;
    if (type === "boolean") return true;
    if (type === "null") return null;
    return stringExampleFor(str(s.format));
  } finally {
    seen.delete(s);
  }
}

function oasMediaExample(ctx: OasContext, media: Json): unknown {
  if (media.example !== undefined) return media.example;
  if (isObj(media.examples)) {
    const first = Object.values(media.examples)[0];
    const resolved = deref(ctx, first);
    if (isObj(resolved) && "value" in resolved) return resolved.value;
    if (resolved !== undefined) return resolved;
  }
  if (media.schema !== undefined) return synthesize(ctx, media.schema, new Set(), 0);
  return undefined;
}

function oasParamExample(ctx: OasContext, param: Json): string {
  if (param.example !== undefined) return scalarText(param.example);
  if (isObj(param.examples)) {
    const first = deref(ctx, Object.values(param.examples)[0]);
    if (isObj(first) && "value" in first) return scalarText(first.value);
  }
  // Swagger 2 puts `type`/`default` on the parameter itself; OpenAPI 3 nests them in `schema`.
  const schema = param.schema !== undefined ? param.schema : param;
  const value = synthesize(ctx, schema, new Set(), 0);
  return scalarText(value);
}

function oasServerUrl(ctx: OasContext): string {
  if (ctx.swagger) {
    const schemes = arr(ctx.doc.schemes).map((s) => str(s));
    const scheme = schemes.includes("https") ? "https" : (schemes[0] ?? "https");
    const host = str(ctx.doc.host);
    const basePath = str(ctx.doc.basePath).replace(/\/$/, "");
    if (!host) return basePath;
    return `${scheme}://${host}${basePath}`;
  }
  const server = objs(ctx.doc.servers)[0];
  if (!server) return "";
  let url = str(server.url);
  // Server templating (`https://{region}.api.com`) resolves through the declared defaults.
  if (isObj(server.variables)) {
    for (const [key, value] of Object.entries(server.variables)) {
      if (!isObj(value)) continue;
      url = url.replace(new RegExp(`\\{${key}\\}`, "g"), str(value.default));
    }
  }
  return url.replace(/\/$/, "");
}

/**
 * What the document declares, made absolute — the value `{{baseUrl}}` is imported with.
 *
 * Two shapes reach here without a host: nothing at all, and a root-relative `servers` entry. Both
 * are legal and both are unusable on their own; a request row reading `/v1/orders` cannot be sent.
 * Swagger UI resolves them against the URL it loaded the document from, so when we fetched the
 * document we resolve them the same way and the import arrives ready to send.
 *
 * A pasted or opened file has no such URL, so it keeps today's behaviour: relative in, relative out.
 */
function oasBaseUrl(ctx: OasContext): string {
  const declared = oasServerUrl(ctx);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(declared)) return declared;
  if (!ctx.sourceUrl) return declared;
  try {
    // `declared || "/"` — with nothing declared the origin *is* the base, because a path that was
    // written without a server is written from the root.
    return new URL(declared || "/", ctx.sourceUrl).toString().replace(/\/$/, "");
  } catch {
    return declared;
  }
}

/** `bearerAuth` + `Token` → `{{bearerAuthToken}}`, the reference and the variable it declares. */
function credentialVar(ctx: OasContext, schemeName: string, role: string): string {
  const words = schemeName.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  // `JWT` reads as `jwt`, not `jWT`; an acronym is one word, not a run of initials.
  const flatten = (word: string) => (word === word.toUpperCase() ? word.toLowerCase() : word);
  const head = words.length ? flatten(words[0]) : "auth";
  const rest = words
    .slice(1)
    .map(flatten)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  const name = `${head.charAt(0).toLowerCase()}${head.slice(1)}${rest.join("")}${role}`;
  ctx.credentials.add(name);
  return `{{${name}}}`;
}

/**
 * The auth block for one security requirement, with its credential pointed at a variable.
 *
 * `@ApiBearerAuth()` on a controller writes `security` onto every operation, and each one imports
 * as its own auth block — fifteen endpoints, fifteen empty token fields, fillable only one at a
 * time. Aiming them all at a single variable is what makes the import sendable after one paste.
 * The variable itself is declared empty and only in the environment, so nothing is invented here
 * and no credential is ever written into a collection that gets exported or shared.
 */
function oasSecurityAuth(ctx: OasContext, requirements: unknown): AuthConfig | null {
  const first = objs(requirements)[0];
  if (!first) return null;
  const schemeName = Object.keys(first)[0];
  if (!schemeName) return null;
  const store = ctx.swagger
    ? ctx.doc.securityDefinitions
    : isObj(ctx.doc.components)
      ? ctx.doc.components.securitySchemes
      : undefined;
  const scheme = deref(ctx, isObj(store) ? store[schemeName] : undefined);
  if (!isObj(scheme)) return null;

  const userPass = (type: "basic" | "digest") => {
    const auth = defaultAuth(type);
    auth[type] = {
      username: credentialVar(ctx, schemeName, "Username"),
      password: credentialVar(ctx, schemeName, "Password"),
    };
    return auth;
  };
  const bearer = () => {
    const auth = defaultAuth("bearer");
    auth.bearer = { token: credentialVar(ctx, schemeName, "Token") };
    return auth;
  };

  const type = str(scheme.type).toLowerCase();
  if (type === "basic") return userPass("basic");
  if (type === "http") {
    const httpScheme = str(scheme.scheme).toLowerCase();
    if (httpScheme === "basic") return userPass("basic");
    if (httpScheme === "digest") return userPass("digest");
    if (httpScheme === "bearer") return bearer();
    ctx.warnings.push(`HTTP auth scheme "${httpScheme}" isn't supported.`);
    return null;
  }
  if (type === "apikey") {
    const where = str(scheme.in).toLowerCase();
    if (where === "cookie") {
      ctx.warnings.push(`API key in a cookie isn't supported (${schemeName}); imported as a header.`);
    }
    const auth = defaultAuth("apikey");
    auth.apikey = {
      key: str(scheme.name),
      value: credentialVar(ctx, schemeName, "Key"),
      addTo: where === "query" ? "query" : "header",
    };
    return auth;
  }
  if (type === "oauth2") {
    const auth = defaultAuth("oauth2");
    const flows = isObj(scheme.flows) ? scheme.flows : null;
    if (flows) {
      const [flowName, flowRaw] = Object.entries(flows)[0] ?? [];
      const flow = isObj(flowRaw) ? flowRaw : {};
      auth.oauth2.grantType =
        flowName === "clientCredentials"
          ? "client_credentials"
          : flowName === "password"
            ? "password"
            : flowName === "implicit"
              ? "implicit"
              : "authorization_code";
      auth.oauth2.accessTokenUrl = str(flow.tokenUrl);
      auth.oauth2.authUrl = str(flow.authorizationUrl);
      auth.oauth2.scope = isObj(flow.scopes) ? Object.keys(flow.scopes).join(" ") : "";
    } else {
      const flowName = str(scheme.flow);
      auth.oauth2.grantType =
        flowName === "application"
          ? "client_credentials"
          : flowName === "password"
            ? "password"
            : flowName === "implicit"
              ? "implicit"
              : "authorization_code";
      auth.oauth2.accessTokenUrl = str(scheme.tokenUrl);
      auth.oauth2.authUrl = str(scheme.authorizationUrl);
      auth.oauth2.scope = isObj(scheme.scopes) ? Object.keys(scheme.scopes).join(" ") : "";
    }
    return auth;
  }
  ctx.warnings.push(`Security scheme "${schemeName}" (${type || "unknown"}) isn't supported.`);
  return null;
}

function oasBody(ctx: OasContext, operation: Json, bodyParams: Json[], spec: ApiRequestSpec): void {
  if (ctx.swagger) {
    const bodyParam = bodyParams.find((p) => str(p.in) === "body");
    if (bodyParam) {
      const example = bodyParam.schema !== undefined
        ? synthesize(ctx, bodyParam.schema, new Set(), 0)
        : undefined;
      spec.body.mode = "raw";
      spec.body.rawLanguage = "json";
      spec.body.raw = example === undefined ? "" : JSON.stringify(example, null, 2);
      if (!headerValue(spec.headers, "content-type")) {
        spec.headers.push(kv("Content-Type", str(arr(operation.consumes)[0]) || "application/json"));
      }
      return;
    }
    const formParams = bodyParams.filter((p) => str(p.in) === "formData");
    if (formParams.length) {
      const consumes = arr(operation.consumes).map((c) => str(c));
      const multipart = consumes.some((c) => c.includes("multipart"));
      const rows = formParams.map((p) =>
        kv(str(p.name), str(p.type) === "file" ? "" : oasParamExample(ctx, p), {
          description: str(p.description),
          type: str(p.type) === "file" ? "file" : "text",
        }),
      );
      spec.body.mode = multipart ? "formdata" : "urlencoded";
      if (multipart) spec.body.formdata = rows;
      else spec.body.urlencoded = rows;
    }
    return;
  }

  const requestBody = deref(ctx, operation.requestBody);
  if (!isObj(requestBody) || !isObj(requestBody.content)) return;
  const content = requestBody.content;
  const preferred =
    Object.keys(content).find((ct) => ct.includes("json")) ??
    Object.keys(content).find((ct) => ct.includes("x-www-form-urlencoded")) ??
    Object.keys(content).find((ct) => ct.includes("multipart")) ??
    Object.keys(content)[0];
  if (!preferred) return;
  const media = isObj(content[preferred]) ? (content[preferred] as Json) : {};
  const example = oasMediaExample(ctx, media);

  if (!headerValue(spec.headers, "content-type")) {
    spec.headers.push(kv("Content-Type", preferred));
  }
  if (preferred.includes("multipart") || preferred.includes("x-www-form-urlencoded")) {
    const schema = deref(ctx, media.schema);
    const properties = isObj(schema) && isObj(schema.properties) ? schema.properties : {};
    const rows = Object.entries(properties).map(([key, value]) => {
      const prop = deref(ctx, value);
      const isFile = isObj(prop) && str(prop.format) === "binary";
      return kv(key, isFile ? "" : scalarText(synthesize(ctx, prop, new Set(), 0)), {
        type: isFile ? "file" : "text",
        description: isObj(prop) ? str(prop.description) : "",
      });
    });
    spec.body.mode = preferred.includes("multipart") ? "formdata" : "urlencoded";
    if (preferred.includes("multipart")) spec.body.formdata = rows;
    else spec.body.urlencoded = rows;
    return;
  }
  if (preferred.includes("octet-stream") || preferred.startsWith("image/")) {
    spec.body.mode = "binary";
    return;
  }
  spec.body.mode = "raw";
  spec.body.rawLanguage = languageFor(preferred, "");
  spec.body.raw =
    example === undefined
      ? ""
      : typeof example === "string"
        ? example
        : JSON.stringify(example, null, 2);
}

/** Only the codes an API actually documents; anything else keeps an empty status text. */
const REASON_PHRASES: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "206": "Partial Content",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "415": "Unsupported Media Type",
  "422": "Unprocessable Entity",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
};

function renderExampleBody(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * The body of one documented response.
 *
 * One media type per status code — the JSON one when there is one, otherwise whichever came
 * first. Taking every media type of every code would bury a five-response CRUD endpoint under
 * fifteen rows for no extra information, since they describe the same payload twice over.
 */
function oasResponseBody(
  ctx: OasContext,
  response: Json,
  operation: Json,
): { body: string; contentType: string } {
  if (ctx.swagger) {
    // Swagger 2 keeps literal examples in `examples`, keyed by MIME, and the shape in `schema`.
    const examples = isObj(response.examples) ? response.examples : null;
    const literalKey = examples
      ? (Object.keys(examples).find((m) => m.includes("json")) ?? Object.keys(examples)[0])
      : undefined;
    if (examples && literalKey !== undefined) {
      return { body: renderExampleBody(examples[literalKey]), contentType: literalKey };
    }
    if (response.schema === undefined) return { body: "", contentType: "" };
    const produces = arr(operation.produces).map((p) => str(p));
    const contentType = produces.find((p) => p.includes("json")) ?? produces[0] ?? "application/json";
    return {
      body: renderExampleBody(synthesize(ctx, response.schema, new Set(), 0)),
      contentType,
    };
  }

  const content = isObj(response.content) ? response.content : null;
  if (!content) return { body: "", contentType: "" };
  const preferred = Object.keys(content).find((ct) => ct.includes("json")) ?? Object.keys(content)[0];
  if (preferred === undefined) return { body: "", contentType: "" };
  const media = isObj(content[preferred]) ? (content[preferred] as Json) : {};
  return { body: renderExampleBody(oasMediaExample(ctx, media)), contentType: preferred };
}

/**
 * Documented responses, as the saved examples that hang under a request in the tree.
 *
 * This is the half of the spec a request alone throws away: what the endpoint answers. The body
 * comes out of the same `oasMediaExample`/`synthesize` pair the request body uses, so a documented
 * example wins over a schema skeleton here exactly as it does there.
 *
 * `default` is skipped. It means "every code not listed", which has no status to file it under,
 * and a row labelled `default` sitting next to `200` reads as a second real response.
 */
function oasExamples(ctx: OasContext, operation: Json): SavedExample[] {
  const responses = deref(ctx, operation.responses);
  if (!isObj(responses)) return [];

  const out: SavedExample[] = [];
  for (const [code, raw] of Object.entries(responses)) {
    const status = Number.parseInt(code, 10);
    if (!Number.isFinite(status) || status < 100 || status > 599) continue;
    const response = deref(ctx, raw);
    if (!isObj(response)) continue;

    const { body, contentType } = oasResponseBody(ctx, response, operation);
    const headers: KeyValue[] = [];
    if (contentType) headers.push(kv("Content-Type", contentType));
    if (isObj(response.headers)) {
      for (const [name, headerRaw] of Object.entries(response.headers)) {
        const header = deref(ctx, headerRaw);
        if (!isObj(header)) continue;
        headers.push(
          kv(name, oasParamExample(ctx, header), { description: str(header.description) }),
        );
      }
    }

    const reason = REASON_PHRASES[code] ?? "";
    const description = str(response.description);
    out.push({
      id: crypto.randomUUID(),
      name: description ? `${code} · ${description}` : `${code} ${reason}`.trim(),
      status,
      statusText: reason,
      headers,
      body,
    });
  }
  return out;
}

function importOpenApi(doc: Json, warnings: string[], options: ImportOptions): ImportResult {
  const ctx: OasContext = {
    doc,
    swagger: typeof doc.swagger === "string",
    warnings,
    examples: options.includeExamples !== false,
    sourceUrl: options.sourceUrl ?? "",
    credentials: new Set(),
  };
  const info = isObj(doc.info) ? doc.info : {};
  const collection = emptyCollection(str(info.title) || "Imported API");
  collection.description = str(info.description);

  const serverUrl = oasBaseUrl(ctx);
  if (serverUrl) collection.variables.push(variable("baseUrl", serverUrl));

  const globalAuth = oasSecurityAuth(ctx, doc.security);
  collection.auth = globalAuth;

  if (objs(doc.servers).length > 1) {
    warnings.push("Only the first server was imported; the others are available in the spec.");
  }

  const folders = new Map<string, ImportedItem[]>();
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = deref(ctx, pathItemRaw);
    if (!isObj(pathItem)) continue;
    const sharedParams = objs(pathItem.parameters).map((p) => deref(ctx, p)).filter(isObj);

    for (const method of OAS_METHODS) {
      const operation = pathItem[method];
      if (!isObj(operation)) continue;

      const spec = defaultRequestSpec("http");
      spec.method = method.toUpperCase();
      spec.description = str(operation.description) || str(operation.summary);

      const params = new Map<string, Json>();
      for (const p of [...sharedParams, ...objs(operation.parameters).map((p) => deref(ctx, p)).filter(isObj)]) {
        params.set(`${str(p.in)}:${str(p.name)}`, p);
      }

      const cookies: string[] = [];
      const bodyParams: Json[] = [];
      let urlPath = path;
      for (const param of params.values()) {
        const name = str(param.name);
        if (!name) continue;
        const where = str(param.in);
        const example = oasParamExample(ctx, param);
        const description = str(param.description);
        switch (where) {
          case "path":
            // `{id}` is OpenAPI's syntax; ours is `:id`.
            urlPath = urlPath.replace(`{${name}}`, `:${name}`);
            spec.pathVars.push(kv(name, example, { description }));
            break;
          case "query":
            spec.params.push(kv(name, example, { description, enabled: param.required === true }));
            break;
          case "header":
            spec.headers.push(kv(name, example, { description }));
            break;
          case "cookie":
            cookies.push(`${name}=${example}`);
            break;
          default:
            bodyParams.push(param);
        }
      }
      if (cookies.length) spec.headers.push(kv("Cookie", cookies.join("; ")));

      spec.url = `${serverUrl ? "{{baseUrl}}" : ""}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
      oasBody(ctx, operation, bodyParams, spec);

      if (operation.security !== undefined) {
        spec.auth = oasSecurityAuth(ctx, operation.security) ?? defaultAuth("none");
      }

      if (ctx.examples) spec.examples = oasExamples(ctx, operation);

      const name = str(operation.summary) || str(operation.operationId) || `${spec.method} ${path}`;
      const tag = str(arr(operation.tags)[0]) || path.split("/").filter(Boolean)[0] || "default";
      const bucket = folders.get(tag) ?? [];
      bucket.push(requestItem(name, spec));
      folders.set(tag, bucket);
    }
  }

  const tagDescriptions = new Map<string, string>();
  for (const tag of objs(doc.tags)) tagDescriptions.set(str(tag.name), str(tag.description));

  for (const [name, items] of folders) {
    collection.items.push({
      kind: "folder",
      name,
      description: tagDescriptions.get(name) ?? "",
      auth: null,
      preScript: "",
      postScript: "",
      items,
    });
  }

  return {
    format: "openapi",
    collections: [collection],
    environments: oasEnvironments(serverUrl, ctx.credentials),
    warnings,
  };
}

/**
 * The environment the import is sendable from: where the host lives, and where the token goes.
 *
 * `baseUrl` is deliberately in both scopes. Collection scope is the default the requests were
 * imported with, environment scope is what wins over it (`VARIABLE_SCOPE_ORDER`), so moving a whole
 * import to another stage is picking a different environment rather than rewriting a variable you
 * then have to remember to put back — and deleting the environment leaves the import still working.
 *
 * Credentials are only here, never on the collection, for two reasons. An empty variable is still a
 * definition, so the same key in both scopes would mean the environment's blank shadows whatever
 * was typed on the collection — a 401 with a token clearly visible one panel over. And a secret
 * belongs in the scope that is per-stage and stays out of the collection you export or share.
 *
 * Named for the host, because that is precisely what differs when one description is imported for
 * two stages — two environments carrying the API's own name would tell you nothing.
 */
function oasEnvironments(
  baseUrl: string,
  credentials: Set<string>,
): { name: string; variables: ApiVariable[] }[] {
  if (!baseUrl) return [];
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return []; /* a base we could not make absolute is not a stage anyone can switch to */
  }
  if (!host) return [];
  return [
    {
      name: host,
      variables: [
        variable("baseUrl", baseUrl),
        ...[...credentials].map((key) => variable(key, "", { secret: true })),
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// HAR
// ---------------------------------------------------------------------------

function importHar(doc: Json, warnings: string[]): ImportResult {
  const log = isObj(doc.log) ? doc.log : {};
  const collection = emptyCollection("HAR import");
  const byHost = new Map<string, ImportedItem[]>();

  for (const entry of objs(log.entries)) {
    const request = isObj(entry.request) ? entry.request : null;
    if (!request) continue;
    const rawUrl = str(request.url);
    if (!rawUrl) continue;

    const spec = defaultRequestSpec("http");
    spec.method = (str(request.method) || "GET").toUpperCase();
    const split = splitQuery(rawUrl);
    spec.url = split.url;
    spec.params = Array.isArray(request.queryString)
      ? objs(request.queryString).map((p) => kv(str(p.name), str(p.value)))
      : split.params;
    spec.headers = objs(request.headers)
      // HTTP/2 pseudo-headers are transport detail, not something to replay.
      .filter((h) => !str(h.name).startsWith(":"))
      .map((h) => kv(str(h.name), str(h.value)));

    const postData = isObj(request.postData) ? request.postData : null;
    if (postData) {
      const mime = str(postData.mimeType);
      const params = objs(postData.params);
      if (params.length && mime.includes("multipart")) {
        spec.body.mode = "formdata";
        spec.body.formdata = params.map((p) =>
          str(p.fileName)
            ? kv(str(p.name), "", { type: "file", src: str(p.fileName) })
            : kv(str(p.name), decodeSafe(str(p.value))),
        );
      } else if (params.length) {
        spec.body.mode = "urlencoded";
        spec.body.urlencoded = params.map((p) => kv(str(p.name), decodeSafe(str(p.value))));
      } else if (str(postData.text)) {
        spec.body.mode = "raw";
        spec.body.raw = str(postData.text);
        spec.body.rawLanguage = languageFor(mime, spec.body.raw);
      }
    }

    const response = isObj(entry.response) ? entry.response : null;
    const content = response && isObj(response.content) ? response.content : null;
    if (response && content && str(content.text) && str(content.encoding) !== "base64") {
      spec.examples.push({
        id: crypto.randomUUID(),
        name: str(response.statusText) || `${num(response.status, 0)}`,
        status: num(response.status, 0),
        statusText: str(response.statusText),
        headers: objs(response.headers)
          .filter((h) => !str(h.name).startsWith(":"))
          .map((h) => kv(str(h.name), str(h.value))),
        body: str(content.text),
      });
    }

    const host = hostOf(rawUrl) || "requests";
    const bucket = byHost.get(host) ?? [];
    bucket.push(requestItem(nameFromUrl(spec.method, spec.url), spec));
    byHost.set(host, bucket);
  }

  if (!byHost.size) {
    warnings.push("The HAR file contains no requests.");
    return { format: "har", collections: [], environments: [], warnings };
  }
  for (const [host, items] of byHost) {
    collection.items.push({
      kind: "folder",
      name: host,
      description: "",
      auth: null,
      preScript: "",
      postScript: "",
      items,
    });
  }
  return { format: "har", collections: [collection], environments: [], warnings };
}

// ---------------------------------------------------------------------------
// Insomnia v4
// ---------------------------------------------------------------------------

function insomniaAuth(node: unknown, warnings: string[]): AuthConfig | null {
  if (!isObj(node)) return null;
  const type = str(node.type);
  if (!type || type === "none" || node.disabled === true) return null;
  switch (type) {
    case "basic": {
      const auth = defaultAuth("basic");
      auth.basic = { username: str(node.username), password: str(node.password) };
      return auth;
    }
    case "digest": {
      const auth = defaultAuth("digest");
      auth.digest = { username: str(node.username), password: str(node.password) };
      return auth;
    }
    case "bearer": {
      const auth = defaultAuth("bearer");
      auth.bearer = { token: str(node.token) };
      if (str(node.prefix) && str(node.prefix) !== "Bearer") {
        warnings.push(`Bearer prefix "${str(node.prefix)}" isn't configurable; "Bearer" is used.`);
      }
      return auth;
    }
    case "apikey": {
      const auth = defaultAuth("apikey");
      auth.apikey = {
        key: str(node.key),
        value: str(node.value),
        addTo: str(node.addTo) === "queryParams" ? "query" : "header",
      };
      return auth;
    }
    case "iam": {
      const auth = defaultAuth("awsv4");
      auth.awsv4 = {
        accessKey: str(node.accessKeyId),
        secretKey: str(node.secretAccessKey),
        sessionToken: str(node.sessionToken),
        region: str(node.region),
        service: str(node.service),
      };
      return auth;
    }
    case "oauth2": {
      const auth = defaultAuth("oauth2");
      const grant = str(node.grantType);
      auth.oauth2 = {
        ...auth.oauth2,
        grantType:
          grant === "client_credentials" || grant === "password" || grant === "implicit"
            ? grant
            : "authorization_code",
        authUrl: str(node.authorizationUrl),
        accessTokenUrl: str(node.accessTokenUrl),
        clientId: str(node.clientId),
        clientSecret: str(node.clientSecret),
        scope: str(node.scope),
        state: str(node.state),
        username: str(node.username),
        password: str(node.password),
        redirectUri: str(node.redirectUrl) || auth.oauth2.redirectUri,
        audience: str(node.audience),
        resource: str(node.resource),
        clientAuth: str(node.credentialsInBody) === "true" ? "body" : "header",
        accessToken: str(node.accessToken),
        refreshToken: str(node.refreshToken),
      };
      return auth;
    }
    default:
      warnings.push(`Insomnia auth type "${type}" isn't supported.`);
      return null;
  }
}

function insomniaBody(spec: ApiRequestSpec, node: unknown): void {
  if (!isObj(node)) return;
  const mime = str(node.mimeType);
  const params = objs(node.params);
  if (mime.includes("graphql")) {
    const parsed = parseJsonSafe(str(node.text));
    const payload = isObj(parsed) ? parsed : {};
    spec.protocol = "graphql";
    spec.body.mode = "graphql";
    spec.body.graphql = {
      query: str(payload.query),
      variables:
        typeof payload.variables === "string"
          ? payload.variables
          : JSON.stringify(payload.variables ?? {}, null, 2),
      operationName: str(payload.operationName),
    };
    return;
  }
  if (mime.includes("multipart")) {
    spec.body.mode = "formdata";
    spec.body.formdata = params.map((p) =>
      str(p.type) === "file" || str(p.fileName)
        ? kv(str(p.name), "", { type: "file", src: str(p.fileName), enabled: p.disabled !== true })
        : kv(str(p.name), str(p.value), { enabled: p.disabled !== true }),
    );
    return;
  }
  if (mime.includes("x-www-form-urlencoded")) {
    spec.body.mode = "urlencoded";
    spec.body.urlencoded = params.map((p) =>
      kv(str(p.name), str(p.value), { enabled: p.disabled !== true }),
    );
    return;
  }
  if (mime.includes("octet-stream")) {
    spec.body.mode = "binary";
    spec.body.binaryPath = str(node.fileName);
    return;
  }
  const text = str(node.text);
  if (!text && !mime) return;
  spec.body.mode = "raw";
  spec.body.raw = text;
  spec.body.rawLanguage = languageFor(mime, text);
}

function importInsomnia(doc: Json, warnings: string[]): ImportResult {
  const resources = objs(doc.resources);
  const sortKey = (r: Json) => num(r.metaSortKey, 0);
  const byParent = new Map<string, Json[]>();
  const workspaces: Json[] = [];
  const environments: { name: string; variables: ApiVariable[] }[] = [];

  for (const resource of resources) {
    const type = str(resource._type);
    if (type === "workspace") {
      workspaces.push(resource);
      continue;
    }
    if (type === "environment") {
      const data = isObj(resource.data) ? resource.data : {};
      const variables = Object.entries(data).map(([key, value]) =>
        variable(key, typeof value === "string" ? value : JSON.stringify(value)),
      );
      if (variables.length) {
        environments.push({ name: str(resource.name) || "Environment", variables });
      }
      continue;
    }
    if (type !== "request" && type !== "request_group") continue;
    const parent = str(resource.parentId);
    const bucket = byParent.get(parent) ?? [];
    bucket.push(resource);
    byParent.set(parent, bucket);
  }

  const build = (parentId: string, depth: number): ImportedItem[] => {
    if (depth > 32) return [];
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) => sortKey(a) - sortKey(b));
    return children.map((resource): ImportedItem => {
      if (str(resource._type) === "request_group") {
        return {
          kind: "folder",
          name: str(resource.name) || "Folder",
          description: str(resource.description),
          auth: insomniaAuth(resource.authentication, warnings),
          preScript: str(resource.preRequestScript),
          postScript: str(resource.afterResponseScript),
          items: build(str(resource._id), depth + 1),
        };
      }
      const spec = defaultRequestSpec("http");
      spec.method = (str(resource.method) || "GET").toUpperCase();
      const split = splitQuery(str(resource.url));
      spec.url = split.url;
      spec.params = [
        ...split.params,
        ...objs(resource.parameters).map((p) =>
          kv(str(p.name), str(p.value), {
            description: str(p.description),
            enabled: p.disabled !== true,
          }),
        ),
      ];
      spec.headers = objs(resource.headers).map((h) =>
        kv(str(h.name), str(h.value), {
          description: str(h.description),
          enabled: h.disabled !== true,
        }),
      );
      spec.pathVars = objs(resource.pathParameters).map((p) => kv(str(p.name), str(p.value)));
      spec.description = str(resource.description);
      spec.preScript = str(resource.preRequestScript);
      spec.postScript = str(resource.afterResponseScript);
      spec.auth = insomniaAuth(resource.authentication, warnings) ?? defaultAuth("inherit");
      insomniaBody(spec, resource.body);
      if (resource.settingFollowRedirects === "off") spec.settings.followRedirects = false;
      return requestItem(str(resource.name) || nameFromUrl(spec.method, spec.url), spec);
    });
  };

  const collections: ImportedCollection[] = [];
  for (const workspace of workspaces) {
    const collection = emptyCollection(str(workspace.name) || "Insomnia import");
    collection.description = str(workspace.description);
    collection.items = build(str(workspace._id), 0);
    if (collection.items.length) collections.push(collection);
  }

  // Exports trimmed to a single folder carry no workspace resource; the orphans still matter.
  const claimed = new Set<string>();
  const markClaimed = (items: Json[]) => {
    for (const item of items) claimed.add(str(item._id));
  };
  for (const workspace of workspaces) markClaimed(byParent.get(str(workspace._id)) ?? []);
  const orphans = resources.filter(
    (r) =>
      (str(r._type) === "request" || str(r._type) === "request_group") &&
      !claimed.has(str(r._id)) &&
      !byParent.has(str(r.parentId)),
  );
  if (!collections.length && orphans.length) {
    const collection = emptyCollection("Insomnia import");
    for (const orphan of orphans) collection.items.push(...build(str(orphan.parentId), 0));
    if (collection.items.length) collections.push(collection);
  }

  if (!collections.length && !environments.length) {
    warnings.push("The Insomnia export contains no requests.");
  }
  return { format: "insomnia", collections, environments, warnings };
}

// ---------------------------------------------------------------------------
// Native (round trip)
// ---------------------------------------------------------------------------

function importNative(doc: Json, warnings: string[]): ImportResult {
  const payload = doc as unknown as Partial<NativeExport>;
  const source = payload.collection;
  if (!isObj(source)) {
    warnings.push("The CodeFlow export has no collection.");
    return { format: "codeflow", collections: [], environments: [], warnings };
  }
  if (num(payload.version, 1) > 1) {
    warnings.push("This export was written by a newer version of CodeFlow; some fields were ignored.");
  }

  const folders = (payload.folders ?? []).filter(isObj);
  const requests = (payload.requests ?? []).filter(isObj);
  const collection: ImportedCollection = {
    name: str(source.name) || "Imported collection",
    description: str(source.description),
    auth: isObj(parseJsonSafe(str(source.auth))) ? (parseJsonSafe(str(source.auth)) as AuthConfig) : null,
    variables: nativeVariables(str(source.variables)),
    preScript: str(source.pre_script),
    postScript: str(source.post_script),
    items: [],
  };

  const build = (parentId: string | null, depth: number): ImportedItem[] => {
    if (depth > 32) return [];
    const nodes: { order: number; item: ImportedItem }[] = [];
    for (const folder of folders) {
      if ((folder.parent_id ?? null) !== parentId) continue;
      nodes.push({
        order: num(folder.sort_order, 0),
        item: {
          kind: "folder",
          name: str(folder.name) || "Folder",
          description: str(folder.description),
          auth: isObj(parseJsonSafe(str(folder.auth)))
            ? (parseJsonSafe(str(folder.auth)) as AuthConfig)
            : null,
          preScript: str(folder.pre_script),
          postScript: str(folder.post_script),
          items: build(str(folder.id), depth + 1),
        },
      });
    }
    for (const request of requests) {
      if ((request.folder_id ?? null) !== parentId) continue;
      const parsed = parseJsonSafe(str(request.spec));
      if (!isObj(parsed)) {
        warnings.push(`Request "${str(request.name)}" had an unreadable spec and was skipped.`);
        continue;
      }
      const protocol = str(request.protocol) as ApiProtocol;
      const spec: ApiRequestSpec = {
        ...defaultRequestSpec(protocol || "http"),
        ...(parsed as unknown as ApiRequestSpec),
      };
      nodes.push({
        order: num(request.sort_order, 0),
        item: requestItem(str(request.name) || "Request", spec),
      });
    }
    return nodes.sort((a, b) => a.order - b.order).map((n) => n.item);
  };

  collection.items = build(null, 0);
  return { format: "codeflow", collections: [collection], environments: [], warnings };
}

function nativeVariables(json: string): ApiVariable[] {
  const parsed = parseJsonSafe(json);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isObj)
    .map((v) =>
      variable(str(v.key), str(v.initialValue), {
        currentValue: str(v.currentValue),
        secret: v.secret === true,
        enabled: v.enabled !== false,
        description: str(v.description),
      }),
    );
}
