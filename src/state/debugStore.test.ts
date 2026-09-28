import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The debugger's state: breakpoints that belong to a workspace and follow the code, watches asked
 * again at every stop, exception filters, the Python it picks, and the session it recovers after a
 * webview reload. The backend is a scripted `invoke`; events are fired by hand.
 */

type Args = Record<string, unknown>;
let settings: Record<string, string> = {};
let calls: Array<{ name: string; args: Args }> = [];
let replies: Record<string, (args: Args) => unknown> = {};
const handlers: Record<string, (event: { payload: unknown }) => void> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Args = {}) => {
    calls.push({ name, args });
    if (name in replies) return replies[name](args);
    if (name === "get_setting") return settings[args.key as string] ?? null;
    if (name === "set_setting") {
      settings[args.key as string] = args.value as string;
      return null;
    }
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers[name] = handler;
    return () => {};
  },
  emit: async () => {},
}));

const { useDebugStore, parseBreakpoints, specsFor } = await import("./debugStore");
const { adapterById } = await import("../lib/debugAdapters");

/** Past the store's write debounce, and every promise queued before it. */
const settle = (ms = 320) => new Promise((resolve) => setTimeout(resolve, ms));
const sent = (name: string) => calls.filter((call) => call.name === name);
/** The last call of that name. */
const lastSent = (name: string) => {
  const list = sent(name);
  return list[list.length - 1];
};

describe("stored breakpoints", () => {
  it("read back, a bad row costs only itself, and bare line numbers still count", () => {
    const stored = JSON.stringify({
      "C:\\repo\\a.js": [3, { line: 5, enabled: false, condition: "x" }, { line: "x" }, { line: 0 }, 3],
      "/b.js": "nope",
    });
    expect(parseBreakpoints(stored)).toEqual({
      "C:/repo/a.js": [
        { line: 3, enabled: true },
        { line: 5, enabled: false, condition: "x" },
      ],
    });
    expect(parseBreakpoints("{not json")).toEqual({});
    expect(parseBreakpoints(null)).toEqual({});
  });

  it("send a session only what is enabled, and an empty list for a file that has none left", () => {
    const specs = specsFor(
      {
        "/a.js": [
          { line: 3, enabled: true, condition: "i > 1" },
          { line: 4, enabled: false },
          { line: 9, enabled: true, logMessage: "i={i}" },
        ],
      },
      new Set(["/a.js", "/gone.js"]),
    );
    expect(specs).toEqual({
      "/a.js": [
        { line: 3, condition: "i > 1" },
        { line: 9, logMessage: "i={i}" },
      ],
      "/gone.js": [],
    });
  });
});

