import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChain, AgentChainStep, AgentTask } from "../types/domain";

/**
 * The chain driver's half of "a chain that cannot run waits instead of dying": what it does with a
 * turn that failed, bounced off a busy repository, or ran into the quota — and the automatic resume
 * a user can arm on a pause.
 *
 * The decisions are the backend's (`complete_chain_step` is scripted here to answer what it would);
 * what is tested is the scheduling around them: nothing is re-sent the instant it failed, a bounce
 * waits for the repository, a pause is announced and left alone.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];
const notified: { titleKey: string; status: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({
  notify: (input: { titleKey: string; status: string }) => notified.push(input),
}));

const { retryDelay, useChainStore } = await import("./chainStore");
const { notifyTurnSettled } = await import("./agentEvents");

/** The chain each test drives. One id per test: the driver keeps its waits in module state, and a
 * wait left over from the test before would otherwise hold this one. */
let current = "c1";

function chainRow(patch: Partial<AgentChain> = {}): AgentChain {
  return {
    id: current,
    project_id: "p1",
    title: "Plan",
    goal: "objetivo",
    agent_project_id: "",
    pinned: false,
    status: "queued",
    current_step: 0,
    step_count: 2,
    last_reason: "",
    dispatches: 0,
    resume_at: 0,
    created_at: "",
    updated_at: "",
    kind: "chain",
    work_item_provider: "",
    work_item_org: "",
    work_item_id: 0,
    work_item_key: "",
    work_item_url: "",
    work_item_title: "",
    repo_count: 1,
    ...patch,
  };
}

const task = {
  id: "t1",
  workspace_id: "w-other",
  project_id: "p1",
  conversation_id: "conv-1",
  agent_id: "a1",
  agent_name: "Bot",
  provider: "claude",
  model: "sonnet",
  prompt: "",
  goal: "g",
  title: "t",
  status: "idle",
  turns: 0,
  last_error: "",
} as unknown as AgentTask;

const stepOf = () => ({ id: `s-${current}`, chain_id: current, step_index: 0, project_id: "p1", attempts: 1 }) as unknown as AgentChainStep;

/** Every claim runs the step; every turn fails with whatever `failWith` holds. */
let failWith = "";
let settledAs: AgentChain = chainRow();

function claims(): number {
  return calls.filter((call) => call.name === "claim_next_chain_step").length;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let serial = 0;

beforeEach(() => {
  vi.useFakeTimers();
  current = `c${++serial}`;
  calls = [];
  notified.length = 0;
  handlers = {
    claim_next_chain_step: () => ({ chain: chainRow({ status: "running" }), kind: "run", task, step: stepOf(), message: "hola" }),
    send_chat_message: () => {
      throw failWith;
    },
    complete_chain_step: () => settledAs,
    list_gated_chains: () => [],
    list_scheduled_resumes: () => [],
  };
  useChainStore.setState({ chains: [chainRow()], workspaceId: "w1", background: false, stepsByChain: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retryDelay", () => {
  it("doubles per attempt spent and stops growing", () => {
    expect(retryDelay(1)).toBe(15_000);
    expect(retryDelay(2)).toBe(30_000);
    expect(retryDelay(3)).toBe(60_000);
    expect(retryDelay(9)).toBe(120_000);
    expect(retryDelay(0)).toBe(15_000);
  });
});

describe("settling a failed step", () => {
  it("parks on a quota error, says so once, and claims nothing more", async () => {
    failWith = "QUOTA_EXCEEDED::You've hit your session limit · resets 12am (America/Santiago)";
    settledAs = chainRow({ status: "paused", last_reason: "chain.pausedQuota" });

    await useChainStore.getState().pump(current);
    await flush();

    const completed = calls.find((call) => call.name === "complete_chain_step");
    expect(completed?.args).toMatchObject({ outcome: "error", reason: failWith });
    // The step's own "agent task failed" goes out as it always has; the plan says it is waiting.
    expect(notified.filter((n) => n.titleKey.startsWith("notifications.chain")).map((n) => n.titleKey)).toEqual([
      "notifications.chainPaused",
    ]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(claims()).toBe(1);
  });

  it("re-sends an overloaded turn only after its backoff", async () => {
    failWith = "API Error: 529 Overloaded";
    settledAs = chainRow({ status: "queued", last_reason: failWith });

    await useChainStore.getState().pump(current);
    await flush();
    expect(claims()).toBe(1);

    // Every other door into the scheduler respects the wait too.
    await useChainStore.getState().pump(current);
    expect(claims()).toBe(1);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(claims()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(claims()).toBe(2);
  });

  it("waits for a busy repository, and wakes when a turn there settles", async () => {
    failWith = "REPO_BUSY::api";
    settledAs = chainRow({ status: "queued", last_reason: "chain.repoBusy" });

    await useChainStore.getState().pump(current);
    await flush();
    const bounce = calls.find((call) => call.name === "complete_chain_step");
    expect(bounce?.args).toMatchObject({ outcome: "requeue", reason: "chain.repoBusy" });
    expect(claims()).toBe(1);

    // Not re-sent into the same wall straight away…
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claims()).toBe(1);

    // …but the moment whoever held the repository lets go, it goes.
    notifyTurnSettled("p1");
    await flush();
    expect(claims()).toBe(2);
  });

  it("asks again after the recheck when nothing announces the repository is free", async () => {
    failWith = "REPO_BUSY::api";
    settledAs = chainRow({ status: "queued", last_reason: "chain.repoBusy" });

    await useChainStore.getState().pump(current);
    await flush();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(claims()).toBe(2);
  });
});

describe("automatic resume", () => {
  it("is armed in seconds and fires only while the backend still lists it", async () => {
    let scheduled: { chain_id: string; resume_at: number }[] = [];
    handlers.set_chain_resume_at = (args) => {
      scheduled = [{ chain_id: String(args.chainId), resume_at: Number(args.resumeAt) }];
      return chainRow({ status: "paused", last_reason: "chain.pausedQuota", resume_at: Number(args.resumeAt) });
    };
    handlers.list_scheduled_resumes = () => scheduled;
    handlers.resume_chain = () => chainRow({ status: "queued" });
    handlers.claim_next_chain_step = () => ({ chain: chainRow({ status: "done" }), kind: "idle", task: null, step: null, message: "" });

    const at = Date.now() + 60_000;
    await useChainStore.getState().setAutoResume(current, at);
    const armed = calls.find((call) => call.name === "set_chain_resume_at");
    expect(armed?.args).toEqual({ chainId: current, resumeAt: Math.floor(at / 1000) });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.some((call) => call.name === "resume_chain")).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect(calls.some((call) => call.name === "resume_chain")).toBe(true);
  });

  it("does nothing when the consent was withdrawn before it fired", async () => {
    let scheduled: { chain_id: string; resume_at: number }[] = [];
    handlers.set_chain_resume_at = (args) => {
      scheduled = [{ chain_id: String(args.chainId), resume_at: Number(args.resumeAt) }];
      return chainRow({ status: "paused", last_reason: "chain.pausedQuota", resume_at: Number(args.resumeAt) });
    };
    handlers.list_scheduled_resumes = () => scheduled;
    handlers.resume_chain = () => chainRow({ status: "queued" });

    await useChainStore.getState().setAutoResume(current, Date.now() + 60_000);
    // The chain moved (resumed by hand elsewhere, say) — the backend no longer lists it.
    scheduled = [];
    await vi.advanceTimersByTimeAsync(61_000);
    await flush();
    expect(calls.some((call) => call.name === "resume_chain")).toBe(false);
  });
});
