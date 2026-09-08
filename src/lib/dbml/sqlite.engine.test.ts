import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseDbml } from "./parse";
import { toSqliteDdl } from "./sqlite";

/**
 * The other half of `sqlite.test.ts`: that one pins the emitted *text*, this one proves the text
 * works by handing it to a real SQLite and inserting rows.
 *
 * It exists because every assertion in the sibling file is a claim about an engine, and a claim
 * about an engine that is only ever checked against a string is a claim about a string. The three
 * behaviours the emitter is built around — `INT` not autonumbering, `uuid` eating `'0012'`, an
 * unknown `DEFAULT` function building clean and then failing every insert — are all invisible until
 * something actually runs.
 *
 * Skipped when `sqlite3` is not on the path. `vitest` is not in CI (only `check-translations` and
 * `tsc` are), so this is a local guard rather than a gate, and a developer without the binary
 * should not see a red suite.
 */

function sqlite3(script: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    input: script,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const available = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The fixture goes through the **real parser**, not through hand-built objects.
 *
 * That is not a stylistic preference — it is the lesson from the bug this file did not catch. A
 * hand-written `DbmlRef` encodes whoever wrote it's belief about which end holds the foreign key,
 * and that belief was wrong: for an inline `ref: > usuarios.id`, this repository's parser puts the
 * **parent** in `from`. Every assertion here passed against fixtures that agreed with the mistake.
 * Parsing real DBML is the only way the test and the product read the same thing.
 *
 * The three reference forms are all present on purpose: inline `>` (the common one, and the
 * reversed one), an explicit `Ref:`, and a composite key.
 */
const REALISTIC = parseDbml(`
Enum estado {
  borrador
  pagado
}

Table usuarios {
  id int [pk, increment, not null]
  email varchar(120) [unique, not null]
  edad int
  creado timestamp [default: \`now()\`]
}

Table productos {
  sku varchar(20) [pk, not null]
  nombre varchar(80) [not null]
}

Table pedidos {
  id uuid [pk, default: \`gen_random_uuid()\`]
  usuario_id int [not null, ref: > usuarios.id]
  sku varchar(20) [not null]
  total decimal(10,2)
  estado estado [default: 'borrador']
}

Ref: pedidos.sku > productos.sku
`);

const HEAD = "PRAGMA foreign_keys = ON;\n";

describe.skipIf(!available)("the emitted DDL against a real SQLite", () => {
  const { ddl, warnings } = toSqliteDdl(REALISTIC);

  it("builds without a warning and without an error", () => {
    expect(warnings).toEqual([]);
    expect(sqlite3(`${HEAD}${ddl}\nSELECT 'ok';`)).toBe("ok");
  });

  it("autonumbers the integer key, which `INT PRIMARY KEY` would not", () => {
    const out = sqlite3(
      `${HEAD}${ddl}
       INSERT INTO "usuarios" (email) VALUES ('ana@x.test');
       SELECT id, typeof(id) FROM "usuarios";`,
    );
    expect(out).toBe("1|integer");
  });

  it("keeps a text key that looks like a number as text", () => {
    // The whole reason `TEXT /* uuid */` exists. Under the declared type this row would come back
    // as the integer 12.
    const out = sqlite3(
      `${HEAD}${ddl}
       INSERT INTO "productos" (sku, nombre) VALUES ('0012', 'Cable');
       SELECT typeof(sku), quote(sku) FROM "productos";`,
    );
    expect(out).toBe("text|'0012'");
  });

  it("fills a uuid key from a default that SQLite can actually evaluate", () => {
    const out = sqlite3(
      `${HEAD}${ddl}
       INSERT INTO "usuarios" (email) VALUES ('ana@x.test');
       INSERT INTO "productos" (sku, nombre) VALUES ('TEC-01', 'Teclado');
       INSERT INTO "pedidos" (usuario_id, sku) VALUES (1, 'TEC-01');
       SELECT length(id), typeof(id), estado FROM "pedidos";`,
    );
    expect(out).toBe("36|text|borrador");
  });

  it("rejects the things the model said to reject", () => {
    const rows = [
      ["INSERT INTO \"usuarios\" (email) VALUES ('ana@x.test');", "UNIQUE"],
      ["INSERT INTO \"usuarios\" (email, edad) VALUES ('z@x.test', 'abc');", "ck_usuarios_edad_type"],
      ["INSERT INTO \"usuarios\" (email) VALUES (NULL);", "NOT NULL"],
      [
        "INSERT INTO \"pedidos\" (usuario_id, sku) VALUES (99, 'TEC-01');",
        "FOREIGN KEY constraint failed",
      ],
      [
        "INSERT INTO \"pedidos\" (usuario_id, sku, estado) VALUES (1, 'TEC-01', 'raro');",
        "ck_pedidos_estado_enum",
      ],
      [
        `INSERT INTO "productos" (sku, nombre) VALUES ('${"x".repeat(30)}', 'Largo');`,
        "ck_productos_sku_len",
      ],
    ];
    const seed = `${HEAD}${ddl}
       INSERT INTO "usuarios" (email) VALUES ('ana@x.test');
       INSERT INTO "productos" (sku, nombre) VALUES ('TEC-01', 'Teclado');\n`;
    for (const [statement, expected] of rows) {
      let error = "";
      try {
        // `-bail` is not passed, so sqlite3 prints the error to stderr and exits non-zero.
        sqlite3(seed + statement);
      } catch (thrown) {
        error = String((thrown as { stderr?: Buffer }).stderr ?? thrown);
      }
      expect(error, `expected ${statement} to be refused`).toContain(expected);
    }
  });

  it("accepts a valid row through every constraint at once", () => {
    const out = sqlite3(
      `${HEAD}${ddl}
       INSERT INTO "usuarios" (email, edad) VALUES ('ana@x.test', 34);
       INSERT INTO "productos" (sku, nombre) VALUES ('TEC-01', 'Teclado');
       INSERT INTO "pedidos" (usuario_id, sku, total, estado) VALUES (1, 'TEC-01', 49.9, 'pagado');
       SELECT u.email, p.nombre, o.total, o.estado
       FROM "pedidos" o
       JOIN "usuarios" u ON u.id = o.usuario_id
       JOIN "productos" p ON p.sku = o.sku;`,
    );
    expect(out).toBe("ana@x.test|Teclado|49.9|pagado");
  });

  it("reports an unsatisfiable reference from the schema alone, with no rows in it", () => {
    // The build button's whole justification: a reference into a non-unique column is a
    // `foreign key mismatch`, and it is knowable before a single row exists.
    const broken = toSqliteDdl(
      parseDbml(`
Table usuarios {
  id int [pk]
  email varchar(120)
}

Table pedidos {
  correo varchar(120) [ref: > usuarios.email]
}
`),
    );
    expect(broken.warnings[0].code).toBe("refNotUnique");
    let error = "";
    try {
      sqlite3(`${HEAD}${broken.ddl}\nPRAGMA foreign_key_check;`);
    } catch (thrown) {
      error = String((thrown as { stderr?: Buffer }).stderr ?? thrown);
    }
    expect(error).toContain("foreign key mismatch");
  });

  it("builds a composite key and the composite reference into it", () => {
    const composite = toSqliteDdl(
      parseDbml(`
Table p {
  a int
  b int

  indexes {
    (a, b) [pk]
  }
}

Table c {
  x int
  y int
}

Ref: c.(x, y) > p.(a, b)
`),
    );
    const out = sqlite3(
      `${HEAD}${composite.ddl}
       INSERT INTO "p" VALUES (1, 2);
       INSERT INTO "c" VALUES (1, 2);
       SELECT count(*) FROM "c";`,
    );
    expect(out).toBe("1");
  });
});
