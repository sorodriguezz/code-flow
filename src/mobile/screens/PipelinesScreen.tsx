import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  ExternalLink,
  Loader2,
  MinusCircle,
  RotateCcw,
  Square,
  TriangleAlert,
  Workflow,
  XCircle,
} from "lucide-react";
import { t, type MobileKey } from "../i18n";
import { rpc, Unpaired } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { useNav } from "../nav";
import { navigated } from "../haptics";
import { sinceIso } from "../time";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
import { ConfirmAction } from "../ui/ConfirmAction";
import type {
  PipelineAvailability,
  PipelineRun,
  PipelineRunDetail,
  PipelineStatus,
} from "../../types/domain";

/**
 * A repository's pipelines, and one run's jobs.
 *
 * The desktop's Pipelines tab, cut to what a phone is picked up for: *did it pass*, *what broke*,
 * and the two verbs that answer a red run from wherever you are — run it again, or stop one that is
 * going wrong. Starting a run from scratch, answering a deployment gate and downloading artifacts
 * are not here, and not in the allowlist either (see `remotectl/dispatch.rs`).
 *
 * # Polled, while something is moving
 *
 * Nothing on the desktop emits when a host's run changes — the host is the one that knows — so the
 * desktop tab polls, and so does this: every 15 seconds while a run on screen is queued or running
 * and the page is visible, and not at all otherwise.
 */

const POLL_MS = 15_000;

type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

const TONE: Record<PipelineStatus, Tone> = {
  queued: "warning",
  running: "accent",
  success: "success",
  warning: "warning",
  failed: "danger",
  cancelled: "neutral",
  skipped: "neutral",
};

const LABEL: Record<PipelineStatus, MobileKey> = {
  queued: "pipelines.status.queued",
  running: "pipelines.status.running",
  success: "pipelines.status.success",
  warning: "pipelines.status.warning",
  failed: "pipelines.status.failed",
  cancelled: "pipelines.status.cancelled",
  skipped: "pipelines.status.skipped",
};

function moving(status: PipelineStatus): boolean {
  return status === "queued" || status === "running";
}

function StatusIcon({ status, size = 15 }: { status: PipelineStatus; size?: number }) {
  const tone = {
    success: "text-[var(--cf-success-text)]",
    danger: "text-[var(--cf-danger-text)]",
    warning: "text-[var(--cf-warning-text)]",
    accent: "text-[var(--cf-accent-text)]",
    neutral: "text-[var(--cf-text-faint)]",
  }[TONE[status]];
  const Icon = {
    queued: Clock,
    running: Loader2,
    success: CheckCircle2,
    warning: TriangleAlert,
    failed: XCircle,
    cancelled: Ban,
    skipped: MinusCircle,
  }[status];
  return <Icon size={size} className={`shrink-0 ${tone} ${status === "running" ? "animate-spin" : ""}`} aria-hidden />;
}

function StatusBadge({ status }: { status: PipelineStatus }) {
  return <Badge tone={TONE[status]}>{t(LABEL[status])}</Badge>;
}

