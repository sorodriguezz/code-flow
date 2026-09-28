import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A workspace created, renamed or deleted in another window. Every window loads the list once, so a
 * detached window's picker never learned about any of it — `refreshWorkspacesFromElsewhere` is what
 * the `workspaces` frame now runs in every window but the one that made the change.
 */

let workspaces = [
  { id: "ws-a", name: "A" },
  { id: "ws-b", name: "B" },
];
let projects: Record<string, { id: string; workspace_id: string }[]> = {
  "ws-a": [{ id: "p-a1", workspace_id: "ws-a" }],
  "ws-b": [{ id: "p-b1", workspace_id: "ws-b" }],
};
const settings: Record<string, string> = {};
const calls: string[] = [];
let failProjects = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, string>) => {
    calls.push(name);
    switch (name) {
      case "list_workspaces":
        return Promise.resolve(workspaces);
      case "list_projects":
        return failProjects ? Promise.reject(new Error("db busy")) : Promise.resolve(projects[args.workspaceId] ?? []);
      case "get_setting":
        return Promise.resolve(settings[args.key] ?? null);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { refreshWorkspacesFromElsewhere, useWorkspaceStore } = await import("./workspaceStore");

beforeEach(() => {
  calls.length = 0;
  failProjects = false;
  workspaces = [
    { id: "ws-a", name: "A" },
    { id: "ws-b", name: "B" },
  ];
  projects = {
    "ws-a": [{ id: "p-a1", workspace_id: "ws-a" }],
    "ws-b": [{ id: "p-b1", workspace_id: "ws-b" }],
  };
  useWorkspaceStore.setState({
    workspaces: workspaces as never,
    projectsByWorkspace: { "ws-b": projects["ws-b"] as never },
    activeWorkspaceId: "ws-b",
    activeProjectId: "p-b1",
  });
});

describe("refreshWorkspacesFromElsewhere", () => {
  it("picks up a workspace created and one renamed in another window", async () => {
    workspaces = [
      { id: "ws-a", name: "A renamed" },
      { id: "ws-b", name: "B" },
      { id: "ws-c", name: "C" },
    ];
    await refreshWorkspacesFromElsewhere();
    const state = useWorkspaceStore.getState();
    expect(state.workspaces.map((w) => w.name)).toEqual(["A renamed", "B", "C"]);
    expect(state.activeWorkspaceId).toBe("ws-b");
    expect(state.activeProjectId).toBe("p-b1");
    // Only the lists this window had loaded are re-read.
    expect(calls.filter((c) => c === "list_projects")).toHaveLength(1);
  });

  it("drops the selection when its repository was removed elsewhere", async () => {
    projects["ws-b"] = [];
    await refreshWorkspacesFromElsewhere();
    expect(useWorkspaceStore.getState().activeProjectId).toBeNull();
    expect(useWorkspaceStore.getState().projectsByWorkspace["ws-b"]).toEqual([]);
  });

  it("keeps a list it could not re-read rather than blanking it", async () => {
    failProjects = true;
    await refreshWorkspacesFromElsewhere();
    const state = useWorkspaceStore.getState();
    expect(state.projectsByWorkspace["ws-b"]?.map((p) => p.id)).toEqual(["p-b1"]);
    expect(state.activeProjectId).toBe("p-b1");
  });

  it("moves off a workspace deleted elsewhere instead of showing rows nothing owns", async () => {
    workspaces = [{ id: "ws-a", name: "A" }];
    await refreshWorkspacesFromElsewhere();
    const state = useWorkspaceStore.getState();
    expect(state.activeWorkspaceId).toBe("ws-a");
    expect(state.projectsByWorkspace["ws-b"]).toBeUndefined();
  });
});
