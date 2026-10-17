import { beforeEach, describe, expect, it, vi } from "vitest";

const created: { workspaces: string[]; projects: string[] } = { workspaces: [], projects: [] };
vi.mock("./tauri/commands", () => ({
  createWorkspace: async (name: string, icon: string, color: string) => {
    created.workspaces.push(name);
    return { id: `ws-${name}`, name, icon, color, sort_order: 0, created_at: "" };
  },
  createProject: async (input: { workspace_id: string; name: string; local_path: string }) => {
    created.projects.push(input.local_path);
    return { ...input, id: `p-${input.local_path}` };
  },
}));
const { applyImport, buildExport, parseExport, samePath } = await import("./workspaceTransfer");

const ws = (id: string, name: string) => ({ id, name, icon: "initials", color: "#000", sort_order: 0, created_at: "" });
const proj = (id: string, workspace_id: string, local_path: string) =>
  ({ id, workspace_id, name: id, local_path, remote_url: null, color: "#111", icon: "git-branch" }) as never;

beforeEach(() => {
  created.workspaces.length = 0;
  created.projects.length = 0;
});

describe("workspace export", () => {
  it("round-trips the arrangement by folder, not by id", () => {
    const data = buildExport(
      [ws("w1", "Work")],
      () => [proj("a", "w1", "/code/a"), proj("b", "w1", "/code/b")],
      () => ({ pinned: ["b"], groups: [{ id: "g", name: "Api", collapsed: true }], groupOf: { a: "g" } }),
    );
    const back = parseExport(JSON.stringify(data));
    expect(back.workspaces[0].layout).toEqual({ pinned: ["/code/b"], groups: [{ name: "Api", collapsed: true, paths: ["/code/a"] }] });
  });

  it("refuses what is not one", () => {
    expect(() => parseExport("{}")).toThrow();
    expect(() => parseExport("nope")).toThrow();
    expect(() => parseExport(JSON.stringify({ app: "codeflow", kind: "workspaces", version: 99, workspaces: [] }))).toThrow(/newer/);
  });

  it("adds what is missing and leaves what is here", async () => {
    const data = buildExport(
      [ws("x1", "Work"), ws("x2", "Side")],
      (id) => (id === "x1" ? [proj("a", "x1", "/code/a"), proj("b", "x1", "/code/b")] : [proj("c", "x2", "/code/c")]),
      () => ({ pinned: ["b"], groups: [], groupOf: {} }),
    );
    const outcome = await applyImport(data, [ws("w1", "work")], [proj("old-a", "w1", "/code/a/")]);
    expect(created.workspaces).toEqual(["Side"]);
    expect(created.projects).toEqual(["/code/b", "/code/c"]);
    expect(outcome).toMatchObject({ workspacesCreated: 1, projectsAdded: 2, projectsSkipped: 1 });
    expect(outcome.layouts.get("w1")?.pinned).toEqual(["p-/code/b"]);
  });

  it("compares Windows paths without case or separator", () => {
    expect(samePath("C:\\Code\\App", "c:/code/app/")).toBe(true);
    expect(samePath("/Code/App", "/code/app")).toBe(false);
  });
});
