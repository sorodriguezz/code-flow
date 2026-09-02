import { describe, expect, it } from "vitest";
import { outlineOf, tableAtLine } from "./outline";
import { blocksOf, findBlock } from "./blocks";

/**
 * The scan behind DBML completion.
 *
 * Two things are worth holding down, and neither is "does it find the tables".
 *
 * **It must keep answering while the document is broken.** That is the whole reason it exists
 * instead of a call to `parseDbml`: the moment you are typing the table you want completions for,
 * the document does not parse. A scan that gave up on an unclosed brace would go silent exactly
 * when it is needed.
 *
 * **`open` must be the block the caret is actually in.** The tempting derivation — "the last table,
 * if the braces do not balance" — is wrong for a caret inside an `Enum` that follows a table, and
 * would offer that table's columns while you are typing enum values.
 */

const DOC = [
  "// a leading comment",
  "Table authors {",
  "  id         integer      [pk, increment]",
  "  name       varchar(120) [not null]",
  "  email      varchar(160) [not null, unique]",
  "  created_at timestamp    [default: `now()`]",
  "  note: '''",
  "  id not a column",
  "  '''",
  "  indexes {",
  "    (email) [unique]",
  "  }",
  "}",
  "",
  'Table "order items" as oi {',
  "  id integer [pk]",
  "  qty int",
  "}",
  "",
  "Enum status {",
  "  draft",
  "  live",
  "}",
  "",
  "Ref: posts.author_id > authors.id",
  "",
  "Table half {",
  "  id int",
].join("\n");

describe("outlineOf", () => {
  it("finds every table, however its name was written", () => {
    const names = outlineOf(DOC).tables.map((table) => table.name);
    expect(names).toEqual(["authors", "order items", "half"]);
  });

  it("unquotes a name and keeps its alias", () => {
    const table = outlineOf(DOC).tables[1];
    expect(table.name).toBe("order items");
    expect(table.alias).toBe("oi");
  });

  it("reads columns with their types", () => {
    const authors = outlineOf(DOC).tables[0];
    expect(authors.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      "id:integer",
      "name:varchar(120)",
      "email:varchar(160)",
      "created_at:timestamp",
    ]);
  });

  // The prose inside a `'''` note is shaped like a column often enough to matter — the fixture's
  // note starts with the word `id` on purpose.
  it("does not read the prose of a block note as columns", () => {
    const authors = outlineOf(DOC).tables[0];
    expect(authors.columns.map((column) => column.name)).not.toContain("not");
    expect(authors.columns).toHaveLength(4);
  });

  // A note that opens and closes on one line must not toggle the state at all.
  it("handles a single-line block note", () => {
    const doc = "Table a {\n  note: '''one line'''\n  id int\n}\n";
    expect(outlineOf(doc).tables[0].columns.map((c) => c.name)).toContain("id");
  });

  it("does not read an index entry as a column", () => {
    const authors = outlineOf(DOC).tables[0];
    expect(authors.columns.map((column) => column.name)).not.toContain("(email)");
  });

  it("collects enums separately from tables", () => {
    expect(outlineOf(DOC).enums).toEqual(["status"]);
    expect(outlineOf(DOC).tables.map((table) => table.name)).not.toContain("status");
  });

  it("keeps the unclosed block at the end, which is the one being typed", () => {
    expect(outlineOf(DOC).open?.name).toBe("half");
  });

  it("returns an empty outline for empty input", () => {
    expect(outlineOf("")).toEqual({ tables: [], enums: [], open: null });
  });
});

describe("tableAtLine", () => {
  it("answers with the table the caret is inside", () => {
    expect(tableAtLine(DOC, 4)?.name).toBe("authors");
    expect(tableAtLine(DOC, 28)?.name).toBe("half");
  });

  it("answers null at the top level", () => {
    expect(tableAtLine(DOC, 14)).toBeNull();
  });

  // The case the naive "last table if unbalanced" rule gets wrong.
  it("answers null inside an enum that follows a table", () => {
    expect(tableAtLine(DOC, 21)).toBeNull();
  });
});

/**
 * The built-in DBML template, read by the scan.
 *
 * Inlined rather than imported from `lib/diagrams/builtinTemplates.ts`: that module pulls in the
 * whole template registry and its icons for two tables' worth of text, and a scan test that has to
 * boot a registry is a scan test that breaks when the registry does. Kept identical to `schema()`
 * there, which is the shape a new DBML diagram actually starts from.
 */
const BUILT_IN = [
  "Table authors {",
  "  id         integer      [pk, increment]",
  "  name       varchar(120) [not null]",
  "  email      varchar(160) [not null, unique]",
  "  created_at timestamp    [default: `now()`]",
  "}",
  "",
  "Table posts {",
  "  id        integer      [pk, increment]",
  "  author_id integer      [not null, ref: > authors.id]",
  "  title     varchar(200) [not null]",
  "  body      text",
  "  published boolean      [not null, default: false]",
  "}",
  "",
].join("\n");

describe("the built-in template", () => {
  it("is read completely", () => {
    const outline = outlineOf(BUILT_IN);
    expect(outline.tables.map((table) => table.name)).toEqual(["authors", "posts"]);
    expect(outline.tables[1].columns.map((column) => column.name)).toEqual([
      "id",
      "author_id",
      "title",
      "body",
      "published",
    ]);
    // Nothing is left open: the document is complete.
    expect(outline.open).toBeNull();
  });

  // A `ref:` inside a column's settings must not be mistaken for a block or a column.
  it("is not confused by an inline ref setting", () => {
    const posts = outlineOf(BUILT_IN).tables[1];
    expect(posts.columns[1]).toEqual({ name: "author_id", type: "integer" });
  });
});

/**
 * The block splitter the edit operations locate their work with.
 *
 * Tested here rather than in `edit.test.ts` because what it returns — line ranges — is what every
 * operation there depends on being right, and a range that is off by one is a much clearer failure
 * read as "the block is lines 4..13" than as "the column landed in the wrong place".
 */
describe("blocksOf", () => {
  it("gives each block its half-open line range", () => {
    const lines = DOC.split("\n");
    const authors = findBlock(blocksOf(DOC), "authors", "table");
    expect(authors).toBeDefined();
    expect(lines[authors!.from]).toBe("Table authors {");
    expect(lines[authors!.to - 1]).toBe("}");
  });

  it("marks a block that was never closed", () => {
    const half = findBlock(blocksOf(DOC), "half", "table");
    expect(half?.closed).toBe(false);
    const authors = findBlock(blocksOf(DOC), "authors", "table");
    expect(authors?.closed).toBe(true);
  });

  it("treats a one-line Ref as its own block", () => {
    const refs = blocksOf(DOC).filter((block) => block.kind === "ref");
    expect(refs).toHaveLength(1);
    expect(refs[0].to - refs[0].from).toBe(1);
  });

  it("finds a table by its alias as well as its name", () => {
    const blocks = blocksOf(DOC);
    expect(findBlock(blocks, "oi", "table")?.name).toBe("order items");
    expect(findBlock(blocks, "order items", "table")?.alias).toBe("oi");
  });

  // `findBlock` falls back to the bare half so `public.orders` is reachable as `orders`.
  it("finds a schema-qualified table by its bare name", () => {
    const blocks = blocksOf("Table public.orders {\n  id int\n}\n");
    expect(findBlock(blocks, "orders", "table")?.name).toBe("public.orders");
  });
});
