import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⌥← / ⌥→ after switching workspace. The history spans every workspace the window has been in, and
 * replaying a project from the previous one used to select an id this workspace does not hold —
 * "no project open", with that id saved as where the window opens next.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { goHistory } = await import("./shortcuts");
const { historyStep, useNavigationStore } = await import("../state/navigationStore");
const { useWorkspaceStore } = await import("../state/workspaceStore");
const { useUiStore } = await import("../state/uiStore");
import type { Project } from "../types/domain";

const project = (id: string, workspace: string) =>
  ({ id, workspace_id: workspace, name: id, local_path: `/repos/${id}` }) as unknown as Project;

beforeEach(() => {
  useNavigationStore.setState({ history: [], index: -1, suppressPush: false, canGoBack: false, canGoForward: false });
  useWorkspaceStore.setState({
    workspaces: [],
    projectsByWorkspace: { w1: [project("a", "w1"), project("b", "w1")], w2: [project("x", "w2")] },
    activeWorkspaceId: "w1",
    activeProjectId: "b",
  });
  useUiStore.setState({ activeView: "graph" });
});

describe("historyStep", () => {
  const entries = [
    { view: "graph" as const, projectId: "a" },
    { view: "graph" as const, projectId: "x" },
    { view: "editor" as const, projectId: "b" },
  ];

  it("walks over the entries it is told to skip, in either direction", () => {
    const here = (e: { projectId: string | null }) => e.projectId !== "x";
    expect(historyStep(entries, 2, "back", here)).toBe(0);
    expect(historyStep(entries, 0, "forward", here)).toBe(2);
  });

  it("answers null when nothing acceptable is left, so nothing moves", () => {
    expect(historyStep(entries, 2, "back", () => false)).toBeNull();
    expect(historyStep(entries, 2, "forward")).toBeNull();
  });

  it("skips an entry identical to where the window already is", () => {
    const repeated = [entries[0], entries[2], entries[0]];
    expect(historyStep(repeated, 2, "back")).toBe(1);
  });
});

describe("goHistory", () => {
  it("never lands on a project from another workspace", () => {
    const nav = useNavigationStore.getState();
    nav.push({ view: "graph", projectId: "a" });
    nav.push({ view: "graph", projectId: "x" });
    nav.push({ view: "editor", projectId: "b" });

    goHistory("back");

    expect(useWorkspaceStore.getState().activeProjectId).toBe("a");
    expect(useNavigationStore.getState().index).toBe(0);
  });

  it("stays put when every earlier entry belongs elsewhere", () => {
    const nav = useNavigationStore.getState();
    nav.push({ view: "graph", projectId: "x" });
    nav.push({ view: "editor", projectId: "b" });

    goHistory("back");

    expect(useWorkspaceStore.getState().activeProjectId).toBe("b");
    expect(useNavigationStore.getState().index).toBe(1);
    // And the next real navigation is still recorded: nothing was suppressed for a jump that
    // did not happen.
    expect(useNavigationStore.getState().suppressPush).toBe(false);
  });

  it("replays a workspace app's entry, which has no project to check", () => {
    const nav = useNavigationStore.getState();
    nav.push({ view: "notes", projectId: null });
    nav.push({ view: "editor", projectId: "b" });

    goHistory("back");

    expect(useUiStore.getState().activeView).toBe("notes");
  });
});
