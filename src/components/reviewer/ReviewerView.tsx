/**
 * The Revisor tab: one repository's quality pipeline — prepare, build, tests, SonarQube, Quality
 * Gate — run on this machine the way a company's CI runs it, and its report.
 *
 * Laid out like the report a pipeline leaves: the stages, the verdict and why, the numbers, then what
 * to work through — the issues, the failing tests, the uncovered code, the log. A review runs in the
 * background (the backend owns it) and survives switching repository; this screen only draws it.
 *
 * No empty-state screen: before the first review the stages are simply waiting and the run button is
 * the way in (the app's rule for empty states — see `terse-in-app-copy`).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Bug,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Loader2,
  MinusCircle,
  Play,
  Settings2,
  ShieldAlert,
  Square,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useT, type Translate } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { openExternalUrl, revealInFileManager } from "../../lib/tauri/commands";
import { EMPTY_PROJECT_CONFIG, effectiveCommands, useReviewerStore, type ReviewerProjectConfig } from "../../state/reviewerStore";
import type {
  ReviewerHistoryEntry,
  ReviewerIssue,
  ReviewerLogLine,
  ReviewerQuality,
  ReviewerRunSummary,
  ReviewerSeverity,
  ReviewerStage,
  ReviewerStageId,
  ReviewerSuggestion,
  ReviewerTestCase,
  ReviewerTestStatus,
} from "../../lib/tauri/reviewerCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { buttonClass } from "../common/Button";
import { chipClass, fieldClass, tabCountClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";

const STAGE_LABEL: Record<ReviewerStageId, TranslationKey> = {
  prepare: "reviewer.stagePrepare",
  build: "reviewer.stageBuild",
  test: "reviewer.stageTest",
  sonar: "reviewer.stageSonar",
  gate: "reviewer.stageGate",
};

const QUALITY_LABEL: Record<ReviewerQuality, TranslationKey> = {
  reliability: "reviewer.qualityReliability",
  security: "reviewer.qualitySecurity",
  maintainability: "reviewer.qualityMaintainability",
};

const QUALITY_ICON: Record<ReviewerQuality, LucideIcon> = {
  reliability: Bug,
  security: ShieldAlert,
  maintainability: Wrench,
};

const SEVERITY_LABEL: Record<ReviewerSeverity, TranslationKey> = {
  blocker: "reviewer.severityBlocker",
  high: "reviewer.severityHigh",
  medium: "reviewer.severityMedium",
  low: "reviewer.severityLow",
  info: "reviewer.severityInfo",
};

function severityColor(severity: ReviewerSeverity): string {
  if (severity === "blocker" || severity === "high") return "var(--cf-danger)";
  if (severity === "medium") return "var(--cf-warning)";
  return "var(--cf-text-muted)";
}

/** "6 s", "1 m 12 s", "2 h 3 m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

/** SonarQube's remediation effort: "5 min", "1 h 30 min", and days of eight hours the way it counts. */
export function formatEffort(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 8 * 60) {
    const rest = minutes % 60;
    return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
  }
  return `${Math.round((minutes / (8 * 60)) * 10) / 10} d`;
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} %`;
}

/** A stage's short result, in the user's words. */
export function stageDetail(t: Translate, stage: ReviewerStage): string {
  const detail = stage.detail ?? "";
  if (detail.startsWith("exit:")) return t("reviewer.exitCode", { code: detail.slice(5) });
  if (detail.startsWith("scanner:")) return t("reviewer.scannerExit", { code: detail.slice(8) });
  if (stage.id === "gate" && detail === "OK") return t("reviewer.gatePassedShort");
  if (stage.id === "gate" && detail === "ERROR") return t("reviewer.gateFailedShort");
  if (stage.status === "skipped") return t("reviewer.stageSkipped");
  if (stage.status === "cancelled") return t("reviewer.stageCancelled");
  if (stage.status === "pending") return t("reviewer.stagePending");
  if (stage.status === "running") return t("reviewer.stageRunning");
  return detail.length > 40 ? `${detail.slice(0, 40)}…` : detail;
}

/** A log line of CodeFlow's own arrives as `cf:<key>`; tool output is shown as it came. */
export function logText(t: Translate, text: string): string {
  if (!text.startsWith("cf:")) return text;
  const key = `reviewer.log.${text.slice(3)}` as TranslationKey;
  const translated = t(key);
  return translated === key ? text : translated;
}

function StageIcon({ status }: { status: ReviewerStage["status"] }) {
  switch (status) {
    case "running":
      // A spinner, not the ThinkingOrb: nothing here is a model reasoning.
      return <Loader2 size={13} className="shrink-0 animate-spin text-[var(--cf-accent)]" />;
    case "ok":
      return <CheckCircle2 size={13} className="shrink-0 text-[var(--cf-success)]" />;
    case "failed":
      return <XCircle size={13} className="shrink-0 text-[var(--cf-danger)]" />;
    case "skipped":
      return <MinusCircle size={13} className="shrink-0 text-[var(--cf-text-faint)]" />;
    case "cancelled":
      return <Ban size={13} className="shrink-0 text-[var(--cf-text-muted)]" />;
    default:
      return <Circle size={13} className="shrink-0 text-[var(--cf-text-faint)]" />;
  }
}

type SubTab = "issues" | "tests" | "coverage" | "log";

export function ReviewerView() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const status = useReviewerStore((s) => s.status);
  const server = useReviewerStore((s) => s.server);
  const run = useReviewerStore((s) => (project ? s.runs[project.id] : undefined));
  const suggestion = useReviewerStore((s) => (project ? s.suggestions[project.id] : undefined));
  const projectConfig = useReviewerStore((s) => (project ? s.projectConfigs[project.id] : undefined)) ?? EMPTY_PROJECT_CONFIG;
  const history = useReviewerStore((s) => (project ? s.history[project.id] : undefined));
  const activeProjectId = useReviewerStore((s) => s.activeProjectId);
  const refresh = useReviewerStore((s) => s.refresh);
  const loadProject = useReviewerStore((s) => s.loadProject);
  const startRun = useReviewerStore((s) => s.run);
  const cancel = useReviewerStore((s) => s.cancel);
  const [tab, setTab] = useState<SubTab>("issues");
  const [stageFilter, setStageFilter] = useState<ReviewerStageId | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  useEffect(() => {
    if (project) void loadProject(project).catch((e: unknown) => pushErrorToast(String(e)));
    // Only when the repository changes; the store keeps it current afterwards through events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const running = !!run && !run.summary && activeProjectId === project?.id;
  const busyElsewhere = activeProjectId !== null && activeProjectId !== project?.id;
  const busyName = busyElsewhere
    ? Object.values(projectsByWorkspace).flat().find((p) => p.id === activeProjectId)?.name ?? ""
    : "";
  const summary = run?.summary ?? null;
  const ready = status?.install.ready ?? false;
  const commands = effectiveCommands(projectConfig, suggestion);

  // Before the first review, the stages the configured commands will run.
  const stages: ReviewerStage[] = useMemo(() => {
    if (run) return run.stages;
    const waiting = (id: ReviewerStageId, command: string): ReviewerStage => ({
      id,
      status: command.trim() || id === "sonar" || id === "gate" ? "pending" : "skipped",
      command,
      startedAt: null,
      durationMs: null,
      detail: null,
    });
    return [
      waiting("prepare", commands.prepare),
      waiting("build", commands.build),
      waiting("test", commands.test),
      waiting("sonar", "sonar-scanner"),
      waiting("gate", ""),
    ];
  }, [run, commands.prepare, commands.build, commands.test]);

  if (!project) return null;

  const onRun = async () => {
    try {
      await startRun(project);
      setStageFilter(null);
    } catch (e) {
      const message = String(e);
      pushErrorToast(message.startsWith("busy:") ? t("reviewer.busy") : message);
    }
  };

  const dashboard =
    server.state === "running" && (summary?.projectKey ?? run?.projectKey)
      ? `${server.url}/dashboard?id=${encodeURIComponent(summary?.projectKey ?? run?.projectKey ?? "")}`
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <ServerChip />
        {status && (
          <Tooltip label={t("reviewer.rulesLabel")} description={status.rules ? `Quality Gate: ${status.rules.gate}` : undefined}>
            <button
              type="button"
              onClick={() => useUiStore.getState().openSettingsAt("reviewer", "rules")}
              className={chipClass("neutral")}
            >
              {rulesName(t, status.config.rules.kind)}
            </button>
          </Tooltip>
        )}
        {summary?.commit && (
          <Tooltip label={t("reviewer.analysedCommit")}>
            <span className={chipClass("neutral", "font-mono")}>
              {summary.branch ? `${summary.branch} · ` : ""}
              {summary.commit}
              {summary.dirty ? " *" : ""}
            </span>
          </Tooltip>
        )}
        <span className="flex-1" />
        <Tooltip label={t("reviewer.configure")}>
          <button
            type="button"
            onClick={() => setConfigOpen((open) => !open)}
            aria-pressed={configOpen}
            className={buttonClass({ variant: configOpen ? "secondary" : "ghost", size: "sm" })}
          >
            <Settings2 size={13} />
            {t("reviewer.configure")}
          </button>
        </Tooltip>
        {dashboard && (
          <button
            type="button"
            onClick={() => void openExternalUrl(dashboard).catch((e: unknown) => pushErrorToast(String(e)))}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            SonarQube
            <ExternalLink size={12} />
          </button>
        )}
        {running ? (
          <button type="button" onClick={() => void cancel(project.id)} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <Square size={11} />
            {t("reviewer.stopRun")}
          </button>
        ) : (
          <Tooltip label={busyElsewhere ? t("reviewer.busyIn", { name: busyName }) : !ready ? t("reviewer.notInstalled") : t("reviewer.runHint")}>
            <button
              type="button"
              disabled={!ready || busyElsewhere}
              onClick={() => void onRun()}
              data-tour="reviewer-run"
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              <Play size={12} />
              {t("reviewer.run")}
            </button>
          </Tooltip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status && !ready && (
          <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">
            {t("reviewer.notInstalled")}
            <button
              type="button"
              onClick={() => useUiStore.getState().openSettingsAt("reviewer", "sonarqube")}
              className="text-[var(--cf-accent)] hover:underline"
            >
              {t("reviewer.goDownload")}
            </button>
          </div>
        )}
        {configOpen && <ProjectConfigPanel projectId={project.id} config={projectConfig} suggestion={suggestion} />}

        <StageStrip
          stages={stages}
          selected={stageFilter}
          onSelect={(id) => {
            setStageFilter((current) => (current === id ? null : id));
            setTab("log");
          }}
        />

        {summary && <Verdict summary={summary} />}
        {summary && summary.gate && <Metrics summary={summary} />}

        <div className={`${underlineStripClass} mt-1`} role="tablist">
          <SubTabButton id="issues" active={tab} onSelect={setTab} label={t("reviewer.tabIssues")} count={summary?.issuesTotal} />
          <SubTabButton id="tests" active={tab} onSelect={setTab} label={t("reviewer.tabTests")} count={summary?.tests?.total} />
          <SubTabButton id="coverage" active={tab} onSelect={setTab} label={t("reviewer.tabCoverage")} />
          <SubTabButton id="log" active={tab} onSelect={setTab} label={t("reviewer.tabLog")} />
          <span className="flex-1" />
          <HistoryStrip history={history} />
        </div>

        {tab === "issues" && <IssuesPanel summary={summary} serverUrl={server.state === "running" ? server.url : null} />}
        {tab === "tests" && <TestsPanel summary={summary} />}
        {tab === "coverage" && <CoveragePanel summary={summary} />}
        {tab === "log" && <LogPanel log={run?.log ?? EMPTY_LOG} running={running} stage={stageFilter} onClearStage={() => setStageFilter(null)} />}
      </div>
    </div>
  );
}

const EMPTY_LOG: ReviewerLogLine[] = [];
const EMPTY_CASES: ReviewerTestCase[] = [];

function rulesName(t: Translate, kind: string): string {
  return kind === "strict" ? t("reviewer.rulesStrict") : kind === "max" ? t("reviewer.rulesMax") : kind === "server" ? t("reviewer.rulesServer") : "Sonar way";
}

function ServerChip() {
  const t = useT();
  const server = useReviewerStore((s) => s.server);
  const version = useReviewerStore((s) => s.status?.sonarqubeVersion);
  const short = version?.split(".").slice(0, 2).join(".") ?? "";
  const [tone, text]: [Parameters<typeof chipClass>[0], string] =
    server.state === "running"
      ? ["ok", `SonarQube ${short} · :${server.port}`]
      : server.state === "starting"
        ? ["accent", t("reviewer.serverStarting")]
        : server.state === "failed"
          ? ["bad", t("reviewer.serverFailed")]
          : server.state === "stopping"
            ? ["neutral", t("reviewer.serverStopping")]
            : ["neutral", `SonarQube ${short} · ${t("reviewer.serverStoppedShort")}`];
  return (
    <Tooltip label={t("reviewer.serverChipHint")}>
      <button type="button" onClick={() => useUiStore.getState().openSettingsAt("reviewer", "sonarqube")} className={chipClass(tone)}>
        {server.state === "starting" ? <Loader2 size={10} className="animate-spin" /> : <span className="h-[6px] w-[6px] rounded-full bg-current" />}
        {text}
      </button>
    </Tooltip>
  );
}

function StageStrip({
  stages,
  selected,
  onSelect,
}: {
  stages: ReviewerStage[];
  selected: ReviewerStageId | null;
  onSelect: (id: ReviewerStageId) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-stretch gap-1 px-3 pt-3" data-tour="reviewer-stages">
      {stages.map((stage, index) => (
        <div key={stage.id} className="flex min-w-0 flex-1 items-center gap-1">
          <Tooltip label={stage.command || t(STAGE_LABEL[stage.id])}>
            <button
              type="button"
              onClick={() => onSelect(stage.id)}
              aria-pressed={selected === stage.id}
              className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                selected === stage.id
                  ? "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)]"
                  : stage.status === "failed"
                    ? "border-[color-mix(in_oklab,var(--cf-danger)_45%,var(--cf-border))] bg-[var(--cf-surface-raised)] hover:bg-[var(--cf-hover)]"
                    : "border-[var(--cf-border)] bg-[var(--cf-surface-raised)] hover:bg-[var(--cf-hover)]"
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-[var(--cf-text)]">
                <StageIcon status={stage.status} />
                <span className="truncate">{t(STAGE_LABEL[stage.id])}</span>
              </span>
              <span className="truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                {[stageDetail(t, stage), formatDuration(stage.durationMs)].filter(Boolean).join(" · ")}
              </span>
            </button>
          </Tooltip>
          {index < stages.length - 1 && <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />}
        </div>
      ))}
    </div>
  );
}

const METRIC_LABEL: Record<string, TranslationKey> = {
  coverage: "reviewer.metricCoverage",
  new_coverage: "reviewer.metricCoverage",
  duplicated_lines_density: "reviewer.metricDuplication",
  new_duplicated_lines_density: "reviewer.metricDuplication",
  software_quality_reliability_rating: "reviewer.qualityReliability",
  reliability_rating: "reviewer.qualityReliability",
  software_quality_security_rating: "reviewer.qualitySecurity",
  security_rating: "reviewer.qualitySecurity",
  software_quality_maintainability_rating: "reviewer.qualityMaintainability",
  sqale_rating: "reviewer.qualityMaintainability",
  new_violations: "reviewer.metricNewIssues",
};

function conditionValue(metric: string, value: string | null): string {
  if (value == null) return "—";
  if (metric.endsWith("_rating")) {
    const n = Math.round(Number(value));
    return n >= 1 && n <= 5 ? String.fromCharCode(64 + n) : value;
  }
  if (metric.includes("coverage") || metric.includes("density")) return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} %`;
  return value;
}

