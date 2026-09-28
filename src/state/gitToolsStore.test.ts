import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The flows in `gitToolsStore` that ask before they act, or that must not act at all: undo explains
 * the plan it runs and passes the HEAD it was shown; a remote branch delete names its remote and
 * waits its turn behind a running remote operation; a dirty worktree asks twice; tags go to the
 * remote the user picked; a bisect starts from the graph with its first verdict.
 *
 * `invoke` is scripted per command, as in `repoStore.git.test.ts`.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];

const DEFAULTS: Record<string, Handler> = {
  get_status: () => ({
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    current_branch: "main",
    is_detached: false,
    head_oid: "abc",
  }),
  get_working_diff: () => [],
  get_staged_diff: () => [],
  list_branches: () => [],
  list_commits_page: () => ({ commits: [], has_more: false }),
  list_unpushed_commits: () => [],
  list_stashes: () => [],
  list_remotes: () => [],
  list_tags: () => [],
  list_worktrees: () => [],
  list_submodules: () => [],
  get_repo_features: () => ({ hooks: [], hooks_path: null, signing: null, lfs: false, lfs_available: false }),
  get_bisect_state: () => ({ active: false, bad: null, good: [], skipped: [], candidate: null, remaining: 0, steps: 0, first_bad: null }),
  get_undo_plan: () => null,
  get_operation_state: () => ({ kind: null, sequenced: false, conflicts: [], message: null }),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name] ?? DEFAULTS[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

const { useRepoStore } = await import("./repoStore");
const { useGitToolsStore } = await import("./gitToolsStore");
const { useConfirmStore } = await import("./confirmStore");
const { useToastStore } = await import("./toastStore");

async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("the question was never asked");
}

const called = (name: string) => calls.filter((c) => c.name === name);

beforeEach(() => {
  handlers = {};
  calls = [];
  useToastStore.setState({ toasts: [] });
  useConfirmStore.setState({ request: null });
  useRepoStore.setState({
    repoPath: "/repo",
    busy: false,
    remoteOp: null,
    remotes: [{ name: "origin", url: "https://example.com/o/r.git" }],
  });
  useGitToolsStore.setState({ repoPath: "/repo", pending: null });
});

describe("undo", () => {
  it("explains the plan, then undoes against the HEAD it was shown", async () => {
    handlers.get_undo_plan = () => ({
      op: "commit",
      strategy: "soft",
      target_oid: "1".repeat(40),
      target_summary: "before",
      checkout_to: null,
      branch: "main",
      message: "commit: Add the thing",
      head_oid: "2".repeat(40),
    });
    const pending = useGitToolsStore.getState().undoLast();
    const request = await until(() => useConfirmStore.getState().request);
    expect(request.message).toContain("Add the thing");
    expect(request.message).toContain("1111111");
    expect(request.danger).toBe(true);
    useConfirmStore.getState().respond(true);
    await pending;
    expect(called("undo_last_operation").map((c) => c.args)).toEqual([{ repoPath: "/repo", expectedHead: "2".repeat(40) }]);
  });

  it("does nothing when declined, and says so when there is nothing to undo", async () => {
    handlers.get_undo_plan = () => ({
      op: "merge",
      strategy: "keep",
      target_oid: "1".repeat(40),
      target_summary: null,
      checkout_to: null,
      branch: "main",
      message: "merge feature: Fast-forward",
      head_oid: "2".repeat(40),
    });
    const pending = useGitToolsStore.getState().undoLast();
    await until(() => useConfirmStore.getState().request);
    useConfirmStore.getState().respond(false);
    await pending;
    expect(called("undo_last_operation")).toHaveLength(0);

    handlers.get_undo_plan = () => null;
    await useGitToolsStore.getState().undoLast();
    expect(useConfirmStore.getState().request).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.type)).toEqual(["info"]);
  });
});

