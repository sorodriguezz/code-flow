import { describe, expect, it } from "vitest";
import type { DbDiagramColumn, DbSchemaDiagram } from "../../types/database";
import { diagramStats, layoutDiagram, ownTablesOnly } from "./erLayout";

const column = (name: string, keys: { pk?: boolean; fk?: boolean } = {}): DbDiagramColumn => ({
  name,
  data_type: "uniqueidentifier",
  nullable: false,
  primary_key: keys.pk ?? false,
  foreign_key: keys.fk ?? false,
});

const edge = (from: string, fromColumn: string, toSchema: string, to: string) => ({
  constraint: `fk_${from}_${fromColumn}`,
  from_schema: "reglas",
  from_table: from,
  from_column: fromColumn,
  to_schema: toSchema,
  to_table: to,
  to_column: "id",
  inferred: false,
});

/** `reglas` pointing at two of its own tables and at two of `agenda`'s, as in the report. */
const reglas: DbSchemaDiagram = {
  database: "agendamiento",
  schema: "reglas",
  tables: [
    { schema: "reglas", name: "capa", kind: "table", row_estimate: 2, columns: [column("id", { pk: true })] },
    {
      schema: "reglas",
      name: "regla",
      kind: "table",
      row_estimate: 19,
      columns: [column("id", { pk: true }), column("fk_id_capa", { fk: true }), column("fk_id_servicio", { fk: true })],
    },
    {
      schema: "reglas",
      name: "regla_alcance",
      kind: "table",
      row_estimate: 40,
      columns: [column("id", { pk: true }), column("fk_id_regla", { fk: true }), column("fk_id_recurso", { fk: true })],
    },
  ],
  edges: [
    edge("regla", "fk_id_capa", "reglas", "capa"),
    edge("regla", "fk_id_servicio", "agenda", "servicio"),
    edge("regla_alcance", "fk_id_regla", "reglas", "regla"),
    edge("regla_alcance", "fk_id_recurso", "agenda", "recurso"),
  ],
  notes: [],
};

describe("ownTablesOnly", () => {
  it("draws only the schema's own tables, and keeps the marks of keys into other schemas", () => {
    const own = ownTablesOnly(reglas);
    expect(own.edges.map((e) => `${e.from_table}.${e.from_column}`)).toEqual(["regla.fk_id_capa", "regla_alcance.fk_id_regla"]);
    const layout = layoutDiagram(own, "all");
    expect(layout.nodes.map((node) => node.id).sort()).toEqual(["reglas.capa", "reglas.regla", "reglas.regla_alcance"]);
    expect(layout.nodes.find((node) => node.name === "regla")?.columns.find((c) => c.name === "fk_id_servicio")?.foreign_key).toBe(true);
    // The counts describe the same model the drawing does.
    expect(diagramStats(own).relations).toBe(2);
    expect(diagramStats(own).isolated).toEqual([]);
  });

  it("hands back the same diagram when nothing points outside", () => {
    const inside = { ...reglas, edges: reglas.edges.filter((e) => e.to_schema === "reglas") };
    expect(ownTablesOnly(inside)).toBe(inside);
  });
});
