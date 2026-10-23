import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../types/domain";

/**
 * Questions answered from what the app knows (user, 2026-10-22: «que la busque súper rápido y sin
 * gastar tantos tokens»): the index first, the deep research only when it has nothing and the user
 * says yes.
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

const { researchActions } = await import("./research");
const { CodiError } = await import("../registry");
const { useWorkspaceStore } = await import("../../../state/workspaceStore");

const noah = { id: "noah", name: "noah-cli", workspace_id: "flow", local_path: "/repos/noah-cli" } as Project;

function run(id: string, params: Record<string, unknown>) {
  const action = researchActions().find((a) => a.id === id)!;
  return action.run(params, { window: "main", request: { id: "t", window: "main", action: id, params } });
}

beforeEach(() => {
  calls.length = 0;
  useWorkspaceStore.setState({
    workspaces: [{ id: "flow", name: "Flow" }] as never,
    activeWorkspaceId: "flow",
    activeProjectId: noah.id,
    projectsByWorkspace: { flow: [noah] },
  });
});

describe("a question about a repository", () => {
  it("is answered from the index first, with the deep research kept as the fallback", async () => {
    answer = (cmd) => (cmd === "codi_know" ? { found: 5, partial: [], ms: 40 } : null);
    const outcome = await run("repo.ask", { question: "explícame el proyecto noah cli", repo: "noah cli" });
    const know = calls.find((c) => c.cmd === "codi_know")!;
    expect(know.args).toMatchObject({ path: noah.local_path, workspaceId: "flow", subject: "noah-cli", question: "explícame el proyecto noah cli" });
    expect(know.args.deep).toEqual({ action: "repo.ask", params: { question: "explícame el proyecto noah cli", repo: "noah-cli", workspace: "Flow", deep: true } });
    expect(calls.some((c) => c.cmd === "codi_research")).toBe(false);
    expect(outcome.say).toBe("codi.say.looking");
  });

  it("offers the deep research when the index has nothing on it", async () => {
    answer = (cmd) => (cmd === "codi_know" ? { found: 0, partial: [], ms: 30 } : null);
    try {
      await run("repo.ask", { question: "¿qué base de datos usa?" });
      throw new Error("it did not fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CodiError);
      expect((error as InstanceType<typeof CodiError>).say).toBe("codi.say.notIndexedOffer");
      expect((error as InstanceType<typeof CodiError>).offer).toMatchObject({ action: "repo.ask", params: { deep: true, repo: "noah-cli" } });
    }
  });

  it("researches in depth only when asked to", async () => {
    answer = () => null;
    await run("repo.ask", { question: "¿cómo funciona el login?", deep: true });
    expect(calls.map((c) => c.cmd)).toContain("codi_research");
    expect(calls.map((c) => c.cmd)).not.toContain("codi_know");
  });
});

describe("a question about a reference repository", () => {
  it("is answered from the workspace's knowledge, which searches it", async () => {
    answer = (cmd) => {
      if (cmd === "reference_repos_for_workspace") return [{ id: "r1", name: "Template.Node.Nest", enabled: true }];
      if (cmd === "codi_know") return { found: 4, partial: [], ms: 30 };
      return null;
    };
    const outcome = await run("repo.ask", { question: "explícame template node nest", repo: "template node nest" });
    expect(calls.find((c) => c.cmd === "codi_know")?.args).toMatchObject({ path: null, workspaceId: "flow", subject: "Template.Node.Nest", deep: null });
    expect(calls.some((c) => c.cmd === "codi_research")).toBe(false);
    expect(outcome.say).toBe("codi.say.looking");
  });

  it("gives way to a repository of the workspace with the same name", async () => {
    answer = (cmd) => (cmd === "reference_repos_for_workspace" ? [{ id: "r1", name: "noah-cli", enabled: true }] : cmd === "codi_know" ? { found: 2, partial: [], ms: 10 } : null);
    await run("repo.ask", { question: "¿qué hace noah?", repo: "noah-cli" });
    expect(calls.find((c) => c.cmd === "codi_know")?.args).toMatchObject({ path: noah.local_path });
  });
});

describe("a question about a workspace", () => {
  it("searches the workspace on screen, with no deep research to offer", async () => {
    answer = (cmd) => (cmd === "codi_know" ? { found: 3, partial: [], ms: 25 } : null);
    await run("knowledge.ask", { question: "¿qué decidimos sobre el login?" });
    expect(calls.find((c) => c.cmd === "codi_know")?.args).toMatchObject({ path: null, workspaceId: "flow", subject: "Flow", deep: null });
  });
});
