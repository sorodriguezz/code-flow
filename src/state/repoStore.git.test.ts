import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The git flows in `repoStore` that stop to ask, or that must not lose anything when they fail:
 * the commit that keeps its message, the identity form, the auto-fetch that reports once, the pull
 * that diverged, the push that was rejected, the publish with no remote, and the branch delete
 * that counts what it loses.
 *
 * `invoke` is scripted per command; anything a test does not script answers `null`, which is what
 * the refreshes that run after every action need to get through quietly.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];

const EMPTY_STATUS = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  current_branch: "main",
  is_detached: false,
  head_oid: "abc",
};

/** What the refreshes read, so a successful action can reload without a scripted answer each. */
const DEFAULTS: Record<string, Handler> = {
  get_status: () => EMPTY_STATUS,
  get_working_diff: () => [],
  get_staged_diff: () => [],
  list_branches: () => [],
  list_commits_page: () => ({ commits: [], has_more: false }),
  list_unpushed_commits: () => [],
  list_stashes: () => [],
  list_remotes: () => [],
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

const { useRepoStore } = await import("./repoStore");
const { useToastStore } = await import("./toastStore");
const { useConfirmStore } = await import("./confirmStore");
const { usePromptStore } = await import("./promptStore");
const { useGitDialogStore } = await import("./gitDialogStore");

/** Waits for a dialog to be asked for — the store awaits it mid-action. */
async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("the question was never asked");
}

const called = (name: string) => calls.filter((c) => c.name === name);
const errorToasts = () => useToastStore.getState().toasts.filter((t) => t.type === "error");

beforeEach(() => {
  handlers = {};
  calls = [];
  useToastStore.setState({ toasts: [] });
  useConfirmStore.setState({ request: null });
  usePromptStore.setState({ request: null });
  useGitDialogStore.setState({ pullChoice: null, identity: null });
  useRepoStore.setState({
    repoPath: "/repo",
    busy: false,
    remoteOp: null,
    status: EMPTY_STATUS,
    branches: [
      {
        name: "main",
        is_head: true,
        is_remote: false,
        upstream: "origin/main",
        ahead: 1,
        behind: 1,
        target: "abc",
        tip_time: 0,
        is_locked: false,
        locked_by_rule: false,
      },
    ],
    remotes: [{ name: "origin", url: "https://example.com/o/r.git" }],
  });
});

describe("commit", () => {
  it("reports a failure instead of pretending it committed, so the message survives", async () => {
    handlers.commit = () => {
      throw "pre-commit hook failed";
    };
    const committed = await useRepoStore.getState().commitChanges("my careful message");
    expect(committed).toBe(false);
    expect(errorToasts()).toHaveLength(1);
    expect(useRepoStore.getState().busy).toBe(false);
  });

  it("reports success", async () => {
    handlers.commit = () => "newoid";
    expect(await useRepoStore.getState().commitChanges("msg")).toBe(true);
  });

  it("asks for a name and email when git has none, and retries with the same message", async () => {
    let attempts = 0;
    handlers.commit = () => {
      attempts += 1;
      if (attempts === 1) throw "IDENTITY_MISSING: config value 'user.name' was not found";
      return "newoid";
    };
    const pending = useRepoStore.getState().commitChanges("keep me");
    const request = await until(() => useGitDialogStore.getState().identity);
    request.resolve(true);
    expect(await pending).toBe(true);
    expect(called("commit").map((c) => c.args.message)).toEqual(["keep me", "keep me"]);
    expect(errorToasts()).toHaveLength(0);
  });

  it("does not retry when the form is dismissed, and does not claim a commit", async () => {
    handlers.commit = () => {
      throw "IDENTITY_MISSING: config value 'user.name' was not found";
    };
    const pending = useRepoStore.getState().commitChanges("keep me");
    (await until(() => useGitDialogStore.getState().identity)).resolve(false);
    expect(await pending).toBe(false);
    expect(called("commit")).toHaveLength(1);
  });
});

describe("auto-fetch", () => {
  it("reports an offline failure once, then stays quiet until a fetch works", async () => {
    let online = false;
    handlers.git_fetch = () => {
      if (!online) throw "GIT_REMOTE: network\ngit fetch failed: Could not resolve host: example.com";
      return null;
    };
    const fetch = useRepoStore.getState().fetch;
    await fetch({ auto: true });
    await fetch({ auto: true });
    await fetch({ auto: true });
    expect(errorToasts()).toHaveLength(1);

    // A fetch the user asked for always answers.
    await fetch();
    expect(errorToasts()).toHaveLength(2);

    // Back online: the next failure is news again.
    online = true;
    await fetch({ auto: true });
    online = false;
    await fetch({ auto: true });
    expect(errorToasts()).toHaveLength(3);
  });
});

