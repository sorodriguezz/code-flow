import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where a window opens: the workspace it was opened from, then its own last one, then the main
 * window's — and the first in the list only when none of those still exists.
 *
 * Pinned because the failure is quiet: an app window that opens on the wrong workspace looks like a
 * perfectly working window showing somebody else's collections.
 */

const WORKSPACES = [
  { id: "ws-a", name: "A" },
  { id: "ws-b", name: "B" },
  { id: "ws-c", name: "C" },
];
const PROJECTS: Record<string, { id: string; workspace_id: string }[]> = {
  "ws-a": [{ id: "p-a1", workspace_id: "ws-a" }],
  "ws-b": [
    { id: "p-b1", workspace_id: "ws-b" },
    { id: "p-b2", workspace_id: "ws-b" },
  ],
  "ws-c": [{ id: "p-c1", workspace_id: "ws-c" }],
};

type Identity = { label: string; main: boolean; openedIn: string | null };

async function boot(identity: Identity, settings: Record<string, string>) {
  vi.resetModules();
  const written: Record<string, string> = {};
  vi.doMock("../lib/windowIdentity", () => ({
    WINDOW: { ...identity, satellite: identity.main ? null : { kind: "app", refId: "notes" } },
    isMainWindow: () => identity.main,
  }));
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: (name: string, args: Record<string, string>) => {
      switch (name) {
        case "list_workspaces":
          return Promise.resolve(WORKSPACES);
        case "list_projects":
          return Promise.resolve(PROJECTS[args.workspaceId] ?? []);
        case "get_setting":
          return Promise.resolve(settings[args.key] ?? null);
        case "set_setting":
          written[args.key] = args.value;
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    },
  }));
  const { useWorkspaceStore } = await import("./workspaceStore");
  await useWorkspaceStore.getState().loadWorkspaces();
  const { activeWorkspaceId, activeProjectId } = useWorkspaceStore.getState();
  return { activeWorkspaceId, activeProjectId, written };
}

const NOTES = "sat-app-notes";

describe("where a window opens", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("an app window opens on the workspace it was opened from, whatever it held last time", async () => {
    const result = await boot(
      { label: NOTES, main: false, openedIn: "ws-b" },
      {
        [`last_active_workspace_id:${NOTES}`]: "ws-a",
        last_active_workspace_id: "ws-b",
        last_active_project_id: "p-b2",
      },
    );
    expect(result.activeWorkspaceId).toBe("ws-b");
    // And on the opener's repository, which is in that workspace.
    expect(result.activeProjectId).toBe("p-b2");
    // Recorded, so a tray restore brings it back here and not to the week-old one.
    expect(result.written[`last_active_workspace_id:${NOTES}`]).toBe("ws-b");
  });

  it("a restored window goes back to the workspace it recorded", async () => {
    const result = await boot(
      { label: NOTES, main: false, openedIn: null },
      { [`last_active_workspace_id:${NOTES}`]: "ws-c", last_active_workspace_id: "ws-b" },
    );
    expect(result.activeWorkspaceId).toBe("ws-c");
    expect(result.written).toEqual({});
  });

  it("a recorded workspace that was deleted falls back to the main window's, not the first", async () => {
    const result = await boot(
      { label: NOTES, main: false, openedIn: null },
      { [`last_active_workspace_id:${NOTES}`]: "ws-deleted", last_active_workspace_id: "ws-c" },
    );
    expect(result.activeWorkspaceId).toBe("ws-c");
  });

  it("an opener that no longer exists is skipped like any other stale id", async () => {
    const result = await boot(
      { label: NOTES, main: false, openedIn: "ws-deleted" },
      { [`last_active_workspace_id:${NOTES}`]: "ws-b" },
    );
    expect(result.activeWorkspaceId).toBe("ws-b");
    expect(result.written).toEqual({});
  });

  it("the main window keeps reading its own key", async () => {
    const result = await boot(
      { label: "main", main: true, openedIn: null },
      { last_active_workspace_id: "ws-c", [`last_active_workspace_id:${NOTES}`]: "ws-a" },
    );
    expect(result.activeWorkspaceId).toBe("ws-c");
    expect(result.activeProjectId).toBe("p-c1");
  });

  it("nothing recorded anywhere is the one case that lands on the first workspace", async () => {
    const result = await boot({ label: NOTES, main: false, openedIn: null }, {});
    expect(result.activeWorkspaceId).toBe("ws-a");
  });
});
