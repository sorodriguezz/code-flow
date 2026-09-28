import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDbml } from "../parse";
import { orientRef } from "../sqlite";
import { orientReference } from "../orient";
import { convert, CONVERSION_TARGETS } from "./index";
import { codegenFindings, codegenRefs, defaultOf } from "./shared";
import type { DbmlField } from "../types";

/**
 * The generators' output, over one fixture that carries every shape they used to get wrong.
 *
 * ~1,350 lines of emitters had no output test at all, which is how three bugs lived in all of them
 * at once: an inline one-to-one oriented backwards, a composite reference cut to its first column,
 * and expression defaults printed with DBML's backticks (or turned into the string "now()"). The
 * snapshots are whole files in each target's own language, so a change to any emitter shows up as a
 * readable diff of the code it now writes; the assertions under them pin the three bugs by name, so
 * a snapshot re-recorded carelessly cannot quietly re-introduce one.
 *
 * The fixture is read **through `parseDbml`**, never built by hand: two of the three bugs were about
 * what the parser hands back, and a hand-written model encodes the author's belief about that.
 */

const fixture = readFileSync(new URL("./__fixtures__/codegen.dbml", import.meta.url), "utf8");
const schema = parseDbml(fixture);

describe("the codegen fixture", () => {
  it("parses with the real parser", () => {
    expect(schema.error).toBeNull();
    expect(schema.tables.map((table) => table.id)).toContain("order_lines");
  });
});

describe("every generator's output", () => {
  for (const target of CONVERSION_TARGETS) {
    it(`${target.label} matches its snapshot`, async () => {
      await expect(convert(schema, target.id)).toMatchFileSnapshot(
        // `.snap` after the language's own extension: a `.ts` snapshot would be type-checked as part
        // of `src`, against ORMs this repository does not install.
        `./__snapshots__/codegen.${target.id}.${target.extension}.snap`,
      );
    });
  }
});

describe("one-to-one orientation", () => {
  const ddl = convert(schema, "postgresql");

  it("puts an inline one-to-one's key on the declaring table", () => {
    // `profiles.user_id [ref: - users.id]` arrives from the parser as users.id → profiles.user_id.
    expect(ddl).toContain('ALTER TABLE "profiles"\n  ADD CONSTRAINT "fk_profiles_user_id"');
    expect(ddl).toContain('FOREIGN KEY ("user_id") REFERENCES "users" ("id")');
    expect(ddl).not.toMatch(/ALTER TABLE "users"/);
  });

  it("puts a standalone one-to-one's key on the non-key end whichever way it was written", () => {
    expect(ddl).toContain('FOREIGN KEY ("owner_id") REFERENCES "users" ("id")');
  });

  it("orients the relation the same way in every ORM", () => {
    const prisma = convert(schema, "prisma");
    const profiles = prisma.slice(prisma.indexOf("model Profiles"), prisma.indexOf("model Passports"));
    const users = prisma.slice(prisma.indexOf("model Users"), prisma.indexOf("model Profiles"));
    expect(profiles).toContain("@relation(fields: [user_id], references: [id])");
    expect(users).not.toContain("@relation(fields:");

    expect(convert(schema, "typeorm")).toContain("@JoinColumn({ name: 'user_id' })\n  user!: Users;");
    expect(convert(schema, "jpa")).toContain(
      '@JoinColumn(name = "user_id", referencedColumnName = "id")\n    private Users user;',
    );
    expect(convert(schema, "drizzle")).toContain(
      "userId: integer('user_id').unique().references(() => users.id)",
    );
    expect(convert(schema, "sequelize")).toContain(
      "Profiles.belongsTo(models.Users, { foreignKey: 'user_id', as: 'users' });",
    );
    expect(convert(schema, "gorm")).toContain('gorm:"foreignKey:UserId;references:Id"');
    expect(convert(schema, "laravel")).toContain(
      "$table->foreign('user_id')->references('id')->on('users')",
    );
    expect(convert(schema, "mongodb")).toContain("user_id: { type: Schema.Types.ObjectId, ref: 'Users' }");
  });

  it("drops a one-to-one nothing can orient, and says so in every target", () => {
    expect(codegenRefs(schema).some((ref) => ref.fkTable.id === "user_settings")).toBe(false);
    expect(codegenFindings(schema)).toHaveLength(1);
    for (const target of CONVERSION_TARGETS) {
      expect(convert(schema, target.id), target.id).toContain("Skipped user_settings.user_id - users.id");
    }
  });
});

