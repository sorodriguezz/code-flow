import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createLatestWriter } from "./latestWriter";
import { chatQueueKey, queuedMessages } from "../state/chatQueueStore";
import { getSetting, setSetting } from "./tauri/commands";
import { MAIN_LABEL, WINDOW } from "./windowIdentity";
import { onWindowMessage, sendTo } from "./windowBus";
import { chatIslandRefId, parseChatIslandRef, registerChatIslandHandler, type ChatIslandRef } from "./chatIslandSync";
import type { SatelliteInfo } from "./tauri/windows";
import {
  chatTabKey,
  disablePanelPersistence,
  flushDrafts,
  registerOpenInterceptor,
  useAiPanelStore,
  wsChatTabKey,
  type PanelTab,
} from "../state/aiPanelStore";
import { useChatStore } from "../state/chatStore";
import { useWorkspaceChatStore, wsChatQueueKey } from "../state/workspaceChatStore";
import { useWindowStore } from "../state/windowStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useUiStore } from "../state/uiStore";

/**
 * Chat islands: one assistant conversation — a repository chat or a workspace chat — in a window of
 * its own, several at once, none of them spending the island limit.
 *
 * **Detaching moves it**, as every island does: while the window is open the conversation's tab is
 * not drawn in the main window's panel (`useHeldChatTabKeys`), opening it from anywhere brings the
 * island forward instead (the open interceptor), and when the window closes the tab is back, focused,
 * with whatever the island added read again from disk.
 *
 * An island has no panel. What it would open there — a fork, a new subchat, another chat — is sent
 * to the main window to open. Nothing of the panel's state is written from it either, except its own
 * draft, under a key of its own the main window takes back on return.
 */

/** The island ref of a chat tab, `null` for any other tab. */
export function tabIslandRef(tab: PanelTab): ChatIslandRef | null {
  if (tab.kind === "chat") return { surface: "panel", projectId: tab.projectId, conversationId: tab.conversationId };
  if (tab.kind === "wsChat") return { surface: "ws", workspaceId: tab.workspaceId, conversationId: tab.conversationId };
  return null;
}

/** The panel tab key a chat island's conversation has. */
export function islandTabKey(ref: ChatIslandRef): string {
  return ref.surface === "panel" ? chatTabKey(ref.conversationId) : wsChatTabKey(ref.conversationId);
}

/** Tab keys held by chat islands, given the satellites open. Pure. */
export function heldChatTabKeys(satellites: readonly SatelliteInfo[]): Set<string> {
  const keys = new Set<string>();
  for (const s of satellites) {
    if (s.kind !== "chat" || s.label === WINDOW.label) continue;
    const ref = parseChatIslandRef(s.ref_id);
    if (ref) keys.add(islandTabKey(ref));
  }
  return keys;
}

/** The tab keys the panel must not draw right now, because an island holds them. */
export function useHeldChatTabKeys(): Set<string> {
  const satellites = useWindowStore((s) => s.satellites);
  return useMemo(() => heldChatTabKeys(satellites), [satellites]);
}

function islandLabelFor(key: string): string | null {
  for (const s of useWindowStore.getState().satellites) {
    if (s.kind !== "chat") continue;
    const ref = parseChatIslandRef(s.ref_id);
    if (ref && islandTabKey(ref) === key) return s.label;
  }
  return null;
}

const islandDraftKey = (tabKey: string) => `ai_panel_island_draft:${tabKey}`;

/** Whether the conversation has a turn running — an island is not opened under one. */
export function chatTabBusy(tab: PanelTab): boolean {
  if (tab.kind === "chat") {
    return (
      Boolean(useChatStore.getState().byConversation[tab.conversationId]?.sending) ||
      queuedMessages(chatQueueKey("panel", tab.conversationId)).length > 0
    );
  }
  if (tab.kind === "wsChat") {
    return (
      Boolean(useWorkspaceChatStore.getState().byConversation[tab.conversationId]?.sending) ||
      queuedMessages(wsChatQueueKey(tab.conversationId)).length > 0
    );
  }
  return false;
}

/**
 * Whether `tab` may go to an island now — the button's rule and the tear-out's: a chat that exists
 * on disk (another window can only read what was written), with no turn running and nothing queued.
 * A tab whose conversation is not in memory came back from disk, so it exists.
 */
export function chatTabDetachable(tab: PanelTab): boolean {
  if (tab.kind !== "chat" && tab.kind !== "wsChat") return false;
  if (chatTabBusy(tab)) return false;
  const session =
    tab.kind === "chat"
      ? useChatStore.getState().byConversation[tab.conversationId]
      : useWorkspaceChatStore.getState().byConversation[tab.conversationId];
  if (session) return session.persisted && session.messages.length > 0;
  return !tab.fresh;
}

