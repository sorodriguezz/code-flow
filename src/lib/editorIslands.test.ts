import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowMessage } from "./windowBus";

/**
 * The handover of one file between the main window's editor and a floating editor window.
 *
 * Two webviews and one buffer: the property every case here pins is that the buffer is never in
 * neither — the main window keeps its copy until the window says it has it, takes it back from a
 * window that went before taking it, and a window does not go until the main window has its file.
 */

const bus = vi.hoisted(() => ({
  handlers: new Set<(message: WindowMessage, from: string) => void>(),
  sent: [] as { to: string; message: WindowMessage }[],
}));
const providers = vi.hoisted(() => [] as { id: string; unsaved: () => { label: string }[] }[]);

vi.mock("./windowBus", () => ({
  onWindowMessage: (handler: (message: WindowMessage, from: string) => void) => {
    bus.handlers.add(handler);
    return () => bus.handlers.delete(handler);
  },
  listenWindowMessages: async (handler: (message: WindowMessage, from: string) => void) => {
    bus.handlers.add(handler);
    return () => bus.handlers.delete(handler);
  },
  sendTo: async (to: string, message: WindowMessage) => {
    bus.sent.push({ to, message });
  },
}));
vi.mock("./windowIdentity", () => ({ WINDOW: { main: true, label: "main" }, MAIN_LABEL: "main" }));
vi.mock("./unsavedWork", () => ({
  registerUnsavedProvider: (provider: { id: string; unsaved: () => { label: string }[] }) => {
    providers.push(provider);
    return () => {};
  },
}));
vi.mock("./tauri/commands", () => ({ getProject: async () => null, writeEditorFile: async () => null }));
vi.mock("./tauri/windows", () => ({ focusSatellite: async () => {}, showMainWindow: async () => {} }));
vi.mock("../state/windowStore", async () => {
  const { create } = await import("zustand");
  return { useWindowStore: create(() => ({ satellites: [] as { label: string; kind: string; ref_id: string }[] })) };
});
vi.mock("../state/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeProjectId: "p1",
      projectsByWorkspace: { w1: [{ id: "p1", name: "Tienda" }] },
      workspaceOfProject: () => "w1",
      focusProject: async () => {},
    }),
  },
}));
vi.mock("../state/uiStore", () => ({
  useUiStore: { getState: () => ({ setActiveView: () => {}, openInEditor: () => {} }) },
}));

const {
  claimFromMain,
  fileIslandRef,
  installIslandHost,
  islandHolding,
  islandPaths,
  parseFileIslandRef,
  registerIslandHost,
  returnToMain,
  stashForIsland,
  takeReturns,
  useIslandInbox,
} = await import("./editorIslands");
const { useWindowStore } = await import("../state/windowStore");

function tab(path: string, content = "text", originalContent = "text") {
  return {
    path,
    content,
    originalContent,
    loading: false,
    viewMode: "code" as const,
    preview: false,
    compare: null,
    version: null,
    notice: null,
    readOnly: null,
    diskChanged: false,
    diskText: null,
  };
}

