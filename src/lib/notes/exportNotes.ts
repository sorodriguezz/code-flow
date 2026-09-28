import { Marked, type Token, type Tokens } from "marked";
import type {
  Content,
  ContentText,
  TDocumentDefinitions,
  TFontContainer,
  TVirtualFileSystem,
} from "pdfmake/interfaces";

/**
 * A note, or a whole notebook, as a file someone else can open: self-contained HTML, or a PDF.
 *
 * Both read the same `ExportedNote[]`, and both resolve `[[wiki links]]` the same way — to the note
 * inside the export when it is there, to plain text when it is not — so the two files say the same
 * thing even though they are laid out twice.
 *
 * **The HTML is sanitized and self-contained**: each body goes through the app's own
 * `renderMarkdown` (`marked` + DOMPurify), the styles are inline, and a Content-Security-Policy in
 * the head forbids scripts and any fetch except images — so a note that quoted something hostile
 * cannot turn the exported file into a page that runs it, even in a browser that ignores the
 * sanitizer's work. It is passed in (`render`) rather than imported here, because DOMPurify needs a
 * DOM and the tests have none.
 *
 * **The PDF is laid out by pdfmake**, from `marked`'s tokens — real text, selectable and searchable,
 * the same choice `lib/api/docsPdf.ts` made. pdfmake is ~2 MB and loaded by `import()` only when a
 * PDF is asked for.
 */

export interface ExportedNote {
  id: string;
  title: string;
  content: string;
}

/** A title made safe for a file name — the characters a file system refuses, and nothing else. */
export function exportFileStem(title: string, fallback: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim();
  return (cleaned || fallback).slice(0, 80);
}

/** The anchor a note gets inside an export: its position, which is stable and never collides. */
function anchorFor(index: number): string {
  return `note-${index + 1}`;
}

