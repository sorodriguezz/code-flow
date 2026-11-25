import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../types/domain";
import { defaultPolicy, emptyMember, type TeamChatState } from "../types/team";
import type { ChatAttachment } from "../lib/tauri/chatCommands";

const api = vi.hoisted(() => ({ open: vi.fn(), state: vi.fn(), send: vi.fn(), cancel: vi.fn(), remove: vi.fn(), notify: vi.fn(), follow: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: api.notify, followTarget: api.follow }));
vi.mock("../lib/tauri/teamCommands", async (original) => ({
  ...await original<typeof import("../lib/tauri/teamCommands")>(),
  teamChatOpen: api.open, teamChatState: api.state, teamChatSend: api.send, teamChatCancel: api.cancel, teamChatDelete: api.remove,
}));

const { useTeamChatStore } = await import("./teamChatStore");
const { useAgentsStore } = await import("./agentsStore");
const { useChatStore } = await import("./chatStore");
const { useAiRunStore } = await import("./aiRunStore");
const { useToastStore } = await import("./toastStore");
const { showingTeamChat, useTeamChatWindowStore } = await import("./teamChatWindowStore");

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
  useToastStore.setState({ toasts: [] });
  useTeamChatWindowStore.setState({ windows: [] });
});

/** A turn sent from here and still running. */
async function sent(): Promise<void> {
  useTeamChatStore.getState().accept(state());
  api.send.mockResolvedValue(state(2, "running"));
  useTeamChatStore.getState().send("chat", "Revisa el esquema");
  await Promise.resolve();
}

function answered(revision: number): TeamChatState {
  const done = state(revision);
  done.messages = [
    { id: "u", role: "user", memberId: "", memberName: "", content: "Revisa el esquema\ny dime qué falta\n\nArchivos adjuntos a este mensaje (léelos con tu herramienta de lectura de archivos):\n- a.png (/tmp/a.png)", provider: "", model: "", traceId: null, responseTimeMs: 0, createdAt: "2026-11-06" },
    { id: "a", role: "assistant", memberId: "lead", memberName: "Lead", content: "Listo", provider: "claude", model: "sonnet", traceId: null, responseTimeMs: 1, createdAt: "2026-11-06" },
  ];
  return done;
}

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

  it("says so in the bell, in a toast and on the folded window when a turn ends out of sight", async () => {
    useTeamChatWindowStore.getState().open("chat", "team");
    useTeamChatWindowStore.getState().minimize(useTeamChatWindowStore.getState().windows[0].key);
    await sent();
    useTeamChatStore.getState().accept(answered(3));

    expect(api.notify).toHaveBeenCalledTimes(1);
    expect(api.notify).toHaveBeenCalledWith(expect.objectContaining({
      source: "agents", titleKey: "notifications.teamChatDone", params: { team: "Squad" }, workspaceId: "ws", status: "success",
      // What was asked, without the files it came with.
      detail: "Revisa el esquema",
      target: { view: "agents", projectId: "repo", select: { kind: "agentTask", id: "task" } },
    }));
    expect(useTeamChatWindowStore.getState().windows[0].unread).toBe("done");
    const [toast] = useToastStore.getState().toasts;
    expect(toast.type).toBe("success");
    toast.action?.run();
    expect(api.follow).toHaveBeenCalledWith("ws", { view: "agents", projectId: "repo", select: { kind: "agentTask", id: "task" } });

    // Once: what arrives later about the same finished turn says nothing more.
    useTeamChatStore.getState().accept(answered(4));
    expect(api.notify).toHaveBeenCalledTimes(1);
  });

  it("marks a turn that ended badly as one", async () => {
    await sent();
    const failed = answered(3);
    failed.chat.status = "error";
    failed.chat.error = "El proveedor no respondió.";
    useTeamChatStore.getState().accept(failed);
    expect(api.notify).toHaveBeenCalledWith(expect.objectContaining({ titleKey: "notifications.teamChatFailed", status: "error" }));
    expect(useToastStore.getState().toasts[0].type).toBe("error");
  });

  it("says nothing about a turn that is being watched, was stopped, or was sent from another window", async () => {
    // Watched: the conversation is drawn and the app is in front.
    Object.assign(globalThis, { document: { hidden: false } });
    const leave = showingTeamChat("chat", { isConnected: true, getClientRects: () => [{}] } as unknown as HTMLElement);
    try {
      await sent();
      useTeamChatStore.getState().accept(answered(3));
    } finally {
      leave();
      delete (globalThis as { document?: unknown }).document;
    }

    // Stopped by the user.
    await sent();
    useTeamChatStore.getState().accept(state(5, "cancelling"));
    useTeamChatStore.getState().accept(answered(6));

    // Running, but not sent from here: the window that sent it is the one that tells.
    useTeamChatStore.setState({ states: {} });
    useTeamChatStore.getState().accept(state(7, "running"));
    useTeamChatStore.getState().accept(answered(8));

    expect(api.notify).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
  it("deletes a conversation, lets go of its tasks and turns its window to the next one", async () => {
    const other = state();
    other.chat.id = "older";
    other.task = { ...other.task, id: "older-task", batch_id: "team-chat:older:lead" };
    useTeamChatStore.getState().accept(state());
    // A member that answered in it has a task of its own.
    useAgentsStore.setState((s) => ({ tasks: [...s.tasks, { ...state().task, id: "member-task", batch_id: "team-chat:chat:backend" }], selectedId: "member-task" }));
    useTeamChatWindowStore.getState().open("chat", "team");
    api.remove.mockResolvedValue(undefined);
    api.state.mockResolvedValue(other);

    expect(await useTeamChatStore.getState().remove("chat", "older")).toBe(true);
    expect(api.remove).toHaveBeenCalledWith("chat");
    expect(useTeamChatStore.getState().states.chat).toBeUndefined();
    expect(useAgentsStore.getState().tasks.map((task) => task.id)).toEqual(["older-task"]);
    expect(useAgentsStore.getState().selectedId).toBeNull();
    expect(useTeamChatWindowStore.getState().windows).toMatchObject([{ chatId: "older", teamId: "team", minimized: false }]);

    // The last one: its window closes.
    expect(await useTeamChatStore.getState().remove("older")).toBe(true);
    expect(useTeamChatWindowStore.getState().windows).toEqual([]);
    expect(useAgentsStore.getState().tasks).toEqual([]);
  });

  it("keeps a conversation the team is answering, and says why", async () => {
    useTeamChatStore.getState().accept(state());
    useTeamChatWindowStore.getState().open("chat", "team");
    api.remove.mockRejectedValue("Detén la respuesta del equipo antes de eliminar la conversación.");
    expect(await useTeamChatStore.getState().remove("chat")).toBe(false);
    expect(useTeamChatStore.getState().states.chat).toBeDefined();
    expect(useTeamChatWindowStore.getState().windows).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]).toMatchObject({ type: "error" });
  });
});
