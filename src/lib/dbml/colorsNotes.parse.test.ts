import { describe, expect, it } from "vitest";
import { parseDbml } from "./parse";
import { addStickyNote, dropStickyNote, setTableColor, stickyNoteBlock, updateStickyNote } from "./edit";
import { blankMarkers, readLayout, stickyBoxes, writeLayout } from "./layout";
import { stickyNoteId } from "./types";

/**
 * Table colours and sticky notes are DBML's own syntax (`[headercolor: …]`, `Note name { … }`), so
 * every operation is checked by running its output through the real parser — a string that looks
 * right and does not parse is the failure that matters.
 */

const SCHEMA = `// usuarios del sistema
Table users {
  id integer [pk]
  email varchar
}

Table posts as P [note: 'a, b [x]'] {
  id integer [pk]
  user_id integer [ref: > users.id]
}
`;

describe("table colours", () => {
  it("adds, replaces and clears headercolor, keeping every other setting", () => {
    const red = setTableColor(SCHEMA, "users", "#ef4444");
    expect(red).toContain("Table users [headercolor: #ef4444] {");
    expect(parseDbml(red).tables.find((t) => t.name === "users")?.color).toBe("#ef4444");

    const posts = setTableColor(red, "posts", "#3b82f6");
    expect(posts).toContain("Table posts as P [note: 'a, b [x]', headercolor: #3b82f6] {");
    const parsed = parseDbml(posts);
    expect(parsed.error).toBeNull();
    expect(parsed.tables.find((t) => t.name === "posts")?.color).toBe("#3b82f6");
    expect(parsed.tables.find((t) => t.name === "posts")?.note).toBe("a, b [x]");

    const swapped = setTableColor(posts, "posts", "#22c55e");
    expect(swapped).toContain("[note: 'a, b [x]', headercolor: #22c55e]");

    // Clearing both gives the document back byte for byte.
    expect(setTableColor(setTableColor(posts, "posts", null), "users", null)).toBe(SCHEMA);
  });

  it("is read by the forgiving reader too, so a broken document keeps its colours", () => {
    const broken = `${setTableColor(SCHEMA, "users", "#ef4444")}\nTable half {\n  id\n`;
    const parsed = parseDbml(broken);
    expect(parsed.error).not.toBeNull();
    expect(parsed.tables.find((t) => t.name === "users")?.color).toBe("#ef4444");
  });
});

describe("sticky notes", () => {
  it("adds one-line and multi-line notes the parser reads back exactly", () => {
    const one = addStickyNote(SCHEMA, "Revisar el índice de 'email'", "#fde68a");
    expect(one.name).toBe("nota");
    const parsed = parseDbml(one.source);
    expect(parsed.error).toBeNull();
    expect(parsed.notes).toEqual([
      { id: stickyNoteId("nota"), name: "nota", content: "Revisar el índice de 'email'", color: "#fde68a" },
    ]);

    const two = addStickyNote(one.source, "Primera línea\n  sangrada\núltima");
    expect(two.name).toBe("nota_2");
    const both = parseDbml(two.source);
    expect(both.error).toBeNull();
    expect(both.notes?.[1]).toEqual({ id: stickyNoteId("nota_2"), name: "nota_2", content: "Primera línea\n  sangrada\núltima" });
  });

  it("an empty note is still legal DBML", () => {
    const { source } = addStickyNote(SCHEMA, "");
    const parsed = parseDbml(source);
    expect(parsed.error).toBeNull();
    expect(parsed.notes?.[0]?.content).toBe("");
  });

  it("rewrites text and colour in place, and drops a note cleanly", () => {
    const { source } = addStickyNote(SCHEMA, "uno", "#fde68a");
    const recoloured = updateStickyNote(source, "nota", { color: "#a855f7" });
    expect(parseDbml(recoloured).notes?.[0]?.color).toBe("#a855f7");
    const retexted = updateStickyNote(recoloured, "nota", { content: "dos\ntres" });
    const parsed = parseDbml(retexted);
    expect(parsed.error).toBeNull();
    expect(parsed.notes?.[0]).toMatchObject({ content: "dos\ntres", color: "#a855f7" });
    const cleared = updateStickyNote(retexted, "nota", { color: null });
    expect(parseDbml(cleared).notes?.[0]?.color).toBeUndefined();
    expect(dropStickyNote(cleared, "nota").trimEnd()).toBe(SCHEMA.trimEnd());
  });

  it("survives a document that does not parse", () => {
    const { source } = addStickyNote(SCHEMA, "sigue aquí", "#fde68a");
    const parsed = parseDbml(`${source}\nTable half {\n  id\n`);
    expect(parsed.error).not.toBeNull();
    expect(parsed.notes?.[0]).toMatchObject({ name: "nota", content: "sigue aquí", color: "#fde68a" });
  });

  it("escapes what would end its string", () => {
    const block = stickyNoteBlock("n", "una 'cita' y \\ barra");
    expect(parseDbml(`${SCHEMA}\n${block}\n`).notes?.[0]?.content).toBe("una 'cita' y \\ barra");
  });
});

describe("everything in the code", () => {
  it("a copy of the whole text carries positions, sizes and marks", () => {
    const { source } = addStickyNote(SCHEMA, "post-it", "#fde68a");
    const doc = writeLayout(
      source,
      { users: { x: 10, y: 20 }, [stickyNoteId("nota")]: { x: 300, y: 40, w: 260, h: 140 } },
      { users: "review" },
    );
    // Pasting `doc` into another diagram is reading it again.
    const again = readLayout(doc);
    expect(again.source).toBe(source);
    expect(again.positions).toEqual({ users: { x: 10, y: 20 }, [stickyNoteId("nota")]: { x: 300, y: 40, w: 260, h: 140 } });
    expect(again.marks).toEqual({ users: "review" });
    expect(parseDbml(doc).error).toBeNull();
  });

  it("blanks the markers for the parser without moving any line", () => {
    const doc = `${writeLayout(SCHEMA, { users: { x: 1, y: 2 } })}Table later {\n  id int\n}\n`;
    const blanked = blankMarkers(doc);
    expect(blanked.split("\n").length).toBe(doc.split("\n").length);
    expect(blanked).not.toContain("codeflow:layout");
    expect(parseDbml(doc).tables.map((t) => t.name)).toContain("later");
  });

  it("places a note nobody placed to the right of the tables, one under another", () => {
    const boxes = stickyBoxes(
      [
        { id: "note:a", name: "a", content: "" },
        { id: "note:b", name: "b", content: "" },
        { id: "note:c", name: "c", content: "" },
      ],
      { "note:b": { x: 5, y: 6, w: 100, h: 80 } },
      { width: 500 },
    );
    expect(boxes[0]).toMatchObject({ x: 548, y: 0 });
    expect(boxes[1]).toMatchObject({ x: 5, y: 6, w: 100, h: 80 });
    expect(boxes[2].x).toBe(548);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
  });
});
