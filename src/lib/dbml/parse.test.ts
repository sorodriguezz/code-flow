import { describe, expect, it } from "vitest";
import { parseDbml } from "./parse";

/**
 * What the real parser accepts, and what the model it produces looks like.
 *
 * The suite exists for the dialect switch: `parse.ts` used to call `Parser.parse(source, "dbml")`,
 * the v1 PEG grammar, which rejects several shapes that are ordinary DBML — a `TableGroup` note
 * among them. It now calls the v2 compiler. Everything below is either a shape v1 refused, or a
 * place where the two compilers hand back a *different* model and this file is what pins which one
 * the app carries.
 */

describe("TableGroup notes", () => {
  const GROUPED = `Table users {
  id integer [pk]
}

Table orders {
  id integer [pk]
}

TableGroup billing {
  users
  orders
  Note: 'Todo lo de facturacion'
}
`;

  /* The bug this switch was made for: v1 answered `Expected " ", comment, or newline but "}" found`
     and the whole document stopped parsing over one note. */
  it("parses a Note: inside the block", () => {
    const schema = parseDbml(GROUPED);
    expect(schema.error).toBeNull();
    expect(schema.groups).toHaveLength(1);
    expect(schema.groups[0].note).toBe("Todo lo de facturacion");
    expect(schema.groups[0].tables).toEqual(["users", "orders"]);
  });

  it("parses the settings form as well", () => {
    const schema = parseDbml(
      `Table users {\n  id integer [pk]\n}\n\nTableGroup billing [note: 'Facturacion'] {\n  users\n}\n`,
    );
    expect(schema.error).toBeNull();
    expect(schema.groups[0].note).toBe("Facturacion");
  });

  it("still parses a group with no note at all", () => {
    const schema = parseDbml(`Table users {\n  id integer [pk]\n}\n\nTableGroup billing {\n  users\n}\n`);
    expect(schema.error).toBeNull();
    expect(schema.groups[0]).toMatchObject({ name: "billing", note: "", tables: ["users"] });
  });
});

describe("notes", () => {
  /* The v2 compiler keeps the newline before the closing `'''`; v1 dropped it, `setTableNote`
     writes `note.trim()`, and every consumer was built against the trimmed form. */
  it("carries a fenced note without its trailing newline", () => {
    const schema = parseDbml(
      `Table t {\n  id integer [pk]\n  note: '''\n  primera\n  segunda\n  '''\n}\n`,
    );
    expect(schema.error).toBeNull();
    expect(schema.tables[0].note).toBe("primera\nsegunda");
  });

  it("leaves a one-line note alone", () => {
    const schema = parseDbml(`Table t {\n  id integer [pk]\n  note: 'una linea'\n}\n`);
    expect(schema.tables[0].note).toBe("una linea");
  });
});

describe("relationships written against an alias", () => {
  const ALIASED = `Table "order items" as oi {
  id integer [pk]
}

Table posts {
  id    integer [pk]
  oi_id integer
}

Ref: posts.oi_id > oi.id
`;

  /**
   * v1 handed the *alias* back as the endpoint's table name, and `resolveEndpoint` has no alias to
   * resolve against — so the ref came out pointing at a table id (`oi`) that nothing declares, and
   * the canvas dropped the line. The relationship was simply missing from the picture, with no
   * error to say why. v2 resolves the alias itself and the endpoint arrives as the real table.
   */
  it("resolves to the table's real id, so the line is drawn", () => {
    const schema = parseDbml(ALIASED);
    expect(schema.error).toBeNull();
    expect(schema.refs).toHaveLength(1);
    expect(schema.refs[0].to.table).toBe("order items");
    // What the canvas does with it: both ends must name a table it has a box for.
    const known = new Set(schema.tables.map((table) => table.id));
    expect(known.has(schema.refs[0].from.table)).toBe(true);
    expect(known.has(schema.refs[0].to.table)).toBe(true);
  });
});

describe("a document that does not parse", () => {
  /* The error has to survive as *data* with a position on it, or the editor's marker and the
     banner's "jump to it" both stop working. Both compilers throw `{diags:[{message, location}]}`;
     this is what holds that down across the switch. */
  it("comes back with the tables it could recover and a placed error", () => {
    //                     1              2                3   4  5              6
    const schema = parseDbml(`Table users {\n  id integer [pk]\n}\n\nTable orders {\n  id\n}\n`);
    expect(schema.error).not.toBeNull();
    // On the untyped column, not on the first line of the file — the editor draws a marker here.
    expect(schema.errorAt?.line).toBe(6);
    // The regex reader keeps the canvas drawn while the message is shown.
    expect(schema.tables.map((table) => table.name)).toContain("users");
  });
});

describe("Records, while the document does not parse", () => {
  /* The forgiving reader answers every keystroke that leaves the document broken, and it had never
     heard of `Records`: a row's text was read as DBML. Each case below has a trailing table that the
     real parser rejects, so the regex reader is the one drawing the canvas. */
  const BROKEN_TAIL = "\n\nTable drafts {\n  id int [pk]\n  title varchar [\n}\n";

  it("does not invent a table out of a row's text", () => {
    const schema = parseDbml(
      "Table users {\n  id int [pk]\n  site varchar\n}\n\nRecords users(id, site) {\n  1, 'table x {'\n  2, 'http://example.test/{a}'\n}" +
        BROKEN_TAIL,
    );
    expect(schema.error).not.toBeNull();
    expect(schema.tables.map((table) => table.id)).toEqual(["users", "drafts"]);
    expect(schema.tables[0].fields.map((field) => field.name)).toEqual(["id", "site"]);
  });

  it("keeps a nested records block out of the table's columns", () => {
    const schema = parseDbml(
      "Table users {\n  id int [pk]\n  name varchar\n\n  records {\n    1, 'Ann'\n    2, 'a } b'\n  }\n}" +
        BROKEN_TAIL,
    );
    expect(schema.error).not.toBeNull();
    expect(schema.tables.map((table) => table.id)).toEqual(["users", "drafts"]);
    expect(schema.tables[0].fields.map((field) => field.name)).toEqual(["id", "name"]);
  });

  it("does not read a Records header as a column of an unclosed table above it", () => {
    const schema = parseDbml(
      "Table users {\n  id int [pk]\n  name varchar\n\nRecords users(id, name) {\n  1, 'Ann'\n}\n\nTable posts {\n  id int [pk]\n  user_id int [ref: > users.id]\n}\n",
    );
    expect(schema.error).not.toBeNull();
    const columns = schema.tables.flatMap((table) => table.fields.map((field) => field.name));
    expect(columns).not.toContain("Records");
    expect(schema.tables.map((table) => table.id)).toContain("posts");
  });

  it("treats a // inside a quoted string as text, not as a comment", () => {
    const schema = parseDbml(
      "Table links {\n  id int [pk]\n  url varchar [default: 'https://example.test']\n  kind varchar\n}" + BROKEN_TAIL,
    );
    const links = schema.tables[0];
    expect(links.fields.find((field) => field.name === "url")?.default).toBe("'https://example.test'");
    expect(links.fields.map((field) => field.name)).toEqual(["id", "url", "kind"]);
  });

  it("is still accepted whole by the real parser", () => {
    const schema = parseDbml(
      "Table users {\n  id int [pk]\n  name varchar\n}\n\nRecords users(id, name) {\n  1, 'Ann'\n}\n",
    );
    expect(schema.error).toBeNull();
    expect(schema.tables).toHaveLength(1);
  });
});
