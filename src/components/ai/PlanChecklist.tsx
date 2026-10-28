import { Check, Circle, Loader2 } from "lucide-react";
import { planProgress, type PlanItem } from "../../lib/runPlan";
import { useT } from "../../state/languageStore";

/**
 * The plan the agent keeps for itself, pinned above its steps: what is done, what it is on, what is
 * left — so a long run says where it is without reading its whole log. Drawn from the newest `TodoWrite`
 * (`runPlan.latestPlan`); nothing when the agent keeps no plan.
 */
export function PlanChecklist({ plan, compact = false }: { plan: PlanItem[]; compact?: boolean }) {
  const t = useT();
  const { done, total } = planProgress(plan);
  return (
    <div className={`rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
      <p className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-[var(--cf-text-muted)]">
        <span>{t("runPlan.title")}</span>
        <span className="tabular-nums" aria-label={t("runPlan.progress", { done, total })}>
          {done}/{total}
        </span>
      </p>
      <ul className="space-y-1">
        {plan.map((item, at) => (
          <li key={at} className={`flex items-start gap-1.5 text-[12px] leading-snug ${item.status === "done" ? "text-[var(--cf-text-faint)] line-through" : "text-[var(--cf-text)]"}`}>
            <span className="mt-[3px] shrink-0">
              {item.status === "done" ? (
                <Check size={11} className="text-[var(--cf-success)]" />
              ) : item.status === "active" ? (
                <Loader2 size={11} className="animate-spin text-[var(--cf-accent)]" />
              ) : (
                <Circle size={11} className="text-[var(--cf-text-faint)]" />
              )}
            </span>
            <span className={item.status === "active" ? "font-medium" : ""}>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
