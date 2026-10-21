/**
 * Decisions: the document's ADRs with their weighted trade-off matrix, and its risk register sorted
 * by impact × probability. Both live in the JSON, linked to the components they affect.
 */
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { ArchDoc, Decision, ResolvedComponents } from "../../../lib/architecture/types";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { buttonClass } from "../../common/Button";
import { appendTo } from "../edits";
import { Refs, panelBodyClass } from "./bits";
import { Segmented } from "../../common/Segmented";
import { ArchAiAction } from "./ArchAiAction";
import { PatternsHere } from "./PatternsHere";
import type { PatternHit } from "../../../lib/architecture/patterns";
import { Evidence } from "../sources/SourcesBar";
import { criteriaFromBrief } from "../../../lib/architecture/sources";

export function weightedTotal(d: Decision, option: NonNullable<Decision["options"]>[number]): number {
  const crit = d.criteria ?? [];
  const max = crit.reduce((a, c) => a + 5 * c.weight, 0) || 1;
  return crit.reduce((a, c) => a + (option.scores?.[c.id] ?? 0) * c.weight, 0) / max;
}

const STATUS_TONE: Record<string, string> = { accepted: "var(--cf-success)", proposed: "var(--cf-warning)", superseded: "var(--cf-text-muted)", rejected: "var(--cf-text-muted)" };
const scoreBg = (s: number) =>
  s >= 5 ? "color-mix(in oklab, var(--cf-success) 26%, transparent)" : s >= 4 ? "color-mix(in oklab, var(--cf-success) 14%, transparent)" : s >= 3 ? "color-mix(in oklab, var(--cf-warning) 16%, transparent)" : s >= 2 ? "color-mix(in oklab, var(--cf-danger) 11%, transparent)" : "color-mix(in oklab, var(--cf-danger) 22%, transparent)";

