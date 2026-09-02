import { describe, expect, it } from "vitest";
import {
  addEnum,
  addField,
  addRef,
  addTable,
  dropField,
  dropRef,
  dropTable,
  freeName,
  renameTable,
  setRefCardinality,
  setTableNote,
  updateField,
} from "./edit";
import { readLayout, writeLayout } from "./layout";

/**
 * The property every operation in `edit.ts` exists to have.
 *
 * These are not "does add a column add a column" tests — that part is obvious and would pass on the
 * naive implementation this file was written to avoid. What is being held down is the *other* half:
 * that a click which edits one line leaves every other byte of the author's document alone. The
 * naive version (re-print the parsed schema) passes every behavioural assertion and fails every one
 * of the preservation assertions, silently, by deleting the comments and reflowing the notes.
 *
 * So the fixture below is deliberately full of things a re-print would eat: two leading comments, a
 * block comment mid-document, blank lines in the middle of a table, a `'''` note with prose whose
 * internal spacing is meaningful, an `indexes` block, hand-aligned columns, and a quoted table name
 * with an alias.
 */
const DOC = `// The schema for the shop.
// Second comment line.

Table authors {
  id         integer      [pk, increment]
  name       varchar(120) [not null]

  email      varchar(160) [not null, unique]

  note: '''
  Authors write posts.
  Keep   this   spacing.
  '''

  indexes {
    (email) [unique]
  }
}

/* a block comment */
Table posts {
  id        integer      [pk, increment]
  author_id integer      [not null]
  title     varchar(200) [not null]
}

Table "order items" as oi {
  id  integer [pk]
  qty int
}

Enum status {
  draft
  live
}

Ref: posts.author_id > authors.id
`;

/** The parts of the fixture no edit below is aimed at, so no edit below may disturb them. */
const PRESERVED = [
  "// The schema for the shop.\n// Second comment line.",
  "/* a block comment */",
  "  id        integer      [pk, increment]",
  'Table "order items" as oi {',
];

function expectPreserved(got: string, except: string[] = []) {
  for (const fragment of PRESERVED) {
    if (except.includes(fragment)) continue;
    expect(got, `lost: ${fragment}`).toContain(fragment);
  }
}

describe("freeName", () => {
  it("returns the base when it is free", () => {
    expect(freeName([], "column")).toBe("column");
    expect(freeName(["id", "name"], "column")).toBe("column");
  });

  it("counts up past every taken form", () => {
    expect(freeName(["column"], "column")).toBe("column_2");
    expect(freeName(["column", "column_2"], "column")).toBe("column_3");
  });

  // DBML compares names case-insensitively, so `Column` and `column` are one collision.
  it("ignores case", () => {
    expect(freeName(["COLUMN"], "column")).toBe("column_2");
  });
});

