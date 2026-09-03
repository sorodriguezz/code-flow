import { Parser } from "@dbml/core";
import { describe, expect, it } from "vitest";
import {
  addEnum,
  addField,
  addRef,
  addTable,
  dropField,
  dropRef,
  dropTable,
  renameTable,
  setRefCardinality,
  setTableNote,
  updateField,
} from "./edit";

/**
 * Every operation's output, put through the real parser.
 *
 * `edit.test.ts` asserts what the text looks like. That is necessary and it is not sufficient: it
 * cannot tell you whether the text it produced is *legal DBML*, and a button that emits plausible
 * text the parser rejects is worse than one that does nothing — the canvas goes blank on what
 * looked like a successful edit.
 *
 * This suite caught exactly that. `setTableNote` inserted the note as the first line of the table
 * body, which reads perfectly and does not parse: `@dbml/core` accepts `note:` inside a table only
 * after every column has been declared, because until then it reads `note` as a column name and
 * wants a type after it (`Expected " " but ":" found`). Both string-level suites were green.
 *
 * So this is the one place `@dbml/core` is imported outside `parse.ts`. That is deliberate and it is
 * safe: the 15 MB rule in `parse.ts` is about the *startup bundle*, and a test file is not in it.
 */

/** Throws with the offending document attached, which is the only useful failure message here. */
function expectParses(source: string, what: string) {
  try {
    Parser.parse(source, "dbml");
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
    expect.fail(`${what} produced DBML that does not parse (${detail})\n---\n${source}---`);
  }
}

const DOC = `Table authors {
  id    integer      [pk, increment]
  email varchar(160) [not null, unique]

  indexes {
    (email) [unique]
  }
}

Table posts {
  id        integer [pk, increment]
  author_id integer [not null]
}

Enum status {
  draft
  live
}

Ref: posts.author_id > authors.id
`;

it("the fixture itself is valid", () => {
  expectParses(DOC, "the fixture");
});

describe("table notes land where the parser accepts them", () => {
  // The regression this file was written for.
  it("adds a note to a table that has none", () => {
    expectParses(setTableNote(DOC, "posts", "para nada"), "setTableNote (new)");
  });

  it("adds a note to a table that has an indexes block", () => {
    expectParses(setTableNote(DOC, "authors", "con indices"), "setTableNote (with indexes)");
  });

  it("replaces an existing note", () => {
    const once = setTableNote(DOC, "posts", "vieja");
    expectParses(setTableNote(once, "posts", "nueva"), "setTableNote (replace)");
  });

  it("clears a note", () => {
    const once = setTableNote(DOC, "posts", "vieja");
    expectParses(setTableNote(once, "posts", ""), "setTableNote (clear)");
  });

  it("writes a multi-line note as a block", () => {
    expectParses(setTableNote(DOC, "posts", "linea uno\nlinea dos"), "setTableNote (multi-line)");
  });

  it("survives a note holding a quote", () => {
    expectParses(setTableNote(DOC, "posts", "it's fine"), "setTableNote (apostrophe)");
  });
});

