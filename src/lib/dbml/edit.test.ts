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
  marksFromComments,
  renameTable,
  stripMarkComments,
  setRefCardinality,
  setFieldMarkComment,
  setMarkComment,
  setTableNote,
  updateField,
} from "./edit";
import { formatDbml } from "./format";
import { fieldMarkKey, readLayout, splitFieldMarkKey, writeLayout } from "./layout";

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

describe("review marks", () => {
  it("writes the state above the declaration", () => {
    const got = setMarkComment(DOC, "posts", "remove");
    expect(got).toContain("// ELIMINAR\nTable posts {");
    expectPreserved(got);
  });

  it("uses one word per mark", () => {
    expect(setMarkComment(DOC, "posts", "review")).toContain("// REVISAR\nTable posts {");
    expect(setMarkComment(DOC, "posts", "keep")).toContain("// RESUELTA\nTable posts {");
  });

  /* Changing your mind is the common move, and it must replace rather than stack. */
  it("replaces the previous mark instead of adding a second one", () => {
    const once = setMarkComment(DOC, "posts", "remove");
    const twice = setMarkComment(once, "posts", "review");
    expect(twice).toContain("// REVISAR\nTable posts {");
    expect(twice).not.toContain("ELIMINAR");
    expect(twice.split("\n").length).toBe(once.split("\n").length);
  });

  it("takes the comment away when the mark is cleared", () => {
    const marked = setMarkComment(DOC, "posts", "remove");
    expect(setMarkComment(marked, "posts", null)).toBe(DOC);
  });

  /* The block comment above `posts` is somebody's prose. Only the marker line is ours to move. */
  it("leaves the author's own comments where they are", () => {
    const got = setMarkComment(DOC, "posts", "remove");
    expect(got).toContain("/* a block comment */\n// ELIMINAR\nTable posts {");
    expect(setMarkComment(got, "posts", null)).toBe(DOC);
  });

  it("is a no-op for a name the document does not declare", () => {
    expect(setMarkComment(DOC, "sessions", "remove")).toBe(DOC);
    // A relationship id, which is what a mark on a ref is keyed by. It must not find a table.
    expect(setMarkComment(DOC, "posts.author_id->authors.id", "remove")).toBe(DOC);
  });

  it("matches a quoted name and its alias", () => {
    expect(setMarkComment(DOC, "order items", "keep")).toContain(
      '// RESUELTA\nTable "order items" as oi {',
    );
    expect(setMarkComment(DOC, "oi", "keep")).toContain('// RESUELTA\nTable "order items" as oi {');
  });

  /* Marking a table and then deleting it is the whole workflow. The marker must not outlive it. */
  it("goes with the table when it is dropped", () => {
    const marked = setMarkComment(DOC, "posts", "remove");
    const got = dropTable(marked, "posts");
    expect(got).not.toContain("ELIMINAR");
    expect(got).not.toContain("Table posts {");
    expect(got).toContain("/* a block comment */");
  });

  it("is invisible to the sidecar split", () => {
    const marked = setMarkComment(DOC, "posts", "remove");
    const stored = writeLayout(marked, {}, { posts: "remove" });
    const read = readLayout(stored);
    expect(read.source).toBe(marked);
    expect(read.marks).toEqual({ posts: "remove" });
  });
});

/**
 * The same feature one row down, where the mark is about a *column*.
 *
 * The thing being held is the placement decision: a table's mark gets a line of its own above the
 * declaration and a column's rides at the end of the column's own line — because a line per marked
 * column doubles the height of the table you are trying to read across. Everything below follows
 * from that, and the last two are what make the choice safe: the mark has to survive the formatter
 * (which re-lays every field line) and it has to survive an edit to the column it is on (which
 * rewrites that line wholesale).
 */
