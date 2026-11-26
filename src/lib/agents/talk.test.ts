import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask, WorkspaceAgent } from "../../types/domain";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  rename: vi.fn(async () => undefined),
  ensureLoaded: vi.fn(async () => undefined),
  setWorkspace: vi.fn(async () => undefined),
  error: vi.fn(),
  agents: { workspaceId: "ws" as string | null, tasks: [] as unknown[] },
  workspace: { activeProjectId: "repo" as string | null },
}));

vi.mock("../../state/agentsStore", () => ({
  useAgentsStore: { getState: () => ({ ...api.agents, create: api.create, rename: api.rename, ensureLoaded: api.ensureLoaded, setWorkspace: api.setWorkspace }) },
}));
vi.mock("../../state/languageStore", () => ({ useLanguageStore: { getState: () => ({ language: "es" }) } }));
vi.mock("../../state/teamCallStore", () => ({ useTeamCallStore: { getState: () => ({ start: vi.fn() }) } }));
vi.mock("../../state/teamChatStore", () => ({ useTeamChatStore: { getState: () => ({ open: vi.fn() }) } }));
vi.mock("../../state/toastStore", () => ({ pushErrorToast: api.error }));
vi.mock("../../state/uiStore", () => ({ useUiStore: { getState: () => ({ setActiveView: vi.fn() }) } }));
vi.mock("../../state/workspaceStore", () => ({ useWorkspaceStore: { getState: () => api.workspace } }));

const { agentChats, chatWithAgent, conversationName, isAgentChat } = await import("./talk");
const { useTeamChatWindowStore } = await import("../../state/teamChatWindowStore");

const task = (id: string, patch: Partial<AgentTask> = {}): AgentTask =>
  ({ id, workspace_id: "ws", project_id: "repo", agent_id: "dev", agent_name: "Dev", goal: "", title: "", batch_id: "", updated_at: "2026-11-20T10:00:00Z", turns: 0, ...patch }) as AgentTask;
const agent = { id: "dev", workspace_id: "ws", name: "Dev" } as WorkspaceAgent;
const windows = () => useTeamChatWindowStore.getState().windows.map((w) => `${w.kind}:${w.teamId}:${w.chatId}:${w.workspaceId}`);

beforeEach(() => {
  vi.clearAllMocks();
  api.agents = { workspaceId: "ws", tasks: [] };
  api.workspace = { activeProjectId: "repo" };
  useTeamChatWindowStore.setState({ windows: [] });
});

describe("conversations with one agent", () => {
  it("are the tasks started with nothing to do, on their own and not put away", () => {
    expect(isAgentChat(task("a"))).toBe(true);
    expect(isAgentChat(task("b", { goal: "Arregla el login" }))).toBe(false);
    // A team's turn, a race, a chain's step: somebody else's conversation.
    expect(isAgentChat(task("c", { batch_id: "team-chat:chat:lead" }))).toBe(false);
    expect(isAgentChat(task("d", { batch_id: "race:1" }))).toBe(false);
    expect(isAgentChat(task("e", { archived: true }))).toBe(false);
  });

  it("lists an agent's own, the one last written in first", () => {
    const tasks = [
      task("old", { updated_at: "2026-11-01T10:00:00Z" }),
      task("job", { goal: "Sube la cobertura", updated_at: "2026-11-25T10:00:00Z" }),
      task("new", { updated_at: "2026-11-24T10:00:00Z" }),
      task("other", { agent_id: "qa" }),
    ];
    expect(agentChats(tasks, "dev").map((t) => t.id)).toEqual(["new", "old"]);
    // An agent that was deleted leaves tasks with no agent: they are nobody's.
    expect(agentChats([task("orphan", { agent_id: "" })], "")).toEqual([]);
  });
});

describe("what a conversation with an agent is called", () => {
  it("goes by the day it started until it is given a name of its own", () => {
    const started = { agent_name: "Dev", created_at: "2026-11-24T15:30:00" };
    expect(conversationName({ ...started, title: "Conversación con Dev" }, "es")).toMatch(/^Conversación del 24 nov/);
    expect(conversationName({ ...started, title: "Chat with Dev" }, "en")).toMatch(/^Conversation of Nov 24/);
    expect(conversationName({ ...started, title: "" }, "es")).toMatch(/^Conversación del 24 nov/);
    expect(conversationName({ ...started, title: "Expiración del token" }, "es")).toBe("Expiración del token");
  });
});

describe("chatting with an agent", () => {
  it("goes back to the last conversation instead of starting an empty one each time", async () => {
    api.agents.tasks = [task("old", { updated_at: "2026-11-01T10:00:00Z" }), task("last", { updated_at: "2026-11-24T10:00:00Z" })];
    api.workspace.activeProjectId = null;
    await chatWithAgent(agent);
    expect(api.create).not.toHaveBeenCalled();
    // Needing no repository: the conversation already has its own.
    expect(api.error).not.toHaveBeenCalled();
    expect(windows()).toEqual(["agent:dev:last:ws"]);
    expect(api.ensureLoaded).toHaveBeenCalledWith("last");
  });

  it("starts one in the repository on screen when there is none, or when a new one is asked for", async () => {
    api.create.mockResolvedValue(task("made"));
    await chatWithAgent(agent);
    expect(api.create).toHaveBeenCalledWith({ projectId: "repo", agent, goal: "" });
    expect(api.rename).toHaveBeenCalledWith("made", "Conversación con Dev");
    expect(windows()).toEqual(["agent:dev:made:ws"]);

    api.agents.tasks = [task("made")];
    api.create.mockResolvedValue(task("second"));
    await chatWithAgent(agent, true);
    expect(windows()).toEqual(["agent:dev:second:ws"]);
  });

  it("asks for a repository before starting a new one", async () => {
    api.workspace.activeProjectId = null;
    await chatWithAgent(agent);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.error).toHaveBeenCalledWith("Abre un repositorio para conversar con el agente.");
    expect(windows()).toEqual([]);
  });

  it("reads the agent's workspace first when another one's tasks are on record", async () => {
    api.agents.workspaceId = "elsewhere";
    api.create.mockResolvedValue(task("made"));
    await chatWithAgent(agent);
    expect(api.setWorkspace).toHaveBeenCalledWith("ws");
  });
});
