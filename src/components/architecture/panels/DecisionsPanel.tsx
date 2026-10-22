/**
 * Decisions: the document's ADRs with their weighted trade-off matrix, and its risk register sorted
 * by impact × probability. Both live in the document, linked to the components they affect, and both
 * are edited here — an entry opens into its own form (user report, 2026-10-21: «si agrego no puedo
 * editar ni nada»), since the JSON they live in is never on screen.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Trash2, X } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { ArchDoc, Decision, DecisionStatus, ResolvedComponents, Risk } from "../../../lib/architecture/types";
import { chosenOption, nextId, weightedTotal } from "../../../lib/architecture/decisions";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { confirmAction } from "../../../state/confirmStore";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { fieldClass } from "../../common/recipes";
import { Tooltip } from "../../common/Tooltip";
import { appendTo, mutate, setValue } from "../edits";
import { Field, Ref, SectionTitle, panelBodyClass } from "./bits";
import { Segmented } from "../../common/Segmented";
import { ArchAiAction } from "./ArchAiAction";
import { PatternsHere } from "./PatternsHere";
import type { PatternHit } from "../../../lib/architecture/patterns";
import { Evidence } from "../sources/SourcesBar";
import { criteriaFromBrief } from "../../../lib/architecture/sources";

const STATUSES: DecisionStatus[] = ["proposed", "accepted", "superseded", "rejected"];
const SCALE = [1, 2, 3, 4, 5];
const STATUS_TONE: Record<string, string> = { accepted: "var(--cf-success)", proposed: "var(--cf-warning)", superseded: "var(--cf-text-muted)", rejected: "var(--cf-text-muted)" };
const scoreBg = (s: number) =>
  s >= 5 ? "color-mix(in oklab, var(--cf-success) 26%, transparent)" : s >= 4 ? "color-mix(in oklab, var(--cf-success) 14%, transparent)" : s >= 3 ? "color-mix(in oklab, var(--cf-warning) 16%, transparent)" : s >= 2 ? "color-mix(in oklab, var(--cf-danger) 11%, transparent)" : "color-mix(in oklab, var(--cf-danger) 22%, transparent)";
const labelClass = "grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]";
const selectClass = fieldClass({ size: "sm", className: "w-full" });

/** A structural change to one decision (options, criteria, the chosen one), as a whole new document. */
function changeDecision(index: number, fn: (d: Decision) => Decision) {
  mutate((doc) => ({ ...doc, decisions: (doc.decisions ?? []).map((d, i) => (i === index ? fn(d) : d)) }));
}

/** `{ ...o, recommended: undefined }` would be written as `null`: the key goes instead. */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

