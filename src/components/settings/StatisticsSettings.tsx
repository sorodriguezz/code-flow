import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Flame,
  GitCommitHorizontal,
  LayoutGrid,
  Loader2,
  MessageSquareText,
  MousePointerClick,
  Power,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { listProjects, usageClear, usageReport, usageRows, writeFileBytes } from "../../lib/tauri/commands";
import { flushUsage } from "../../lib/usageTracker";
import { compactTokens, formatCost } from "../../lib/usageFormat";
import { SHORTCUT_BY_ID } from "../../lib/shortcuts";
import { SETTINGS_SECTIONS } from "../../lib/settingsCatalog";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { translate, useLanguageStore, useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { Project, UsageDayStat, UsageGroupStat, UsageKeyStat, UsageKind, UsageRawRow, UsageReport, UsageTotals } from "../../types/domain";
import { Select } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { buttonClass } from "../common/Button";
import { RailSection } from "./settingsNav";
import { SECTION_LABEL, providerLabel, taskLabel } from "./UsageStatsSection";

/** The windows the picker offers, in days; `all` is everything ever recorded. */
const RANGES = [
  { value: "7", labelKey: "stats.range7d" },
  { value: "30", labelKey: "stats.range30d" },
  { value: "90", labelKey: "stats.range90d" },
  { value: "all", labelKey: "stats.rangeAll" },
] as const;

const ALL = "__all__";

/** "1 h 05 min", "12 min", "40 s" — a duration as it is read, not as a stopwatch prints it. */
export function formatSeconds(total: number): string {
  const seconds = Math.round(total);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A translation when there is one, else `fallback`. */
function look(id: string, fallback: string): string {
  const text = translate(id as TranslationKey);
  return text === id ? fallback : text;
}

/** `method.POST` → "method POST": an untranslated key, made readable rather than hidden. */
const readable = (key: string) => key.replace(/[._]/g, " ");

/** An `app.action` key as "App · action". */
export function actionLabel(key: string): string {
  const [app, ...rest] = key.split(".");
  const action = rest.join(".");
  // `save.ts`, `method.POST`, `status.2xx`: an action and its detail, worded by a template.
  const [base, ...detail] = rest;
  const template = detail.length > 0 ? `stats.actDetail.${base}` : "";
  let actionText = template && translateable(template)
    ? translate(template as TranslationKey, { v: detail.join(".") })
    : look(`stats.act.${action}`, readable(action));
  if (app === "ai") actionText = taskLabel(action, (id) => translate(id));
  if (app === "chat") actionText = look(`stats.surface.${action}`, readable(action));
  return `${look(`stats.app.${app}`, app)} · ${actionText}`;
}

function translateable(id: string): boolean {
  return translate(id as TranslationKey) !== id;
}

/** A recorded key as something to read. */
export function usageLabel(kind: UsageKind, key: string): string {
  switch (kind) {
    case "view":
      return look(`tabbar.${key}`, key);
    case "ai":
      return taskLabel(key, (id) => translate(id));
    case "ai_provider":
      return providerLabel(key);
    case "ai_model": {
      const [provider, ...model] = key.split("/");
      return `${providerLabel(provider)} · ${model.join("/") === "default" ? translate("stats.defaultModel") : model.join("/")}`;
    }
    case "chat_engine": {
      const [provider, ...model] = key.split("/");
      return `${providerLabel(provider)} · ${model.join("/") === "default" ? translate("stats.defaultModel") : model.join("/")}`;
    }
    case "git":
      return look(`stats.git.${key}`, readable(key));
    case "feature":
    case "session":
      return look(`stats.feature.${key}`, readable(key));
    case "action":
    case "error":
      return actionLabel(key);
    case "shortcut": {
      const command = SHORTCUT_BY_ID.get(key as never);
      return command ? translate(command.labelKey) : key;
    }
    case "settings": {
      const section = SETTINGS_SECTIONS.find((entry) => entry.id === key);
      return section ? translate(section.labelKey) : key;
    }
    case "command": {
      const [group, id] = key.split(":");
      if (group === "settings" && id) return `${translate("stats.cmdGroup.settings")} · ${usageLabel("settings", id)}`;
      if (group === "view" && id) return `${translate("stats.cmdGroup.views")} · ${look(`tabbar.${id}`, id)}`;
      return look(`stats.cmdGroup.${group}`, readable(key)) + (id ? ` · ${readable(id)}` : "");
    }
    default:
      return readable(key);
  }
}

/**
 * Settings › Estadísticas: how the app is used, for every workspace, one workspace or one
 * repository, over a window. The scope and the window sit above the rail and hold across panes —
 * each pane is one side of the same question. See `usage_stats.rs` for what is counted and where.
 */
export function StatisticsSettings() {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const [workspace, setWorkspace] = useState<string>(ALL);
  const [repo, setRepo] = useState<string>(ALL);
  const [range, setRange] = useState<string>("30");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);

  const workspaceId = workspace === ALL ? null : workspace;
  const repoId = repo === ALL ? null : repo;
  const days = range === "all" ? null : Number(range);

  // Every workspace's repositories, not only the ones the sidebar has loaded: a repository of
  // another workspace is not a deleted one.
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  useEffect(() => {
    void Promise.all(workspaces.map((ws) => listProjects(ws.id).catch(() => [] as Project[]))).then((lists) => setAllProjects(lists.flat()));
  }, [workspaces]);
  const repoName = useCallback(
    (id: string) =>
      [...allProjects, ...Object.values(projectsByWorkspace).flat()].find((p) => p.id === id)?.name ?? t("stats.deletedRepo"),
    [allProjects, projectsByWorkspace, t],
  );
  const projects = useMemo(() => {
    const known = allProjects.length > 0 ? allProjects : Object.values(projectsByWorkspace).flat();
    return workspaceId ? known.filter((p) => p.workspace_id === workspaceId) : known;
  }, [allProjects, projectsByWorkspace, workspaceId]);

  const load = useCallback(async () => {
    setLoading(true);
    // What the tracker is still holding belongs in the answer: the minutes spent on the way here.
    await flushUsage();
    const next = await usageReport(workspaceId, repoId, days).catch(() => null);
    setReport(next);
    setLoading(false);
  }, [workspaceId, repoId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickWorkspace = (id: string) => {
    setWorkspace(id);
    setRepo(ALL);
  };
  const pickRepo = (id: string) => {
    const owner = allProjects.find((p) => p.id === id)?.workspace_id;
    if (owner && workspace !== ALL && owner !== workspace) setWorkspace(owner);
    setRepo(id);
  };

  const scopeName = repoId ? repoName(repoId) : workspaceId ? (workspaces.find((ws) => ws.id === workspaceId)?.name ?? "") : "";

  const clear = async () => {
    const ok = await confirmAction(scopeName ? t("stats.clearWorkspaceConfirm", { name: scopeName }) : t("stats.clearAllConfirm"));
    if (!ok) return;
    await usageClear(workspaceId, repoId).catch(() => 0);
    void load();
  };

  const exportAs = async (format: "csv" | "json") => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: `codeflow-statistics-${new Date().toISOString().slice(0, 10)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    try {
      await flushUsage();
      const rows = await usageRows(workspaceId, repoId, days);
      const text = format === "json" ? `${JSON.stringify({ scope: { workspaceId, repo: repoId, days }, rows }, null, 2)}\n` : toCsv(rows);
      await writeFileBytes(path, new TextEncoder().encode(text));
      pushSuccessToast(t("stats.exported", { n: rows.length }));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-[180px]">
        <Select
          size="sm"
          ariaLabel={t("stats.scope")}
          value={workspace}
          onChange={pickWorkspace}
          options={[{ value: ALL, label: t("stats.scopeGlobal") }, ...workspaces.map((ws) => ({ value: ws.id, label: ws.name }))]}
        />
      </div>
      <div className="w-[180px]">
        <Select
          size="sm"
          ariaLabel={t("stats.repoScope")}
          value={repo}
          onChange={(id) => (id === ALL ? setRepo(ALL) : pickRepo(id))}
          options={[{ value: ALL, label: t("stats.allRepos") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </div>
      <Segmented
        options={RANGES.map((entry) => ({ value: entry.value, label: t(entry.labelKey) }))}
        value={range}
        onChange={setRange}
        layoutId="cf-set-stats-range"
        size="sm"
      />
      {loading && <Loader2 size={13} className="animate-spin text-[var(--cf-text-muted)]" />}
      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={() => void exportAs("csv")} className={buttonClass({ variant: "ghost", size: "sm" })}>
          <Download size={12} />
          CSV
        </button>
        <button type="button" onClick={() => void exportAs("json")} className={buttonClass({ variant: "ghost", size: "sm" })}>
          <Download size={12} />
          JSON
        </button>
      </div>
    </div>
  );

  return (
    <RailSection section="statistics" title={t("stats.title")} hint={t("stats.hint")} fallback="overview">
      {(tab) => (
        <div className="space-y-4">
          {controls}
          {!report ? (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">{t("stats.loading")}</p>
          ) : (
            <>
              {tab === "overview" && <Overview report={report} repoScope={!!repoId} onClear={clear} />}
              {tab === "apps" && <AppsPane report={report} />}
              {tab === "workspaces" && (
                <WorkspacesPane report={report} global={!workspaceId && !repoId} onPick={(id) => id && pickWorkspace(id)} />
              )}
              {tab === "repos" && <ReposPane report={report} repoScope={!!repoId} nameOf={repoName} onPick={pickRepo} />}
              {tab === "chats" && <ChatsPane report={report} />}
              {tab === "ai" && <AiPane report={report} />}
              {tab === "git" && <GitPane report={report} />}
              {tab === "commands" && <CommandsPane report={report} />}
              {tab === "errors" && <ErrorsPane report={report} />}
            </>
          )}
        </div>
      )}
    </RailSection>
  );
}

function toCsv(rows: UsageRawRow[]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = "day,workspace_id,repo,kind,key,count,seconds,tokens,cost_usd";
  return `${[header, ...rows.map((r) => [r.day, r.workspaceId, r.repo, r.kind, r.key, r.count, r.seconds, r.tokens, r.costUsd].map(cell).join(","))].join("\n")}\n`;
}

const of = (report: UsageReport, kind: UsageKind) => report.keys.filter((row) => row.kind === kind);
const sum = (rows: UsageKeyStat[], field: "count" | "seconds" | "tokens" | "costUsd") => rows.reduce((acc, row) => acc + row[field], 0);

function Empty() {
  const t = useT();
  return <p className="px-3 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">{t("stats.empty")}</p>;
}

/** "+12 %" against the window before, coloured by direction; nothing when there is no window before. */
function Delta({ now, before, invert = false }: { now: number; before: number | undefined; invert?: boolean }) {
  const t = useT();
  if (before === undefined) return null;
  if (before === 0) return now > 0 ? <span className="text-[11px] text-[var(--cf-text-muted)]">{t("stats.new")}</span> : null;
  const change = Math.round(((now - before) / before) * 100);
  const good = invert ? change < 0 : change > 0;
  return (
    <span className={`text-[11px] tabular-nums ${change === 0 ? "text-[var(--cf-text-muted)]" : good ? "text-[var(--cf-success)]" : "text-[var(--cf-warning)]"}`}>
      {change > 0 ? "+" : ""}
      {change} %
    </span>
  );
}

function Kpi({ icon: Icon, label, value, note }: { icon: typeof Clock; label: string; value: string; note?: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--cf-border)] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
        <Icon size={12} className="shrink-0" />
        <span className="min-w-0 break-words leading-snug">{label}</span>
      </div>
      <p className="mt-0.5 text-[17px] font-semibold tabular-nums">{value}</p>
      {note && <div className="flex flex-wrap items-center gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{note}</div>}
    </div>
  );
}

function Overview({ report, repoScope, onClear }: { report: UsageReport; repoScope: boolean; onClear: () => void }) {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const now = report.totals;
  const before: Partial<UsageTotals> = report.previous ?? {};
  const launches = sum(of(report, "session").filter((row) => row.key === "launch"), "count");
  const top = of(report, "view").sort((a, b) => b.seconds - a.seconds || b.count - a.count).slice(0, 5);

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi
          icon={Clock}
          label={t(repoScope ? "stats.timeInRepo" : "stats.activeTime")}
          value={formatSeconds(now.seconds)}
          note={<Delta now={now.seconds} before={before.seconds} />}
        />
        <Kpi icon={LayoutGrid} label={t("stats.appOpens")} value={String(now.views)} note={<Delta now={now.views} before={before.views} />} />
        <Kpi
          icon={Bot}
          label={t("stats.aiRuns")}
          value={String(now.aiRuns)}
          note={
            <>
              {now.costUsd > 0 && <span>{formatCost(now.costUsd)}</span>}
              <Delta now={now.aiRuns} before={before.aiRuns} />
            </>
          }
        />
        <Kpi icon={MessageSquareText} label={t("stats.chatsSent")} value={String(now.chats)} note={<Delta now={now.chats} before={before.chats} />} />
        <Kpi icon={GitCommitHorizontal} label={t("stats.gitOps")} value={String(now.gitOps)} note={<Delta now={now.gitOps} before={before.gitOps} />} />
        <Kpi icon={MousePointerClick} label={t("stats.actions")} value={String(now.actions)} note={<Delta now={now.actions} before={before.actions} />} />
        <Kpi icon={TriangleAlert} label={t("stats.errors")} value={String(now.errors)} note={<Delta now={now.errors} before={before.errors} invert />} />
        <Kpi
          icon={Flame}
          label={t("stats.streak")}
          value={t("stats.daysCount", { n: report.streak })}
          note={t("stats.longestStreak", { n: report.longestStreak })}
        />
        <Kpi icon={Activity} label={t("stats.activeDays")} value={String(report.activeDays)} />
        {!repoScope && <Kpi icon={Power} label={t("stats.launches")} value={String(launches)} />}
      </div>
      {report.previous && <p className="text-[11px] text-[var(--cf-text-muted)]">{t("stats.comparedHint")}</p>}
      {report.daily.length > 0 && (
        <DailyChart
          days={report.daily}
          locale={locale}
          title={t("stats.perDay")}
          value={(day) => day.seconds}
          shown={(day) => formatSeconds(day.seconds)}
          detail={(day) =>
            `${t("stats.opensN", { n: day.views })} · ${t("stats.aiRunsN", { n: day.aiRuns })} · ${t("stats.gitOpsN", { n: day.gitOps })} · ${t("stats.actionsN", { n: day.actions })}`
          }
        />
      )}
      <HeatMap seconds={report.heatSeconds} events={report.heatEvents} locale={locale} repoScope={repoScope} />
      {top.length > 0 && (
        <BarList
          title={t("stats.topApps")}
          rows={top.map((row) => ({
            id: row.key,
            label: usageLabel("view", row.key),
            value: row.seconds,
            shown: formatSeconds(row.seconds),
            note: t("stats.opensN", { n: row.count }),
          }))}
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        {report.since && (
          <p className="text-[11px] text-[var(--cf-text-muted)]">
            {t("stats.since", { date: new Date(`${report.since}T00:00:00`).toLocaleDateString(locale) })}
          </p>
        )}
        <button type="button" onClick={onClear} className={buttonClass({ variant: "ghost", size: "sm", className: "ml-auto" })}>
          <Trash2 size={12} />
          {t("stats.clear")}
        </button>
      </div>
    </>
  );
}

const CHART_HEIGHT = 110;

/** A value per day, hand-drawn like the AI usage chart (there is no chart library here). */
function DailyChart({
  days,
  locale,
  title,
  value,
  shown,
  detail,
}: {
  days: UsageDayStat[];
  locale: string;
  title: string;
  value: (day: UsageDayStat) => number;
  shown: (day: UsageDayStat) => string;
  detail?: (day: UsageDayStat) => string;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const peakDay = days.reduce((best, day) => (value(day) > value(best) ? day : best), days[0]);
  const peak = Math.max(value(peakDay), 1e-9);
  const width = 100 / Math.max(days.length, 1);
  const label = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" });
  const step = Math.max(1, Math.ceil(days.length / 7));
  const at = hover !== null ? days[hover] : null;

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className={SECTION_LABEL}>{title}</span>
        <span className="ml-auto min-w-0 truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {at ? `${label(at.day)} · ${shown(at)}${detail ? ` · ${detail(at)}` : ""}` : t("stats.peak", { time: shown(peakDay) })}
        </span>
      </div>
      <svg viewBox={`0 0 100 ${CHART_HEIGHT}`} preserveAspectRatio="none" className="h-[110px] w-full" onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={100} y1={CHART_HEIGHT} y2={CHART_HEIGHT} stroke="var(--cf-border)" vectorEffect="non-scaling-stroke" />
        {days.map((day, index) => {
          const height = (value(day) / peak) * (CHART_HEIGHT - 4);
          return (
            <g key={day.day} onMouseEnter={() => setHover(index)}>
              <rect x={index * width} y={0} width={width} height={CHART_HEIGHT} fill="transparent" />
              <rect
                x={index * width + width * 0.15}
                y={CHART_HEIGHT - height}
                width={width * 0.7}
                height={height}
                rx={0.4}
                fill="var(--cf-accent)"
                opacity={hover === null || hover === index ? 0.9 : 0.4}
              />
            </g>
          );
        })}
      </svg>
      <div className="relative mt-1 h-[14px] text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
        {days.map((day, index) => {
          // Counted back from the newest, so today always carries its date.
          if ((days.length - 1 - index) % step !== 0) return null;
          const left = index * width;
          return (
            <span key={day.day} className="absolute top-0 whitespace-nowrap" style={left > 88 ? { right: `${100 - left - width}%` } : { left: `${left}%` }}>
              {label(day.day)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Time in front of the app by weekday and hour — when the work happens. */
function HeatMap({ seconds, events, locale, repoScope }: { seconds: number[][]; events: number[][]; locale: string; repoScope: boolean }) {
  const t = useT();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const peak = Math.max(1, ...seconds.flat());
  if (seconds.flat().every((value) => value === 0) && events.flat().every((value) => value === 0)) return null;
  // Monday first: 2024-01-01 was a Monday.
  const weekday = (index: number) => new Date(2024, 0, 1 + index).toLocaleDateString(locale, { weekday: "short" });
  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className={SECTION_LABEL}>{t("stats.heatTitle")}</span>
        <span className="ml-auto min-w-0 truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {hover
            ? `${weekday(hover[0])} ${String(hover[1]).padStart(2, "0")}:00 · ${formatSeconds(seconds[hover[0]][hover[1]])} · ${t("stats.actionsN", { n: events[hover[0]][hover[1]] })}`
            : repoScope
              ? t("stats.heatWorkspaceNote")
              : t("stats.heatHint")}
        </span>
      </div>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))" }} onMouseLeave={() => setHover(null)}>
        {seconds.map((row, day) => (
          <div key={day} className="contents">
            <span className="text-[10px] leading-[14px] text-[var(--cf-text-muted)]">{weekday(day)}</span>
            {row.map((value, hour) => (
              <div
                key={hour}
                onMouseEnter={() => setHover([day, hour])}
                className="h-[14px] rounded-[2px]"
                style={{
                  background:
                    value > 0
                      ? `color-mix(in oklab, var(--cf-accent) ${Math.round(20 + (value / peak) * 80)}%, transparent)`
                      : "var(--cf-press)",
                }}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="text-center text-[9.5px] tabular-nums text-[var(--cf-text-muted)]">
            {hour % 3 === 0 ? hour : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

interface BarRow {
  id: string;
  label: string;
  value: number;
  shown: string;
  note?: string;
  extra?: string;
  onClick?: () => void;
  /** Rows shown under this one when it is opened. */
  children?: BarRow[];
}

/** A ranked list with a bar under each row, the shape the AI usage screen's task table has. */
function BarList({ title, rows, hint }: { title: string; rows: BarRow[]; hint?: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (rows.length === 0) return null;
  const peak = Math.max(...rows.map((row) => row.value), 1);
  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-3">
      <p className={`mb-1.5 ${SECTION_LABEL}`}>{title}</p>
      {hint && <p className="-mt-1 mb-1.5 text-[11px] text-[var(--cf-text-muted)]">{hint}</p>}
      <div className="space-y-1.5">
        {rows.map((row) => {
          const expandable = !!row.children?.length;
          const isOpen = !!open[row.id];
          const content = (
            <>
              <div className="flex items-center gap-1.5 text-[12px]">
                {expandable &&
                  (isOpen ? (
                    <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                  ) : (
                    <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                  ))}
                <span className="min-w-0 flex-1 break-words text-left leading-snug">{row.label}</span>
                {row.note && <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">{row.note}</span>}
                {row.extra && <span className="w-16 shrink-0 text-right tabular-nums text-[var(--cf-text-muted)]">{row.extra}</span>}
                <span className="w-20 shrink-0 text-right tabular-nums">{row.shown}</span>
              </div>
              <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--cf-press)]">
                <div className="h-full rounded-full bg-[var(--cf-accent-fill)]" style={{ width: `${Math.max((row.value / peak) * 100, 2)}%` }} />
              </div>
            </>
          );
          const onClick = expandable ? () => setOpen((s) => ({ ...s, [row.id]: !s[row.id] })) : row.onClick;
          return (
            <div key={row.id}>
              {onClick ? (
                <button type="button" onClick={onClick} className="block w-full rounded-md hover:bg-[var(--cf-hover)]">
                  {content}
                </button>
              ) : (
                content
              )}
              {expandable && isOpen && (
                <div className="mt-1 space-y-1 border-l border-[var(--cf-border)] pl-3">
                  {row.children!.map((child) => (
                    <div key={child.id} className="flex items-center gap-1.5 text-[11.5px]">
                      <span className="min-w-0 flex-1 break-words text-[var(--cf-text-muted)]">{child.label}</span>
                      <span className="w-20 shrink-0 text-right tabular-nums">{child.shown}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Which action apps (`usageActions`) belong to which tab or app of the rail. */
const VIEW_ACTIONS: Record<string, string[]> = {
  api: ["api"],
  databases: ["db"],
  flows: ["flows"],
  notes: ["notes"],
  diagrams: ["diagrams"],
  editor: ["editor", "explorer"],
  remote: ["remote"],
  vault: ["vault"],
  agents: ["agents"],
  stories: ["stories"],
  pipelines: ["pipelines"],
  reviewer: ["quality"],
};

function AppsPane({ report }: { report: UsageReport }) {
  const t = useT();
  const views = of(report, "view").sort((a, b) => b.seconds - a.seconds || b.count - a.count);
  const actions = of(report, "action");
  const features = of(report, "feature").sort((a, b) => b.count - a.count);
  if (views.length === 0 && actions.length === 0 && features.length === 0) return <Empty />;

  const actionRows = (apps: string[]): BarRow[] =>
    actions
      .filter((row) => apps.includes(row.key.split(".")[0]))
      .sort((a, b) => b.count - a.count)
      .map((row) => ({ id: row.key, label: usageLabel("action", row.key), value: row.count, shown: t("stats.timesN", { n: row.count }) }));
  const claimed = new Set(views.flatMap((row) => VIEW_ACTIONS[row.key] ?? []));
  const otherApps = Array.from(new Set(actions.map((row) => row.key.split(".")[0]))).filter((app) => !claimed.has(app));

  return (
    <>
      <BarList
        title={t("stats.appsByTime")}
        hint={t("stats.appsExpandHint")}
        rows={views.map((row) => ({
          id: row.key,
          label: usageLabel("view", row.key),
          value: row.seconds,
          shown: formatSeconds(row.seconds),
          note: t("stats.opensN", { n: row.count }),
          extra: t("stats.daysN", { n: row.days }),
          children: actionRows(VIEW_ACTIONS[row.key] ?? []),
        }))}
      />
      <BarList
        title={t("stats.toolActions")}
        rows={otherApps
          .map((app) => {
            const children = actionRows([app]);
            const total = children.reduce((acc, row) => acc + row.value, 0);
            return { id: app, label: look(`stats.app.${app}`, app), value: total, shown: t("stats.timesN", { n: total }), children };
          })
          .sort((a, b) => b.value - a.value)}
      />
      <BarList
        title={t("stats.features")}
        rows={features.map((row) => ({ id: row.key, label: usageLabel("feature", row.key), value: row.count, shown: t("stats.timesN", { n: row.count }) }))}
      />
    </>
  );
}

function groupRows(rows: UsageGroupStat[], nameOf: (id: string) => string, t: ReturnType<typeof useT>, onPick?: (id: string) => void): BarRow[] {
  return rows.map((row) => ({
    id: row.id || "none",
    label: nameOf(row.id),
    value: row.seconds,
    shown: formatSeconds(row.seconds),
    note: `${t("stats.aiRunsN", { n: row.aiRuns })} · ${t("stats.gitOpsN", { n: row.gitOps })} · ${t("stats.actionsN", { n: row.actions })}`,
    extra: row.costUsd > 0 ? formatCost(row.costUsd) : undefined,
    onClick: onPick && row.id ? () => onPick(row.id) : undefined,
  }));
}

function WorkspacesPane({ report, global, onPick }: { report: UsageReport; global: boolean; onPick: (id: string) => void }) {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  if (!global) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("stats.workspacesOnlyGlobal")}</p>;
  if (report.workspaces.length === 0) return <Empty />;
  const nameOf = (id: string) => (id === "" ? t("stats.noWorkspace") : (workspaces.find((ws) => ws.id === id)?.name ?? t("stats.deletedWorkspace")));
  const known = (id: string) => workspaces.some((ws) => ws.id === id);
  return <BarList title={t("stats.byWorkspace")} rows={groupRows(report.workspaces, nameOf, t, (id) => known(id) && onPick(id))} />;
}

function ReposPane({ report, repoScope, nameOf, onPick }: { report: UsageReport; repoScope: boolean; nameOf: (id: string) => string; onPick: (id: string) => void }) {
  const t = useT();
  if (repoScope) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("stats.reposOnlyWider")}</p>;
  if (report.repos.length === 0) return <Empty />;
  return <BarList title={t("stats.byRepo")} hint={t("stats.reposHint")} rows={groupRows(report.repos, nameOf, t, onPick)} />;
}

const SURFACES = ["repo", "chat", "workspace", "quickAsk", "agents"] as const;
const CHAT_EVENTS = ["sent", "reply", "created", "image", "file", "branch", "continue", "compact", "clear"] as const;

function ChatsPane({ report }: { report: UsageReport }) {
  const t = useT();
  const chats = of(report, "chat");
  const engines = of(report, "chat_engine").sort((a, b) => b.count - a.count);
  if (chats.length === 0) return <Empty />;
  const count = (surface: string, event: string) => chats.find((row) => row.key === `${surface}.${event}`)?.count ?? 0;
  const replySeconds = (surface: string) => chats.find((row) => row.key === `${surface}.reply`)?.seconds ?? 0;
  const surfaces = SURFACES.filter((surface) => CHAT_EVENTS.some((event) => count(surface, event) > 0));
  const totals = Object.fromEntries(CHAT_EVENTS.map((event) => [event, surfaces.reduce((acc, s) => acc + count(s, event), 0)]));

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi icon={MessageSquareText} label={t("stats.chat.sent")} value={String(totals.sent)} />
        <Kpi icon={Bot} label={t("stats.chat.reply")} value={String(totals.reply)} />
        <Kpi icon={LayoutGrid} label={t("stats.chat.created")} value={String(totals.created)} />
        <Kpi icon={Download} label={t("stats.chat.attachments")} value={String(totals.image + totals.file)} note={t("stats.chat.imagesN", { n: totals.image })} />
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--cf-border)] p-3">
        <p className={`mb-1.5 ${SECTION_LABEL}`}>{t("stats.chat.bySurface")}</p>
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-[11px] text-[var(--cf-text-muted)]">
              <th className="py-1 text-left font-normal" />
              {CHAT_EVENTS.map((event) => (
                <th key={event} className="px-1.5 py-1 text-right font-normal">
                  {t(`stats.chat.${event}` as TranslationKey)}
                </th>
              ))}
              <th className="px-1.5 py-1 text-right font-normal">{t("stats.chat.avgReply")}</th>
            </tr>
          </thead>
          <tbody>
            {surfaces.map((surface) => (
              <tr key={surface} className="border-t border-[var(--cf-border)]">
                <td className="py-1 pr-2">{t(`stats.surface.${surface}` as TranslationKey)}</td>
                {CHAT_EVENTS.map((event) => (
                  <td key={event} className="px-1.5 py-1 text-right">
                    {count(surface, event) || "—"}
                  </td>
                ))}
                <td className="px-1.5 py-1 text-right">
                  {count(surface, "reply") > 0 ? formatSeconds(replySeconds(surface) / count(surface, "reply")) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BarList
        title={t("stats.chat.byModel")}
        rows={engines.map((row) => ({ id: row.key, label: usageLabel("chat_engine", row.key), value: row.count, shown: t("stats.chat.repliesN", { n: row.count }) }))}
      />
    </>
  );
}

function AiPane({ report }: { report: UsageReport }) {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const tasks = of(report, "ai").sort((a, b) => b.count - a.count || b.tokens - a.tokens);
  if (tasks.length === 0) return <Empty />;
  const rows = (list: UsageKeyStat[], kind: UsageKind): BarRow[] =>
    list
      .sort((a, b) => b.count - a.count || b.tokens - a.tokens)
      .map((row) => ({
        id: row.key,
        label: usageLabel(kind, row.key),
        value: row.count || row.tokens,
        shown: t("stats.aiRunsN", { n: row.count }),
        note: `${compactTokens(row.tokens)}${row.count > 0 ? ` · ⌀ ${formatSeconds(row.seconds / row.count)}` : ""}`,
        extra: row.costUsd > 0 ? formatCost(row.costUsd) : "—",
      }));
  const outcomes = of(report, "ai_outcome");
  const tokens = of(report, "ai_tokens");
  const tokenOf = (key: string) => tokens.find((row) => row.key === key)?.tokens ?? 0;
  const runs = sum(outcomes, "count");
  const seconds = sum(outcomes, "seconds");

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi icon={Bot} label={t("stats.aiRuns")} value={String(runs)} note={runs > 0 ? `⌀ ${formatSeconds(seconds / runs)} · Σ ${formatSeconds(seconds)}` : undefined} />
        <Kpi icon={Download} label={t("stats.tokens.input")} value={compactTokens(tokenOf("input"))} />
        <Kpi icon={Download} label={t("stats.tokens.output")} value={compactTokens(tokenOf("output"))} />
        <Kpi icon={Download} label={t("stats.tokens.cache")} value={compactTokens(tokenOf("cache_read") + tokenOf("cache_write"))} />
      </div>
      <BarList
        title={t("stats.aiByOutcome")}
        rows={outcomes
          .sort((a, b) => b.count - a.count)
          .map((row) => ({ id: row.key, label: look(`stats.outcome.${row.key}`, row.key), value: row.count, shown: t("stats.aiRunsN", { n: row.count }) }))}
      />
      <BarList title={t("stats.aiByArea")} rows={rows(tasks, "ai")} />
      <BarList title={t("stats.aiByEngine")} rows={rows(of(report, "ai_provider"), "ai_provider")} />
      <BarList title={t("stats.aiByModel")} rows={rows(of(report, "ai_model"), "ai_model")} />
      {report.daily.some((day) => day.costUsd > 0) && (
        <DailyChart days={report.daily} locale={locale} title={t("stats.costPerDay")} value={(day) => day.costUsd} shown={(day) => formatCost(day.costUsd)} />
      )}
      <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("stats.aiNote")}</p>
    </>
  );
}

function GitPane({ report }: { report: UsageReport }) {
  const t = useT();
  const ops = of(report, "git").sort((a, b) => b.count - a.count);
  const lines = of(report, "git_lines");
  const line = (key: string) => lines.find((row) => row.key === key)?.count ?? 0;
  const commits = ops.find((row) => row.key === "commit")?.count ?? 0;
  if (ops.length === 0) return <Empty />;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi icon={GitCommitHorizontal} label={t("stats.git.commit")} value={String(commits)} />
        <Kpi icon={GitCommitHorizontal} label={t("stats.linesAdded")} value={`+${line("added")}`} />
        <Kpi icon={GitCommitHorizontal} label={t("stats.linesRemoved")} value={`−${line("removed")}`} />
        <Kpi
          icon={GitCommitHorizontal}
          label={t("stats.filesPerCommit")}
          value={commits > 0 ? (line("files") / commits).toFixed(1) : "—"}
          note={t("stats.filesTotal", { n: line("files") })}
        />
      </div>
      <BarList
        title={t("stats.gitOps")}
        rows={ops.map((row) => ({
          id: row.key,
          label: usageLabel("git", row.key),
          value: row.count,
          shown: t("stats.timesN", { n: row.count }),
          note: t("stats.daysN", { n: row.days }),
        }))}
      />
    </>
  );
}

function keyRows(rows: UsageKeyStat[], kind: UsageKind, t: ReturnType<typeof useT>): BarRow[] {
  return rows
    .sort((a, b) => b.count - a.count)
    .map((row) => ({ id: row.key, label: usageLabel(kind, row.key), value: row.count, shown: t("stats.timesN", { n: row.count }) }));
}

function CommandsPane({ report }: { report: UsageReport }) {
  const t = useT();
  const shortcuts = of(report, "shortcut");
  const commands = of(report, "command");
  const settings = of(report, "settings");
  if (shortcuts.length + commands.length + settings.length === 0) return <Empty />;
  return (
    <>
      <BarList title={t("stats.shortcutsUsed")} rows={keyRows(shortcuts, "shortcut", t)} />
      <BarList title={t("stats.paletteCommands")} rows={keyRows(commands, "command", t)} />
      <BarList title={t("stats.settingsOpened")} rows={keyRows(settings, "settings", t)} />
    </>
  );
}

function ErrorsPane({ report }: { report: UsageReport }) {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const errors = of(report, "error");
  if (errors.length === 0) return <p className="px-3 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">{t("stats.noErrors")}</p>;
  return (
    <>
      <BarList title={t("stats.errorsByApp")} rows={keyRows(errors, "error", t)} />
      {report.daily.length > 0 && (
        <DailyChart days={report.daily} locale={locale} title={t("stats.errorsPerDay")} value={(day) => day.errors} shown={(day) => String(day.errors)} />
      )}
    </>
  );
}