describe("column edits stay legal", () => {
  it("adds a plain column", () => {
    expectParses(addField(DOC, "posts", { name: "body", type: "text" }), "addField");
  });

  it("adds a column carrying every setting at once", () => {
    expectParses(
      addField(DOC, "posts", {
        name: "slug",
        type: "varchar(80)",
        unique: true,
        notNull: true,
        default: "'x'",
        note: "it's unique",
      }),
      "addField (all settings)",
    );
  });

  // A column with no type is not legal DBML at all — the parser reads the *next* line's first word
  // as this column's type and unravels from there. So rather than emit it, the operation declines,
  // and the form refuses to submit. This suite is what established that: the form used to allow an
  // empty type and both string-level suites were green on the result.
  it("declines to add a column with no type", () => {
    expect(addField(DOC, "posts", { name: "untyped", type: "" })).toBe(DOC);
    expect(addField(DOC, "posts", { name: "untyped", type: "   " })).toBe(DOC);
  });

  it("declines to update a column to no type", () => {
    expect(updateField(DOC, "posts", "author_id", { name: "author_id", type: "" })).toBe(DOC);
  });

  it("adds a column whose name needs quoting", () => {
    expectParses(addField(DOC, "posts", { name: "my column", type: "int" }), "addField (quoted)");
  });

  it("updates one", () => {
    expectParses(
      updateField(DOC, "posts", "author_id", { name: "author_id", type: "bigint", notNull: true }),
      "updateField",
    );
  });

  it("renames one and the ref that names it", () => {
    expectParses(
      updateField(DOC, "authors", "id", { name: "uid", type: "integer", pk: true }),
      "updateField (rename)",
    );
  });

  it("drops one along with its refs", () => {
    expectParses(dropField(DOC, "authors", "id"), "dropField");
  });

  /**
   * Editing a column must not delete the settings the edit did not mention.
   *
   * `updateField` replaces the whole line, so what it is handed is the entire truth about that
   * column — anything the caller forgot to include is silently dropped. The inspector's form left
   * `increment` out of the object it built from the row, so opening `id integer [pk, increment]`,
   * changing nothing and pressing save quietly demoted it to `[pk]`.
   */
  it("keeps every setting when a column is rewritten unchanged", () => {
    const same = updateField(DOC, "authors", "id", {
      name: "id",
      type: "integer",
      pk: true,
      increment: true,
    });
    expect(same).toContain("[pk, increment]");
    expectParses(same, "updateField (unchanged)");

    const documented = updateField(DOC, "authors", "email", {
      name: "email",
      type: "varchar(160)",
      unique: true,
      notNull: true,
      note: "el correo",
      default: "'x'",
    });
    expect(documented).toContain("unique");
    expect(documented).toContain("not null");
    expect(documented).toContain("default: 'x'");
    expect(documented).toContain("note: 'el correo'");
    expectParses(documented, "updateField (every setting)");
  });
});

describe("table and enum edits stay legal", () => {
  it("adds a table", () => {
    expectParses(addTable(DOC, "comments"), "addTable");
  });

  it("adds a table whose name needs quoting", () => {
    expectParses(addTable(DOC, "order items"), "addTable (quoted)");
  });

  it("renames a table and rewrites its refs", () => {
    expectParses(renameTable(DOC, "authors", "writers"), "renameTable");
  });

  it("drops a table and every ref touching it", () => {
    expectParses(dropTable(DOC, "authors"), "dropTable");
  });

  it("adds an enum", () => {
    expectParses(addEnum(DOC, "visibility", ["public", "private"]), "addEnum");
  });

  it("adds an enum with no values given", () => {
    expectParses(addEnum(DOC, "visibility"), "addEnum (default value)");
  });
});

describe("relationship edits stay legal", () => {
  it.each(["<", ">", "-", "<>"] as const)("adds a %s relationship", (cardinality) => {
    expectParses(
      addRef(DOC, { table: "posts", column: "id" }, { table: "authors", column: "id" }, cardinality),
      `addRef (${cardinality})`,
    );
  });

  it("drops one", () => {
    expectParses(
      dropRef(DOC, { table: "posts", column: "author_id" }, { table: "authors", column: "id" }),
      "dropRef",
    );
  });

  it.each(["<", ">", "-", "<>"] as const)("flips one to %s", (cardinality) => {
    expectParses(
      setRefCardinality(
        DOC,
        { table: "posts", column: "author_id" },
        { table: "authors", column: "id" },
        cardinality,
      ),
      `setRefCardinality (${cardinality})`,
    );
  });
});

/**
 * A run of edits, each applied to the output of the last.
 *
 * Every test above starts from a clean fixture, which is not how the feature is used: a session is
 * a dozen clicks in a row, and an operation that is legal once can still leave the document in a
 * state the next one mishandles.
 */
