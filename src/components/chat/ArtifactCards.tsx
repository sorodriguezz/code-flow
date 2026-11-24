import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Layers, MessageSquare, Trash2 } from "lucide-react";
import { useDismiss } from "../ai/docParts";
import { popoverClass } from "../common/recipes";
import type { ChatArtifactBlock } from "../../lib/chatArtifacts";
import { chatArtifactDelete, chatRefsList, type ChatArtifactSummary } from "../../lib/tauri/chatRefsCommands";
import { NO_ARTIFACTS, useChatArtifactsStore } from "../../state/chatArtifactsStore";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { useUiStore } from "../../state/uiStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { ArtifactViewer, artifactIcon } from "./ArtifactViewer";

/**
 * The artifacts an answer carries, drawn as cards under its text; a click anywhere on one opens the
 * viewer.
 *
 * As wide as what it says (up to 420px), its kind in words — «Página · 200 líneas» — and the file
 * name in the tooltip. The card it replaced stretched to 448px whatever the title, so «Abrir» sat at
 * the far end of a mostly empty box, under a generic globe and a monospace line of internals (user
 * ask, 2026-11-23).
 */
export function ArtifactCards({ artifacts, projectId }: { artifacts: ChatArtifactBlock[]; projectId?: string | null }) {
  const t = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspaceId);
  const ownWorkspace = useWorkspaceStore((s) => (projectId ? s.workspaceOfProject(projectId) : null));
  const workspaceId = ownWorkspace ?? activeWorkspace ?? null;
  const [open, setOpen] = useState<ChatArtifactBlock | null>(null);
  return (
    <div className="flex flex-col items-start gap-1.5">
      {artifacts.map((a, i) => {
        const Icon = artifactIcon(a.kind);
        const lines = a.content.split("\n").length;
        const kind = t(`artifact.kind.${a.kind}` as never) as string;
        return (
          <button
            key={`${a.name}:${i}`}
            type="button"
            onClick={() => setOpen(a)}
            title={a.name}
            className="group/card flex w-fit max-w-[min(100%,420px)] items-center gap-2.5 rounded-[10px] bg-[var(--cf-surface-raised)] p-1.5 text-left shadow-[inset_0_0_0_1px_var(--cf-border)] transition-shadow hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--cf-accent)_45%,var(--cf-border))]"
          >
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
              <Icon size={15} />
            </span>
            <span className="min-w-0 pr-1">
              <span className="block truncate text-[12.5px] font-semibold text-[var(--cf-text)]">{a.title || a.name}</span>
              <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                {kind.charAt(0).toUpperCase() + kind.slice(1)} · {t("artifact.lines", { n: String(lines) })}
              </span>
            </span>
            <span className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-[7px] bg-[var(--cf-hover)] px-2 py-1 text-[11.5px] font-medium text-[var(--cf-text)] group-hover/card:bg-[var(--cf-accent-fill)] group-hover/card:text-[var(--cf-on-accent)]">
              {t("artifact.open")}
              <ArrowUpRight size={11} />
            </span>
          </button>
        );
      })}
      {open && <ArtifactViewer workspaceId={workspaceId} name={open.name} block={open} projectId={projectId} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One row of a stored-artifacts list. */
function Row({ artifact, onOpen, onDelete }: { artifact: ChatArtifactSummary; onOpen: () => void; onDelete?: () => void }) {
  const t = useT();
  const Icon = artifactIcon(artifact.kind);
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--cf-hover)]">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={13} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">{artifact.title || artifact.name}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-faint)]">
          {artifact.name}
          {artifact.versions > 1 ? ` · v${artifact.version}` : ""}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          title={t("artifact.delete")}
          aria-label={t("artifact.delete")}
          className="hidden shrink-0 text-[var(--cf-text-faint)] hover:text-[var(--cf-danger)] group-hover:block"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * A chat's artifacts, as «▤ N artefactos ▾» in its header strip — absent while it has none. A click
 * lists them; a row opens the viewer. It used to be a bordered fold of its own between the header
 * and the transcript: a full row of chrome to say «there is one» (user ask, 2026-11-23).
 * `conversationId` names the chat; `workspaceId` where its artifacts are filed.
 */
