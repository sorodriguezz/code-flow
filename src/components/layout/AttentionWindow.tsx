import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Loader2, X } from "lucide-react";
import { attentionRows, type AttentionAction, type AttentionRow } from "../../lib/attentionRows";
import { MAIN_LABEL } from "../../lib/windowIdentity";
import { broadcast } from "../../lib/windowBus";
import { showMainWindow } from "../../lib/tauri/windows";
import {
  approveChainGate,
  chainExtraLap,
  chainReviewInfo,
  listGatedChains,
  listParkedChains,
  notifyStateChange,
  resumeChain,
} from "../../lib/tauri/commands";
import { onStateInvalidate } from "../../lib/tauri/events";
import { buttonClass } from "../common/Button";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import type { TranslationKey } from "../../lib/i18n/translations";

const REFRESH_MS = 4_000;

const LABEL: Record<AttentionAction, TranslationKey> = {
  approve: "attention.approve",
  resume: "attention.resume",
  extraLap: "agents.reviewOneMoreLap",
  open: "attention.open",
};

/**
 * «Te necesitan»: a small window that stays on top and lists the plans waiting for a person — a gate, a
 * spent quota, a signed-out CLI, a reviewer that stopped — with the buttons to answer them. An agent should
 * not sit blocked until somebody finds the main window.
 *
 * It acts through the same backend commands the Agents view does, then tells the main window to pump the
 * chain (`pump` on the window bus): only the main window runs the executor, because two executors claim the
 * same step twice.
 */
export function AttentionWindow() {
  const t = useT();
  const [rows, setRows] = useState<AttentionRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void Promise.all([listGatedChains().catch(() => []), listParkedChains().catch(() => [])]).then(([gates, parked]) =>
      setRows(attentionRows(gates, parked)),
    );
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    const unlisten = onStateInvalidate(() => load());
    return () => {
      window.clearInterval(timer);
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [load]);

  const advance = (chainId: string) => {
    notifyStateChange("chains");
    broadcast({ kind: "pump", chainId });
    load();
  };

  const act = async (row: AttentionRow, action: AttentionAction) => {
    setBusy(`${row.key}:${action}`);
    try {
      if (action === "open") {
        await showMainWindow().catch(() => {});
        broadcast({ kind: "open-chain", to: MAIN_LABEL, workspaceId: row.workspaceId, projectId: row.projectId, chainId: row.chainId });
        return;
      }
      if (action === "approve") {
        // Empty input keeps the message the gate froze; the step id makes a gate that has since moved refuse
        // rather than be cleared unread.
        await approveChainGate(row.chainId, "", row.stepId || undefined);
      } else if (action === "resume") {
        await resumeChain(row.chainId);
      } else {
        const info = await chainReviewInfo(row.chainId);
        const latest = [...info.laps].sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
        if (latest) await chainExtraLap(row.chainId, latest.step_id);
      }
      advance(row.chainId);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(null);
      load();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Frameless: this strip is the window's handle and its only way to close. */}
      <div data-tauri-drag-region className="flex shrink-0 items-center justify-between px-3 py-2">
        <span data-tauri-drag-region className="text-[12px] font-medium text-[var(--cf-text)]">
          {t("attention.title")}
          {rows.length > 0 && <span className="ml-1.5 text-[var(--cf-text-muted)]">{rows.length}</span>}
        </span>
        <button type="button" aria-label={t("common.close")} onClick={() => void getCurrentWindow().close()} className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          <X size={13} />
        </button>
      </div>
      <ul aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {rows.map((row) => (
          <li key={row.key} className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2">
            <p className="truncate text-[12px] font-medium text-[var(--cf-text)]" title={row.title}>
              {row.title}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--cf-text-muted)]">{t(row.reasonKey as TranslationKey)}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {row.actions.map((action, at) => (
                <button
                  key={action}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void act(row, action)}
                  className={buttonClass({ variant: at === 0 && action !== "open" ? "primary" : "ghost", size: "sm" })}
                >
                  {busy === `${row.key}:${action}` ? <Loader2 size={12} className="animate-spin" /> : action === "approve" ? <Check size={12} /> : null}
                  {/* On a reviewer's stop, resuming is accepting the work as it is. */}
                  {t(action === "resume" && row.reasonKey === "attention.reviewStop" ? "agents.reviewAcceptAsIs" : LABEL[action])}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
