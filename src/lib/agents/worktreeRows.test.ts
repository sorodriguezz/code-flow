import { describe, expect, it } from "vitest";
import {
  agentsByRow,
  buildRepoBlocks,
  cardState,
  folderName,
  isListed,
  isUnread,
  listedBlocks,
  railSections,
  rowForFolder,
  rowState,
  taskLine,
  terminalLine,
  type WorktreeListing,
} from "./worktreeRows";
import type { AgentTask, TerminalAgent } from "../../types/domain";

function task(id: string, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    workspace_id: "w1",
    project_id: "p1",
    agent_id: "a1",
    agent_name: "Bot",
    provider: "claude",
    model: "sonnet",
    prompt: "",
    goal: "Arregla el login",
    title: "Arregla el login",
    agent_project_id: "",
    batch_id: "",
    pinned: false,
    conversation_id: `agent-${id}`,
    status: "idle",
    turns: 1,
    last_error: "",
    created_at: "2026-10-19T10:00:00Z",
    updated_at: "2026-10-19T10:00:00Z",
    ...patch,
  } as AgentTask;
}

const repo = { id: "p1", name: "app", local_path: "/src/app" };
const main: WorktreeListing = { path: "/src/app", branch: "main", is_main: true, prunable: false };

describe("buildRepoBlocks", () => {
  it("gives every repository its main checkout, even with nothing in it", () => {
    const [block] = buildRepoBlocks([repo], { p1: [main] }, []);
    expect(block.rows).toHaveLength(1);
    expect(block.rows[0]).toMatchObject({ isMain: true, task: null, path: "/src/app", branch: "main" });
  });

  it("puts a worktree task at its worktree and a plain task at the main checkout", () => {
    const tasks = [
      task("wt", { worktree_path: "/wt/login", worktree_branch: "agent/login" }),
      task("here", { created_at: "2026-10-19T09:00:00Z" }),
    ];
    const [block] = buildRepoBlocks([repo], { p1: [main] }, tasks);
    expect(block.rows.map((row) => row.key)).toEqual(["task:wt", "task:here"]);
    expect(block.rows[0]).toMatchObject({ path: "/wt/login", branch: "agent/login", isMain: false });
    expect(block.rows[1]).toMatchObject({ path: "/src/app", branch: "main", isMain: true });
  });

  it("lists a worktree nobody owns, and not one a task already stands for", () => {
    const listing: WorktreeListing[] = [
      main,
      { path: "/wt/login/", branch: "agent/login", is_main: false, prunable: false },
      { path: "/wt/manual", branch: "spike", is_main: false, prunable: false },
      { path: "/wt/gone", branch: "old", is_main: false, prunable: true },
    ];
    const [block] = buildRepoBlocks([repo], { p1: listing }, [task("wt", { worktree_path: "/wt/login" })]);
    const keys = block.rows.map((row) => row.key);
    expect(keys).toContain("task:wt");
    expect(keys).toContain("path:/wt/manual");
    // The trailing slash is the same folder; the prunable one is gone from disk.
    expect(block.rows.filter((row) => row.path.includes("login")).map((row) => row.key)).toEqual(["task:wt"]);
    expect(keys.some((key) => key.includes("gone"))).toBe(false);
  });

  it("leaves archived tasks out", () => {
    const [block] = buildRepoBlocks([repo], { p1: [main] }, [task("old", { archived: true, worktree_path: "/wt/x" })]);
    expect(block.rows.every((row) => row.task === null)).toBe(true);
  });

  it("gathers a race into one entry, its runners in the order they were started", () => {
    const tasks = [
      task("b", { batch_id: "r1", worktree_path: "/wt/b", created_at: "2026-10-19T10:00:01Z" }),
      task("solo", { worktree_path: "/wt/solo", created_at: "2026-10-19T11:00:00Z" }),
      task("a", { batch_id: "r1", worktree_path: "/wt/a", created_at: "2026-10-19T10:00:00Z" }),
    ];
    const [block] = buildRepoBlocks([repo], { p1: [main] }, tasks);
    expect(block.items[0]).toMatchObject({ kind: "row" });
    const race = block.items[1];
    expect(race.kind).toBe("race");
    if (race.kind === "race") expect(race.rows.map((row) => row.task?.id)).toEqual(["a", "b"]);
    // Counted once each, races flattened.
    expect(block.rows.filter((row) => row.task).length).toBe(3);
  });

  it("reads a repository whose worktrees have not been listed yet", () => {
    const [block] = buildRepoBlocks([repo], {}, [task("wt", { worktree_path: "/wt/a", worktree_branch: "x" })]);
    expect(block.rows.map((row) => row.key)).toEqual(["task:wt", "path:/src/app"]);
  });
});