export function DecisionsPanel({ doc, comps, patterns }: { doc: ArchDoc; comps: ResolvedComponents; patterns: PatternHit[] }) {
  const t = useT();
  const select = useArchitectureViewStore((s) => s.select);
  const [tab, setTab] = useState<"decisions" | "risks">("decisions");
  const [open, setOpen] = useState<string | null>(doc.decisions?.[0]?.id ?? null);
  const decisions = doc.decisions ?? [];
  const risks = [...(doc.risks ?? [])].sort((a, b) => (b.impact ?? 0) * (b.probability ?? 0) - (a.impact ?? 0) * (a.probability ?? 0));

  const addDecision = () => {
    const n = decisions.length + 1;
    const id = `ADR-${String(n).padStart(3, "0")}`;
    // The brief's quality drivers are the criteria to weigh by, when the document has a brief.
    const drivers = criteriaFromBrief(doc.brief, (a) => t(`arch.qa.${a}` as TranslationKey));
    const criteria = drivers.length ? drivers : [{ id: "c1", name: t("arch.dec.criterion"), weight: 3 }];
    const scores = Object.fromEntries(criteria.map((c) => [c.id, 3]));
    appendTo(["decisions"], {
      id,
      title: t("arch.dec.newTitle"),
      status: "proposed",
      date: new Date().toISOString().slice(0, 10),
      affects: [],
      context: "",
      criteria,
      options: [{ name: t("arch.dec.simplest"), scores }, { name: t("arch.dec.optionB"), scores }],
    });
    setOpen(id);
  };
  const addRisk = () => appendTo(["risks"], { id: `R${risks.length + 1}`, title: t("arch.risk.newTitle"), impact: 3, probability: 3, mitigation: "", affects: [] });

  return (
    <div className={panelBodyClass}>
      <div className="flex items-center gap-1.5">
        <Segmented
          layoutId="arch-dec-tab"
          size="sm"
          value={tab}
          onChange={setTab}
          ariaLabel={t("arch.lens.decisions")}
          options={(["decisions", "risks"] as const).map((k) => ({ value: k, label: `${t(k === "decisions" ? "arch.dec.tab" : "arch.risk.tab")} ${k === "decisions" ? decisions.length : risks.length}` }))}
        />
        <span className="flex-1" />
        <button type="button" className={buttonClass({ size: "sm", variant: "ghost" })} onClick={tab === "decisions" ? addDecision : addRisk}>
          <Plus size={13} />{t(tab === "decisions" ? "arch.dec.add" : "arch.risk.add")}
        </button>
      </div>
      {tab === "decisions" ? (
        <>
          <ArchAiAction action="adr" />
          {decisions.map((d) => {
            const expanded = open === d.id;
            const crit = d.criteria ?? [];
            const options = (d.options ?? []).map((o) => ({ o, total: weightedTotal(d, o) }));
            const rec = options.find((x) => x.o.recommended) ?? [...options].sort((a, b) => b.total - a.total)[0];
            return (
              <div key={d.id} className="rounded-lg border border-[var(--cf-border)]">
                <button
                  type="button"
                  aria-expanded={expanded}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 px-2.5 py-2 text-left"
                  onClick={() => {
                    const next = expanded ? null : d.id;
                    setOpen(next);
                    const ids = (d.affects ?? []).filter((id) => comps[id]);
                    if (next && ids.length) select(ids.length === 1 ? { kind: "card", id: ids[0] } : { kind: "cards", ids });
                  }}
                >
                  <code className="text-[10.5px] text-[var(--cf-accent)]">{d.id}</code>
                  <span className="text-[12.5px] font-semibold leading-tight">{d.title}</span>
                  <span className="rounded-full px-1.5 text-[10.5px] leading-[17px]" style={{ color: STATUS_TONE[d.status ?? "proposed"], background: `color-mix(in oklab, ${STATUS_TONE[d.status ?? "proposed"]} 13%, transparent)` }}>
                    {t(`arch.decisionStatus.${d.status ?? "proposed"}` as TranslationKey)}
                  </span>
                  <ChevronDown size={14} className={`text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
                {expanded ? (
                  <div className="grid gap-2 px-2.5 pb-2.5 text-[12px] leading-[1.45] text-[var(--cf-text-muted)]">
                    {d.context ? <p className="m-0">{d.context}</p> : null}
                    {crit.length && options.length ? (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-[11.5px]">
                          <thead>
                            <tr>
                              <th className="border-b border-[var(--cf-border)] px-1.5 py-1 text-left font-semibold">{t("arch.dec.option")}</th>
                              {crit.map((c) => (
                                <th key={c.id} className="border-b border-[var(--cf-border)] px-1.5 py-1 text-center text-[10.5px] font-semibold">
                                  {c.name}<span className="block font-normal text-[var(--cf-text-faint)]">×{c.weight}</span>
                                </th>
                              ))}
                              <th className="border-b border-[var(--cf-border)] px-1.5 py-1 text-center font-semibold">{t("arch.dec.total")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {options.map(({ o, total }) => (
                              <tr key={o.name} style={o === rec?.o ? { background: "color-mix(in oklab, var(--cf-accent) 7%, transparent)" } : undefined}>
                                <td className="border-b border-[var(--cf-border)] px-1.5 py-1 text-[var(--cf-text)]">
                                  {o.name}
                                  {o === rec?.o ? <span className="block text-[10.5px] font-semibold text-[var(--cf-accent)]">{t("arch.dec.recommended")}</span> : null}
                                </td>
                                {crit.map((c) => (
                                  <td key={c.id} className="border-b border-[var(--cf-border)] px-1.5 py-1 text-center">
                                    <span className="inline-block h-5 w-5 rounded-[5px] text-center font-semibold leading-5 tabular-nums text-[var(--cf-text)]" style={{ background: scoreBg(o.scores?.[c.id] ?? 0) }}>{o.scores?.[c.id] ?? "–"}</span>
                                  </td>
                                ))}
                                <td className="border-b border-[var(--cf-border)] px-1.5 py-1 text-center font-bold tabular-nums text-[var(--cf-text)]">{Math.round(total * 100)} %</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {rec && (rec.o.pros?.length || rec.o.cons?.length) ? (
                      <div className="grid grid-cols-2 gap-2">
                        <div><h4 className="m-0 mb-0.5 text-[10.5px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("arch.dec.pros")}</h4><ul className="m-0 pl-4 text-[var(--cf-text)]">{(rec.o.pros ?? []).map((x) => <li key={x}>{x}</li>)}</ul></div>
                        <div><h4 className="m-0 mb-0.5 text-[10.5px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("arch.dec.cons")}</h4><ul className="m-0 pl-4 text-[var(--cf-text)]">{(rec.o.cons ?? []).map((x) => <li key={x}>{x}</li>)}</ul></div>
                      </div>
                    ) : null}
                    {d.consequences ? <p className="m-0"><b className="text-[var(--cf-text)]">{t("arch.dec.consequences")}</b> {d.consequences}</p> : null}
                    {d.revisitIf ? <p className="m-0"><b className="text-[var(--cf-text)]">{t("arch.dec.revisitIf")}</b> {d.revisitIf}</p> : null}
                    <Refs ids={d.affects ?? []} comps={comps} />
                    <Evidence lines={d.evidence} max={3} />
                    <p className="m-0 text-[11px] text-[var(--cf-text-faint)]">{t("arch.dec.meta", { confidence: d.confidence ?? "—", date: d.date ?? "" })}</p>
                  </div>
                ) : null}
              </div>
            );
          })}
          {!decisions.length ? <p className="m-0 text-[12px] text-[var(--cf-text-faint)]">{t("arch.dec.empty")}</p> : null}
          {/* What the drawing already does, and what each choice buys and costs — the trade-offs the
              decisions above are made against. */}
          <PatternsHere patterns={patterns} />
        </>
      ) : (
        <>
          {risks.map((r) => {
            const score = (r.impact ?? 0) * (r.probability ?? 0);
            const tone = score >= 15 ? "var(--cf-danger)" : score >= 9 ? "var(--cf-warning)" : "var(--cf-text-muted)";
            return (
              <div key={r.id} className="grid grid-cols-[30px_minmax(0,1fr)] gap-2 rounded-lg border border-[var(--cf-border)] p-2.5 text-[12px]">
                <span className="grid h-7 w-7 place-items-center rounded-md font-bold tabular-nums" style={{ background: score >= 15 ? tone : `color-mix(in oklab, ${tone} 18%, transparent)`, color: score >= 15 ? "#fff" : tone }}>{score}</span>
                <div className="grid gap-1">
                  <b className="text-[var(--cf-text)]">{r.id} · {r.title}</b>
                  <p className="m-0 leading-[1.45] text-[var(--cf-text-muted)]">{t("arch.risk.score", { impact: r.impact ?? 0, probability: r.probability ?? 0 })} {r.mitigation}</p>
                  <Refs ids={r.affects ?? []} comps={comps} />
                  <Evidence lines={r.evidence} max={2} />
                </div>
              </div>
            );
          })}
          {!risks.length ? <p className="m-0 text-[12px] text-[var(--cf-text-faint)]">{t("arch.risk.empty")}</p> : null}
        </>
      )}
    </div>
  );
}