/** «Abrir en una isla», or the tab dragged out of the strip: the conversation of `tab` in a window
 *  of its own — opened at `at` (logical screen px, where the tab was let go) when given. */
export async function openChatIsland(tab: PanelTab, title: string, at?: { x: number; y: number }): Promise<boolean> {
  const ref = tabIslandRef(tab);
  if (!ref || !chatTabDetachable(tab)) return false;
  // The island reads the draft from disk as it boots.
  await flushDrafts();
  return useWindowStore.getState().detach("chat", chatIslandRefId(ref), title, at);
}

let installed = false;

/** Wires the main window (or, in a chat island, the island) — once, from `AiPanel` / the island. */
export function installChatIslands(): void {
  if (installed) return;
  installed = true;

  if (WINDOW.satellite?.kind === "chat") {
    installInIsland();
    return;
  }
  if (!WINDOW.main) return;

  // Opening a conversation an island holds brings the island forward.
  registerOpenInterceptor((target) => {
    if (!target.conversationId) return false;
    const key = target.kind === "chat" ? chatTabKey(target.conversationId) : wsChatTabKey(target.conversationId);
    const label = islandLabelFor(key);
    if (!label) return false;
    void useWindowStore.getState().focus(label);
    return true;
  });

  // What an island asks to have opened.
  onWindowMessage((message) => {
    if (message.kind !== "panel-open" || message.to !== WINDOW.label) return;
    useAiPanelStore.getState().open(message.target);
  });

  registerChatIslandHandler({
    opened: () => {
      // Nothing to release: the tab stops being drawn (`useHeldChatTabKeys`) and the turns the island
      // adds are folded in when it returns.
    },
    returned: (ref) => {
      const key = islandTabKey(ref);
      void (async () => {
        // The island's unsent text, if it left any.
        // An envelope, so "the island cleared it" (sent it) is told apart from "never touched it".
        const raw = await getSetting(islandDraftKey(key)).catch(() => null);
        if (raw) {
          try {
            const { text } = JSON.parse(raw) as { text?: unknown };
            if (typeof text === "string") useAiPanelStore.getState().setDraft(key, text);
          } catch {
            // A corrupt envelope is a lost draft, nothing more.
          }
          void setSetting(islandDraftKey(key), "").catch(() => {});
        }
        if (ref.surface === "panel") {
          await useChatStore.getState().reconcile(ref.projectId, ref.conversationId).catch(() => {});
        } else if (useWorkspaceChatStore.getState().byConversation[ref.conversationId]) {
          await useWorkspaceChatStore.getState().ensureLoaded(ref.conversationId, ref.workspaceId).catch(() => {});
        }
      })();
      // Back where it was, and on screen.
      const workspaceId =
        ref.surface === "panel" ? useWorkspaceStore.getState().workspaceOfProject(ref.projectId) : ref.workspaceId;
      const panel = useAiPanelStore.getState();
      const open = workspaceId ? (panel.tabsByWorkspace[workspaceId] ?? []).some((t) => t.key === key) : false;
      if (open && workspaceId && workspaceId === useWorkspaceStore.getState().activeWorkspaceId) {
        panel.focus(key, workspaceId);
        useUiStore.getState().openAiPanel();
      }
    },
  });
}

function installInIsland(): void {
  disablePanelPersistence();
  const ref = parseChatIslandRef(WINDOW.satellite?.refId ?? "");
  // Everything the conversation would open in a panel is the main window's to open.
  registerOpenInterceptor((target) => {
    const own = ref && target.conversationId === ref.conversationId;
    if (own) return true;
    void sendTo(MAIN_LABEL, { kind: "panel-open", to: MAIN_LABEL, target }).catch(() => {});
    return true;
  });
  if (!ref) return;
  // Its own draft, written where the main window will look for it on return — every change on its
  // way to disk at once (no timer), and the close waits for the last one. Both ways out of the window
  // («Volver al panel» and the red button, the OS's close too) are a close request.
  const key = islandTabKey(ref);
  const writer = createLatestWriter((text: string) => setSetting(islandDraftKey(key), JSON.stringify({ text })));
  let last = useAiPanelStore.getState().drafts[key] ?? "";
  useAiPanelStore.subscribe((state) => {
    const now = state.drafts[key] ?? "";
    if (now === last) return;
    last = now;
    writer.push(now);
  });
  // Listening is what makes Tauri hold the close until the handler resolves.
  void getCurrentWindow()
    .onCloseRequested(async () => {
      await writer.flush();
    })
    .catch(() => {});
}