describe("review marks on a column", () => {
  it("writes the state at the end of the column's line", () => {
    const got = setFieldMarkComment(DOC, "posts", "title", "remove");
    expect(got).toContain("  title     varchar(200) [not null]  // ELIMINAR");
    expectPreserved(got);
  });

  it("uses the same word per mark that a table's does", () => {
    expect(setFieldMarkComment(DOC, "posts", "title", "review")).toContain("[not null]  // REVISAR");
    expect(setFieldMarkComment(DOC, "posts", "title", "keep")).toContain("[not null]  // RESUELTA");
  });

  /* The table's own mark is a *different* mark, on a different line, and must not be disturbed. */
  it("leaves the table's own mark where it is", () => {
    const both = setFieldMarkComment(setMarkComment(DOC, "posts", "review"), "posts", "title", "remove");
    expect(both).toContain("// REVISAR\nTable posts {");
    expect(both).toContain("[not null]  // ELIMINAR");
  });

  it("replaces the previous mark instead of adding a second one", () => {
    const once = setFieldMarkComment(DOC, "posts", "title", "remove");
    const twice = setFieldMarkComment(once, "posts", "title", "review");
    expect(twice).toContain("[not null]  // REVISAR");
    expect(twice).not.toContain("ELIMINAR");
    expect(twice.split("\n").length).toBe(DOC.split("\n").length);
  });

  it("takes the comment away when the mark is cleared", () => {
    const marked = setFieldMarkComment(DOC, "posts", "title", "remove");
    expect(setFieldMarkComment(marked, "posts", "title", null)).toBe(DOC);
  });

  /* Somebody's own trailing note is theirs. The marker is appended after it and taken away from
     after it, and clearing must give the line back exactly as it was found. */
  it("leaves a comment the author wrote on the column alone", () => {
    const annotated = DOC.replace("  title     varchar(200) [not null]", "  title     varchar(200) [not null] // ask the CMS team");
    const marked = setFieldMarkComment(annotated, "posts", "title", "remove");
    expect(marked).toContain("// ask the CMS team  // ELIMINAR");
    expect(setFieldMarkComment(marked, "posts", "title", null)).toBe(annotated);
  });

  it("is a no-op for a table or a column the document does not declare", () => {
    expect(setFieldMarkComment(DOC, "sessions", "id", "remove")).toBe(DOC);
    expect(setFieldMarkComment(DOC, "posts", "slug", "remove")).toBe(DOC);
    // `note` and `indexes` open blocks of their own; neither is a column.
    expect(setFieldMarkComment(DOC, "authors", "note", "remove")).toBe(DOC);
  });

  /* Marking a column and then deleting it is the whole workflow. The marker goes with the line. */
  it("goes with the column when it is dropped", () => {
    const marked = setFieldMarkComment(DOC, "posts", "title", "remove");
    const got = dropField(marked, "posts", "title");
    expect(got).not.toContain("ELIMINAR");
    expect(got).not.toContain("varchar(200)");
    expectPreserved(got);
  });

  /* `updateField` rewrites the whole line, so without the carry the mark would be deleted by an
     edit that never mentioned it — and the sidecar, which keeps it, would then be alone. */
  it("survives an edit to the column it is on", () => {
    const marked = setFieldMarkComment(DOC, "posts", "title", "review");
    const got = updateField(marked, "posts", "title", { name: "title", type: "text" });
    expect(got).toContain("  title text  // REVISAR");
  });

  it("survives the column being renamed", () => {
    const marked = setFieldMarkComment(DOC, "posts", "title", "review");
    const got = updateField(marked, "posts", "title", { name: "headline", type: "text" });
    expect(got).toContain("  headline text  // REVISAR");
  });

  /* The placement is only worth having if Format keeps it: the formatter re-lays every field line
     in the block, and it is the one thing in this app that touches lines nobody edited. */
  it("survives being formatted, and is aligned rather than moved", () => {
    const marked = setFieldMarkComment(DOC, "posts", "title", "remove");
    const tidy = formatDbml(marked);
    expect(tidy).toMatch(/ {2}title {5}varchar\(200\) \[not null] {2}\/\/ ELIMINAR/);
    // And formatting is idempotent over it, so opening a marked file does not produce a diff.
    expect(formatDbml(tidy)).toBe(tidy);
  });
});

/**
 * Reading the marks back out of the document.
 *
 * The half that makes a mark removable. Until the comments could be read back, a `// REVISAR` the
 * `// codeflow:marks` sidecar had forgotten was invisible to the app — undrawn, so unoffered in any
 * menu, so never passed to `setMarkComment` — and the only way to take it out of the document was
 * to delete the line by hand.
 */
