import { useMemo } from "react";
import { Activity } from "lucide-react";
import { outageEffects, type SimResult } from "../../../lib/architecture/sim";
import type { ResolvedComponents } from "../../../lib/architecture/types";
import { useLanguageStore, useT } from "../../../state/languageStore";
import { Ref, Refs } from "./bits";

export function SimOutageImpact({ sim, healthy, comps }: { sim: SimResult; healthy: SimResult; comps: ResolvedComponents }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const number = useMemo(() => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }), [language]);
  const rows = useMemo(() => outageEffects(sim, healthy), [sim, healthy]);
  const down = Object.keys(sim.metrics).filter((id) => sim.metrics[id].down);

  return (
    <section aria-label={t("arch.sim.outage.title")} className="grid gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2.5">
      <h3 className="m-0 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--cf-text)]">
        <Activity size={14} className="text-[var(--cf-accent)]" />{t("arch.sim.outage.title")}
      </h3>
      <p className="m-0 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("arch.sim.outage.hint")}</p>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[11px] text-[var(--cf-text-muted)]">{t("arch.sim.outage.off")}</span>
        <Refs ids={down} comps={comps} />
      </div>
      {rows.length ? (
        <ul className="m-0 grid max-h-48 gap-1 overflow-y-auto overscroll-contain border-t border-[var(--cf-border)] pt-1.5 pl-0">
          {rows.map((row) => (
            <li key={row.id} className="grid list-none gap-0.5 rounded-md px-1.5 py-1 hover:bg-[var(--cf-hover)]">
              <Ref id={row.id} comps={comps} plain />
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                {row.errorIncrease >= 0.0005 ? <span className="text-[var(--cf-danger)]">{t("arch.sim.outage.errors", { n: number.format(row.errorIncrease * 100) })}</span> : null}
                {row.loadLost >= 0.05 ? <span>{t("arch.sim.outage.load", { n: number.format(row.loadLost) })}</span> : null}
                {row.backlogIncrease >= 0.05 ? <span className="text-[var(--cf-warning)]">{t("arch.sim.outage.queue", { n: number.format(row.backlogIncrease) })}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="m-0 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("arch.sim.outage.none")}</p>}
    </section>
  );
}
