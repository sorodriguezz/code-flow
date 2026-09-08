import { describe, expect, it } from "vitest";
import { EMPTY_SCHEMA, type DbmlField, type DbmlSchema, type DbmlTable } from "./types";
import { parseDbml } from "./parse";
import { fingerprint, orderTables, readFailure, toSqliteDdl } from "./sqlite";

/**
 * The emitter's contract, and the reason most of these assertions look oddly specific: every one of
 * them is a measured SQLite behaviour that is silent when you get it wrong. `INT PRIMARY KEY`
 * stores `null` instead of autonumbering; a `uuid` column turns `'0012'` into the integer 12; a
 * `DEFAULT (gen_random_uuid())` builds clean and then fails every insert. None of those produce an
 * error at build time, so none of them would be caught by "does the DDL run".
 *
 * `sqlite.engine.test.ts` runs the emitted DDL through a real `sqlite3` and is the other half of
 * this — these tests pin the *text*, that one proves the text works.
 *
 * The fixtures above are built by hand on purpose: they are about what a *field's flags* produce,
 * and spelling those out is clearer than a DBML document. Anything about how a *document is read* —
 * which end of a reference holds the key, what shape a default arrives in — goes through
 * `parseDbml` further down, because both of those were got wrong by fixtures that agreed with the
 * mistake.
 */

function field(name: string, type: string, extra: Partial<DbmlField> = {}): DbmlField {
  return {
    name,
    type,
    pk: false,
    notNull: false,
    unique: false,
    increment: false,
    default: null,
    note: "",
    ...extra,
  };
}

function table(id: string, fields: DbmlField[], indexes: DbmlTable["indexes"] = []): DbmlTable {
  return {
    id,
    schema: "public",
    name: id,
    alias: null,
    note: "",
    fields,
    indexes,
  };
}

function schemaOf(partial: Partial<DbmlSchema>): DbmlSchema {
  return { ...EMPTY_SCHEMA, ...partial };
}

describe("primary keys that are not integers", () => {
  it("emits the exact word INTEGER for a single-column integer key", () => {
    // `INT PRIMARY KEY` is not a rowid alias — only `INTEGER PRIMARY KEY` is — so an omitted id
    // would store null rather than autonumbering. DBML writes `int`.
    const { ddl } = toSqliteDdl(
      schemaOf({ tables: [table("t", [field("id", "int", { pk: true, increment: true })])] }),
    );
    expect(ddl).toContain('"id" INTEGER PRIMARY KEY');
    expect(ddl).not.toContain("AUTOINCREMENT");
  });

  it("leaves a text key alone and never calls it INTEGER", () => {
    const { ddl } = toSqliteDdl(
      schemaOf({ tables: [table("productos", [field("sku", "varchar(20)", { pk: true })])] }),
    );
    expect(ddl).toContain('"sku" VARCHAR(20) PRIMARY KEY');
  });

  it("forces TEXT affinity on a type SQLite does not know", () => {
    // Measured: `INSERT INTO t VALUES ('0012')` into a `uuid` column stores the integer 12. The
    // declared type survives as a comment so the DDL still reads like the model.
    const { ddl } = toSqliteDdl(
      schemaOf({ tables: [table("t", [field("id", "uuid", { pk: true })])] }),
    );
    expect(ddl).toContain('"id" TEXT /* uuid */ PRIMARY KEY');
  });

  it("warns rather than emitting AUTOINCREMENT on a key that cannot carry it", () => {
    const { warnings } = toSqliteDdl(
      schemaOf({
        tables: [table("t", [field("codigo", "varchar(8)", { pk: true, increment: true })])],
      }),
    );
    expect(warnings).toEqual([
      { table: "t", column: "codigo", code: "increment", detail: "varchar(8)" },
    ]);
  });

  it("reads a composite key off the index, where it is the only place it appears", () => {
    // The fields come back with pk/unique/notNull all false when a table declares a composite key.
    // Reading the fields alone produces a table with no key at all.
    const { ddl } = toSqliteDdl(
      schemaOf({
        tables: [
          table(
            "items",
            [field("pedido_id", "int"), field("linea", "int")],
            [{ columns: ["pedido_id", "linea"], unique: false, pk: true, name: "", type: "" }],
          ),
        ],
      }),
    );
    expect(ddl).toContain('PRIMARY KEY ("pedido_id", "linea")');
    // And no column claims the key on its own, or it would be declared twice.
    expect(ddl).not.toContain('"pedido_id" INTEGER PRIMARY KEY');
  });
});

