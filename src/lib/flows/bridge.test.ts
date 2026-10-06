import { describe, expect, it } from "vitest";
import { dbmlAnswer } from "./bridge";
import type { DbSchemaDiagram } from "../../types/database";

const column = (name: string, data_type: string, extra: Partial<{ primary_key: boolean; foreign_key: boolean }> = {}) => ({
  name,
  data_type,
  nullable: false,
  primary_key: false,
  foreign_key: false,
  ...extra,
});

describe("a flow's schema as DBML", () => {
  it("writes the schema's tables with the one emitter, without a line into another schema", async () => {
    const diagram = {
      database: "app",
      schema: "reglas",
      tables: [
        { schema: "reglas", name: "capa", kind: "table", columns: [column("id", "int4", { primary_key: true })], row_estimate: null },
        { schema: "reglas", name: "regla", kind: "table", columns: [column("id", "int4", { primary_key: true }), column("fk_id_capa", "int4", { foreign_key: true })], row_estimate: null },
      ],
      edges: [
        { constraint: "fk_capa", from_schema: "reglas", from_table: "regla", from_column: "fk_id_capa", to_schema: "reglas", to_table: "capa", to_column: "id", inferred: false },
        { constraint: "fk_user", from_schema: "reglas", from_table: "regla", from_column: "id", to_schema: "otros", to_table: "usuario", to_column: "id", inferred: false },
      ],
      notes: [],
    } as unknown as DbSchemaDiagram;
    const answer = await dbmlAnswer({ diagram, title: "Reglas" });
    expect(answer.tables).toBe(2);
    expect(answer.dbml).toContain("Reglas");
    expect(answer.dbml).toMatch(/Table .*capa/);
    expect(answer.dbml).toContain("integer");
    expect(answer.dbml).not.toContain("usuario");
  });
});
