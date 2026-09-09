import { describe, expect, it } from "vitest";
import {
  AI_FILL_BATCH,
  batchTables,
  emptyPlan,
  keyHint,
  mergePlans,
  parseAiRows,
  planAiFill,
  schemaOutline,
  type AiRowsAnswer,
} from "./aiFill";
import { parseDbml } from "./parse";

/**
 * What the schema does to an answer a model gave.
 *
 * The feature is "rows that mean something", and the risk is the other half of that sentence: an
 * answer that reads perfectly and does not fit the database. Every test below is a shape a model
 * actually produces — a customer that was never written, an id used twice, an enum value invented
 * on the spot, a number spelled as a word — and what is asserted is that it is *dropped and
 * counted* rather than sent to SQLite to fail, or quietly repaired into something nobody wrote.
 */
const SCHEMA = parseDbml(`Enum estado_pedido {
  pendiente
  pagado
}

Table clientes {
  id     integer      [pk, increment]
  nombre varchar(10)  [not null]
  email  varchar(160)
  activo boolean
}

Table pedidos {
  id         integer       [pk, increment]
  cliente_id integer       [not null, ref: > clientes.id]
  estado     estado_pedido [not null]
  total      decimal(10,2)
}
`);

const answer = (tables: AiRowsAnswer["tables"]): AiRowsAnswer => ({ tables });

const clients = (rows: unknown[][]) => ({ table: "clientes", columns: ["id", "nombre"], rows });

describe("the answer's shape", () => {
  it("reads the rows out of a well-formed reply", () => {
    const parsed = parseAiRows('{"tables":[{"table":"clientes","columns":["id"],"rows":[[1]]}]}');
    expect(parsed?.tables).toHaveLength(1);
    expect(parsed?.tables[0]).toMatchObject({ table: "clientes", rows: [[1]] });
  });

  it.each([
    ["prose", "Aquí tienes las filas que pediste."],
    ["an array", "[1, 2, 3]"],
    ["an object with no tables", '{"filas":[]}'],
    ["tables that are not rows", '{"tables":[{"table":"clientes"}]}'],
  ])("refuses %s whole rather than half-reading it", (_label, text) => {
    expect(parseAiRows(text)).toBeNull();
  });
});

