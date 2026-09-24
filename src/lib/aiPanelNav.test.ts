import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An analysis reads the unstaged and untracked changes and nothing else, so with none there is
 * nothing to start. It used to start anyway: the engine answered about an empty diff and the run was
 * filed as a failure — a red row for having clicked a button that should not have been on.
 */

let analyzeReply: () => Promise<unknown> = async () => "📈 CALIDAD: Fiabilidad=A";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string) => (name === "analyze_working_changes" ? analyzeReply() : null),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { changesToAnalyze, startAnalysis } = await import("./aiPanelNav");
const { useJobsStore } = await import("../state/jobsStore");
const { useRepoStore } = await import("../state/repoStore");
const { useToastStore } = await import("../state/toastStore");
const { useWorkspaceStore } = await import("../state/workspaceStore");

const file = (path: string) => ({ path, status: "M" }) as never;

function openRepo(changes: { staged?: number; unstaged?: number; untracked?: number }) {
  const many = (n = 0, prefix: string) => Array.from({ length: n }, (_, i) => file(`${prefix}${i}.ts`));
  useRepoStore.setState({
    repoPath: "/work/web/",
    status: {
      staged: many(changes.staged, "s"),
      unstaged: many(changes.unstaged, "u"),
      untracked: many(changes.untracked, "n"),
      conflicted: [],
      current_branch: "main",
      is_detached: false,
      head_oid: null,
    },
  });
}

beforeEach(() => {
  analyzeReply = async () => "📈 CALIDAD: Fiabilidad=A";
  useJobsStore.setState({ byProject: {} });
  useToastStore.setState({ toasts: [] });
  useWorkspaceStore.setState({
    activeWorkspaceId: "ws-1",
    activeProjectId: "p-web",
    projectsByWorkspace: {
      "ws-1": [
        { id: "p-web", workspace_id: "ws-1", name: "web", local_path: "/work/web" } as never,
        { id: "p-api", workspace_id: "ws-1", name: "api", local_path: "/work/api" } as never,
      ],
    },
  });
});

describe("changesToAnalyze", () => {
  it("counts what the analysis reads — staged changes are not in its diff", () => {
    openRepo({ staged: 3 });
    expect(changesToAnalyze("p-web")).toBe(0);
    openRepo({ staged: 3, unstaged: 1, untracked: 2 });
    expect(changesToAnalyze("p-web")).toBe(3);
  });

  it("does not answer for a repository this window holds no status for", () => {
    openRepo({});
    expect(changesToAnalyze("p-api")).toBeNull();
  });
});

describe("startAnalysis", () => {
  it("starts nothing when there is nothing to analyze, and says why", () => {
    openRepo({ staged: 2 });
    expect(startAnalysis("p-web")).toBeNull();
    expect(useJobsStore.getState().byProject["p-web"] ?? []).toHaveLength(0);
    expect(useToastStore.getState().toasts.map((t) => t.type)).toEqual(["info"]);
  });

  it("starts when there are changes", async () => {
    openRepo({ unstaged: 1 });
    const id = startAnalysis("p-web");
    expect(id).not.toBeNull();
    await vi.waitFor(() => expect(useJobsStore.getState().byProject["p-web"]?.[0]?.status).toBe("done"));
  });

  it("drops the run instead of filing a failure when the tree emptied before it ran", async () => {
    openRepo({ unstaged: 1 });
    analyzeReply = async () => {
      throw "NOTHING_TO_ANALYZE::";
    };
    startAnalysis("p-web");
    await vi.waitFor(() => expect(useJobsStore.getState().byProject["p-web"] ?? []).toHaveLength(0));
    expect(useToastStore.getState().toasts.map((t) => t.type)).toEqual(["info"]);
  });
});
