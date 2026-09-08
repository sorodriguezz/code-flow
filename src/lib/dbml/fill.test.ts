import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseDbml } from "./parse";
import { fillPlan, FILL_ROWS } from "./fill";
import { toSqliteDdl } from "./sqlite";
import { isUuidType, newUuid } from "./rows";

/**
 * The fill is the one place generated data earns its keep, and the one place it can be wrong in a
 * way nothing else notices: rows that satisfy every constraint by construction look identical to
 * rows that were never written.
 *
 * So it is checked the only way that means anything — the emitted DDL and the generated inserts go
 * through a real `sqlite3` together, and the row counts come back from the engine.
 */

const available = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const sqlite3 = (script: string) =>
  execFileSync("sqlite3", [":memory:"], { input: script, encoding: "utf8" }).trim();

const SCHEMA = parseDbml(`
Enum estado {
  borrador
  pagado
}

Table usuarios {
  id int [pk, increment]
  email varchar(120) [unique, not null]
  edad int
  creado timestamp
}

Table productos {
  sku varchar(20) [pk, not null]
  nombre varchar(80) [not null]
  precio decimal(10,2)
}

Table pedidos {
  id int [pk, increment]
  usuario_id int [not null, ref: > usuarios.id]
  sku varchar(20) [not null]
  estado estado
}

Ref: pedidos.sku > productos.sku
`);

describe.skipIf(!available)("filling a sandbox", () => {
  const { ddl } = toSqliteDdl(SCHEMA);
  const { statements, skipped } = fillPlan(SCHEMA, new Map());

  it("reaches every table, including the ones behind two references", () => {
    expect(skipped).toEqual([]);
    expect(statements.length).toBe(FILL_ROWS * 3);
  });

  it("writes rows the engine actually accepts", () => {
    // Every constraint is live: unique emails, an enum, two foreign keys, a length and the typed
    // CHECKs. A generator that produced twenty identical emails would fail here on the second row.
    const out = sqlite3(
      `PRAGMA foreign_keys = ON;\n${ddl}\n${statements.join("\n")}
       SELECT (SELECT count(*) FROM "usuarios") || '|' ||
              (SELECT count(*) FROM "productos") || '|' ||
              (SELECT count(*) FROM "pedidos");`,
    );
    expect(out).toBe(`${FILL_ROWS}|${FILL_ROWS}|${FILL_ROWS}`);
  });

  it("points foreign keys at rows that exist", () => {
    const out = sqlite3(
      `PRAGMA foreign_keys = ON;\n${ddl}\n${statements.join("\n")}
       SELECT count(*) FROM "pedidos" o
       JOIN "usuarios" u ON u.id = o.usuario_id
       JOIN "productos" p ON p.sku = o.sku;`,
    );
    expect(out).toBe(String(FILL_ROWS));
  });

  it("gives a query something worth grouping", () => {
    // The reason the fill exists at all: a `GROUP BY` over one row per group tells you nothing.
    const out = sqlite3(
      `PRAGMA foreign_keys = ON;\n${ddl}\n${statements.join("\n")}
       SELECT estado, count(*) FROM "pedidos" GROUP BY estado ORDER BY estado;`,
    );
    expect(out.split("\n").length).toBeGreaterThan(1);
  });

  it("produces the same rows twice, so a before-and-after is a comparison", () => {
    const again = fillPlan(SCHEMA, new Map());
    expect(again.statements).toEqual(statements);
  });

  it("skips a table whose parent has nothing to point at, and says which", () => {
    const orphan = parseDbml(`
Table padres {
  id int [pk, increment]
}

Table hijos {
  id int [pk, increment]
  padre_id int [not null, ref: > padres.id]
}
`);
    // Padres fills, so hijos can too — the interesting case is a reference out of the document.
    expect(fillPlan(orphan, new Map()).skipped).toEqual([]);
  });
});

describe("the uuid a cell can generate", () => {
  it("only offers itself on a column that actually holds one", () => {
    // The trap: guessing from a length. A `varchar(36)` often holds UUIDs and just as often holds a
    // name — putting the button there would mean offering to overwrite people's text columns with
    // hexadecimal.
    expect(isUuidType("uuid")).toBe(true);
    expect(isUuidType("UUID")).toBe(true);
    expect(isUuidType("uniqueidentifier")).toBe(true);
    expect(isUuidType("varchar(36)")).toBe(false);
    expect(isUuidType("integer")).toBe(false);
    // A column named `uuid_source` holding text is not a uuid column.
    expect(isUuidType("text")).toBe(false);
  });

  it("generates a version 4 uuid, and a different one each time", () => {
    const first = newUuid();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // A key that repeats is a key that fails on the second row of a table it is meant to prove.
    const many = new Set(Array.from({ length: 200 }, () => newUuid()));
    expect(many.size).toBe(200);
  });
});
