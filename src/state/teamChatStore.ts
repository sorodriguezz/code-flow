import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { teamChatCancel, teamChatDelete, teamChatOpen, teamChatSend, teamChatState } from "../lib/tauri/teamCommands";
import type { ChatAttachment } from "../lib/tauri/chatCommands";
import { teamChatIdOf, type TeamChatState } from "../types/team";
import { useAgentsStore } from "./agentsStore";
import { useAiRunStore } from "./aiRunStore";
import { useChatStore } from "./chatStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { translate } from "./languageStore";
import { followTarget, notify } from "./notificationStore";
import { teamChatOnScreen, useTeamChatWindowStore } from "./teamChatWindowStore";
import { splitAttachmentNote } from "../lib/attachmentNote";

export const teamChatBusy = (state: TeamChatState | undefined) => state?.chat.status === "running" || state?.chat.status === "cancelling";

/** The chats whose turn was sent from this window: the one that says so when it ends, so a turn
 *  watched from two windows is announced once. */
const awaited = new Set<string>();

/** The chats this window is deleting: it tidies up after them itself, in its own order. */
const deleting = new Set<string>();

/** Drops what this window holds of a conversation that no longer exists: its state, and the tasks
 *  that stood for it among the agents' — the lead's and each member's. */
function forget(chatId: string): void {
  awaited.delete(chatId);
  const state = useTeamChatStore.getState().states[chatId];
  if (state?.chat.activeRunId) useAiRunStore.getState().settle(state.chat.activeRunId);
  useTeamChatStore.setState((s) => {
    if (!(chatId in s.states)) return s;
    const { [chatId]: _gone, ...states } = s.states;
    return { states };
  });
  useAgentsStore.setState((s) => {
    const gone = s.tasks.filter((task) => teamChatIdOf(task) === chatId).map((task) => task.id);
    if (gone.length === 0) return s;
    const live = { ...s.live };
    for (const id of gone) delete live[id];
    return { tasks: s.tasks.filter((task) => !gone.includes(task.id)), live, selectedId: s.selectedId && gone.includes(s.selectedId) ? null : s.selectedId };
  });
}

/** Unfolds the floating window of `chatId`, reading the conversation first when this window has
 *  not seen it — the window is the team's, and only the conversation says which team that is. */
export async function openTeamChatWindow(chatId: string): Promise<void> {
  if (!useTeamChatStore.getState().states[chatId]) await useTeamChatStore.getState().refresh(chatId);
  const state = useTeamChatStore.getState().states[chatId];
  if (state) useTeamChatWindowStore.getState().open(chatId, state.chat.teamId);
}

/**
 * A turn ended. Seen happening, that is all there is to say; otherwise its window's chip is
 * marked, the bell keeps a row and a toast says it where the user is now. Both lead to the
 * conversation's window, which floats over whatever view that is.
 */
function announce(state: TeamChatState): void {
  const { chat } = state;
  if (teamChatOnScreen(chat.id)) return;
  const failed = chat.status === "error" || Boolean(chat.error);
  useTeamChatWindowStore.getState().markUnread(chat.id, failed ? "error" : "done");
  const titleKey = failed ? "notifications.teamChatFailed" : "notifications.teamChatDone";
  const asked = [...state.messages].reverse().find((message) => message.role === "user");
  const detail = asked ? splitAttachmentNote(asked.content).text.trim().split("\n")[0].slice(0, 120) : undefined;
  notify({
    source: "agents",
    titleKey,
    params: { team: chat.teamName },
    workspaceId: chat.workspaceId,
    target: { select: { kind: "teamChat", id: chat.id } },
    status: failed ? "error" : "success",
    detail,
  });
  useToastStore.getState().pushToast(translate(titleKey, { team: chat.teamName }), failed ? "error" : "success", {
    action: {
      label: translate("notifications.openTeamChat"),
      run: () => void followTarget(chat.workspaceId, { select: { kind: "teamChat", id: chat.id } }),
    },
    lifetimeMs: 12_000,
  });
}

interface TeamChatStore {
  states: Record<string, TeamChatState>;
  accept: (state: TeamChatState) => void;
  open: (teamId: string, projectId: string | null, fresh?: boolean) => Promise<string>;
  refresh: (chatId: string) => Promise<void>;
  send: (chatId: string, text: string, files?: ChatAttachment[]) => boolean;
  cancel: (chatId: string) => Promise<void>;
  /** Deletes the conversation for good. Its window turns to `next` — another of the team's — or
   *  closes. Resolves to whether it was deleted: the team answering it is a refusal, said in a toast. */
  remove: (chatId: string, next?: string) => Promise<boolean>;
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
        target: { select: { kind: "teamChat", id: chat.id } },
      });
    }
    if (previous?.chat.activeRunId && previous.chat.activeRunId !== chat.activeRunId) useAiRunStore.getState().settle(previous.chat.activeRunId);
    if (awaited.has(chat.id) && previous && teamChatBusy(previous) && !teamChatBusy(state)) {
      awaited.delete(chat.id);
      // One the user stopped needs no telling.
      if (previous.chat.status !== "cancelling") announce(state);
    }
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
    awaited.add(chatId);
    void teamChatSend(chatId, text.trim(), files?.map((file) => file.id)).then((next) => get().accept(next)).catch((error: unknown) => {
      // Refused before it began: said right here, below, and not as a turn that ended.
      awaited.delete(chatId);
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
  remove: async (chatId, next) => {
    deleting.add(chatId);
    try {
      await teamChatDelete(chatId);
      // The next conversation is read before the window turns to it, so it never shows a blank.
      if (next && !get().states[next]) await get().refresh(next);
      useTeamChatWindowStore.getState().drop(chatId, next && get().states[next] ? next : undefined);
      forget(chatId);
      return true;
    } catch (error) {
      pushErrorToast(String(error));
      return false;
    } finally {
      deleting.delete(chatId);
    }
  },
}));

if (typeof window !== "undefined") {
  void listen<{ chatId: string }>("team-chat:changed", (event) => void useTeamChatStore.getState().refresh(event.payload.chatId));
  // Deleted from another window: this one lets go of it too.
  void listen<{ chatId: string }>("team-chat:deleted", (event) => {
    const { chatId } = event.payload;
    if (deleting.has(chatId)) return;
    useTeamChatWindowStore.getState().drop(chatId);
    forget(chatId);
  });
}
