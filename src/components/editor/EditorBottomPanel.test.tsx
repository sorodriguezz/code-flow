import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("../../state/languageStore", async (original) => ({
  ...(await original<typeof import("../../state/languageStore")>()),
  useT: () => (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));

/**
 * `renderToStaticMarkup` reads a zustand store's *initial* state, so the two stores are handed in
 * through their hooks (see the vitest traps note) — the grouping and counting are the real ones.
 */
const state = vi.hoisted(() => ({
  problems: { byOwner: {} as Record<string, Record<string, unknown[]>> },
  panel: {
    open: true,
    tab: "problems" as "problems" | "results",
    results: null as unknown,
    show: { error: true, warning: true, info: true },
    canCheckProject: false,
    checkingProject: false,
    toggleSeverity: () => {},
  },
}));
vi.mock("../../state/problemsStore", async (original) => ({
  ...(await original<typeof import("../../state/problemsStore")>()),
  useProblemsStore: (select: (s: typeof state.problems) => unknown) => select(state.problems),
}));
vi.mock("../../state/editorPanelStore", async (original) => {
  const actual = await original<typeof import("../../state/editorPanelStore")>();
  const hook = (select: (s: typeof state.panel) => unknown) => select(state.panel);
  return { ...actual, useEditorPanelStore: Object.assign(hook, { getState: () => state.panel, setState: () => {} }) };
});

// The icon pack's glyph subscribes to its catalog with no server snapshot; a plain mark stands in.
vi.mock("../common/FileGlyph", () => ({ FileGlyph: ({ path }: { path: string }) => <i data-glyph={path} /> }));

import { EditorBottomPanel } from "./EditorBottomPanel";

const problem = (line: number, severity: string, message: string, code?: string) => ({
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  severity,
  message,
  code,
  source: "ts",
});

const render = () => renderToStaticMarkup(<EditorBottomPanel onOpen={() => {}} />);

describe("EditorBottomPanel", () => {
  it("lists problems grouped by file, each with where it is and who said so", () => {
    state.panel.tab = "problems";
    state.problems.byOwner = {
      "tsserver:semantic": {
        "src/b.ts": [problem(12, "error", "Cannot find name 'pool'.", "TS2304")],
        "src/a.ts": [problem(4, "warning", "Unreachable code detected.", "TS7027")],
      },
    };
    const markup = render();
    expect(markup.indexOf("a.ts")).toBeLessThan(markup.indexOf("b.ts"));
    expect(markup).toContain("Cannot find name &#x27;pool&#x27;.");
    expect(markup).toContain("ts TS2304");
    expect(markup).toContain("12:3");
    // The tab carries the total.
    expect(markup).toContain("editor.problems 2");
  });

  it("says so when there is nothing wrong", () => {
    state.panel.tab = "problems";
    state.problems.byOwner = {};
    expect(render()).toContain("editor.problemsNone");
  });

  it("offers the project check only while a compiler that can run one is up", () => {
    state.panel.tab = "problems";
    state.panel.canCheckProject = false;
    expect(render()).not.toContain("editor.problemsCheckProject");
    state.panel.canCheckProject = true;
    expect(render()).toContain("editor.problemsCheckProject");
  });

  it("shows the last results with their notes, each file's lines under it", () => {
    state.panel.tab = "results";
    state.panel.results = {
      title: "Renamed to fetchUser · 2 change(s) in 2 file(s)",
      notes: ["Restore point created"],
      groups: [
        { path: "src/api.ts", items: [{ line: 7, column: 17, text: "export function fetchUser() {" }] },
        { path: "src/app.ts", items: [{ line: 2, column: 10, text: "import { fetchUser } from \"./api\";" }] },
      ],
    };
    const markup = render();
    expect(markup).toContain("Renamed to fetchUser · 2 change(s) in 2 file(s)");
    expect(markup).toContain("Restore point created");
    expect(markup).toContain("export function fetchUser() {");
    expect(markup.indexOf("api.ts")).toBeLessThan(markup.indexOf("app.ts"));
  });
});
