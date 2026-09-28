import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelChoice, KernelEvent } from "../lib/tauri/notebookCommands";

/**
 * A notebook's life against a kernel and an editor tab that are both faked at the IPC boundary:
 * what the kernel's events do to the file, and that every change — typed, printed, generated —
 * ends up in the tab, which is what the editor saves.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];
let eventListener: ((events: KernelEvent[]) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "notebook:kernel-events") eventListener = (events) => handler({ payload: events });
    return () => {};
  },
  emit: async () => {},
}));
vi.mock("./notificationStore", () => ({ notify: () => {} }));

const { notebookActions, useNotebookStore, reduceKernelEvents, pickKernel, assistRequest } = await import("./notebookStore");
const { registerNotebookHost, notebookKey } = await import("../lib/notebook/host");
const { parseNotebook, cellOutputs, cellSource, executionCount } = await import("../lib/notebook/nbformat");
const { newOutputState } = await import("../lib/notebook/outputs");
const { proposalDiff, changesNothing } = await import("../lib/notebook/aiDiff");

const REPO = "/repo";
const PATH = "analysis.ipynb";

const notebookText = JSON.stringify({
  cells: [
    { cell_type: "code", execution_count: null, id: "c1", metadata: {}, outputs: [], source: "print('a')" },
    { cell_type: "code", execution_count: null, id: "c2", metadata: {}, outputs: [], source: "x = input()" },
    { cell_type: "markdown", id: "m1", metadata: {}, source: "# Notas" },
  ],
  metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
});

const python: KernelChoice = {
  id: "spec:python3",
  name: "python3",
  displayName: "Python 3",
  language: "python",
  argv: ["python3"],
  env: {},
  interruptMode: "signal",
  source: "jupyter",
  resourceDir: null,
  python: null,
};

/** The editor's tab, as far as the notebook can tell. */
let tab = "";
let writes = 0;

function message(kernelId: string, channel: "iopub" | "shell" | "stdin", msgType: string, parent: string, content: Record<string, unknown>): KernelEvent {
  return { type: "message", kernelId, channel, msgType, msgId: crypto.randomUUID(), parentMsgId: parent, content: content as never, metadata: {} };
}

async function settle(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  handlers = {
    notebook_discover_kernels: () => ({ kernels: [python], withoutIpykernel: [] }),
    notebook_kernel_start: () => ({ language_info: { name: "python", version: "3.12.4" } }),
    get_setting: () => null,
  };
  calls = [];
  tab = notebookText;
  writes = 0;
  for (const key of Object.keys(useNotebookStore.getState().sessions)) void notebookActions.close(key);
  registerNotebookHost(REPO, {
    read: () => tab,
    write: (_path, text) => {
      tab = text;
      writes += 1;
    },
  });
});

function open(): string {
  return notebookActions.open({ repoPath: REPO, path: PATH, projectId: "p1", workspaceId: "w1", text: tab });
}

const doc = () => parseNotebook(tab);
const cell = (id: string) => doc().cells.find((c) => c.key === id)!;

describe("the tab is the file", () => {
  it("writes an edit into the tab at once, and nothing when nothing changed", () => {
    const key = open();
    expect(writes).toBe(0);
    notebookActions.setSource(key, "c1", "print('b')");
    expect(writes).toBe(1);
    expect(cellSource(cell("c1"))).toBe("print('b')");
    notebookActions.setSource(key, "c1", "print('b')");
    expect(writes).toBe(1);
  });

  it("takes a change made outside — a reload, the JSON view — as the notebook", () => {
    const key = open();
    const reloaded = JSON.parse(notebookText);
    reloaded.cells[0].source = "print('from disk')";
    tab = JSON.stringify(reloaded);
    notebookActions.sync(key, tab);
    expect(cellSource(useNotebookStore.getState().sessions[key].doc!.cells[0])).toBe("print('from disk')");
    // And an edit afterwards is made on top of it, not on top of the old text.
    notebookActions.setSource(key, "c2", "y = 1");
    expect(cellSource(cell("c1"))).toBe("print('from disk')");
    expect(cellSource(cell("c2"))).toBe("y = 1");
  });

  it("says what is wrong with text that is not a notebook", () => {
    tab = "{ not json";
    const key = open();
    const session = useNotebookStore.getState().sessions[key];
    expect(session.doc).toBeNull();
    expect(session.parseError).toBeTruthy();
  });

  it("deletes a cell and brings it back", () => {
    const key = open();
    notebookActions.remove(key, "c2");
    expect(doc().cells.map((c) => c.key)).toEqual(["c1", "m1"]);
    notebookActions.undoDelete(key);
    expect(doc().cells.map((c) => c.key)).toEqual(["c1", "c2", "m1"]);
    expect(cellSource(cell("c2"))).toBe("x = input()");
  });
});

