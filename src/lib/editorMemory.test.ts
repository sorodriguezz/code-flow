import { beforeEach, describe, expect, it } from "vitest";
import {
  editorShape,
  forgetAllEditorMemory,
  loadEditorMemory,
  parseEditorMemory,
  recallEditor,
  recallExplorer,
  recallViewState,
  rememberEditor,
  rememberExplorer,
  rememberViewState,
  serializeEditorMemory,
} from "./editorMemory";
import type { EditorGroup } from "./editorGroups";

const group = (id: string, paths: string[], activePath: string | null, pinned: string[] = []): EditorGroup => ({
  id,
  column: `column-${id}`,
  paths,
  activePath,
  pinned,
});

const tab = (path: string, preview = false) => ({ path, preview, viewMode: "code" });

beforeEach(() => forgetAllEditorMemory());

describe("editorShape", () => {
  it("keeps every file, group and the focused group as they were", () => {
    const groups = [group("a", ["x.ts", "y.ts"], "y.ts", ["x.ts"]), group("b", ["z.ts"], "z.ts")];
    const shape = editorShape({ tabs: [tab("x.ts"), tab("y.ts", true), tab("z.ts")], groups, activeGroupId: "b" }, () => true);
    expect(shape).toEqual({
      tabs: [tab("x.ts"), tab("y.ts", true), tab("z.ts")],
      groups,
      activeGroupId: "b",
    });
  });

  it("takes refused tabs out of every group and moves the top tab to one still there", () => {
    const groups = [group("a", ["scratch", "x.ts"], "scratch", ["scratch"])];
    const shape = editorShape({ tabs: [tab("scratch"), tab("x.ts")], groups, activeGroupId: "a" }, (p) => p !== "scratch");
    expect(shape?.tabs.map((t) => t.path)).toEqual(["x.ts"]);
    expect(shape?.groups[0]).toMatchObject({ paths: ["x.ts"], pinned: [], activePath: "x.ts" });
  });

  it("is nothing when nothing is left to put back", () => {
    expect(editorShape({ tabs: [tab("scratch")], groups: [group("a", ["scratch"], "scratch")], activeGroupId: "a" }, () => false)).toBeNull();
    expect(editorShape({ tabs: [], groups: [group("a", [], null)], activeGroupId: "a" }, () => true)).toBeNull();
  });
});

describe("remembering", () => {
  it("recalls per repository, and forgets an editor left empty", () => {
    const shape = editorShape({ tabs: [tab("x.ts")], groups: [group("a", ["x.ts"], "x.ts")], activeGroupId: "a" }, () => true);
    rememberEditor("/repo/one", shape);
    expect(recallEditor("/repo/one")).toBe(shape);
    expect(recallEditor("/repo/two")).toBeUndefined();
    rememberEditor("/repo/one", null);
    expect(recallEditor("/repo/one")).toBeUndefined();
  });

  it("keeps the explorer per repository, and drops the oldest past the limit", () => {
    for (let i = 0; i < 31; i++) {
      rememberExplorer(`/repo/${i}`, { expanded: [`src${i}`], nestOpen: [], focus: { path: "", isDir: true }, scrollTop: i });
    }
    expect(recallExplorer("/repo/0")).toBeUndefined();
    expect(recallExplorer("/repo/30")?.expanded).toEqual(["src30"]);
  });
});

describe("across restarts", () => {
  const explorer = (path: string) => ({ expanded: [path], nestOpen: [], focus: { path, isDir: false }, scrollTop: 40 });

  it("reads back exactly what it wrote", () => {
    const shape = editorShape({ tabs: [tab("x.ts")], groups: [group("a", ["x.ts"], "x.ts")], activeGroupId: "a" }, () => true);
    rememberEditor("/repo/one", shape);
    rememberExplorer("/repo/one", explorer("src"));
    rememberViewState("cf-editor:/p1/x.ts", { cursorState: [], viewState: { scrollTop: 120 } });
    const raw = serializeEditorMemory();
    forgetAllEditorMemory();
    loadEditorMemory(raw);
    expect(recallEditor("/repo/one")).toEqual(shape);
    expect(recallExplorer("/repo/one")).toEqual(explorer("src"));
    expect(recallViewState("cf-editor:/p1/x.ts")).toEqual({ cursorState: [], viewState: { scrollTop: 120 } });
  });

  it("is an empty memory for text that is not one", () => {
    for (const raw of [null, "", "not json", "[]", "42", '{"editors":"nope"}']) {
      expect(parseEditorMemory(raw)).toEqual({ editors: [], explorers: [], views: [] });
    }
  });

  it("skips malformed entries and keeps the rest", () => {
    const good = { tabs: [tab("x.ts")], groups: [group("a", ["x.ts"], "x.ts")], activeGroupId: "a" };
    const parsed = parseEditorMemory(
      JSON.stringify({
        editors: [["/bad", { tabs: "x" }], ["/good", good], [42, good]],
        explorers: [["/bad", { expanded: [1] }], ["/good", explorer("lib")]],
        views: [["u1", null], ["u2", { viewState: {} }]],
      }),
    );
    expect(parsed.editors.map(([key]) => key)).toEqual(["/good"]);
    expect(parsed.explorers.map(([key]) => key)).toEqual(["/good"]);
    expect(parsed.views.map(([key]) => key)).toEqual(["u2"]);
  });

  it("opens a stored diff as code, and drops group paths with no tab", () => {
    const parsed = parseEditorMemory(
      JSON.stringify({
        editors: [["/r", { tabs: [{ path: "x.ts", preview: false, viewMode: "diff" }], groups: [group("a", ["x.ts", "ghost.ts"], "ghost.ts")], activeGroupId: "a" }]],
      }),
    );
    const [, editor] = parsed.editors[0];
    expect(editor.tabs[0].viewMode).toBe("code");
    expect(editor.groups[0]).toMatchObject({ paths: ["x.ts"], activePath: "x.ts" });
  });

  it("puts what this session already remembered over what was stored", () => {
    rememberExplorer("/repo/one", explorer("fresh"));
    loadEditorMemory(JSON.stringify({ explorers: [["/repo/one", explorer("stale")], ["/repo/two", explorer("other")]] }));
    expect(recallExplorer("/repo/one")?.expanded).toEqual(["fresh"]);
    expect(recallExplorer("/repo/two")?.expanded).toEqual(["other"]);
  });

  it("keeps view states for the most recently left files only", () => {
    for (let i = 0; i < 301; i++) rememberViewState(`u${i}`, { i });
    expect(recallViewState("u0")).toBeUndefined();
    expect(recallViewState("u300")).toEqual({ i: 300 });
  });
});
