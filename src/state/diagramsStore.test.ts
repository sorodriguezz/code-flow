import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagram, DiagramFileVersion, DiagramMetaRow, DiagramRow } from "../types/diagrams";

/**
 * A linked diagram's save, which used to write its `.dbml` over whatever was on disk: a `git pull`
 * in a repository the watcher was not following was silently put back by the next autosave. The
 * save now carries the version the diagram read, a refusal becomes the editor's question, and the
 * quit guard sees an unsaved diagram.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./aiRunStore", () => ({ useAiRunStore: { getState: () => ({ cancel: async () => {} }) } }));

const { useDiagramsStore } = await import("./diagramsStore");
const { useConfirmStore } = await import("./confirmStore");
const { collectUnsaved, saveAllUnsaved } = await import("../lib/unsavedWork");

const v1: DiagramFileVersion = { mtime_ms: 1, size: 10, hash: "aaa" };
const v2: DiagramFileVersion = { mtime_ms: 2, size: 12, hash: "bbb" };

const meta: DiagramMetaRow = {
  id: "d1",
  workspace_id: "w1",
  folder_id: null,
  title: "Esquema",
  format: "dbml",
  tags: "[]",
  pinned: false,
  shape_count: 1,
  sort_order: 0,
  created_at: "",
  updated_at: "",
  origin_project_id: "p1",
  origin_path: "db/schema.dbml",
} as DiagramMetaRow;
const row = (doc: string): DiagramRow => ({ ...meta, doc, thumbnail: "" }) as DiagramRow;
const asDiagram = (m: DiagramMetaRow): Diagram => ({ ...m, tags: [] }) as unknown as Diagram;

const CHANGED = "changed-on-disk: db/schema.dbml changed on disk since it was opened";

async function asked() {
  for (let i = 0; i < 200; i++) {
    const request = useConfirmStore.getState().request;
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("nothing was asked");
}

const saveCalls = () => calls.filter((call) => call.name === "diagrams_save_diagram");

beforeEach(() => {
  calls = [];
  handlers = {
    diagrams_save_diagram: () => ({ meta, version: v2 }),
    diagrams_pull_file: () => ({ row: row("Table disk {\n  id int\n}\n"), file_error: "", version: v2 }),
  };
  useConfirmStore.setState({ request: null });
  useDiagramsStore.setState({
    workspaceId: "w1",
    diagrams: [asDiagram(meta)],
    activeId: "d1",
    openingId: null,
    draft: { id: "d1", doc: "Table mine {\n  id int\n}\n", format: "dbml", thumbnail: "", dirty: true },
    saving: false,
    fileVersions: { d1: v1 },
    fileConflict: null,
    compareRequest: null,
  });
});

describe("saving a linked diagram", () => {
  it("sends the version the diagram read, and keeps the one it wrote for next time", async () => {
    await useDiagramsStore.getState().flush();
    expect(saveCalls()[0].args).toMatchObject({ expected: v1, force: false });
    expect(useDiagramsStore.getState().fileVersions.d1).toEqual(v2);
    expect(useDiagramsStore.getState().draft?.dirty).toBe(false);
  });

  it("turns a refusal into the editor's question, asked once, and keeps the edit", async () => {
    handlers.diagrams_save_diagram = () => {
      throw CHANGED;
    };
    await useDiagramsStore.getState().flush();
    const request = await asked();
    expect(request.choices?.map((choice) => choice.id)).toEqual(["compare", "reload", "overwrite"]);
    expect(useDiagramsStore.getState()).toMatchObject({ fileConflict: "d1" });
    expect(useDiagramsStore.getState().draft?.dirty).toBe(true);

    // Cancelled: the next autosave is refused again, and quietly.
    useConfirmStore.getState().respond(false);
    await useDiagramsStore.getState().flush();
    await Promise.resolve();
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it("overwrites only when told to", async () => {
    useDiagramsStore.setState({ fileConflict: "d1" });
    await useDiagramsStore.getState().resolveFileConflict("overwrite");
    expect(saveCalls()[0].args).toMatchObject({ force: true });
    expect(useDiagramsStore.getState()).toMatchObject({ fileConflict: null });
  });

  it("reloads the disk's copy over the unsaved edit when that is the answer", async () => {
    useDiagramsStore.setState({ fileConflict: "d1" });
    await useDiagramsStore.getState().resolveFileConflict("reload");
    expect(saveCalls()).toHaveLength(0);
    expect(useDiagramsStore.getState().draft).toMatchObject({ doc: "Table disk {\n  id int\n}\n", dirty: false });
    expect(useDiagramsStore.getState()).toMatchObject({ fileConflict: null, fileVersions: { d1: v2 } });
  });

  it("hands Comparar the file when a schema's question is answered with Compare", async () => {
    handlers.diagrams_save_diagram = () => {
      throw CHANGED;
    };
    await useDiagramsStore.getState().flush();
    await asked();
    useConfirmStore.getState().pick("compare");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(useDiagramsStore.getState().compareRequest).toEqual({ diagramId: "d1", source: "disk" });
  });
});

describe("leaving a diagram whose file changed under it", () => {
  it("asks first, and stays open when the question is cancelled", async () => {
    useDiagramsStore.setState({ fileConflict: "d1" });
    handlers.diagrams_save_diagram = () => {
      throw CHANGED;
    };
    const closing = useDiagramsStore.getState().closeDiagram();
    await asked();
    useConfirmStore.getState().respond(false);
    await closing;
    expect(useDiagramsStore.getState()).toMatchObject({ activeId: "d1", fileConflict: "d1" });
    expect(useDiagramsStore.getState().draft?.dirty).toBe(true);
  });

  it("leaves once the conflict is answered", async () => {
    useDiagramsStore.setState({ fileConflict: "d1" });
    handlers.diagrams_save_diagram = () => {
      throw CHANGED;
    };
    const closing = useDiagramsStore.getState().closeDiagram();
    await asked();
    handlers.diagrams_save_diagram = () => ({ meta, version: v2 });
    useConfirmStore.getState().pick("overwrite");
    await closing;
    const last = saveCalls()[saveCalls().length - 1];
    expect(last?.args).toMatchObject({ force: true });
    expect(useDiagramsStore.getState()).toMatchObject({ activeId: null, draft: null });
  });
});

describe("the quit guard's view of a diagram", () => {
  it("lists an unsaved diagram and saves it without asking", async () => {
    expect(collectUnsaved()).toContainEqual(expect.objectContaining({ label: "Esquema" }));
    expect(await saveAllUnsaved()).toEqual([]);
    expect(collectUnsaved().filter((item) => item.label === "Esquema")).toEqual([]);
  });

  it("reports a file that changed on disk as not saved, and asks nothing", async () => {
    handlers.diagrams_save_diagram = () => {
      throw CHANGED;
    };
    expect(await saveAllUnsaved()).toContain("Esquema");
    await Promise.resolve();
    expect(useConfirmStore.getState().request).toBeNull();
  });
});