describe("defaults", () => {
  it("translates the ones it knows", () => {
    const { ddl, warnings } = toSqliteDdl(
      schemaOf({
        tables: [
          table("t", [
            field("creado", "timestamp", { default: "now()" }),
            field("rol", "varchar", { default: "'user'" }),
            field("n", "int", { default: "0" }),
            field("activo", "boolean", { default: "true" }),
          ]),
        ],
      }),
    );
    expect(ddl).toContain("DEFAULT (CURRENT_TIMESTAMP)");
    expect(ddl).toContain("DEFAULT 'user'");
    expect(ddl).toContain("DEFAULT 0");
    expect(ddl).toContain("DEFAULT (1)");
    expect(warnings).toEqual([]);
  });

  it("replaces gen_random_uuid() with something SQLite can actually run", () => {
    // The trap this exists for: SQLite accepts an unknown function in a DEFAULT at CREATE time and
    // then fails *every* insert with `unknown function`. Building clean and rejecting all rows is
    // the worst of the available failures.
    const { ddl, warnings } = toSqliteDdl(
      schemaOf({
        tables: [table("t", [field("id", "uuid", { pk: true, default: "gen_random_uuid()" })])],
      }),
    );
    expect(ddl).toContain("randomblob(4)");
    expect(ddl).not.toContain("gen_random_uuid");
    expect(warnings).toEqual([]);
  });

  it("drops an expression it cannot translate, and says so", () => {
    const { ddl, warnings } = toSqliteDdl(
      schemaOf({ tables: [table("t", [field("n", "int", { default: "nextval('s')" })])] }),
    );
    expect(ddl).not.toContain("nextval");
    expect(warnings).toEqual([
      { table: "t", column: "n", code: "defaultDropped", detail: "nextval('s')" },
    ]);
  });
});

describe("checks", () => {
  it("names every check and records what it meant", () => {
    // The name cannot be taken apart afterwards — `_` is legal in identifiers — so the map is the
    // only way back from an engine error to a cell.
    const { ddl, constraints } = toSqliteDdl(
      schemaOf({
        enums: [
          {
            id: "rol",
            schema: "public",
            name: "rol",
            values: [
              { name: "admin", note: "" },
              { name: "user", note: "" },
            ],
          },
        ],
        tables: [
          table("usuarios", [
            field("edad", "int"),
            field("rol", "rol"),
            field("email", "varchar(120)"),
          ]),
        ],
      }),
    );
    expect(ddl).toContain("typeof(\"edad\") = 'integer'");
    expect(ddl).toContain("\"rol\" IN ('admin','user')");
    expect(ddl).toContain('length("email") <= 120');
    expect(constraints["ck_usuarios_edad_type"]).toEqual({
      table: "usuarios",
      column: "edad",
      rule: "type",
      detail: "integer",
    });
    expect(constraints["ck_usuarios_rol_enum"].detail).toBe("admin, user");
    expect(constraints["ck_usuarios_email_len"].detail).toBe("120");
  });

  it("leaves plain text columns unchecked", () => {
    // Affinity already keeps text as text, so there is nothing to test and nothing to say.
    const { ddl } = toSqliteDdl(
      schemaOf({ tables: [table("t", [field("nota", "text")])] }),
    );
    expect(ddl).not.toContain("CHECK");
  });
});

