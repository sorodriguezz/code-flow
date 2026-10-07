import { describe, expect, it } from "vitest";
import { outlineOf } from "./outline";
import { bookPath, buildBookTree, descendantIds, flattenTree } from "./tree";
import { normalizeTag, parseTags, serializeTags, tagCounts, tagHue } from "./tags";
import { findNoteLinks } from "./noteLinks";
import { fillTemplate, titleFromTemplate } from "./templates";
import type { Note, NoteBookRow, NoteTemplate } from "../../types/notes";

/**
 * The pure half of the Notes workspace, which had no tests: the outline the rail scrolls by, the
 * tree the explorer draws, tag storage, the `[[link]]` scanner the editor decorates with, and
 * template filling. Each rule pinned here is one whose failure is silent — a rail one row off, a
 * book that reports 0 notes while holding forty, a tag stored twice.
 */

const book = (id: string, parent: string | null, name: string, sort = 0): NoteBookRow => ({
  id,
  workspace_id: "w1",
  parent_id: parent,
  name,
  color: "",
  sort_order: sort,
  created_at: "",
  updated_at: "",
  scope: "workspace",
});

const note = (id: string, bookId: string | null, title = id): Note => ({
  id,
  workspace_id: "w1",
  book_id: bookId,
  title,
  excerpt: "",
  tags: [],
  pinned: false,
  word_count: 0,
  sort_order: 0,
  created_at: "",
  updated_at: "",
  scope: "workspace",
  origin_project_id: "",
  origin_path: "",
});

describe("outlineOf", () => {
  it("lists ATX and setext headings, and nothing inside a fence", () => {
    const source = [
      "# Uno",
      "texto",
      "```sh",
      "# comentario de shell",
      "```",
      "Dos",
      "===",
      "## **Tres** ##",
      "Cuatro",
      "---",
      "- lista",
      "-",
    ].join("\n");
    expect(outlineOf(source)).toEqual([
      { level: 1, text: "Uno", line: 0 },
      { level: 1, text: "Dos", line: 5 },
      { level: 2, text: "Tres", line: 7 },
      { level: 2, text: "Cuatro", line: 8 },
    ]);
  });

  it("keeps an empty heading, so every later index stays aligned with the preview", () => {
    expect(outlineOf("##\n# Después").map((heading) => heading.line)).toEqual([0, 1]);
  });

  it("does not close a ``` fence with ~~~", () => {
    expect(outlineOf("```\n~~~\n# no\n```\n# sí")).toEqual([{ level: 1, text: "sí", line: 4 }]);
  });
});

describe("the book tree", () => {
  const books = [book("a", null, "A", 1), book("b", null, "B", 0), book("c", "a", "C"), book("x", "gone", "Huérfano")];

  it("orders by sort_order, then name, and surfaces an orphan at the root", () => {
    // b and the orphan share sort_order 0 and are then ordered by name; a comes after both.
    expect(buildBookTree(books).map((entry) => entry.id)).toEqual(["b", "x", "a"]);
    expect(buildBookTree(books).find((entry) => entry.id === "a")?.children.map((c) => c.id)).toEqual(["c"]);
  });

  it("counts a closed book's whole subtree, and draws only what is open", () => {
    const notes = [note("n1", "a"), note("n2", "c"), note("n3", "c")];
    const closed = flattenTree(buildBookTree(books), notes, new Set());
    const a = closed.find((row) => row.id === "a");
    expect(a?.kind === "book" && a.noteCount).toBe(3);
    expect(closed.some((row) => row.kind === "note")).toBe(false);

    const open = flattenTree(buildBookTree(books), notes, new Set(["a", "c"]));
    expect(open.filter((row) => row.kind === "note").map((row) => [row.id, row.depth])).toEqual([
      ["n2", 2],
      ["n3", 2],
      ["n1", 1],
    ]);
  });

  it("walks paths and descendants without hanging on a cycle", () => {
    expect(bookPath(books, "c").map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(bookPath(books, null)).toEqual([]);
    expect([...descendantIds(books, "a")].sort()).toEqual(["a", "c"]);
    const cyclic = [book("p", "q", "P"), book("q", "p", "Q")];
    expect(bookPath(cyclic, "p").length).toBeLessThanOrEqual(3);
    expect([...descendantIds(cyclic, "p")].sort()).toEqual(["p", "q"]);
  });
});

describe("tags", () => {
  it("normalise to one spelling", () => {
    expect(normalizeTag("  ##Code Review ")).toBe("code-review");
    expect(serializeTags(["A", "a", " b "])).toBe('["a","b"]');
  });

  it("parse whatever a row holds without throwing", () => {
    expect(parseTags('["X","x",3]')).toEqual(["x"]);
    expect(parseTags("{not json")).toEqual([]);
    expect(parseTags("")).toEqual([]);
  });

  it("count most-used first, then by name, and colour by name alone", () => {
    expect(tagCounts([{ tags: ["b", "a"] }, { tags: ["b"] }])).toEqual([
      { tag: "b", count: 2 },
      { tag: "a", count: 1 },
    ]);
    expect(tagHue("devops")).toBe(tagHue("devops"));
    expect(tagHue("devops")).toBeGreaterThanOrEqual(0);
    expect(tagHue("devops")).toBeLessThan(360);
  });
});

describe("findNoteLinks", () => {
  it("finds each link with 1-based columns, and never one that does not close", () => {
    expect(findNoteLinks("ver [[A]] y [[B|b]]\n[[roto")).toEqual([
      { line: 1, startColumn: 5, endColumn: 10 },
      { line: 1, startColumn: 13, endColumn: 20 },
    ]);
  });
});

describe("templates", () => {
  const at = new Date(2026, 8, 28, 10, 30);

  it("fills the known placeholders and leaves unknown ones as written", () => {
    const filled = fillTemplate("{{title}} {{ DATE }} {{jira}}", "Retro", at);
    expect(filled.startsWith("Retro ")).toBe(true);
    expect(filled).toContain(at.toLocaleDateString());
    expect(filled.endsWith("{{jira}}")).toBe(true);
  });

  it("takes the title from the first heading, filled", () => {
    const template = { name: "Reunión", content: "texto\n# Reunión — {{title}}\n" } as NoteTemplate;
    expect(titleFromTemplate(template, at)).toBe("Reunión — Reunión");
    expect(titleFromTemplate({ name: "Solo", content: "sin títulos" } as NoteTemplate, at)).toBe("Solo");
  });
});
