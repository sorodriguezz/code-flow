import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo, Project } from "../../../types/domain";

/**
 * Git by voice on a repository named rather than on screen — «haz un pool del repositorio node.core»
 * (user report, 2026-10-22): worked on where it lies, asked about when it is in another workspace,
 * and handed to the screen for what only the screen can answer.
 */

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let answer: (cmd: string, args: Record<string, unknown>) => unknown = () => null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    return answer(cmd, args);
  },
  transformCallback: () => 0,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("../../../state/languageStore", () => {
  const state = { language: "es" };
  const store = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => state,
    setState: () => {},
    subscribe: () => () => {},
  });
  return { useLanguageStore: store, useT: () => (key: string) => key, translate: (key: string) => key, languageFromLocale: () => "es" };
});

const { gitActions } = await import("./git");
const { CodiError } = await import("../registry");
const { useWorkspaceStore } = await import("../../../state/workspaceStore");

const project = (id: string, name: string, workspace: string): Project => ({ id, name, workspace_id: workspace, local_path: `/repos/${name}` }) as Project;
const branch = (over: Partial<BranchInfo>): BranchInfo =>
  ({ name: "main", is_head: true, is_remote: false, upstream: "origin/main", ahead: 0, behind: 0, target: "aaa", tip_time: 0, is_locked: false, locked_by_rule: false, ...over }) as BranchInfo;

const open = project("web", "FichaClinica.Transporte.React.Web", "ficha");
const core = project("core", "FichaClinica.Transporte.Node.Core", "ficha");
const billing = project("billing", "facturacion", "clientes");

function run(id: string, params: Record<string, unknown>) {
  const action = gitActions().find((a) => a.id === id)!;
  return action.run(params, { window: "main", request: { id: "t", window: "main", action: id, params } });
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodiError) return error;
    throw error;
  }
  throw new Error("it did not fail");
}

beforeEach(() => {
  calls.length = 0;
  useWorkspaceStore.setState({
    workspaces: [
      { id: "ficha", name: "Ficha" },
      { id: "clientes", name: "Clientes" },
    ] as never,
    activeWorkspaceId: "ficha",
    activeProjectId: open.id,
    projectsByWorkspace: { ficha: [open, core], clientes: [billing] },
  });
});

describe("git on a repository named by voice", () => {
  it("pulls it where it lies, without switching the screen to it", async () => {
    let pulled = false;
    answer = (cmd) => {
      if (cmd === "list_branches") return [branch({ target: pulled ? "bbb" : "aaa" })];
      if (cmd === "git_pull") pulled = true;
      return null;
    };
    const outcome = await run("git.pull", { repo: "node.core" });
    expect(calls.find((c) => c.cmd === "git_pull")?.args).toEqual({ repoPath: core.local_path });
    expect(outcome.say).toBe("codi.say.pulledRepo");
    expect(outcome.result).toMatchObject({ repo: core.name, pulled: true });
    expect(useWorkspaceStore.getState().activeProjectId).toBe(open.id);
  });

  it("says when there was nothing new", async () => {
    answer = (cmd) => (cmd === "list_branches" ? [branch({})] : null);
    expect((await run("git.pull", { repo: "node core" })).say).toBe("codi.say.upToDate");
  });

  it("asks before working on one that is only in another workspace, and a yes names where", async () => {
    answer = () => null;
    const error = await failure(run("git.pull", { repo: "facturacion" }));
    expect(error.say).toBe("codi.say.gitElsewhere");
    expect(error.offer).toEqual({ action: "git.pull", params: { repo: "facturacion", workspace: "Clientes" } });
    expect(calls.some((c) => c.cmd === "git_pull")).toBe(false);
  });

  it("hands a diverged pull to the screen, where merge or rebase is chosen", async () => {
    answer = (cmd) => {
      if (cmd === "list_branches") return [branch({})];
      if (cmd === "git_pull") throw "PULL_DIVERGED: main";
      return null;
    };
    const error = await failure(run("git.pull", { repo: "node.core" }));
    expect(error.say).toBe("codi.say.pullDiverged");
    expect(error.offer).toEqual({ action: "repo.switch", params: { name: core.name, workspace: "Ficha" } });
  });

  it("pushes what is ahead, and says when nothing is", async () => {
    answer = (cmd) => (cmd === "list_branches" ? [branch({ ahead: 2 })] : null);
    expect((await run("git.push", { repo: "node.core" })).say).toBe("codi.say.pushedRepo");
    expect(calls.find((c) => c.cmd === "git_push")?.args).toMatchObject({ repoPath: core.local_path, setUpstream: false });
    answer = (cmd) => (cmd === "list_branches" ? [branch({ ahead: 0 })] : null);
    expect((await run("git.push", { repo: "node.core" })).say).toBe("codi.say.nothingToPushIn");
  });

  it("commits only on screen: another repository is offered to be opened", async () => {
    answer = () => null;
    const error = await failure(run("git.commit", { message: "fix", repo: "node.core" }));
    expect(error.say).toBe("codi.say.commitOpenFirst");
    expect(error.offer).toEqual({ action: "repo.switch", params: { name: core.name, workspace: "Ficha" } });
    expect(calls.some((c) => c.cmd.startsWith("git_") || c.cmd === "stage_all")).toBe(false);
  });
});
