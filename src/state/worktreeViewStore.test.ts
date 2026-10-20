import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri/commands", () => ({ getSetting: async () => null, setSetting: async () => {} }));
vi.mock("../lib/tauri/gitCommands", () => ({ listWorktrees: async () => [] }));
vi.mock("../lib/settingsSync", () => ({ watchSettings: () => {} }));
const { useWorktreeViewStore } = await import("./worktreeViewStore");

const task = (id: string, turns: number) => ({ id, turns }) as never;

describe("observe", () => {
  it("starts every task's marks from now, so nothing already read lights up", () => {
    useWorktreeViewStore.setState({ seenTurns: {} });
    useWorktreeViewStore.getState().observe([task("a", 3), task("b", 0)], null);
    expect(useWorktreeViewStore.getState().seenTurns).toEqual({ a: 3, b: 0 });
  });

  it("keeps a closed task's count, so its next turn reads as unread", () => {
    useWorktreeViewStore.setState({ seenTurns: { a: 3, b: 0 } });
    useWorktreeViewStore.getState().observe([task("a", 4), task("b", 1)], "b");
    // `a` was not open when its turn landed; `b` was.
    expect(useWorktreeViewStore.getState().seenTurns).toEqual({ a: 3, b: 1 });
  });

  it("writes nothing when nothing moved", () => {
    const seen = { a: 3 };
    useWorktreeViewStore.setState({ seenTurns: seen });
    useWorktreeViewStore.getState().observe([task("a", 3)], "a");
    expect(useWorktreeViewStore.getState().seenTurns).toBe(seen);
  });
});

describe("setCliTerminal", () => {
  it("remembers a row's CLI terminal and forgets it", () => {
    useWorktreeViewStore.setState({ cliTerminal: {} });
    useWorktreeViewStore.getState().setCliTerminal("task:a", "term-1");
    expect(useWorktreeViewStore.getState().cliTerminal).toEqual({ "task:a": "term-1" });
    useWorktreeViewStore.getState().setCliTerminal("task:a", null);
    expect(useWorktreeViewStore.getState().cliTerminal).toEqual({});
  });
});

describe("filing working copies", () => {
  it("files by folder, stores the default status as nothing, and toggles a pin", () => {
    useWorktreeViewStore.setState({ lanes: {}, pinned: [] });
    const store = useWorktreeViewStore.getState();
    store.setLane("C:\\Work\\App\\", "review");
    expect(useWorktreeViewStore.getState().lanes).toEqual({ "c:/work/app": "review" });
    store.setLane("c:/work/app", "progress");
    expect(useWorktreeViewStore.getState().lanes).toEqual({});
    store.togglePin("/src/app/");
    expect(useWorktreeViewStore.getState().pinned).toEqual(["/src/app"]);
    store.togglePin("/src/app");
    expect(useWorktreeViewStore.getState().pinned).toEqual([]);
  });

  it("reads a stored row back, dropping what it does not recognise", async () => {
    const raw = JSON.stringify({
      lanes: { "/a": "review", "/b": "sleeping" },
      pinned: ["/a", 3],
      names: { "/a": "Login", "/b": "  " },
      grouping: "project",
      folded: ["lane:done"],
      repoFilter: "p1",
    });
    vi.resetModules();
    vi.doMock("../lib/tauri/commands", () => ({ getSetting: async () => raw, setSetting: async () => {} }));
    const fresh = (await import("./worktreeViewStore")).useWorktreeViewStore;
    await fresh.getState().load();
    expect(fresh.getState()).toMatchObject({
      lanes: { "/a": "review" },
      pinned: ["/a"],
      names: { "/a": "Login" },
      grouping: "project",
      folded: ["lane:done"],
      repoFilter: "p1",
    });
  });
});

