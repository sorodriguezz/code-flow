import { useEffect, useState } from "react";
import { Layers, Trash2 } from "lucide-react";
import type { ChatArtifactBlock } from "../../lib/chatArtifacts";
import { chatArtifactDelete, type ChatArtifactSummary } from "../../lib/tauri/chatRefsCommands";
import { NO_ARTIFACTS, useChatArtifactsStore } from "../../state/chatArtifactsStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { ArtifactViewer, artifactIcon } from "./ArtifactViewer";

/** The artifacts an answer carries, drawn as cards under its text; a click opens the viewer. */
export function ArtifactCards({ artifacts, projectId }: { artifacts: ChatArtifactBlock[]; projectId?: string | null }) {
  const t = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspaceId);
  const ownWorkspace = useWorkspaceStore((s) => (projectId ? s.workspaceOfProject(projectId) : null));
  const workspaceId = ownWorkspace ?? activeWorkspace ?? null;
  const [open, setOpen] = useState<ChatArtifactBlock | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      {artifacts.map((a, i) => {
        const Icon = artifactIcon(a.kind);
        const lines = a.content.split("\n").length;
        return (
          <button
            key={`${a.name}:${i}`}
            type="button"
            onClick={() => setOpen(a)}
            className="flex w-full max-w-md items-center gap-2.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 text-left hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--cf-hover)] text-[var(--cf-accent)]">
              <Icon size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-[var(--cf-text)]">{a.title || a.name}</span>
              <span className="block truncate font-mono text-[10.5px] text-[var(--cf-text-muted)]">
                {a.name} · {t(`artifact.kind.${a.kind}` as never)} · {t("artifact.lines", { n: String(lines) })}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-[var(--cf-accent)]">{t("artifact.open")}</span>
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
 * A chat's artifacts, as a fold over its transcript — absent while it has none. `conversationId`
 * names the chat; `workspaceId` where its artifacts are filed.
 */
export function ChatArtifactsStrip({ workspaceId, conversationId, projectId }: { workspaceId: string | null; conversationId: string; projectId?: string | null }) {
  const t = useT();
  const list = useChatArtifactsStore((s) => s.byConversation[conversationId] ?? NO_ARTIFACTS);
  const [folded, setFolded] = useState(true);
  const [open, setOpen] = useState<ChatArtifactSummary | null>(null);
  useEffect(() => {
    if (workspaceId) void useChatArtifactsStore.getState().loadConversation(workspaceId, conversationId);
  }, [workspaceId, conversationId]);
  if (!workspaceId || list.length === 0) return null;
  return (
    <div className="mx-3 mt-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <button type="button" onClick={() => setFolded((f) => !f)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-[var(--cf-text-muted)]">
        <Layers size={12} />
        {t("artifact.inChat", { n: String(list.length) })}
      </button>
      {!folded && (
        <div className="border-t border-[var(--cf-border)] px-1 py-1">
          {list.map((a) => (
            <Row key={a.id} artifact={a} onOpen={() => setOpen(a)} />
          ))}
        </div>
      )}
      {open && <ArtifactViewer workspaceId={workspaceId} name={open.name} projectId={projectId ?? open.project_id} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Every artifact of a workspace — the Inbox's section. Absent while there are none. */
export function WorkspaceArtifacts({ workspaceId }: { workspaceId: string | null }) {
  const t = useT();
  const list = useChatArtifactsStore((s) => (workspaceId ? (s.byWorkspace[workspaceId] ?? NO_ARTIFACTS) : NO_ARTIFACTS));
  const [folded, setFolded] = useState(true);
  const [open, setOpen] = useState<ChatArtifactSummary | null>(null);
  useEffect(() => {
    if (workspaceId) void useChatArtifactsStore.getState().loadWorkspace(workspaceId);
  }, [workspaceId]);
  if (!workspaceId || list.length === 0) return null;
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
  return (
    <div>
      <button
        type="button"
        onClick={() => setFolded((f) => !f)}
        className="flex w-full items-center gap-1.5 px-1 py-1 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--cf-text-faint)]"
      >
        <Layers size={11} />
        {t("artifact.title")} · {list.length}
      </button>
      {!folded && (
        <div className="pb-1">
          {list.map((a) => (
            <Row key={a.id} artifact={a} onOpen={() => setOpen(a)} onDelete={() => void remove(a)} />
          ))}
        </div>
      )}
      {open && <ArtifactViewer workspaceId={workspaceId} name={open.name} projectId={open.project_id} onClose={() => setOpen(null)} />}
    </div>
  );
}
