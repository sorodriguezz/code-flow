import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Field, Sparkline, fmtPercent } from "./ui";
import { fmtBinaryBytes as fmtBytes } from "./format";
import { containersStats, containersUpdateLimits } from "../../lib/tauri/containersCommands";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { ContainerStats as Sample, RuntimeId } from "../../types/containers";

/**
 * «Estadísticas» — a running container's CPU, memory, network and disk as live graphs with their
 * scale (lite-dock's), and its limits, changed in place (`docker update`) without recreating it.
 *
 * A sample takes the engine about two seconds, so samples are chained rather than timed: the next
 * one is asked for when the last has answered, and the network and disk rates come from the real
 * time between two of them, not from the interval anyone hoped for. The counters behind those
 * rates are exact (`manage::exact_counters`), never `docker stats`' rounded "2.8MB" — two of those
 * a sample apart mostly differ by nothing, which read as a steady 0 B/s.
 *
 * Sizes are in powers of 1024 (`fmtBinaryBytes`), as Docker Desktop and other clients draw them.
 */

const HISTORY = 60;

interface Series {
  /** `performance.now()` of each sample — the window the graphs span. */
  at: number[];
  cpu: number[];
  memory: number[];
  rx: number[];
  tx: number[];
  network: number[];
  disk: number[];
}

const EMPTY: Series = { at: [], cpu: [], memory: [], rx: [], tx: [], network: [], disk: [] };

export function ContainerStats({ runtime, context, id, running, memoryLimit, cpuLimit }: { runtime: RuntimeId; context: string | null; id: string; running: boolean; memoryLimit: number | null; cpuLimit: number | null }) {
  const t = useT();
  const [sample, setSample] = useState<Sample | null>(null);
  const [series, setSeries] = useState<Series>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const last = useRef<{ at: number; rx: number; tx: number; disk: number } | null>(null);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // `docker stats` every second and a half is for a window someone is looking at; hidden, the
      // loop only waits, and the next sample after it shows again measures from the last one.
      if (document.visibilityState !== "visible") {
        if (alive) timer = setTimeout(() => void tick(), 1500);
        return;
      }
      try {
        const [found] = await containersStats(runtime, context, [id]);
        if (!alive) return;
        if (found) {
          const now = performance.now();
          const disk = found.blockRead + found.blockWrite;
          const previous = last.current;
          const seconds = previous ? Math.max(0.25, (now - previous.at) / 1000) : 0;
          last.current = { at: now, rx: found.netRx, tx: found.netTx, disk };
          const rate = (now: number, before: number) => Math.max(0, now - before) / seconds;
          setSample(found);
          setError(null);
          setSeries((s) => {
            const push = (values: number[], value: number) => [...values, value].slice(-HISTORY);
            const rx = previous ? rate(found.netRx, previous.rx) : null;
            const tx = previous ? rate(found.netTx, previous.tx) : null;
            return {
              at: push(s.at, now),
              cpu: push(s.cpu, found.cpuPercent),
              memory: push(s.memory, found.memUsage),
              rx: rx === null ? s.rx : push(s.rx, rx),
              tx: tx === null ? s.tx : push(s.tx, tx),
              network: rx === null || tx === null ? s.network : push(s.network, rx + tx),
              disk: previous ? push(s.disk, rate(disk, previous.disk)) : s.disk,
            };
          });
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
  const span = series.at.length > 1 ? Math.round((series.at[series.at.length - 1] - series.at[0]) / 1000) : 0;
  // CPU on a 100 % scale until it needs more (100 % = one core, so a busy container goes past it).
  const cpuTop = Math.max(100, ...series.cpu.map((v) => Math.ceil(v / 100) * 100));
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
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2">
          <Graph title="CPU" value={fmtPercent(sample.cpuPercent)} sub={t("containers.m.stats.cpuSub")}>
            <Chart values={series.cpu} top={cpuTop} topLabel={`${cpuTop}%`} span={span} color="var(--cf-accent)" />
          </Graph>
          <Graph
            title={t("containers.stat.memory")}
            value={sample.memLimit ? `${fmtBytes(sample.memUsage)} / ${fmtBytes(sample.memLimit)}` : fmtBytes(sample.memUsage)}
            sub={sample.memLimit ? fmtPercent(sample.memPercent) : undefined}
          >
            {/* Against the limit, as the engine enforces it: a leak reads as a line climbing to the top. */}
            <Chart values={series.memory} top={sample.memLimit || undefined} format={fmtBytes} span={span} color="var(--cf-success)" />
          </Graph>
          <Graph
            title={t("containers.stat.network")}
            value={`${fmtBytes(latest(series.network))}/s`}
            sub={`${t("containers.m.stats.rates", { a: fmtBytes(latest(series.rx)), b: fmtBytes(latest(series.tx)) })} · ${t("containers.m.stats.totals", { a: fmtBytes(sample.netRx), b: fmtBytes(sample.netTx) })}`}
          >
            <Chart values={series.network} format={(v) => `${fmtBytes(v)}/s`} span={span} color="var(--cf-warning)" />
          </Graph>
          <Graph title={t("containers.stat.disk")} value={`${fmtBytes(latest(series.disk))}/s`} sub={t("containers.m.stats.diskTotals", { a: fmtBytes(sample.blockRead), b: fmtBytes(sample.blockWrite) })}>
            <Chart values={series.disk} format={(v) => `${fmtBytes(v)}/s`} span={span} color="#a78bfa" />
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

function Graph({ title, value, sub, children }: { title: string; value: string; sub?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--cf-border)] px-3 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-[var(--cf-text-muted)]">{title}</span>
      <span className="font-mono text-[18px] font-semibold tabular-nums text-[var(--cf-text)]">{value}</span>
      {sub && <span className="truncate text-[11px] text-[var(--cf-text-faint)]">{sub}</span>}
      {children}
    </div>
  );
}

/**
 * A graph with its scale: the top of the box and zero on the left, the time it spans below. Without
 * `top` the box is the peak with a quarter of headroom — the same top `Sparkline` draws to, so the
 * label is the line's real scale.
 */
function Chart({
  values,
  top,
  topLabel,
  format = String,
  span,
  color,
}: {
  values: number[];
  top?: number;
  topLabel?: string;
  format?: (value: number) => string;
  span: number;
  color: string;
}) {
  const scale = Math.max(top ?? 0, Math.max(0, ...values) * 1.25);
  return (
    <div className="flex gap-1.5">
      <div className="flex w-[56px] shrink-0 flex-col justify-between text-right font-mono text-[10px] leading-none text-[var(--cf-text-faint)]">
        <span className="truncate">{topLabel ?? (scale > 0 ? format(scale) : "")}</span>
        <span>0</span>
      </div>
      <div className="min-w-0 flex-1 border-b border-l border-[var(--cf-border)]">
        <Sparkline values={values} max={scale || undefined} color={color} height={64} />
      </div>
      <span className="self-end font-mono text-[10px] leading-none text-[var(--cf-text-faint)]">{span > 0 ? `~${span} s` : ""}</span>
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