function Verdict({ summary }: { summary: ReviewerRunSummary }) {
  const t = useT();
  const failing = summary.gate?.conditions.filter((c) => c.status === "ERROR") ?? [];
  const testsFailed = summary.tests && summary.tests.failed > 0 ? summary.tests.failed : 0;
  const tone =
    summary.status === "passed"
      ? { bg: "color-mix(in oklab, var(--cf-success) 12%, transparent)", fg: "var(--cf-success)", icon: CheckCircle2 }
      : summary.status === "failed"
        ? { bg: "color-mix(in oklab, var(--cf-danger) 11%, transparent)", fg: "var(--cf-danger)", icon: XCircle }
        : summary.status === "cancelled"
          ? { bg: "var(--cf-hover)", fg: "var(--cf-text-muted)", icon: Ban }
          : { bg: "color-mix(in oklab, var(--cf-warning) 13%, transparent)", fg: "var(--cf-warning)", icon: ShieldAlert };
  const Icon = tone.icon;
  const title =
    summary.status === "passed"
      ? t("reviewer.verdictPassed")
      : summary.status === "failed"
        ? t("reviewer.verdictFailed")
        : summary.status === "cancelled"
          ? t("reviewer.verdictCancelled")
          : t("reviewer.verdictError");
  return (
    <div className="mx-3 mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg px-3 py-2" style={{ background: tone.bg, color: tone.fg }}>
      <span className="mr-1 flex items-center gap-1.5 text-[13px] font-semibold">
        <Icon size={14} />
        {title}
      </span>
      {failing.map((condition) => (
        <span key={condition.metric} className="rounded-[5px] border px-1.5 py-[1px] text-[11px]" style={{ borderColor: "currentColor" }}>
          {t(METRIC_LABEL[condition.metric] ?? "reviewer.metricOther", { metric: condition.metric })} {conditionValue(condition.metric, condition.actual)} ·{" "}
          {condition.comparator === "LT"
            ? t("reviewer.atLeast", { value: conditionValue(condition.metric, condition.threshold) })
            : t("reviewer.atMost", { value: conditionValue(condition.metric, condition.threshold) })}
        </span>
      ))}
      {testsFailed > 0 && (
        <span className="rounded-[5px] border px-1.5 py-[1px] text-[11px]" style={{ borderColor: "currentColor" }}>
          {t("reviewer.testsFailing", { n: testsFailed })}
        </span>
      )}
      {summary.error && <span className="min-w-0 break-words text-[11px]">{summary.error.startsWith("scanner:") ? t("reviewer.scannerExit", { code: summary.error.slice(8) }) : summary.error}</span>}
      <span className="flex-1" />
      <span className="text-[11px] opacity-80">{new Date(summary.finishedAt).toLocaleString()}</span>
    </div>
  );
}

