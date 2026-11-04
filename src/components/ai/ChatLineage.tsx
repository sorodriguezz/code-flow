import { useEffect, useMemo } from "react";
import { CornerLeftUp, GitBranch, MessageSquarePlus, PictureInPicture2 } from "lucide-react";
import { WINDOW } from "../../lib/windowIdentity";
import { openChatIsland } from "../../lib/chatIslands";
import { chatTabKey, newConversationId, useAiPanelStore, wsChatTabKey, type PanelTab } from "../../state/aiPanelStore";
import { EMPTY_LINKS, useChatLineageStore } from "../../state/chatLineageStore";
import { useChatHistoryStore } from "../../state/activityStore";
import { useChatStore } from "../../state/chatStore";
import { useWorkspaceChatStore } from "../../state/workspaceChatStore";
import { useT } from "../../state/languageStore";
import type { ChatLink } from "../../lib/tauri/chatLineage";

/**
 * Subchats and chat islands, for both panel chats: the two header buttons («Nuevo subchat», «Abrir en
 * una isla») and the row under the header naming the parent and the subchats.
 *
 * `scopeId` is what the conversation runs on — the project of a repository chat, the workspace of a
 * workspace chat — and what a new subchat runs on too.
 */
export interface LineageScope {
  surface: "panel" | "ws";
  scopeId: string;
  /** The workspace the links are kept under. */
  workspaceId: string | null;
  conversationId: string;
}

const headerButton =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40 disabled:hover:bg-transparent";

/** A blank conversation on the same repository or workspace, opened in its own tab under this one. */
export async function startSubchat(scope: LineageScope): Promise<void> {
  if (!scope.workspaceId) return;
  const id = scope.surface === "panel" ? newConversationId() : crypto.randomUUID();
  await useChatLineageStore.getState().link(scope.workspaceId, {
    conversationId: id,
    surface: scope.surface,
    parentId: scope.conversationId,
    kind: "new",
    scopeId: scope.scopeId,
  });
  if (scope.surface === "ws") {
    // The repositories the parent was narrowed to come along: same workspace, same selection.
    const ws = useWorkspaceChatStore.getState();
    const narrowed = ws.scopeFor(scope.conversationId);
    if (narrowed) ws.setScope(id, narrowed);
  }
  useAiPanelStore
    .getState()
    .open(
      scope.surface === "panel"
        ? { kind: "chat", projectId: scope.scopeId, conversationId: id, fresh: true }
        : { kind: "wsChat", workspaceId: scope.scopeId, conversationId: id, fresh: true },
    );
}

/** The two header buttons. `busy`: a turn is running — no island then. */
export function ChatLineageButtons({
  scope,
  title,
  busy,
  persisted,
}: {
  scope: LineageScope;
  title: string;
  busy: boolean;
  persisted: boolean;
}) {
  const t = useT();
  const inIsland = WINDOW.satellite?.kind === "chat";
  const tab: PanelTab =
    scope.surface === "panel"
      ? { kind: "chat", key: chatTabKey(scope.conversationId), projectId: scope.scopeId, conversationId: scope.conversationId }
      : { kind: "wsChat", key: wsChatTabKey(scope.conversationId), workspaceId: scope.scopeId, conversationId: scope.conversationId };
  return (
    <>
      <button
        type="button"
        onClick={() => void startSubchat(scope)}
        disabled={!scope.workspaceId}
        title={t("assistant.newSubchatHint")}
        aria-label={t("assistant.newSubchat")}
        className={headerButton}
      >
        <MessageSquarePlus size={12} />
      </button>
      {/* Only a conversation that exists on disk can be read by another window. */}
      {!inIsland && persisted && (
        <button
          type="button"
          onClick={() => void openChatIsland(tab, title || t("assistant.newChat"))}
          disabled={busy}
          title={busy ? t("assistant.islandBusy") : t("assistant.openIslandHint")}
          aria-label={t("assistant.openIsland")}
          className={headerButton}
        >
          <PictureInPicture2 size={12} />
        </button>
      )}
    </>
  );
}

/** A conversation's title as the stores hold it, for the subchat row. */
function useTitles(surface: "panel" | "ws", scopeId: string, ids: string[]): Record<string, string> {
  const history = useChatHistoryStore((s) => (surface === "panel" ? s.byProject[scopeId] : undefined));
  const live = useChatStore((s) => s.byConversation);
  const wsList = useWorkspaceChatStore((s) => (surface === "ws" ? s.listByWorkspace[scopeId] : undefined));
  const wsLive = useWorkspaceChatStore((s) => s.byConversation);
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      out[id] =
        surface === "panel"
          ? history?.find((c) => c.session_id === id)?.title || live[id]?.title || ""
          : wsList?.find((c) => c.id === id)?.title || wsLive[id]?.title || "";
    }
    return out;
  }, [ids, surface, history, live, wsList, wsLive]);
}

/**
 * Under the header: «↰ parent» when this is a subchat, and one chip per subchat. Nothing at all
 * for a conversation with neither.
 */
export function SubchatRow({ scope }: { scope: LineageScope }) {
  const t = useT();
  const links = useChatLineageStore((s) => (scope.workspaceId ? (s.byWorkspace[scope.workspaceId] ?? EMPTY_LINKS) : EMPTY_LINKS));
  useEffect(() => {
    if (scope.workspaceId) void useChatLineageStore.getState().load(scope.workspaceId);
  }, [scope.workspaceId]);
  const own = links.find((l) => l.conversationId === scope.conversationId) ?? null;
  const children = useMemo(() => links.filter((l) => l.parentId === scope.conversationId), [links, scope.conversationId]);
  const ids = useMemo(() => [own?.parentId, ...children.map((c) => c.conversationId)].filter((x): x is string => !!x), [own, children]);
  const titles = useTitles(scope.surface, scope.scopeId, ids);
  if (!own && children.length === 0) return null;

  const go = (link: Pick<ChatLink, "surface" | "scopeId">, conversationId: string) =>
    useAiPanelStore
      .getState()
      .open(
        link.surface === "panel"
          ? { kind: "chat", projectId: link.scopeId, conversationId }
          : { kind: "wsChat", workspaceId: link.scopeId, conversationId },
      );

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--cf-border)] px-3 py-1 text-[11px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {own && (
        <button
          type="button"
          onClick={() => go(own, own.parentId)}
          title={t("assistant.subchatParentHint")}
          className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <CornerLeftUp size={11} className="shrink-0" />
          <span className="truncate">{titles[own.parentId] || t("assistant.subchatParent")}</span>
        </button>
      )}
      {children.length > 0 && (
        <span className="shrink-0 px-1 text-[var(--cf-text-faint)]">{t("assistant.subchats", { n: String(children.length) })}</span>
      )}
      {children.map((child) => {
        const Icon = child.kind === "branch" ? GitBranch : MessageSquarePlus;
        return (
          <button
            key={child.conversationId}
            type="button"
            onClick={() => go(child, child.conversationId)}
            title={child.kind === "branch" ? t("assistant.subchatBranch") : t("assistant.subchatNew")}
            className="flex min-w-0 max-w-[180px] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          >
            <Icon size={11} className="shrink-0" />
            <span className="truncate">{titles[child.conversationId] || t("assistant.newChat")}</span>
          </button>
        );
      })}
    </div>
  );
}
