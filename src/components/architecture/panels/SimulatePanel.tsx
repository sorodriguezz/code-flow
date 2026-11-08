/**
 * Simulate: traffic, capacity, failures. A calculation over the document's `sim` parameters, live
 * as the slider moves — no model involved.
 */
import { useMemo } from "react";
import { Info, Power } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import { requestErrorRate, simulate, type SimResult } from "../../../lib/architecture/sim";
import type { ArchDoc, ResolvedComponent, ResolvedComponents } from "../../../lib/architecture/types";
import { joinNames } from "../../../lib/architecture/patterns";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { Tooltip } from "../../common/Tooltip";
import { Evidence } from "../sources/SourcesBar";
import { Ref, SectionTitle, panelBodyClass } from "./bits";
import { SimOutageImpact } from "./SimOutageImpact";

const pct = (x: number) => `${x > 0 && x < 0.1 ? (x * 100).toFixed(1) : Math.round(Math.min(x, 9.99) * 100)} %`;
const times = (x: number) => `×${x.toFixed(1)}`;
const ms = (x: number) => (x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);
const rps = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)} rps`;
const PRESETS: Array<[TranslationKey, number]> = [["arch.sim.normal", 1], ["arch.sim.double", 2], ["arch.sim.peak", 3], ["arch.sim.campaign", 5]];
const queueRate = (result: SimResult) => result.backlogs.reduce((sum, b) => sum + b.rate, 0);

function parameterSource({ category, sim }: ResolvedComponent) {
  const values = category === "actor" ? [sim?.rps] : [sim?.rps, sim?.capacity, sim?.latency, sim?.replicas];
  if (!values.some((value) => typeof value === "number")) return "defaults";
  return sim?.estimated ? "estimated" : "configured";
}

function Bar({ value }: { value: number }) {
  const tone = value >= 0.85 ? "var(--cf-danger)" : value >= 0.6 ? "var(--cf-warning)" : "var(--cf-success)";
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--cf-hover)]">
      <i className="block h-full rounded-full" style={{ width: `${Math.min(100, value * 100)}%`, background: tone }} />
    </span>
  );
}

export function SimulatePanel({ doc, sim, comps }: { doc: ArchDoc; sim: SimResult; comps: ResolvedComponents }) {
  const t = useT();
  const scale = useArchitectureViewStore((s) => s.scale);
  const setScale = useArchitectureViewStore((s) => s.setScale);
  const down = useArchitectureViewStore((s) => s.down);
  const toggleDown = useArchitectureViewStore((s) => s.toggleDown);
  const setDown = useArchitectureViewStore((s) => s.setDown);
  const selection = useArchitectureViewStore((s) => s.selection);
  const name = (id: string | null) => (id ? comps[id]?.name ?? id : "");
  const inputs = useMemo(() => {
    const counts = { configured: 0, estimated: 0, defaults: 0 };
    const sources = new Map<string, ReturnType<typeof parameterSource>>();
    for (const component of Object.values(comps)) {
      const source = parameterSource(component);
      sources.set(component.id, source);
      counts[source]++;
    }
    return { counts, sources };
  }, [comps]);
  const hasOutages = down.some((id) => sim.metrics[id]?.down);
  const compare = scale !== 1 || hasOutages;
  const baseline = useMemo(() => compare ? simulate(doc, comps, 1, new Set()) : null, [compare, doc, comps]);
  const healthyAtScale = useMemo(
    () => hasOutages ? scale === 1 ? baseline : simulate(doc, comps, scale, new Set()) : null,
    [hasOutages, scale, baseline, doc, comps],
  );

  const verdictTone = sim.verdict === "fails" ? "var(--cf-danger)" : sim.verdict === "ok" ? "var(--cf-success)" : sim.verdict === "idle" ? "var(--cf-text-muted)" : "var(--cf-warning)";
  let detail = "";
  if (sim.verdict === "fails") {
    detail = sim.actorError > 0.01
      ? t("arch.sim.failsDetail", { pct: pct(sim.actorError) })
      : t("arch.sim.flowFailsDetail", { pct: pct(sim.flowError) });
  }
  else if (sim.verdict === "queues") detail = t("arch.sim.queuesDetail", { queues: joinNames(sim.backlogs.map((b) => name(b.consumer)), t("arch.and")) });
  else if (sim.firstToBreak) detail = t("arch.sim.marginDetail", { times: times(sim.breakAt) });
  else detail = t("arch.sim.idleDetail");

  const rows = Object.keys(sim.metrics)
    .filter((id) => comps[id]?.category !== "actor" && (sim.metrics[id].load > 0 || sim.metrics[id].down))
    .sort((a, b) => (sim.metrics[b].down ? 9 : sim.metrics[b].util) - (sim.metrics[a].down ? 9 : sim.metrics[a].util));
  const selected = selection?.kind === "card" && sim.metrics[selection.id] && comps[selection.id]?.category !== "actor" ? selection.id : null;
  const range = (steps: number[]) => (steps.length ? t("arch.sim.steps", { from: steps[0], to: steps[steps.length - 1] }) : "");
  const backlog = queueRate(sim);
  const syncTime = (result: SimResult) => !result.syncSteps.length ? t("arch.sim.noSteps")
    : requestErrorRate(result) >= 1 ? t("arch.sim.noResponse") : ms(result.syncMs);
  const asyncTime = (result: SimResult) => queueRate(result) > 0
    ? t("arch.sim.late")
    : result.asyncSteps.length ? ms(result.asyncMs) : t("arch.sim.noSteps");
  const queues = (rate: number) => rate > 0 ? `+${rps(rate).replace("rps", "msg/s")}` : t("arch.sim.stable");
  const bottleneck = sim.firstToBreak;

  return (
    <div className={panelBodyClass}>
      {!inputs.counts.configured && !inputs.counts.estimated ? <p className="m-0 rounded-lg border border-dashed border-[var(--cf-border-strong)] p-2.5 text-[12px] text-[var(--cf-text-muted)]">{t("arch.sim.noParams")}</p> : null}
      <label className="grid gap-1.5">
        <span className="flex items-baseline justify-between gap-2 text-[12px] text-[var(--cf-text-muted)]">
          {t("arch.sim.traffic")}
          <span className="font-medium tabular-nums text-[var(--cf-text)]">{t("arch.sim.entry", { times: times(scale), rps: rps(sim.entry) })}</span>
        </span>
        <input type="range" min={0.5} max={6} step={0.1} value={scale} onChange={(e) => setScale(Number(e.target.value))} className="w-full accent-[var(--cf-accent)]" />
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {PRESETS.map(([key, value]) => (
          <button key={key} type="button" aria-pressed={Math.abs(scale - value) < 0.01} onClick={() => setScale(value)} className="rounded-full border border-[var(--cf-border)] px-2.5 py-[2px] text-[11.5px] text-[var(--cf-text-muted)] aria-pressed:border-transparent aria-pressed:bg-[var(--cf-accent-soft)] aria-pressed:font-semibold aria-pressed:text-[var(--cf-accent)]">
            {t(key)} {times(value)}
          </button>
        ))}
        {down.length ? <button type="button" onClick={() => setDown([])} className="rounded-full border border-[var(--cf-border)] px-2.5 py-[2px] text-[11.5px] text-[var(--cf-text-muted)]">{t("arch.sim.allOn")}</button> : null}
      </div>
      <div className="grid gap-0.5 rounded-lg border p-2.5" style={{ borderColor: `color-mix(in oklab, ${verdictTone} 35%, transparent)`, background: `color-mix(in oklab, ${verdictTone} 8%, transparent)` }}>
        <b className="text-[13.5px]" style={{ color: verdictTone }}>{t(`arch.sim.verdict.${sim.verdict}` as TranslationKey)}</b>
        <span className="text-[12px] leading-[1.4] text-[var(--cf-text)]">{detail}</span>
        {bottleneck && (sim.verdict === "ok" || sim.verdict === "tight") ? (
          <span className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
            {t("arch.sim.bottleneck")} <Ref id={bottleneck} comps={comps} />
          </span>
        ) : null}
      </div>
      {healthyAtScale ? <SimOutageImpact sim={sim} healthy={healthyAtScale} comps={comps} /> : null}
      {baseline ? <p className="m-0 text-[11px] text-[var(--cf-text-muted)]">{t("arch.sim.baselineHint")}</p> : null}
      <div className="grid grid-cols-2 gap-1.5">
        {[
          [t("arch.sim.syncTime"), syncTime(sim), range(sim.syncSteps), baseline && syncTime(baseline)],
          [t("arch.sim.asyncTime"), asyncTime(sim), range(sim.asyncSteps), baseline && asyncTime(baseline)],
          [t("arch.sim.errors"), pct(requestErrorRate(sim)), t(sim.entry > 0 ? "arch.sim.errorsHint" : "arch.sim.flowErrorsHint"), baseline && pct(requestErrorRate(baseline))],
          [t("arch.sim.queues"), queues(backlog), backlog > 0 ? t("arch.sim.pendingFor", { names: joinNames(sim.backlogs.map((b) => name(b.consumer)), t("arch.and")) }) : t("arch.sim.stableHint"), baseline && queues(queueRate(baseline))],
        ].map(([label, value, hint, normal]) => (
          <div key={label} className="grid min-w-0 gap-[1px] rounded-lg border border-[var(--cf-border)] px-2 py-1.5">
            <span className="text-[10.5px] text-[var(--cf-text-faint)]">{label}</span>
            <b className="text-[16px] font-bold tabular-nums text-[var(--cf-text)]">{value}</b>
            {hint ? <span className="break-words text-[10.5px] text-[var(--cf-text-muted)]">{hint}</span> : null}
            {normal ? <span className="mt-1 border-t border-[var(--cf-border)] pt-1 text-[10.5px] text-[var(--cf-text-muted)]">{t("arch.sim.baselineValue", { value: normal })}</span> : null}
          </div>
        ))}
      </div>
      {selected ? (
        <div className="grid gap-1.5 rounded-lg border border-[var(--cf-accent)] bg-[color-mix(in_oklab,var(--cf-accent)_5%,var(--cf-surface))] p-2.5">
          <div className="flex items-center justify-between gap-2">
            <Ref id={selected} comps={comps} />
            <button type="button" onClick={() => toggleDown(selected)} className="rounded-md border border-[var(--cf-border)] px-2 py-[2px] text-[12px]">
              {sim.metrics[selected].down ? t("arch.sim.turnOn") : t("arch.sim.turnOff")}
            </button>
          </div>
          <Bar value={sim.metrics[selected].down ? 0 : sim.metrics[selected].util} />
          <div className="flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-[var(--cf-text-muted)]">
            <span>{t("arch.sim.loadOf", { load: rps(sim.metrics[selected].load), cap: rps(sim.metrics[selected].cap) })}</span>
            <span>{sim.metrics[selected].down ? t("arch.sim.off") : pct(sim.metrics[selected].util)}</span>
            <span>{ms(sim.metrics[selected].latency)}</span>
            {sim.metrics[selected].err > 0.001 ? <span className="text-[var(--cf-danger)]">{pct(sim.metrics[selected].err)} {t("arch.sim.errShort")}</span> : null}
          </div>
          {inputs.sources.get(selected) === "defaults" ? <p className="m-0 text-[11px] text-[var(--cf-text-faint)]">{t("arch.sim.defaultHint")}</p> : null}
          {inputs.sources.get(selected) === "estimated" ? <p className="m-0 text-[11px] text-[var(--cf-text-faint)]">{t("arch.sim.estimatedHint")}</p> : <Evidence lines={comps[selected]?.evidence} max={3} />}
        </div>
      ) : null}
      <SectionTitle>{t("arch.sim.components")}</SectionTitle>
      <div className="grid gap-0.5">
        {rows.map((id) => {
          const m = sim.metrics[id];
          return (
            <div key={id} className="grid h-7 grid-cols-[minmax(0,1.3fr)_minmax(40px,1fr)_48px_24px] items-center gap-2.5 rounded-md px-1 text-[11.5px] hover:bg-[var(--cf-hover)]">
              <span className="flex min-w-0 items-center gap-1"><Ref id={id} comps={comps} plain />{inputs.sources.get(id) === "estimated" ? <span className="shrink-0 text-[var(--cf-text-faint)]" title={t("arch.sim.estimatedHint")}>≈</span> : null}</span>
              <Bar value={m.down ? 0 : m.util} />
              <span className={`text-right tabular-nums ${m.down ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>{m.down ? t("arch.sim.off") : pct(m.util)}</span>
              <button
                type="button"
                aria-pressed={m.down}
                aria-label={t(m.down ? "arch.sim.turnOnNamed" : "arch.sim.turnOffNamed", { name: name(id) })}
                title={m.down ? t("arch.sim.turnOn") : t("arch.sim.powerHint")}
                onClick={() => toggleDown(id)}
                className="grid h-[22px] w-6 place-items-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-faint)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] aria-pressed:border-[var(--cf-danger)] aria-pressed:bg-[var(--cf-danger)] aria-pressed:text-white"
              >
                <Power size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--cf-border)] pt-2 text-[11.5px] text-[var(--cf-text-faint)]">
        {Object.keys(comps).length ? <span>{t("arch.sim.inputs", inputs.counts)}</span> : null}
        <Tooltip label={t("arch.sim.howTitle")} description={t("arch.sim.howItWorks")}>
          <span className="inline-flex cursor-help items-center gap-1 hover:text-[var(--cf-text-muted)]"><Info size={12} />{t("arch.sim.howTitle")}</span>
        </Tooltip>
      </div>
    </div>
  );
}