describe("rowState", () => {
  const row = (patch: Partial<AgentTask> | null) => ({
    key: "k",
    projectId: "p1",
    path: "/p",
    branch: "",
    isMain: false,
    task: patch === null ? null : task("t", patch),
  });

  it("puts a waiting question above everything", () => {
    expect(rowState(row({ status: "running" }), true, true)).toBe("asking");
  });

  it("says working while a turn runs", () => {
    expect(rowState(row({ status: "idle" }), true, false)).toBe("working");
    expect(rowState(row({ status: "running" }), false, false)).toBe("working");
  });

  it("maps the task's own states", () => {
    expect(rowState(row({ status: "error" }), false, false)).toBe("failed");
    expect(rowState(row({ status: "done" }), false, false)).toBe("done");
    expect(rowState(row({ status: "cancelled" }), false, false)).toBe("stopped");
    expect(rowState(row({ status: "idle", turns: 2 }), false, false)).toBe("ready");
    expect(rowState(row({ status: "idle", turns: 0 }), false, false)).toBe("draft");
  });

  it("is empty with no task", () => {
    expect(rowState(row(null), false, false)).toBe("empty");
  });
});

describe("isUnread", () => {
  it("marks a turn that landed after the last look", () => {
    expect(isUnread(task("t", { turns: 3 }), { t: 2 }, false)).toBe(true);
    expect(isUnread(task("t", { turns: 2 }), { t: 2 }, false)).toBe(false);
  });

  it("never marks the open row or one never recorded", () => {
    expect(isUnread(task("t", { turns: 3 }), { t: 1 }, true)).toBe(false);
    expect(isUnread(task("t", { turns: 3 }), {}, false)).toBe(false);
  });
});

describe("folderName", () => {
  it("takes the last segment on either separator", () => {
    expect(folderName("/wt/login/")).toBe("login");
    expect(folderName("C:\\wt\\login")).toBe("login");
  });
});

function agent(session: string, patch: Partial<TerminalAgent> = {}): TerminalAgent {
  return {
    session_id: session,
    agent: "claude",
    state: "working",
    kind: null,
    summary: "",
    prompt: "",
    reply: "",
    cwd: "/src/app",
    since: 1000,
    turn: 1000,
    ...patch,
  };
}

describe("railSections", () => {
  const listing: WorktreeListing[] = [
    main,
    { path: "/wt/login", branch: "agent/login", is_main: false, prunable: false },
    { path: "/wt/api", branch: "agent/api", is_main: false, prunable: false },
  ];
  const blocks = buildRepoBlocks([repo], { p1: listing }, []);

  it("files every working copy under In progress until the user says otherwise, and keeps every status on screen", () => {
    const sections = railSections(blocks, { grouping: "status", lanes: {}, pinned: [] });
    expect(sections.map((section) => section.id)).toEqual(["lane:todo", "lane:progress", "lane:review", "lane:done"]);
    expect(sections[1].rows).toHaveLength(3);
    expect(sections.filter((section) => section.id !== "lane:progress").every((section) => section.rows.length === 0)).toBe(true);
  });

  it("puts pinned rows on top and the rest where they were filed — by folder, whatever its spelling", () => {
    const sections = railSections(blocks, {
      grouping: "status",
      lanes: { "/wt/api": "review" },
      pinned: ["/src/app"],
    });
    expect(sections[0]).toMatchObject({ id: "pinned", lane: null });
    expect(sections[0].rows.map((row) => row.path)).toEqual(["/src/app"]);
    expect(sections.find((section) => section.id === "lane:review")?.rows.map((row) => row.path)).toEqual(["/wt/api"]);
    expect(sections.find((section) => section.id === "lane:progress")?.rows.map((row) => row.path)).toEqual(["/wt/login"]);
  });

  it("groups by repository when asked, leaving out the empty ones", () => {
    const other = { id: "p2", name: "lib", local_path: "/src/lib" };
    const two = buildRepoBlocks([repo, other], { p1: listing, p2: [] }, []);
    const sections = railSections(two, { grouping: "project", lanes: {}, pinned: ["/wt/login"] });
    expect(sections.map((section) => section.id)).toEqual(["pinned", "project:p1", "project:p2"]);
    expect(sections[1].rows.map((row) => row.path)).toEqual(["/wt/api", "/src/app"]);
  });
});

