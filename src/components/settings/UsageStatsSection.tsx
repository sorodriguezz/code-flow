import { useEffect, useMemo, useState } from "react";
import { Coins, Gauge, Layers, Loader2, Zap } from "lucide-react";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { aiUsageStats } from "../../lib/tauri/commands";
import { compactTokens, formatCost } from "../../lib/usageFormat";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { ModelStat, ProviderStat, TaskStat, UsageStats } from "../../types/domain";
import type { TranslationKey } from "../../lib/i18n/translations";

/** The windows the picker offers, in hours. Mirrors nothing on the backend — it takes whatever it
 * is given and buckets accordingly — so the set is a product decision, not a constraint. */
const WINDOWS = [
  { hours: 5, labelKey: "usage.window5h" },
  { hours: 24, labelKey: "usage.window24h" },
  { hours: 24 * 7, labelKey: "usage.window7d" },
  { hours: 24 * 30, labelKey: "usage.window30d" },
] as const;

/** Every provider gets a stable colour so the chart, the split bar and the table agree about who is
 * who. Indexed off the catalogue rather than off the data, which reorders itself by usage. */
const SERIES_COLOURS = [
  "var(--cf-accent)",
  "#22c55e",
  "#f59e0b",
  "#0ea5e9",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
];

function colourFor(provider: string): string {
  const at = AI_PROVIDERS.findIndex((candidate) => candidate.id === provider);
  return SERIES_COLOURS[(at === -1 ? AI_PROVIDERS.length : at) % SERIES_COLOURS.length];
}

function providerLabel(provider: string): string {
  return AI_PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;
}

function tokensOf(stat: ProviderStat): number {
  return stat.input_tokens + stat.output_tokens + stat.cache_read_tokens + stat.cache_write_tokens;
}

/**
 * What every engine has spent, over a window you choose.
 *
 * The screen the status-bar meter defers to. Same data and the same honesty about it — measured
 * spend, never a fraction of a plan — but a screen can afford four windows, a shape over time, and
 * the per-model split that says *why* one engine costs what it does.
 *
 * The chart is inline SVG. There is no chart library in this project and one bar chart does not
 * justify adding one; what it costs instead is the geometry below, which is about fifteen lines.
 */
export function UsageStatsSection() {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const [hours, setHours] = useState<number>(24 * 7);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    aiUsageStats(hours)
      .then((answer) => {
        // Guarded twice: by the unmount flag, and by the window the answer says it is about. The
        // picker is faster than the query, and a slow answer for 30 days landing under the 5-hour
        // heading is the one bug this screen can have that nobody would notice.
        if (live && answer.window_hours === hours) setStats(answer);
      })
      .catch(() => {
        if (live) setStats(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [hours]);

  const totals = useMemo(() => {
    const providers = stats?.providers ?? [];
    return providers.reduce(
      (acc, p) => ({
        tokens: acc.tokens + tokensOf(p),
        input: acc.input + p.input_tokens,
        output: acc.output + p.output_tokens,
        cached: acc.cached + p.cache_read_tokens + p.cache_write_tokens,
        cost: acc.cost + p.cost_usd,
        costed: acc.costed + p.costed_runs,
        runs: acc.runs + p.runs,
      }),
      { tokens: 0, input: 0, output: 0, cached: 0, cost: 0, costed: 0, runs: 0 },
    );
  }, [stats]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-1">
        {WINDOWS.map((window) => (
          <button
            key={window.hours}
            type="button"
            onClick={() => setHours(window.hours)}
            className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
              hours === window.hours
                ? "bg-[var(--cf-accent)] text-white"
                : "border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            }`}
          >
            {t(window.labelKey)}
          </button>
        ))}
        {loading && <Loader2 size={13} className="ml-1 animate-spin text-[var(--cf-text-muted)]" />}
      </div>

      {!stats || totals.runs === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--cf-border)] px-3 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
          {t(loading ? "usage.statsLoading" : "usage.quietWindow")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile icon={Layers} label={t("usage.totalTokens")} value={compactTokens(totals.tokens)} />
            <Tile icon={Zap} label={t("usage.runs")} value={String(totals.runs)} />
            <Tile
              icon={Coins}
              label={t("usage.totalCost")}
              value={totals.costed > 0 ? formatCost(totals.cost) : t("usage.noCost")}
              // Said on the tile rather than in a footnote: the number is a sum over the runs that
              // reported a price, and how many of the window's runs those were changes what it means.
              note={
                totals.costed > 0 && totals.costed < totals.runs
                  ? t("usage.costedOf", { n: totals.costed, total: totals.runs })
                  : undefined
              }
            />
            <Tile
              icon={Gauge}
              label={t("usage.cacheShare")}
              value={`${Math.round((totals.cached / Math.max(totals.tokens, 1)) * 100)}%`}
              note={t("usage.cacheShareNote")}
            />
          </div>

          <Chart stats={stats} locale={locale} />

          <ProviderSplit providers={stats.providers} total={totals.tokens} />

          <ModelTable models={stats.models} />

          <TaskTable tasks={stats.tasks} />
        </>
      )}

      {stats?.since && (
        <p className="text-[11px] text-[var(--cf-text-muted)]">
          {t("usage.since", { date: new Date(stats.since).toLocaleString(locale) })}
        </p>
      )}
    </section>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--cf-border)] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
        <Icon size={11} className="shrink-0" />
        <span className="min-w-0 break-words leading-snug">{label}</span>
      </div>
      <p className="mt-0.5 text-[17px] font-semibold tabular-nums">{value}</p>
      {note && <p className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{note}</p>}
    </div>
  );
}

