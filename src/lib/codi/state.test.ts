import { describe, expect, it, vi } from "vitest";

/**
 * `ui.state`, read off real stores. The backend puts this at the end of every prompt, so the shape is
 * the contract: small, absent rather than null where absence says it, and a summary of one or two
 * lines in a fixed order — the same screen must always read as the same text.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("../../state/languageStore", () => {
  const state = { language: "en" };
  const store = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => state,
    setState: () => {},
    subscribe: () => () => {},
  });
  return {
    useLanguageStore: store,
    useT: () => (key: string) => key,
    // `key(param,param)`, so the summary's parts can be told apart in the assertions.
    translate: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}(${Object.values(params).join(",")})` : key,
    languageFromLocale: () => "en",
  };
});

const { useWorkspaceStore } = await import("../../state/workspaceStore");
const { useRepoStore } = await import("../../state/repoStore");
const { useUiStore } = await import("../../state/uiStore");
const { useTerminalStore } = await import("../../state/terminalStore");
const { useWindowStore } = await import("../../state/windowStore");
const { useNotificationStore } = await import("../../state/notificationStore");
const { snapshotUiState } = await import("./state");

const project = (id: string, name: string) =>
  ({ id, name, workspace_id: "ws-1", local_path: `/code/${name}` }) as never;

function seed() {
  useWorkspaceStore.setState({
    workspaces: [
      { id: "ws-1", name: "Tienda", icon: "", color: "", sort_order: 0, created_at: "" },
      { id: "ws-2", name: "Personal", icon: "", color: "", sort_order: 1, created_at: "" },
    ],
    projectsByWorkspace: { "ws-1": [project("p1", "api-pagos"), project("p2", "web")] },
    activeWorkspaceId: "ws-1",
    activeProjectId: "p1",
  });
  useRepoStore.setState({
    status: { staged: [], unstaged: [{} as never], untracked: [], conflicted: [], current_branch: "main", is_detached: false, head_oid: "x" },
    branches: [{ name: "main", is_head: true, is_remote: false, upstream: "origin/main", ahead: 0, behind: 2 } as never],
  });
  useUiStore.setState({ activeView: "graph", aiPanelOpen: false, settingsOpen: false });
  useTerminalStore.setState({ panelOpen: false });
  useWindowStore.setState({ satellites: [] });
  useNotificationStore.setState({ items: [] });
}

describe("ui.state", () => {
  it("says where the window is, compactly", () => {
    seed();
    const state = snapshotUiState();
    expect(state).toMatchObject({
      window: { label: "main", kind: "main" },
      workspace: { name: "Tienda", others: ["Personal"] },
      repo: { name: "api-pagos", others: ["web"] },
      branch: { name: "main", behind: 2, changes: 1 },
      view: "graph",
    });
    // Nothing open around it, so nothing said about it — absent, not null or false.
    for (const key of ["settings", "aiPanel", "dock", "modals", "islands", "services", "unread", "focus", "sidebarCollapsed"]) {
      expect(state, key).not.toHaveProperty(key);
    }
    expect(state.branch).not.toHaveProperty("ahead");
    // One line, in the fixed order: window · workspace › repo · branch · view.
    expect(state.summary).toBe("codi.state.main · Tienda › api-pagos · codi.state.branch(main) ↓2 · tabbar.graph");
  });

  it("adds a second line for what is open around it, in a stable order", () => {
    seed();
    useUiStore.setState({ activeView: "api", apiWorkspace: "database", settingsOpen: true, settingsSection: "voice", settingsTab: null });
    useTerminalStore.setState({ panelOpen: true, dockView: "services" });
    useWindowStore.setState({ satellites: [{ label: "sat-app-notes", kind: "app", ref_id: "notes" }, { label: "sat-repo-p2", kind: "repo", ref_id: "p2" }] });
    useNotificationStore.setState({ items: [{ id: "n1", seen: false } as never, { id: "n2", seen: true } as never] });
    const state = snapshotUiState();
    expect(state.view).toBe("api:database");
    expect(state.settings).toEqual({ section: "voice", tab: null });
    expect(state.dock).toBe("services");
    expect(state.islands).toEqual(["notes", "repo:web"]);
    expect(state.unread).toBe(1);
    const lines = state.summary.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("codi.state.main · Tienda › api-pagos · codi.state.branch(main) ↓2 · tabbar.databases");
    expect(lines[1]).toBe(
      "codi.state.settings(voice.sectionTitle) · codi.state.dock(services.title) · codi.state.islands(tabbar.notes, web) · codi.state.unread(1)",
    );
    // Same screen, same text.
    expect(snapshotUiState().summary).toBe(state.summary);
  });

  it("says so when no repository is open", () => {
    seed();
    useWorkspaceStore.setState({ activeProjectId: null });
    const state = snapshotUiState();
    expect(state.repo).toBeNull();
    expect(state.branch).toBeNull();
    expect(state.summary.startsWith("codi.state.main · Tienda › codi.state.noRepo")).toBe(true);
  });
});
