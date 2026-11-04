import { chatDelegateAccept, chatDelegateSettle, onChatDelegate, type ChatDelegateRequest } from "./tauri/chatRefsCommands";
import { parseChatIslandRef } from "./chatIslandSync";
import { WINDOW } from "./windowIdentity";
import { useChatStore } from "../state/chatStore";
import { useWorkspaceChatStore } from "../state/workspaceChatStore";
import { useWindowStore } from "../state/windowStore";
import { useToastStore } from "../state/toastStore";
import { translate } from "../state/languageStore";

/**
 * One chat asked another to continue (`chat_refs::delegate`): the window that holds the target
 * conversation sends the message as an ordinary turn of it — on screen, stoppable, filed like any
 * other — and hands the answer back. A chat island holds its own conversation; the main window holds
 * every other one.
 */

/** Whether this window is the one that holds `conversationId`. Pure over its inputs. */
export function holdsConversation(
  window: { main: boolean; satellite: { kind: string; refId: string } | null },
  satellites: readonly { kind: string; ref_id: string }[],
  conversationId: string,
): boolean {
  if (window.satellite) {
    return window.satellite.kind === "chat" && parseChatIslandRef(window.satellite.refId)?.conversationId === conversationId;
  }
  if (!window.main) return false;
  return !satellites.some((s) => s.kind === "chat" && parseChatIslandRef(s.ref_id)?.conversationId === conversationId);
}

/** How long a turn may take to start after `send` (a repository lease, a queue). */
const START_MS = 120_000;

/** Waits for a store's session to go through a turn and returns its last answer. */
export function awaitTurn<S>(
  subscribe: (listener: (state: S) => void) => () => void,
  read: (state: S) => { sending: boolean; last: { content: string; isError?: boolean; isCancelled?: boolean } | null } | null,
  current: S,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let started = read(current)?.sending ?? false;
    const timer = setTimeout(() => {
      if (!started) {
        stop();
        reject(new Error("el turno no llegó a empezar"));
      }
    }, START_MS);
    const stop = subscribe((state) => {
      const session = read(state);
      if (!session) return;
      if (session.sending) {
        started = true;
        return;
      }
      if (!started) return;
      clearTimeout(timer);
      stop();
      const last = session.last;
      if (!last) reject(new Error("el chat no respondió"));
      else if (last.isCancelled) reject(new Error("el usuario detuvo el turno"));
      else if (last.isError) reject(new Error(last.content || "el turno falló"));
      else resolve(last.content);
    });
  });
}

async function runPanel(request: ChatDelegateRequest): Promise<string> {
  const store = useChatStore;
  const projectId = request.projectId ?? "";
  await store.getState().ensureLoaded(projectId, request.conversationId);
  const read = (state: ReturnType<typeof store.getState>) => {
    const session = state.byConversation[request.conversationId];
    if (!session) return null;
    const last = [...session.messages].reverse().find((m) => m.role === "assistant") ?? null;
    return { sending: session.sending, last };
  };
  const turn = awaitTurn(store.subscribe, read, store.getState());
  store.getState().send(projectId, request.conversationId, request.message);
  return turn;
}

async function runWorkspace(request: ChatDelegateRequest): Promise<string> {
  const store = useWorkspaceChatStore;
  await store.getState().ensureLoaded(request.conversationId, request.workspaceId);
  const read = (state: ReturnType<typeof store.getState>) => {
    const session = state.byConversation[request.conversationId];
    if (!session) return null;
    const last = [...session.messages].reverse().find((m) => m.role === "assistant") ?? null;
    return { sending: session.sending, last };
  };
  const turn = awaitTurn(store.subscribe, read, store.getState());
  store.getState().send(request.conversationId, request.message);
  return turn;
}

async function handle(request: ChatDelegateRequest): Promise<void> {
  if (!holdsConversation(WINDOW, useWindowStore.getState().satellites, request.conversationId)) return;
  if (!(await chatDelegateAccept(request.requestId))) return;
  useToastStore.getState().pushToast(translate("chat.delegated", { from: request.fromTitle }), "info");
  try {
    const reply = request.surface === "panel" ? await runPanel(request) : await runWorkspace(request);
    await chatDelegateSettle(request.requestId, reply, null);
  } catch (e) {
    await chatDelegateSettle(request.requestId, null, e instanceof Error ? e.message : String(e));
  }
}

let installed = false;

/** Listens for delegated turns. Once per window: main, and each chat island. */
export function installChatDelegate(): void {
  if (installed) return;
  installed = true;
  void onChatDelegate((request) => void handle(request)).catch(() => {
    installed = false;
  });
}
