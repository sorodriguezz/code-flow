/**
 * The known patterns the drawing already uses, at the foot of the decisions: what each one buys and
 * what it costs here — the trade-offs the decisions above are made against.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import { patternDef, type PatternHit } from "../../../lib/architecture/patterns";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { SectionTitle } from "./bits";

/** Quality attributes a pattern improves (↑) or costs (↓), as small coloured tags. */
export function QualityTags({ improves, costs }: { improves: string[]; costs: string[] }) {
  const t = useT();
  const tag = (a: string, up: boolean) => (
    <span key={`${up}-${a}`} className="rounded-[4px] px-1.5 text-[10.5px] leading-[17px]" style={{ color: up ? "var(--cf-success)" : "var(--cf-danger)", background: `color-mix(in oklab, ${up ? "var(--cf-success)" : "var(--cf-danger)"} 11%, transparent)` }}>
      {up ? "↑" : "↓"} {t(`arch.qa.${a}` as TranslationKey)}
    </span>
  );
  return <div className="flex flex-wrap gap-1">{improves.map((a) => tag(a, true))}{costs.map((a) => tag(a, false))}</div>;
}

/** The known patterns the drawing already uses, each with what it buys and what it costs here. */
export function PatternsHere({ patterns }: { patterns: PatternHit[] }) {
  const t = useT();
  const select = useArchitectureViewStore((s) => s.select);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <SectionTitle aside={String(patterns.length)}>{t("arch.dec.patternsHere")}</SectionTitle>
      <div className="grid gap-0.5">
        {patterns.map((p, i) => {
          const def = patternDef(p.id);
          const expanded = open === i;
          return (
            <div key={`${p.id}-${i}`} className={`rounded-lg border transition-colors duration-100 ${expanded ? "border-[var(--cf-border-strong)] bg-[var(--cf-surface)]" : "border-transparent hover:bg-[var(--cf-hover)]"}`}>
              <button type="button" aria-expanded={expanded} className="flex w-full items-center gap-2 px-2.5 py-[7px] text-left text-[12.5px]" onClick={() => { setOpen(expanded ? null : i); if (!expanded) select({ kind: "cards", ids: p.affects }); }}>
                <span className="min-w-0 flex-1 font-medium text-[var(--cf-text)]">{t(`arch.pattern.${p.id}.name` as TranslationKey)}</span>
                <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{t(`arch.family.${def.family}` as TranslationKey)}</span>
                <ChevronDown size={14} className={`shrink-0 text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
              {expanded ? (
                <div className="grid gap-1.5 px-2.5 pb-2.5 text-[12px] leading-[1.45] text-[var(--cf-text-muted)]">
                  <p className="m-0">{t(`arch.pattern.${p.id}.what` as TranslationKey)}</p>
                  <p className="m-0"><b className="text-[var(--cf-text)]">{t("arch.dec.patternHere")}</b> {t(`arch.pattern.${p.id}.here` as TranslationKey, p.params)}</p>
                  <QualityTags improves={def.improves} costs={def.costs} />
                </div>
              ) : null}
            </div>
          );
        })}
        {!patterns.length ? <p className="m-0 text-[12px] text-[var(--cf-text-faint)]">{t("arch.dec.noPatterns")}</p> : null}
      </div>
    </>
  );
}
