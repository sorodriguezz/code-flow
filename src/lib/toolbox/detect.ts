/**
 * What a pasted text probably is, and which tool opens it: the toolbox's «Pegar y detectar» and the
 * search box's «Abrir en …» when what was typed is data rather than a tool's name.
 *
 * Patterns only, tried strongest first — a JWT is also Base64-ish, a JSON number is also a
 * timestamp — and every one cheap, since it runs on each keystroke of the search. A guess that is
 * merely possible (Base64 that does not decode to text) is left out rather than offered.
 */

export interface Detection {
  /** The tool to open. */
  tool: string;
  /** Translation key of what the text was recognised as. */
  kind: DetectionKind;
  /** Fields set on the tool alongside its input — a two-way tool's direction. */
  extra?: Record<string, unknown>;
}

export type DetectionKind =
  | "jwt"
  | "json"
  | "curl"
  | "url"
  | "urlEncoded"
  | "timestamp"
  | "isoDate"
  | "cron"
  | "uuid"
  | "objectId"
  | "snowflake"
  | "pem"
  | "bcrypt"
  | "otpauth"
  | "base64"
  | "gzip"
  | "xml"
  | "html"
  | "sql"
  | "cidr"
  | "userAgent"
  | "env"
  | "color"
  | "rut"
  | "yaml";

const DECODE = { direction: "decode" } as const;

/** Whether a Base64 string decodes to readable UTF-8 — the difference between data and a word. */
function base64Text(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return false;
  // A word, a hash in hex or a number is valid Base64 too, and is none of those things.
  if (/^[a-z]+$/i.test(compact) || /^[0-9a-f]+$/i.test(compact)) return false;
  try {
    const binary = atob(compact.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(compact.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const printable = decoded.replace(/[\p{L}\p{N}\p{P}\p{S}\s]/gu, "").length;
    return decoded.length > 0 && printable / decoded.length < 0.05;
  } catch {
    return false;
  }
}

function isJson(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A cron line: five or six fields of digits, `*`, `/`, `,`, `-`, `?`, `L`, `W`, `#` or names. */
const CRON_FIELD = /^(\*|\?|[0-9A-Za-z]+([-,/#][0-9A-Za-z*]+)*|\*\/\d+|L|\d+W)$/;
function isCron(text: string): boolean {
  if (/^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(text)) return true;
  const fields = text.split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return false;
  // A sentence of five words is not a schedule: at least one field has to look like one.
  if (!fields.some((f) => /[*/?]|^\d/.test(f))) return false;
  return fields.every((f) => CRON_FIELD.test(f) && (/[\d*?]/.test(f) || /^[A-Z]{3}(-[A-Z]{3})?$/i.test(f)));
}

/** Every tool the text could be opened in, best first. Empty for plain prose. */
export function detectTools(raw: string): Detection[] {
  const text = raw.trim();
  if (!text || text.length > 2_000_000) return [];
  const out: Detection[] = [];
  const add = (tool: string, kind: DetectionKind, extra?: Record<string, unknown>) => {
    if (!out.some((d) => d.tool === tool)) out.push({ tool, kind, extra });
  };
  const oneLine = !/\n/.test(text);

  if (/^eyJ[\w-]*\.[\w-]*\.[\w-]*$/.test(text)) add("jwt", "jwt");
  if (/^-----BEGIN [A-Z0-9 ]+-----/.test(text)) add("cert", "pem");
  if (/^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(text)) add("bcrypt", "bcrypt");
  if (/^otpauth:\/\//i.test(text)) add("totp", "otpauth");
  if (/^curl\s/i.test(text)) add("curl", "curl");
  if (isJson(text)) {
    add("json", "json");
    add("json-code", "json");
  }
  if (oneLine && /^https?:\/\/\S+$/i.test(text)) {
    add("url-parse", "url");
    if (/%[0-9a-f]{2}/i.test(text)) add("url", "urlEncoded", DECODE);
  } else if (oneLine && /%[0-9a-f]{2}/i.test(text)) add("url", "urlEncoded", DECODE);
  if (/^\d{10}(\d{3})?$/.test(text)) add("timestamp", "timestamp");
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) add("timestamp", "isoDate");
  if (oneLine && isCron(text)) add("cron", "cron");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) add("uuid", "uuid");
  if (/^[0-9a-f]{24}$/i.test(text)) add("id-decode", "objectId");
  if (/^\d{15,20}$/.test(text)) add("id-decode", "snowflake");
  if (/^H4sI[A-Za-z0-9+/=\s]+$/.test(text)) add("gzip", "gzip", DECODE);
  if (/^<\?xml/i.test(text)) add("xml", "xml");
  else if (/^<(!doctype html|html|head|body|div|span|p|a|ul|table|section|main)\b/i.test(text)) add("web-format", "html");
  else if (/^<[A-Za-z][\w:.-]*[\s>]/.test(text) && /<\/[A-Za-z][\w:.-]*>\s*$/.test(text)) add("xml", "xml");
  if (/^(select|insert|update|delete|with|create|alter|drop|merge)\s/i.test(text)) add("sql", "sql");
  if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(text) || /^[0-9a-f:]+:[0-9a-f:]*\/\d{1,3}$/i.test(text)) add("cidr", "cidr");
  if (/^Mozilla\/\d|^(curl|Wget|okhttp|python-requests|PostmanRuntime)\//.test(text)) add("user-agent", "userAgent");
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) || /^(rgb|hsl|oklch)a?\(/i.test(text)) add("color", "color");
  if (/^\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]$/.test(text)) add("rut", "rut");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  // One line is only an assignment with a conventional upper-case name: Base64 padding is `=` too.
  const envLine = (l: string) => /^(export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=(?!=)/.test(l.trim());
  if (lines.length >= 2 ? lines.every(envLine) : lines.length === 1 && /^(export\s+)?[A-Z_][A-Z0-9_]*=(?!=)/.test(lines[0].trim())) add("env", "env");
  if (!out.length && lines.length >= 2 && lines.every((l) => /^\s*(-\s|[\w"'-]+:(\s|$))/.test(l))) add("convert", "yaml", { from: "yaml", to: "json" });
  if (base64Text(text) && !out.some((d) => d.kind === "jwt")) add("base64", "base64", DECODE);
  return out;
}
