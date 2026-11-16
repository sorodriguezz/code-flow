import { beforeEach, describe, expect, it, vi } from "vitest";

const registered: { provider: any } = { provider: null };

vi.mock("../monacoSetup", () => ({
  monaco: {
    languages: {
      CompletionItemKind: { Field: 3, Struct: 6, Module: 8, Keyword: 17 },
      CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
      registerCompletionItemProvider: (_lang: string, provider: unknown) => {
        registered.provider = provider;
        return { dispose() {} };
      },
    },
    editor: { getModels: () => [] },
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("../inlineCompletion", () => ({ registerCompletionContext: () => {} }));

import { nodeKey, useDbStore } from "../../state/dbStore";
import type { DbNode, DbNodeRef } from "../../types/database";
import { installSqlCompletions } from "./sqlCompletion";

const CONNECTION = "c1";

function node(kind: DbNode["kind"], name: string, extra: Partial<DbNode> = {}): DbNode {
  return { id: `${kind}:${name}`, kind, name, detail: "", database: null, schema: null, table: null, has_children: true, column: null, ...extra } as DbNode;
}

function seed(children: Array<[DbNodeRef, DbNode[]]>, tab: { database: string; schema: string }) {
  const map: Record<string, DbNode[]> = {};
  for (const [ref, nodes] of children) map[nodeKey(CONNECTION, ref)] = nodes;
  useDbStore.setState({
    children: map,
    tabs: [{ id: "t1", kind: "console", connectionId: CONNECTION, consoleId: null, name: "c", body: "", database: tab.database, schema: tab.schema, maxRows: 100, dirty: false, running: false, runId: null } as never],
  });
}

/** Asks the provider for the list at the end of `text`, as if `.` had just been typed. */
function complete(text: string): string[] {
  const column = text.length + 1;
  const word = /\w*$/.exec(text)![0];
  const model = {
    uri: { toString: () => "cf-db:/console/t1.sql" },
    getValue: () => text,
    getOffsetAt: () => text.length,
    getWordUntilPosition: () => ({ word, startColumn: column - word.length, endColumn: column }),
    getValueInRange: () => text,
  };
  const trigger = text.endsWith(".") ? { triggerKind: 1, triggerCharacter: "." } : { triggerKind: 0 };
  const list = registered.provider.provideCompletionItems(model, { lineNumber: 1, column }, trigger);
  return list.suggestions.map((s: { label: string | { label: string } }) => (typeof s.label === "string" ? s.label : s.label.label));
}

const pgDatabase: DbNodeRef = { kind: "database", database: "app", schema: null, name: null };
const publicTables: DbNodeRef = { kind: "table_folder", database: "app", schema: "public", name: null };
const publicViews: DbNodeRef = { kind: "view_folder", database: "app", schema: "public", name: null };
const usersColumns: DbNodeRef = { kind: "column_folder", database: "app", schema: "public", name: "users" };

describe("sql completion after a dot", () => {
  beforeEach(() => {
    installSqlCompletions();
    seed(
      [
        [pgDatabase, [node("schema", "public"), node("schema", "audit")]],
        [publicTables, [node("table", "users"), node("table", "orders")]],
        [publicViews, [node("view", "active_users")]],
        [usersColumns, [node("column", "id"), node("column", "email")]],
        [{ kind: "root", database: null, schema: null, name: null }, [node("database", "app")]],
      ],
      { database: "app", schema: "public" },
    );
  });

  it("offers a schema's tables right after `from schema.`", () => {
    expect(complete("select * from public.")).toEqual(["users", "orders", "active_users"]);
  });

  it("still offers them once a letter is typed", () => {
    expect(complete("select * from public.us")).toEqual(["users", "orders", "active_users"]);
  });

  it("offers an alias's columns", () => {
    expect(complete("select * from users u where u.")).toEqual(["id", "email"]);
  });

  it("offers a table's columns when it is used as a qualifier without an alias", () => {
    expect(complete("select users.")).toEqual(["id", "email"]);
  });

  it("offers the closest tables when the qualifier names no schema or database", () => {
    expect(complete("select * from user.")).toEqual(["users", "active_users"]);
    const item = registered.provider.provideCompletionItems(
      { uri: { toString: () => "cf-db:/console/t1.sql" }, getValue: () => "select * from user.", getOffsetAt: () => 19,
        getWordUntilPosition: () => ({ word: "", startColumn: 20, endColumn: 20 }), getValueInRange: () => "select * from user." },
      { lineNumber: 1, column: 20 }, { triggerKind: 1, triggerCharacter: "." },
    ).suggestions[0];
    expect(item.range.startColumn).toBe(15);
    expect(item.filterText).toBe("user.");
    expect(complete("select * from zzz.")).toEqual([]);
  });

  it("offers the schemas after the console's own database name", () => {
    expect(complete("select * from app.")).toEqual(["public", "audit"]);
  });

  it("offers another database's tables where there is no schema level", () => {
    seed(
      [
        [{ kind: "database", database: "shop", schema: null, name: null }, [node("table_folder", "Tables")]],
        [{ kind: "root", database: null, schema: null, name: null }, [node("database", "shop"), node("database", "crm")]],
        [{ kind: "table_folder", database: "crm", schema: null, name: null }, [node("table", "leads")]],
        [{ kind: "view_folder", database: "crm", schema: null, name: null }, []],
      ],
      { database: "shop", schema: "" },
    );
    expect(complete("select * from crm.")).toEqual(["leads"]);
  });
});
