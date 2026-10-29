import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A commit or push started in one repository ends there or is cancelled — it never lands on the
 * repository the user switched to while the scan, a confirm or the identity form was waiting.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];

const status = (branch: string | null, detached = false) => ({
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  current_branch: branch,
  is_detached: detached,
  head_oid: "abc",
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { useRepoStore, commitTargetOf, commitTargetDrift, repoDisplayName } = await import("./repoStore");
const { useToastStore } = await import("./toastStore");
const { useGitDialogStore } = await import("./gitDialogStore");

async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("never happened");
}

const called = (name: string) => calls.filter((c) => c.name === name);
const errorToasts = () => useToastStore.getState().toasts.filter((t) => t.type === "error");

beforeEach(() => {
  handlers = {};
  calls = [];
  useToastStore.setState({ toasts: [] });
  useGitDialogStore.setState({ pullChoice: null, identity: null });
  useRepoStore.setState({ repoPath: "/work/alpha", busy: false, remoteOp: null, status: status("main") });
});

describe("commit target", () => {
  it("is read from the active repository and branch", () => {
    expect(commitTargetOf(useRepoStore.getState())).toEqual({ repoPath: "/work/alpha", branch: "main", detached: false });
    expect(commitTargetOf({ repoPath: null, status: null })).toBeNull();
  });

  it("notices another repository, another branch, and a detach — and nothing else", () => {
    const target = commitTargetOf(useRepoStore.getState())!;
    expect(commitTargetDrift(target, { repoPath: "/work/alpha", status: status("main") })).toBeNull();
    expect(commitTargetDrift(target, { repoPath: "/work/alpha", status: null })).toBeNull();
    expect(commitTargetDrift(target, { repoPath: "/work/beta", status: status("main") })).toBe("repo");
    expect(commitTargetDrift(target, { repoPath: "/work/alpha", status: status("feature") })).toBe("branch");
    expect(commitTargetDrift(target, { repoPath: "/work/alpha", status: status(null, true) })).toBe("branch");
  });

  it("names a repository by its folder", () => {
    expect(repoDisplayName("/work/alpha/")).toBe("alpha");
    expect(repoDisplayName("C:\\work\\beta")).toBe("beta");
  });
});

describe("commit with an explicit repository", () => {
  it("commits into the repository it was given, not the active one, and leaves the active lists alone", async () => {
    handlers.commit = () => "newoid";
    useRepoStore.setState({ repoPath: "/work/beta" });
    expect(await useRepoStore.getState().commitChanges("msg", { repoPath: "/work/alpha" })).toBe(true);
    expect(called("commit").map((c) => c.args.repoPath)).toEqual(["/work/alpha"]);
    expect(called("get_status")).toHaveLength(0);
  });

  it("cancels instead of retrying when the identity form was answered in another repository", async () => {
    handlers.commit = () => {
      throw "IDENTITY_MISSING: config value 'user.name' was not found";
    };
    const pending = useRepoStore.getState().commitChanges("keep me", { repoPath: "/work/alpha" });
    const request = await until(() => useGitDialogStore.getState().identity);
    useRepoStore.setState({ repoPath: "/work/beta" });
    request.resolve(true);
    expect(await pending).toBe(false);
    expect(called("commit")).toHaveLength(1);
    expect(errorToasts()).toHaveLength(1);
  });
});

describe("push with an explicit repository", () => {
  it("is cancelled with a toast when another repository is active", async () => {
    useRepoStore.setState({ repoPath: "/work/beta" });
    await useRepoStore.getState().push(false, { repoPath: "/work/alpha" });
    expect(called("git_push")).toHaveLength(0);
    expect(errorToasts()).toHaveLength(1);
    expect(useRepoStore.getState().remoteOp).toBeNull();
  });

  it("pushes when it is still the active repository", async () => {
    await useRepoStore.getState().push(false, { repoPath: "/work/alpha" });
    expect(called("git_push").map((c) => c.args.repoPath)).toEqual(["/work/alpha"]);
  });
});
