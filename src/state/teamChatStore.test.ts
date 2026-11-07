import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../types/domain";
import { defaultPolicy, emptyMember, type TeamChatState } from "../types/team";
import type { ChatAttachment } from "../lib/tauri/chatCommands";

const api = vi.hoisted(() => ({ open: vi.fn(), state: vi.fn(), send: vi.fn(), cancel: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));
vi.mock("../lib/tauri/teamCommands", async (original) => ({
  ...await original<typeof import("../lib/tauri/teamCommands")>(),
  teamChatOpen: api.open, teamChatState: api.state, teamChatSend: api.send, teamChatCancel: api.cancel,
}));

const { useTeamChatStore } = await import("./teamChatStore");
const { useAgentsStore } = await import("./agentsStore");
const { useChatStore } = await import("./chatStore");
const { useAiRunStore } = await import("./aiRunStore");

function state(revision = 1, status: TeamChatState["chat"]["status"] = "idle"): TeamChatState {
  return {
    chat: {
      id: "chat", workspaceId: "ws", projectId: "repo", projectName: "API", teamId: "team", teamName: "Squad", teamUpdatedAt: "", leadId: "lead", taskId: "task",
      members: [{ ...emptyMember(), id: "lead", name: "Lead", agent_id: "agent", provider: "claude", model: "sonnet", effort: "", prompt: "" }], policy: defaultPolicy(),
      status, activeMemberId: status === "running" ? "lead" : "", activeRunId: status === "running" ? "run" : "", error: "", revision, createdAt: "2026-11-06T00:00:00Z",
    },
    task: { id: "task", workspace_id: "ws", project_id: "repo", agent_id: "agent", agent_name: "Lead", provider: "claude", model: "sonnet", conversation_id: "conversation", worktree_path: "", status: "idle", batch_id: "team-chat:chat:lead" } as AgentTask,
    messages: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTeamChatStore.setState({ states: {} });
  useAgentsStore.setState({ workspaceId: "ws", tasks: [], live: {}, bounced: {} });
  useChatStore.setState({ attachments: {} });
  useAiRunStore.setState({ active: {}, linesByRun: {}, aboutByRun: {} });
});

describe("team chat", () => {
  it("opens a persistent chat and adopts its leader's conversation for the composer", async () => {
    api.open.mockResolvedValue(state());
    expect(await useTeamChatStore.getState().open("team", "repo", true)).toBe("chat");
    expect(api.open).toHaveBeenCalledWith("team", "repo", true);
    expect(useAgentsStore.getState().tasks[0].conversation_id).toBe("conversation");
  });

  it("sends to the team coordinator and blocks a second submission while it is working", async () => {
    useTeamChatStore.getState().accept(state());
    api.send.mockResolvedValue(state(2, "running"));
    expect(useTeamChatStore.getState().send("chat", "Implementa el endpoint")).toBe(true);
    expect(useTeamChatStore.getState().send("chat", "otra vez")).toBe(false);
    await Promise.resolve();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledWith("chat", "Implementa el endpoint", undefined);
    expect(useAgentsStore.getState().live.task.sending).toBe(true);
  });

  it("does not let a delayed response overwrite newer progress", () => {
    useTeamChatStore.getState().accept(state(5, "running"));
    useTeamChatStore.getState().accept(state(3, "idle"));
    expect(useTeamChatStore.getState().states.chat.chat.revision).toBe(5);
    expect(useAgentsStore.getState().live.task.sending).toBe(true);
  });

  it("settles a background chat after a workspace switch without adding its task to the new workspace", () => {
    useTeamChatStore.getState().accept(state(2, "running"));
    useAgentsStore.setState({ workspaceId: "another-workspace", tasks: [] });
    useTeamChatStore.getState().accept(state(3, "idle"));
    expect(useAgentsStore.getState().live.task.sending).toBe(false);
    expect(useAgentsStore.getState().tasks).toEqual([]);
  });

  it("returns both the message and its attachments if the backend refuses the send", async () => {
    useTeamChatStore.getState().accept(state());
    const files = [{ id: "image", path: "/tmp/image.png", name: "image.png", isImage: true, bytes: 10 }] as ChatAttachment[];
    api.send.mockRejectedValue("repository is busy");
    expect(useTeamChatStore.getState().send("chat", "Revisa esto", files)).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(useAgentsStore.getState().bounced.task).toBe("Revisa esto");
    expect(useChatStore.getState().attachments.conversation).toEqual(files);
    expect(useTeamChatStore.getState().states.chat.chat.status).toBe("error");
  });

  it("waits when another task already occupies the repository", () => {
    const current = state();
    useTeamChatStore.getState().accept(current);
    useAgentsStore.setState((s) => ({ tasks: [...s.tasks, { ...current.task, id: "other" }], live: { ...s.live, other: { ...s.live.task, sending: true } } }));
    expect(useTeamChatStore.getState().send("chat", "Haz cambios")).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("cancels the whole exchange and releases its repository after the backend settles", async () => {
    useTeamChatStore.getState().accept(state(2, "running"));
    api.cancel.mockResolvedValue(undefined);
    api.state.mockResolvedValue(state(4, "idle"));
    const stopped = useTeamChatStore.getState().cancel("chat");
    expect(useTeamChatStore.getState().states.chat.chat.status).toBe("cancelling");
    await stopped;
    expect(api.cancel).toHaveBeenCalledWith("chat");
    expect(useAgentsStore.getState().live.task.sending).toBe(false);
  });
});
