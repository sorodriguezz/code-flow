import { useEffect, useId, useRef, useState } from "react";
import { useDialog } from "../../lib/useFocusTrap";
import { X } from "lucide-react";
import { getCommitDiff } from "../../lib/tauri/commands";
import { useRepoStore } from "../../state/repoStore";
import { DiffView } from "../git/DiffView";
import { BouncingDots } from "../common/BouncingDots";
import { useT } from "../../state/languageStore";
import type { FileDiffInfo, StashInfo } from "../../types/domain";

export function StashDiffModal({ stash, onClose }: { stash: StashInfo; onClose: () => void }) {
  const repoPath = useRepoStore((s) => s.repoPath);
  const [diff, setDiff] = useState<FileDiffInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setDiff(null);
    setError(null);
    getCommitDiff(repoPath, stash.oid)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, stash.oid]);

  // A dialog's keyboard contract: Tab stays inside, and Escape closes it while it is the top
  // layer. It had neither — Tab walked into the app behind the backdrop.
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const t = useT();
  useDialog(panelRef, true, onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] w-[92vw] max-w-[1200px] flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-2">
          <span id={titleId} className="truncate text-[13px] font-medium text-[var(--cf-text)]">{stash.message}</span>
          <button onClick={onClose} aria-label={t("common.close")} className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {error ? (
            <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>
          ) : diff ? (
            <DiffView files={diff} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <BouncingDots />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
