import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Run in every worktree»: one tab, one pane per folder, the same line typed into all of them.
 *
 * What is pinned here is the arrangement, because every part of it is a thing the user counts on
 * screen — one tab and not three, a pane per worktree each standing in *its own* folder, and the
 * command reaching every one of them. The writes are what make it a run rather than three empty
 * shells.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let created = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { useBenchStore } = await import("./benchStore");

/** Every `(id, data)` written to a pty, in order. */
let writes: { id: string; data: string }[];
/** Every folder a shell was opened in, in order. */
let opened: string[];
let tabs: number;

beforeEach(() => {
  created = 0;
  writes = [];
  opened = [];
  tabs = 0;
  handlers = {
    add_bench_tab: () => {
      tabs += 1;
      return { id: `tab-${tabs}`, workspace_id: "w1", title: "", layout: "", sort_order: tabs };
    },
    add_workspace_terminal: (args) => {
      created += 1;
      opened.push(String(args.cwd));
      return { id: `term-${created}`, workspace_id: "w1", tab_id: String(args.tabId), cwd: String(args.cwd), title: "" };
    },
    set_bench_layout: () => null,
    rename_workspace_terminal: () => null,
    write_terminal: (args) => {
      writes.push({ id: String(args.id), data: String(args.data) });
      return null;
    },
  };
  useBenchStore.setState({ workspaceId: "w1", tabs: [], terminals: [], layouts: {}, activeTabId: null, focusedPane: {} });
});

const PANES = [
  { cwd: "/wt/uno", title: "agent/uno" },
  { cwd: "/wt/dos", title: "agent/dos" },
  { cwd: "/wt/tres", title: "agent/tres" },
];