describe("columns", () => {
  it("adds one at the end of the table body", () => {
    const got = addField(DOC, "posts", { name: "body", type: "text" });
    expect(got).toContain("  body text");
    // Inside the block, not after its closing brace.
    expect(got.indexOf("  body text")).toBeLessThan(got.indexOf('Table "order items"'));
    expectPreserved(got);
  });

  it("adds exactly one line and changes nothing above it", () => {
    const got = addField(DOC, "posts", { name: "body", type: "text" });
    const before = DOC.split("\n");
    const after = got.split("\n");
    expect(after.length - before.length).toBe(1);
    const untouched = before.indexOf("Table posts {");
    expect(after.slice(0, untouched).join("\n")).toBe(before.slice(0, untouched).join("\n"));
  });

  it("writes the settings list in DBML's order", () => {
    const got = addField(DOC, "posts", {
      name: "slug",
      type: "varchar(80)",
      unique: true,
      notNull: true,
      note: "it's unique",
    });
    expect(got).toContain("  slug varchar(80) [unique, not null, note: 'it\\'s unique']");
  });

  it("replaces a column's whole line", () => {
    const got = updateField(DOC, "posts", "title", { name: "title", type: "text", notNull: true });
    expect(got).toContain("  title text [not null]");
    expect(got).not.toContain("varchar(200)");
    expectPreserved(got);
  });

  it("keeps the indentation the table already uses", () => {
    // `order items` is indented two spaces like the rest, so a new row matches its neighbours.
    const got = addField(DOC, "order items", { name: "note_id", type: "int" });
    expect(got).toContain("  note_id int");
  });

  it("removes one, and the relationships drawn to it", () => {
    const got = dropField(DOC, "authors", "id");
    expect(got).not.toContain("Ref: posts.author_id");
    expectPreserved(got);
  });

  it("leaves unrelated relationships alone when removing a column", () => {
    const got = dropField(DOC, "posts", "title");
    expect(got).toContain("Ref: posts.author_id > authors.id");
    expect(got).not.toContain("varchar(200)");
  });

  // The name also appears inside `indexes { (email) [unique] }`; that is not its declaration.
  it("does not mistake an index entry for the column", () => {
    const got = dropField(DOC, "authors", "email");
    expect(got).not.toContain("  email      varchar(160)");
    expect(got).toContain("    (email) [unique]");
  });

  it("renames the refs that name a renamed column", () => {
    const got = updateField(DOC, "authors", "id", {
      name: "author_id",
      type: "integer",
      pk: true,
      increment: true,
    });
    expect(got).toContain("Ref: posts.author_id > authors.author_id");
  });
});

describe("tables", () => {
  it("appends a new one with a primary key", () => {
    const got = addTable(DOC, "comments");
    expect(got).toContain("Table comments {");
    expect(got).toContain("  id integer [pk, increment]");
    expectPreserved(got);
  });

  it("renames the declaration and every ref that names it", () => {
    const got = renameTable(DOC, "authors", "writers");
    expect(got).toContain("Table writers {");
    expect(got).not.toContain("Table authors {");
    expect(got).toContain("Ref: posts.author_id > writers.id");
  });

  // The trap a text replace falls into: `author_id` contains the word being renamed.
  it("does not rewrite a column whose name contains the table's", () => {
    const got = renameTable(DOC, "authors", "writers");
    expect(got).toContain("  author_id integer      [not null]");
  });

  it("removes a table and every relationship touching it", () => {
    const got = dropTable(DOC, "authors");
    expect(got).not.toContain("Table authors {");
    expect(got).not.toContain("Ref: posts.author_id");
    expect(got).toContain("Table posts {");
    expectPreserved(got);
  });

  it("replaces a block note without reflowing an untouched one", () => {
    const got = setTableNote(DOC, "authors", "Short one.");
    expect(got).toContain("  note: 'Short one.'");
    expect(got).not.toContain("Authors write posts.");
    expectPreserved(got);
  });

  it("adds a note to a table that has none", () => {
    const got = setTableNote(DOC, "posts", "Posts belong to authors.");
    expect(got).toContain("  note: 'Posts belong to authors.'");
    // The other table's note is not this edit's business.
    expect(got).toContain("  Keep   this   spacing.");
  });

  it("appends an enum with the values it was given", () => {
    const got = addEnum(DOC, "visibility", ["public", "private"]);
    expect(got).toContain("Enum visibility {");
    expect(got).toContain("  public");
    expect(got).toContain("  private");
  });
});