export function DecisionsPanel({ doc, comps, patterns }: { doc: ArchDoc; comps: ResolvedComponents; patterns: PatternHit[] }) {
  const t = useT();
  const select = useArchitectureViewStore((s) => s.select);
  const [tab, setTab] = useState<"decisions" | "risks">("decisions");
  const [open, setOpen] = useState<string | null>(doc.decisions?.[0]?.id ?? null);
  const [openRisk, setOpenRisk] = useState<string | null>(null);
  const decisions = doc.decisions ?? [];
  const risks = [...(doc.risks ?? [])].sort((a, b) => (b.impact ?? 0) * (b.probability ?? 0) - (a.impact ?? 0) * (a.probability ?? 0));

  const addDecision = () => {
    const id = nextId("ADR-", decisions.map((d) => d.id), 3);
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
  const addRisk = () => {
    const id = nextId("R", (doc.risks ?? []).map((r) => r.id));
    appendTo(["risks"], { id, title: t("arch.risk.newTitle"), impact: 3, probability: 3, mitigation: "", affects: [] });
    setOpenRisk(id);
  };

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
          {decisions.map((d, index) => {
            const expanded = open === d.id;
            const status = d.status ?? "proposed";
            return (
              <div key={`${d.id}-${index}`} className="rounded-lg border border-[var(--cf-border)]">
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
                  <span className="truncate text-[12.5px] font-semibold leading-tight">{d.title}</span>
                  <span className="rounded-full px-1.5 text-[10.5px] leading-[17px]" style={{ color: STATUS_TONE[status], background: `color-mix(in oklab, ${STATUS_TONE[status]} 13%, transparent)` }}>
                    {t(`arch.decisionStatus.${status}` as TranslationKey)}
                  </span>
                  <ChevronDown size={14} className={`text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
                {expanded ? <DecisionForm d={d} index={index} comps={comps} /> : null}
              </div>
            );
          })}
          {!decisions.length ? <p className="m-0 text-[12px] leading-[1.45] text-[var(--cf-text-faint)]">{t("arch.dec.empty")}</p> : null}
          {/* What the drawing already does, and what each choice buys and costs — the trade-offs the
              decisions above are made against. */}
          <PatternsHere patterns={patterns} />
        </>
      ) : (
        <>
          {risks.map((r) => (
            <RiskCard
              key={r.id}
              risk={r}
              index={(doc.risks ?? []).indexOf(r)}
              comps={comps}
              expanded={openRisk === r.id}
              onToggle={() => setOpenRisk(openRisk === r.id ? null : r.id)}
            />
          ))}
          {!risks.length ? <p className="m-0 text-[12px] leading-[1.45] text-[var(--cf-text-faint)]">{t("arch.risk.empty")}</p> : null}
        </>
      )}
    </div>
  );
}

/** One decision, open: what it is about, its options scored against its criteria, what follows. */
function DecisionForm({ d, index, comps }: { d: Decision; index: number; comps: ResolvedComponents }) {
  const t = useT();
  const at = (...rest: Array<string | number>) => ["decisions", index, ...rest];
  const crit = d.criteria ?? [];
  const options = d.options ?? [];
  const chosen = chosenOption(d);

  const addCriterion = () =>
    changeDecision(index, (x) => {
      const id = nextId("c", (x.criteria ?? []).map((c) => c.id));
      return {
        ...x,
        criteria: [...(x.criteria ?? []), { id, name: `${t("arch.dec.criterion")} ${(x.criteria ?? []).length + 1}`, weight: 3 }],
        options: (x.options ?? []).map((o) => ({ ...o, scores: { ...o.scores, [id]: 3 } })),
      };
    });
  const removeCriterion = (id: string) =>
    changeDecision(index, (x) => ({
      ...x,
      criteria: (x.criteria ?? []).filter((c) => c.id !== id),
      options: (x.options ?? []).map((o) => ({ ...o, scores: without(o.scores ?? {}, id) })),
    }));
  const addOption = () =>
    changeDecision(index, (x) => ({
      ...x,
      options: [...(x.options ?? []), { name: `${t("arch.dec.option")} ${(x.options ?? []).length + 1}`, scores: Object.fromEntries((x.criteria ?? []).map((c) => [c.id, 3])) }],
    }));
  const removeOption = (j: number) => changeDecision(index, (x) => ({ ...x, options: (x.options ?? []).filter((_, k) => k !== j) }));
  // Marking the one already marked unmarks it: the best total decides again.
  const choose = (j: number) =>
    changeDecision(index, (x) => ({
      ...x,
      options: (x.options ?? []).map((o, k) => (k === j && !o.recommended ? { ...o, recommended: true } : without(o, "recommended"))),
    }));
  const remove = () =>
    void confirmAction(t("arch.dec.removeConfirm", { id: d.id })).then((ok) => {
      if (ok) mutate((doc) => ({ ...doc, decisions: (doc.decisions ?? []).filter((_, i) => i !== index) }));
    });

  return (
    <div className="grid gap-2.5 border-t border-[var(--cf-border)] px-2.5 pb-2.5 pt-2.5 text-[12px] leading-[1.45] text-[var(--cf-text-muted)]">
      <Field label={t("arch.insp.title")} value={d.title} onCommit={(v) => setValue(at("title"), v || t("arch.dec.newTitle"))} />
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          {t("arch.dec.status")}
          <select value={d.status ?? "proposed"} onChange={(e) => setValue(at("status"), e.target.value)} className={selectClass}>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`arch.decisionStatus.${s}` as TranslationKey)}</option>)}
          </select>
        </label>
        <Field label={t("arch.dec.date")} type="date" value={d.date ?? ""} onCommit={(v) => setValue(at("date"), v)} />
      </div>
      <Field label={t("arch.dec.context")} multiline placeholder={t("arch.dec.contextHint")} value={d.context ?? ""} onCommit={(v) => setValue(at("context"), v)} />

      <SectionTitle aside={<span className="normal-case tracking-normal">{t("arch.dec.scoreHint")}</span>}>{t("arch.dec.options")}</SectionTitle>
      {crit.length && options.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                <th className="border-b border-[var(--cf-border)] px-1 py-1 text-left font-semibold">{t("arch.dec.option")}</th>
                {crit.map((c) => (
                  <th key={c.id} className="max-w-[90px] border-b border-[var(--cf-border)] px-1 py-1 text-center text-[10.5px] font-semibold">
                    <span className="block truncate">{c.name}</span><span className="block font-normal text-[var(--cf-text-faint)]">×{c.weight}</span>
                  </th>
                ))}
                <th className="border-b border-[var(--cf-border)] px-1 py-1 text-center font-semibold">{t("arch.dec.total")}</th>
                <th className="border-b border-[var(--cf-border)]" />
              </tr>
            </thead>
            <tbody>
              {options.map((o, j) => {
                const isChosen = chosen?.index === j;
                return (
                  <tr key={j} style={isChosen ? { background: "color-mix(in oklab, var(--cf-accent) 7%, transparent)" } : undefined}>
                    <td className="min-w-[110px] border-b border-[var(--cf-border)] px-1 py-1 text-[var(--cf-text)]">
                      <InlineText value={o.name} label={t("arch.dec.option")} onCommit={(v) => setValue(at("options", j, "name"), v || `${t("arch.dec.option")} ${j + 1}`)} />
                      {isChosen ? <span className="block px-1 text-[10.5px] font-semibold text-[var(--cf-accent)]">{t(chosen.byHand ? "arch.dec.chosen" : "arch.dec.recommended")}</span> : null}
                    </td>
                    {crit.map((c) => (
                      <td key={c.id} className="border-b border-[var(--cf-border)] px-1 py-1 text-center">
                        <ScoreSelect value={o.scores?.[c.id]} label={`${o.name} · ${c.name}`} onChange={(n) => setValue(at("options", j, "scores", c.id), n)} />
                      </td>
                    ))}
                    <td className="whitespace-nowrap border-b border-[var(--cf-border)] px-1 py-1 text-center font-bold tabular-nums text-[var(--cf-text)]">{Math.round(weightedTotal(d, o) * 100)} %</td>
                    <td className="whitespace-nowrap border-b border-[var(--cf-border)] px-0.5 py-1 text-right">
                      <Tooltip label={t(o.recommended ? "arch.dec.unchoose" : "arch.dec.choose")}>
                        <button type="button" aria-pressed={!!o.recommended} aria-label={t(o.recommended ? "arch.dec.unchoose" : "arch.dec.choose")} className={iconButtonClass({ size: "xs", active: !!o.recommended })} onClick={() => choose(j)}>
                          <Check size={12} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t("arch.dec.removeOption")}>
                        <button type="button" aria-label={t("arch.dec.removeOption")} className={iconButtonClass({ size: "xs" })} onClick={() => removeOption(j)}>
                          <X size={12} />
                        </button>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {crit.length ? (
        <div className="grid gap-1">
          <span className="text-[11px] font-medium">{t("arch.dec.criteria")}</span>
          {crit.map((c, k) => (
            <div key={c.id} className="grid grid-cols-[minmax(0,1fr)_64px_auto] items-center gap-1.5">
              <InlineText bordered value={c.name} label={t("arch.dec.criterion")} onCommit={(v) => setValue(at("criteria", k, "name"), v || `${t("arch.dec.criterion")} ${k + 1}`)} />
              <select value={c.weight} aria-label={t("arch.dec.weight")} title={t("arch.dec.weight")} onChange={(e) => setValue(at("criteria", k, "weight"), Number(e.target.value))} className={selectClass}>
                {SCALE.map((n) => <option key={n} value={n}>×{n}</option>)}
              </select>
              <Tooltip label={t("arch.dec.removeCriterion")}>
                <button type="button" aria-label={t("arch.dec.removeCriterion")} className={iconButtonClass({ size: "xs" })} onClick={() => removeCriterion(c.id)}>
                  <X size={12} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <button type="button" className={buttonClass({ size: "sm", variant: "ghost" })} onClick={addOption}><Plus size={13} />{t("arch.dec.addOption")}</button>
        <button type="button" className={buttonClass({ size: "sm", variant: "ghost" })} onClick={addCriterion}><Plus size={13} />{t("arch.dec.addCriterion")}</button>
      </div>

      {chosen ? (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label={t("arch.dec.prosOf", { name: chosen.option.name })}
            multiline
            placeholder={t("arch.dec.onePerLine")}
            value={(chosen.option.pros ?? []).join("\n")}
            onCommit={(v) => setValue(at("options", chosen.index, "pros"), lines(v))}
          />
          <Field
            label={t("arch.dec.consOf", { name: chosen.option.name })}
            multiline
            placeholder={t("arch.dec.onePerLine")}
            value={(chosen.option.cons ?? []).join("\n")}
            onCommit={(v) => setValue(at("options", chosen.index, "cons"), lines(v))}
          />
        </div>
      ) : null}
      <Field label={t("arch.dec.consequencesLabel")} multiline value={d.consequences ?? ""} onCommit={(v) => setValue(at("consequences"), v)} />
      <Field label={t("arch.dec.revisitLabel")} multiline value={d.revisitIf ?? ""} onCommit={(v) => setValue(at("revisitIf"), v)} />
      <Affects ids={d.affects ?? []} comps={comps} onChange={(ids) => setValue(at("affects"), ids)} />
      <Evidence lines={d.evidence} max={3} />
      {d.confidence != null ? <p className="m-0 text-[11px] text-[var(--cf-text-faint)]">{t("arch.dec.confidence", { confidence: d.confidence })}</p> : null}
      <button type="button" className={buttonClass({ size: "sm", variant: "danger-ghost", className: "justify-self-start" })} onClick={remove}>
        <Trash2 size={13} />{t("arch.dec.remove")}
      </button>
    </div>
  );
}

/** One risk: its score and line when folded, its form when open. */
function RiskCard({ risk: r, index, comps, expanded, onToggle }: { risk: Risk; index: number; comps: ResolvedComponents; expanded: boolean; onToggle: () => void }) {
  const t = useT();
  const at = (...rest: Array<string | number>) => ["risks", index, ...rest];
  const score = (r.impact ?? 0) * (r.probability ?? 0);
  const tone = score >= 15 ? "var(--cf-danger)" : score >= 9 ? "var(--cf-warning)" : "var(--cf-text-muted)";
  const remove = () =>
    void confirmAction(t("arch.risk.removeConfirm", { id: r.id })).then((ok) => {
      if (ok) mutate((doc) => ({ ...doc, risks: (doc.risks ?? []).filter((_, i) => i !== index) }));
    });
  return (
    <div className="rounded-lg border border-[var(--cf-border)] text-[12px]">
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2 p-2.5 text-left">
        <span className="grid h-7 w-7 place-items-center rounded-md font-bold tabular-nums" style={{ background: score >= 15 ? tone : `color-mix(in oklab, ${tone} 18%, transparent)`, color: score >= 15 ? "#fff" : tone }}>{score}</span>
        <span className="grid min-w-0 gap-0.5">
          <b className="truncate text-[var(--cf-text)]">{r.id} · {r.title}</b>
          <span className="truncate leading-[1.45] text-[var(--cf-text-muted)]">{t("arch.risk.score", { impact: r.impact ?? 0, probability: r.probability ?? 0 })} {r.mitigation}</span>
        </span>
        <ChevronDown size={14} className={`text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded ? (
        <div className="grid gap-2.5 border-t border-[var(--cf-border)] p-2.5 text-[var(--cf-text-muted)]">
          <Field label={t("arch.insp.title")} value={r.title} onCommit={(v) => setValue(at("title"), v || t("arch.risk.newTitle"))} />
          <div className="grid grid-cols-2 gap-2">
            {(["impact", "probability"] as const).map((key) => (
              <label key={key} className={labelClass}>
                {t(key === "impact" ? "arch.risk.impact" : "arch.risk.probability")}
                <select value={r[key] ?? 3} onChange={(e) => setValue(at(key), Number(e.target.value))} className={selectClass}>
                  {SCALE.map((n) => <option key={n} value={n}>{n} · {t(`arch.risk.level${n}` as TranslationKey)}</option>)}
                </select>
              </label>
            ))}
          </div>
          <Field label={t("arch.risk.mitigation")} multiline placeholder={t("arch.risk.mitigationHint")} value={r.mitigation ?? ""} onCommit={(v) => setValue(at("mitigation"), v)} />
          <Affects ids={r.affects ?? []} comps={comps} onChange={(ids) => setValue(at("affects"), ids)} />
          <Evidence lines={r.evidence} max={2} />
          <button type="button" className={buttonClass({ size: "sm", variant: "danger-ghost", className: "justify-self-start" })} onClick={remove}>
            <Trash2 size={13} />{t("arch.risk.remove")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The components an entry is about: chips that light the card up, each removable, and one to add. */
function Affects({ ids, comps, onChange }: { ids: string[]; comps: ResolvedComponents; onChange: (ids: string[]) => void }) {
  const t = useT();
  const shown = ids.filter((id) => comps[id]);
  const addable = Object.entries(comps).filter(([id]) => !ids.includes(id));
  return (
    <div className={labelClass}>
      {t("arch.dec.affects")}
      {shown.length ? (
        <div className="flex flex-wrap gap-1">
          {shown.map((id) => (
            <span key={id} className="inline-flex items-center">
              <Ref id={id} comps={comps} />
              <button type="button" aria-label={t("arch.dec.removeAffected", { name: comps[id]?.name ?? id })} className={iconButtonClass({ size: "xs" })} onClick={() => onChange(ids.filter((x) => x !== id))}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {addable.length ? (
        <select value="" onChange={(e) => e.target.value && onChange([...ids, e.target.value])} className={selectClass} aria-label={t("arch.dec.addAffected")}>
          <option value="">{t("arch.dec.addAffected")}</option>
          {addable.map(([id, c]) => <option key={id} value={id}>{c.name ?? id}</option>)}
        </select>
      ) : null}
    </div>
  );
}

/** A 1–5 score in the matrix, coloured by how good it is; a native list to pick from. */
function ScoreSelect({ value, label, onChange }: { value: number | undefined; label: string; onChange: (n: number) => void }) {
  return (
    <select
      value={value ?? ""}
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-6 w-7 cursor-pointer appearance-none rounded-[5px] border-0 text-center text-[11.5px] font-semibold tabular-nums text-[var(--cf-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]"
      style={{ background: scoreBg(value ?? 0), textAlignLast: "center" }}
    >
      {value == null ? <option value="">–</option> : null}
      {SCALE.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}

/** A name edited in place — an option's, a criterion's — committing as it is typed, like `Field`. */
function InlineText({ value, label, bordered = false, onCommit }: { value: string; label: string; bordered?: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  return (
    <input
      value={draft}
      aria-label={label}
      onFocus={() => { editing.current = true; }}
      onBlur={() => { editing.current = false; setDraft(value); }}
      onChange={(e) => { setDraft(e.target.value); onCommit(e.target.value); }}
      className={bordered
        ? fieldClass({ size: "sm", className: "w-full" })
        : "h-6 w-full min-w-0 rounded-[5px] border border-transparent bg-transparent px-1 text-[12px] text-[var(--cf-text)] outline-none hover:border-[var(--cf-border)] focus:border-[var(--cf-accent)] focus:bg-[var(--cf-field)]"}
    />
  );
}

/** «a\n\n b » → `["a", "b"]`; nothing → `undefined`, which drops the key. */
function lines(text: string): string[] | undefined {
  const out = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return out.length ? out : undefined;
}
