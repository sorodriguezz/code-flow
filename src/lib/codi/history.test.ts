import { describe, expect, it, vi } from "vitest";

/**
 * `nav.undo`'s notion of "the screen", on real stores: what is captured, and that restoring it puts
 * the workspace, the repository, the view and the panels back — in the main window.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));

const { useWorkspaceStore } = await import("../../state/workspaceStore");
const { useUiStore } = await import("../../state/uiStore");
const { captureScreen, restoreScreen } = await import("./history");

const project = (id: string, workspace: string) => ({ id, name: id, workspace_id: workspace, local_path: `/code/${id}` }) as never;

describe("the screen nav.undo restores", () => {
  it("comes back to the workspace, repository, view and panels it was on", async () => {
    useWorkspaceStore.setState({
      workspaces: [],
      projectsByWorkspace: { "ws-1": [project("p1", "ws-1")], "ws-2": [project("p2", "ws-2")] },
      activeWorkspaceId: "ws-1",
      activeProjectId: "p1",
    });
    useUiStore.setState({ activeView: "editor", apiWorkspace: "requests", settingsOpen: false, aiPanelOpen: true });
    const before = captureScreen();
    expect(before).toEqual({
      workspaceId: "ws-1",
      projectId: "p1",
      view: "editor",
      apiWorkspace: "requests",
      settings: null,
      aiPanelOpen: true,
    });

    // Codi moved: another workspace and repository, the database, Settings open, the panel shut.
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-2", activeProjectId: "p2" });
    useUiStore.setState({ activeView: "api", apiWorkspace: "database", settingsOpen: true, settingsSection: "voice", aiPanelOpen: false });

    await restoreScreen(before);
    expect(captureScreen()).toEqual(before);
  });
});