describe("terminal agents on the rail", () => {
  const listing: WorktreeListing[] = [main, { path: "/src/app/.claude/worktrees/nice", branch: "claude/nice", is_main: false, prunable: false }];
  const rows = buildRepoBlocks([repo], { p1: listing }, [])[0].rows;

  it("files a terminal under the working copy that holds its folder most closely", () => {
    expect(rowForFolder(rows, "/src/app/src/lib")?.path).toBe("/src/app");
    // A Claude Code worktree sits inside the repository, and is its own row.
    expect(rowForFolder(rows, "/src/app/.claude/worktrees/nice/src")?.path).toBe("/src/app/.claude/worktrees/nice");
    expect(rowForFolder(rows, "/elsewhere")).toBeNull();
    const byRow = agentsByRow(rows, {
      a: agent("a", { cwd: "/src/app" }),
      b: agent("b", { cwd: "/src/app/.claude/worktrees/nice" }),
      gone: agent("gone", { state: null }),
    });
    expect(byRow.get("path:/src/app")?.map((entry) => entry.session_id)).toEqual(["a"]);
    expect(byRow.get("path:/src/app/.claude/worktrees/nice")?.map((entry) => entry.session_id)).toEqual(["b"]);
  });

  it("reads a turn that ended after the user last looked as unread", () => {
    const done = agent("a", { state: "done", turn: 5000, prompt: "fix it", reply: "Fixed." });
    expect(terminalLine(done, 4000)).toMatchObject({ state: "done", unread: true, prompt: "fix it", detail: "Fixed." });
    expect(terminalLine(done, 6000)?.unread).toBe(false);
    // Still working is not news yet.
    expect(terminalLine(agent("a", { turn: 5000 }), 0)?.unread).toBe(false);
    // The agent's own summary stands in for a reply it did not send.
    expect(terminalLine(agent("a", { summary: "Reading src/" }), 0)?.detail).toBe("Reading src/");
  });

  it("wears the most urgent state of everyone in it", () => {
    const working = terminalLine(agent("a"), 0)!;
    const waiting = terminalLine(agent("b", { state: "blocked" }), 0)!;
    const chat = taskLine(task("t"), "ready", false);
    expect(cardState([chat, working])).toBe("working");
    expect(cardState([chat, working, waiting])).toBe("blocked");
    expect(cardState([chat])).toBe("done");
    expect(cardState([])).toBeNull();
  });
});

describe("what the rail lists", () => {
  const listing: WorktreeListing[] = [
    main,
    { path: "/src/app/.claude/worktrees/nice", branch: "claude/nice", is_main: false, prunable: false },
    { path: "/wt/login", branch: "codeflow/login", is_main: false, prunable: false },
  ];
  const blocks = buildRepoBlocks([repo], { p1: listing }, [task("chat", { worktree_path: "/wt/chat", worktree_branch: "codeflow/chat" })]);
  const none = { names: {}, pinned: [], byRow: new Map() };

  it("lists tasks, not every folder git knows about", () => {
    expect(listedBlocks(blocks, none)[0].rows.map((row) => row.key)).toEqual(["task:chat"]);
  });

  it("lists a space «Nuevo agente» made, one with an agent at work, and a pinned one", () => {
    const rows = blocks[0].rows;
    const byRow = new Map([["path:/src/app/.claude/worktrees/nice", [agent("a")]]]);
    const context = { names: { "/wt/login": "Arreglar el login" }, pinned: ["/src/app"], byRow };
    expect(rows.filter((row) => isListed(row, context)).map((row) => row.path)).toEqual([
      "/wt/chat",
      "/src/app/.claude/worktrees/nice",
      "/wt/login",
      "/src/app",
    ]);
  });
});

