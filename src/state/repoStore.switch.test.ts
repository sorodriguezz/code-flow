import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Switching repository: a repository seen before comes back as it was left and is re-read quietly,
 * a first visit unfolds the projects panel on its own reads, and an answer for the repository just
 * left never lands on the one just opened.
 *
 * Every read answers for the path it was asked about, so what is on screen can be traced to the
 * repository it came from. A read can be held back with `hold`, to land after a switch.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let calls: { name: string; args: Record<string, unknown> }[] = [];
let held: Record<string, Promise<void>> = {};

const commit = (repo: string, n: number) => ({
  id: `${repo}-${n}`,
  short_id: `${repo}-${n}`,
  summary: `${repo} commit ${n}`,
  author_name: "Test",
  author_email: "test@example.com",
  timestamp: 0,
  parent_ids: [],
  refs: [],
});

const branch = (repo: string) => ({ name: `${repo}-main`, is_head: true, is_remote: false, target: "x", ahead: 0, behind: 0 });

const READS: Record<string, Handler> = {
  get_status: ({ repoPath }) => ({
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    current_branch: `${repoPath}-main`,
    is_detached: false,
    head_oid: "x",
  }),
  get_working_diff: () => [],
  get_staged_diff: () => [],
  list_branches: ({ repoPath }) => [branch(String(repoPath))],
  list_commits_page: ({ repoPath }) => ({ commits: [commit(String(repoPath), 1)], has_more: false }),
  list_unpushed_commits: () => [],
  list_stashes: () => [],
  list_remotes: () => [],
  get_operation_state: () => ({ kind: null, sequenced: false, conflicts: [], message: null }),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const wait = held[`${name}:${String(args.repoPath)}`];
    if (wait) await wait;
    return READS[name]?.(args) ?? null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { useRepoStore } = await import("./repoStore");

/** Holds `name` for `repo` until the returned function is called. */
function hold(name: string, repo: string): () => void {
  let release = () => {};
  held[`${name}:${repo}`] = new Promise<void>((resolve) => (release = resolve));
  return () => release();
}

const reads = (repo: string) => calls.filter((c) => c.args.repoPath === repo).map((c) => c.name);

beforeEach(() => {
  calls = [];
  held = {};
});

describe("switching repository", () => {
  it("brings a repository seen before back at once, and re-reads it without a skeleton", async () => {
    await useRepoStore.getState().setRepoPath("/seen-a");
    await useRepoStore.getState().setRepoPath("/seen-b");
    expect(useRepoStore.getState().commits[0].summary).toBe("/seen-b commit 1");

    calls = [];
    const back = useRepoStore.getState().setRepoPath("/seen-a");
    // Before any read has answered: the repository as it was left, and nothing saying it is loading.
    const now = useRepoStore.getState();
    expect(now.repoPath).toBe("/seen-a");
    expect(now.commits[0].summary).toBe("/seen-a commit 1");
    expect(now.branches[0].name).toBe("/seen-a-main");
    expect(now.status?.current_branch).toBe("/seen-a-main");
    expect(now.projectLoading).toBe(false);
    expect(now.commitsLoading).toBe(false);
    await back;
    // Still re-read, every part of it.
    expect(reads("/seen-a")).toEqual(expect.arrayContaining(["get_status", "list_branches", "list_commits_page"]));
    expect(useRepoStore.getState().commitsLoading).toBe(false);
  });

  it("loads a first visit from nothing, and unfolds the panel before the history has arrived", async () => {
    await useRepoStore.getState().setRepoPath("/first-a");
    const releaseHistory = hold("list_commits_page", "/first-b");
    const opening = useRepoStore.getState().setRepoPath("/first-b");
    expect(useRepoStore.getState().projectLoading).toBe(true);
    expect(useRepoStore.getState().commits).toEqual([]);
    expect(useRepoStore.getState().branches).toEqual([]);

    // Branches, stashes, remotes and merge state are in; the history is still held back.
    await vi.waitFor(() => expect(useRepoStore.getState().projectLoading).toBe(false));
    expect(useRepoStore.getState().branches[0].name).toBe("/first-b-main");
    expect(useRepoStore.getState().commits).toEqual([]);
    expect(useRepoStore.getState().commitsLoading).toBe(true);

    releaseHistory();
    await opening;
    expect(useRepoStore.getState().commits[0].summary).toBe("/first-b commit 1");
    expect(useRepoStore.getState().commitsLoading).toBe(false);
  });

  it("never lets an answer for the repository just left land on the one just opened", async () => {
    const releaseBranches = hold("list_branches", "/slow-a");
    const releaseHistory = hold("list_commits_page", "/slow-a");
    const leaving = useRepoStore.getState().setRepoPath("/slow-a");
    await useRepoStore.getState().setRepoPath("/slow-b");

    releaseBranches();
    releaseHistory();
    await leaving;
    const now = useRepoStore.getState();
    expect(now.repoPath).toBe("/slow-b");
    expect(now.branches.map((b) => b.name)).toEqual(["/slow-b-main"]);
    expect(now.commits.map((c) => c.summary)).toEqual(["/slow-b commit 1"]);
    expect(now.commitsLoading).toBe(false);
    expect(now.projectLoading).toBe(false);
  });

  it("does not keep a repository it never finished reading", async () => {
    const releaseHistory = hold("list_commits_page", "/half-a");
    const leaving = useRepoStore.getState().setRepoPath("/half-a");
    await vi.waitFor(() => expect(useRepoStore.getState().projectLoading).toBe(false));
    // Left while its history was still on its way.
    await useRepoStore.getState().setRepoPath("/half-b");
    releaseHistory();
    await leaving;

    const back = useRepoStore.getState().setRepoPath("/half-a");
    // Not an empty graph with no skeleton: a first visit again, loading from nothing.
    expect(useRepoStore.getState().projectLoading).toBe(true);
    expect(useRepoStore.getState().commits).toEqual([]);
    await back;
    expect(useRepoStore.getState().commits[0].summary).toBe("/half-a commit 1");
  });
});
