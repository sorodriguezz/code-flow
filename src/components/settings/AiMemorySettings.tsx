import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, History, Lightbulb, Pencil, Plus, Trash2, Undo2, X } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { chipClass, fieldClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import {
  aiMemoryCreate,
  aiMemoryDelete,
  aiMemoryEdit,
  aiMemoryList,
  aiMemoryPropose,
  aiMemoryRevisions,
  aiMemorySetStatus,
  type Memory,
  type MemoryKind,
  type MemoryRevision,
  type MemoryScope,
} from "../../lib/tauri/memoryCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

const KIND_KEY: Record<MemoryKind, TranslationKey> = {
  preference: "memory.kindPreference",
  convention: "memory.kindConvention",
  decision: "memory.kindDecision",
  fact: "memory.kindFact",
};

const SCOPE_KEY: Record<MemoryScope, TranslationKey> = {
  global: "memory.scopeGlobal",
  workspace: "memory.scopeWorkspace",
  project: "memory.scopeProject",
  task: "memory.scopeTask",
};

/**
 * Settings › Memoria: what CodeFlow remembers between conversations (`crate::ai_memory`) — shared
 * by every engine, local or cloud. Candidates wait here for approval; only approved memories are
 * shown to a model, and a local-only one never to a cloud engine.
 */
export function AiMemorySettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projectId = useWorkspaceStore((s) => s.activeProjectId);
  const [rows, setRows] = useState<Memory[]>([]);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<{ title: string; body: string; kind: MemoryKind; scope: MemoryScope; localOnly: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string; body: string } | null>(null);
  const [history, setHistory] = useState<{ id: string; revisions: MemoryRevision[] } | null>(null);

  const reload = useCallback(async () => {
    try {
      const all = await aiMemoryList({ status: status || null, limit: 500 });
      // This workspace's, its repositories' and the global ones.
      setRows(all.filter((m) => m.scope === "global" || m.workspaceId === workspaceId));
    } catch (e) {
      pushErrorToast(String(e));
    }
  }, [status, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      pushErrorToast(String(e));
    }
    void reload();
  };

  const save = async () => {
    if (!draft || (!draft.title.trim() && !draft.body.trim())) return;
    await act(() =>
      aiMemoryCreate({
        scope: draft.scope,
        workspaceId,
        projectId: draft.scope === "project" ? projectId : null,
        kind: draft.kind,
        title: draft.title,
        body: draft.body,
        approved: true,
        localOnly: draft.localOnly,
      }),
    );
    setDraft(null);
  };

  const propose = async () => {
    if (!workspaceId) return;
    try {
      const found = await aiMemoryPropose(workspaceId);
      pushSuccessToast(t("memory.proposed", { n: String(found.length) }));
    } catch (e) {
      pushErrorToast(String(e));
    }
    void reload();
  };

  const candidates = rows.filter((m) => m.status === "candidate").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[170px]">
          <Select
            size="sm"
            value={status}
            ariaLabel={t("memory.status")}
            onChange={setStatus}
            options={[
              { value: "", label: t("memory.allStatuses") },
              { value: "candidate", label: t("memory.candidates") },
              { value: "approved", label: t("memory.approved") },
              { value: "revoked", label: t("memory.revoked") },
            ]}
          />
        </div>
        <button
          type="button"
          onClick={() => setDraft({ title: "", body: "", kind: "convention", scope: projectId ? "project" : "workspace", localOnly: false })}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          <Plus size={13} /> {t("memory.add")}
        </button>
        <button type="button" disabled={!workspaceId} onClick={() => void propose()} className={buttonClass({ variant: "ghost", size: "sm" })}>
          <Lightbulb size={13} /> {t("memory.propose")}
        </button>
        {candidates > 0 && <span className={chipClass("info")}>{t("memory.pending", { n: String(candidates) })}</span>}
      </div>

      {draft && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--cf-border)] p-3">
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={t("memory.titlePlaceholder")}
            aria-label={t("memory.title")}
            className={fieldClass({ size: "sm" })}
          />
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder={t("memory.bodyPlaceholder")}
            aria-label={t("memory.body")}
            rows={3}
            className={`${fieldClass({ size: "sm" })} h-auto py-1.5`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-[150px]">
              <Select
                size="sm"
                value={draft.kind}
                ariaLabel={t("memory.kind")}
                onChange={(value) => setDraft({ ...draft, kind: value as MemoryKind })}
                options={(Object.keys(KIND_KEY) as MemoryKind[]).map((k) => ({ value: k, label: t(KIND_KEY[k]) }))}
              />
            </div>
            <div className="w-[160px]">
              <Select
                size="sm"
                value={draft.scope}
                ariaLabel={t("memory.scope")}
                onChange={(value) => setDraft({ ...draft, scope: value as MemoryScope })}
                options={(["global", "workspace", ...(projectId ? ["project"] : [])] as MemoryScope[]).map((k) => ({ value: k, label: t(SCOPE_KEY[k]) }))}
              />
            </div>
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
              <Checkbox checked={draft.localOnly} onChange={(value) => setDraft({ ...draft, localOnly: value })} />
              {t("memory.localOnly")}
            </label>
            <div className="ml-auto flex gap-1">
              <button type="button" onClick={() => setDraft(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                {t("memory.cancel")}
              </button>
              <button type="button" onClick={() => void save()} className={buttonClass({ variant: "primary", size: "sm" })}>
                {t("memory.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <span className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("memory.empty")}</span>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {rows.map((memory) => (
            <div key={memory.id} className="border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={chipClass(memory.status === "candidate" ? "info" : memory.status === "approved" ? "ok" : "neutral")}>
                      {t(memory.status === "candidate" ? "memory.candidate" : memory.status === "approved" ? "memory.approvedOne" : "memory.revokedOne")}
                    </span>
                    <span className="text-[11px] text-[var(--cf-text-muted)]">{t(KIND_KEY[memory.kind])}</span>
                    <span className="text-[11px] text-[var(--cf-text-muted)]">· {t(SCOPE_KEY[memory.scope])}</span>
                    {memory.localOnly && <span className={chipClass("warn")}>{t("memory.localOnlyChip")}</span>}
                    {memory.useCount > 0 && <span className="text-[11px] text-[var(--cf-text-faint)]">· {t("memory.used", { n: String(memory.useCount) })}</span>}
                  </div>
                  {editing?.id === memory.id ? (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                      <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} aria-label={t("memory.title")} className={fieldClass({ size: "sm" })} />
                      <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label={t("memory.body")} rows={3} className={`${fieldClass({ size: "sm" })} h-auto py-1.5`} />
                      <div className="flex gap-1">
                        <button type="button" onClick={() => setEditing(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                          {t("memory.cancel")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const current = editing;
                            setEditing(null);
                            void act(() => aiMemoryEdit(current.id, { title: current.title, body: current.body }));
                          }}
                          className={buttonClass({ variant: "primary", size: "sm" })}
                        >
                          {t("memory.save")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-0.5 text-[12px] text-[var(--cf-text)]">{memory.title}</p>
                      {memory.body && memory.body !== memory.title && <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{memory.body}</p>}
                    </>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  {memory.status !== "approved" && (
                    <button type="button" title={t("memory.approve")} onClick={() => void act(() => aiMemorySetStatus(memory.id, "approved"))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <Check size={13} />
                    </button>
                  )}
                  {memory.status === "approved" && (
                    <button type="button" title={t("memory.revoke")} onClick={() => void act(() => aiMemorySetStatus(memory.id, "revoked"))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <Undo2 size={13} />
                    </button>
                  )}
                  {memory.status === "candidate" && (
                    <button type="button" title={t("memory.discard")} onClick={() => void act(() => aiMemorySetStatus(memory.id, "revoked"))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <X size={13} />
                    </button>
                  )}
                  <button type="button" title={t("memory.edit")} onClick={() => setEditing({ id: memory.id, title: memory.title, body: memory.body })} className={buttonClass({ variant: "ghost", size: "sm" })}>
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    title={t("memory.history")}
                    onClick={() =>
                      history?.id === memory.id
                        ? setHistory(null)
                        : void aiMemoryRevisions(memory.id).then((revisions) => setHistory({ id: memory.id, revisions }))
                    }
                    className={buttonClass({ variant: "ghost", size: "sm" })}
                  >
                    <History size={13} />
                  </button>
                  <button type="button" title={t("memory.delete")} onClick={() => void act(() => aiMemoryDelete(memory.id))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {history?.id === memory.id && (
                <div className="mt-1.5 flex flex-col gap-0.5 pl-1">
                  {history.revisions.map((revision, index) => (
                    <span key={index} className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                      <ChevronRight size={11} />
                      {new Date(revision.at).toLocaleString()} · {revision.action} · {revision.actor}
                      {revision.body && revision.action === "edited" && <span className="truncate text-[var(--cf-text-faint)]">— {revision.body}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