export function ChatArtifactsMenu({ workspaceId, conversationId, projectId }: { workspaceId: string | null; conversationId: string; projectId?: string | null }) {
  const t = useT();
  const list = useChatArtifactsStore((s) => s.byConversation[conversationId] ?? NO_ARTIFACTS);
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<ChatArtifactSummary | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, menu, () => setMenu(false));
  useEffect(() => {
    if (workspaceId) void useChatArtifactsStore.getState().loadConversation(workspaceId, conversationId);
  }, [workspaceId, conversationId]);
  if (!workspaceId || list.length === 0) return null;
  const label = list.length === 1 ? t("artifact.chipOne") : t("artifact.chipMany", { n: String(list.length) });
  return (
    <div ref={ref} className="relative min-w-0 shrink-0">
      <button
        type="button"
        onClick={() => setMenu((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menu}
        title={t("artifact.inChat", { n: String(list.length) })}
        className="inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <Layers size={11} className="shrink-0" />
        {/* Just the count on a narrow header (the strip is a size container), the words when it
            has room. The button's title still says it in full. */}
        <span className="tabular-nums @[30rem]:hidden">{list.length}</span>
        <span className="hidden @[30rem]:inline">{label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {menu && (
        <div role="menu" className={`absolute right-0 top-full z-40 mt-1 max-h-72 w-72 max-w-[85vw] overflow-y-auto p-1 ${popoverClass}`}>
          {list.map((a) => (
            <Row
              key={a.id}
              artifact={a}
              onOpen={() => {
                setMenu(false);
                setOpen(a);
              }}
            />
          ))}
        </div>
      )}
      {open && <ArtifactViewer workspaceId={workspaceId} name={open.name} projectId={projectId ?? open.project_id} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Opens the chat an artifact came from, wherever it lives: a repository's panel, the workspace
 *  chat, or the Chat app. */
async function openSourceChat(a: ChatArtifactSummary): Promise<void> {
  if (a.surface === "panel" && a.project_id) {
    useAiPanelStore.getState().open({ kind: "chat", projectId: a.project_id, conversationId: a.conversation_id });
    useUiStore.getState().openAiPanel();
    return;
  }
  if (a.surface === "ws") {
    useAiPanelStore.getState().open({ kind: "wsChat", workspaceId: a.workspace_id, conversationId: a.conversation_id });
    useUiStore.getState().openAiPanel();
    return;
  }
  const { useConversationStore } = await import("../../state/conversationStore");
  useUiStore.getState().setActiveView("chat");
  await useConversationStore.getState().loadConversations(true);
  await useConversationStore.getState().open(a.conversation_id);
}

/**
 * «Artefactos», the Inbox's own filter beside Chats and PRs (user, 2026-11-09: «deberían tener su
 * vista entre chats y PRs… y que digan de qué chat salió»): every artifact of the workspace, newest
 * first, each with the chat it came from — a link that opens that chat — and its repository.
 * `query` narrows by name, title or the chat's title.
 */
export function ArtifactsList({ workspaceId, query }: { workspaceId: string | null; query: string }) {
  const t = useT();
  const list = useChatArtifactsStore((s) => (workspaceId ? (s.byWorkspace[workspaceId] ?? NO_ARTIFACTS) : NO_ARTIFACTS));
  const projects = useWorkspaceStore((s) => (workspaceId ? s.projectsByWorkspace[workspaceId] : undefined));
  const language = useLanguageStore((s) => s.language);
  const [chats, setChats] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<ChatArtifactSummary | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    void useChatArtifactsStore.getState().loadWorkspace(workspaceId);
    let live = true;
    void chatRefsList(workspaceId)
      .then((refs) => live && setChats(Object.fromEntries(refs.map((r) => [r.id, r.title.trim()]))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const sorted = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!needle) return sorted;
    return sorted.filter((a) => [a.title, a.name, chats[a.conversation_id] ?? ""].some((s) => s.toLowerCase().includes(needle)));
  }, [list, chats, needle]);

  if (!workspaceId) return null;
  if (shown.length === 0) {
    return <p className="px-1 py-3 text-center text-[12px] text-[var(--cf-text-faint)]">{needle ? t("ai.noMatches") : t("artifact.none")}</p>;
  }

  const remove = async (a: ChatArtifactSummary) => {
    if (!window.confirm(t("artifact.deleteConfirm", { name: a.name }))) return;
    try {
      await chatArtifactDelete(workspaceId, a.name);
      useChatArtifactsStore.getState().invalidate(workspaceId);
      void useChatArtifactsStore.getState().loadWorkspace(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const locale = language === "es" ? "es-ES" : "en-US";
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map((a) => {
        const Icon = artifactIcon(a.kind);
        const chat = chats[a.conversation_id] || t("artifact.untitledChat");
        const repo = a.project_id ? projects?.find((p) => p.id === a.project_id)?.name : null;
        const when = new Date(a.created_at);
        return (
          <div key={a.id} className="group flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-[var(--cf-hover)]">
            <button type="button" onClick={() => setOpen(a)} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" aria-label={t("artifact.open")}>
              <Icon size={14} />
            </button>
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => setOpen(a)} className="block w-full truncate text-left text-[12.5px] text-[var(--cf-text)]">
                {a.title || a.name}
                {a.versions > 1 && <span className="ml-1 font-mono text-[10.5px] text-[var(--cf-text-faint)]">v{a.version}</span>}
              </button>
              <div className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                <MessageSquare size={10} className="shrink-0" />
                <button
                  type="button"
                  onClick={() => void openSourceChat(a).catch((e: unknown) => pushErrorToast(String(e)))}
                  title={t("artifact.openChat")}
                  className="min-w-0 truncate hover:text-[var(--cf-accent)] hover:underline"
                >
                  {chat}
                </button>
                {repo && <span className="shrink-0 truncate text-[var(--cf-text-faint)]">· {repo}</span>}
                {!Number.isNaN(when.getTime()) && (
                  <span className="ml-auto shrink-0 tabular-nums text-[var(--cf-text-faint)]">
                    {when.toLocaleDateString(locale, { day: "numeric", month: "short" })}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void remove(a)}
              title={t("artifact.delete")}
              aria-label={t("artifact.delete")}
              className="mt-0.5 hidden shrink-0 text-[var(--cf-text-faint)] hover:text-[var(--cf-danger)] group-hover:block"
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
      {open && <ArtifactViewer workspaceId={workspaceId} name={open.name} projectId={open.project_id} onClose={() => setOpen(null)} />}
    </div>
  );
}
