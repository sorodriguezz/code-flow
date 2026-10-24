/**
 * Text tools: case conversion, counting, line operations, escaping, slugs, lorem ipsum and an
 * inspector that names the characters you cannot see.
 */

// ---------------------------------------------------------------------------------------------
// Case
// ---------------------------------------------------------------------------------------------

export type CaseStyle =
  | "camel"
  | "pascal"
  | "snake"
  | "constant"
  | "kebab"
  | "train"
  | "dot"
  | "title"
  | "sentence"
  | "lower"
  | "upper";

export const CASE_STYLES: CaseStyle[] = ["camel", "pascal", "snake", "constant", "kebab", "train", "dot", "title", "sentence", "lower", "upper"];

/**
 * The words of an identifier or a phrase: splits on anything that is not a letter or digit, on
 * lower→upper (`fooBar`) and on the end of an acronym (`HTTPServer` → `HTTP`, `Server`).
 */
export function splitWords(text: string): string[] {
  return text
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

export function convertCase(text: string, style: CaseStyle): string {
  if (style === "lower") return text.toLowerCase();
  if (style === "upper") return text.toUpperCase();
  // Line by line, so a pasted column of identifiers converts as a column.
  return text
    .split("\n")
    .map((line) => {
      const words = splitWords(line);
      if (!words.length) return line;
      const lower = words.map((w) => w.toLowerCase());
      switch (style) {
        case "camel":
          return lower[0] + lower.slice(1).map(cap).join("");
        case "pascal":
          return lower.map(cap).join("");
        case "snake":
          return lower.join("_");
        case "constant":
          return lower.join("_").toUpperCase();
        case "kebab":
          return lower.join("-");
        case "train":
          return lower.map(cap).join("-");
        case "dot":
          return lower.join(".");
        case "title":
          return lower.map(cap).join(" ");
        case "sentence":
          return cap(lower.join(" "));
      }
      return line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------------------------

export interface TextStats {
  characters: number;
  /** User-perceived characters (an emoji with a skin tone is one). */
  graphemes: number;
  codePoints: number;
  words: number;
  lines: number;
  paragraphs: number;
  bytesUtf8: number;
  bytesUtf16: number;
  /** Minutes at 230 words per minute. */
  readingMinutes: number;
}

export function textStats(text: string): TextStats {
  // `Intl.Segmenter` is in every engine the app runs on, but not in the TS lib this project targets.
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (t: string) => Iterable<unknown> } }).Segmenter;
  const graphemes = Segmenter ? Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length : Array.from(text).length;
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length;
  return {
    characters: text.length,
    graphemes,
    codePoints: Array.from(text).length,
    words,
    lines: text ? text.split(/\r\n|\r|\n/).length : 0,
    paragraphs: text.split(/\n\s*\n/).filter((p) => p.trim()).length,
    bytesUtf8: new TextEncoder().encode(text).length,
    bytesUtf16: text.length * 2,
    readingMinutes: words / 230,
  };
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

export interface LineOptions {
  sort: "none" | "asc" | "desc" | "natural" | "length" | "reverse" | "shuffle";
  dedupe: boolean;
  caseInsensitive: boolean;
  trim: boolean;
  removeEmpty: boolean;
}

export function processLines(text: string, o: LineOptions, random: () => number = Math.random): string {
  let lines = text.split(/\r?\n/);
  if (o.trim) lines = lines.map((l) => l.trim());
  if (o.removeEmpty) lines = lines.filter((l) => l.trim() !== "");
  if (o.dedupe) {
    const seen = new Set<string>();
    lines = lines.filter((l) => {
      const key = o.caseInsensitive ? l.toLowerCase() : l;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const collator = new Intl.Collator(undefined, { sensitivity: o.caseInsensitive ? "base" : "variant" });
  const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: o.caseInsensitive ? "base" : "variant" });
  switch (o.sort) {
    case "asc":
      lines.sort(collator.compare);
      break;
    case "desc":
      lines.sort((a, b) => collator.compare(b, a));
      break;
    case "natural":
      lines.sort(natural.compare);
      break;
    case "length":
      lines.sort((a, b) => a.length - b.length || collator.compare(a, b));
      break;
    case "reverse":
      lines.reverse();
      break;
    case "shuffle":
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }
      break;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------------------------

export type EscapeKind = "json" | "regex" | "sql" | "shell" | "csharp" | "xml";

export const ESCAPE_KINDS: EscapeKind[] = ["json", "regex", "sql", "shell", "csharp", "xml"];

export function escapeText(text: string, kind: EscapeKind): string {
  switch (kind) {
    case "json":
      return JSON.stringify(text).slice(1, -1);
    case "regex":
      return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    case "sql":
      return `'${text.replace(/'/g, "''")}'`;
    case "shell":
      // POSIX single quotes: nothing inside is special except the quote itself.
      return `'${text.replace(/'/g, `'\\''`)}'`;
    case "csharp":
      return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
    case "xml":
      return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
  }
}

export function unescapeText(text: string, kind: EscapeKind): string {
  switch (kind) {
    case "json": {
      const body = text.startsWith('"') && text.endsWith('"') && text.length > 1 ? text.slice(1, -1) : text;
      try {
        return JSON.parse(`"${body}"`);
      } catch {
        throw new Error("Not a valid JSON string body");
      }
    }
    case "regex":
      return text.replace(/\\(.)/g, "$1");
    case "sql":
      return text.replace(/^'|'$/g, "").replace(/''/g, "'");
    case "shell":
      return text.replace(/'\\''/g, "'").replace(/^'|'$/g, "");
    case "csharp":
      return text
        .replace(/^"|"$/g, "")
        .replace(/\\(["\\nrt0])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", "0": "\0" })[c] ?? c);
    case "xml":
      return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[n]!);
  }
}

// ---------------------------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------------------------

export function slugify(text: string, separator = "-", lower = true): string {
  const base = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, separator)
    .replace(new RegExp(`^${escapeText(separator, "regex")}+|${escapeText(separator, "regex")}+$`, "g"), "");
  return lower ? base.toLowerCase() : base;
}

// ---------------------------------------------------------------------------------------------
// Lorem ipsum
// ---------------------------------------------------------------------------------------------

const LOREM =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum".split(
    " ",
  );

export function lorem(
  count: number,
  unit: "words" | "sentences" | "paragraphs",
  startWithLorem = true,
  random: () => number = Math.random,
): string {
  const word = () => LOREM[Math.floor(random() * LOREM.length)];
  const sentence = (first: boolean) => {
    const n = 6 + Math.floor(random() * 10);
    const words = first && startWithLorem ? ["lorem", "ipsum", "dolor", "sit", "amet"] : [];
    while (words.length < n) words.push(word());
    // A comma in longer sentences, the way the real text reads.
    if (n > 9) words[Math.floor(n / 2)] += ",";
    const s = words.join(" ");
    return `${s[0].toUpperCase()}${s.slice(1)}.`;
  };
  if (unit === "words") {
    const words = startWithLorem ? ["lorem", "ipsum", "dolor", "sit", "amet"].slice(0, count) : [];
    while (words.length < count) words.push(word());
    return words.join(" ");
  }
  if (unit === "sentences") return Array.from({ length: count }, (_, i) => sentence(i === 0)).join(" ");
  return Array.from({ length: count }, (_, p) =>
    Array.from({ length: 4 + Math.floor(random() * 4) }, (_, i) => sentence(p === 0 && i === 0)).join(" "),
  ).join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------------------------

const INVISIBLE: Record<number, string> = {
  0x00: "NUL",
  0x09: "TAB",
  0x0a: "LF",
  0x0b: "VT",
  0x0c: "FF",
  0x0d: "CR",
  0x1b: "ESC",
  0x20: "SPACE",
  0x7f: "DEL",
  0xa0: "NO-BREAK SPACE",
  0xad: "SOFT HYPHEN",
  0x034f: "COMBINING GRAPHEME JOINER",
  0x061c: "ARABIC LETTER MARK",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x2000: "EN QUAD",
  0x2001: "EM QUAD",
  0x2002: "EN SPACE",
  0x2003: "EM SPACE",
  0x2004: "THREE-PER-EM SPACE",
  0x2005: "FOUR-PER-EM SPACE",
  0x2006: "SIX-PER-EM SPACE",
  0x2007: "FIGURE SPACE",
  0x2008: "PUNCTUATION SPACE",
  0x2009: "THIN SPACE",
  0x200a: "HAIR SPACE",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x202f: "NARROW NO-BREAK SPACE",
  0x205f: "MEDIUM MATHEMATICAL SPACE",
  0x2060: "WORD JOINER",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0x3000: "IDEOGRAPHIC SPACE",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE (BOM)",
  0xfffd: "REPLACEMENT CHARACTER",
};

export interface CharInfo {
  char: string;
  codePoint: number;
  /** `U+00E9`. */
  label: string;
  /** The name for the invisible and confusable ones; empty for ordinary characters. */
  name: string;
  utf8: string;
  /** Not printable, or printable but easy to mistake for a space. */
  suspicious: boolean;
}

export function inspectChars(text: string, limit = 5000): CharInfo[] {
  const out: CharInfo[] = [];
  for (const char of text) {
    if (out.length >= limit) break;
    const cp = char.codePointAt(0)!;
    const control = cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
    const name = INVISIBLE[cp] ?? (control ? "CONTROL" : "");
    out.push({
      char,
      codePoint: cp,
      label: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
      name,
      utf8: Array.from(new TextEncoder().encode(char), (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
      suspicious: (name !== "" && cp !== 0x20 && cp !== 0x0a) || (cp >= 0xe000 && cp <= 0xf8ff),
    });
  }
  return out;
}

/** The text with every invisible character spelled out as `⟨NAME⟩`, for copying a clean report. */
export function revealInvisibles(text: string): string {
  return Array.from(text, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a) return "⏎\n";
    if (cp === 0x20) return "·";
    if (cp === 0x09) return "→";
    const name = INVISIBLE[cp] ?? (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? `U+${cp.toString(16).toUpperCase().padStart(4, "0")}` : "");
    return name ? `⟨${name}⟩` : ch;
  }).join("");
}
