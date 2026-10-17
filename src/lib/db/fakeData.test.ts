import { describe, expect, it } from "vitest";
import {
  chooseGenerator,
  fakeColumnsOf,
  generateRows,
  insertSql,
  parseType,
  planProblems,
  planWarnings,
  sqlLiteral,
  type ColumnPlan,
  type FakeColumn,
} from "./fakeData";
import type { DbNode } from "../../types/database";

function col(name: string, type: string, extra: Partial<FakeColumn> = {}): FakeColumn {
  return { name, type, nullable: true, primaryKey: false, default: null, autoIncrement: false, ref: null, ...extra };
}

function plansOf(columns: FakeColumn[]): ColumnPlan[] {
  return columns.map((column) => ({ column, generator: chooseGenerator(column) }));
}

describe("parseType", () => {
  it("reads lengths, precision and families", () => {
    expect(parseType("character varying(50)")).toMatchObject({ family: "text", length: 50 });
    expect(parseType("numeric(6,2)")).toMatchObject({ family: "decimal", precision: 6, scale: 2 });
    expect(parseType("int(11) unsigned").family).toBe("int");
    expect(parseType("tinyint(1)").family).toBe("bool");
    expect(parseType("NUMBER(10)").family).toBe("int");
    expect(parseType("timestamp with time zone").family).toBe("timestamp");
    expect(parseType("jsonb").family).toBe("json");
    expect(parseType("uniqueidentifier").family).toBe("uuid");
    expect(parseType("text[]").family).toBe("array");
    expect(parseType("bytea").family).toBe("binary");
  });
});

describe("chooseGenerator", () => {
  it("goes by the name first, then the type", () => {
    expect(chooseGenerator(col("email", "varchar(120)"))).toBe("email");
    expect(chooseGenerator(col("correo_electronico", "text"))).toBe("email");
    expect(chooseGenerator(col("first_name", "varchar(40)"))).toBe("firstName");
    expect(chooseGenerator(col("apellido", "varchar(40)"))).toBe("lastName");
    expect(chooseGenerator(col("telefono", "varchar(20)"))).toBe("phone");
    expect(chooseGenerator(col("ciudad", "varchar(40)"))).toBe("city");
    expect(chooseGenerator(col("precio", "numeric(10,2)"))).toBe("price");
    expect(chooseGenerator(col("status", "varchar(10)"))).toBe("status");
    expect(chooseGenerator(col("is_active", "boolean"))).toBe("boolean");
    expect(chooseGenerator(col("created_at", "timestamp"))).toBe("timestamp");
    expect(chooseGenerator(col("payload", "jsonb"))).toBe("json");
    expect(chooseGenerator(col("whatever", "integer"))).toBe("integer");
    expect(chooseGenerator(col("bank_account", "varchar(30)"))).toBe("word");
  });

  it("leaves server-numbered and defaulted columns to the server", () => {
    expect(chooseGenerator(col("id", "integer", { autoIncrement: true, primaryKey: true }))).toBe("skip");
    expect(chooseGenerator(col("created_at", "timestamp", { default: "now()" }))).toBe("skip");
    expect(chooseGenerator(col("id", "integer", { primaryKey: true }))).toBe("sequence");
    expect(chooseGenerator(col("customer_id", "integer", { ref: { schema: null, table: "customers", column: "id" } }))).toBe("fk");
    expect(chooseGenerator(col("blob", "bytea"))).toBe("null");
  });
});

describe("fakeColumnsOf", () => {
  const node = (name: string, data_type: string, extra: Partial<DbNode> = {}, info: object = {}): DbNode => ({
    id: name,
    kind: "column",
    name,
    detail: data_type,
    database: null,
    schema: "public",
    table: "t",
    has_children: false,
    column: { data_type, nullable: true, primary_key: false, default_value: null, position: 0, ...info },
    ...extra,
  });

  it("spots auto-increment columns however the engine spells them", () => {
    const columns = fakeColumnsOf(
      [
        node("a", "integer", {}, { default_value: "nextval('t_a_seq'::regclass)" }),
        node("b", "int", { detail: "int · PK · identity" }),
        node("c", "int(11)", { detail: "int(11) · PK · auto_increment" }),
        node("d", "integer"),
      ],
      [{ column: "d", ref_schema: "public", ref_table: "p", ref_column: "id" }],
      "postgres",
    );
    expect(columns.map((c) => c.autoIncrement)).toEqual([true, true, true, false]);
    expect(columns[3].ref).toEqual({ schema: "public", table: "p", column: "id" });
  });

  it("treats SQLite's INTEGER PRIMARY KEY as the rowid", () => {
    const [id] = fakeColumnsOf([node("id", "INTEGER", {}, { primary_key: true })], [], "sqlite");
    expect(id.autoIncrement).toBe(true);
  });
});