describe("running", () => {
  it("queues, runs and fills a cell, with its output written into the tab", async () => {
    const key = open();
    await notebookActions.run(key, ["c1"]);
    const execute = calls.find((c) => c.name === "notebook_kernel_execute")!;
    expect(execute.args.code).toBe("print('a')");
    const kernelId = String(execute.args.kernelId);
    const msgId = String(execute.args.msgId);
    expect(useNotebookStore.getState().sessions[key].runs.c1).toEqual({ status: "queued", msgId });
    // The kernel's language went into the notebook with the run.
    expect((doc().top.metadata as Record<string, unknown>).language_info).toEqual({ name: "python", version: "3.12.4" });

    eventListener!([
      message(kernelId, "iopub", "status", msgId, { execution_state: "busy" }),
      message(kernelId, "iopub", "execute_input", msgId, { code: "print('a')", execution_count: 1 }),
      message(kernelId, "iopub", "stream", msgId, { name: "stdout", text: "a\n" }),
    ]);
    expect(useNotebookStore.getState().sessions[key].runs.c1.status).toBe("running");
    expect(useNotebookStore.getState().sessions[key].kernel?.status).toBe("busy");
    eventListener!([
      message(kernelId, "shell", "execute_reply", msgId, { status: "ok", execution_count: 1 }),
      message(kernelId, "iopub", "status", msgId, { execution_state: "idle" }),
    ]);
    const session = useNotebookStore.getState().sessions[key];
    expect(session.runs).toEqual({});
    expect(session.kernel?.status).toBe("idle");
    // Output is written to the tab a moment later, in a batch.
    await settle(150);
    // Split into lines, as Jupyter writes it.
    expect(cellOutputs(cell("c1"))).toEqual([{ name: "stdout", output_type: "stream", text: ["a\n"] }]);
    expect(executionCount(cell("c1"))).toBe(1);
  });

  it("answers input() and drops the run when the kernel dies", async () => {
    const key = open();
    await notebookActions.run(key, ["c2"]);
    const execute = calls.find((c) => c.name === "notebook_kernel_execute")!;
    const kernelId = String(execute.args.kernelId);
    const msgId = String(execute.args.msgId);
    eventListener!([
      message(kernelId, "iopub", "execute_input", msgId, { code: "x = input()", execution_count: 2 }),
      message(kernelId, "stdin", "input_request", msgId, { prompt: "name? ", password: false }),
    ]);
    expect(useNotebookStore.getState().sessions[key].input).toEqual({ cellKey: "c2", prompt: "name? ", password: false });
    await notebookActions.answerInput(key, "Ana");
    expect(calls.find((c) => c.name === "notebook_kernel_input")?.args).toEqual({ kernelId, value: "Ana" });
    expect(useNotebookStore.getState().sessions[key].input).toBeNull();

    eventListener!([{ type: "lifecycle", kernelId, lifecycle: { state: "died", code: 1, stderr: "Segmentation fault" } }]);
    const session = useNotebookStore.getState().sessions[key];
    expect(session.kernel?.status).toBe("dead");
    expect(session.kernel?.error).toContain("Segmentation fault");
    expect(session.runs).toEqual({});
  });

  it("clears an empty cell without sending it", async () => {
    const key = open();
    notebookActions.setSource(key, "c1", "   ");
    await notebookActions.run(key, ["c1"]);
    expect(calls.some((c) => c.name === "notebook_kernel_execute")).toBe(false);
  });

  it("offers ipykernel's install when no kernel exists", async () => {
    handlers.notebook_discover_kernels = () => ({
      kernels: [],
      withoutIpykernel: [{ path: "/usr/bin/python3", label: "PATH", version: "3.9.6", source: "path" }],
    });
    const key = open();
    await notebookActions.run(key, ["c1"]);
    const session = useNotebookStore.getState().sessions[key];
    expect(session.noKernel).toBe(true);
    expect(session.runs).toEqual({});
    expect(calls.some((c) => c.name === "notebook_kernel_start")).toBe(false);
  });
});