describe("marks recovered from the document", () => {
  it("finds nothing in a document nobody has marked", () => {
    expect(marksFromComments(DOC)).toEqual({});
  });

  it("reads back exactly what the two writers wrote", () => {
    const marked = setFieldMarkComment(setMarkComment(DOC, "posts", "remove"), "posts", "title", "keep");
    expect(marksFromComments(marked)).toEqual({
      posts: "remove",
      [fieldMarkKey("posts", "title")]: "keep",
    });
  });

  it("reads a mark somebody typed by hand, spaced and cased however they liked", () => {
    const byHand = DOC.replace("Table posts {", "//revisar\nTable posts {");
    expect(marksFromComments(byHand)).toEqual({ posts: "review" });
  });

  /* The clearing path is the whole point: what is read back has to be what `setMarkComment` and
     `setFieldMarkComment` can then take away again. */
  it("hands back a key those writers can clear with", () => {
    const marked = setFieldMarkComment(setMarkComment(DOC, "posts", "review"), "posts", "title", "remove");
    const cleared = setFieldMarkComment(setMarkComment(marked, "posts", null), "posts", "title", null);
    expect(cleared).toBe(DOC);
    expect(marksFromComments(cleared)).toEqual({});
  });

  it("survives the document being formatted", () => {
    const marked = setFieldMarkComment(setMarkComment(DOC, "posts", "review"), "posts", "title", "remove");
    expect(marksFromComments(formatDbml(marked))).toEqual({
      posts: "review",
      [fieldMarkKey("posts", "title")]: "remove",
    });
  });

  /* A quoted name and an alias are two different strings and only one of them is the id. */
  it("keys a table by its declared name and not by its alias", () => {
    const marked = setMarkComment(DOC, "oi", "keep");
    expect(marksFromComments(marked)).toEqual({ "order items": "keep" });
  });

  /* Neither `note:` nor `indexes` is a column, and a trailing marker on one is not a column's. */
  it("does not mistake a note or an index for a column", () => {
    const marked = DOC.replace("    (email) [unique]", "    (email) [unique]  // REVISAR");
    expect(marksFromComments(marked)).toEqual({});
  });

  /* The sidecar is keyed by id, so the comments have to be too — and `public` is not part of one. */
  it("drops the default schema from a qualified declaration", () => {
    expect(marksFromComments("// REVISAR\nTable public.users {\n  id int\n}\n")).toEqual({
      users: "review",
    });
    expect(marksFromComments("// REVISAR\nTable core.users {\n  id int\n}\n")).toEqual({
      "core.users": "review",
    });
  });
});

/**
 * The half of marking that was reported broken: taking one off and having the document follow.
 *
 * Every failure here has the same shape from the outside — the mark leaves the canvas and the
 * `// REVISAR` stays in the text, with nothing left in the app that admits the comment is there.
 */
describe("taking a mark off again", () => {
  it("removes a marker that has drifted off its declaration", () => {
    // A blank line above the table is all it takes: somebody pressed Enter, a merge left a gap, a
    // paste landed between the two. The marker is still plainly that table's, and a clear that only
    // looked at the line immediately above used to walk away from it.
    const drifted = DOC.replace("Table posts {", "// REVISAR\n\nTable posts {");
    const cleared = setMarkComment(drifted, "posts", null);
    expect(cleared).not.toContain("REVISAR");
    // The blank line is the author's and stays: only the marker line is taken out.
    expect(cleared).toContain("\n\nTable posts {");
  });

  it("shows a drifted marker as a mark, so there is something to press", () => {
    const drifted = DOC.replace("Table posts {", "// REVISAR\n\nTable posts {");
    expect(marksFromComments(drifted)).toEqual({ posts: "review" });
  });

  /* The walk upwards must not reach past the table above into its marker. */
  it("does not take the previous table's marker with it", () => {
    const both = setMarkComment(setMarkComment(DOC, "authors", "remove"), "posts", "review");
    const cleared = setMarkComment(both, "posts", null);
    expect(cleared).toContain("// ELIMINAR\nTable authors {");
    expect(cleared).not.toContain("REVISAR");
  });

  it("is the same string back when there was nothing to clear", () => {
    expect(setMarkComment(DOC, "posts", null)).toBe(DOC);
  });
});

/**
 * A column's mark that somebody has moved onto a line of its own.
 *
 * The reported bug, from a real schema. A column's mark is written at the *end* of its line, which
 * on a column already carrying a sentence of the author's own buries it a hundred characters into
 * the prose — so people push it down onto its own line, which is the obvious thing to do and used
 * to make it vanish from the app entirely: nothing read it, so no dot was drawn, so no menu offered
 * to clear it, so the one function that could have removed it was never asked to.
 */
