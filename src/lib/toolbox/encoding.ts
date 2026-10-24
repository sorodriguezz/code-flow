/**
 * The encoders and decoders of «Herramientas» — Base64, URL, HTML entities, Unicode escapes, hex,
 * binary, quoted-printable, Punycode and gzip/deflate.
 *
 * All of it runs in the webview and nothing leaves the machine, which is the whole point of the
 * toolbox against the websites people paste tokens into (user, 2026-10-23: «métele un montón de
 * herramientas altiro para que en verdad valga la pena»). Text is always UTF-8 on the wire: every
 * function that turns text into bytes goes through `TextEncoder`, so «ñ» is two bytes everywhere.
 *
 * Decoders throw an `Error` with a short English message on input they cannot read; the UI shows
 * it inline under the output.
 */

const encoder = new TextEncoder();
/** `fatal` so invalid UTF-8 is reported rather than silently turned into U+FFFD. */
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new Error("The bytes are not valid UTF-8 text");
  }
}

// ---------------------------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` over a whole file overflows the call stack.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Reads standard or URL-safe Base64, with or without padding, ignoring whitespace. */
export function base64ToBytes(input: string): Uint8Array {
  let clean = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (/[^A-Za-z0-9+/=]/.test(clean)) throw new Error("Not Base64: unexpected characters");
  clean = clean.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new Error("Not Base64: wrong length");
  clean += "=".repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeBase64(text: string, urlSafe = false): string {
  const b64 = bytesToBase64(utf8(text));
  return urlSafe ? toBase64Url(b64) : b64;
}

export function decodeBase64(input: string): string {
  return fromUtf8(base64ToBytes(input));
}

/** The MIME type a data URI declares, or `null` when `text` is not one. */
export function parseDataUri(text: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(text.trim());
  return match ? { mime: match[1] || "application/octet-stream", base64: match[2] } : null;
}

// ---------------------------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------------------------

/**
 * `component` escapes everything that is not unreserved (what goes *inside* a query value);
 * `full` leaves the URL's own structure (`:/?#&=`) alone, like `encodeURI`.
 */
export function encodeUrl(text: string, mode: "component" | "full"): string {
  return mode === "component" ? encodeURIComponent(text) : encodeURI(text);
}

export function decodeUrl(text: string, plusAsSpace = true): string {
  const prepared = plusAsSpace ? text.replace(/\+/g, " ") : text;
  try {
    return decodeURIComponent(prepared);
  } catch {
    throw new Error("Malformed percent-encoding");
  }
}

// ---------------------------------------------------------------------------------------------
// HTML entities
// ---------------------------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«",
  raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", deg: "°", plusmn: "±",
  times: "×", divide: "÷", micro: "µ", middot: "·", bull: "•", iexcl: "¡", iquest: "¿", aacute: "á",
  eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í",
  Oacute: "Ó", Uacute: "Ú", ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", agrave: "à", egrave: "è",
  ccedil: "ç", Ccedil: "Ç", ordf: "ª", ordm: "º", larr: "←", rarr: "→", uarr: "↑", darr: "↓",
  harr: "↔", le: "≤", ge: "≥", ne: "≠", infin: "∞", sum: "∑", radic: "√", alpha: "α", beta: "β",
  gamma: "γ", delta: "δ", pi: "π", sigma: "σ", omega: "ω", lambda: "λ", mu: "μ", shy: "­",
  zwj: "‍", zwnj: "‌", thinsp: " ", ensp: " ", emsp: " ",
};

export function encodeHtmlEntities(text: string, nonAscii = false): string {
  let out = text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  if (nonAscii) {
    out = Array.from(out)
      .map((ch) => {
        const cp = ch.codePointAt(0)!;
        return cp > 0x7e ? `&#x${cp.toString(16).toUpperCase()};` : ch;
      })
      .join("");
  }
  return out;
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

// ---------------------------------------------------------------------------------------------
// Unicode escapes
// ---------------------------------------------------------------------------------------------

/**
 * `\uXXXX` with surrogate pairs (what JSON and Java read) or `\u{X}` (ES2015, one escape per code
 * point). `all` escapes ASCII too.
 */
export function escapeUnicode(text: string, style: "u4" | "braces" = "u4", all = false): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!all && cp >= 0x20 && cp < 0x7f) {
      out += ch;
      continue;
    }
    if (style === "braces") out += `\\u{${cp.toString(16).toUpperCase()}}`;
    else {
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return out;
}