/** Case- and accent-folded, whitespace collapsed — the comparison `resolveNoteLink` makes. */
function fold(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Folded title → anchor, for the notes in this export. The first of two same-titled notes wins. */
function anchorsOf(notes: ExportedNote[]): Map<string, string> {
  const anchors = new Map<string, string>();
  notes.forEach((note, index) => {
    const key = fold(note.title);
    if (key && !anchors.has(key)) anchors.set(key, anchorFor(index));
  });
  return anchors;
}

/**
 * `[[Title]]` and `[[Title|label]]` rewritten for a file outside the app: a Markdown link to the
 * note's anchor when that note is in the export, and the bare label when it is not — a `[[…]]` left
 * as it was would read as a formatting accident to anyone without CodeFlow.
 *
 * Code is left alone: a fenced block or an inline span that *shows* the syntax is quoting it.
 */
export function wikiLinksForExport(markdown: string, anchors: Map<string, string>): string {
  const rewrite = (text: string) =>
    text.replace(/\[\[([^\]\n[]{1,200})\]\]/g, (_, inner: string) => {
      const [target, label] = inner.split("|");
      const shown = (label ?? target).trim();
      const anchor = anchors.get(fold(target));
      return anchor ? `[${shown}](#${anchor})` : shown;
    });
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      // Odd segments of a split on backtick spans are the code.
      return line
        .split(/(`[^`]*`)/)
        .map((segment, index) => (index % 2 === 1 ? segment : rewrite(segment)))
        .join("");
    })
    .join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Light, print-friendly, and deliberately the app's preview in spirit rather than in tokens: the
 *  file is read outside the app, where none of `--cf-*` exists. */
const HTML_STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #ffffff; color: #1b1f24; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
nav.contents { border-bottom: 1px solid #e3e6ea; margin-bottom: 32px; padding-bottom: 16px; }
nav.contents h1 { font-size: 26px; margin: 0 0 12px; }
nav.contents ol { margin: 0; padding-left: 20px; }
article + article { border-top: 1px solid #e3e6ea; margin-top: 40px; padding-top: 32px; }
h1.note-title { font-size: 26px; margin: 0 0 16px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
a { color: #4f46e5; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f5f7; border-radius: 4px; padding: 0.1em 0.3em; }
pre { background: #f4f5f7; border-radius: 6px; padding: 12px 14px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #e3e6ea; color: #6a737d; margin-left: 0; padding-left: 14px; }
table { border-collapse: collapse; }
th, td { border: 1px solid #e3e6ea; padding: 6px 10px; text-align: left; }
th { background: #f7f8fa; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #e3e6ea; }
@media print { main { padding: 0; } a { color: inherit; } }
`;

/**
 * One HTML document holding `notes` in order. A single note is just that note; several get a
 * contents list at the top whose entries jump to each one.
 */
export function notesToHtml(
  notes: ExportedNote[],
  options: { title: string; lang: string; untitled: string; render: (markdown: string) => string },
): string {
  const anchors = anchorsOf(notes);
  const articles = notes
    .map((note, index) => {
      const body = options.render(wikiLinksForExport(note.content, anchors));
      const title = escapeHtml(note.title.trim() || options.untitled);
      return `<article id="${anchorFor(index)}">\n<h1 class="note-title">${title}</h1>\n${body}\n</article>`;
    })
    .join("\n");
  const contents =
    notes.length > 1
      ? `<nav class="contents">\n<h1>${escapeHtml(options.title)}</h1>\n<ol>\n${notes
          .map(
            (note, index) =>
              `<li><a href="#${anchorFor(index)}">${escapeHtml(note.title.trim() || options.untitled)}</a></li>`,
          )
          .join("\n")}\n</ol>\n</nav>\n`
      : "";
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(options.lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // No scripts and no fetches but images, whatever the bodies turn out to contain.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data:; style-src 'unsafe-inline'">`,
    '<meta name="generator" content="CodeFlow">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${HTML_STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `${contents}${articles}`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** A4 at 50pt margins. */
const PAGE_MARGIN = 50;

const PDF_COLORS = { text: "#1b1f24", muted: "#6a737d", line: "#e3e6ea", code: "#f4f5f7", link: "#4f46e5" };

type Run = ContentText & { text: string };

/** Inline tokens as pdfmake text runs, styles inherited downwards. */
function inline(tokens: Token[] | undefined, style: Partial<Run>, anchors: Map<string, string>): Run[] {
  if (!tokens) return [];
  return tokens.flatMap((token): Run[] => {
    switch (token.type) {
      case "strong":
        return inline((token as Tokens.Strong).tokens, { ...style, bold: true }, anchors);
      case "em":
        return inline((token as Tokens.Em).tokens, { ...style, italics: true }, anchors);
      case "del":
        return inline((token as Tokens.Del).tokens, { ...style, decoration: "lineThrough" }, anchors);
      case "codespan":
        return [{ ...style, text: (token as Tokens.Codespan).text, font: "Courier", background: PDF_COLORS.code }];
      case "link": {
        const link = token as Tokens.Link;
        const internal = link.href.startsWith("#") ? link.href.slice(1) : null;
        const target =
          internal && [...anchors.values()].includes(internal)
            ? { linkToDestination: internal }
            : /^(https?:|mailto:)/i.test(link.href)
              ? { link: link.href }
              : {};
        return inline(link.tokens, { ...style, ...target, color: PDF_COLORS.link }, anchors);
      }
      case "image": {
        const image = token as Tokens.Image;
        // Pictures are referenced by URL and a PDF cannot fetch; the reference is kept as text.
        return [{ ...style, text: `[${image.text || image.href}]`, color: PDF_COLORS.muted }];
      }
      case "br":
        return [{ ...style, text: "\n" }];
      case "html":
        // Inline markup is dropped; the text between the tags arrives as its own tokens.
        return [];
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? inline(text.tokens, style, anchors) : [{ ...style, text: text.text }];
      }
      case "escape":
        return [{ ...style, text: (token as Tokens.Escape).text }];
      default:
        return "text" in token && typeof token.text === "string" ? [{ ...style, text: token.text }] : [];
    }
  });
}

const HEADING_SIZES = [20, 16, 14, 12.5, 11.5, 11];

/** Block tokens as pdfmake content. */
function blocks(tokens: Token[], anchors: Map<string, string>): Content[] {
  const out: Content[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        out.push({
          text: inline(heading.tokens, {}, anchors),
          fontSize: HEADING_SIZES[Math.min(heading.depth, 6) - 1],
          bold: true,
          margin: [0, 10, 0, 4],
        });
        break;
      }
      case "paragraph":
        out.push({ text: inline((token as Tokens.Paragraph).tokens, {}, anchors), margin: [0, 0, 0, 8] });
        break;
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item): Content => {
          const inner = blocks(item.tokens.filter((entry) => entry.type !== "checkbox"), anchors);
          const box = item.task ? (item.checked ? "☑ " : "☐ ") : "";
          if (box && inner.length > 0 && typeof inner[0] === "object" && "text" in inner[0]) {
            const first = inner[0] as ContentText;
            inner[0] = { ...first, text: [{ text: box }, ...(Array.isArray(first.text) ? first.text : [first.text])] } as Content;
          }
          return { stack: inner, margin: [0, 0, 0, 2] };
        });
        out.push(
          list.ordered
            ? { ol: items, start: typeof list.start === "number" ? list.start : 1, margin: [0, 0, 0, 8] }
            : { ul: items, margin: [0, 0, 0, 8] },
        );
        break;
      }
      case "code":
        out.push({
          table: { widths: ["*"], body: [[{ text: (token as Tokens.Code).text, font: "Courier", fontSize: 8.5 }]] },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: () => 0,
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
            fillColor: () => PDF_COLORS.code,
          },
          margin: [0, 0, 0, 8],
        });
        break;
      case "blockquote":
        out.push({
          stack: blocks((token as Tokens.Blockquote).tokens, anchors),
          color: PDF_COLORS.muted,
          margin: [12, 0, 0, 8],
        });
        break;
      case "table": {
        const table = token as Tokens.Table;
        out.push({
          table: {
            headerRows: 1,
            widths: table.header.map(() => "*"),
            body: [
              table.header.map((cell) => ({ text: inline(cell.tokens, {}, anchors), bold: true })),
              ...table.rows.map((row) => row.map((cell) => ({ text: inline(cell.tokens, {}, anchors) }))),
            ],
          },
          layout: "lightHorizontalLines",
          fontSize: 9.5,
          margin: [0, 0, 0, 8],
        });
        break;
      }
      case "hr":
        out.push({
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 495, y2: 0, lineWidth: 0.5, lineColor: PDF_COLORS.line }],
          margin: [0, 6, 0, 10],
        });
        break;
      case "html": {
        const text = (token as Tokens.HTML).text.replace(/<[^>]*>/g, "").trim();
        if (text) out.push({ text, margin: [0, 0, 0, 8] });
        break;
      }
      case "text":
        out.push({ text: inline((token as Tokens.Text).tokens ?? [token], {}, anchors), margin: [0, 0, 0, 4] });
        break;
      default:
        break;
    }
  }
  return out;
}