it("survives a session's worth of edits in sequence", () => {
  let doc = DOC;
  const steps: [string, () => string][] = [
    ["addTable", () => addTable(doc, "comments")],
    ["addField", () => addField(doc, "comments", { name: "body", type: "text", notNull: true })],
    ["addField", () => addField(doc, "comments", { name: "post_id", type: "integer" })],
    [
      "addRef",
      () => addRef(doc, { table: "comments", column: "post_id" }, { table: "posts", column: "id" }, ">"),
    ],
    ["setTableNote", () => setTableNote(doc, "comments", "Comentarios de un post")],
    ["updateField", () => updateField(doc, "comments", "body", { name: "body", type: "varchar(500)" })],
    ["setTableNote", () => setTableNote(doc, "comments", "Actualizada")],
    ["renameTable", () => renameTable(doc, "comments", "post_comments")],
    ["addEnum", () => addEnum(doc, "visibility", ["public", "private"])],
    ["dropField", () => dropField(doc, "post_comments", "body")],
  ];

  for (const [name, step] of steps) {
    doc = step();
    expectParses(doc, `after ${name}`);
  }

  // And the thing all of it was for: the schema still says what the edits asked for.
  const parsed = Parser.parse(doc, "dbml") as {
    schemas?: { tables?: { name: string; note?: string }[] }[];
  };
  const tables = parsed.schemas?.[0]?.tables ?? [];
  expect(tables.map((table) => table.name)).toContain("post_comments");
  expect(tables.find((table) => table.name === "post_comments")?.note).toBe("Actualizada");
});

/**
 * The same schema with its relationships written as column settings instead of `Ref:` blocks.
 *
 * DBML has two ways to say a join and both are idiomatic — the AI panel emits this one. Every
 * operation used to see only the block form, because that is what `blocksOf` returns; an inline
 * `ref:` is three words inside a column line, not a block. So dropping a table left inline refs
 * pointing at something that no longer existed, and an orphan `ref:` does not make a messy schema,
 * it makes one that will not parse — the canvas goes blank on a delete that looked like it worked.
 *
 * Every test here failed before inline refs were handled.
 */
const INLINE = `Table usuarios {
  id integer [pk, increment]
  nombre varchar(50) [not null]
}

Table historias {
  id integer [pk]
  usuario_id integer [not null, ref: > usuarios.id]
}

Table me_gusta {
  id integer [pk]
  usuario_id integer [ref: > usuarios.id]
}
`;

describe("relationships written as column settings", () => {
  it("the fixture is valid", () => {
    expectParses(INLINE, "the inline fixture");
  });

  it("dropping the table they point at strips them", () => {
    const got = dropTable(INLINE, "usuarios");
    expect(got).not.toMatch(/ref:\s*[<>-]+\s*usuarios/i);
    expectParses(got, "dropTable (inline refs)");
  });

  it("dropping the column they point at strips them", () => {
    const got = dropField(INLINE, "usuarios", "id");
    expect(got).not.toMatch(/ref:\s*[<>-]+\s*usuarios\.id/i);
    expectParses(got, "dropField (inline refs)");
  });

  it("renaming the table rewrites them", () => {
    const got = renameTable(INLINE, "usuarios", "users");
    expect(got).toContain("ref: > users.id");
    expect(got).not.toMatch(/ref:\s*[<>-]+\s*usuarios\./i);
    expectParses(got, "renameTable (inline refs)");
  });

  it("renaming the column they point at rewrites them", () => {
    const got = updateField(INLINE, "usuarios", "id", { name: "uid", type: "integer", pk: true });
    expect(got).toContain("ref: > usuarios.uid");
    expectParses(got, "updateField (inline refs)");
  });

  // The setting is removed from the settings list, not the whole line.
  it("keeps a column's other settings when its ref is stripped", () => {
    const got = dropTable(INLINE, "usuarios");
    expect(got).toContain("usuario_id integer [not null]");
    // And a column left with no settings loses its brackets rather than keeping an empty pair.
    expect(got).toContain("usuario_id integer\n");
    expect(got).not.toContain("[]");
  });

  it("deletes one directly", () => {
    const got = dropRef(
      INLINE,
      { table: "historias", column: "usuario_id" },
      { table: "usuarios", column: "id" },
    );
    expect(got).toContain("usuario_id integer [not null]");
    // Only that one: the other table's ref is a different relationship.
    expect(got).toContain("ref: > usuarios.id");
    expectParses(got, "dropRef (inline)");
  });

  it("flips one in place", () => {
    const got = setRefCardinality(
      INLINE,
      { table: "historias", column: "usuario_id" },
      { table: "usuarios", column: "id" },
      "<",
    );
    expect(got).toContain("ref: < usuarios.id");
    expectParses(got, "setRefCardinality (inline)");
  });

  // Declaring the same join twice is rejected by DBML, so an inline one must block a block one.
  it("is not declared a second time as a Ref block", () => {
    const got = addRef(
      INLINE,
      { table: "historias", column: "usuario_id" },
      { table: "usuarios", column: "id" },
      ">",
    );
    expect(got).toBe(INLINE);
  });

  it("survives a run of edits", () => {
    let doc = INLINE;
    doc = addField(doc, "usuarios", { name: "email", type: "varchar(120)", unique: true });
    expectParses(doc, "inline: addField");
    doc = renameTable(doc, "usuarios", "users");
    expectParses(doc, "inline: renameTable");
    doc = setTableNote(doc, "users", "Los usuarios");
    expectParses(doc, "inline: setTableNote");
    doc = dropTable(doc, "users");
    expectParses(doc, "inline: dropTable");
    expect(doc).not.toMatch(/ref:/i);
  });
});