describe("composite references", () => {
  it("keep every column, in order, on both sides", () => {
    const [ref] = codegenRefs(schema).filter((entry) => entry.fkTable.id === "order_lines");
    expect(ref.fkFields).toEqual(["shop_id", "order_number"]);
    expect(ref.pkFields).toEqual(["shop_id", "number"]);
  });

  it("are emitted whole by every generator that can express one", () => {
    expect(convert(schema, "postgresql")).toContain(
      'FOREIGN KEY ("shop_id", "order_number") REFERENCES "orders" ("shop_id", "number")',
    );
    expect(convert(schema, "sqlserver")).toContain(
      "FOREIGN KEY ([shop_id], [order_number]) REFERENCES [orders] ([shop_id], [number])",
    );
    expect(convert(schema, "prisma")).toContain(
      "@relation(fields: [shop_id, order_number], references: [shop_id, number])",
    );
    expect(convert(schema, "typeorm")).toContain(
      "@JoinColumn([{ name: 'shop_id', referencedColumnName: 'shop_id' }, { name: 'order_number', referencedColumnName: 'number' }])",
    );
    expect(convert(schema, "jpa")).toContain('@JoinColumn(name = "order_number", referencedColumnName = "number")');
    expect(convert(schema, "drizzle")).toContain(
      "columns: [table.shopId, table.orderNumber],\n    foreignColumns: [orders.shopId, orders.number],",
    );
    expect(convert(schema, "gorm")).toContain('gorm:"foreignKey:ShopId,OrderNumber;references:ShopId,Number"');
    expect(convert(schema, "laravel")).toContain(
      "$table->foreign(['shop_id', 'order_number'])->references(['shop_id', 'number'])->on('orders')",
    );
  });

  it("are named rather than cut where the target cannot express one", () => {
    const sequelize = convert(schema, "sequelize");
    expect(sequelize).toContain("Sequelize cannot associate on a composite key");
    expect(sequelize).not.toContain("foreignKey: 'shop_id', as: 'orders'");
  });

  it("point at a composite primary key the generators now declare", () => {
    expect(convert(schema, "postgresql")).toContain('PRIMARY KEY ("shop_id", "number")');
    expect(convert(schema, "prisma")).toContain("@@id([shop_id, number])");
    expect(convert(schema, "drizzle")).toContain("primaryKey({ columns: [table.shopId, table.number] })");
    expect(convert(schema, "laravel")).toContain("$table->primary(['shop_id', 'number']);");
    expect(convert(schema, "jpa")).toContain("@IdClass(Orders.Key.class)");
  });
});

