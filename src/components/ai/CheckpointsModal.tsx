import { useCallback, useEffect, useState } from "react";
import { History, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import {
  deleteAiCheckpoint,
  listAiCheckpoints,
  restoreAiCheckpoint,
  type AiCheckpoint,
} from "../../lib/tauri/commands";
import { useRepoStore } from "../../state/repoStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { EmptyState } from "../common/EmptyState";

/** Maps the backend's stable action keys onto translated labels. An unknown key (an older
 * checkpoint, a kind added later) falls back to showing the raw key rather than nothing. */
const KIND_LABELS: Record<string, TranslationKey> = {
  chat: "checkpoints.kindChat",
  "fix-finding": "checkpoints.kindFix",
  "replace-all": "checkpoints.kindReplace",
};

/** The undo list: every snapshot taken before something was allowed to rewrite the working tree
 * — an AI run, a project-wide replace — with the files it would put back. Snapshots that would
 * restore nothing are dropped by the backend, so everything listed here is a real, reversible
 * change. */
export function CheckpointsModal({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const t = useT();
  const [checkpoints, setCheckpoints] = useState<AiCheckpoint[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setCheckpoints(await listAiCheckpoints(repoPath).catch(() => []));
  }, [repoPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (checkpoint: AiCheckpoint) => {
    const ok = await confirmAction(
      t("checkpoints.confirmRestore", { n: checkpoint.changed_paths.length }),
      true,
    );
    if (!ok) return;
    setBusyId(checkpoint.id);
    try {
      const restored = await restoreAiCheckpoint(repoPath, checkpoint.id);
      useToastStore.getState().pushToast(t("checkpoints.restored", { n: restored.length }), "success");
      // The files changed on disk; the working diff and status the rest of the app shows are
      // now stale until they're re-read.
      void useRepoStore.getState().refreshAll();
      await reload();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (checkpoint: AiCheckpoint) => {
    setBusyId(checkpoint.id);
    try {
      await deleteAiCheckpoint(repoPath, checkpoint.id);
      await reload();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <History size={14} className="text-[var(--cf-accent)]" />
          <h2 className="text-[13px] font-semibold">{t("checkpoints.title")}</h2>
          <button onClick={onClose} className="ml-auto text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {checkpoints === null ? (
            <div className="flex justify-center py-8">
              <Loader2 size={16} className="animate-spin text-[var(--cf-text-muted)]" />
            </div>
          ) : checkpoints.length === 0 ? (
            <EmptyState icon={History} title={t("checkpoints.empty")} subtitle={t("checkpoints.emptyHint")} />
          ) : (
            <div className="space-y-2">
              {checkpoints.map((checkpoint) => {
                const kindKey = KIND_LABELS[checkpoint.kind];
                return (
                  <div
                    key={checkpoint.id}
                    className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium">{kindKey ? t(kindKey) : checkpoint.kind}</span>
                      <span className="text-[11px] text-[var(--cf-text-muted)]">
                        {new Date(checkpoint.created_at * 1000).toLocaleString()}
                      </span>
                      <button
                        onClick={() => void restore(checkpoint)}
                        disabled={busyId !== null}
                        className="ml-auto flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-0.5 text-[11px] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
                      >
                        {busyId === checkpoint.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <RotateCcw size={11} />
                        )}
                        {t("checkpoints.restore")}
                      </button>
                      <button
                        onClick={() => void remove(checkpoint)}
                        disabled={busyId !== null}
                        title={t("checkpoints.forget")}
                        className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {checkpoint.changed_paths.slice(0, 6).map((path) => (
                        <li key={path} className="truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
                          {path}
                        </li>
                      ))}
                      {checkpoint.changed_paths.length > 6 && (
                        <li className="text-[10px] text-[var(--cf-text-muted)]">
                          {t("checkpoints.andMore", { n: checkpoint.changed_paths.length - 6 })}
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