/**
 * The shapes a relationship can take that the rewriting engine used to be blind to.
 *
 * Each of these is legal in the dialect this app parses with (`Parser.parse(source, "dbml")`, see
 * `parse.ts`) and each one used to make `refEndsOf` answer `null`, so `mapRefs` and `filterRefs`
 * skipped the block entirely and `renameTable`/`dropTable` left an endpoint naming something that
 * no longer existed. That does not produce an untidy schema — `@dbml/core` rejects it outright — so
 * the canvas blanked on an edit that looked like it had worked, and with the document no longer
 * parsing every visual control went inert behind `editing.blocked`. String assertions cannot catch
 * any of this, which is the whole reason this suite exists.
 *
 * Watch the dialect when adding a fixture here. `TableGroup` settings and a group `Note:` are v2
 * only and are rejected by the v1 parser this app uses, as is a `Ref:` whose endpoints sit on the
 * next line — `edit.ts` handles all three defensively, but they cannot be asserted through
 * `expectParses`.
 */
const BRACED = `Table usuarios {
  id integer [pk]
}

Table historias {
  usuario_id integer
}

Ref {
  historias.usuario_id > usuarios.id
}
`;

const COMPOSITE = `Table usuarios {
  tenant integer
  id     integer
}

Table historias {
  tenant     integer
  usuario_id integer
}

Ref: historias.(tenant, usuario_id) > usuarios.(tenant, id)
`;

const GROUPED = `Table usuarios {
  id integer [pk]
}

Table historias {
  id integer [pk]
}

TableGroup nucleo {
  usuarios
  historias
}
`;

describe("every shape a relationship can be written in", () => {
  const fixtures = [
    ["a braced Ref block", BRACED],
    ["a composite Ref", COMPOSITE],
    ["a TableGroup member", GROUPED],
  ] as const;

  for (const [what, doc] of fixtures) {
    it(`${what}: the fixture is valid`, () => {
      expectParses(doc, what);
    });

    it(`${what}: survives a rename`, () => {
      const got = renameTable(doc, "usuarios", "clientes");
      expect(got).not.toBe(doc);
      expect(got).not.toMatch(/\busuarios\b/);
      expectParses(got, `renameTable (${what})`);
    });

    it(`${what}: survives a drop`, () => {
      const got = dropTable(doc, "usuarios");
      expect(got).not.toContain("Table usuarios");
      expectParses(got, `dropTable (${what})`);
    });
  }

  // A group whose last member goes is legal, and emptying it is the right answer: the alternative
  // is deciding on the user's behalf that the group should go too.
  it("empties a TableGroup rather than leaving a member that is gone", () => {
    let doc = dropTable(GROUPED, "usuarios");
    doc = dropTable(doc, "historias");
    expect(doc).toContain("TableGroup nucleo");
    expect(doc).not.toMatch(/^\s+usuarios\s*$/m);
    expectParses(doc, "dropTable (last group member)");
  });

  // The one that reads as a dead button rather than as a corruption, and so went unreported.
  it("deletes a composite relationship instead of silently keeping it", () => {
    const got = dropRef(
      COMPOSITE,
      { table: "historias", column: "tenant" },
      { table: "usuarios", column: "tenant" },
    );
    expect(got).not.toMatch(/^Ref:/m);
    expectParses(got, "dropRef (composite)");
  });
});

