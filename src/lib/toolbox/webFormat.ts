/**
 * HTML, CSS and JavaScript, beautified or minified. Beautifying is js-beautify's; minifying
 * JavaScript is Terser's — both loaded with this module, which loads with the tool. CSS and HTML
 * minification are written here: what they need is whitespace and comments gone without touching
 * strings, `<pre>`, `<textarea>`, scripts or styles, which a short scanner does exactly.
 */
import { css as beautifyCss, html as beautifyHtml, js as beautifyJs } from "js-beautify";

export type WebLanguage = "html" | "css" | "js";

export function beautify(code: string, language: WebLanguage, indent: number): string {
  const options = { indent_size: indent, indent_char: " ", end_with_newline: false, preserve_newlines: true, max_preserve_newlines: 2 };
  if (language === "css") return beautifyCss(code, options);
  if (language === "html") return beautifyHtml(code, { ...options, wrap_line_length: 0, indent_inner_html: true });
  return beautifyJs(code, options);
}

export async function minify(code: string, language: WebLanguage): Promise<string> {
  if (language === "css") return minifyCss(code);
  if (language === "html") return minifyHtml(code);
  const { minify: terser } = await import("terser");
  const result = await terser(code, { compress: true, mangle: true, format: { comments: false } });
  return result.code ?? "";
}

/** Comments and needless whitespace out of a stylesheet, strings left exactly as written. */
export function minifyCss(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const end = stringEnd(code, i, c);
      out += code.slice(i, end + 1);
      i = end;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 1;
    } else if (/\s/.test(c)) {
      // One space survives only between two things that would otherwise run together.
      while (i + 1 < code.length && /\s/.test(code[i + 1])) i++;
      const before = out[out.length - 1] ?? "";
      const after = code[i + 1] ?? "";
      if (before && after && !/[{}:;,>~+(\s]/.test(before) && !/[{}:;,>~+)!]/.test(after)) out += " ";
    } else {
      out += c;
    }
  }
  return out.replace(/;}/g, "}");
}

/** Index of the quote that closes the string opened at `start`. */
function stringEnd(code: string, start: number, quote: string): number {
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === quote) return i;
  }
  return code.length - 1;
}

/** Tags whose content is kept byte for byte. */
const RAW = /^<(pre|textarea|script|style)\b/i;

/** Comments out and whitespace between tags collapsed, leaving raw blocks and attribute values alone. */
export function minifyHtml(code: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < code.length) {
    if (code.startsWith("<!--", i) && !code.startsWith("<!--[if", i)) {
      const end = code.indexOf("-->", i + 4);
      i = end < 0 ? code.length : end + 3;
      continue;
    }
    const raw = RAW.exec(code.slice(i, i + 12));
    if (raw) {
      const close = code.toLowerCase().indexOf(`</${raw[1].toLowerCase()}`, i);
      const end = close < 0 ? code.length : code.indexOf(">", close) + 1 || code.length;
      let block = code.slice(i, end);
      if (raw[1].toLowerCase() === "style") block = block.replace(/(>)([\s\S]*)(<\/style)/i, (_, a: string, body: string, b: string) => a + minifyCss(body) + b);
      parts.push(block);
      i = end;
      continue;
    }
    const next = code.indexOf("<", i + 1);
    const end = next < 0 ? code.length : next;
    const chunk = code.slice(i, end);
    if (chunk.startsWith("<")) {
      const tagEnd = chunk.indexOf(">");
      const tag = tagEnd < 0 ? chunk : chunk.slice(0, tagEnd + 1);
      parts.push(tag.replace(/\s+/g, " ").replace(/\s+(\/?>)$/, "$1"));
      parts.push(collapse(tagEnd < 0 ? "" : chunk.slice(tagEnd + 1)));
    } else {
      parts.push(collapse(chunk));
    }
    i = end;
  }
  return parts.join("").trim();
}

/** Runs of whitespace in text become one space, and whitespace that is only between tags goes. */
function collapse(text: string): string {
  return /^\s*$/.test(text) ? "" : text.replace(/\s+/g, " ");
}