describe("reduceKernelEvents", () => {
  const base = () => {
    const parsed = parseNotebook(notebookText);
    return {
      doc: parsed,
      kernel: { kernelId: "k", choice: python, status: "idle" as const, info: null, error: null },
      runs: { c1: { status: "queued" as const, msgId: "m1" } },
      input: null,
      docChanged: false,
    };
  };

  it("merges a stream across batches and applies carriage returns", () => {
    const cells = new Map([["m1", "c1"]]);
    const state = newOutputState();
    let result = reduceKernelEvents(base(), [message("k", "iopub", "stream", "m1", { name: "stdout", text: "10%\r" })], cells, state);
    result = reduceKernelEvents(
      result,
      [
        message("k", "iopub", "stream", "m1", { name: "stdout", text: "60%\r" }),
        message("k", "iopub", "stream", "m1", { name: "stdout", text: "100%\ndone\n" }),
      ],
      cells,
      state,
    );
    expect(result.docChanged).toBe(true);
    expect(cellOutputs(result.doc!.cells[0])).toEqual([{ name: "stdout", output_type: "stream", text: "100%\ndone\n" }]);
  });

  it("updates a display shown by another cell", () => {
    const cells = new Map([
      ["m1", "c1"],
      ["m2", "c2"],
    ]);
    const state = newOutputState();
    const start = { ...base(), runs: { c1: { status: "running" as const, msgId: "m1" }, c2: { status: "running" as const, msgId: "m2" } } };
    const shown = reduceKernelEvents(
      start,
      [message("k", "iopub", "display_data", "m1", { data: { "text/plain": "0%" }, metadata: {}, transient: { display_id: "bar" } })],
      cells,
      state,
    );
    const updated = reduceKernelEvents(
      shown,
      [message("k", "iopub", "update_display_data", "m2", { data: { "text/plain": "100%" }, metadata: {}, transient: { display_id: "bar" } })],
      cells,
      state,
    );
    expect(cellOutputs(updated.doc!.cells[0])[0].data).toEqual({ "text/plain": "100%" });
    expect(cellOutputs(updated.doc!.cells[1])).toEqual([]);
  });

  it("drops a run the kernel aborted, and ignores other kernels", () => {
    const cells = new Map([["m1", "c1"]]);
    const aborted = reduceKernelEvents(base(), [message("k", "shell", "execute_reply", "m1", { status: "aborted" })], cells, newOutputState());
    expect(aborted.runs).toEqual({});
    expect(executionCount(aborted.doc!.cells[0])).toBeNull();
    const foreign = reduceKernelEvents(base(), [message("other", "iopub", "stream", "m1", { name: "stdout", text: "x" })], cells, newOutputState());
    expect(foreign.docChanged).toBe(false);
  });
});