/**
 * A rename onto a name that is already spoken for.
 *
 * The report was "renaming created another table and everything broke", and this is exactly that:
 * `renameTable` wrote the new name into the declaration without checking, leaving the document with
 * two blocks of one name. The enum case is the one most worth a test, because it is the variant the
 * parser does *not* catch — two boxes end up sharing a node id with no error anywhere. See
 * `nameIsTaken`.
 */
describe("a rename declines a name that is taken", () => {
  const TAKEN = `Table usuarios {
  id integer [pk]
}

Table historias {
  id integer [pk]
}

Enum estado {
  borrador
  publicado
}

Table clientes as c {
  id integer [pk]
}
`;

  it("the fixture is valid", () => {
    expectParses(TAKEN, "the taken fixture");
  });

  for (const [what, to] of [
    ["another table", "historias"],
    ["an enum", "estado"],
    ["another table's alias", "c"],
    ["the same name in another case", "HISTORIAS"],
  ] as const) {
    it(`refuses ${what}, byte for byte`, () => {
      // Identity, not merely "still parses": a refused edit has to leave the document alone, or
      // `applyEdit`'s `next === source` guard misses and Monaco takes an undo entry for a change
      // nobody made.
      expect(renameTable(TAKEN, "usuarios", to)).toBe(TAKEN);
    });
  }

  it("still allows a block to be re-cased", () => {
    const got = renameTable(TAKEN, "usuarios", "Usuarios");
    expect(got).toContain("Table Usuarios {");
    expectParses(got, "renameTable (re-case)");
  });

  it("still allows an ordinary rename", () => {
    const got = renameTable(TAKEN, "usuarios", "clientes_finales");
    expect(got).toContain("Table clientes_finales {");
    expectParses(got, "renameTable (free name)");
  });
});

/**
 * Renaming an enum, which is the quiet one.
 *
 * DBML takes any bare word as a column type, so an enum renamed without this leaves every column
 * that used it reading `state estado` — legal, parseable, and no longer an enum reference. Nothing
 * errors and nothing is disabled; the badge and the enum box's link just stop matching, and the
 * schema is wrong in a way only a person notices.
 */
describe("renaming an enum carries the columns typed with it", () => {
  const ENUMS = `Enum estado {
  borrador
  publicado
}

Table posts {
  id           integer     [pk, increment]
  state        estado      [not null]
  title        varchar(200)
  estado_note  text

  indexes {
    (state) [name: 'estado']
  }
  note: 'menciona estado en prosa'
}
`;

  it("the fixture is valid", () => {
    expectParses(ENUMS, "the enum fixture");
  });

  it("rewrites the column's type", () => {
    const got = renameTable(ENUMS, "estado", "situacion");
    expect(got).toContain("Enum situacion {");
    // The trailing run of spaces is the one the author wrote, not a re-alignment: `edit.ts` copies
    // every byte it did not have to change, and re-flowing the column would be the Format button's
    // job rather than a rename's.
    expect(got).toContain("state        situacion      [not null]");
    expectParses(got, "renameTable (enum)");
  });

  it("touches nothing else that happens to say the same word", () => {
    const got = renameTable(ENUMS, "estado", "situacion");
    // A column *named* after it, a parametrised type, an index name and prose in a note are all
    // words that are not the type token of a column line.
    expect(got).toContain("estado_note  text");
    expect(got).toContain("varchar(200)");
    expect(got).toContain("(state) [name: 'estado']");
    expect(got).toContain("note: 'menciona estado en prosa'");
  });
});

/**
 * The four shapes an adversarial pass found after the first round of fixes.
 *
 * Each one was produced by a change that was *itself* a fix — which is the argument for this suite:
 * the first three do not merely look wrong, they emit DBML the parser rejects, and the fourth
 * rewrites prose in the middle of a sentence while still parsing perfectly.
 */
const NOTE_FENCE = "'".repeat(3);

