import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertOctagon, AlertTriangle, MapPin, ShieldAlert } from "lucide-react";
import type { SecretHit } from "../../types/domain";
import { useT } from "../../state/languageStore";
import { buttonClass } from "../common/Button";

const SEVERITY_STYLE: Record<SecretHit["severity"], { icon: typeof AlertOctagon; color: string }> = {
  critical: { icon: AlertOctagon, color: "var(--cf-danger)" },
  warning: { icon: AlertTriangle, color: "var(--cf-warning)" },
};

/**
 * Blocking gate shown when the pre-commit secret scanner finds credential-looking content in the
 * staged diff. The safe default (Escape / backdrop / Cancel) aborts the commit; the user has to
 * deliberately choose "commit anyway". Nothing is deleted automatically.
 *
 * **It portals to `document.body`, and it has to.** The changes panel renders inside
 * `.cf-ambient-bg` — and that carries `isolation: isolate` so its ambient gradient (a `::before` at
 * `z-index: -1`) stays behind the view instead of the whole app. Isolation makes a stacking context,
 * which traps every overlay rendered inside it: no `z-index` on a descendant can lift this gate over
 * the terminal dock, the AI panel or the status bar, because those are later siblings of the
 * isolated element. That is worse here than for an ordinary dialog — a gate the user can see *past*
 * and click *through* is not blocking anything, which is the whole job of this one.
 *
 * `z-40` — the dialog layer — rather than the `z-[60]` this carried before the portal. That number
 * only ever meant "above the trap"; nothing was reading it, since the stacking context made it moot.
 * Out here it stops being free: `ConfirmModal` sits at `z-[60]` precisely so it can be raised on top
 * of dialogs, and a portal appends *after* the app root, so an equal z-index would break the tie by
 * DOM order and put this gate over the confirm. The layers are app chrome (unnumbered) < dialogs
 * like this one (`z-40`) < the app-root overlays — Settings, the command palette, toasts (`z-50`) <
 * `ConfirmModal` (`z-[60]`) < popovers (`z-[9999]`).
 */
export function SecretScanModal({
  hits,
  onCancel,
  onCommitAnyway,
}: {
  hits: SecretHit[];
  onCancel: () => void;
  onCommitAnyway: () => void;
}) {
  const t = useT();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const criticalCount = hits.filter((h) => h.severity === "critical").length;

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-start gap-3 border-b border-[var(--cf-border)] p-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--cf-danger)_16%,transparent)] text-[var(--cf-danger)]">
            <ShieldAlert size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-[var(--cf-text)]">{t("secrets.title")}</h2>
            <p className="mt-0.5 text-[12px] text-[var(--cf-text-muted)]">
              {t("secrets.subtitle", { n: hits.length })}
            </p>
          </div>
        </div>

        <ul className="min-h-0 flex-1 space-y-1.5 overflow-auto p-3">
          {hits.map((hit, i) => {
            const style = SEVERITY_STYLE[hit.severity];
            const Icon = style.icon;
            return (
              <li
                key={`${hit.file}:${hit.line}:${i}`}
                className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2.5"
                style={{ borderLeft: `3px solid ${style.color}` }}
              >
                <div className="flex items-center gap-2">
                  <Icon size={14} style={{ color: style.color }} className="shrink-0" />
                  <span className="text-[13px] font-medium text-[var(--cf-text)]">{hit.rule_name}</span>
                  <span
                    className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold uppercase"
                    style={{ color: style.color, backgroundColor: `color-mix(in oklab, ${style.color} 14%, transparent)` }}
                  >
                    {t(hit.severity === "critical" ? "secrets.critical" : "secrets.warning")}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                  <MapPin size={11} className="shrink-0" />
                  <span className="truncate font-mono">
                    {hit.file}:{hit.line}
                  </span>
                </div>
                <code className="mt-1 block truncate rounded bg-[var(--cf-hover)] px-1.5 py-1 font-mono text-[11px] text-[var(--cf-text)]">
                  {hit.preview}
                </code>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--cf-border)] p-3">
          <span className="text-[11px] text-[var(--cf-text-muted)]">
            {criticalCount > 0 ? t("secrets.criticalCount", { n: criticalCount }) : t("secrets.reviewHint")}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCommitAnyway}
              className={buttonClass({ variant: "ghost" })}
            >
              {t("secrets.commitAnyway")}
            </button>
            <button
              onClick={onCancel}
              autoFocus
              className={buttonClass({ variant: "primary" })}
            >
              {t("secrets.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