describe("relationships", () => {
  it("appends a Ref line", () => {
    const got = addRef(DOC, { table: "posts", column: "id" }, { table: "authors", column: "id" }, "<");
    expect(got).toContain("Ref: posts.id < authors.id");
    expectPreserved(got);
  });

  // Appending a duplicate is what makes the document stop parsing, so it is refused outright.
  it("is a no-op when the relationship is already declared", () => {
    const got = addRef(
      DOC,
      { table: "posts", column: "author_id" },
      { table: "authors", column: "id" },
      ">",
    );
    expect(got).toBe(DOC);
  });

  it("removes one given either end first", () => {
    const forwards = dropRef(
      DOC,
      { table: "posts", column: "author_id" },
      { table: "authors", column: "id" },
    );
    const backwards = dropRef(
      DOC,
      { table: "authors", column: "id" },
      { table: "posts", column: "author_id" },
    );
    expect(forwards).not.toContain("Ref: posts.author_id");
    expect(backwards).not.toContain("Ref: posts.author_id");
  });

  it("rewrites the arrow in place", () => {
    const got = setRefCardinality(
      DOC,
      { table: "posts", column: "author_id" },
      { table: "authors", column: "id" },
      "<",
    );
    expect(got).toContain("Ref: posts.author_id < authors.id");
    expectPreserved(got);
  });

  // `ARROW` must stay non-capturing: `String.split` with a capture group interleaves the capture,
  // which returns `[left, ">", right]` and makes every operation here read the arrow as an endpoint.
  it("reads both endpoints rather than the arrow", () => {
    const got = dropRef(
      DOC,
      { table: "posts", column: "author_id" },
      { table: "authors", column: "id" },
    );
    expect(got).not.toBe(DOC);
  });
});

describe("a document being typed", () => {
  it("still takes a column when the block is unclosed", () => {
    const half = "Table a {\n  id int\n";
    const got = addField(half, "a", { name: "x", type: "int" });
    expect(got).toContain("  x int");
    expect(got.startsWith("Table a {\n  id int")).toBe(true);
  });

  it("leaves a document alone when the table is not there", () => {
    expect(addField(DOC, "nope", { name: "x", type: "int" })).toBe(DOC);
    expect(renameTable(DOC, "nope", "other")).toBe(DOC);
    expect(dropTable(DOC, "nope")).toBe(DOC);
  });
});

/**
 * The invariant the whole workbench rests on, checked across every operation.
 *
 * The dragged box positions live in a trailing `// codeflow:layout {…}` comment, and the editor's
 * value is the *source* half. `edit.ts` never sees that comment — callers split it off and put it
 * back — so the thing worth proving is that a full round trip through an edit returns the positions
 * untouched and the source byte for byte.
 */
describe("the layout comment survives every operation", () => {
  const positions = { authors: { x: 40, y: 80 }, posts: { x: 300, y: 80 } };

  const operations: [string, (source: string) => string][] = [
    ["addField", (s) => addField(s, "posts", { name: "body", type: "text" })],
    ["updateField", (s) => updateField(s, "posts", "title", { name: "title", type: "text" })],
    ["dropField", (s) => dropField(s, "posts", "title")],
    ["addTable", (s) => addTable(s, "comments")],
    ["renameTable", (s) => renameTable(s, "authors", "writers")],
    ["dropTable", (s) => dropTable(s, "authors")],
    ["setTableNote", (s) => setTableNote(s, "posts", "A note.")],
    ["addEnum", (s) => addEnum(s, "visibility")],
    [
      "addRef",
      (s) => addRef(s, { table: "posts", column: "id" }, { table: "authors", column: "id" }, "<"),
    ],
    [
      "dropRef",
      (s) => dropRef(s, { table: "posts", column: "author_id" }, { table: "authors", column: "id" }),
    ],
  ];

  it.each(operations)("%s round-trips through readLayout/writeLayout", (_name, operate) => {
    const stored = writeLayout(DOC, positions);
    const { source, positions: read } = readLayout(stored);

    // The split itself is lossless before anything is edited.
    expect(source).toBe(DOC);
    expect(read).toEqual(positions);

    const edited = operate(source);
    const rewritten = writeLayout(edited, read);
    const after = readLayout(rewritten);

    expect(after.source).toBe(edited);
    expect(after.positions).toEqual(positions);
  });
});