describe("pull", () => {
  it("asks how to reconcile diverged branches and pulls with the answer", async () => {
    handlers.git_pull = () => {
      throw "PULL_DIVERGED: git pull failed: fatal: Need to specify how to reconcile divergent branches.";
    };
    const pending = useRepoStore.getState().pull();
    const request = await until(() => useGitDialogStore.getState().pullChoice);
    expect(request.branch).toBe("main");
    expect(request.upstream).toBe("origin/main");
    request.resolve({ mode: "rebase", remember: true });
    await pending;
    expect(called("git_pull_with").map((c) => c.args)).toEqual([{ repoPath: "/repo", mode: "rebase", remember: true }]);
    expect(errorToasts()).toHaveLength(0);
  });

  it("does nothing more when the choice is cancelled", async () => {
    handlers.git_pull = () => {
      throw "PULL_DIVERGED: git pull failed";
    };
    const pending = useRepoStore.getState().pull();
    (await until(() => useGitDialogStore.getState().pullChoice)).resolve(null);
    await pending;
    expect(called("git_pull_with")).toHaveLength(0);
    expect(useRepoStore.getState().remoteOp).toBeNull();
  });

  it("treats a pull that stopped on conflicts as work to do, not as an error", async () => {
    handlers.git_pull = () => {
      throw "OPERATION_CONFLICTS: merge";
    };
    handlers.get_operation_state = () => ({ kind: "merge", sequenced: false, conflicts: ["a.txt"], message: "Merge" });
    await useRepoStore.getState().pull();
    expect(errorToasts()).toHaveLength(0);
    expect(useRepoStore.getState().operation).toBe("merge");
    expect(useRepoStore.getState().conflicts).toEqual([{ path: "a.txt" }]);
  });
});

describe("push", () => {
  it("offers a force push with lease, naming the branch and remote, when the push is rejected", async () => {
    handlers.git_push = () => {
      throw "PUSH_REJECTED: git push failed:  ! [rejected] main -> main (non-fast-forward)";
    };
    const pending = useRepoStore.getState().push(false);
    const request = await until(() => useConfirmStore.getState().request);
    expect(request.danger).toBe(true);
    expect(request.message).toContain("main");
    expect(request.message).toContain("origin/main");
    useConfirmStore.getState().respond(true);
    await pending;
    expect(called("git_push_force_with_lease")).toHaveLength(1);
  });

  it("never forces when the confirmation is declined", async () => {
    handlers.git_push = () => {
      throw "PUSH_REJECTED: git push failed";
    };
    const pending = useRepoStore.getState().push(false);
    await until(() => useConfirmStore.getState().request);
    useConfirmStore.getState().respond(false);
    await pending;
    expect(called("git_push_force_with_lease")).toHaveLength(0);
  });

  it("publishing with no remote asks for a URL, adds it as origin, and publishes", async () => {
    let pushes = 0;
    handlers.git_push = () => {
      pushes += 1;
      if (pushes === 1) throw "NO_REMOTE: this repository has no remote";
      return null;
    };
    const pending = useRepoStore.getState().push(true);
    const request = await until(() => usePromptStore.getState().request);
    expect(request.validate?.("not a url")).not.toBeNull();
    expect(request.validate?.("https://example.com/o/r.git")).toBeNull();
    usePromptStore.getState().respond("https://example.com/o/r.git");
    await pending;
    expect(called("add_remote").map((c) => c.args)).toEqual([
      { repoPath: "/repo", name: "origin", url: "https://example.com/o/r.git" },
    ]);
    expect(called("git_push").map((c) => c.args.setUpstream)).toEqual([true, true]);
  });
});

describe("branch delete", () => {
  it("says how many commits the delete would lose", async () => {
    handlers.branch_unmerged_count = () => 3;
    const pending = useRepoStore.getState().deleteBranch("feature", false);
    const request = await until(() => useConfirmStore.getState().request);
    expect(request.danger).toBe(true);
    expect(request.flow?.note).toContain("3");
    useConfirmStore.getState().respond(false);
    await pending;
    expect(called("delete_branch")).toHaveLength(0);
  });
});

describe("operation state", () => {
  it("shows conflicts whatever the operation, and none", async () => {
    handlers.get_operation_state = () => ({ kind: null, sequenced: false, conflicts: ["x.txt"], message: null });
    await useRepoStore.getState().refreshMergeState();
    expect(useRepoStore.getState().operation).toBeNull();
    expect(useRepoStore.getState().conflicts).toEqual([{ path: "x.txt" }]);

    handlers.get_operation_state = () => ({ kind: "rebase", sequenced: true, conflicts: [], message: null });
    await useRepoStore.getState().refreshMergeState();
    expect(useRepoStore.getState().operation).toBe("rebase");
    expect(useRepoStore.getState().operationSequenced).toBe(true);
  });
});

describe("line staging", () => {
  const selection = {
    file_path: "a.txt",
    lines: [{ origin: "+", content: "new", old_lineno: null, new_lineno: 2 }],
  };

  it("sends the drawn lines as they are and refreshes", async () => {
    expect(await useRepoStore.getState().stageLines(selection)).toBe(true);
    expect(called("stage_lines").map((c) => c.args)).toEqual([{ repoPath: "/repo", selection }]);
    expect(called("get_status").length).toBeGreaterThan(0);
  });

  it("reports a stale selection in words and says nothing was written", async () => {
    handlers.discard_lines = () => {
      throw "LINES_STALE: a.txt";
    };
    expect(await useRepoStore.getState().discardLines(selection)).toBe(false);
    expect(errorToasts().map((toast) => toast.message)).toEqual([
      "Those lines moved — the file changed after it was drawn. Nothing was modified; select them again.",
    ]);
  });
});

describe("commit through git", () => {
  it("shows what a refusing hook printed instead of a toast, and keeps the message", async () => {
    const { useGitOutputStore } = await import("./gitOutputStore");
    useGitOutputStore.setState({ failure: null });
    handlers.commit = () => {
      throw "HOOK_FAILED: lint: 2 problems\n  a.ts:3 no-unused-vars";
    };
    expect(await useRepoStore.getState().commitChanges("feat: x")).toBe(false);
    expect(useGitOutputStore.getState().failure).toEqual({
      kind: "hook",
      output: "lint: 2 problems\n  a.ts:3 no-unused-vars",
    });
    expect(errorToasts()).toHaveLength(0);
  });
});