function ratingTone(rating: string | null): string {
  if (!rating) return "var(--cf-text-muted)";
  if (rating === "A") return "var(--cf-success)";
  if (rating === "B" || rating === "C") return "var(--cf-warning)";
  return "var(--cf-danger)";
}

function Metrics({ summary }: { summary: ReviewerRunSummary }) {
  const t = useT();
  const m = summary.measures;
  const tests = summary.tests;
  const card = "min-w-0 rounded-lg bg-[var(--cf-hover)] px-2.5 py-2";
  const label = "truncate text-[11px] text-[var(--cf-text-muted)]";
  const rating = (letter: string | null, count: number | null) => (
    <div className="mt-1 flex items-center gap-2">
      <span
        className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[13px] font-bold"
        style={{ color: ratingTone(letter), background: `color-mix(in oklab, ${ratingTone(letter)} 15%, transparent)` }}
      >
        {letter ?? "—"}
      </span>
      <span className="truncate text-[12px] tabular-nums text-[var(--cf-text)]">{t("reviewer.issuesCount", { n: count ?? 0 })}</span>
    </div>
  );
  const coverage = m.coverage;
  return (
    <div className="grid grid-cols-3 gap-1.5 px-3 pt-2.5 lg:grid-cols-6">
      <div className={card}>
        <div className={label}>{t("reviewer.qualityReliability")}</div>
        {rating(m.reliabilityRating, m.reliabilityIssues)}
      </div>
      <div className={card}>
        <div className={label}>{t("reviewer.qualitySecurity")}</div>
        {rating(m.securityRating, m.securityIssues)}
      </div>
      <div className={card}>
        <div className={label}>{t("reviewer.qualityMaintainability")}</div>
        {rating(m.maintainabilityRating, m.maintainabilityIssues)}
      </div>
      <div className={card}>
        <div className={label}>{t("reviewer.metricCoverage")}</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-[var(--cf-text)]">{formatPercent(coverage)}</div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--cf-border)]">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, coverage ?? 0)}%`, background: (coverage ?? 0) >= 80 ? "var(--cf-success)" : "var(--cf-warning)" }} />
        </div>
      </div>
      <div className={card}>
        <div className={label}>{t("reviewer.metricDuplication")}</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-[var(--cf-text)]">{formatPercent(m.duplicatedLinesDensity)}</div>
        <div className="truncate text-[11px] text-[var(--cf-text-muted)]">{m.ncloc != null ? t("reviewer.linesOfCode", { n: m.ncloc.toLocaleString() }) : ""}</div>
      </div>
      <div className={card}>
        <div className={label}>{t("reviewer.metricTests")}</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-[var(--cf-text)]">{tests && tests.files > 0 ? `${tests.passed}/${tests.total}` : "—"}</div>
        <div className="truncate text-[11px]" style={{ color: tests && tests.failed > 0 ? "var(--cf-danger)" : "var(--cf-text-muted)" }}>
          {tests && tests.files > 0 ? (tests.failed > 0 ? t("reviewer.testsFailing", { n: tests.failed }) : formatDuration(tests.durationMs)) : t("reviewer.noTestReport")}
        </div>
      </div>
    </div>
  );
}

function SubTabButton({
  id,
  active,
  onSelect,
  label,
  count,
}: {
  id: SubTab;
  active: SubTab;
  onSelect: (id: SubTab) => void;
  label: string;
  count?: number;
}) {
  return (
    <button type="button" role="tab" aria-selected={active === id} onClick={() => onSelect(id)} className={underlineTabClass(active === id)}>
      {label}
      {count !== undefined && count > 0 && <span className={tabCountClass}>{count}</span>}
      {active === id && <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-[var(--cf-accent)]" />}
    </button>
  );
}

function HistoryStrip({ history }: { history: ReviewerHistoryEntry[] | undefined }) {
  const t = useT();
  if (!history || history.length === 0) return null;
  const recent = history.slice(-12);
  return (
    <span className="flex items-center gap-[3px] self-center text-[11px] text-[var(--cf-text-muted)]">
      <span className="mr-1">{t("reviewer.history")}</span>
      {recent.map((entry) => {
        const color =
          entry.status === "passed" ? "var(--cf-success)" : entry.status === "failed" ? "var(--cf-danger)" : entry.status === "error" ? "var(--cf-warning)" : "var(--cf-text-faint)";
        return (
          <Tooltip
            key={entry.runId}
            label={new Date(entry.finishedAt).toLocaleString()}
            description={[
              entry.coverage != null ? `${t("reviewer.metricCoverage")} ${formatPercent(entry.coverage)}` : null,
              entry.commit,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <span className="h-[9px] w-[9px] rounded-[2px]" style={{ background: color }} />
          </Tooltip>
        );
      })}
    </span>
  );
}

function IssuesPanel({ summary, serverUrl }: { summary: ReviewerRunSummary | null; serverUrl: string | null }) {
  const t = useT();
  const [quality, setQuality] = useState<ReviewerQuality | "all">("all");
  const issues = summary?.issues ?? [];
  const counts = useMemo(() => {
    const out: Record<ReviewerQuality, number> = { reliability: 0, security: 0, maintainability: 0 };
    for (const issue of issues) out[issue.quality] += 1;
    return out;
  }, [issues]);
  const shown = quality === "all" ? issues : issues.filter((i) => i.quality === quality);
  if (!summary) return null;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 border-b border-[var(--cf-border)] px-3 py-2">
        {(["all", "reliability", "security", "maintainability"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setQuality(key)}
            className={chipClass(quality === key ? "accent" : "neutral", "cursor-pointer")}
          >
            {key === "all" ? t("reviewer.filterAll", { n: issues.length }) : `${t(QUALITY_LABEL[key])} ${counts[key]}`}
          </button>
        ))}
      </div>
      {shown.map((issue) => (
        <IssueRow key={issue.key} issue={issue} projectKey={summary.projectKey} serverUrl={serverUrl} />
      ))}
      {summary.issuesTotal > issues.length && (
        <p className="px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">{t("reviewer.moreIssues", { n: summary.issuesTotal - issues.length })}</p>
      )}
    </div>
  );
}

function IssueRow({ issue, projectKey, serverUrl }: { issue: ReviewerIssue; projectKey: string; serverUrl: string | null }) {
  const t = useT();
  const Icon = QUALITY_ICON[issue.quality];
  const open = () => useUiStore.getState().openInEditor(issue.path, issue.line ?? undefined);
  return (
    <div className="group flex min-w-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-3 py-1.5 hover:bg-[var(--cf-hover)]">
      <Tooltip label={`${t(QUALITY_LABEL[issue.quality])} · ${t(SEVERITY_LABEL[issue.severity])}`}>
        <Icon size={14} className="shrink-0" style={{ color: severityColor(issue.severity) }} />
      </Tooltip>
      <button type="button" onClick={open} className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-[13px] text-[var(--cf-text)]">{issue.message}</span>
        <span className="truncate text-[11px] text-[var(--cf-text-muted)]">
          <span className="font-mono">
            {issue.path}
            {issue.line ? `:${issue.line}` : ""}
          </span>
          {" · "}
          {issue.rule} · {t(SEVERITY_LABEL[issue.severity])}
          {issue.effortMinutes ? ` · ${formatEffort(issue.effortMinutes)}` : ""}
        </span>
      </button>
      {serverUrl && (
        <Tooltip label={t("reviewer.openInSonar")}>
          <button
            type="button"
            onClick={() =>
              void openExternalUrl(`${serverUrl}/project/issues?id=${encodeURIComponent(projectKey)}&open=${encodeURIComponent(issue.key)}`).catch(
                (e: unknown) => pushErrorToast(String(e)),
              )
            }
            className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] opacity-0 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] group-hover:opacity-100"
            aria-label={t("reviewer.openInSonar")}
          >
            <ExternalLink size={12} />
          </button>
        </Tooltip>
      )}
      <button type="button" onClick={open} className={buttonClass({ variant: "ghost", size: "sm" })}>
        <FileCode2 size={12} />
        {t("reviewer.openFile")}
      </button>
    </div>
  );
}

export interface SuiteGroup {
  suite: string;
  cases: ReviewerTestCase[];
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/** The cases by suite, the suites in the order the reports first name them. */
export function groupCases(cases: ReviewerTestCase[]): SuiteGroup[] {
  const groups = new Map<string, SuiteGroup>();
  for (const test of cases) {
    let group = groups.get(test.suite);
    if (!group) {
      group = { suite: test.suite, cases: [], passed: 0, failed: 0, skipped: 0, durationMs: 0 };
      groups.set(test.suite, group);
    }
    group.cases.push(test);
    group[test.status] += 1;
    group.durationMs += test.durationMs ?? 0;
  }
  return [...groups.values()];
}

/** One test's time: "12 ms", "1.4 s", and past a minute the stage strip's own format. */
export function formatTestTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  // The backend keeps whole milliseconds, and most unit tests take less than one.
  if (ms === 0) return "<1 ms";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms);
}

type CaseFilter = "all" | ReviewerTestStatus;

const CASE_FILTERS: { id: CaseFilter; labelKey: TranslationKey }[] = [
  { id: "all", labelKey: "reviewer.testsFilterAll" },
  { id: "passed", labelKey: "reviewer.testsFilterPassed" },
  { id: "failed", labelKey: "reviewer.testsFilterFailed" },
  { id: "skipped", labelKey: "reviewer.testsFilterSkipped" },
];

/** Past this many cases the suites start folded, so a big report opens as a list of suites. */
const FOLD_SUITES_ABOVE = 200;

function CaseIcon({ status }: { status: ReviewerTestStatus }) {
  if (status === "failed") return <XCircle size={13} className="shrink-0 text-[var(--cf-danger)]" />;
  if (status === "skipped") return <MinusCircle size={13} className="shrink-0 text-[var(--cf-text-faint)]" />;
  return <CheckCircle2 size={13} className="shrink-0 text-[var(--cf-success)]" />;
}

/**
 * Every case the reports listed — the evidence behind "72 pass", which used to be all the tab said
 * when nothing failed (user report, 2026-10-09). Failures still come first with their stack; below
 * them each suite and its cases, then the report files themselves.
 */
function TestsPanel({ summary }: { summary: ReviewerRunSummary | null }) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<CaseFilter>("all");
  // Suites whose fold the user flipped from the default — see `FOLD_SUITES_ABOVE`.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const tests = summary?.tests;
  const cases = tests?.cases ?? EMPTY_CASES;
  const groups = useMemo(
    () => groupCases(filter === "all" ? cases : cases.filter((test) => test.status === filter)),
    [cases, filter],
  );
  // A new run is a new list: what was folded or filtered was about the last one.
  useEffect(() => {
    setFilter("all");
    setFlipped(new Set());
  }, [summary?.runId]);
  if (!summary) return null;
  if (!tests || tests.files === 0) {
    return <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.noTestReportLong")}</p>;
  }
  const counts: Record<CaseFilter, number> = { all: tests.total, passed: tests.passed, failed: tests.failed, skipped: tests.skipped };
  // A filtered list is short by intent, so it opens unfolded whatever its size.
  const foldedByDefault = filter === "all" && cases.length > FOLD_SUITES_ABOVE;
  const toggleSuite = (suite: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(suite)) next.delete(suite);
      else next.add(suite);
      return next;
    });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--cf-border)] px-3 py-2">
        {/* `formatTestTime`, finer than the stage strip: a fast suite's whole run is milliseconds,
            which the strip's whole seconds round to "0 s". */}
        <p className="min-w-0 flex-1 text-[11px] text-[var(--cf-text-muted)]">
          {t("reviewer.testsSummary", { passed: tests.passed, failed: tests.failed, skipped: tests.skipped, duration: formatTestTime(tests.durationMs) })}
        </p>
        {cases.length > 0 && (
          <div className="flex items-center gap-0.5" role="group">
            {CASE_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                disabled={option.id !== "all" && counts[option.id] === 0}
                onClick={() => setFilter(option.id)}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40 ${
                  filter === option.id
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                }`}
              >
                {t(option.labelKey)}
                <span className="tabular-nums opacity-70">{counts[option.id]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {cases.length === 0 && tests.total > 0 && (
        <p className="border-b border-[var(--cf-border)] px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.testsNoCases")}</p>
      )}
      {cases.length > 0 && cases.length < tests.total && (
        <p className="border-b border-[var(--cf-border)] px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">
          {t("reviewer.testsTruncated", { shown: cases.length, total: tests.total })}
        </p>
      )}
      {(filter === "all" || filter === "failed") && tests.failures.map((failure, index) => (
        <div key={`${failure.suite}-${failure.name}-${index}`} className="border-b border-[var(--cf-border)]">
          <div className="flex min-w-0 items-center gap-2.5 px-3 py-1.5 hover:bg-[var(--cf-hover)]">
            <XCircle size={14} className="shrink-0 text-[var(--cf-danger)]" />
            <button type="button" onClick={() => setOpen(open === index ? null : index)} className="flex min-w-0 flex-1 flex-col text-left">
              <span className="truncate text-[13px] text-[var(--cf-text)]">
                {failure.suite ? `${failure.suite} › ` : ""}
                {failure.name}
              </span>
              <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{failure.message}</span>
            </button>
            {failure.file && (
              <button
                type="button"
                onClick={() => useUiStore.getState().openInEditor(failure.file ?? "", failure.line ?? undefined)}
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                <FileCode2 size={12} />
                {t("reviewer.openFile")}
              </button>
            )}
          </div>
          {open === index && failure.detail && (
            <pre className="mx-3 mb-2 overflow-x-auto rounded-md bg-[var(--cf-sunken)] p-2 font-mono text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {failure.detail}
            </pre>
          )}
        </div>
      ))}
      {/* The failures above carry their stack; under "Fallan" the list below would only repeat them. */}
      {filter !== "failed" &&
        groups.map((group) => {
          const expanded = foldedByDefault === flipped.has(group.suite);
          return (
            <div key={group.suite} className="border-b border-[var(--cf-border)]">
              <button
                type="button"
                onClick={() => toggleSuite(group.suite)}
                aria-expanded={expanded}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--cf-hover)]"
              >
                <ChevronRight
                  size={12}
                  className={`shrink-0 text-[var(--cf-text-faint)] transition-transform duration-100 ${expanded ? "rotate-90" : ""}`}
                />
                <CaseIcon status={group.failed > 0 ? "failed" : group.passed > 0 ? "passed" : "skipped"} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--cf-text)]" title={group.suite}>
                  {group.suite || t("reviewer.testsNoSuite")}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                  {filter === "all" ? `${group.passed}/${group.cases.length}` : group.cases.length}
                  {group.durationMs > 0 ? ` · ${formatTestTime(group.durationMs)}` : ""}
                </span>
              </button>
              {expanded &&
                group.cases.map((test, index) => (
                  <div
                    key={`${test.name}-${index}`}
                    className="group flex min-w-0 items-center gap-2 py-1 pl-[42px] pr-3 hover:bg-[var(--cf-hover)]"
                  >
                    <CaseIcon status={test.status} />
                    <span
                      className={`min-w-0 flex-1 truncate text-[12px] ${
                        test.status === "skipped" ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"
                      }`}
                      title={test.name}
                    >
                      {test.name}
                    </span>
                    {test.file && (
                      <button
                        type="button"
                        onClick={() => useUiStore.getState().openInEditor(test.file ?? "", test.line ?? undefined)}
                        className={buttonClass({ variant: "ghost", size: "sm", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })}
                      >
                        <FileCode2 size={12} />
                        {t("reviewer.openFile")}
                      </button>
                    )}
                    <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                      {formatTestTime(test.durationMs)}
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
      {tests.reports.length > 0 && (
        <div className="px-3 py-2.5">
          <p className="mb-1 text-[11px] font-medium text-[var(--cf-text-muted)]">{t("reviewer.testsReports")}</p>
          {tests.reports.map((path) => (
            <div key={path} className="group flex min-w-0 items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]" title={path}>
                {path}
              </span>
              <Tooltip label={t("reviewer.revealReport")}>
                <button
                  type="button"
                  onClick={() => void revealInFileManager(path).catch((e: unknown) => pushErrorToast(String(e)))}
                  aria-label={t("reviewer.revealReport")}
                  className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] opacity-0 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <FolderOpen size={12} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CoveragePanel({ summary }: { summary: ReviewerRunSummary | null }) {
  const t = useT();
  if (!summary) return null;
  const entries = summary.coverage.filter((e) => e.linesToCover != null && e.linesToCover > 0);
  if (entries.length === 0) {
    return <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.noCoverage")}</p>;
  }
  const folders = entries.filter((e) => !e.isFile);
  const files = entries.filter((e) => e.isFile);
  const row = (entry: (typeof entries)[number]) => (
    <div key={`${entry.isFile}-${entry.path}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,10rem)_8rem] items-center gap-3 border-b border-[var(--cf-border)] px-3 py-1.5">
      {entry.isFile ? (
        <button type="button" onClick={() => useUiStore.getState().openInEditor(entry.path)} className="truncate text-left font-mono text-[12px] text-[var(--cf-text)] hover:underline">
          {entry.path}
        </button>
      ) : (
        <span className="truncate font-mono text-[12px] text-[var(--cf-text)]">{entry.path}/</span>
      )}
      <span className="h-1.5 overflow-hidden rounded-full bg-[var(--cf-hover)]">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.min(100, entry.coverage ?? 0)}%`, background: (entry.coverage ?? 0) >= 80 ? "var(--cf-success)" : "var(--cf-warning)" }}
        />
      </span>
      <span className="text-right text-[11px] tabular-nums text-[var(--cf-text-muted)]">
        {formatPercent(entry.coverage)} · {t("reviewer.uncovered", { n: entry.uncoveredLines ?? 0 })}
      </span>
    </div>
  );
  return (
    <div>
      <p className="border-b border-[var(--cf-border)] px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">
        {t("reviewer.coverageSummary", {
          coverage: formatPercent(summary.measures.coverage),
          lines: (summary.measures.linesToCover ?? 0).toLocaleString(),
          uncovered: (summary.measures.uncoveredLines ?? 0).toLocaleString(),
        })}
      </p>
      {folders.map(row)}
      {files.length > 0 && <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-faint)]">{t("reviewer.worstFiles")}</p>}
      {files.map(row)}
    </div>
  );
}

/** The log of the open review. The last stretch only — a build can print tens of thousands of lines. */
const LOG_SHOWN = 3_000;

function LogPanel({
  log,
  running,
  stage,
  onClearStage,
}: {
  log: ReviewerLogLine[];
  running: boolean;
  stage: ReviewerStageId | null;
  onClearStage: () => void;
}) {
  const t = useT();
  const end = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const filtered = stage ? log.filter((line) => line.stage === stage) : log;
    return filtered.length > LOG_SHOWN ? filtered.slice(filtered.length - LOG_SHOWN) : filtered;
  }, [log, stage]);
  useEffect(() => {
    if (running) end.current?.scrollIntoView({ block: "end" });
  }, [running, lines.length]);
  return (
    <div>
      {stage && (
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
          {t("reviewer.logOfStage", { stage: t(STAGE_LABEL[stage]) })}
          <button type="button" onClick={onClearStage} className="text-[var(--cf-accent)] hover:underline">
            {t("reviewer.logAll")}
          </button>
        </div>
      )}
      {lines.length === 0 ? (
        <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.logEmpty")}</p>
      ) : (
        <pre className="select-text whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-[var(--cf-text-muted)]">
          {lines.map((line) => (
            <div key={line.seq} className={line.text.startsWith("$ ") ? "text-[var(--cf-text)]" : line.text.startsWith("cf:") ? "text-[var(--cf-accent)]" : undefined}>
              {logText(t, line.text)}
            </div>
          ))}
          <div ref={end} />
        </pre>
      )}
    </div>
  );
}

const NOTE_KEY: Record<string, TranslationKey> = {
  "gradle-no-jacoco": "reviewer.noteGradleNoJacoco",
  "vitest-no-coverage": "reviewer.noteVitestNoCoverage",
  "pytest-no-coverage": "reviewer.notePytestNoCoverage",
  "rust-no-coverage": "reviewer.noteRustNoCoverage",
  "dotnet-needs-msbuild": "reviewer.noteDotnet",
  "cpp-not-in-community": "reviewer.noteCpp",
};

/** One repository's stages: what was detected, and what the user changed. */
function ProjectConfigPanel({
  projectId,
  config,
  suggestion,
}: {
  projectId: string;
  config: ReviewerProjectConfig;
  suggestion: ReviewerSuggestion | undefined;
}) {
  const t = useT();
  const save = useReviewerStore((s) => s.saveProjectConfig);
  const commands = effectiveCommands(config, suggestion);
  const [draft, setDraft] = useState({ ...config, ...commands });
  useEffect(() => {
    setDraft({ ...config, ...effectiveCommands(config, suggestion) });
  }, [config, suggestion]);

  const commit = (patch: Partial<ReviewerProjectConfig>) => {
    const next = { ...draft, ...patch, customized: true };
    setDraft(next);
    void save(projectId, next);
  };
  const field = (key: "prepare" | "build" | "test", label: TranslationKey) => (
    <>
      <span className="text-[12px] text-[var(--cf-text-muted)]">{t(label)}</span>
      <input
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => {
          if (draft[key] !== commands[key]) commit({ [key]: draft[key] });
        }}
        placeholder={t("reviewer.stageEmpty")}
        spellCheck={false}
        className={fieldClass({ size: "sm", className: "font-mono" })}
      />
    </>
  );
  return (
    <div className="border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {suggestion?.stacks.map((stack) => (
          <span key={stack} className={chipClass("neutral")}>
            {stack}
          </span>
        ))}
        {suggestion?.hasProperties && <span className={chipClass("info")}>sonar-project.properties</span>}
        <span className="flex-1" />
        {config.customized && (
          <button
            type="button"
            onClick={() => void save(projectId, { ...config, customized: false })}
            className="text-[11px] text-[var(--cf-accent)] hover:underline"
          >
            {t("reviewer.useDetected")}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        {field("prepare", "reviewer.stagePrepare")}
        {field("build", "reviewer.stageBuild")}
        {field("test", "reviewer.stageTest")}
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.exclusions")}</span>
        <input
          value={draft.exclusions}
          onChange={(e) => setDraft({ ...draft, exclusions: e.target.value })}
          onBlur={() => draft.exclusions !== config.exclusions && commit({ exclusions: draft.exclusions })}
          placeholder="**/generated/**, dist/**"
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "font-mono" })}
        />
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.projectKey")}</span>
        <input
          value={draft.projectKey}
          onChange={(e) => setDraft({ ...draft, projectKey: e.target.value })}
          onBlur={() => draft.projectKey !== config.projectKey && commit({ projectKey: draft.projectKey })}
          placeholder={suggestion?.projectKey}
          disabled={suggestion?.hasProperties}
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "font-mono" })}
        />
      </div>
      {suggestion?.notes.map((note) => (
        <p key={note} className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t(NOTE_KEY[note] ?? "reviewer.noteOther")}
        </p>
      ))}
      <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("reviewer.reportsHint")}</p>
    </div>
  );
}
