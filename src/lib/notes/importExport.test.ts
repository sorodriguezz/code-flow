import { describe, expect, it } from "vitest";
import { noteFromMarkdownFile } from "./importMarkdown";
import {
  exportFileStem,
  markdownToPdfContent,
  notesToHtml,
  renderNotesPdf,
  wikiLinksForExport,
  type ExportedNote,
} from "./exportNotes";

/**
 * Getting notes out (HTML, PDF) and Markdown files in.
 *
 * The HTML renderer is injected in these tests — DOMPurify needs a DOM and there is none here — so
 * what is asserted is the document around the bodies: the policy that forbids scripts, the escaped
 * titles, the contents list and the anchors the links reach. The PDF is rendered for real, through
 * pdfmake, and read back as bytes.
 */

const escapeRender = (markdown: string) =>
  `<p>${markdown.replace(/</g, "&lt;").replace(/\[([^\]]+)\]\((#[^)]+)\)/g, '<a href="$2">$1</a>')}</p>`;

const notes: ExportedNote[] = [
  { id: "a", title: "Arquitectura", content: "Ver [[Decisiones|las decisiones]] y [[Fuera]]." },
  { id: "b", title: "Decisiones <b>", content: "Nada `[[Arquitectura]]` aquí.\n```\n[[Arquitectura]]\n```" },
];

describe("wikiLinksForExport", () => {
  const anchors = new Map([["arquitectura", "note-1"], ["decisiones", "note-2"]]);

  it("links notes that are in the export and flattens the rest to their label", () => {
    expect(wikiLinksForExport("[[decisiones|ver]] y [[Otra]]", anchors)).toBe("[ver](#note-2) y Otra");
  });

  it("leaves code alone", () => {
    const source = "`[[Arquitectura]]`\n```\n[[Arquitectura]]\n```\n[[Arquitectura]]";
    expect(wikiLinksForExport(source, anchors)).toBe(
      "`[[Arquitectura]]`\n```\n[[Arquitectura]]\n```\n[Arquitectura](#note-1)",
    );
  });
});

describe("notesToHtml", () => {
  const html = notesToHtml(notes, { title: "Libro", lang: "es", untitled: "Sin título", render: escapeRender });

  it("is a standalone document that cannot run a script", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<link |@import/i);
  });

  it("escapes titles and gives each note an anchor the contents list and links reach", () => {
    expect(html).toContain("<h1 class=\"note-title\">Decisiones &lt;b&gt;</h1>");
    expect(html).toContain('<article id="note-2">');
    expect(html).toContain('<li><a href="#note-2">Decisiones &lt;b&gt;</a></li>');
    // The title carries "<b>", so `[[Decisiones]]` names no note in this export: it is flattened to
    // its label rather than left as a dead anchor.
    expect(html).toContain("Ver las decisiones y Fuera.");
  });

  it("draws no contents list for a single note", () => {
    const single = notesToHtml([notes[0]], { title: "A", lang: "en", untitled: "Untitled", render: escapeRender });
    expect(single).not.toContain("<nav");
  });
});

describe("the PDF", () => {
  it("turns Markdown into real pdfmake content", () => {
    const content = markdownToPdfContent("# Título\n\nUn **negro** y `código`.\n\n- [x] hecho\n\n```\nx < y\n```");
    const flat = JSON.stringify(content);
    expect(flat).toContain('"fontSize":20');
    expect(flat).toContain('"bold":true');
    expect(flat).toContain('"font":"Courier"');
    expect(flat).toContain("☑ ");
    expect(flat).toContain("x < y");
  });

  it("renders to bytes that are a PDF", async () => {
    const bytes = await renderNotesPdf(notes, { title: "Libro", untitled: "Sin título" });
    expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
    // Two notes, each from the top of its own page.
    expect(new TextDecoder("latin1").decode(bytes)).toMatch(/\/Count 2\b/);
  });
});

describe("noteFromMarkdownFile", () => {
  it("names the note after the file and keeps the body exactly", () => {
    expect(noteFromMarkdownFile("/home/ana/Retro 12.md", "# Hola\r\n\r\ntexto")).toEqual({
      title: "Retro 12",
      content: "# Hola\n\ntexto",
      tags: [],
    });
  });

  it("prefers front matter for the title and the tags", () => {
    const text = "\uFEFF---\ntitle: \"Plan Q3\"\ntags:\n  - Roadmap\n  - '#equipo'\n---\ncuerpo";
    expect(noteFromMarkdownFile("C:\\notas\\x.markdown", text)).toEqual({
      title: "Plan Q3",
      content: "---\ntitle: \"Plan Q3\"\ntags:\n  - Roadmap\n  - '#equipo'\n---\ncuerpo",
      tags: ["roadmap", "equipo"],
    });
    expect(noteFromMarkdownFile("y.md", "---\ntags: [a, b]\n---\n").tags).toEqual(["a", "b"]);
  });
});

describe("exportFileStem", () => {
  it("replaces what a file system refuses and falls back when nothing is left", () => {
    expect(exportFileStem("a/b:c", "x")).toBe("a-b-c");
    expect(exportFileStem("   ", "Sin título")).toBe("Sin título");
  });
});
