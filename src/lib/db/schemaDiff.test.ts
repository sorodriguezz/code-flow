import { describe, expect, it } from "vitest";
import { diffSchemas, isEmptyDiff, migrationSql, normalizeType } from "./schemaDiff";
import type { DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbSchemaDiagram } from "../../types/database";

const column = (name: string, data_type: string, extra: Partial<DbDiagramColumn> = {}): DbDiagramColumn => ({
  name,
  data_type,
  nullable: true,
  primary_key: false,
  foreign_key: false,
  ...extra,
});

const table = (name: string, columns: DbDiagramColumn[]): DbDiagramTable => ({
  schema: null,
  name,
  kind: "table",
  columns,
  row_estimate: null,
});

const edge = (from: string, fromColumn: string, to: string, toColumn: string, constraint = `${from}_fk`): DbDiagramEdge => ({
  constraint,
  from_schema: null,
  from_table: from,
  from_column: fromColumn,
  to_schema: null,
  to_table: to,
  to_column: toColumn,
  inferred: false,
});

const diagram = (schema: string, tables: DbDiagramTable[], edges: DbDiagramEdge[] = []): DbSchemaDiagram => ({
  database: null,
  schema,
  tables,
  edges,
  notes: [],
});

const source = diagram(
  "app",
  [
    table("customers", [column("id", "integer", { primary_key: true, nullable: false }), column("email", "varchar(120)", { nullable: false })]),
    table("orders", [
      column("id", "integer", { primary_key: true, nullable: false }),
      column("customer_id", "integer", { nullable: false }),
      column("total", "numeric(10,2)"),
    ]),
    table("invoices", [column("id", "integer", { primary_key: true, nullable: false }), column("order_id", "integer")]),
  ],
  [edge("orders", "customer_id", "customers", "id"), edge("invoices", "order_id", "orders", "id")],
);

const target = diagram("app_old", [
  table("CUSTOMERS", [column("ID", "int4", { primary_key: true, nullable: false }), column("EMAIL", "character varying(80)")]),
  table("orders", [column("id", "integer", { primary_key: true, nullable: false }), column("legacy", "text")]),
  table("audit", [column("id", "integer")]),
]);

describe("normalizeType", () => {
  it("treats spellings of one type as the same", () => {
    expect(normalizeType("int4")).toBe(normalizeType("integer"));
    expect(normalizeType("int(11)")).toBe(normalizeType("INTEGER"));
    expect(normalizeType("character varying(50)")).toBe(normalizeType("varchar( 50 )"));
    expect(normalizeType("varchar(50)")).not.toBe(normalizeType("varchar(80)"));
  });
});

describe("diffSchemas", () => {
  const diff = diffSchemas(source, target);

  it("finds tables on one side only, matching names case-insensitively", () => {
    expect(diff.onlyInSource.map((t) => t.name)).toEqual(["invoices"]);
    expect(diff.onlyInTarget.map((t) => t.name)).toEqual(["audit"]);
    expect(diff.newTableKeys).toHaveLength(1);
  });

  it("finds column, key and constraint changes", () => {
    const customers = diff.changed.find((t) => t.name === "customers")!;
    expect(customers.changed).toHaveLength(1);
    expect(customers.changed[0]).toMatchObject({ name: "email", type: true, nullable: true, default: false });
    const orders = diff.changed.find((t) => t.name === "orders")!;
    expect(orders.added.map((c) => c.name)).toEqual(["customer_id", "total"]);
    expect(orders.removed.map((c) => c.name)).toEqual(["legacy"]);
    expect(orders.fkAdded).toHaveLength(1);
    expect(orders.primaryKey).toBeNull();
  });

  it("compares defaults only when both sides were read", () => {
    const withDefault = (value: string | null | undefined) =>
      diagram("s", [table("t", [{ ...column("a", "int"), default: value } as DbDiagramColumn])]);
    expect(isEmptyDiff(diffSchemas(withDefault("0"), withDefault(undefined)))).toBe(true);
    expect(isEmptyDiff(diffSchemas(withDefault("('x'::character varying)"), withDefault("'x'")))).toBe(true);
    expect(diffSchemas(withDefault("1"), withDefault("0")).changed[0].changed[0].default).toBe(true);
  });

  it("is empty for identical schemas", () => {
    expect(isEmptyDiff(diffSchemas(source, source))).toBe(true);
  });
});

describe("migrationSql", () => {
  const diff = diffSchemas(source, target);

  it("creates, alters and comments out drops on Postgres", () => {
    const sql = migrationSql(diff, "postgres");
    expect(sql).toContain(`CREATE TABLE "app_old"."invoices"`);
    expect(sql).toContain(`PRIMARY KEY ("id")`);
    expect(sql).toContain(`ALTER TABLE "app_old"."customers" ALTER COLUMN "email" TYPE varchar(120);`);
    expect(sql).toContain(`ALTER COLUMN "email" SET NOT NULL;`);
    expect(sql).toContain(`ALTER TABLE "app_old"."orders" ADD COLUMN "customer_id" integer NOT NULL;`);
    expect(sql).toContain(`FOREIGN KEY ("customer_id") REFERENCES "app_old"."customers" ("id")`);
    expect(sql).toContain(`-- ALTER TABLE "app_old"."orders" DROP COLUMN "legacy";`);
    expect(sql).toContain(`-- DROP TABLE "app_old"."audit";`);
  });

  it("includes drops only when asked", () => {
    const sql = migrationSql(diff, "postgres", { includeDrops: true });
    expect(sql).toMatch(/^DROP TABLE "app_old"\."audit";$/m);
  });

  it("speaks each dialect", () => {
    expect(migrationSql(diff, "mysql")).toContain("ALTER TABLE `app_old`.`customers` MODIFY COLUMN `email` varchar(120) NOT NULL;");
    expect(migrationSql(diff, "sqlserver")).toContain("ALTER TABLE [app_old].[customers] ALTER COLUMN [email] varchar(120) NOT NULL;");
    expect(migrationSql(diff, "sqlserver")).toContain("ALTER TABLE [app_old].[orders] ADD [total] numeric(10,2);");
    expect(migrationSql(diff, "oracle")).toContain(`MODIFY ("email" varchar(120) NOT NULL);`);
    const sqlite = migrationSql(diff, "sqlite");
    expect(sqlite).toContain("-- SQLite cannot change column email");
    expect(sqlite).toContain("FOREIGN KEY (\"order_id\") REFERENCES \"orders\" (\"id\")");
  });

  it("says when there is nothing to do", () => {
    expect(migrationSql(diffSchemas(source, source), "postgres")).toBe("-- The schemas match: nothing to do.");
  });
});
