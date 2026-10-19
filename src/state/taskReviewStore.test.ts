import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask, FileDiffInfo } from "../types/domain";

/**
 * The review is a turn's worth of reading: the comments it collects must survive a refresh of the
 * diff, and must *not* be thrown away by a send the agent store refused.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));

const { useTaskReviewStore, reviewOf, mergeSides } = await import("./taskReviewStore");
const { useAgentsStore } = await import("./agentsStore");
const { useWorkspaceStore } = await import("./workspaceStore");

const LABELS = { intro: "Revisión", general: "Nota general" };

function fileDiff(path: string, origins: string[], patch: Partial<FileDiffInfo> = {}): FileDiffInfo {
  return {
    old_path: path,
    new_path: path,
    status: "modified",
    binary: false,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: origins.map((origin, at) => ({
          origin,
          content: `line ${at}`,
          old_lineno: origin === "+" ? null : at + 1,
          new_lineno: origin === "-" ? null : at + 1,
        })),
      },
    ],
    ...patch,
  };
}

function task(patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    workspace_id: "w1",
    project_id: "p1",
    conversation_id: "conv-t1",
    agent_id: "a1",
    agent_name: "Bot",
    provider: "claude",
    model: "sonnet",
    prompt: "",
    goal: "Arregla el login",
    title: "Arregla el login",
    status: "idle",
    turns: 1,
    last_error: "",
    ...patch,
  } as unknown as AgentTask;
}

const review = () => reviewOf(useTaskReviewStore.getState(), "t1");

beforeEach(() => {
  handlers = {};
  useTaskReviewStore.setState({ byTask: {} });
  useWorkspaceStore.setState({
    activeWorkspaceId: "w1",
    projectsByWorkspace: { w1: [{ id: "p1", name: "api", local_path: "/tmp/api" }] },
  } as never);
  useAgentsStore.setState({ workspaceId: "w1", tasks: [task()], live: {}, bounced: {} });
});

describe("mergeSides", () => {
  it("counts each file's added and removed lines", () => {
    const [row] = mergeSides([fileDiff("src/a.ts", ["+", "+", "-", " "])], []);
    expect(row).toMatchObject({ path: "src/a.ts", added: 2, removed: 1, staged: false });
  });

  it("shows a file that is in both sides once, as its working-tree side", () => {
    const rows = mergeSides([fileDiff("src/a.ts", ["+"])], [fileDiff("src/a.ts", ["+", "+"])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ added: 1, staged: false });
  });

  it("keeps a file that is only staged, marked as such", () => {
    const rows = mergeSides([], [fileDiff("src/b.ts", ["-"])]);
    expect(rows[0]).toMatchObject({ path: "src/b.ts", staged: true });
  });

  it("sorts by path", () => {
    const rows = mergeSides([fileDiff("src/z.ts", ["+"]), fileDiff("src/a.ts", ["+"])], []);
    expect(rows.map((row) => row.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });
});

describe("load", () => {
  it("reads the worktree it is given, not the repository", async () => {
    const seen: unknown[] = [];
    handlers.get_working_diff = (args) => {
      seen.push(args.repoPath);
      return [fileDiff("src/a.ts", ["+"])];
    };
    handlers.get_staged_diff = () => [];
    await useTaskReviewStore.getState().load("t1", "/tmp/wt/login");
    expect(seen).toEqual(["/tmp/wt/login"]);
    expect(review().files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  it("keeps the comments already written across a refresh", async () => {
    handlers.get_working_diff = () => [fileDiff("src/a.ts", ["+"])];
    handlers.get_staged_diff = () => [];
    await useTaskReviewStore.getState().load("t1", "/tmp/api");
    useTaskReviewStore.getState().addComment("t1", {
      path: "src/a.ts",
      side: "new",
      lineno: 1,
      code: "+ a",
      body: "revisa esto",
    });
    await useTaskReviewStore.getState().load("t1", "/tmp/api");
    expect(review().comments).toHaveLength(1);
  });

  it("closes a file that is no longer changed", async () => {
    handlers.get_working_diff = () => [fileDiff("src/a.ts", ["+"])];
    handlers.get_staged_diff = () => [];
    handlers.get_file_diff = () => fileDiff("src/a.ts", ["+"]);
    await useTaskReviewStore.getState().load("t1", "/tmp/api");
    await useTaskReviewStore.getState().selectFile("t1", "src/a.ts");
    expect(review().selected).toBe("src/a.ts");

    handlers.get_working_diff = () => [];
    await useTaskReviewStore.getState().load("t1", "/tmp/api");
    expect(review().selected).toBeNull();
    expect(review().diff).toBeNull();
  });

  it("reports a failure instead of showing an empty review as a clean tree", async () => {
    handlers.get_working_diff = () => {
      throw new Error("not a git repository");
    };
    handlers.get_staged_diff = () => [];
    await useTaskReviewStore.getState().load("t1", "/tmp/gone");
    expect(review().error).toContain("not a git repository");
    expect(review().loading).toBe(false);
  });

  it("does nothing for a task with no working copy", async () => {
    handlers.get_working_diff = () => {
      throw new Error("should not be asked");
    };
    await useTaskReviewStore.getState().load("t1", "");
    expect(review().error).toBe("");
  });
});

describe("selectFile", () => {
  it("asks for the staged side of a file that is only staged", async () => {
    handlers.get_working_diff = () => [];
    handlers.get_staged_diff = () => [fileDiff("src/b.ts", ["+"])];
    const asked: Record<string, unknown>[] = [];
    handlers.get_file_diff = (args) => {
      asked.push(args);
      return fileDiff("src/b.ts", ["+"]);
    };
    await useTaskReviewStore.getState().load("t1", "/tmp/api");
    await useTaskReviewStore.getState().selectFile("t1", "src/b.ts");
    expect(asked[0]).toMatchObject({ path: "src/b.ts", staged: true });
  });

  it("closes the pane with null", async () => {
    handlers.get_working_diff = () => [fileDiff("src/a.ts", ["+"])];
    handlers.get_staged_diff = () => [];
    handlers.get_file_diff = () => fileDiff("src/a.ts", ["+"]);
    await useTaskReviewStore.getState().load("t1", "/tmp/api");
    await useTaskReviewStore.getState().selectFile("t1", "src/a.ts");
    await useTaskReviewStore.getState().selectFile("t1", null);
    expect(review().selected).toBeNull();
    expect(review().diff).toBeNull();
  });
});

describe("sendReview", () => {
  function comment(body = "arregla esto"): void {
    useTaskReviewStore.getState().addComment("t1", {
      path: "src/a.ts",
      side: "new",
      lineno: 7,
      code: "+ const a = 1",
      body,
    });
  }

  it("sends the comments as the next turn and clears them", () => {
    let sent = "";
    useAgentsStore.setState({
      send: ((_id: string, message: string) => {
        sent = message;
        return true;
      }) as never,
    } as never);

    comment();
    useTaskReviewStore.getState().setGeneral("t1", "y revisa los tests");
    expect(useTaskReviewStore.getState().sendReview("t1", LABELS)).toBe(true);

    expect(sent).toContain("### src/a.ts:7");
    expect(sent).toContain("> arregla esto");
    expect(sent).toContain("### Nota general");
    expect(review().comments).toEqual([]);
    expect(review().general).toBe("");
  });

  it("keeps the comments when the send is refused", () => {
    useAgentsStore.setState({ send: (() => false) as never } as never);
    comment();
    expect(useTaskReviewStore.getState().sendReview("t1", LABELS)).toBe(false);
    expect(review().comments).toHaveLength(1);
  });

  it("refuses an empty review without touching the task", () => {
    let calls = 0;
    useAgentsStore.setState({
      send: (() => {
        calls += 1;
        return true;
      }) as never,
    } as never);
    expect(useTaskReviewStore.getState().sendReview("t1", LABELS)).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("forget", () => {
  it("drops a deleted task's review", () => {
    useTaskReviewStore.getState().setGeneral("t1", "algo");
    useTaskReviewStore.getState().forget("t1");
    expect(useTaskReviewStore.getState().byTask.t1).toBeUndefined();
  });
});

describe("a task that goes", () => {
  it("takes its review with it", () => {
    useTaskReviewStore.getState().setGeneral("t1", "algo");
    useAgentsStore.setState({ tasks: [] });
    expect(useTaskReviewStore.getState().byTask.t1).toBeUndefined();
  });

  it("leaves the others alone", () => {
    useAgentsStore.setState({ tasks: [task(), task({ id: "t2" })] });
    useTaskReviewStore.getState().setGeneral("t1", "algo");
    useTaskReviewStore.getState().setGeneral("t2", "otra");
    useAgentsStore.setState({ tasks: [task()] });
    expect(useTaskReviewStore.getState().byTask.t1).toBeDefined();
    expect(useTaskReviewStore.getState().byTask.t2).toBeUndefined();
  });
});
