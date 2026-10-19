import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../../types/domain";

/**
 * How a race looks in the list: **one** parent row saying how many agents are on it, with the
 * racers nested under it — and nowhere else. Drawing them loose as well is the failure this pins:
 * a row in two places is a row you act on twice, and three agents on one goal is three rows that
 * all read as the same task.
 *
 * The stores are stand-ins. These render on the server (the suite has no DOM) and zustand serves a
 * server render from its initial state, so seeding the real ones would assert against an empty tree.
 */

let tasks: AgentTask[];
let open: Record<string, boolean>;

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../../state/agentsStore", () => {
  const store = (selector: (s: unknown) => unknown) =>
    selector({ projects: [], open, toggleOpen: () => {}, tasks, selectedId: null, live: {} });
  store.getState = () => ({ select: async () => {}, rename: async () => {} });
  return { useAgentsStore: store, OPEN_BY_DEFAULT: new Set(["sec:projects", "sec:pinned", "sec:tasks"]) };
});
vi.mock("../../state/chainStore", () => {
  const store = (selector: (s: unknown) => unknown) =>
    selector({ chains: [], briefsByChain: {}, templates: [], selectedId: null });
  store.getState = () => ({ select: async () => {} });
  return { useChainStore: store };
});
vi.mock("../../state/uiStore", () => ({
  useUiStore: (selector: (s: unknown) => unknown) => selector({ activeView: "agents" }),
}));
vi.mock("../../state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ activeWorkspaceId: "w1", projectsByWorkspace: { w1: [{ id: "p1", name: "api" }] } }),
}));
vi.mock("../../state/taskReviewStore", () => {
  const store = () => undefined;
  store.getState = () => ({ requestTab: () => {} });
  return { useTaskReviewStore: store };
});

const { TaskTree } = await import("./TaskTree");

function task(id: string, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    workspace_id: "w1",
    project_id: "p1",
    agent_id: `agent-${id}`,
    agent_name: `Bot ${id}`,
    provider: "claude",
    model: "sonnet",
    prompt: "",
    goal: "Arregla el login",
    title: "Arregla el login",
    agent_project_id: "",
    batch_id: "race-1",
    pinned: false,
    conversation_id: `agent-${id}`,
    status: "idle",
    turns: 1,
    last_error: "",
    created_at: `2026-10-19T10:00:0${id}Z`,
    updated_at: `2026-10-19T10:00:0${id}Z`,
    worktree_path: `/wt/${id}`,
    worktree_branch: `agent/${id}`,
    ...patch,
  } as AgentTask;
}

const render = () =>
  renderToStaticMarkup(
    <TaskTree
      tasks={tasks}
      query=""
      onNewTask={() => {}}
      onNewChain={() => {}}
      onNewStory={() => {}}
      onNewProject={() => {}}
      onEditProject={() => {}}
      onContinueWith={() => {}}
      onUseTemplate={() => {}}
    />,
  );

beforeEach(() => {
  tasks = [task("1"), task("2"), task("3")];
  open = {};
});

describe("a race in the task list", () => {
  it("is one row that says how many agents are on it", () => {
    const html = render();
    expect(html).toContain("3 agents racing");
    expect(html).toContain("Arregla el login");
  });

  it("keeps its racers out of the list while it is collapsed", () => {
    expect(render()).not.toContain("Bot 1");
  });

  it("shows them nested once it is opened", () => {
    open = { "race:race-1": true };
    const html = render();
    expect(html).toContain("Bot 1");
    expect(html).toContain("Bot 2");
    expect(html).toContain("Bot 3");
    // Still one race row above them, not one per racer.
    expect((html.match(/agents racing/g) ?? []).length).toBe(1);
  });

  it("leaves a task started on its own exactly where it was", () => {
    tasks = [...tasks, task("4", { batch_id: "", title: "Otra cosa", agent_name: "Solo" })];
    const html = render();
    expect(html).toContain("Otra cosa");
    expect(html).toContain("3 agents racing");
  });

  it("draws a lone survivor as an ordinary task rather than a race of one", () => {
    tasks = [task("1")];
    const html = render();
    expect(html).not.toContain("agents racing");
    expect(html).toContain("Bot 1");
  });
});
