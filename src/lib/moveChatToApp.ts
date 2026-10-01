import { chatMoveFromPanel } from "./tauri/chatCommands";
import { notifyStateChange } from "./tauri/commands";
import { modelRouteLabel } from "../components/ai/ModelTag";
import { useAiPanelStore, chatTabKey } from "../state/aiPanelStore";
import { useChatHistoryStore } from "../state/activityStore";
import { engineFor, useChatStore } from "../state/chatStore";
import { chatQueueKey, queuedMessages } from "../state/chatQueueStore";
import { useConfirmStore } from "../state/confirmStore";
import { translate } from "../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../state/toastStore";
import { useUiStore } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";

/** Whether a repository conversation can move right now: not while a turn runs or messages wait in
 *  its queue — they belong to the session it is in. The backend refuses a running turn too, from
 *  any device, because the move takes the conversation's lease. */
export function canMoveChatToApp(conversationId: string): boolean {
  const session = useChatStore.getState().byConversation[conversationId];
  return !session?.sending && queuedMessages(chatQueueKey("panel", conversationId)).length === 0;
}

/**
 * Moves a repository conversation into the chat workspace, for good, after asking — see
 * `chat_move_from_panel`. The question says what happens: everything goes, it keeps working on the
 * repository on the same engine session, and it leaves the assistant (and the phone, which only
 * lists repository chats).
 *
 * Afterwards it is opened where it now lives, with a toast saying it moved, and its transcript
 * marks the spot. Every other window and paired phone hears it (`state:invalidate`): their history
 * drops the row, and a tab still showing it closes — `PanelChat` closes a tab whose conversation
 * is gone.
 */
export async function moveChatToApp(projectId: string, conversationId: string): Promise<boolean> {
  if (!canMoveChatToApp(conversationId)) {
    pushErrorToast(translate("assistant.moveBusy"));
    return false;
  }
  const chat = useChatStore.getState();
  const session = chat.byConversation[conversationId];
  const picked = chat.engineByConversation[conversationId];
  const row = useChatHistoryStore
    .getState()
    .byProject[projectId]?.find((conversation) => conversation.session_id === conversationId);
  const title = row?.title || session?.title || translate("assistant.newChat");
  const repo = useWorkspaceStore.getState().projectsByWorkspace;
  const repoName =
    Object.values(repo)
      .flat()
      .find((project) => project.id === projectId)?.name ?? "";
  const engine = engineFor(session, picked);

  // One paragraph rather than the dialog's `items`, which is a list of file names: monospaced, one
  // line each, cut short.
  const ok = await useConfirmStore.getState().ask({
    message: [
      translate("assistant.moveConfirm", { title }),
      engine
        ? translate("assistant.moveCarriesEngine", { engine: modelRouteLabel(engine.provider, engine.model, translate) })
        : translate("assistant.moveCarries"),
      translate("assistant.moveKeepsRepo", { repo: repoName }),
      translate("assistant.moveLeaves"),
    ].join(" "),
    danger: false,
    confirmLabel: translate("assistant.moveConfirmButton"),
  });
  if (!ok) return false;

  let moved;
  try {
    moved = await chatMoveFromPanel(
      projectId,
      conversationId,
      picked ? { provider: picked.provider, model: picked.model, account: picked.account ?? null } : null,
    );
  } catch (error) {
    pushErrorToast(String(error));
    return false;
  }

  // Gone from the assistant here, all of it: its tab, the unsent draft and unread mark the tab keeps
  // past closing, this window's copy, its staged images and engine pick, and its row.
  const workspaceId = useWorkspaceStore.getState().workspaceOfProject(projectId) ?? undefined;
  const tabKey = chatTabKey(conversationId);
  useAiPanelStore.getState().setDraft(tabKey, "");
  useAiPanelStore.getState().markSeen(tabKey);
  useAiPanelStore.getState().close(tabKey, workspaceId);
  useChatStore.getState().discard(conversationId);
  void useChatHistoryStore.getState().load(projectId);
  notifyStateChange("chat", projectId, conversationId);

  // And open where it lives now.
  const { useConversationStore } = await import("../state/conversationStore");
  useUiStore.getState().setActiveView("chat");
  await useConversationStore.getState().loadConversations(true);
  await useConversationStore.getState().open(moved.id);
  pushSuccessToast(translate("assistant.movedToast", { title: moved.title || title }));
  return true;
}