describe("planning the inserts", () => {
  it("writes parents before children", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([
        {
          table: "pedidos",
          columns: ["id", "cliente_id", "estado"],
          rows: [[1, 1, "pendiente"]],
        },
        clients([[1, "Ana"]]),
      ]),
      new Map(),
    );
    expect(plan.dropped).toEqual([]);
    expect(plan.statements).toHaveLength(2);
    // The order in the answer is not the order it is written in — the foreign key decides.
    expect(plan.statements[0]).toContain("clientes");
    expect(plan.statements[1]).toContain("pedidos");
  });

  it("builds the SQL itself rather than taking any from the model", () => {
    const plan = planAiFill(SCHEMA, answer([clients([[1, "O'Brien"]])]), new Map());
    // Two things at once. The apostrophe is escaped, so a name is a value and not a syntax error —
    // which is the whole reason the model is asked for values and never for SQL. And the integer is
    // written as `'1'`: everything crosses to SQLite as text and column affinity converts it, which
    // is the sandbox's own rule and what `fill.ts` has always done.
    expect(plan.statements[0]).toBe(
      `INSERT INTO "clientes" ("id", "nombre") VALUES ('1', 'O''Brien');`,
    );
  });

  /**
   * A key that names nothing is repointed, not dropped — see the loop's own note for why. The case
   * that made it necessary: with `uuid` keys a model reproduces a parent id *almost* exactly, and
   * one character used to cost the whole row, so every table with a foreign key came out empty.
   */
  it("repoints a foreign key that names a row nobody wrote, and counts it", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([
        clients([[1, "Ana"]]),
        {
          table: "pedidos",
          columns: ["id", "cliente_id", "estado"],
          rows: [
            [1, 1, "pagado"],
            [2, 99, "pagado"],
          ],
        },
      ]),
      new Map(),
    );
    expect(plan.dropped).toEqual([]);
    expect(plan.written).toEqual({ clientes: 1, pedidos: 2 });
    // Only the broken one counts as repaired; the row that named a real customer is untouched.
    expect(plan.repaired).toEqual({ pedidos: 1 });
    expect(plan.statements[2]).toContain("'1'");
  });

  /* Nothing to point at is the one case still refused: inventing a parent would be writing rows
     into a table nobody asked to fill. */
  it("still drops a row whose parent table is empty", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([
        { table: "pedidos", columns: ["cliente_id", "estado"], rows: [[7, "pagado"]] },
      ]),
      new Map(),
    );
    expect(plan.written).toEqual({});
    expect(plan.dropped).toEqual([{ table: "pedidos", reason: "foreignKey", rows: 1 }]);
  });

  /* And a not-null reference the answer left out is filled rather than refused: the row is
     otherwise complete, and a link the app chose beats no row at all. */
  it("fills a required reference the answer omitted", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([
        clients([[1, "Ana"], [2, "Beto"]]),
        { table: "pedidos", columns: ["estado"], rows: [["pagado"], ["pendiente"]] },
      ]),
      new Map(),
    );
    expect(plan.dropped).toEqual([]);
    expect(plan.repaired).toEqual({ pedidos: 2 });
    // Round-robin over the real parents, so the children spread instead of piling on the first.
    expect(plan.statements[2]).toContain("'1'");
    expect(plan.statements[3]).toContain("'2'");
  });

  /* A key you typed by hand is as good a target as one this answer wrote. */
  it("accepts a foreign key pointing at a row already in the sandbox", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([
        { table: "pedidos", columns: ["cliente_id", "estado"], rows: [[7, "pagado"]] },
      ]),
      new Map([["clientes|id", ["7"]]]),
    );
    expect(plan.dropped).toEqual([]);
    expect(plan.written).toEqual({ pedidos: 1 });
  });

  it("drops a primary key used twice", () => {
    const plan = planAiFill(SCHEMA, answer([clients([[1, "Ana"], [1, "Beto"]])]), new Map());
    expect(plan.written).toEqual({ clientes: 1 });
    expect(plan.dropped).toEqual([{ table: "clientes", reason: "duplicateKey", rows: 1 }]);
  });

  it("drops an enum value nobody declared, and keeps the declared spelling of one that was", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([
        clients([[1, "Ana"]]),
        {
          table: "pedidos",
          columns: ["cliente_id", "estado"],
          rows: [
            [1, "Pendiente"],
            [1, "cancelado"],
          ],
        },
      ]),
      new Map(),
    );
    expect(plan.dropped).toEqual([{ table: "pedidos", reason: "enum", rows: 1 }]);
    expect(plan.statements[1]).toContain("'pendiente'");
  });

  it("refuses a number written as a word instead of coercing it to zero", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([{ table: "clientes", columns: ["id", "nombre"], rows: [["tres", "Ana"]] }]),
      new Map(),
    );
    expect(plan.statements).toEqual([]);
    expect(plan.dropped).toEqual([{ table: "clientes", reason: "type", rows: 1 }]);
  });

  it("drops a row that leaves a not-null column with no value", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([{ table: "clientes", columns: ["id", "nombre"], rows: [[1, null]] }]),
      new Map(),
    );
    expect(plan.dropped).toEqual([{ table: "clientes", reason: "notNull", rows: 1 }]);
  });

  /* An autonumbered key the model left out is SQLite's to fill, not a missing value. */
  it("lets the engine fill a key the answer omitted", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([{ table: "clientes", columns: ["nombre"], rows: [["Ana"]] }]),
      new Map(),
    );
    expect(plan.dropped).toEqual([]);
    expect(plan.statements[0]).toBe(`INSERT INTO "clientes" ("nombre") VALUES ('Ana');`);
  });

  it("ignores a column the document does not declare, and keeps the rest of the row", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([{ table: "clientes", columns: ["nombre", "telefono"], rows: [["Ana", "555"]] }]),
      new Map(),
    );
    expect(plan.statements[0]).toBe(`INSERT INTO "clientes" ("nombre") VALUES ('Ana');`);
  });

  it("reports a table the document does not declare", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([{ table: "facturas", columns: ["id"], rows: [[1]] }]),
      new Map(),
    );
    expect(plan.unknown).toEqual(["facturas"]);
    expect(plan.statements).toEqual([]);
  });

  it("truncates to the declared length rather than dropping the row", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([{ table: "clientes", columns: ["nombre"], rows: [["Maximiliano Alejandro"]] }]),
      new Map(),
    );
    expect(plan.dropped).toEqual([]);
    expect(plan.statements[0]).toContain("'Maximilian'");
  });

  it("takes booleans in the forms a model writes them", () => {
    const plan = planAiFill(
      SCHEMA,
      answer([
        { table: "clientes", columns: ["nombre", "activo"], rows: [["Ana", true], ["Beto", false]] },
      ]),
      new Map(),
    );
    expect(plan.statements[0]).toContain("1");
    expect(plan.statements[1]).toContain("0");
  });
});

/**
 * Filling in passes.
 *
 * The bug these exist for: asked for a fifteen-table schema in one call, an engine answered with
 * eight tables and stopped — a reply that ran out of room, not an error, and nothing said so. The
 * tables now go in batches, and the two things that make batching *work* rather than merely finish
 * are here: the report has to be about the whole fill, and a later pass has to be told which keys
 * the earlier ones actually wrote or its foreign keys are guesses.
 */