describe("references", () => {
  const usuarios = table("usuarios", [
    field("id", "int", { pk: true }),
    field("email", "varchar(120)"),
  ]);

  it("warns when the target is not unique, which SQLite only reports as a data error later", () => {
    const { warnings } = toSqliteDdl(
      schemaOf({
        tables: [usuarios, table("pedidos", [field("correo", "varchar(120)")])],
        refs: [
          {
            id: "r1",
            from: { table: "pedidos", fields: ["correo"], relation: "*" },
            to: { table: "usuarios", fields: ["email"], relation: "1" },
          },
        ],
      }),
    );
    expect(warnings).toEqual([
      {
        table: "pedidos",
        column: "correo",
        code: "refNotUnique",
        detail: "usuarios.email",
      },
    ]);
  });

  it("emits a composite reference with all of its columns at once", () => {
    // `fields[0]` alone would be a *different* constraint, which is worse than an absent one.
    const parent = table(
      "p",
      [field("a", "int"), field("b", "int")],
      [{ columns: ["a", "b"], unique: false, pk: true, name: "", type: "" }],
    );
    const { ddl, warnings } = toSqliteDdl(
      schemaOf({
        tables: [parent, table("c", [field("x", "int"), field("y", "int")])],
        refs: [
          {
            id: "r1",
            from: { table: "c", fields: ["x", "y"], relation: "*" },
            to: { table: "p", fields: ["a", "b"], relation: "1" },
          },
        ],
      }),
    );
    expect(ddl).toContain('FOREIGN KEY ("x", "y") REFERENCES "p" ("a", "b")');
    expect(warnings).toEqual([]);
  });

  it("refuses many-to-many rather than inventing a junction table", () => {
    const { ddl, warnings } = toSqliteDdl(
      schemaOf({
        tables: [usuarios, table("roles", [field("id", "int", { pk: true })])],
        refs: [
          {
            id: "r1",
            from: { table: "usuarios", fields: ["id"], relation: "*" },
            to: { table: "roles", fields: ["id"], relation: "*" },
          },
        ],
      }),
    );
    expect(ddl).not.toContain("FOREIGN KEY");
    expect(warnings[0].code).toBe("manyToMany");
  });
});

/**
 * The two bugs that hand-built fixtures could not see, pinned against the real parser.
 *
 * Both shipped past a green suite. A `DbmlRef` written by hand encodes its author's belief about
 * which end holds the key, and a `default` written by hand is missing the backticks the parser
 * actually attaches — so in both cases the test agreed with the mistake instead of catching it.
 * Anything about how a *document* is read belongs down here, on `parseDbml`.
 */
describe("what the parser actually hands over", () => {
  it("finds the foreign key on the child, whichever slot it landed in", () => {
    // Measured: for an inline `ref: >` the parser puts the **parent** in `from`, and for an
    // explicit `Ref:` it puts the child there. Emitting off `from` reverses the constraint on the
    // form most people write — a different constraint, which is worse than a missing one.
    const inline = toSqliteDdl(
      parseDbml("Table p {\n  id int [pk]\n}\n\nTable c {\n  pid int [ref: > p.id]\n}\n"),
    );
    const explicit = toSqliteDdl(
      parseDbml("Table p {\n  id int [pk]\n}\n\nTable c {\n  pid int\n}\n\nRef: c.pid > p.id\n"),
    );
    const wanted = 'FOREIGN KEY ("pid") REFERENCES "p" ("id")';
    expect(inline.ddl, "inline `ref: >`").toContain(wanted);
    expect(explicit.ddl, "explicit `Ref:`").toContain(wanted);
    // And never the other way round, which is what reading `from` as the child produced.
    expect(inline.ddl).not.toContain('REFERENCES "c"');
    expect(inline.warnings).toEqual([]);
  });

  it("reads `<` the same way, where the arrow is the thing that flipped", () => {
    const build = toSqliteDdl(
      parseDbml("Table p {\n  id int [pk]\n}\n\nTable c {\n  pid int\n}\n\nRef: p.id < c.pid\n"),
    );
    expect(build.ddl).toContain('FOREIGN KEY ("pid") REFERENCES "p" ("id")');
    expect(build.order).toEqual(["p", "c"]);
  });

  it("carries a default that arrived wrapped in backticks", () => {
    // `DbmlField.default` is documented as "as it should be re-emitted", and for `'user'` and `0`
    // it is — but DBML marks an *expression* with backticks and they come through attached. Looked
    // up with them on, every expression missed the shelf and was dropped, which is how a `uuid` key
    // with `gen_random_uuid()` ended up NULL on a row that should have filled itself.
    const build = toSqliteDdl(
      parseDbml(
        "Table t {\n  id uuid [pk, default: `gen_random_uuid()`]\n" +
          "  creado timestamp [default: `now()`]\n  rol varchar [default: 'user']\n" +
          "  n int [default: 0]\n}\n",
      ),
    );
    expect(build.warnings, "nothing on this shelf should be dropped").toEqual([]);
    expect(build.ddl).toContain("randomblob(4)");
    expect(build.ddl).toContain("DEFAULT (CURRENT_TIMESTAMP)");
    expect(build.ddl).toContain("DEFAULT 'user'");
    expect(build.ddl).toContain("DEFAULT 0");
  });

  it("still refuses an expression it genuinely cannot run", () => {
    const build = toSqliteDdl(parseDbml("Table t {\n  n int [default: `nextval('s')`]\n}\n"));
    expect(build.warnings).toEqual([
      { table: "t", column: "n", code: "defaultDropped", detail: "nextval('s')" },
    ]);
  });
});

