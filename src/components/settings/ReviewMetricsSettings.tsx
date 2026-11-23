import { useEffect, useMemo, useState } from "react";
import { BarChart3, X } from "lucide-react";
import { reviewMetrics, type ReviewMetrics, type ReviewMetricsRate } from "../../lib/tauri/commands";
import { compactTokens, fillMonths, METRIC_SEVERITIES, percent, usd } from "../../lib/reviewMetrics";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Select } from "../common/Select";
import { DateField } from "../common/DateField";
import { EmptyState } from "../common/EmptyState";
import { Skeleton } from "../common/Skeleton";
import { buttonClass } from "../common/Button";
import { SECTION_LABEL } from "./UsageStatsSection";

/**
 * Severity → mark colour, in the fixed order of `METRIC_SEVERITIES`. Status-derived on purpose (the
 * app's danger/warning/blue tokens, which retune themselves in dark mode), and never the only cue:
 * every chart carries a legend with the names, and the hover readout says each count in words.
 */
const SEVERITY_COLOR: Record<string, string> = {
  Blocker: "var(--cf-danger)",
  Crítico: "color-mix(in oklab, var(--cf-danger) 55%, var(--cf-warning))",
  Mayor: "var(--cf-warning)",
  Menor: "var(--cf-blue)",
  Info: "var(--cf-text-faint)",
};

/** Finding states the memory screen already names; anything newer is shown by its own name. */
const STATE_LABEL: Record<string, TranslationKey> = {
  abierto: "settings.memoryEstadoOpen",
  posteado: "settings.memoryEstadoPosted",
  resuelto: "settings.memoryEstadoResolved",
  falso_positivo: "settings.memoryEstadoFalse",
  ignorado: "settings.memoryEstadoIgnored",
};

/**
 * The review metrics of the active workspace: how the gate trends, what the reviews find, what
 * stays open, how often humans reject a finding (per reviewer and per category), and what reviews
 * cost — computed on demand from the saved runs (`review_metrics`), filtered by repository and date.
 *
 * A tab beside the memory manager because it is the same data read the other way round: the manager
 * goes run by run, this sums them. Charts are hand-drawn SVG like the statistics screen's; the app
 * carries no chart library and this needs none.
 */
