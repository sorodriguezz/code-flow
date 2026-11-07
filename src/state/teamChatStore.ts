import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { teamChatCancel, teamChatOpen, teamChatSend, teamChatState } from "../lib/tauri/teamCommands";
import type { ChatAttachment } from "../lib/tauri/chatCommands";
import type { TeamChatState } from "../types/team";
import { useAgentsStore } from "./agentsStore";
import { useAiRunStore } from "./aiRunStore";
import { useChatStore } from "./chatStore";
import { pushErrorToast } from "./toastStore";
import { translate } from "./languageStore";

export const teamChatBusy = (state: TeamChatState | undefined) => state?.chat.status === "running" || state?.chat.status === "cancelling";

interface TeamChatStore {
  states: Record<string, TeamChatState>;
  accept: (state: TeamChatState) => void;
  open: (teamId: string, projectId: string, fresh?: boolean) => Promise<string>;
  refresh: (chatId: string) => Promise<void>;
  send: (chatId: string, text: string, files?: ChatAttachment[]) => boolean;
  cancel: (chatId: string) => Promise<void>;
}

export const useTeamChatStore = create<TeamChatStore>((set, get) => ({
  states: {},
  accept: (state) => {
    const { chat, task } = state;
    const previous = get().states[chat.id];
    if (previous && previous.chat.revision > chat.revision) return;
    set((s) => ({ states: { ...s.states, [chat.id]: state } }));
    // A team chat occupies the repository for the whole exchange, including handoffs between
    // members. Keep the ordinary task guards and the dock informed in every window.
    const agents = useAgentsStore.getState();
    const inWorkspace = agents.workspaceId === chat.workspaceId;
    if (inWorkspace || agents.live[task.id]) {
      if (inWorkspace && !agents.tasks.some((t) => t.id === task.id)) agents.adopt(task);
      useAgentsStore.setState((s) => {
        const old = s.live[task.id];
        return {
          tasks: s.tasks.map((t) => t.id === task.id ? { ...task, status: teamChatBusy(state) ? "running" : task.status } : t),
          live: { ...s.live, [task.id]: {
            messages: old?.messages ?? [], sessionId: old?.sessionId ?? null, loaded: old?.loaded ?? false,
            sending: teamChatBusy(state), runId: chat.activeRunId || null,
            runStartedAt: chat.activeRunId === previous?.chat.activeRunId ? old?.runStartedAt ?? Date.now() : Date.now(),
          } },
        };
      });
    }
    if (chat.activeRunId && !useAiRunStore.getState().active[chat.activeRunId]) {
      useAiRunStore.getState().adopt(chat.activeRunId, {
        kindKey: "agents.liveKindAgent", workspaceId: chat.workspaceId,
        detail: `${chat.teamName} · ${chat.members.find((m) => m.id === chat.activeMemberId)?.name ?? ""}`,
        target: { view: "agents", projectId: chat.projectId, select: { kind: "agentTask", id: task.id } },
      });
    }
    if (previous?.chat.activeRunId && previous.chat.activeRunId !== chat.activeRunId) useAiRunStore.getState().settle(previous.chat.activeRunId);
  },
  open: async (teamId, projectId, fresh) => {
    const state = await teamChatOpen(teamId, projectId, fresh);
    get().accept(state);
    return state.chat.id;
  },
  refresh: async (chatId) => {
    try { get().accept(await teamChatState(chatId)); }
    catch (error) { pushErrorToast(String(error)); }
  },
  send: (chatId, text, files) => {
    const state = get().states[chatId];
    if (!state || !text.trim() || teamChatBusy(state)) return false;
    if (useAgentsStore.getState().runningInProject(state.chat.projectId, state.task.id)) {
      pushErrorToast(translate("agents.busyInRepo", { name: state.chat.projectName }));
      return false;
    }
    get().accept({ ...state, chat: { ...state.chat, status: "running", error: "" } });
    void teamChatSend(chatId, text.trim(), files?.map((file) => file.id)).then((next) => get().accept(next)).catch((error: unknown) => {
      get().accept({ ...state, chat: { ...state.chat, status: "error", error: String(error) } });
      useAgentsStore.setState((s) => ({ bounced: { ...s.bounced, [state.task.id]: text } }));
      if (files?.length) useChatStore.setState((s) => ({ attachments: { ...s.attachments, [state.task.conversation_id]: [...(s.attachments[state.task.conversation_id] ?? []), ...files] } }));
      pushErrorToast(String(error));
    });
    return true;
  },
  cancel: async (chatId) => {
    const state = get().states[chatId];
    if (state) get().accept({ ...state, chat: { ...state.chat, status: "cancelling" } });
    await teamChatCancel(chatId).catch((error: unknown) => pushErrorToast(String(error)));
    await get().refresh(chatId);
  },
}));

if (typeof window !== "undefined") {
  void listen<{ chatId: string }>("team-chat:changed", (event) => void useTeamChatStore.getState().refresh(event.payload.chatId));
}
