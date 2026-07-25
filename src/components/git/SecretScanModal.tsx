import { useEffect } from "react";
import { AlertOctagon, AlertTriangle, MapPin, ShieldAlert } from "lucide-react";
import type { SecretHit } from "../../types/domain";
import { useT } from "../../state/languageStore";

const SEVERITY_STYLE: Record<SecretHit["severity"], { icon: typeof AlertOctagon; color: string }> = {
  critical: { icon: AlertOctagon, color: "var(--cf-danger)" },
  warning: { icon: AlertTriangle, color: "var(--cf-warning)" },
};

/**
 * Blocking gate shown when the pre-commit secret scanner finds credential-looking content in the
 * staged diff. The safe default (Escape / backdrop / Cancel) aborts the commit; the user has to
 * deliberately choose "commit anyway". Nothing is deleted automatically.
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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={onCancel}>
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
                    className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase"
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
                <code className="mt-1 block truncate rounded bg-black/[0.04] px-1.5 py-1 font-mono text-[11px] text-[var(--cf-text)] dark:bg-white/[0.06]">
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
              className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              {t("secrets.commitAnyway")}
            </button>
            <button
              onClick={onCancel}
              autoFocus
              className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
            >
              {t("secrets.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