describe("remote branch delete", () => {
  it("names the remote in the confirmation and deletes on yes", async () => {
    const pending = useGitToolsStore.getState().deleteRemoteBranch("origin/feature/x");
    const request = await until(() => useConfirmStore.getState().request);
    expect(request.danger).toBe(true);
    expect(request.message).toContain("feature/x");
    expect(request.message).toContain("origin");
    useConfirmStore.getState().respond(true);
    await pending;
    expect(called("git_delete_remote_branch").map((c) => c.args)).toEqual([
      { repoPath: "/repo", remoteBranch: "origin/feature/x" },
    ]);
    expect(useRepoStore.getState().remoteOp).toBeNull();
  });

  it("waits its turn behind a running remote operation", async () => {
    useRepoStore.setState({ remoteOp: "fetch" });
    const pending = useGitToolsStore.getState().deleteRemoteBranch("origin/feature/x");
    (await until(() => useConfirmStore.getState().request)) && useConfirmStore.getState().respond(true);
    await pending;
    expect(called("git_delete_remote_branch")).toHaveLength(0);
  });
});

describe("worktree removal", () => {
  const worktree = {
    name: "wt",
    path: "/w/wt",
    branch: "feature",
    head_oid: "abc",
    is_main: false,
    is_current: false,
    locked: false,
    prunable: false,
  };

  it("asks a second time before forcing a dirty worktree away", async () => {
    let attempts = 0;
    handlers.remove_worktree = (args) => {
      attempts += 1;
      if (!args.force) throw "WORKTREE_DIRTY: /w/wt";
      return null;
    };
    const pending = useGitToolsStore.getState().removeWorktree(worktree);
    await until(() => useConfirmStore.getState().request);
    useConfirmStore.getState().respond(true);
    const second = await until(() => {
      const request = useConfirmStore.getState().request;
      return request && request.message.includes("uncommitted") ? request : null;
    });
    expect(second.danger).toBe(true);
    useConfirmStore.getState().respond(true);
    await pending;
    expect(called("remove_worktree").map((c) => c.args.force)).toEqual([false, true]);
    expect(attempts).toBe(2);
  });

  it("stops at the second question when it is declined", async () => {
    handlers.remove_worktree = () => {
      throw "WORKTREE_DIRTY: /w/wt";
    };
    const pending = useGitToolsStore.getState().removeWorktree(worktree);
    await until(() => useConfirmStore.getState().request);
    useConfirmStore.getState().respond(true);
    await until(() => {
      const request = useConfirmStore.getState().request;
      return request && request.message.includes("uncommitted") ? request : null;
    });
    useConfirmStore.getState().respond(false);
    await pending;
    expect(called("remove_worktree").map((c) => c.args.force)).toEqual([false]);
  });
});

describe("tags", () => {
  it("asks which remote when there are several, and pushes the tag there", async () => {
    useRepoStore.setState({
      remotes: [
        { name: "origin", url: "https://example.com/o/r.git" },
        { name: "upstream", url: "https://example.com/u/r.git" },
      ],
    });
    const pending = useGitToolsStore.getState().pushTag("v1.2.0");
    const request = await until(() => useConfirmStore.getState().request);
    expect(request.choices?.map((c) => c.id)).toEqual(["origin", "upstream"]);
    useConfirmStore.getState().pick("upstream");
    await pending;
    expect(called("git_push_tag").map((c) => c.args)).toEqual([{ repoPath: "/repo", tag: "v1.2.0", remoteName: "upstream" }]);
  });

  it("deletes a remote tag only after a danger confirmation naming the remote", async () => {
    const pending = useGitToolsStore.getState().deleteRemoteTag("v1");
    const request = await until(() => useConfirmStore.getState().request);
    expect(request.danger).toBe(true);
    expect(request.message).toContain("origin");
    useConfirmStore.getState().respond(true);
    await pending;
    expect(called("git_delete_remote_tag").map((c) => c.args)).toEqual([{ repoPath: "/repo", remoteName: "origin", tag: "v1" }]);
  });
});

describe("bisect", () => {
  it("starts from a commit with its verdict and keeps the state it answers with", async () => {
    const state = { active: true, bad: "c".repeat(40), good: [], skipped: [], candidate: null, remaining: 0, steps: 0, first_bad: null };
    handlers.bisect_start = () => state;
    await useGitToolsStore.getState().bisectStart("bad", "c".repeat(40));
    expect(called("bisect_start").map((c) => c.args)).toEqual([{ repoPath: "/repo", verdict: "bad", rev: "c".repeat(40) }]);
    expect(useGitToolsStore.getState().bisect).toEqual(state);
  });
});
