import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../types/domain";

/**
 * Codi at work out of sight (user, 2026-10-22: «que Codi ocupe la app en segundo plano sin abrir
 * cosas»): the setting and the order decide whether a job's screen opens, a job that outlasts the turn
 * is told when it lands — with what is worth seeing offered — and the app's data is answered from the
 * data («¿cuántas conexiones tengo?» while Settings covered the database client).
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
const db = {
  connections: [
    { id: "a", name: "api-prod", kind: "postgres", spec: "{}", group_name: "" },
    { id: "b", name: "reportes", kind: "postgres", spec: "{}", group_name: "bi" },
    { id: "c", name: "cache", kind: "redis", spec: "{}", group_name: "" },
  ],
  connected: ["a"],
};
vi.mock("../../../state/dbStore", () => ({ ensureDbStoreLoaded: async () => {}, useDbStore: { getState: () => db } }));

const shared = await import("./shared");
const { CodiError } = await import("../registry");
const { dbActions } = await import("./data");
const { terminalActions, keepsRunning } = await import("./run");
const { useWorkspaceStore } = await import("../../../state/workspaceStore");

const repo = { id: "web", name: "web", workspace_id: "w", local_path: "/repos/web" } as Project;

function run(actions: ReturnType<typeof dbActions>, id: string, params: Record<string, unknown>) {
  const action = actions.find((a) => a.id === id)!;
  return action.run(params, { window: "main", request: { id: "t", window: "main", action: id, params } });
}

const told = () => calls.filter((c) => c.cmd === "codi_tell").map((c) => c.args);

beforeEach(() => {
  calls.length = 0;
  answer = () => null;
  useWorkspaceStore.setState({
    workspaces: [{ id: "w", name: "Web" }] as never,
    activeWorkspaceId: "w",
    activeProjectId: repo.id,
    projectsByWorkspace: { w: [repo] },
  });
});

describe("whether a job's screen opens", () => {
  it("is the order's to say, and the setting's when it says nothing — on unless turned off", async () => {
    expect(await shared.outOfSight(true)).toBe(false);
    expect(await shared.outOfSight(false)).toBe(true);
    expect(await shared.outOfSight(undefined)).toBe(true);
    answer = (cmd, args) => (cmd === "get_setting" && args.key === "codi_background" ? "off" : null);
    expect(await shared.outOfSight(undefined)).toBe(false);
    expect(await shared.outOfSight(false)).toBe(true);
  });
});

describe("work that outlasts its turn", () => {
  it("is answered at once when it is quick", async () => {
    const outcome = await shared.answerOrTell(Promise.resolve({ say: "hecho" }), { source: "x", still: { say: "sigo" }, failed: () => "falló", ms: 50 });
    expect(outcome.say).toBe("hecho");
    expect(told()).toEqual([]);
  });

  it("says it is still at it, then tells the result and asks its offer", async () => {
    let finish: (value: { say: string; offer: { action: string; params: Record<string, unknown>; question: string } }) => void = () => {};
    const work = new Promise<{ say: string; offer: { action: string; params: Record<string, unknown>; question: string } }>((resolve) => (finish = resolve));
    const outcome = await shared.answerOrTell(work, { source: "flow:f", still: { say: "sigo" }, failed: () => "falló", ms: 10 });
    expect(outcome.say).toBe("sigo");
    finish({ say: "terminó", offer: { action: "flow.open", params: { name: "f" }, question: "¿Lo abro?" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(told()).toEqual([{ text: "terminó", source: "flow:f", offer: { action: "flow.open", params: { name: "f" }, question: "¿Lo abro?" } }]);
  });

  it("tells a failure that is a question only as the question", async () => {
    const work = new Promise((_, reject) => setTimeout(() => reject(new CodiError("boom", "Falló. ¿Lo abro?", { action: "flow.open", params: {} })), 20));
    await shared.answerOrTell(work as never, { source: "flow:f", still: { say: "sigo" }, failed: () => "falló", ms: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(told()).toEqual([{ text: "Falló. ¿Lo abro?", source: "flow:f", offer: { action: "flow.open", params: {}, question: "Falló. ¿Lo abro?" } }]);
  });
});

describe("the app's data, from the data", () => {
  it("counts the database connections by engine and names the connected ones", async () => {
    const outcome = await run(dbActions(), "db.list", {});
    expect(outcome.result).toMatchObject({ total: 3 });
    const list = (outcome.result as { connections: Record<string, unknown>[] }).connections;
    expect(list.map((c) => c.name)).toEqual(["api-prod", "reportes", "cache"]);
    expect(list[0]).toMatchObject({ connected: true });
    expect(list[1]).toMatchObject({ group: "bi" });
    expect(outcome.say).toContain("codi.say.dbConnections");
    expect(outcome.say).toContain("codi.say.dbConnectedNow");
    expect(calls.some((c) => c.cmd === "set_active_view")).toBe(false);
  });
});

describe("a command out of sight", () => {
  it("runs without a terminal and says how it ended", async () => {
    answer = (cmd) => (cmd === "codi_run_command" ? { code: 0, output: "compiling…\n12 passed", timedOut: false, ms: 2300 } : null);
    const outcome = await run(terminalActions(), "terminal.run", { command: "npm test" });
    expect(calls.find((c) => c.cmd === "codi_run_command")?.args).toEqual({ cwd: "/repos/web", command: "npm test" });
    expect(outcome.say).toBe("codi.say.commandDone");
    expect(outcome.result).toMatchObject({ code: 0, ran: "npm test" });
  });

  it("offers a terminal when it fails, with what it last said", async () => {
    answer = (cmd) => (cmd === "codi_run_command" ? { code: 1, output: "1 failed", timedOut: false, ms: 900 } : null);
    const error = await run(terminalActions(), "terminal.run", { command: "npm test" }).catch((e) => e);
    expect(error).toBeInstanceOf(CodiError);
    expect(error.offer).toEqual({ action: "terminal.run", params: { command: "npm test", show: true } });
  });

  it("leaves what keeps running to a terminal", () => {
    for (const line of ["npm run dev", "pnpm dev", "yarn start", "cargo watch -x test", "tail -f app.log", "docker compose up", "npm test -- --watch"]) {
      expect(keepsRunning(line), line).toBe(true);
    }
    for (const line of ["npm test", "pnpm build", "cargo test", "docker compose up -d", "ls -la", "git status"]) {
      expect(keepsRunning(line), line).toBe(false);
    }
  });
});