export function ReviewMetricsSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [repo, setRepo] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [metrics, setMetrics] = useState<ReviewMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRepo("");
    setFrom("");
    setTo("");
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    setError(null);
    reviewMetrics(workspaceId, { repo: repo || null, from: from || null, to: to || null })
      .then((m) => live && setMetrics(m))
      .catch((e: unknown) => {
        if (!live) return;
        setError(String(e));
        setMetrics(null);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, repo, from, to]);

  if (!workspaceId) {
    return <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.reviewSelectWorkspace")}</p>;
  }
  if (error) {
    return <p className="text-[12px] text-[var(--cf-danger)]">{t("reviewMetrics.loadFailed", { error })}</p>;
  }
  if (!metrics) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  // Nothing saved at all: filters would be controls over nothing.
  if (metrics.repos.length === 0) {
    return <EmptyState icon={BarChart3} title={t("reviewMetrics.empty")} subtitle={t("reviewMetrics.emptyHint")} />;
  }

  const filtered = Boolean(repo || from || to);
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("reviewMetrics.hint")}</p>
      {/* One row of filters above everything they narrow. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={repo}
          onChange={setRepo}
          size="compact"
          ariaLabel={t("reviewMetrics.repo")}
          className="min-w-[180px]"
          options={[
            { value: "", label: t("reviewMetrics.allRepos") },
            ...metrics.repos.map((r) => ({ value: r.key, label: `${r.label} (${r.runs})` })),
          ]}
        />
        <DateField value={from} onChange={setFrom} size="sm" clearable max={to || undefined} placeholder={t("reviewMetrics.from")} ariaLabel={t("reviewMetrics.from")} />
        <DateField value={to} onChange={setTo} size="sm" clearable min={from || undefined} placeholder={t("reviewMetrics.to")} ariaLabel={t("reviewMetrics.to")} />
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setRepo("");
              setFrom("");
              setTo("");
            }}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            <X size={12} />
            {t("reviewMetrics.clearFilters")}
          </button>
        )}
      </div>

      {metrics.total_runs === 0 ? (
        <EmptyState icon={BarChart3} title={t("reviewMetrics.emptyFiltered")} />
      ) : (
        <MetricsBody metrics={metrics} />
      )}
    </div>
  );
}

function MetricsBody({ metrics }: { metrics: ReviewMetrics }) {
  const t = useT();
  const months = useMemo(() => fillMonths(metrics.months), [metrics.months]);
  const gateTotal = metrics.gate_passed + metrics.gate_failed;
  const fp = metrics.false_positive;
  const avg = usd(metrics.cost.avg_cost_usd);
  const total = usd(metrics.cost.runs_with_cost > 0 ? metrics.cost.total_cost_usd : null);

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label={t("reviewMetrics.runs")} value={String(metrics.total_runs)} note={t("reviewMetrics.prsN", { n: metrics.total_prs })} />
        <Tile
          label={t("reviewMetrics.gateRate")}
          value={percent(metrics.gate_passed, gateTotal)}
          note={t("reviewMetrics.ofN", { n: metrics.gate_passed, total: gateTotal })}
        />
        <Tile
          label={t("reviewMetrics.fpRate")}
          value={percent(fp.false_positives, fp.findings)}
          note={t("reviewMetrics.ofN", { n: fp.false_positives, total: fp.findings })}
        />
        <Tile label={t("reviewMetrics.resolved")} value={String(metrics.resolved)} note={t("reviewMetrics.approvedN", { n: metrics.approved })} />
        <Tile
          label={t("reviewMetrics.avgCost")}
          value={avg ?? t("reviewMetrics.noCost")}
          note={t("reviewMetrics.costCoverage", { n: metrics.cost.runs_with_cost, total: metrics.total_runs })}
        />
        <Tile
          label={t("reviewMetrics.totalCost")}
          value={total ?? t("reviewMetrics.noCost")}
          note={t("reviewMetrics.tokens", { n: compactTokens(metrics.cost.total_tokens) })}
        />
        {metrics.runs_by_level.map((level) => (
          <Tile
            key={level.key}
            label={t("reviewMetrics.levelRuns", { level: levelLabel(level.key, t) })}
            value={String(level.count)}
            note={percent(level.count, metrics.total_runs)}
          />
        ))}
      </div>

      <MonthlyStack
        title={t("reviewMetrics.gateByMonth")}
        months={months}
        series={[
          { key: "passed", label: t("reviewMetrics.passed"), color: "var(--cf-success)" },
          { key: "failed", label: t("reviewMetrics.failed"), color: "var(--cf-danger)" },
        ]}
        value={(m, key) => (key === "passed" ? m.gate_passed : m.gate_failed)}
      />
      <MonthlyStack
        title={t("reviewMetrics.newByMonth")}
        months={months}
        series={METRIC_SEVERITIES.map((s) => ({ key: s, label: s, color: SEVERITY_COLOR[s] }))}
        value={(m, key) => m.new_findings[key] ?? 0}
      />

      <RepoTable metrics={metrics} />

      <div className="grid gap-2 md:grid-cols-2">
        <CountList title={t("reviewMetrics.topCategories")} rows={metrics.top_categories.map((c) => ({ key: c.key, label: c.key, count: c.count }))} mono />
        <CountList
          title={t("reviewMetrics.byState")}
          rows={metrics.by_state.map((s) => ({
            key: s.key,
            label: STATE_LABEL[s.key] ? t(STATE_LABEL[s.key]) : s.key.replace(/_/g, " "),
            count: s.count,
          }))}
        />
        <RateList title={t("reviewMetrics.fpByEngine")} rows={metrics.false_positive_by_engine} />
        <RateList title={t("reviewMetrics.fpByCategory")} rows={metrics.false_positive_by_category.slice(0, 10)} mono />
      </div>
    </>
  );
}

function levelLabel(level: string, t: ReturnType<typeof useT>): string {
  return ["basico", "completo", "ultra"].includes(level) ? t(`pr.level.${level}` as TranslationKey) : level;
}

/** One headline number — a stat tile rather than a chart: there is nothing to compare it against. */
function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--cf-border)] px-3 py-2">
      <p className={`truncate ${SECTION_LABEL}`}>{label}</p>
      <p className="mt-0.5 truncate text-[18px] font-semibold tabular-nums text-[var(--cf-text)]">{value}</p>
      {note && <p className="truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">{note}</p>}
    </div>
  );
}

type Month = ReviewMetrics["months"][number];

const CHART_HEIGHT = 110;

/**
 * Stacked bars, one per month, in the fixed order of `series` from the baseline up. A legend names
 * every series, and hovering a month swaps the header's line for that month's counts in words — so
 * the colour is never the only way to read a bar.
 */