describe("ordering", () => {
  it("puts parents before children", () => {
    const { order, cyclic } = orderTables(
      schemaOf({
        tables: [table("pedidos", []), table("usuarios", [])],
        refs: [
          {
            id: "r1",
            from: { table: "pedidos", fields: ["usuario_id"], relation: "*" },
            to: { table: "usuarios", fields: ["id"], relation: "1" },
          },
        ],
      }),
    );
    expect(order).toEqual(["usuarios", "pedidos"]);
    expect(cyclic).toEqual([]);
  });

  it("reports a cycle instead of pretending it has an order", () => {
    // `usuarios.org_id → orgs` with `orgs.owner_id → usuarios` is a real shape, and the rail's
    // promise — parents first — is unsatisfiable for it. Saying so is what lets the panel offer the
    // "ignore foreign keys" switch rather than leaving the user with an unexplained rejection.
    const { cyclic } = orderTables(
      schemaOf({
        tables: [table("usuarios", []), table("orgs", [])],
        refs: [
          {
            id: "r1",
            from: { table: "usuarios", fields: ["org_id"], relation: "*" },
            to: { table: "orgs", fields: ["id"], relation: "1" },
          },
          {
            id: "r2",
            from: { table: "orgs", fields: ["owner_id"], relation: "*" },
            to: { table: "usuarios", fields: ["id"], relation: "1" },
          },
        ],
      }),
    );
    expect(cyclic.sort()).toEqual(["orgs", "usuarios"]);
  });
});

describe("fingerprint", () => {
  it("ignores everything that cannot make a row invalid", () => {
    // Notes move constantly while a diagram is being drawn. A drift bar that appeared every time
    // somebody typed a comment is a drift bar people learn to dismiss.
    const base = schemaOf({ tables: [table("t", [field("a", "int")])] });
    const noted = schemaOf({
      tables: [{ ...table("t", [field("a", "int", { note: "hola" })]), note: "una tabla" }],
    });
    expect(fingerprint(base)).toBe(fingerprint(noted));
  });

  it("moves when a constraint does", () => {
    const before = schemaOf({ tables: [table("t", [field("a", "int")])] });
    const after = schemaOf({ tables: [table("t", [field("a", "int", { notNull: true })])] });
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });
});

describe("reading the engine back", () => {
  const notes = {
    ck_usuarios_edad_type: {
      table: "usuarios",
      column: "edad",
      rule: "type" as const,
      detail: "integer",
    },
  };

  it("uses the map rather than splitting the constraint name", () => {
    const failure = readFailure(
      "CHECK constraint failed: ck_usuarios_edad_type",
      notes,
    );
    expect(failure).toEqual({
      table: "usuarios",
      column: "edad",
      code: "type",
      detail: "integer",
    });
  });

  it("survives a schema-qualified NOT NULL path", () => {
    // Measured with a schema: `NOT NULL constraint failed: core.usuarios.email`. Splitting on the
    // first dot would call the table `core`.
    expect(readFailure("NOT NULL constraint failed: core.usuarios.email", {})).toEqual({
      table: "core.usuarios",
      column: "email",
      code: "notNull",
      detail: "",
    });
  });

  it("keeps every column of a composite unique index", () => {
    const failure = readFailure("UNIQUE constraint failed: t.a, t.b", {});
    expect(failure.code).toBe("unique");
    expect(failure.column).toBe("a");
    expect(failure.detail).toBe("t.a, t.b");
  });

  it("does not pretend a foreign key error names a column", () => {
    // Measured: SQLite returns exactly `FOREIGN KEY constraint failed`, with no table, column or
    // value. Naming the offending column is the caller's job — it probes the parents first.
    expect(readFailure("FOREIGN KEY constraint failed", {})).toEqual({
      table: null,
      column: null,
      code: "foreignKey",
      detail: "",
    });
  });
});
