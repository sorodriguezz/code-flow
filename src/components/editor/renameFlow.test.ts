import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

const applied = vi.hoisted(() => ({ outcome: null as unknown }));
vi.mock("../../lib/workspaceEdit", async (original) => ({
  ...(await original<typeof import("../../lib/workspaceEdit")>()),
  applyEditPlan: vi.fn(async () => applied.outcome),
}));
const refreshStatus = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../state/repoStore", () => ({ useRepoStore: { getState: () => ({ refreshStatus }) } }));

import { applyRename, renameResults } from "./renameFlow";
import { useEditorPanelStore } from "../../state/editorPanelStore";
import { useToastStore } from "../../state/toastStore";
import type { ApplyOutcome, EditPlan } from "../../lib/workspaceEdit";

const edit = { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: "bar" };
const plan = (paths: string[], extra: Partial<EditPlan> = {}): EditPlan => ({
  files: paths.map((path) => ({ path, edits: [edit] })),
  outside: [],
  unsupported: 0,
  ...extra,
});
const outcome = (overrides: Partial<ApplyOutcome>): ApplyOutcome => ({
  applied: [],
  changes: 0,
  conflicts: [],
  failed: [],
  checkpointId: null,
  ...overrides,
});
const file = (path: string, inBuffer: boolean) => ({ path, inBuffer, at: [{ lineNumber: 1, column: 1, text: "bar()" }] });

beforeEach(() => {
  useEditorPanelStore.setState({ open: false, tab: "problems", results: null });
  useToastStore.setState({ toasts: [] });
  refreshStatus.mockClear();
});

describe("what a rename reports", () => {
  it("names every file it changed, where, and everything it could not do", () => {
    const results = renameResults(
      plan(["a.ts", "b.ts", "c.ts"], { outside: ["/lib/x.d.ts"], unsupported: 1 }),
      outcome({
        applied: [file("a.ts", true), file("b.ts", false)],
        changes: 2,
        conflicts: ["c.ts"],
        failed: [{ path: "d.ts", error: "read-only" }],
        checkpointId: "cp-1",
      }),
      "bar",
      "2 change(s) in 2 file(s)",
    );
    expect(results.title).toBe("Renamed to bar · 2 change(s) in 2 file(s)");
    expect(results.groups).toEqual([
      { path: "a.ts", items: [{ line: 1, column: 1, text: "bar()" }] },
      { path: "b.ts", items: [{ line: 1, column: 1, text: "bar()" }] },
    ]);
    expect(results.notes).toEqual([
      "c.ts changed on disk and was not renamed",
      "d.ts: read-only",
      "1 file(s) outside the repository left untouched",
      "1 file operation(s) not applied",
      "Restore point created",
      "Open files changed in their tabs and still need saving",
    ]);
  });

  it("says when files were written without a restore point", () => {
    const results = renameResults(plan(["b.ts"]), outcome({ applied: [file("b.ts", false)], changes: 1 }), "x", "");
    expect(results.notes).toEqual(["No restore point could be created"]);
  });
});

describe("applyRename", () => {
  it("keeps a rename inside the open file to a toast", async () => {
    applied.outcome = outcome({ applied: [file("a.ts", true)], changes: 3 });
    await applyRename(plan(["a.ts"]), "/repo", "bar");
    expect(useEditorPanelStore.getState().open).toBe(false);
    expect(useToastStore.getState().toasts.map((toast) => [toast.type, toast.message])).toEqual([
      ["success", "3 change(s) in 1 file(s)"],
    ]);
    expect(refreshStatus).not.toHaveBeenCalled();
  });

  it("lists the files when it reached more than one, and refreshes status after writing to disk", async () => {
    applied.outcome = outcome({ applied: [file("a.ts", true), file("b.ts", false)], changes: 2, checkpointId: "cp" });
    await applyRename(plan(["a.ts", "b.ts"]), "/repo", "bar");
    expect(useEditorPanelStore.getState()).toMatchObject({ open: true, tab: "results" });
    expect(refreshStatus).toHaveBeenCalled();
  });

  it("opens the list and reports an error when a file could not be renamed", async () => {
    applied.outcome = outcome({ applied: [file("a.ts", true)], changes: 1, conflicts: ["b.ts"] });
    await applyRename(plan(["a.ts", "b.ts"]), "/repo", "bar");
    expect(useEditorPanelStore.getState().open).toBe(true);
    expect(useToastStore.getState().toasts[0].type).toBe("error");
  });

  it("says there was nothing to rename when the plan reaches no file of the repository", async () => {
    expect(await applyRename(plan([], { outside: ["/x.d.ts"] }), "/repo", "bar")).toBeNull();
    expect(useToastStore.getState().toasts[0].message).toBe("Nothing to rename in this repository");
  });
});
