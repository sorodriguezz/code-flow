import { beforeEach, describe, expect, it, vi } from "vitest";

const listRemovedProjects = vi.fn();
vi.mock("../lib/tauri/commands", async (original) => ({
  ...(await original<typeof import("../lib/tauri/commands")>()),
  listRemovedProjects: (workspaceId: string) => listRemovedProjects(workspaceId),
}));

const { useRemovedProjectsStore } = await import("./removedProjectsStore");
const { useWorkspaceStore } = await import("./workspaceStore");

const gone = { id: "p-old", workspace_id: "ws1", name: "api", local_path: "/tmp/api", removed_at: "2026-11-24T10:00:00Z" };

describe("a removed repository's chats", () => {
  beforeEach(() => {
    useRemovedProjectsStore.setState({ byWorkspace: {} });
    listRemovedProjects.mockReset();
  });

  it("are found by their old project id once the workspace's list is loaded", async () => {
    listRemovedProjects.mockResolvedValue([gone]);
    await useRemovedProjectsStore.getState().load("ws1");
    expect(useRemovedProjectsStore.getState().find("p-old")).toEqual(gone);
    expect(useRemovedProjectsStore.getState().find("p-other")).toBeNull();
  });

  it("still belong to their workspace, so their tab opens there", async () => {
    listRemovedProjects.mockResolvedValue([gone]);
    await useRemovedProjectsStore.getState().load("ws1");
    expect(useWorkspaceStore.getState().workspaceOfProject("p-old")).toBe("ws1");
  });

  it("keep the last list when a reload fails", async () => {
    listRemovedProjects.mockResolvedValueOnce([gone]).mockRejectedValueOnce(new Error("db busy"));
    await useRemovedProjectsStore.getState().load("ws1");
    await useRemovedProjectsStore.getState().load("ws1");
    expect(useRemovedProjectsStore.getState().byWorkspace.ws1).toEqual([gone]);
  });
});