export function unescapeUnicode(text: string): string {
  return text.replace(
    /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\x([0-9a-fA-F]{2})/g,
    (_, braces, u4, u8, x) => {
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      const cp = parseInt(braces ?? u8 ?? x, 16);
      if (cp > 0x10ffff) throw new Error(`Code point out of range: ${cp.toString(16)}`);
      return String.fromCodePoint(cp);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Hex and binary
// ---------------------------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array, separator = ""): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(separator);
}

/** Reads hex with any of `0x`, spaces, colons or dashes between the bytes. */
export function hexToBytes(input: string): Uint8Array {
  const clean = input.replace(/0x/gi, "").replace(/[\s:,-]/g, "");
  if (/[^0-9a-fA-F]/.test(clean)) throw new Error("Not hex: unexpected characters");
  if (clean.length % 2) throw new Error("Not hex: odd number of digits");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function textToHex(text: string, separator = " "): string {
  return bytesToHex(utf8(text), separator);
}

export function hexToText(hex: string): string {
  return fromUtf8(hexToBytes(hex));
}

export function textToBinary(text: string, separator = " "): string {
  return Array.from(utf8(text), (b) => b.toString(2).padStart(8, "0")).join(separator);
}

export function binaryToText(input: string): string {
  const groups = /\s/.test(input.trim()) ? input.trim().split(/\s+/) : (input.trim().match(/.{1,8}/g) ?? []);
  const bytes = groups.map((g) => {
    if (!/^[01]{1,8}$/.test(g)) throw new Error(`Not binary: "${g}"`);
    return parseInt(g, 2);
  });
  return fromUtf8(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------------------------
// Quoted-printable (RFC 2045)
// ---------------------------------------------------------------------------------------------

export function encodeQuotedPrintable(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => {
      const bytes = utf8(line);
      let encoded = "";
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        const last = i === bytes.length - 1;
        const printable = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
        encoded += printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      }
      // Soft breaks keep every physical line at 76 characters, never splitting an `=XX`.
      const out: string[] = [];
      while (encoded.length > 76) {
        let cut = 75;
        const eq = encoded.lastIndexOf("=", cut);
        if (eq > cut - 3) cut = eq;
        out.push(`${encoded.slice(0, cut)}=`);
        encoded = encoded.slice(cut);
      }
      out.push(encoded);
      return out.join("\r\n");
    })
    .join("\r\n");
}

export function decodeQuotedPrintable(input: string): string {
  const joined = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (c === "=" && /^[0-9a-fA-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of utf8(c)) bytes.push(b);
    }
  }
  return fromUtf8(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------------------------
// Punycode (RFC 3492) and IDNA domains
// ---------------------------------------------------------------------------------------------

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

const digit = (d: number) => String.fromCharCode(d < 26 ? d + 97 : d + 22);

export function punycodeEncode(input: string): string {
  const cps = Array.from(input, (c) => c.codePointAt(0)!);
  let output = cps.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join("");
  const basic = output.length;
  let handled = basic;
  if (basic) output += "-";
  let n = INITIAL_N, delta = 0, bias = INITIAL_BIAS;
  while (handled < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
          if (q < t) break;
          output += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += digit(q);
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output;
}

export function punycodeDecode(input: string): string {
  const out: number[] = [];
  const dash = input.lastIndexOf("-");
  for (let i = 0; i < Math.max(dash, 0); i++) out.push(input.charCodeAt(i));
  let n = INITIAL_N, bias = INITIAL_BIAS, i = 0;
  for (let pos = dash > 0 ? dash + 1 : 0; pos < input.length; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (pos >= input.length) throw new Error("Invalid Punycode");
      const c = input.charCodeAt(pos++);
      const d = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : BASE;
      if (d >= BASE) throw new Error("Invalid Punycode");
      i += d * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** `ñandú.cl` → `xn--and-6ma2c.cl`, label by label. */
export function domainToAscii(domain: string): string {
  return domain
    .split(".")
    .map((label) => (/[^\x00-\x7f]/.test(label) ? `xn--${punycodeEncode(label.toLowerCase())}` : label))
    .join(".");
}

export function domainToUnicode(domain: string): string {
  return domain
    .split(".")
    .map((label) => (/^xn--/i.test(label) ? punycodeDecode(label.slice(4).toLowerCase()) : label))
    .join(".");
}

// ---------------------------------------------------------------------------------------------
// gzip / deflate
// ---------------------------------------------------------------------------------------------

export type CompressionKind = "gzip" | "deflate" | "deflate-raw";

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const response = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

export async function compressToBase64(text: string, kind: CompressionKind): Promise<string> {
  return bytesToBase64(await pipe(utf8(text), new CompressionStream(kind)));
}

export async function decompressFromBase64(base64: string, kind: CompressionKind): Promise<string> {
  const bytes = base64ToBytes(base64);
  try {
    return fromUtf8(await pipe(bytes, new DecompressionStream(kind)));
  } catch (err) {
    if (err instanceof Error && err.message.includes("UTF-8")) throw err;
    throw new Error(`Not ${kind} data`);
  }
}