describe("shapes that broke the first round of fixes", () => {
  // The block-splitter used to stop on the arrow, which for this shape is one line short of the
  // closing brace — so a delete spliced half the block and left the `}` behind.
  const BRACE_ON_ITS_OWN_LINE = `Table usuarios {
  id integer [pk]
}

Table historias {
  usuario_id integer
}

Ref
{
  historias.usuario_id > usuarios.id
}
`;

  // And a blank line inside a braced body used to end the block for the same reason.
  const BLANK_INSIDE = `Table usuarios {
  id integer [pk]
}

Table historias {
  usuario_id integer
}

Ref {

  historias.usuario_id > usuarios.id
}
`;

  for (const [what, doc] of [
    ["a Ref whose brace is on its own line", BRACE_ON_ITS_OWN_LINE],
    ["a Ref with a blank line in its body", BLANK_INSIDE],
  ] as const) {
    it(`${what}: the fixture is valid`, () => {
      expectParses(doc, what);
    });

    it(`${what}: deleting the relationship leaves no orphan brace`, () => {
      const got = dropRef(
        doc,
        { table: "historias", column: "usuario_id" },
        { table: "usuarios", column: "id" },
      );
      // Parsing is the assertion that matters — an orphan `}` is a syntax error, and the tables'
      // own closing braces make a "no lone brace" regex meaningless.
      expect(got).not.toMatch(/\bRef\b/i);
      expectParses(got, `dropRef (${what})`);
    });

    it(`${what}: dropping a table takes the whole block`, () => {
      const got = dropTable(doc, "usuarios");
      expect(got).not.toContain("usuarios");
      expectParses(got, `dropTable (${what})`);
    });
  }

  // Group members resolve in the schema they name, so matching on the bare half rewrote the
  // namesake in another schema as well — two group lines with one name, which DBML rejects.
  const TWO_SCHEMAS = `Table core.users {
  id integer [pk]
}

Table users {
  id integer [pk]
}

TableGroup g {
  core.users
  users
}
`;

  it("a cross-schema namesake is a different table", () => {
    expectParses(TWO_SCHEMAS, "the two-schema fixture");

    const renamed = renameTable(TWO_SCHEMAS, "users", "clientes");
    expect(renamed).toContain("  core.users\n  clientes\n");
    expectParses(renamed, "renameTable (public half of a namesake pair)");

    const qualified = renameTable(TWO_SCHEMAS, "core.users", "core.clientes");
    expect(qualified).toContain("  core.clientes\n  users\n");
    expectParses(qualified, "renameTable (qualified half of a namesake pair)");

    const dropped = dropTable(TWO_SCHEMAS, "users");
    expect(dropped).toContain("  core.users\n");
    expect(dropped).not.toMatch(/^\s+users\s*$/m);
    expectParses(dropped, "dropTable (public half of a namesake pair)");
  });

  // The enum pass walks column lines, and a multi-line note's body carries no braces — so every
  // line of the prose reached the column regex, where "el estado del pedido" read as a column `el`
  // of type `estado`. It parses either way; that is what makes it worth a test.
  const PROSE = `Enum estado {
  borrador
  publicado
}

Table posts {
  id    integer [pk]
  state estado
  note: ${NOTE_FENCE}
  el estado del pedido
  otra linea estado aqui
  ${NOTE_FENCE}
}
`;

  it("leaves a multi-line note's prose alone", () => {
    expectParses(PROSE, "the prose fixture");
    const got = renameTable(PROSE, "estado", "situacion");
    expect(got).toContain("state situacion");
    expect(got).toContain("el estado del pedido");
    expect(got).toContain("otra linea estado aqui");
    expectParses(got, "renameTable (enum with a prose note)");
  });

  it("finds a column typed with a schema-qualified enum", () => {
    const doc = `Enum core.estado {
  borrador
  publicado
}

Table posts {
  id    integer [pk]
  state core.estado
}
`;
    expectParses(doc, "the qualified-enum fixture");
    const got = renameTable(doc, "core.estado", "core.situacion");
    expect(got).toContain("Enum core.situacion {");
    expect(got).toContain("state core.situacion");
    expectParses(got, "renameTable (qualified enum)");
  });
});
