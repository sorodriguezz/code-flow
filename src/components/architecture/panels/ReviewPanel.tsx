import { useState } from "react";
import { CheckCircle2, ChevronDown, Crosshair, Gauge, Link2, ShieldCheck } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { Area, Severity } from "../../../lib/architecture/rules";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { AiSparkles } from "../../common/AiGlyph";
import { buttonClass } from "../../common/Button";
import { fieldClass } from "../../common/recipes";
import { useArchAskStore } from "../ai/archAi";
import { Evidence } from "../sources/SourcesBar";
import type { ArchModel } from "../useArchModel";
import { ArchAiAction } from "./ArchAiAction";
import { Refs, panelBodyClass } from "./bits";

const SEVERITIES: Severity[] = ["critical", "warning", "suggestion", "risk"];
const TONE: Record<Severity, string> = {
  critical: "var(--cf-danger)",
  warning: "var(--cf-warning)",
  suggestion: "var(--cf-accent)",
  risk: "var(--cf-accent)",
};

export function ReviewPanel({ model }: { model: ArchModel }) {
  const t = useT();
  const { findings, comps, doc, docId } = model;
  const selection = useArchitectureViewStore((s) => s.selection);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [area, setArea] = useState<Area | "">("");
  const [scope, setScope] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const name = (id: string) => comps[id]?.name ?? id;
  const select = useArchitectureViewStore.getState;
  const selectedIds = selection?.kind === "cards" ? selection.ids : selection?.kind === "card" ? [selection.id] : [];
  const areas = [...new Set(findings.map((finding) => finding.area))]
    .sort((a, b) => t(`arch.area.${a}`).localeCompare(t(`arch.area.${b}`)));
  const inScope = findings.filter((f) => (!area || f.area === area) && (!scope.length || f.affects.some((id) => scope.includes(id))));
  const shown = inScope.filter((f) => !severity || f.severity === severity);
  const reset = () => { setScope([]); setArea(""); setSeverity(null); };

  const center = (ids: string[]) => {
    select().select(ids.length === 1 ? { kind: "card", id: ids[0] } : { kind: "cards", ids }, { reveal: true });
  };
  const runScenario = (scale: number, down: string[], ids: string[]) => {
    const view = select();
    view.setScale(scale);
    view.setDown(down);
    view.setLens("simulate");
    if (ids.length) center(ids);
  };
  const editConnection = (index: number, from: string, to: string) => {
    const view = select();
    view.select({ kind: "edge", index });
    view.setLens("diagram");
    view.setDiagramTab("inspector");
    view.focusOn([from, to]);
  };
  const prepareQuestion = (title: string, reason: string, ids: string[]) => {
    const thread = useArchAskStore.getState();
    const question = t("arch.review.aiPrompt", { title, reason });
    const affected = ids.length ? t("arch.review.aiAffected", { names: ids.map((id) => `${name(id)} (${id})`).join(", ") }) : "";
    thread.setDraft(docId, [thread.drafts[docId]?.trim(), question, affected].filter(Boolean).join("\n\n"));
    select().setLens("ask");
  };

  if (model.error) return <div className={panelBodyClass}><p role="status" className="m-0 text-[12px] text-[var(--cf-warning)]">{t("arch.parse.broken")}</p></div>;
  if (!Object.keys(comps).length && !findings.length) return (
    <div className={panelBodyClass}>
      <p className="m-0 flex items-start gap-2 rounded-lg border border-dashed border-[var(--cf-border-strong)] p-3 text-[12px] text-[var(--cf-text-muted)]">
        <ShieldCheck size={15} className="mt-0.5 shrink-0" />{t("arch.review.empty")}
      </p>
    </div>
  );

  return (
    <div className={panelBodyClass}>
      {findings.length ? (
        <section className="grid gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-[12px] font-semibold text-[var(--cf-text)]">{t("arch.review.rules")}</h3>
            <span aria-live="polite" className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">{t("arch.review.results", { n: shown.length, total: findings.length })}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("arch.review.severity")}>
            {SEVERITIES.map((level) => {
              const count = inScope.filter((f) => f.severity === level).length;
              if (!count && severity !== level) return null;
              return (
                <button key={level} type="button" aria-pressed={severity === level} onClick={() => setSeverity(severity === level ? null : level)}
                  className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--cf-border)] px-2 text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] aria-pressed:border-transparent aria-pressed:bg-[var(--cf-accent-soft)] aria-pressed:text-[var(--cf-text)]">
                  <span aria-hidden className="size-1.5 rounded-full" style={{ background: TONE[level] }} />
                  <span className="font-semibold tabular-nums">{count}</span>{t(`arch.sevPlural.${level}`, { n: count })}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label={t("arch.review.area")} value={area} onChange={(e) => setArea(e.target.value as Area | "")} className={fieldClass({ size: "sm", className: "min-w-0 max-w-full flex-1" })}>
              <option value="">{t("arch.review.allAreas")}</option>
              {areas.map((key) => <option key={key} value={key}>{t(`arch.area.${key}`)}</option>)}
            </select>
            {selectedIds.length || scope.length ? (
              <button type="button" title={scope.length ? scope.map(name).join(", ") : undefined} aria-pressed={!!scope.length} className={buttonClass({ size: "sm", variant: "ghost", className: "aria-pressed:bg-[var(--cf-accent-soft)] aria-pressed:text-[var(--cf-accent)]" })} onClick={() => { setScope(scope.length ? [] : selectedIds); setSeverity(null); }}>
                <Crosshair size={13} />{t("arch.review.selection")}
              </button>
            ) : null}
          </div>
          {scope.length ? <p className="m-0 text-[11px] text-[var(--cf-text-muted)]">{t("arch.review.focus", { name: scope.map(name).join(", ") })}</p> : null}
          {severity || area || scope.length ? <button type="button" onClick={reset} className="justify-self-start text-[11px] text-[var(--cf-accent)] hover:underline">{t("arch.review.clearFilters")}</button> : null}
        </section>
      ) : (
        <p className="m-0 flex items-center gap-1.5 text-[12px] text-[var(--cf-success)]"><CheckCircle2 size={14} />{t("arch.review.clean")}</p>
      )}
      {findings.length && !shown.length ? <p className="m-0 p-2 text-[12px] text-[var(--cf-text-muted)]">{t("arch.review.noMatches")}</p> : null}
      <div className="grid gap-1.5">
        {shown.map((f) => {
          const key = `arch.rule.${f.rule}` as const;
          const id = JSON.stringify([f.rule, f.params.id ?? "", f.affects]);
          const expanded = open === id;
          const title = t(`${key}.title` as TranslationKey, f.params);
          const reason = t(`${key}.why` as TranslationKey, f.params);
          const scale = f.rule === "notTwice" ? 2 : f.rule === "bottleneckNow" ? 1 : null;
          const fault = f.rule === "singlePoint" && model.sim.entry > 0 ? f.affects[0] : undefined;
          return (
            <article key={id} className={`rounded-lg border ${expanded ? "border-[var(--cf-border-strong)] bg-[var(--cf-surface)]" : "border-[var(--cf-border)] hover:bg-[var(--cf-hover)]"}`}>
              <button type="button" aria-expanded={expanded} className="grid w-full grid-cols-[9px_minmax(0,1fr)_auto] items-start gap-2 px-2.5 py-2 text-left" onClick={() => setOpen(expanded ? null : id)}>
                <span aria-hidden className="mt-[5px] size-2 rounded-full" style={{ background: TONE[f.severity] }} />
                <span className="grid gap-0.5">
                  <span className="text-[12.5px] font-medium leading-snug text-[var(--cf-text)]">{title}</span>
                  <span className="text-[11px] text-[var(--cf-text-muted)]">
                    <span style={{ color: TONE[f.severity] }}>{t(`arch.sev.${f.severity}`)}</span>
                    {" · "}{t(`arch.area.${f.area}`)}
                  </span>
                </span>
                <ChevronDown size={14} className={`mt-0.5 text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
              {expanded ? (
                <div className="grid gap-2 px-3 pb-3 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
                  <p className="m-0">{reason}</p>
                  <ol className="m-0 grid gap-1 pl-5 text-[var(--cf-text)]">
                    {t(`${key}.fix` as TranslationKey, f.params).split("\n").filter(Boolean).map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  <Refs ids={f.affects} comps={comps} />
                  {f.connections?.length ? (
                    <div className="grid gap-1 border-t border-[var(--cf-border)] pt-2">
                      <span className="text-[11px] font-medium">{t("arch.review.connections")}</span>
                      {f.connections.map((index) => {
                        const edge = doc.connections?.[index];
                        if (!edge) return null;
                        return (
                          <button key={index} type="button" className="flex items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-[var(--cf-text)] hover:bg-[var(--cf-hover)]" onClick={() => editConnection(index, edge.from, edge.to)}>
                            <Link2 size={13} className="mt-0.5 shrink-0" />
                            <span className="min-w-0 flex-1 break-words">{name(edge.from)} → {name(edge.to)}{edge.protocol ? ` · ${edge.protocol}` : ""}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <Evidence lines={f.affects.flatMap((id) => comps[id]?.evidence ?? [])} max={3} />
                  <div className="flex flex-wrap gap-1.5 border-t border-[var(--cf-border)] pt-2">
                    {f.affects.length ? <button type="button" className={buttonClass({ size: "sm" })} onClick={() => center(f.affects)}><Crosshair size={13} />{t("arch.review.locate")}</button> : null}
                    {scale !== null ? <button type="button" className={buttonClass({ size: "sm" })} onClick={() => runScenario(scale, [], f.affects)}><Gauge size={13} />{t("arch.review.simulateScale", { scale })}</button> : null}
                    {fault ? <button type="button" className={buttonClass({ size: "sm" })} onClick={() => runScenario(1, [fault], [fault])}><Gauge size={13} />{t("arch.review.simulateFailure", { name: name(fault) })}</button> : null}
                    <button type="button" className={buttonClass({ size: "sm", variant: "ghost" })} onClick={() => prepareQuestion(title, reason, f.affects)}><AiSparkles size={13} />{t("arch.review.ask")}</button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <ArchAiAction action="review" />
    </div>
  );
}
