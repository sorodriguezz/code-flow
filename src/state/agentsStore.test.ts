import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../types/domain";

/**
 * `send` is the door every hand-typed turn goes through, and each of its refusals used to be
 * silent: a new task whose repository was busy sat there looking started, and a follow-up the
 * backend turned away vanished from the composer that had already been emptied.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));

const { useAgentsStore } = await import("./agentsStore");
const { useToastStore } = await import("./toastStore");
const { useWorkspaceStore } = await import("./workspaceStore");

function taskRow(id: string, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    workspace_id: "w1",
    project_id: "p1",
    conversation_id: `conv-${id}`,
    agent_id: "a1",
    agent_name: "Bot",
    provider: "claude",
    model: "sonnet",
    prompt: "",
    goal: "Arregla el login",
    title: "Arregla el login",
    status: "idle",
    turns: 0,
    last_error: "",
    ...patch,
  } as unknown as AgentTask;
}

const toasts = () => useToastStore.getState().toasts.map((toast) => toast.message);

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  handlers = {};
  useToastStore.setState({ toasts: [] });
  useWorkspaceStore.setState({
    projectsByWorkspace: { w1: [{ id: "p1", name: "api", local_path: "/tmp/api" }] },
  } as never);
  useAgentsStore.setState({ workspaceId: "w1", tasks: [], live: {}, bounced: {} });
});

describe("send", () => {
  it("refuses out loud, naming the repository, while another task runs there", () => {
    useAgentsStore.setState({
      tasks: [taskRow("busy"), taskRow("new")],
      live: {
        busy: { messages: [], sessionId: null, runId: "r1", runStartedAt: 1, sending: true, loaded: true },
      },
    });
    expect(useAgentsStore.getState().send("new", "Arregla el login")).toBe(false);
    expect(toasts().join(" ")).toContain("api");
  });

  it("says yes when it dispatched", () => {
    handlers.send_chat_message = () => new Promise(() => {});
    useAgentsStore.setState({ tasks: [taskRow("t1")] });
    expect(useAgentsStore.getState().send("t1", "hola")).toBe(true);
    expect(useAgentsStore.getState().live.t1?.sending).toBe(true);
  });

  it("refuses nothing it cannot send, without a word", () => {
    useAgentsStore.setState({ tasks: [taskRow("t1")] });
    expect(useAgentsStore.getState().send("t1", "   ")).toBe(false);
    expect(useAgentsStore.getState().send("missing", "hola")).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it("hands a follow-up the backend turned away back to the composer, once", async () => {
    handlers.send_chat_message = () => {
      throw "REPO_BUSY::api";
    };
    useAgentsStore.setState({
      tasks: [taskRow("t1", { turns: 1 })],
      live: {
        t1: {
          messages: [{ role: "user", content: "primero" }, { role: "assistant", content: "hecho" }],
          sessionId: null,
          runId: null,
          runStartedAt: null,
          sending: false,
          loaded: true,
        },
      },
    });
    expect(useAgentsStore.getState().send("t1", "y ahora los tests")).toBe(true);
    await flush();

    // The optimistic bubble is withdrawn, the reason is said, and the text is waiting.
    expect(useAgentsStore.getState().live.t1?.messages.map((m) => m.content)).toEqual(["primero", "hecho"]);
    expect(toasts().join(" ")).toContain("api");
    expect(useAgentsStore.getState().takeBounced("t1")).toBe("y ahora los tests");
    expect(useAgentsStore.getState().takeBounced("t1")).toBeNull();
  });

  it("leaves a refused first turn as a task with its goal and a Run button, not a draft", async () => {
    handlers.send_chat_message = () => {
      throw "REPO_BUSY::api";
    };
    useAgentsStore.setState({ tasks: [taskRow("t1")], live: { t1: { messages: [], sessionId: null, runId: null, runStartedAt: null, sending: false, loaded: true } } });
    expect(useAgentsStore.getState().send("t1", "Arregla el login")).toBe(true);
    await flush();
    expect(useAgentsStore.getState().live.t1?.messages).toEqual([]);
    expect(useAgentsStore.getState().tasks[0].turns).toBe(0);
    expect(useAgentsStore.getState().takeBounced("t1")).toBeNull();
  });
});
