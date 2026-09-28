import { describe, expect, it } from "vitest";
import { diffSchemas } from "./diff";
import { mergeDbml } from "./merge";
import { parseDbml } from "./parse";
import { readLayout, writeLayout } from "./layout";

/** The structural diff under "Comparar", and the merge under "add to the schema". */

describe("diffSchemas", () => {
  const before = parseDbml(`
Enum role {
  admin
  guest
}
Table users {
  id int [pk]
  email varchar(100)
  nick varchar
}
Table old {
  id int [pk]
}
`);
  const after = parseDbml(`
Table new_one {
  id int [pk]
}
Table users {
  email varchar(255) [not null]
  id int [pk]
  age int
}
Enum role {
  admin
  owner
}
Ref: new_one.id - users.id
`);
  const diff = diffSchemas(before, after);

  it("compares models, not text: order and formatting are not changes", () => {
    const same = diffSchemas(before, parseDbml("Table old {\n  id int [pk]\n}\nTable users {\n id int [pk]\n email varchar(100)\n nick varchar\n}\nEnum role {\n guest\n admin\n}"));
    expect(same.changed).toBe(false);
  });

  it("lists what arrived, went and changed, in reading order", () => {
    expect(diff.tables.map((table) => [table.name, table.status])).toEqual([
      ["new_one", "added"],
      ["users", "modified"],
      ["old", "removed"],
    ]);
    const users = diff.tables.find((table) => table.name === "users");
    expect(users?.fields.map((field) => [field.name, field.status])).toEqual([
      ["age", "added"],
      ["email", "modified"],
      ["id", "unchanged"],
      ["nick", "removed"],
    ]);
    expect(users?.fields.find((field) => field.name === "email")?.changes).toEqual([
      { property: "type", before: "varchar(100)", after: "varchar(255)" },
      { property: "not null", before: "no", after: "yes" },
    ]);
    expect(diff.enums[0]).toMatchObject({ status: "modified", added: ["owner"], removed: ["guest"] });
    expect(diff.refs).toHaveLength(1);
    expect(diff.counts).toEqual({ added: 1, removed: 1, modified: 2 });
  });
});

describe("mergeDbml", () => {
  const document = writeLayout("Table users {\n  id int [pk]\n}\n", { users: { x: 10, y: 20 } });

  it("adds only what the document does not already declare, keeping the layout", () => {
    const merged = mergeDbml(
      document,
      "// a model's commentary\nTable users {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  user_id int\n}\nRef: orders.user_id > users.id\nRef:  orders.user_id  >  users.id",
    );
    const { source, positions } = readLayout(merged);
    expect(positions).toEqual({ users: { x: 10, y: 20 } });
    expect(source.match(/Table users/g)).toHaveLength(1);
    expect(source).toContain("Table orders");
    expect(source.match(/Ref:/g)).toHaveLength(1);
    expect(source).not.toContain("commentary");
    expect(parseDbml(merged).error).toBeNull();
  });

  it("returns the document untouched when nothing is new", () => {
    expect(mergeDbml(document, "Table USERS {\n  id int\n}")).toBe(document);
    expect(mergeDbml(document, "   ")).toBe(document);
  });
});
