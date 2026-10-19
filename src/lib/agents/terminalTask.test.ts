import { describe, expect, it } from "vitest";
import { buildCommandReport, tailLines, taskForCwd } from "./terminalTask";
import type { AgentTask } from "../../types/domain";

function task(id: string, worktree: string): AgentTask {
  return {
    id,
    workspace_id: "w1",
    project_id: "p1",
    agent_id: "a1",
    agent_name: `Bot ${id}`,
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
    worktree_path: worktree,
    worktree_branch: `agent/${id}`,
  } as AgentTask;
}

const LABELS = { intro: "Corrí esto en tu worktree:", exit: "Terminó con código 1.", output: "Salida" };

describe("taskForCwd", () => {
  it("finds the task whose worktree the shell is standing in", () => {
    const tasks = [task("a", "/wt/login"), task("b", "/wt/search")];
    expect(taskForCwd(tasks, "/wt/login/src/api")?.id).toBe("a");
  });

  it("matches the worktree root itself", () => {
    expect(taskForCwd([task("a", "/wt/login")], "/wt/login")?.id).toBe("a");
  });

  /** The trap this exists for: a prefix match on characters would hand `/wt/login-old` to the
   *  agent working in `/wt/login`. */
  it("does not match a sibling folder that merely starts the same", () => {
    expect(taskForCwd([task("a", "/wt/login")], "/wt/login-old/src")).toBeNull();
  });

  it("spells Windows paths either way, in either case", () => {
    const tasks = [task("a", "C:\\wt\\login")];
    expect(taskForCwd(tasks, "c:/WT/Login/src")?.id).toBe("a");
    expect(taskForCwd(tasks, "C:\\wt\\login\\src")?.id).toBe("a");
  });

  it("ignores a trailing separator on either side", () => {
    expect(taskForCwd([task("a", "/wt/login/")], "/wt/login/")?.id).toBe("a");
  });

  it("gives a nested worktree to the inner task", () => {
    const tasks = [task("outer", "/wt"), task("inner", "/wt/login")];
    expect(taskForCwd(tasks, "/wt/login/src")?.id).toBe("inner");
  });

  /** A task editing the repository's own working copy would otherwise own every shell opened
   *  anywhere in that repository. */
  it("never matches a task that has no worktree of its own", () => {
    expect(taskForCwd([task("a", "")], "/repo/src")).toBeNull();
  });

  it("is null for a shell with no folder yet", () => {
    expect(taskForCwd([task("a", "/wt/login")], "")).toBeNull();
  });
});

describe("buildCommandReport", () => {
  it("states the command, how it ended and what it printed", () => {
    const text = buildCommandReport({ command: "pnpm test", exit: 1, output: "2 failed" }, LABELS);
    expect(text).toBe(
      ["Corrí esto en tu worktree:", "```\npnpm test\n```", "Terminó con código 1.", "### Salida\n\n```\n2 failed\n```"].join(
        "\n\n",
      ),
    );
  });

  /** A build that fails silently and one that succeeds silently print the same thing. */
  it("says nothing about the exit code when there is none to say", () => {
    const text = buildCommandReport({ command: "pnpm test", exit: null, output: "ok" }, LABELS);
    expect(text).not.toContain("código");
  });

  it("outgrows a fence inside the output", () => {
    const text = buildCommandReport({ command: null, exit: 1, output: "```ts\nconst a = 1\n```" }, LABELS);
    expect(text).toContain("````\n```ts");
  });

  it("is empty when there is nothing to report", () => {
    expect(buildCommandReport({ command: "  ", exit: 0, output: "\n\n" }, LABELS)).toBe("");
  });
});

describe("tailLines", () => {
  it("keeps the end, where a failure is", () => {
    const text = Array.from({ length: 10 }, (_, at) => `line ${at}`).join("\n");
    expect(tailLines(text, 3)).toBe("line 7\nline 8\nline 9");
  });

  it("leaves a short output whole", () => {
    expect(tailLines("one\ntwo", 10)).toBe("one\ntwo");
  });
});
