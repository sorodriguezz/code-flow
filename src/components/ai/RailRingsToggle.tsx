import { Checkbox } from "../common/Checkbox";
import { useT } from "../../state/languageStore";
import { useQuotaStore } from "../../state/quotaStore";

/** The check that puts one ring per account on the rail. The same store value from the status-bar
 * panel and from Settings → Plan limits, so ticking it in one shows ticked in the other. Worded
 * apart from "Show in the status bar" — that one picks *which* limit the pill reports; this one
 * says *whether* the rail draws them all. */
export function RailRingsToggle({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const on = useQuotaStore((s) => s.railRings);
  const setOn = useQuotaStore((s) => s.setRailRings);
  return (
    <label className={`flex cursor-pointer items-start gap-2 ${compact ? "" : "rounded-lg border border-[var(--cf-border)] p-3"}`}>
      <Checkbox checked={on} onChange={(v) => void setOn(v)} className="mt-0.5" />
      <span className="min-w-0">
        <span className={`block font-medium text-[var(--cf-text)] ${compact ? "text-[12px]" : "text-[13px]"}`}>
          {t("quota.railLabel")}
        </span>
        <span className={`block leading-snug text-[var(--cf-text-muted)] ${compact ? "text-[10.5px]" : "text-[11px]"}`}>
          {t("quota.railHint")}
        </span>
      </span>
    </label>
  );
}
