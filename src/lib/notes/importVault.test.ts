import { describe, expect, it } from "vitest";
import { fromVault, looksLikeNotion, notionLinks } from "./importVault";

const ID = "0123456789abcdef0123456789abcdef";

describe("vault import", () => {
  it("reads a Notion export: ids off names and folders, page links as [[links]], the title heading dropped", () => {
    const files = [
      {
        dir: `Proyectos ${ID}/Lanzamiento ${ID}`,
        name: `Plan de lanzamiento ${ID}.md`,
        content: `# Plan de lanzamiento\n\nVer [Riesgos](Riesgos%20${ID}.md) y [la web](https://example.com/a.md).\n`,
      },
    ];
    expect(looksLikeNotion(files)).toBe(true);
    const [note] = fromVault(files, "notion");
    expect(note.title).toBe("Plan de lanzamiento");
    expect(note.folders).toEqual(["Proyectos", "Lanzamiento"]);
    expect(note.content).toBe("Ver [[Riesgos]] y [la web](https://example.com/a.md).\n");
  });

  it("keeps an Obsidian vault as written, with its folders and front matter", () => {
    const [note] = fromVault([{ dir: "Diario/2026", name: "Ideas.md", content: "---\ntags: [idea, web]\n---\nUna [[Nota]]\n" }], "obsidian");
    expect(note.title).toBe("Ideas");
    expect(note.tags).toEqual(["idea", "web"]);
    expect(note.folders).toEqual(["Diario", "2026"]);
    expect(note.content).toContain("Una [[Nota]]");
  });

  it("leaves a link that is not a page alone", () => {
    expect(notionLinks("[x](imagen.png) [y](otra/Pagina.md)")).toBe("[x](imagen.png) [[Pagina]]");
  });
});