describe("generateRows", () => {
  const columns = [
    col("id", "integer", { primaryKey: true, nullable: false }),
    col("email", "varchar(30)", { nullable: false }),
    col("name", "varchar(8)"),
    col("price", "numeric(5,2)"),
    col("customer_id", "integer", { ref: { schema: "public", table: "customers", column: "id" }, nullable: false }),
  ];
  const parents = { "public.customers": { columns: ["id"], rows: [["7"], ["9"]] } };

  it("is deterministic for a seed", () => {
    const plans = plansOf(columns);
    expect(generateRows(plans, 20, 42, parents)).toEqual(generateRows(plans, 20, 42, parents));
    expect(generateRows(plans, 20, 42, parents)).not.toEqual(generateRows(plans, 20, 43, parents));
  });

  it("stays inside the column's type and draws keys from the parent", () => {
    const plans = plansOf(columns);
    plans[0].start = 100;
    const rows = generateRows(plans, 200, 1, parents);
    const emails = new Set<string>();
    rows.forEach((row, index) => {
      expect(row[0]).toEqual({ t: "number", v: String(100 + index) });
      const email = row[1] as { t: "text"; v: string };
      expect(email.v.length).toBeLessThanOrEqual(30);
      expect(email.v).toContain("@example.");
      emails.add(email.v);
      expect((row[2] as { v: string }).v.length).toBeLessThanOrEqual(8);
      expect(Math.abs(Number((row[3] as { v: string }).v))).toBeLessThan(1000);
      expect(["7", "9"]).toContain((row[4] as { v: string }).v);
    });
    expect(emails.size).toBe(200);
  });

  it("refuses a required key into an empty parent and nulls an optional one", () => {
    const required = plansOf([columns[4]]);
    expect(planProblems(required, {})).toEqual(["customer_id"]);
    const optional = plansOf([{ ...columns[4], nullable: true }]);
    expect(planProblems(optional, {})).toEqual([]);
    expect(planWarnings(optional, {})).toEqual(["customer_id"]);
    expect(generateRows(optional, 1, 1, {})[0][0]).toEqual({ t: "null" });
  });
});

describe("insertSql", () => {
  const plans = plansOf([col("id", "int", { autoIncrement: true }), col("name", "varchar(20)"), col("ok", "boolean")]);
  const rows = generateRows(plans, 3, 5);

  it("batches multi-row VALUES and leaves skipped columns out", () => {
    const sql = insertSql({ schema: "public", name: "t" }, plans, rows, "postgres", 2);
    expect(sql.match(/INSERT INTO/g)).toHaveLength(2);
    expect(sql).toContain(`INSERT INTO "public"."t" ("name", "ok") VALUES`);
    expect(sql).not.toContain(`"id"`);
    expect(sql).toMatch(/TRUE|FALSE/);
  });

  it("speaks each dialect", () => {
    expect(insertSql({ schema: "db", name: "t" }, plans, rows, "mysql")).toContain("INSERT INTO `db`.`t` (`name`, `ok`)");
    expect(insertSql({ schema: "dbo", name: "t" }, plans, rows, "sqlserver")).toContain("N'");
    const oracle = insertSql({ schema: "HR", name: "T" }, plans, rows, "oracle");
    expect(oracle.startsWith("INSERT ALL")).toBe(true);
    expect(oracle).toContain("SELECT 1 FROM DUAL;");
    expect(insertSql({ schema: "SQLUser", name: "t" }, plans, rows, "iris").match(/INSERT INTO/g)).toHaveLength(3);
  });

  it("escapes quotes in literals", () => {
    expect(sqlLiteral({ t: "text", v: "O'Brien" }, "postgres")).toBe("'O''Brien'");
    expect(sqlLiteral({ t: "text", v: "a\\b" }, "mysql")).toBe("'a\\\\b'");
    expect(sqlLiteral({ t: "date", v: "2024-01-02" }, "oracle")).toBe("DATE '2024-01-02'");
  });
});
