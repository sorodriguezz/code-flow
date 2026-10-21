/**
 * Simulate: traffic, capacity, failures. A calculation over the document's `sim` parameters, live
 * as the slider moves — no model involved.
 */
import { Info, Power } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { SimResult } from "../../../lib/architecture/sim";
import type { ResolvedComponents } from "../../../lib/architecture/types";
import { joinNames } from "../../../lib/architecture/patterns";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { Tooltip } from "../../common/Tooltip";
import { Evidence } from "../sources/SourcesBar";
import { Ref, SectionTitle, panelBodyClass } from "./bits";

const pct = (x: number) => `${x > 0 && x < 0.1 ? (x * 100).toFixed(1) : Math.round(Math.min(x, 9.99) * 100)} %`;
const times = (x: number) => `×${x.toFixed(1)}`;
const ms = (x: number) => (x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);
const rps = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)} rps`;
const PRESETS: Array<[TranslationKey, number]> = [["arch.sim.normal", 1], ["arch.sim.peak", 3], ["arch.sim.campaign", 5]];

function Bar({ value }: { value: number }) {
  const tone = value >= 0.85 ? "var(--cf-danger)" : value >= 0.6 ? "var(--cf-warning)" : "var(--cf-success)";
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--cf-hover)]">
      <i className="block h-full rounded-full" style={{ width: `${Math.min(100, value * 100)}%`, background: tone }} />
    </span>
  );
}

export function SimulatePanel({ sim, comps }: { sim: SimResult; comps: ResolvedComponents }) {
  const t = useT();
  const scale = useArchitectureViewStore((s) => s.scale);
  const setScale = useArchitectureViewStore((s) => s.setScale);
  const down = useArchitectureViewStore((s) => s.down);
  const toggleDown = useArchitectureViewStore((s) => s.toggleDown);
  const setDown = useArchitectureViewStore((s) => s.setDown);
  const selection = useArchitectureViewStore((s) => s.selection);
  const name = (id: string | null) => (id ? comps[id]?.name ?? id : "");
  const hasSim = Object.values(comps).some((c) => c.sim);
  const withSim = Object.values(comps).filter((c) => c.sim);
  const estimated = withSim.filter((c) => c.sim?.estimated).length;

  const verdictTone = sim.verdict === "fails" ? "var(--cf-danger)" : sim.verdict === "ok" ? "var(--cf-success)" : sim.verdict === "idle" ? "var(--cf-text-muted)" : "var(--cf-warning)";
  let detail = "";
  if (sim.verdict === "fails") detail = t("arch.sim.failsDetail", { pct: pct(Math.max(sim.flowError, sim.actorError)) });
  else if (sim.verdict === "queues") detail = t("arch.sim.queuesDetail", { queues: joinNames(sim.backlogs.map((b) => name(b.queue)), t("arch.and")) });
  else if (sim.firstToBreak) detail = t("arch.sim.marginDetail", { times: times(sim.breakAt), name: name(sim.firstToBreak) });
  else detail = t("arch.sim.idleDetail");

  const rows = Object.keys(sim.metrics)
    .filter((id) => comps[id]?.category !== "actor" && (sim.metrics[id].load > 0 || sim.metrics[id].down))
    .sort((a, b) => (sim.metrics[b].down ? 9 : sim.metrics[b].util) - (sim.metrics[a].down ? 9 : sim.metrics[a].util));
  const selected = selection?.kind === "card" && sim.metrics[selection.id] && comps[selection.id]?.category !== "actor" ? selection.id : null;
  const range = (steps: number[]) => (steps.length ? t("arch.sim.steps", { from: steps[0], to: steps[steps.length - 1] }) : "");
  const backlog = sim.backlogs.reduce((a, b) => a + b.rate, 0);

  return (
    <div className={panelBodyClass}>
      {!hasSim ? <p className="m-0 rounded-lg border border-dashed border-[var(--cf-border-strong)] p-2.5 text-[12px] text-[var(--cf-text-muted)]">{t("arch.sim.noParams")}</p> : null}
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
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {[
          [t("arch.sim.syncTime"), ms(sim.syncMs), range(sim.syncSteps)],
          [t("arch.sim.asyncTime"), backlog > 0 ? t("arch.sim.late") : ms(sim.asyncMs), range(sim.asyncSteps)],
          [t("arch.sim.errors"), pct(sim.flowError), t("arch.sim.errorsHint")],
          [t("arch.sim.queues"), backlog > 0 ? `+${rps(backlog).replace("rps", "msg/s")}` : t("arch.sim.stable"), backlog > 0 ? joinNames(sim.backlogs.map((b) => name(b.queue)), t("arch.and")) : t("arch.sim.stableHint")],
        ].map(([label, value, hint]) => (
          <div key={label} className="grid min-w-0 gap-[1px] rounded-lg border border-[var(--cf-border)] px-2 py-1.5">
            <span className="text-[10.5px] text-[var(--cf-text-faint)]">{label}</span>
            <b className="text-[16px] font-bold tabular-nums text-[var(--cf-text)]">{value}</b>
            <span className="truncate text-[10.5px] text-[var(--cf-text-muted)]">{hint}</span>
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
          {comps[selected]?.sim?.estimated ? <p className="m-0 text-[11px] text-[var(--cf-text-faint)]">{t("arch.sim.estimatedHint")}</p> : <Evidence lines={comps[selected]?.evidence} max={3} />}
        </div>
      ) : null}
      <SectionTitle>{t("arch.sim.components")}</SectionTitle>
      <div className="grid gap-0.5">
        {rows.map((id) => {
          const m = sim.metrics[id];
          return (
            <div key={id} className="grid h-7 grid-cols-[minmax(0,1.3fr)_minmax(40px,1fr)_48px_24px] items-center gap-2.5 rounded-md px-1 text-[11.5px] hover:bg-[var(--cf-hover)]">
              <span className="flex min-w-0 items-center gap-1"><Ref id={id} comps={comps} plain />{comps[id]?.sim?.estimated ? <span className="shrink-0 text-[var(--cf-text-faint)]" title={t("arch.sim.estimatedHint")}>≈</span> : null}</span>
              <Bar value={m.down ? 0 : m.util} />
              <span className={`text-right tabular-nums ${m.down ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>{m.down ? t("arch.sim.off") : pct(m.util)}</span>
              <button
                type="button"
                aria-pressed={m.down}
                title={m.down ? t("arch.sim.turnOn") : `${t("arch.sim.turnOff")} — ${t("arch.sim.powerHint")}`}
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
        {withSim.length ? (
          <span title={t("arch.sim.estimatedHint")}>
            {estimated ? t("arch.sim.provenance", { read: withSim.length - estimated, estimated }) : t("arch.sim.allRead", { n: withSim.length })}
          </span>
        ) : null}
        <Tooltip label={t("arch.sim.howTitle")} description={t("arch.sim.howItWorks")}>
          <span className="inline-flex cursor-help items-center gap-1 hover:text-[var(--cf-text-muted)]"><Info size={12} />{t("arch.sim.howTitle")}</span>
        </Tooltip>
      </div>
    </div>
  );
}