/** `markdown` as pdfmake content. Exported for the tests, which read what a note turns into. */
export function markdownToPdfContent(markdown: string, anchors: Map<string, string> = new Map()): Content[] {
  const lexer = new Marked({ gfm: true, breaks: false });
  return blocks(lexer.lexer(wikiLinksForExport(markdown, anchors)), anchors);
}

/** The whole document: each note from the top of a page, its title as an anchor the links reach. */
export function notesPdfDefinition(
  notes: ExportedNote[],
  options: { title: string; untitled: string },
): TDocumentDefinitions {
  const anchors = anchorsOf(notes);
  const content: Content[] = notes.flatMap((note, index): Content[] => [
    {
      text: note.title.trim() || options.untitled,
      id: anchorFor(index),
      fontSize: 22,
      bold: true,
      margin: [0, 0, 0, 12],
      ...(index > 0 ? { pageBreak: "before" as const } : {}),
    },
    ...markdownToPdfContent(note.content, anchors),
  ]);
  return {
    info: { title: options.title, creator: "CodeFlow" },
    pageSize: "A4",
    pageMargins: [PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN],
    content,
    defaultStyle: { fontSize: 10.5, lineHeight: 1.25, color: PDF_COLORS.text },
    footer: (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: "center",
      fontSize: 8,
      color: PDF_COLORS.muted,
      margin: [0, 20, 0, 0],
    }),
  };
}

/** pdfmake with its Roboto files and the Courier metrics — see `lib/api/docsPdf.ts`'s loader. */
async function loadPdfMake() {
  const [core, vfs, courier] = await Promise.all([
    import("pdfmake/build/pdfmake"),
    import("pdfmake/build/vfs_fonts"),
    import("pdfmake/build/standard-fonts/Courier"),
  ]);
  type Core = typeof core;
  const unwrap = <T,>(mod: unknown): T => (mod as { default?: T }).default ?? (mod as T);
  const pdfMake = unwrap<Core>(core);
  pdfMake.addVirtualFileSystem(unwrap<TVirtualFileSystem>(vfs));
  pdfMake.addFontContainer(unwrap<TFontContainer>(courier));
  return pdfMake;
}

/** The finished PDF's bytes. */
export async function renderNotesPdf(
  notes: ExportedNote[],
  options: { title: string; untitled: string },
): Promise<Uint8Array> {
  const pdfMake = await loadPdfMake();
  const base64 = await pdfMake.createPdf(notesPdfDefinition(notes, options)).getBase64();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