describe("runAcross", () => {
  it("opens one tab with a pane per folder, each standing in its own", async () => {
    const tabId = await useBenchStore.getState().runAcross("w1", PANES, "pnpm test");
    expect(tabId).toBe("tab-1");
    expect(tabs).toBe(1);
    expect(opened).toEqual(["/wt/uno", "/wt/dos", "/wt/tres"]);
    expect(useBenchStore.getState().terminals).toHaveLength(3);
  });

  it("types the command into every one of them", async () => {
    await useBenchStore.getState().runAcross("w1", PANES, "  pnpm test  ");
    expect(writes.map((write) => write.id)).toEqual(["term-1", "term-2", "term-3"]);
    // A pty is a terminal: Enter is a carriage return, and the line arrives trimmed.
    expect(new Set(writes.map((write) => write.data))).toEqual(new Set(["pnpm test\r"]));
  });

  it("runs nothing on an empty command, so no tab is left behind", async () => {
    expect(await useBenchStore.getState().runAcross("w1", PANES, "   ")).toBeNull();
    expect(tabs).toBe(0);
    expect(writes).toEqual([]);
  });

  it("runs nothing when no racer has a worktree", async () => {
    expect(await useBenchStore.getState().runAcross("w1", [{ cwd: "  " }], "pnpm test")).toBeNull();
    expect(tabs).toBe(0);
  });

  /** One worktree is still a run: the panel offers it, and a single pane is a valid arrangement. */
  it("works for a single folder", async () => {
    await useBenchStore.getState().runAcross("w1", [PANES[0]], "pnpm test");
    expect(useBenchStore.getState().terminals).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it("keeps the panes side by side", async () => {
    const tabId = (await useBenchStore.getState().runAcross("w1", PANES, "pnpm test")) ?? "";
    const layout = JSON.stringify(useBenchStore.getState().layouts[tabId]);
    expect(layout).toContain('"dir":"row"');
    expect(layout).not.toContain('"dir":"col"');
  });
});

/**
 * A view pane is the arrangement and nothing else: no shell, no process, and closing it must not
 * ask the backend to remove a terminal that never existed.
 */
describe("addView", () => {
  it("opens a tab when the bench is empty and puts the view in it", async () => {
    await useBenchStore.getState().addView("w1", { kind: "diff", taskId: "task-1" });
    const state = useBenchStore.getState();
    const tabId = state.activeTabId ?? "";
    // One shell — the tab's own — and the view beside it.
    expect(state.terminals).toHaveLength(1);
    expect(JSON.stringify(state.layouts[tabId])).toContain('"kind":"diff"');
    expect(state.focusedPane[tabId]).toMatch(/^view:/);
  });

  it("costs no process of its own", async () => {
    await useBenchStore.getState().addView("w1", { kind: "diff", taskId: "task-1" });
    const before = created;
    await useBenchStore.getState().addView("w1", { kind: "diff", taskId: "task-2" });
    expect(created).toBe(before);
  });

  it("closes without touching a terminal that never existed", async () => {
    let removed = 0;
    handlers.remove_workspace_terminal = () => {
      removed += 1;
      return null;
    };
    await useBenchStore.getState().addView("w1", { kind: "diff", taskId: "task-1" });
    const tabId = useBenchStore.getState().activeTabId ?? "";
    const viewId = useBenchStore.getState().focusedPane[tabId];
    await useBenchStore.getState().closePane(tabId, viewId);
    expect(removed).toBe(0);
    expect(JSON.stringify(useBenchStore.getState().layouts[tabId])).not.toContain('"kind":"diff"');
  });
});

/**
 * A saved arrangement: panes with folders *and* commands of their own, which is what makes
 * «dev = server + tests + agent» one click instead of three shells and three command lines.
 */
describe("runPanes", () => {
  it("gives each pane its own folder and its own command", async () => {
    await useBenchStore.getState().runPanes("w1", [
      { cwd: "/repo", title: "server", command: "pnpm dev" },
      { cwd: "/repo", title: "tests", command: "pnpm test --watch" },
    ]);
    expect(opened).toEqual(["/repo", "/repo"]);
    expect(writes.map((write) => write.data)).toEqual(["pnpm dev\r", "pnpm test --watch\r"]);
  });

  it("leaves a pane with no command of its own at its prompt", async () => {
    await useBenchStore.getState().runPanes("w1", [
      { cwd: "/repo", command: "pnpm dev" },
      { cwd: "/repo" },
    ]);
    expect(useBenchStore.getState().terminals).toHaveLength(2);
    expect(writes).toHaveLength(1);
  });

  it("keeps a pane that has a command and no folder — a shell at home, running something", async () => {
    await useBenchStore.getState().runPanes("w1", [{ cwd: "", command: "htop" }]);
    expect(writes.map((write) => write.data)).toEqual(["htop\r"]);
  });

  it("runs nothing at all for an empty arrangement", async () => {
    expect(await useBenchStore.getState().runPanes("w1", [])).toBeNull();
    expect(tabs).toBe(0);
  });
});

describe("saved layouts", () => {
  it("round-trips through the settings row", async () => {
    const stored: Record<string, string> = {};
    handlers.set_setting = (args) => {
      stored[String(args.key)] = String(args.value);
      return null;
    };
    handlers.get_setting = (args) => stored[String(args.key)] ?? null;

    await useBenchStore.getState().saveLayout("w1", {
      name: "dev",
      panes: [{ cwd: "/repo", command: "pnpm dev" }],
    });
    useBenchStore.setState({ savedLayouts: [] });
    await useBenchStore.getState().loadSavedLayouts("w1");
    expect(useBenchStore.getState().savedLayouts).toEqual([
      { name: "dev", panes: [{ cwd: "/repo", command: "pnpm dev" }] },
    ]);
  });

  it("runs one, and names the tab after it", async () => {
    let renamed = "";
    handlers.rename_bench_tab = (args) => {
      renamed = String(args.title);
      return null;
    };
    useBenchStore.setState({
      savedLayouts: [{ name: "dev", panes: [{ cwd: "/repo", command: "pnpm dev" }] }],
    });
    const tabId = await useBenchStore.getState().runLayout("w1", "dev");
    expect(tabId).toBe("tab-1");
    expect(renamed).toBe("dev");
    expect(writes.map((write) => write.data)).toEqual(["pnpm dev\r"]);
  });

  it("does nothing for a name nobody saved", async () => {
    expect(await useBenchStore.getState().runLayout("w1", "nope")).toBeNull();
    expect(tabs).toBe(0);
  });
});