/** `3:07`, or `1:02:44` — how long a job took, or has been running. Nothing for one not started. */
function duration(started: string | null, finished: string | null): string {
  if (!started) return "";
  const from = Date.parse(started);
  const to = finished ? Date.parse(finished) : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return "";
  const seconds = Math.round((to - from) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Re-reads `load` every [`POLL_MS`] while `active` and the page is visible — the one polling loop
 * in this client, and bounded to the screen that needs it.
 */
function usePoll(active: boolean, load: () => unknown) {
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [active, load]);
}

/**
 * The runs of the repository in scope, newest first — the PRs tab's second view.
 *
 * Takes the tab's app bar rather than drawing one, so the segmented control above it stays exactly
 * where it was when the view switched.
 */
export function PipelinesView({ bar, projectId }: { bar: ReactNode; projectId: string }) {
  const push = useNav((s) => s.push);
  const [availability, setAvailability] = useState<PipelineAvailability | null>(null);
  const [runs, setRuns] = useState<PipelineRun[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const found = await rpc<PipelineAvailability>("pipeline_availability", { projectId });
      const list =
        found.provider && found.connected
          ? await rpc<PipelineRun[]>("list_pipeline_runs", { projectId, limit: 30 })
          : [];
      // The scope may have moved while this was in flight — the guard every load here needs.
      if (useMobileStore.getState().projectId !== projectId) return;
      setAvailability(found);
      setRuns(list);
      setFailure(null);
    } catch (e) {
      if (e instanceof Unpaired) {
        useMobileStore.setState({ unpaired: true });
        return;
      }
      if (useMobileStore.getState().projectId !== projectId) return;
      // The last list stays on screen under the error, rather than turning into "no runs".
      setFailure(message(e));
    }
  }, [projectId]);

  // A new project starts from nothing rather than from the last one's runs: the tab root is not
  // remounted when the scope moves, and a list that is correct about the wrong repository is the one
  // thing a screen here must never draw.
  useEffect(() => {
    setAvailability(null);
    setRuns(null);
    setFailure(null);
  }, [projectId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  usePoll(Boolean(runs?.some((run) => moving(run.status))), reload);

  let body: ReactNode;
  if (runs === null && failure === null) {
    body = (
      <Section>
        <SkeletonList rows={4} />
      </Section>
    );
  } else if (failure !== null && !runs?.length) {
    body = <ErrorState title={t("pipelines.failed")} detail={failure} onRetry={() => void reload()} />;
  } else if (availability && !availability.provider) {
    body = <EmptyState icon={<Workflow size={26} aria-hidden />} title={t("pipelines.notLinked")} />;
  } else if (availability && !availability.connected) {
    body = (
      <EmptyState
        icon={<Workflow size={26} aria-hidden />}
        title={t("pipelines.notConnected", { host: availability.host ?? "" })}
      />
    );
  } else if (!runs?.length) {
    body = <EmptyState icon={<Workflow size={26} aria-hidden />} title={t("pipelines.none")} />;
  } else {
    body = (
      <Section>
        <Card>
          {runs.map((run, index) => (
            <div key={run.id}>
              {index > 0 && <Divider inset />}
              <Row
                leading={<StatusIcon status={run.status} />}
                title={run.name}
                subtitle={[run.number !== null ? `#${run.number}` : null, run.branch, sinceIso(run.created_at)]
                  .filter(Boolean)
                  .join(" · ")}
                trailing={run.gated ? <Badge tone="accent">{t("pipelines.gated")}</Badge> : <StatusBadge status={run.status} />}
                onClick={() => {
                  navigated();
                  push({ k: "pipeline", projectId, runId: run.id, title: run.name });
                }}
              />
            </div>
          ))}
        </Card>
      </Section>
    );
  }

  return (
    <Screen bar={bar} onRefresh={reload}>
      {body}
    </Screen>
  );
}

/** One run: its jobs, and re-run / cancel behind a confirmation. */
export function PipelineRunScreen({
  projectId,
  runId,
  title,
}: {
  projectId: string;
  runId: string;
  title: string;
}) {
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("pipelines");
  const [detail, setDetail] = useState<PipelineRunDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await rpc<PipelineRunDetail>("pipeline_run_detail", { projectId, runId });
      setDetail(next);
      setFailure(null);
    } catch (e) {
      if (e instanceof Unpaired) {
        useMobileStore.setState({ unpaired: true });
        return;
      }
      setFailure(message(e));
    }
  }, [projectId, runId]);

  useEffect(() => {
    void reload();
  }, [reload]);
  usePoll(Boolean(detail && moving(detail.run.status)), reload);

  /** Runs one of the two verbs, then re-reads once the host has had a moment to register it. */
  const act = (cmd: "rerun_pipeline" | "cancel_pipeline", success: string, failedOnly = false) =>
    void run(
      async () => {
        await rpc<void>(cmd, cmd === "rerun_pipeline" ? { projectId, runId, failedOnly } : { projectId, runId });
        window.setTimeout(() => void reload(), 2000);
      },
      "pipelines",
      success,
    );

  const current = detail?.run;
  const subtitle = current
    ? [current.number !== null ? `#${current.number}` : null, current.branch, sinceIso(current.created_at)]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  return (
    <Screen
      bar={
        <PushBar
          title={title}
          subtitle={subtitle}
          actions={
            current?.web_url ? (
              <a
                href={current.web_url}
                target="_blank"
                rel="noreferrer"
                aria-label={t("pr.openInHost")}
                className="cf-tap cf-press flex items-center justify-center rounded-md px-2 text-[var(--cf-text-muted)]"
              >
                <ExternalLink size={17} aria-hidden />
              </a>
            ) : undefined
          }
        />
      }
      onRefresh={reload}
    >
      {!detail && !failure ? (
        <Section>
          <SkeletonList rows={4} />
        </Section>
      ) : !detail ? (
        <ErrorState title={t("pipelines.failed")} detail={failure} onRetry={() => void reload()} />
      ) : (
        <>
          <Section>
            <Card padded>
              <div className="flex items-center gap-2">
                <StatusIcon status={detail.run.status} size={18} />
                <span className="min-w-0 flex-1 truncate text-md font-medium">{detail.run.commit_title ?? detail.run.name}</span>
                <StatusBadge status={detail.run.status} />
              </div>
              <div className="mt-3 flex gap-2">
                {moving(detail.run.status) ? (
                  <ConfirmAction
                    label={t("pipelines.cancel")}
                    confirmLabel={t("pipelines.cancelConfirm")}
                    icon={<Square size={13} />}
                    variant="danger"
                    disabled={busy}
                    onConfirm={() => act("cancel_pipeline", t("toast.pipelineCancelled"))}
                  />
                ) : (
                  <>
                    <ConfirmAction
                      label={t("pipelines.rerun")}
                      confirmLabel={t("pipelines.rerunConfirm")}
                      icon={<RotateCcw size={13} />}
                      variant="primary"
                      disabled={busy}
                      onConfirm={() => act("rerun_pipeline", t("toast.pipelineRerun"))}
                    />
                    {/* Only where the host has a verb for it: GitLab's retry already re-runs just the
                        failed jobs, and Azure can only queue the whole definition again. */}
                    {detail.run.provider === "github" && detail.run.status === "failed" && (
                      <ConfirmAction
                        label={t("pipelines.rerunFailed")}
                        confirmLabel={t("pipelines.rerunFailedConfirm")}
                        icon={<RotateCcw size={13} />}
                        variant="secondary"
                        disabled={busy}
                        onConfirm={() => act("rerun_pipeline", t("toast.pipelineRerun"), true)}
                      />
                    )}
                  </>
                )}
              </div>
            </Card>
          </Section>

          <Section title={t("pipelines.jobs")}>
            {detail.jobs.length === 0 ? (
              <p className="flex items-center gap-1.5 px-1 text-base text-[var(--cf-text-muted)]">
                <CircleDashed size={14} aria-hidden />
                {t("pipelines.noJobs")}
              </p>
            ) : (
              <Card>
                {detail.jobs.map((job, index) => (
                  <div key={job.id}>
                    {index > 0 && <Divider inset />}
                    <Row
                      leading={<StatusIcon status={job.status} />}
                      title={job.name}
                      subtitle={[job.stage, duration(job.started_at, job.finished_at)].filter(Boolean).join(" · ") || undefined}
                      trailing={<StatusBadge status={job.status} />}
                    />
                  </div>
                ))}
              </Card>
            )}
          </Section>
        </>
      )}
    </Screen>
  );
}