describe("column defaults", () => {
  it("never carry DBML's backticks into any target", () => {
    for (const target of CONVERSION_TARGETS) {
      const code = convert(schema, target.id);
      expect(code, target.id).not.toContain("`now()`");
      expect(code, target.id).not.toContain("`gen_random_uuid()`");
      // Nor the expression as a *string* default — the other half of the same bug.
      expect(code, target.id).not.toMatch(/default(Value)?: ?'now\(\)'/);
      expect(code, target.id).not.toContain("->default('now()')");
    }
  });

  it("are written as expressions in each dialect", () => {
    expect(convert(schema, "postgresql")).toContain('"created_at" TIMESTAMP DEFAULT now()');
    expect(convert(schema, "sqlserver")).toContain("[created_at] DATETIME2 DEFAULT GETDATE()");
    expect(convert(schema, "sqlserver")).toContain("[code] UNIQUEIDENTIFIER DEFAULT NEWID()");
    expect(convert(schema, "typeorm")).toContain("default: () => 'lower(md5(random()::text))'");
    expect(convert(schema, "sequelize")).toContain("defaultValue: Sequelize.literal('lower(md5(random()::text))')");
    expect(convert(schema, "sequelize")).toContain("defaultValue: DataTypes.NOW");
    expect(convert(schema, "mongodb")).toContain("created_at: { type: Date, default: Date.now }");
    expect(convert(schema, "prisma")).toContain('@default(dbgenerated("lower(md5(random()::text))"))');
    expect(convert(schema, "drizzle")).toContain(".default(sql`lower(md5(random()::text))`)");
    expect(convert(schema, "laravel")).toContain("->default(DB::raw('lower(md5(random()::text))'))");
  });

  it("quote strings the target's way", () => {
    expect(convert(schema, "postgresql")).toContain(`"bio" TEXT DEFAULT 'it''s me'`);
    expect(convert(schema, "prisma")).toContain('@default("it\'s me")');
    expect(convert(schema, "prisma")).toContain("OrderStatus?  @default(pending)");
    expect(convert(schema, "typeorm")).toContain("default: 'it\\'s me'");
  });

  it("classify what the parser hands back", () => {
    const field = (value: string | null): DbmlField => ({
      name: "x",
      type: "text",
      pk: false,
      notNull: false,
      unique: false,
      increment: false,
      default: value,
      note: "",
    });
    expect(defaultOf(field("`now()`"))).toEqual({ kind: "expression", sql: "now()" });
    expect(defaultOf(field("'it\\'s'"))).toEqual({ kind: "string", value: "it's" });
    expect(defaultOf(field("-1.5"))).toEqual({ kind: "number", text: "-1.5" });
    expect(defaultOf(field("true"))).toEqual({ kind: "boolean", value: true });
    expect(defaultOf(field("null"))).toEqual({ kind: "null" });
    expect(defaultOf(field(null))).toBeNull();
  });
});

describe("orientReference", () => {
  const refOf = (doc: string) => {
    const parsed = parseDbml(doc);
    expect(parsed.error).toBeNull();
    return { parsed, ref: parsed.refs[0] };
  };
  const tables = "Table users {\n  id int [pk]\n}\nTable profiles {\n  id int [pk]\n  user_id int [unique]\n}\n";

  it("agrees across the three ways of writing the same one-to-one", () => {
    for (const doc of [
      "Table users {\n  id int [pk]\n}\nTable profiles {\n  id int [pk]\n  user_id int [unique, ref: - users.id]\n}",
      `${tables}Ref: profiles.user_id - users.id`,
      `${tables}Ref: users.id - profiles.user_id`,
    ]) {
      const { parsed, ref } = refOf(doc);
      const oriented = orientReference(parsed, ref);
      expect(oriented.kind).toBe("one-to-one");
      if (oriented.kind !== "one-to-one") continue;
      expect(oriented.child).toEqual({ table: "profiles", fields: ["user_id"], relation: "1" });
      expect(oriented.parent.table).toBe("users");
    }
  });

  it("falls to unique-but-not-key when neither end is a declared key", () => {
    const { parsed, ref } = refOf(
      "Table users {\n  id int\n}\nTable profiles {\n  user_id int [unique, ref: - users.id]\n}",
    );
    const oriented = orientReference(parsed, ref);
    expect(oriented.kind === "one-to-one" && oriented.child.table).toBe("profiles");
  });

  it("calls a shared primary key ambiguous, and the sandbox still reads `to` as the parent", () => {
    const { parsed, ref } = refOf(
      "Table users {\n  id int [pk]\n}\nTable settings {\n  user_id int [pk]\n}\nRef: settings.user_id - users.id",
    );
    expect(orientReference(parsed, ref).kind).toBe("ambiguous");
    expect(orientRef(parsed, ref)).toEqual({ child: ref.from, parent: ref.to });
  });

  it("leaves one-to-many to the `*` end, whichever slot it is in", () => {
    const { parsed, ref } = refOf(
      "Table users {\n  id int [pk]\n}\nTable posts {\n  id int [pk]\n  user_id int [ref: > users.id]\n}",
    );
    const oriented = orientReference(parsed, ref);
    expect(oriented.kind).toBe("many-to-one");
    expect(oriented.kind === "many-to-one" && oriented.child.table).toBe("posts");
  });
});
