/**
 * Review: the rules' findings, worst first, each with why it matters and how to fix it — and the
 * deeper review a model does, asked from the same panel.
 */
import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { Finding, Severity } from "../../../lib/architecture/rules";
import type { ResolvedComponents } from "../../../lib/architecture/types";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { Refs, panelBodyClass } from "./bits";
import { ArchAiAction } from "./ArchAiAction";
import { Evidence } from "../sources/SourcesBar";

const SEVERITIES: Severity[] = ["critical", "warning", "suggestion", "risk"];
const TONE: Record<Severity, string> = {
  critical: "var(--cf-danger)",
  warning: "var(--cf-warning)",
  suggestion: "var(--cf-accent)",
  risk: "#be185d",
};

export function ReviewPanel({ findings, comps }: { findings: Finding[]; comps: ResolvedComponents }) {
  const t = useT();
  const selection = useArchitectureViewStore((s) => s.selection);
  const select = useArchitectureViewStore((s) => s.select);
  const [filter, setFilter] = useState<Severity | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const focus = selection?.kind === "card" ? selection.id : null;
  const counts = useMemo(() => {
    const c: Partial<Record<Severity, number>> = {};
    for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [findings]);
  const list = findings.map((f, i) => ({ f, i })).filter(({ f }) => (!filter || f.severity === filter) && (!focus || f.affects.includes(focus)));

  return (
    <div className={panelBodyClass}>
      {findings.length ? (
        <div className="flex flex-wrap gap-1">
          {SEVERITIES.filter((s) => counts[s]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={filter === s}
              onClick={() => setFilter(filter === s ? null : s)}
              className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--cf-border)] px-2.5 text-[11.5px] text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] aria-pressed:border-transparent"
              style={filter === s ? { color: TONE[s], background: `color-mix(in oklab, ${TONE[s]} 13%, transparent)` } : undefined}
            >
              <span aria-hidden className="h-[7px] w-[7px] rounded-full" style={{ background: TONE[s] }} />
              <b className="font-semibold tabular-nums text-[var(--cf-text)]" style={filter === s ? { color: TONE[s] } : undefined}>{counts[s]}</b>
              {t(`arch.sevPlural.${s}` as TranslationKey, { n: counts[s] ?? 0 })}
            </button>
          ))}
        </div>
      ) : (
        <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-[var(--cf-success)]"><CheckCircle2 size={14} />{t("arch.review.clean")}</p>
      )}
      {focus ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
          {t("arch.review.focus", { name: comps[focus]?.name ?? focus })}
          <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={() => select(null)}>{t("arch.review.all")}</button>
        </div>
      ) : null}
      <ArchAiAction action="review" />
      <div className="grid gap-1">
        {list.map(({ f, i }) => {
          const expanded = open === i;
          const key = `arch.rule.${f.rule}` as const;
          return (
            <div key={`${f.rule}-${i}`} className={`rounded-lg border transition-colors duration-100 ${expanded ? "border-[var(--cf-border-strong)] bg-[var(--cf-surface)]" : "border-transparent hover:bg-[var(--cf-hover)]"}`}>
              <button
                type="button"
                aria-expanded={expanded}
                className="grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-x-2.5 px-2.5 py-2 text-left"
                onClick={() => {
                  const next = expanded ? null : i;
                  setOpen(next);
                  if (next !== null && f.affects.length) select(f.affects.length === 1 ? { kind: "card", id: f.affects[0] } : { kind: "cards", ids: f.affects });
                }}
              >
                <span aria-hidden className="mt-[5px] h-2 w-2 rounded-full" style={{ background: TONE[f.severity] }} />
                <span className="grid gap-0.5">
                  <span className="text-[12.5px] font-medium leading-snug text-[var(--cf-text)]">{t(`${key}.title` as TranslationKey, f.params)}</span>
                  <span className="text-[11px] text-[var(--cf-text-faint)]">
                    <span style={{ color: TONE[f.severity] }}>{t(`arch.sev.${f.severity}` as TranslationKey)}</span>
                    {" · "}{t(`arch.area.${f.area}` as TranslationKey)}{f.affects.length ? ` · ${f.affects.length}` : ""}
                  </span>
                </span>
                <ChevronDown size={14} className={`mt-0.5 text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
              {expanded ? (
                <div className="grid gap-2 pb-2.5 pl-[30px] pr-2.5 text-[12px] leading-[1.5] text-[var(--cf-text-muted)]">
                  <p className="m-0">{t(`${key}.why` as TranslationKey, f.params)}</p>
                  <ol className="m-0 grid gap-1 pl-4 text-[var(--cf-text)]">
                    {t(`${key}.fix` as TranslationKey, f.params).split("\n").filter(Boolean).map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  <Refs ids={f.affects} comps={comps} />
                  <Evidence lines={f.affects.flatMap((id) => comps[id]?.evidence ?? [])} max={3} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
