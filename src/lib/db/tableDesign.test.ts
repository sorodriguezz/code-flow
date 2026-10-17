import { describe, expect, it } from "vitest";
import { alterSql, createSql, designProblems, type TableDesign } from "./tableDesign";

const col = (name: string, type: string, extra: Partial<TableDesign["columns"][number]> = {}) => ({
  id: name,
  original: name,
  name,
  type,
  nullable: true,
  defaultValue: null,
  primaryKey: false,
  ...extra,
});

const before: TableDesign = {
  name: "users",
  columns: [col("id", "bigint", { nullable: false, primaryKey: true }), col("email", "text"), col("legacy", "text")],
  indexes: [{ id: "i", original: "users_email_idx", name: "users_email_idx", columns: [], unique: false }],
};

describe("tableDesign", () => {
  it("creates a table with its key and indexes", () => {
    const sql = createSql(
      {
        name: "t",
        columns: [col("id", "int", { original: null, nullable: false, primaryKey: true }), col("n", "text", { defaultValue: "'x'" })],
        indexes: [{ id: "x", original: null, name: "t_n", columns: ["n"], unique: true }],
      },
      { schema: "public", dialect: "postgres" },
    );
    expect(sql[0]).toBe(`CREATE TABLE "public"."t" (\n  "id" int NOT NULL,\n  "n" text DEFAULT 'x',\n  PRIMARY KEY ("id")\n)`);
    expect(sql[1]).toBe(`CREATE UNIQUE INDEX "t_n" ON "public"."t" ("n")`);
  });

  it("tells a rename from a drop, and changes in place on Postgres", () => {
    const after: TableDesign = {
      name: "users",
      columns: [
        before.columns[0],
        { ...before.columns[1], name: "mail", nullable: false },
        col("age", "int", { original: null, defaultValue: "0" }),
      ],
      indexes: [],
    };
    expect(alterSql(before, after, { schema: "public", dialect: "postgres" })).toEqual([
      `DROP INDEX "public"."users_email_idx"`,
      `ALTER TABLE "public"."users" DROP COLUMN "legacy"`,
      `ALTER TABLE "public"."users" RENAME COLUMN "email" TO "mail"`,
      `ALTER TABLE "public"."users" ALTER COLUMN "mail" SET NOT NULL`,
      `ALTER TABLE "public"."users" ADD COLUMN "age" int DEFAULT 0`,
    ]);
  });

  it("restates the column on MySQL and uses sp_rename on SQL Server", () => {
    const after = { ...before, columns: [before.columns[0], { ...before.columns[1], type: "varchar(100)" }, before.columns[2]] };
    expect(alterSql(before, after, { schema: "app", dialect: "mysql" })).toContain(
      "ALTER TABLE `app`.`users` MODIFY COLUMN `email` varchar(100)",
    );
    const renamed = { ...before, name: "people" };
    expect(alterSql(before, renamed, { schema: "dbo", dialect: "sqlserver" })).toEqual([
      "EXEC sp_rename 'dbo.users', 'people'",
    ]);
  });

  it("says what SQLite cannot do instead of doing something else", () => {
    const after = { ...before, columns: [before.columns[0], { ...before.columns[1], type: "integer" }, before.columns[2]] };
    expect(alterSql(before, after, { schema: null, dialect: "sqlite" })[0]).toMatch(/^-- SQLite cannot/);
  });

  it("finds what blocks the statements", () => {
    expect(designProblems({ name: "", columns: [col("a", ""), col("A", "int")], indexes: [] })).toEqual([
      "noName",
      "noType",
      "duplicate",
    ]);
  });
});
