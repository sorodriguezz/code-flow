import { beforeEach, describe, expect, it } from "vitest";
import { groupHits, useEditorPanelStore } from "./editorPanelStore";

beforeEach(() => useEditorPanelStore.setState({ open: false, tab: "problems", results: null }));

describe("the panel under the editor", () => {
  it("opens on a tab, switches tabs, and closes when the showing tab is asked for again", () => {
    const panel = useEditorPanelStore.getState();
    panel.toggle("problems");
    expect(useEditorPanelStore.getState()).toMatchObject({ open: true, tab: "problems" });
    panel.toggle("results");
    expect(useEditorPanelStore.getState()).toMatchObject({ open: true, tab: "results" });
    panel.toggle("results");
    expect(useEditorPanelStore.getState().open).toBe(false);
  });

  it("brings new results into view", () => {
    useEditorPanelStore.getState().showResults({ title: "3 references to x", groups: [], notes: [] });
    expect(useEditorPanelStore.getState()).toMatchObject({ open: true, tab: "results" });
    expect(useEditorPanelStore.getState().results?.title).toBe("3 references to x");
  });

  it("filters severities one at a time", () => {
    useEditorPanelStore.getState().toggleSeverity("warning");
    expect(useEditorPanelStore.getState().show).toEqual({ error: true, warning: false, info: true });
    useEditorPanelStore.getState().toggleSeverity("warning");
    expect(useEditorPanelStore.getState().show.warning).toBe(true);
  });
});

describe("groupHits", () => {
  it("groups by file in path order, each file's hits in line order", () => {
    const hit = (path: string, line: number, column: number, text?: string) => ({
      path,
      range: { startLineNumber: line, startColumn: column },
      text,
    });
    expect(
      groupHits([hit("src/b.ts", 9, 1, "b()"), hit("src/a.ts", 3, 5, "a()"), hit("src/b.ts", 2, 7), hit("src/b.ts", 2, 3)]),
    ).toEqual([
      { path: "src/a.ts", items: [{ line: 3, column: 5, text: "a()" }] },
      {
        path: "src/b.ts",
        items: [
          { line: 2, column: 3, text: "" },
          { line: 2, column: 7, text: "" },
          { line: 9, column: 1, text: "b()" },
        ],
      },
    ]);
  });
});
