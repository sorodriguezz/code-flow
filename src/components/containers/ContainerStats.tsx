import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Field, Sparkline, fmtBytes, fmtPercent } from "./ui";
import { containersStats, containersUpdateLimits } from "../../lib/tauri/containersCommands";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { ContainerStats as Sample, RuntimeId } from "../../types/containers";

/**
 * «Estadísticas» — a running container's CPU, memory, network and disk as live lines (lite-dock's
 * graphs), and its limits, changed in place (`docker update`) without recreating it.
 *
 * A sample takes the engine about two seconds, so samples are chained rather than timed: the next
 * one is asked for when the last has answered, and the network and disk rates come from the real
 * time between two of them, not from the interval anyone hoped for.
 */

const HISTORY = 60;

interface Series {
  cpu: number[];
  memory: number[];
  network: number[];
  disk: number[];
}

export function ContainerStats({ runtime, context, id, running, memoryLimit, cpuLimit }: { runtime: RuntimeId; context: string | null; id: string; running: boolean; memoryLimit: number | null; cpuLimit: number | null }) {
  const t = useT();
  const [sample, setSample] = useState<Sample | null>(null);
  const [series, setSeries] = useState<Series>({ cpu: [], memory: [], network: [], disk: [] });
  const [error, setError] = useState<string | null>(null);
  const last = useRef<{ at: number; net: number; disk: number } | null>(null);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const [found] = await containersStats(runtime, context, [id]);
        if (!alive) return;
        if (found) {
          const now = performance.now();
          const net = found.netRx + found.netTx;
          const disk = found.blockRead + found.blockWrite;
          const previous = last.current;
          const seconds = previous ? Math.max(0.25, (now - previous.at) / 1000) : 0;
          last.current = { at: now, net, disk };
          setSample(found);
          setError(null);
          setSeries((s) => ({
            cpu: [...s.cpu, found.cpuPercent].slice(-HISTORY),
            memory: [...s.memory, found.memUsage].slice(-HISTORY),
            network: previous ? [...s.network, Math.max(0, net - previous.net) / seconds].slice(-HISTORY) : s.network,
            disk: previous ? [...s.disk, Math.max(0, disk - previous.disk) / seconds].slice(-HISTORY) : s.disk,
          }));
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
      if (alive) timer = setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runtime, context, id, running]);

  if (!running) return <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("containers.notRunningContainer")}</p>;
  const latest = (values: number[]) => (values.length ? values[values.length - 1] : 0);
  const cores = Math.max(100, ...series.cpu);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {error && !sample && <p className="pb-2 text-[12px] text-[var(--cf-danger)]">{error}</p>}
      {!sample && !error && (
        <div className="flex items-center gap-2 p-2 text-[12px] text-[var(--cf-text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          {t("containers.m.stats.sampling")}
        </div>
      )}
      {sample && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
          <Graph title="CPU" value={fmtPercent(sample.cpuPercent)} sub={t("containers.m.stats.cpuSub")}>
            <Sparkline values={series.cpu} max={cores} color="var(--cf-accent)" />
          </Graph>
          <Graph
            title={t("containers.stat.memory")}
            value={fmtBytes(sample.memUsage)}
            sub={sample.memLimit ? t("containers.m.stats.ofLimit", { limit: fmtBytes(sample.memLimit), percent: fmtPercent(sample.memPercent) }) : undefined}
          >
            <Sparkline values={series.memory} color="var(--cf-success)" />
          </Graph>
          <Graph title={t("containers.stat.network")} value={`${fmtBytes(latest(series.network))}/s`} sub={t("containers.m.stats.totals", { a: fmtBytes(sample.netRx), b: fmtBytes(sample.netTx) })}>
            <Sparkline values={series.network} color="var(--cf-warning)" />
          </Graph>
          <Graph title={t("containers.stat.disk")} value={`${fmtBytes(latest(series.disk))}/s`} sub={t("containers.m.stats.diskTotals", { a: fmtBytes(sample.blockRead), b: fmtBytes(sample.blockWrite) })}>
            <Sparkline values={series.disk} color="#a78bfa" />
          </Graph>
        </div>
      )}
      {sample?.pids !== null && sample?.pids !== undefined && (
        <p className="pt-2 text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.m.stats.processes", { count: sample.pids })}</p>
      )}
      <Limits runtime={runtime} context={context} id={id} memoryLimit={memoryLimit} cpuLimit={cpuLimit} />
    </div>
  );
}

function Graph({ title, value, sub, children }: { title: string; value: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-[var(--cf-border)] px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-[var(--cf-text-muted)]">{title}</span>
        <span className="ml-auto font-mono text-[13px] font-medium tabular-nums text-[var(--cf-text)]">{value}</span>
      </div>
      {children}
      {sub && <span className="truncate text-[11px] text-[var(--cf-text-faint)]">{sub}</span>}
    </div>
  );
}

/** Memory (MB) and CPUs, applied to the running container — empty leaves one as it is. */
function Limits({ runtime, context, id, memoryLimit, cpuLimit }: { runtime: RuntimeId; context: string | null; id: string; memoryLimit: number | null; cpuLimit: number | null }) {
  const t = useT();
  const [memory, setMemory] = useState(memoryLimit ? String(Math.round(memoryLimit / (1024 * 1024))) : "");
  const [cpus, setCpus] = useState(cpuLimit ? String(cpuLimit).replace(".", ",") : "");
  const [saving, setSaving] = useState(false);
  const parse = (raw: string): number | null | "bad" => {
    const text = raw.trim().replace(",", ".");
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : "bad";
  };
  const apply = async () => {
    const mem = parse(memory);
    const cpu = parse(cpus);
    if (mem === "bad" || cpu === "bad") {
      pushErrorToast(t("containers.m.stats.badLimit"));
      return;
    }
    if (mem === null && cpu === null) return;
    setSaving(true);
    try {
      await containersUpdateLimits(runtime, context, id, mem, cpu);
      pushSuccessToast(t("containers.m.stats.limitsApplied"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-4 border-t border-[var(--cf-border)] pt-3">
      <h4 className="pb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("containers.m.stats.limits")}</h4>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("containers.m.run.memory")} className="w-[140px]">
          <input value={memory} onChange={(e) => setMemory(e.target.value)} placeholder={t("containers.m.stats.unlimited")} inputMode="numeric" className={fieldClass({ size: "sm", className: "w-full" })} />
        </Field>
        <Field label={t("containers.m.run.cpus")} className="w-[140px]">
          <input value={cpus} onChange={(e) => setCpus(e.target.value)} placeholder={t("containers.m.stats.unlimited")} inputMode="decimal" className={fieldClass({ size: "sm", className: "w-full" })} />
        </Field>
        <Button size="sm" variant="secondary" onClick={() => void apply()} disabled={saving}>
          {saving && <Loader2 size={12} className="animate-spin" />}
          {t("containers.m.stats.apply")}
        </Button>
      </div>
      <p className="pt-1.5 text-[11px] text-[var(--cf-text-faint)]">{t("containers.m.stats.limitsHint")}</p>
    </div>
  );
}
