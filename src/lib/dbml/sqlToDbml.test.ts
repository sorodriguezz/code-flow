import { describe, expect, it } from "vitest";
import { parseDbml } from "./parse";
import { sqlToDbml } from "./sqlToDbml";

/**
 * The forgiving SQL reader behind "Importar SQL". Every case is read back through `parseDbml`: the
 * point of an import is DBML the real parser accepts, and two of the bugs below produced DBML that
 * looked right and did not parse.
 */

const read = (sql: string) => {
  const dbml = sqlToDbml(sql);
  const schema = parseDbml(dbml);
  expect(schema.error, dbml).toBeNull();
  return { dbml, schema };
};

describe("sqlToDbml", () => {
  it("reads tables, keys and constraints out of a dump full of other statements", () => {
    const { schema } = read(`
      -- a dump
      SET client_encoding = 'UTF8';
      CREATE TABLE IF NOT EXISTS public.users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        full_name character varying(100),
        created_at TIMESTAMP WITH TIME ZONE
      );
      CREATE TABLE posts (
        id bigint GENERATED ALWAYS AS IDENTITY,
        author_id INT REFERENCES users(id),
        CONSTRAINT posts_pkey PRIMARY KEY (id)
      );
      GRANT SELECT ON users TO reader;
    `);
    const users = schema.tables.find((table) => table.name === "users");
    expect(users?.fields.map((field) => [field.name, field.type])).toEqual([
      ["id", "integer"],
      ["email", "varchar(255)"],
      ["full_name", "varchar(100)"],
      ["created_at", "timestamp"],
    ]);
    expect(users?.fields[0]).toMatchObject({ pk: true, increment: true });
    expect(users?.fields[1]).toMatchObject({ notNull: true, unique: true });
    const posts = schema.tables.find((table) => table.name === "posts");
    expect(posts?.fields[0]).toMatchObject({ pk: true, increment: true });
    expect(schema.refs).toHaveLength(1);
  });

  it("writes an expression default between backticks, and re-escapes a string one", () => {
    const { dbml, schema } = read(`
      CREATE TABLE t (
        id int PRIMARY KEY,
        at timestamp DEFAULT now(),
        stamp timestamp DEFAULT CURRENT_TIMESTAMP,
        role varchar(20) DEFAULT 'member',
        n int DEFAULT 0,
        flag boolean DEFAULT TRUE
      );
    `);
    expect(dbml).toContain("default: `now()`");
    expect(dbml).toContain("default: `CURRENT_TIMESTAMP`");
    const fields = Object.fromEntries(schema.tables[0].fields.map((field) => [field.name, field.default]));
    expect(fields).toMatchObject({ at: "`now()`", role: "'member'", n: "0", flag: "true" });
  });

  it("keeps a composite foreign key whole, from a constraint or a later ALTER", () => {
    const { dbml, schema } = read(`
      CREATE TABLE orders (shop_id int, num int, PRIMARY KEY (shop_id, num));
      CREATE TABLE lines (
        id int PRIMARY KEY, shop_id int, order_num int,
        FOREIGN KEY (shop_id, order_num) REFERENCES orders (shop_id, num)
      );
      CREATE TABLE notes (id int PRIMARY KEY, shop_id int, order_num int);
      ALTER TABLE ONLY notes ADD CONSTRAINT fk FOREIGN KEY (shop_id, order_num) REFERENCES orders(shop_id, num);
    `);
    expect(dbml).toContain("Ref: lines.(shop_id, order_num) > orders.(shop_id, num)");
    expect(schema.refs.map((ref) => ref.from.fields.length)).toEqual([2, 2]);
  });

  it("writes one relationship once, however many times the SQL states it", () => {
    const { schema } = read(`
      CREATE TABLE a (id int PRIMARY KEY);
      CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));
      ALTER TABLE b ADD FOREIGN KEY (a_id) REFERENCES a (id);
    `);
    expect(schema.refs).toHaveLength(1);
  });

  it("turns a multi-column unique into an index, and a single one into the column's setting", () => {
    const { dbml, schema } = read(`
      CREATE TABLE m (id int PRIMARY KEY, a int, b int, c int, UNIQUE (a, b), UNIQUE (c));
    `);
    expect(dbml).toContain("(a, b) [unique]");
    expect(schema.tables[0].fields.find((field) => field.name === "c")?.unique).toBe(true);
  });

  it("answers nothing for SQL with no table in it", () => {
    expect(sqlToDbml("SELECT 1;")).toBe("");
  });
});