function MonthlyStack({
  title,
  months,
  series,
  value,
}: {
  title: string;
  months: Month[];
  series: { key: string; label: string; color: string }[];
  value: (month: Month, key: string) => number;
}) {
  const t = useT();
  const locale = useLanguageStore((s) => s.language);
  const [hover, setHover] = useState<number | null>(null);
  const totals = months.map((m) => series.reduce((sum, s) => sum + value(m, s.key), 0));
  const peak = Math.max(...totals, 1);
  const width = 100 / Math.max(months.length, 1);
  const label = (key: string) => {
    const [year, month] = key.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString(locale, { month: "short", year: "2-digit" });
  };
  const step = Math.max(1, Math.ceil(months.length / 8));
  const at = hover !== null ? months[hover] : null;
  const readout = at
    ? `${label(at.month)} · ${series.map((s) => `${s.label} ${value(at, s.key)}`).join(" · ")}`
    : t("reviewMetrics.hoverHint");

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={SECTION_LABEL}>{title}</span>
        <span className="ml-auto min-w-0 truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">{readout}</span>
      </div>
      <svg
        viewBox={`0 0 100 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[110px] w-full"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} x2={100} y1={CHART_HEIGHT} y2={CHART_HEIGHT} stroke="var(--cf-border)" vectorEffect="non-scaling-stroke" />
        {months.map((m, index) => {
          let y = CHART_HEIGHT;
          return (
            <g key={m.month} onMouseEnter={() => setHover(index)}>
              {/* The hit target is the whole column, not the bar: an empty month is still hoverable. */}
              <rect x={index * width} y={0} width={width} height={CHART_HEIGHT} fill="transparent" />
              {series.map((s) => {
                const n = value(m, s.key);
                if (n <= 0) return null;
                const h = (n / peak) * (CHART_HEIGHT - 4);
                y -= h;
                return (
                  <rect
                    key={s.key}
                    x={index * width + width * 0.18}
                    y={y}
                    width={width * 0.64}
                    height={h}
                    fill={s.color}
                    // A surface hairline between stacked segments, so neighbours never fuse.
                    stroke="var(--cf-surface)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    opacity={hover === null || hover === index ? 0.92 : 0.4}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="relative mt-1 h-[14px] text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
        {months.map((m, index) => {
          if ((months.length - 1 - index) % step !== 0) return null;
          const left = index * width;
          return (
            <span key={m.month} className="absolute top-0 whitespace-nowrap" style={left > 85 ? { right: `${100 - left - width}%` } : { left: `${left}%` }}>
              {label(m.month)}
            </span>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Open findings per repository, by severity, beside what reviewing it has cost — a table, since
 * these are numbers to look up rather than shapes to compare. */
function RepoTable({ metrics }: { metrics: ReviewMetrics }) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
      <div className="border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2">
        <p className={SECTION_LABEL}>{t("reviewMetrics.openByRepo")}</p>
        <p className="mt-0.5 text-[11px] text-[var(--cf-text-muted)]">{t("reviewMetrics.openByRepoHint")}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-[11px] text-[var(--cf-text-muted)]">
              <th className="px-3 py-1.5 font-medium">{t("reviewMetrics.repo")}</th>
              {METRIC_SEVERITIES.map((s) => (
                <th key={s} className="px-2 py-1.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-[2px]" style={{ background: SEVERITY_COLOR[s] }} aria-hidden />
                    {s}
                  </span>
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-medium">{t("reviewMetrics.runs")}</th>
              <th className="px-3 py-1.5 text-right font-medium">{t("reviewMetrics.cost")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--cf-border)]">
            {metrics.by_repo.map((r) => {
              const total = usd(r.runs_with_cost > 0 ? r.total_cost_usd : null);
              const avg = usd(r.avg_cost_usd);
              return (
                <tr key={r.key}>
                  <td className="max-w-[220px] truncate px-3 py-1.5" title={r.key}>
                    {r.label}
                    <span className="ml-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("reviewMetrics.prsN", { n: r.prs })}</span>
                  </td>
                  {METRIC_SEVERITIES.map((s) => (
                    <td key={s} className={`px-2 py-1.5 text-right ${r.open[s] ? "" : "text-[var(--cf-text-faint)]"}`}>
                      {r.open[s] ?? 0}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right">{r.runs}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right" title={avg ? t("reviewMetrics.avgPerRun", { cost: avg }) : undefined}>
                    {total ?? <span className="text-[var(--cf-text-faint)]">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A ranked list of counts with a thin bar under each row — the statistics screen's `BarList`. */
function CountList({ title, rows, mono }: { title: string; rows: { key: string; label: string; count: number }[]; mono?: boolean }) {
  if (rows.length === 0) return null;
  const peak = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <p className={`mb-1.5 ${SECTION_LABEL}`}>{title}</p>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.key}>
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[11.5px]" : ""}`}>{row.label}</span>
              <span className="shrink-0 tabular-nums">{row.count}</span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--cf-press)]">
              <div className="h-full rounded-full bg-[var(--cf-accent-fill)]" style={{ width: `${Math.max((row.count / peak) * 100, 2)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** False-positive rates: the bar is the rate itself (0–100 %), the numbers beside it what it is of. */
function RateList({ title, rows, mono }: { title: string; rows: ReviewMetricsRate[]; mono?: boolean }) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <p className={SECTION_LABEL}>{title}</p>
      <p className="mb-1.5 mt-0.5 text-[11px] text-[var(--cf-text-muted)]">{t("reviewMetrics.fpHint")}</p>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.key}>
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[11.5px]" : ""}`}>{row.key}</span>
              <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">
                {t("reviewMetrics.ofN", { n: row.false_positives, total: row.findings })}
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums">{percent(row.false_positives, row.findings)}</span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--cf-press)]">
              <div className="h-full rounded-full bg-[var(--cf-warning)]" style={{ width: `${Math.max(row.rate * 100, row.false_positives > 0 ? 2 : 0)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