const CHART_HEIGHT = 120;

/**
 * Tokens over the window, one bar per bucket.
 *
 * Scaled to the busiest bucket, which is the only honest scale available: there is no quota to
 * measure against, so the chart answers "when was I busy" rather than "how close am I to a limit".
 * The bars are drawn as a percentage of the width so the SVG resizes with the pane without a
 * measurement pass.
 */
function Chart({ stats, locale }: { stats: UsageStats; locale: string }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(stats.peak_tokens, 1);
  const count = Math.max(stats.series.length, 1);
  const width = 100 / count;

  /** Whole days get a date; anything shorter gets a clock. A 5-hour window labelled by date would
   * repeat the same string thirty times. */
  const tick = (iso: string) =>
    new Date(iso).toLocaleString(
      locale,
      stats.bucket_minutes >= 60 * 24
        ? { day: "2-digit", month: "short" }
        : { hour: "2-digit", minute: "2-digit" },
    );

  const at = hover !== null ? stats.series[hover] : null;

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("usage.overTime")}
        </span>
        <span className="ml-auto min-w-0 truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {at
            ? `${tick(at.start)} · ${compactTokens(at.tokens)} · ${t("usage.runsN", { n: at.runs })}`
            : t("usage.peakN", { n: compactTokens(stats.peak_tokens) })}
        </span>
      </div>

      <svg
        viewBox={`0 0 100 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[120px] w-full"
        onMouseLeave={() => setHover(null)}
      >
        {stats.series.map((bucket, at) => {
          const height = (bucket.tokens / peak) * (CHART_HEIGHT - 4);
          return (
            <g key={bucket.start} onMouseEnter={() => setHover(at)}>
              {/* A full-height transparent bar behind each column: an empty bucket has no bar to
                  hover, and the gaps are exactly what somebody reading a sparse window points at. */}
              <rect x={at * width} y={0} width={width} height={CHART_HEIGHT} fill="transparent" />
              <rect
                x={at * width + width * 0.15}
                y={CHART_HEIGHT - height}
                width={width * 0.7}
                height={height}
                rx={0.4}
                fill="var(--cf-accent)"
                opacity={hover === null || hover === at ? 0.9 : 0.4}
              />
            </g>
          );
        })}
      </svg>

      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--cf-text-muted)]">
        <span>{stats.series[0] ? tick(stats.series[0].start) : ""}</span>
        <span>{stats.series.length > 0 ? tick(stats.series[stats.series.length - 1].start) : ""}</span>
      </div>
    </div>
  );
}

/** Who the tokens went to, as one stacked bar plus a legend that carries the numbers. */
function ProviderSplit({ providers, total }: { providers: ProviderStat[]; total: number }) {
  const t = useT();
  if (providers.length === 0) return null;

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("usage.byProvider")}
      </p>

      <div className="flex h-2 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
        {providers.map((provider) => (
          <div
            key={provider.provider}
            title={providerLabel(provider.provider)}
            style={{
              width: `${(tokensOf(provider) / Math.max(total, 1)) * 100}%`,
              background: colourFor(provider.provider),
            }}
          />
        ))}
      </div>

      <div className="mt-2 space-y-1.5">
        {providers.map((provider) => {
          const tokens = tokensOf(provider);
          return (
            <div key={provider.provider} className="flex items-center gap-1.5 text-[12px]">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: colourFor(provider.provider) }}
              />
              <span className="min-w-0 flex-1 break-words leading-snug">{providerLabel(provider.provider)}</span>
              <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">
                {t("usage.runsN", { n: provider.runs })}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{compactTokens(tokens)}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-[var(--cf-text-muted)]">
                {provider.costed_runs > 0 ? formatCost(provider.cost_usd) : t("usage.noCost")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Which part of the app spent it.
 *
 * The one breakdown that can be read for a *gap* rather than a total: every other table here answers
 * "where did my tokens go", and none of them can answer "is my PR review being counted at all". A
 * feature that ran and is missing from this list is a hole in the meter, and now it is visible
 * instead of having to be reasoned about.
 */
function TaskTable({ tasks }: { tasks: TaskStat[] }) {
  const t = useT();
  if (tasks.length === 0) return null;
  const peak = Math.max(...tasks.map((task) => task.tokens), 1);

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("usage.byTask")}
      </p>
      <div className="space-y-1.5">
        {tasks.map((task) => (
          <div key={task.task || "unknown"}>
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className="min-w-0 flex-1 break-words leading-snug">{taskLabel(task.task, t)}</span>
              <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">
                {t("usage.runsN", { n: task.runs })}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{compactTokens(task.tokens)}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-[var(--cf-text-muted)]">
                {task.costed_runs > 0 ? formatCost(task.cost_usd) : t("usage.noCost")}
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
              <div
                className="h-full rounded-full bg-[var(--cf-accent)]"
                style={{ width: `${Math.max((task.tokens / peak) * 100, 2)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The `ai::task` ids, as something to read. An id with no entry is shown raw rather than hidden —
 * a flow added on the Rust side should show up here the day it starts spending, not the day
 * somebody remembers to translate it. */
const TASK_LABELS: Record<string, TranslationKey> = {
  chat: "usage.task.chat",
  inline: "usage.task.inline",
  "note-write": "usage.task.noteWrite",
  commit: "usage.task.commit",
  analyze: "usage.task.analyze",
  "review-pr": "usage.task.reviewPr",
  "fix-finding": "usage.task.fixFinding",
  "pr-description": "usage.task.prDescription",
  "comment-reply": "usage.task.commentReply",
  conflict: "usage.task.conflict",
  stories: "usage.task.stories",
  "stories-verify": "usage.task.storiesVerify",
  "work-item-review": "usage.task.workItemReview",
  "repo-doc": "usage.task.repoDoc",
  "workspace-doc": "usage.task.workspaceDoc",
  "repair-json": "usage.task.repairJson",
  other: "usage.task.other",
};

function taskLabel(id: string, t: (key: TranslationKey) => string): string {
  if (id === "") return t("usage.task.unlabelled");
  const key = TASK_LABELS[id];
  return key ? t(key) : id;
}

/** The per-model split — where an engine routed across two models stops reading as one average. */
function ModelTable({ models }: { models: ModelStat[] }) {
  const t = useT();
  if (models.length === 0) return null;
  const peak = Math.max(...models.map((model) => model.tokens), 1);

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("usage.byModel")}
      </p>
      <div className="space-y-1.5">
        {models.map((model) => (
          <div key={`${model.provider}/${model.model}`}>
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className="min-w-0 flex-1 truncate">
                {/* The model is the row; the engine is the qualifier, because two engines can be
                    pointed at the same model id and the pair is what identifies a row. */}
                {model.model || t("usage.modelUnnamed")}
                <span className="ml-1.5 text-[11px] text-[var(--cf-text-muted)]">
                  {providerLabel(model.provider)}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">
                {t("usage.runsN", { n: model.runs })}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{compactTokens(model.tokens)}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-[var(--cf-text-muted)]">
                {model.costed_runs > 0 ? formatCost(model.cost_usd) : t("usage.noCost")}
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max((model.tokens / peak) * 100, 2)}%`,
                  background: colourFor(model.provider),
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
