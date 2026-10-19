import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../../types/domain";
import type { TaskReview } from "../../state/taskReviewStore";

/**
 * The columns are the comparison: whose work each one is, which branch it is on, and how much it
 * changed. All three are pinned here, as is the one thing the panel must *not* grow — a button that
 * merges or deletes anything.
 *
 * The stores are stand-ins: these render on the server (the suite has no DOM) and zustand serves a
 * server render from its initial state, so seeding the real ones would assert against an empty
 * panel. See `TaskReviewPanel.test.tsx`.
 */

let reviews: Record<string, TaskReview>;
let tasks: AgentTask[];

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../../state/taskReviewStore", () => {
  const store = (selector: (s: unknown) => unknown) => selector({ load: async () => {} });
  store.getState = () => ({ load: async () => {}, requestTab: () => {} });
  return { useTaskReviewStore: store, reviewOf: (_s: unknown, id: string) => reviews[id] };
});
vi.mock("../../state/agentsStore", () => {
  const store = (selector: (s: unknown) => unknown) => selector({ tasks, live: {}, selectedId: null });
  store.getState = () => ({ select: async () => {} });
  return { useAgentsStore: store };
});

const { RacePanel } = await import("./RacePanel");

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
    updated_at: "2026-10-19T10:00:00Z",
    worktree_path: `/wt/${id}`,
    worktree_branch: `agent/${id}`,
    ...patch,
  } as AgentTask;
}

function review(files: TaskReview["files"]): TaskReview {
  return {
    repoPath: "/wt",
    files,
    loading: false,
    error: "",
    selected: null,
    diff: null,
    diffLoading: false,
    comments: [],
    general: "",
  };
}

const file = (path: string, added: number, removed: number) => ({
  path,
  status: "modified",
  binary: false,
  added,
  removed,
  staged: false,
});

beforeEach(() => {
  tasks = [task("1"), task("2")];
  reviews = {
    "1": review([file("src/a.ts", 10, 2), file("src/b.ts", 5, 0)]),
    "2": review([file("src/a.ts", 1, 1)]),
  };
});

const render = () => renderToStaticMarkup(<RacePanel batchId="race-1" />);

describe("RacePanel", () => {
  it("draws a column per racer, with its agent and its branch", () => {
    const html = render();
    expect(html).toContain("Bot 1");
    expect(html).toContain("Bot 2");
    expect(html).toContain("agent/1");
    expect(html).toContain("agent/2");
    expect(html).toContain("2 agents on the same goal, one worktree each");
  });

  it("totals each racer's diff", () => {
    const html = render();
    expect(html).toContain("2 file(s)");
    expect(html).toContain("+15");
    expect(html).toContain("1 file(s)");
    expect(html).toContain("+1");
  });

  it("says when a racer is still working rather than reading as finished and empty", () => {
    reviews["2"] = review([]);
    tasks = [task("1"), task("2", { status: "running" })];
    expect(render()).toContain("Still working");
  });

  it("reports a worktree it could not read on that racer's column alone", () => {
    reviews["2"] = { ...review([]), error: "not a git repository" };
    const html = render();
    expect(html).toContain("not a git repository");
    // The other column is unaffected.
    expect(html).toContain("+15");
  });

  it("says so when every task of the race is gone", () => {
    tasks = [];
    expect(render()).toContain("This race has no tasks left");
  });

  /**
   * The panel compares, and the only thing it decides is which racers to *stop* keeping. It never
   * moves a branch: merging is an act for the git views, with the branch and the working copy in
   * front of the person doing it.
   */
  it("offers to keep one, and never to merge or commit", () => {
    const html = render();
    expect(html).toContain('aria-label="Keep this one"');
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).not.toMatch(/\b(merge|commit|rebase|push)\b/i);
  });

  /** With a single racer there is nothing to discard, so the action is drawn **dead** rather than
   *  destructive by one click — present, so the column reads the same whatever the race holds. */
  it("leaves keeping dead when there is only one racer", () => {
    tasks = [task("1")];
    const html = render();
    const keep = /<button[^>]*aria-label="Keep this one"[^>]*>/.exec(html)?.[0] ?? "";
    expect(keep).not.toBe("");
    expect(keep).toContain("disabled");
  });
});