describe("choosing a kernel", () => {
  const venv: KernelChoice = { ...python, id: "python:/repo/.venv/bin/python3", source: "venv", displayName: "Python 3.12 (.venv)" };
  const ir: KernelChoice = { ...python, id: "spec:ir", name: "ir", language: "r", displayName: "R" };

  it("prefers what was picked, then a specific kernelspec, then the project's virtualenv", () => {
    expect(pickKernel([python, venv, ir], { name: "python3", language: "python" }, null)).toBe(venv);
    expect(pickKernel([python, venv, ir], { name: "python3", language: "python" }, "spec:python3")).toBe(python);
    expect(pickKernel([python, venv, ir], { name: "ir", language: "R" }, null)).toBe(ir);
    expect(pickKernel([python, ir], { name: "", language: "r" }, null)).toBe(ir);
    expect(pickKernel([], null, null)).toBeNull();
  });
});

describe("AI on a cell", () => {
  it("builds the context around the cell and keeps the answer until it is accepted", async () => {
    let asked: Record<string, unknown> | null = null;
    handlers.notebook_ai = (args) => {
      asked = args;
      return "# suma uno\nprint('a' * 2)";
    };
    const key = open();
    await notebookActions.askAi(key, "c1", "document", null);
    const request = (asked as unknown as { request: ReturnType<typeof assistRequest>; workspaceId: string }).request;
    expect(request.action).toBe("document");
    expect(request.target?.source).toBe("print('a')");
    expect(request.after.map((c) => c.source)).toEqual(["x = input()", "# Notas"]);
    expect((asked as unknown as { workspaceId: string }).workspaceId).toBe("w1");

    // Not applied by itself.
    expect(cellSource(cell("c1"))).toBe("print('a')");
    const run = useNotebookStore.getState().sessions[key].ai.c1;
    expect(run.status).toBe("ready");
    expect(proposalDiff(cellSource(cell("c1")), run.answer!)).toEqual([
      { kind: "removed", text: "print('a')" },
      { kind: "added", text: "# suma uno" },
      { kind: "added", text: "print('a' * 2)" },
    ]);
    notebookActions.acceptAi(key, "c1");
    expect(cellSource(cell("c1"))).toBe("# suma uno\nprint('a' * 2)");
    expect(useNotebookStore.getState().sessions[key].ai.c1).toBeUndefined();
  });

  it("inserts a generated cell below, and drops an answer whose cell is gone", async () => {
    let answer: (value: string) => void = () => {};
    handlers.notebook_ai = () => new Promise<string>((resolve) => (answer = resolve));
    const key = open();
    const pending = notebookActions.askAi(key, "c1", "generate", "plot it");
    await settle();
    answer("import matplotlib");
    await pending;
    notebookActions.acceptAi(key, "c1");
    expect(doc().cells.map((c) => cellSource(c))).toEqual(["print('a')", "import matplotlib", "x = input()", "# Notas"]);

    const late = notebookActions.askAi(key, "c2", "fix", null);
    await settle();
    notebookActions.remove(key, "c2");
    answer("fixed");
    await late;
    expect(useNotebookStore.getState().sessions[key].ai.c2).toBeUndefined();
  });

  it("reads the diff of a generated cell as added lines", () => {
    expect(proposalDiff("", "a\nb\n")).toEqual([
      { kind: "added", text: "a" },
      { kind: "added", text: "b" },
    ]);
    expect(changesNothing("x = 1\n", "x = 1")).toBe(true);
  });
});

describe("closing", () => {
  it("stops the kernel of a notebook whose tab closed", async () => {
    const key = open();
    await notebookActions.run(key, ["c1"]);
    const kernelId = String(calls.find((c) => c.name === "notebook_kernel_execute")!.args.kernelId);
    expect(notebookActions.isBusy(REPO, PATH)).toBe(true);
    notebookActions.syncOpenNotebooks(REPO, []);
    await settle();
    expect(calls.some((c) => c.name === "notebook_kernel_shutdown" && c.args.kernelId === kernelId)).toBe(true);
    expect(useNotebookStore.getState().sessions[notebookKey(REPO, PATH)]).toBeUndefined();
  });
});