describe("a column's mark on a line of its own", () => {
  const MOVED = `Table servicio {
  id uuid [pk]
  nombre text [not null] // Nombre del servicio, ej: Consulta de Medicina Interna.
  // REVISAR

  codigo text [not null]

  // duracion o tipo_cita
  duracion int [not null]

  note: '''
  Ejemplo: Resonancia Magnética (Rodilla).
  REVISAR
  '''
}
`;

  it("belongs to the column above it", () => {
    expect(marksFromComments(MOVED)).toEqual({ [fieldMarkKey("servicio", "nombre")]: "review" });
  });

  it("comes off when that column's mark is cleared", () => {
    const cleared = setFieldMarkComment(MOVED, "servicio", "nombre", null);
    expect(cleared).not.toContain("// REVISAR");
    expect(marksFromComments(cleared)).toEqual({});
  });

  /* Only the marker goes. A comment of the author's next door is not one of these. */
  it("leaves the author's own comments where they are", () => {
    const cleared = setFieldMarkComment(MOVED, "servicio", "nombre", null);
    expect(cleared).toContain("  // duracion o tipo_cita");
    expect(cleared).toContain("  nombre text [not null] // Nombre del servicio");
  });

  /* Prose inside a `'''` note is prose, however much a line of it looks like a marker. */
  it("does not reach inside a multi-line note", () => {
    expect(setFieldMarkComment(MOVED, "servicio", "nombre", null)).toContain("\n  REVISAR\n");
  });

  /* Setting a new one has to fold the stray back in, or the column wears two marks at once. */
  it("is folded back onto the line when the column is marked again", () => {
    const set = setFieldMarkComment(MOVED, "servicio", "nombre", "remove");
    expect(set).toContain("Medicina Interna.  // ELIMINAR");
    expect(set).not.toContain("// REVISAR");
    expect(marksFromComments(set)).toEqual({ [fieldMarkKey("servicio", "nombre")]: "remove" });
  });

  /* A marker before the first column has nothing above it, so it reads downwards instead. */
  it("reads downwards when there is no column above it", () => {
    const first = "Table a {\n  // ELIMINAR\n  id int\n}\n";
    expect(marksFromComments(first)).toEqual({ [fieldMarkKey("a", "id")]: "remove" });
    expect(setFieldMarkComment(first, "a", "id", null)).toBe("Table a {\n  id int\n}\n");
  });
});

/**
 * The sweep, which is the one clear that cannot fail.
 *
 * It finds nothing and locates nothing: it reads lines. That is the point — it is what the
 * "clear every mark" control runs, and the way out of any disagreement the targeted clears above
 * cannot reconcile.
 */
describe("stripMarkComments", () => {
  it("takes every marker out, on tables and on columns alike", () => {
    const marked = setFieldMarkComment(setMarkComment(DOC, "posts", "remove"), "posts", "title", "review");
    const swept = stripMarkComments(marked);
    expect(swept).toBe(DOC);
    expect(marksFromComments(swept)).toEqual({});
  });

  it("reaches markers the targeted clears cannot", () => {
    // Detached from any declaration at all, which is as far as a marker can drift.
    const stray = "// REVISAR\n\n\n" + DOC;
    expect(stripMarkComments(stray)).not.toContain("REVISAR");
  });

  it("keeps a comment of the author's that merely ends in one of the words", () => {
    const prose = "Table a {\n  id int // no hay nada que revisar aqui\n}\n";
    expect(stripMarkComments(prose)).toBe(prose);
  });

  it("is the same string back on a document nobody has marked", () => {
    expect(stripMarkComments(DOC)).toBe(DOC);
  });
});

/**
 * How a column's mark is filed in the sidecar the canvas reads.
 *
 * One map holds tables, relationships and columns, so the only thing that keeps the three apart is
 * the shape of the key — and a column's is the only one with a pipe in it.
 */
describe("the key a column's mark is filed under", () => {
  it("round-trips a table id and a column name", () => {
    expect(splitFieldMarkKey(fieldMarkKey("core.users", "id"))).toEqual({
      table: "core.users",
      column: "id",
    });
  });

  it("is not a table id and is not a relationship id", () => {
    expect(splitFieldMarkKey("core.users")).toBeNull();
    expect(splitFieldMarkKey("posts.author_id->authors.id")).toBeNull();
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