describe("filling a big schema in passes", () => {
  it("splits the tables and leaves none out", () => {
    const ids = Array.from({ length: 15 }, (_, at) => `t${at}`);
    const batches = batchTables(ids);
    expect(batches).toHaveLength(Math.ceil(15 / AI_FILL_BATCH));
    expect(batches.flat()).toEqual(ids);
    // Parents-first order is what the caller passes in; batching must not reshuffle it.
    expect(batches[0][0]).toBe("t0");
  });

  it("folds every pass into one report", () => {
    const total = emptyPlan();
    mergePlans(total, {
      statements: ["a"],
      written: { clientes: 20 },
      dropped: [{ table: "clientes", reason: "type", rows: 2 }],
      repaired: { clientes: 3 },
      unknown: [],
    });
    mergePlans(total, {
      statements: ["b"],
      written: { clientes: 5, pedidos: 12 },
      dropped: [
        { table: "clientes", reason: "type", rows: 1 },
        { table: "pedidos", reason: "foreignKey", rows: 4 },
      ],
      repaired: { clientes: 1, pedidos: 6 },
      unknown: ["facturas"],
    });
    expect(total.written).toEqual({ clientes: 25, pedidos: 12 });
    expect(total.repaired).toEqual({ clientes: 4, pedidos: 6 });
    // Summed per table *and* reason: "3 of the same problem" and "3 assorted" are different facts.
    expect(total.dropped).toEqual([
      { table: "clientes", reason: "type", rows: 3 },
      { table: "pedidos", reason: "foreignKey", rows: 4 },
    ]);
    expect(total.unknown).toEqual(["facturas"]);
    expect(total.statements).toEqual(["a", "b"]);
  });

  it("tells a later pass which keys exist, and only for columns something references", () => {
    const hint = keyHint(
      new Map([
        ["clientes|id", ["1", "2", "3"]],
        // Referenced by nothing, so naming it would be the database copied into the prompt.
        ["clientes|nombre", ["Ana", "Beto"]],
      ]),
      SCHEMA,
    );
    expect(hint).toContain("clientes.id: 1, 2, 3");
    expect(hint).not.toContain("Ana");
  });

  it("caps a long list and says how long it was", () => {
    const ids = Array.from({ length: 80 }, (_, at) => String(at + 1));
    const hint = keyHint(new Map([["clientes|id", ids]]), SCHEMA);
    expect(hint).toContain("… (80)");
    expect(hint).not.toContain(" 60,");
  });

  it("says nothing at all when the sandbox is empty", () => {
    expect(keyHint(new Map(), SCHEMA)).toBe("");
  });
});

/**
 * What the engine is shown.
 *
 * The bug: the whole DBML was sent, the context is capped in Rust, and a schema whose `note`
 * blocks were four fifths of its 17 000 characters got cut at the eighth table — so every pass
 * after the second was asked to write rows for tables it had never seen, and wrote none. The fill
 * stopped at the same eight tables however the batches were arranged. These hold the outline to
 * carrying what the answer depends on and nothing that made it big.
 */
describe("the schema the engine is shown", () => {
  const NOTED = parseDbml(`Table clientes {
  id     integer     [pk, increment]
  nombre varchar(60) [not null]
  note: '''
  Catálogo maestro de clientes.

  NUEVO: es el pivote entre las dos ofertas. El recurso declara qué roles cubre y el servicio
  declara qué roles necesita, de modo que el flujo de reserva sabe qué rol resuelve el motor.
  '''
}

Table pedidos {
  id         integer [pk, increment]
  cliente_id integer [not null, ref: > clientes.id]
}
`);

  it("keeps every table, every column and the references", () => {
    const outline = schemaOutline(NOTED);
    expect(outline).toContain("Table clientes {");
    expect(outline).toContain("Table pedidos {");
    expect(outline).toContain("id integer [pk, autonumérico]");
    expect(outline).toContain("nombre varchar(60) [not null]");
    // Oriented: which end is the child is the whole question a foreign key asks.
    expect(outline).toContain("Ref: pedidos.cliente_id > clientes.id");
  });

  /* The prose is the thing that pushed the tables past the cap, and it is the thing a model
     inventing a row has no use for. */
  it("drops the notes", () => {
    const outline = schemaOutline(NOTED);
    expect(outline).not.toContain("pivote");
    expect(outline).not.toContain("Catálogo maestro");
    expect(outline.length).toBeLessThan(300);
  });

  it("carries the enums, since a column typed with one may only hold its values", () => {
    expect(schemaOutline(SCHEMA)).toContain("Enum estado_pedido { pendiente pagado }");
  });
});
