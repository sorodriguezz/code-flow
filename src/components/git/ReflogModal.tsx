import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, Loader2, RotateCcw, Undo2, X } from "lucide-react";
import * as gitApi from "../../lib/tauri/gitCommands";
import type { ReflogEntry, ReflogOp } from "../../lib/tauri/gitCommands";
import { useRepoStore } from "../../state/repoStore";
import { useGitToolsStore } from "../../state/gitToolsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { describeGitError } from "../../lib/gitErrors";
import { reflogOpKey, reflogSubject } from "../../lib/undoPlan";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { buttonClass, iconButtonClass } from "../common/Button";
import { chipClass, type ChipTone } from "../common/recipes";

/**
 * HEAD's reflog — every place HEAD has been, newest first, each named by what moved it — with a way
 * back to any of them.
 *
 * "Restore" puts the branch HEAD is on at that entry's commit, by `reset --keep`, after writing a
 * backup ref (see `git/reflog.rs`); the restore is then itself the newest entry here, so it can be
 * walked back the same way. "Undo last" is the same button the graph's toolbar has.
 */

const TONE: Partial<Record<ReflogOp, ChipTone>> = {
  commit: "ok",
  initial: "ok",
  amend: "info",
  merge: "accent",
  pull: "accent",
  rebase: "warn",
  reset: "bad",
  checkout: "neutral",
  cherry_pick: "info",
  revert: "info",
};

const formatters = new Map<string, Intl.RelativeTimeFormat>();

/** "hace 5 min" — the reflog is read for *when*, and a week-old entry by its date. */
function ago(seconds: number, locale: string): string {
  const delta = Math.round(seconds - Date.now() / 1000);
  const absolute = Math.abs(delta);
  if (absolute > 7 * 86400) return new Date(seconds * 1000).toLocaleDateString(locale, { day: "numeric", month: "short" });
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    formatters.set(locale, formatter);
  }
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as [Intl.RelativeTimeFormatUnit, number][]) {
    if (absolute >= size) return formatter.format(Math.round(delta / size), unit);
  }
  return formatter.format(0, "minute");
}

export function ReflogModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const locale = useLanguageStore((s) => s.language);
  const repoPath = useRepoStore((s) => s.repoPath);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const restoreEntry = useGitToolsStore((s) => s.restoreEntry);
  const undoLast = useGitToolsStore((s) => s.undoLast);
  const undoPlan = useGitToolsStore((s) => s.undoPlan);
  const pending = useGitToolsStore((s) => s.pending);
  const [entries, setEntries] = useState<ReflogEntry[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  const load = useCallback(async () => {
    if (!repoPath) return;
    try {
      setEntries(await gitApi.listReflog(repoPath, 300));
    } catch (e) {
      pushErrorToast(describeGitError(e, t));
      setEntries([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (entry: ReflogEntry) => {
    if (await restoreEntry(entry)) await load();
  };

  const undo = async () => {
    await undoLast();
    await load();
  };

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="cf-fade-in flex max-h-[80vh] w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-4 pr-2">
          <History size={15} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="flex-1 text-[13px] font-semibold text-[var(--cf-text)]" title={t("reflog.hint")}>
            {t("reflog.title")}
          </span>
          <button
            type="button"
            disabled={!undoPlan || pending !== null}
            onClick={() => void undo()}
            title={undoPlan ? t("undo.buttonHint", { op: t(reflogOpKey(undoPlan.op)) }) : t("undo.nothing")}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            {pending === "undo" ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
            {t("undo.button")}
          </button>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className={iconButtonClass({ size: "sm" })}>
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {entries === null ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 size={16} className="animate-spin text-[var(--cf-text-muted)]" />
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={`${entry.index}:${entry.new_oid}`}
                className="group flex h-8 items-center gap-2 rounded-md px-2 text-[12px] hover:bg-[var(--cf-hover)]"
              >
                <span className={chipClass(TONE[entry.op] ?? "neutral", "w-[92px] shrink-0 justify-center")}>
                  {t(reflogOpKey(entry.op))}
                </span>
                <button
                  type="button"
                  onClick={() => void selectCommit(entry.new_oid)}
                  title={entry.message}
                  className="min-w-0 flex-1 truncate text-left text-[var(--cf-text)]"
                >
                  {entry.summary && entry.op !== "checkout" && entry.op !== "reset" ? entry.summary : reflogSubject(entry.message)}
                </button>
                <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text-faint)]">{entry.new_oid.slice(0, 7)}</span>
                <span className="w-[76px] shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                  {ago(entry.time, locale)}
                </span>
                {entry.index === 0 ? (
                  <span className="w-[22px] shrink-0" title={t("reflog.current")} />
                ) : (
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void restore(entry)}
                    title={t("reflog.restore")}
                    aria-label={t("reflog.restore")}
                    className={iconButtonClass({
                      size: "xs",
                      className: "opacity-0 hover:text-[var(--cf-danger)] focus-visible:opacity-100 group-hover:opacity-100",
                    })}
                  >
                    {pending === "restore" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  </button>
                )}
              </div>
            ))
          )}
          {entries !== null && entries.length === 0 && (
            <p className="px-2 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("reflog.empty")}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