describe("debugStore", () => {
  beforeEach(async () => {
    settings = {};
    calls = [];
    replies = {};
    useDebugStore.setState({ workspaceId: null, breakpoints: {}, watches: [], watchValues: {}, status: "idle" });
    await useDebugStore.getState().loadWorkspace("w1");
  });

  it("keeps breakpoints per workspace and follows the one on screen", async () => {
    const store = useDebugStore.getState();
    store.toggleBreakpoint("/r/a.js", 3);
    await settle();
    expect(JSON.parse(settings["debug_breakpoints:w1"])).toEqual({ "/r/a.js": [{ line: 3, enabled: true }] });

    await useDebugStore.getState().loadWorkspace("w2");
    expect(useDebugStore.getState().breakpoints).toEqual({});
    useDebugStore.getState().toggleBreakpoint("/r/b.js", 7);
    await settle();
    expect(JSON.parse(settings["debug_breakpoints:w2"])).toEqual({ "/r/b.js": [{ line: 7, enabled: true }] });
    // Nothing set in the second workspace was filed under the first.
    expect(JSON.parse(settings["debug_breakpoints:w1"])).toEqual({ "/r/a.js": [{ line: 3, enabled: true }] });

    await useDebugStore.getState().loadWorkspace("w1");
    expect(useDebugStore.getState().breakpoints).toEqual({ "/r/a.js": [{ line: 3, enabled: true }] });
  });

  it("moves breakpoints with an edit without sending them to the running program", async () => {
    const store = useDebugStore.getState();
    store.toggleBreakpoint("/a.js", 10);
    store.toggleBreakpoint("/a.js", 20);
    expect(lastSent("debug_set_breakpoints")?.args.breakpoints).toEqual({ "/a.js": [{ line: 10 }, { line: 20 }] });

    calls = [];
    useDebugStore.getState().moveBreakpoints("/a.js", [[10, 12], [20, 20]]);
    expect(useDebugStore.getState().breakpoints["/a.js"].map((bp) => bp.line)).toEqual([12, 20]);
    expect(sent("debug_set_breakpoints")).toHaveLength(0);

    // Two panes on one file both report the same edit; the second report must not move them again.
    useDebugStore.getState().moveBreakpoints("/a.js", [[12, 13], [20, 21]]);
    useDebugStore.getState().moveBreakpoints("/a.js", [[12, 13], [20, 21]]);
    expect(useDebugStore.getState().breakpoints["/a.js"].map((bp) => bp.line)).toEqual([13, 21]);

    // Two collapsing onto one line — the lines between them deleted — leave one.
    useDebugStore.getState().moveBreakpoints("/a.js", [[13, 15], [21, 15]]);
    expect(useDebugStore.getState().breakpoints["/a.js"].map((bp) => bp.line)).toEqual([15]);
    await settle();
    expect(JSON.parse(settings["debug_breakpoints:w1"])["/a.js"]).toEqual([{ line: 15, enabled: true }]);
  });

  it("clears a file on the session once its last breakpoint goes", () => {
    const store = useDebugStore.getState();
    store.toggleBreakpoint("/a.js", 3);
    store.toggleBreakpoint("/a.js", 3);
    expect(lastSent("debug_set_breakpoints")?.args.breakpoints).toEqual({ "/a.js": [] });
    // And having been cleared, it is not sent again.
    useDebugStore.getState().toggleBreakpoint("/b.js", 1);
    expect(lastSent("debug_set_breakpoints")?.args.breakpoints).toEqual({ "/b.js": [{ line: 1 }] });
  });

  it("gives a breakpoint a condition, a log message, or switches it off", () => {
    const store = useDebugStore.getState();
    store.setBreakpoint("/a.js", 3, { condition: "i > 3" });
    store.setBreakpoint("/a.js", 5, { logMessage: "total={total}" });
    store.setBreakpoint("/a.js", 7, {});
    store.setBreakpoint("/a.js", 7, { enabled: false });
    expect(lastSent("debug_set_breakpoints")?.args.breakpoints).toEqual({
      "/a.js": [{ line: 3, condition: "i > 3" }, { line: 5, logMessage: "total={total}" }],
    });
    // A cleared condition is no condition.
    useDebugStore.getState().setBreakpoint("/a.js", 3, { condition: "  " });
    expect(useDebugStore.getState().breakpoints["/a.js"][0]).toEqual({ line: 3, enabled: true });
  });

  it("asks every watch again at each stop, in the selected frame, as a watch", async () => {
    replies = {
      debug_scopes: () => [
        { name: "Local", value: "", object_id: "s1" },
        { name: "Global", value: "", object_id: "g1" },
      ],
      debug_properties: (args) => (args.objectId === "s1" ? [{ name: "a", value: "1", object_id: null }] : []),
      debug_evaluate: (args) => {
        if (args.expression === "boom") throw "ReferenceError: boom is not defined";
        return { name: "", value: `${args.frameId}:42`, object_id: null };
      },
    };
    const store = useDebugStore.getState();
    store.init();
    store.addWatch("a + 1");
    store.addWatch("boom");
    store.addWatch("a + 1");
    expect(useDebugStore.getState().watches).toEqual(["a + 1", "boom"]);

    const frames = [
      { id: "f1", name: "inner", file: "/a.js", line: 3, scope_id: "s1" },
      { id: "f2", name: "outer", file: "/a.js", line: 9, scope_id: null },
    ];
    handlers["debug:paused"]({ payload: { reason: "exception", frames, description: "TypeError: x" } });
    await settle(30);
    const state = useDebugStore.getState();
    expect(state.status).toBe("paused");
    expect(state.pauseDescription).toBe("TypeError: x");
    expect(state.scopes.map((scope) => scope.name)).toEqual(["Local", "Global"]);
    // The innermost scope opened by itself; the global one did not.
    expect(state.expanded.s1).toEqual([{ name: "a", value: "1", object_id: null }]);
    expect(state.expanded.g1).toBeUndefined();
    expect(state.watchValues["a + 1"]).toEqual({ value: "f1:42", error: false, objectId: null });
    expect(state.watchValues.boom.error).toBe(true);
    expect(sent("debug_evaluate").every((call) => call.args.context === "watch")).toBe(true);

    // Any frame, not only the top one: its own scopes, and the watches asked there.
    await useDebugStore.getState().selectFrame(1);
    expect(lastSent("debug_scopes")?.args.frameId).toBe("f2");
    expect(useDebugStore.getState().watchValues["a + 1"].value).toBe("f2:42");

    handlers["debug:resumed"]({ payload: null });
    expect(useDebugStore.getState().watchValues).toEqual({});
    await settle();
    expect(JSON.parse(settings["debug_watches:w1"])).toEqual(["a + 1", "boom"]);
  });

  it("runs Python under the project's own interpreter unless told another", async () => {
    replies = {
      debug_python: () => ({ adapter: "/p/.venv/bin/python", interpreter: "/p/.venv/bin/python" }),
      debug_start_adapter: () => [{ filter: "uncaught", label: "Uncaught", default: true }],
    };
    const python = adapterById("python");
    // `python` is exactly what macOS does not have.
    expect(python.command).toBe("python3");
    await useDebugStore.getState().start("/p", "/p/app.py", python, "python3");
    const start = lastSent("debug_start_adapter")!.args;
    expect(start.command).toBe("/p/.venv/bin/python");
    expect((start.launchConfig as Args).python).toEqual(["/p/.venv/bin/python"]);
    // Never chosen for this adapter: its own defaults apply, on the backend's side.
    expect(start.exceptionFilters).toBeNull();
    expect(useDebugStore.getState().enabledFiltersFor("python")).toEqual(["uncaught"]);

    // A choice made during the session reaches it.
    calls = [];
    useDebugStore.getState().setExceptionFilter("python", "uncaught", false);
    expect(lastSent("debug_set_exception_filters")?.args.filters).toEqual([]);
    await settle();
    expect(JSON.parse(settings.debug_exception_filters)).toEqual({ python: [] });

    // A command typed by hand is run as it is.
    calls = [];
    await useDebugStore.getState().start("/p", "/p/app.py", python, "/opt/py/bin/python3.12");
    expect(sent("debug_python")).toHaveLength(0);
    expect(lastSent("debug_start_adapter")?.args.command).toBe("/opt/py/bin/python3.12");
  });

  it("starts Node with its exception filters", async () => {
    useDebugStore.getState().setExceptionFilter("node", "all", true);
    await useDebugStore.getState().start("/p", "/p/app.js", adapterById("node"));
    expect(lastSent("debug_start")?.args.exceptionFilters).toEqual(["all"]);
  });
});

describe("a session the panel did not start", () => {
  it("is picked up after a reload instead of showing idle", async () => {
    vi.resetModules();
    replies = {
      debug_is_running: () => true,
      debug_session: () => ({
        backend: "node",
        paused: {
          reason: "breakpoint",
          frames: [{ id: "f1", name: "main", file: "/a.js", line: 4, scope_id: "s1" }],
          description: null,
        },
        exceptionFilters: [{ filter: "uncaught", label: "Uncaught exceptions", default: false }],
      }),
      debug_scopes: () => [{ name: "Local", value: "", object_id: "s1" }],
      debug_properties: () => [],
    };
    const { useDebugStore: fresh } = await import("./debugStore");
    fresh.getState().init();
    await settle(30);
    const state = fresh.getState();
    expect(state.status).toBe("paused");
    expect(state.frames[0].line).toBe(4);
    expect(state.sessionDebugger).toBe("node");
    expect(state.scopes.map((scope) => scope.name)).toEqual(["Local"]);
  });
});
