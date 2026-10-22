import { describe, expect, it } from "vitest";
import { resolveEditor } from "./externalEditorStore";
import type { ExternalEditorState } from "../lib/tauri/externalEditorCommands";

const state = (over: Partial<ExternalEditorState> = {}): ExternalEditorState => ({
  editors: [
    { id: "vscode", label: "VS Code", installed: true },
    { id: "cursor", label: "Cursor", installed: true },
    { id: "zed", label: "Zed", installed: false },
  ],
  default: "",
  auto: "vscode",
  workspaces: {},
  projects: {},
  ...over,
});

describe("resolveEditor — the rule `external_editor::resolve` keeps", () => {
  it("takes the nearest choice: repository, workspace, app, automatic", () => {
    const s = state({ default: "zed", workspaces: { ws: "cursor" }, projects: { p: "vscode" } });
    expect(resolveEditor(s, "p", "ws")).toBe("vscode");
    expect(resolveEditor(s, "other", "ws")).toBe("cursor");
    expect(resolveEditor(s, "other", "other")).toBe("zed");
    expect(resolveEditor(state(), "p", "ws")).toBe("vscode");
  });

  it("reads `auto` and an unknown id as no choice", () => {
    expect(resolveEditor(state({ default: "auto", auto: "cursor" }))).toBe("cursor");
    expect(resolveEditor(state({ projects: { p: "notepad" }, workspaces: { ws: "cursor" } }), "p", "ws")).toBe("cursor");
  });
});
