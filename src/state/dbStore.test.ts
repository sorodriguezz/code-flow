import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbDataTab } from "./dbStore";

/**
 * A data tab's foreign keys — what the grid's "open the related row" arrows are drawn from. They
 * used to be asked for only when a tab was opened, so a tab restored after a restart or a reload
 * had none, and its arrows were gone for good (user report: "perdí la redirección que había").
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push(name);
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { useDbStore, DEFAULT_DATA_UI } = await import("./dbStore");
const { EMPTY_QUERY_OPTIONS } = await import("../types/database");

const FK = { column: "profesional_id", ref_schema: "public", ref_table: "profesionales", ref_column: "id" };
const NODE = { kind: "table" as const, database: "app", schema: "public", name: "citas" };

/** A data tab as `restoreTab` builds it at start-up: nothing loaded, no columns, no keys. */
function restoredTab(id: string): DbDataTab {
  return {
    id,
    kind: "data",
    connectionId: "c1",
    node: NODE,
    name: "citas",
    offset: 0,
    limit: 100,
    filter: "",
    filterDraft: "",
    options: EMPTY_QUERY_OPTIONS,
    optionsDraft: EMPTY_QUERY_OPTIONS,
    sort: [],
    loading: false,
    runId: null,
    countRunId: null,
    result: null,
    total: null,
    columns: [],
    foreignKeys: [],
    pending: {},
    deleted: [],
    inserted: [],
    replaced: {},
    insertedDocs: [],
    error: null,
    ui: DEFAULT_DATA_UI,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const tab = (id: string) => useDbStore.getState().tabs.find((entry) => entry.id === id) as DbDataTab;
const asked = () => calls.filter((name) => name === "db_foreign_keys").length;

beforeEach(() => {
  calls = [];
  handlers = {
    db_table_data: () => ({
      statement: "SELECT * FROM public.citas",
      columns: [{ name: "profesional_id", type_name: "int4" }],
      rows: [["5"]],
      duration_ms: 1,
    }),
    db_children: () => [{ kind: "column", name: "profesional_id" }],
    db_row_count: () => 1,
    db_foreign_keys: () => [FK],
    db_connected: () => [],
  };
  useDbStore.setState({ tabs: [], activeTabId: null });
});

describe("a data tab's foreign keys", () => {
  it("are asked for when a restored tab first loads", async () => {
    useDbStore.setState({ tabs: [restoredTab("t1")], activeTabId: "t1" });

    await useDbStore.getState().loadData("t1");
    await settle();

    expect(tab("t1").foreignKeys).toEqual([FK]);
    expect(asked()).toBe(1);
  });

  it("are not asked for again on the next page", async () => {
    useDbStore.setState({ tabs: [restoredTab("t1")], activeTabId: "t1" });
    await useDbStore.getState().loadData("t1");
    await settle();

    await useDbStore.getState().loadData("t1");
    await settle();

    expect(asked()).toBe(1);
  });

  it("are asked for once when a tab is opened", async () => {
    useDbStore.getState().openData("c1", NODE, "citas");
    for (let i = 0; i < 5; i++) await settle();

    const opened = useDbStore.getState().tabs.find((entry) => entry.kind === "data") as DbDataTab;
    expect(opened.foreignKeys).toEqual([FK]);
    expect(asked()).toBe(1);
  });

  it("leave the rows alone when the catalog refuses them", async () => {
    handlers.db_foreign_keys = () => {
      throw new Error("permission denied for pg_constraint");
    };
    useDbStore.setState({ tabs: [restoredTab("t1")], activeTabId: "t1" });

    await useDbStore.getState().loadData("t1");
    await settle();

    expect(tab("t1").foreignKeys).toEqual([]);
    expect(tab("t1").result?.rows).toEqual([["5"]]);
    expect(tab("t1").error).toBeNull();
  });
});