/** Hands a message to every listener, as the bus does for one that reached this window. */
function deliver(message: WindowMessage, from: string) {
  for (const handler of [...bus.handlers]) handler(message, from);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const sentTo = (to: string, kind: WindowMessage["kind"]) =>
  bus.sent.filter((entry) => entry.to === to && entry.message.kind === kind).map((entry) => entry.message);

beforeAll(() => installIslandHost());

beforeEach(() => {
  bus.sent.length = 0;
  useIslandInbox.setState({ returned: [] });
  useWindowStore.setState({ satellites: [] });
});

describe("a floating editor's id", () => {
  it("is the project, then the path — split at the first colon, whatever the path holds", () => {
    const ref = fileIslandRef("p1", "docs/a:b.md");
    expect(ref).toBe("p1:docs/a:b.md");
    expect(parseFileIslandRef(ref)).toEqual({ projectId: "p1", path: "docs/a:b.md" });
    expect(parseFileIslandRef("p1:")).toBeNull();
    expect(parseFileIslandRef(":a.ts")).toBeNull();
  });
});

describe("the main window's side of the handover", () => {
  it("hands the stash over, and keeps it until the window says it has it", () => {
    const edited = tab("a.ts", "typed", "on disk");
    stashForIsland("p1", "/repo", edited);
    // Still opening: no second copy may be opened meanwhile.
    expect(islandHolding("p1", "a.ts")).toBe("");
    expect(islandPaths("p1")).toEqual(new Set(["a.ts"]));

    deliver({ kind: "island-claim", requestId: "r1", projectId: "p1", path: "a.ts" }, "sat-file-a");
    expect(sentTo("sat-file-a", "island-handoff")).toEqual([{ kind: "island-handoff", requestId: "r1", tab: edited }]);

    // A window that asks again — reloaded before it answered — gets the same copy, not nothing.
    deliver({ kind: "island-claim", requestId: "r2", projectId: "p1", path: "a.ts" }, "sat-file-a");
    expect(sentTo("sat-file-a", "island-handoff")[1]).toEqual({ kind: "island-handoff", requestId: "r2", tab: edited });

    deliver({ kind: "island-taken", ref: "p1:a.ts" }, "sat-file-a");
    expect(islandHolding("p1", "a.ts")).toBeNull();
  });

  it("takes a file it has open out of the editor when the window was not handed it — a tray restore", () => {
    const take = vi.fn(() => ({ tab: tab("b.ts"), repoPath: "/repo" }));
    const unregister = registerIslandHost({ take });
    deliver({ kind: "island-claim", requestId: "r3", projectId: "p1", path: "b.ts" }, "sat-file-b");
    expect(take).toHaveBeenCalledWith("p1", "b.ts");
    expect(sentTo("sat-file-b", "island-handoff")).toEqual([{ kind: "island-handoff", requestId: "r3", tab: tab("b.ts") }]);
    deliver({ kind: "island-taken", ref: "p1:b.ts" }, "sat-file-b");
    unregister();
  });

  it("answers nothing when nothing here has the file, so the window reads the disk", () => {
    deliver({ kind: "island-claim", requestId: "r4", projectId: "p1", path: "c.ts" }, "sat-file-c");
    expect(sentTo("sat-file-c", "island-handoff")).toEqual([{ kind: "island-handoff", requestId: "r4", tab: null }]);
  });

  it("takes a returned tab in, says so, and hands it out again to the window that asks", () => {
    const dirty = tab("d.ts", "unsaved", "saved");
    deliver(
      { kind: "island-return", requestId: "x1", projectId: "p2", repoPath: "/other", tab: dirty, reveal: false },
      "sat-file-d",
    );
    expect(sentTo("sat-file-d", "island-returned")).toEqual([{ kind: "island-returned", requestId: "x1" }]);
    expect(useIslandInbox.getState().returned).toEqual([{ projectId: "p2", repoPath: "/other", tab: dirty }]);
    // Listed for the quit question while it waits for its project to be on screen.
    const inFlight = providers.find((provider) => provider.id === "editor-islands");
    expect(inFlight?.unsaved().map((item) => item.label)).toEqual(["d.ts"]);

    // Put away to the tray and back: the window asks for the file it gave back.
    deliver({ kind: "island-claim", requestId: "r5", projectId: "p2", path: "d.ts" }, "sat-file-d");
    expect(sentTo("sat-file-d", "island-handoff")).toEqual([{ kind: "island-handoff", requestId: "r5", tab: dirty }]);
    expect(useIslandInbox.getState().returned).toEqual([]);
    deliver({ kind: "island-taken", ref: "p2:d.ts" }, "sat-file-d");
  });

  it("takes back a tab whose window went before taking it", () => {
    const edited = tab("e.ts", "typed", "on disk");
    stashForIsland("p1", "/repo", edited);
    useWindowStore.setState({ satellites: [{ label: "sat-file-e", kind: "file", ref_id: "p1:e.ts" }] });
    expect(islandHolding("p1", "e.ts")).toBe("sat-file-e");

    useWindowStore.setState({ satellites: [] });
    expect(takeReturns("p1")).toEqual([{ projectId: "p1", repoPath: "/repo", tab: edited }]);
    expect(islandHolding("p1", "e.ts")).toBeNull();
  });

  it("lets the editor take only its own project's returns", () => {
    useIslandInbox.setState({
      returned: [
        { projectId: "p1", repoPath: "/repo", tab: tab("mine.ts") },
        { projectId: "p2", repoPath: "/other", tab: tab("theirs.ts") },
      ],
    });
    expect(takeReturns("p1").map((entry) => entry.tab.path)).toEqual(["mine.ts"]);
    expect(useIslandInbox.getState().returned.map((entry) => entry.tab.path)).toEqual(["theirs.ts"]);
  });
});

describe("the floating editor's side of the handover", () => {
  it("claims its buffer, and says it has it", async () => {
    const claimed = claimFromMain("p1", "f.ts");
    await flush();
    const [claim] = sentTo("main", "island-claim");
    expect(claim).toMatchObject({ kind: "island-claim", projectId: "p1", path: "f.ts" });
    const requestId = (claim as { requestId: string }).requestId;

    // Someone else's answer is not this one's.
    deliver({ kind: "island-handoff", requestId: "not-mine", tab: tab("f.ts", "wrong") }, "main");
    deliver({ kind: "island-handoff", requestId, tab: tab("f.ts", "typed", "on disk") }, "main");
    expect(await claimed).toEqual(tab("f.ts", "typed", "on disk"));
    expect(sentTo("main", "island-taken")).toEqual([{ kind: "island-taken", ref: "p1:f.ts" }]);
  });

  it("goes only once the main window has the file", async () => {
    const back = returnToMain("p1", "/repo", tab("g.ts", "typed", "on disk"), true);
    await flush();
    const [sent] = sentTo("main", "island-return");
    expect(sent).toMatchObject({ kind: "island-return", projectId: "p1", repoPath: "/repo", reveal: true });
    deliver({ kind: "island-returned", requestId: (sent as { requestId: string }).requestId }, "main");
    expect(await back).toBe(true);
  });
});
