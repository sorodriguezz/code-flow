import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Play, X } from "lucide-react";
import { Button } from "../common/Button";
import { docStripClass, docTabClass } from "../common/recipes";
import { TerminalPane } from "../terminal/TerminalPane";
import { RowAction, StateDot } from "./containerBits";
import { RunContainerDialog } from "./RunContainerDialog";
import { jobBacklog, useContainersJobsStore, type ContainerJob } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";

/**
 * The manager's running jobs — pulls, builds, Compose commands, a project's log — at the foot of
 * whatever page is open, one tab each. They belong to `containersJobsStore`, not to the page that
 * started them, so they keep going when the user looks elsewhere or closes the dock, and their
 * output is all there when they come back. Closing a tab stops a job still running.
 */
export function JobsPanel() {
  const t = useT();
  const jobs = useContainersJobsStore((s) => s.jobs);
  const shown = useContainersJobsStore((s) => s.shown);
  const folded = useContainersJobsStore((s) => s.folded);
  const show = useContainersJobsStore((s) => s.show);
  const close = useContainersJobsStore((s) => s.close);
  const setFolded = useContainersJobsStore((s) => s.setFolded);
  const runtimes = useContainersStore((s) => s.runtimes);
  const [runFrom, setRunFrom] = useState<ContainerJob | null>(null);
  if (jobs.length === 0) return null;
  const job = jobs.find((j) => j.key === shown) ?? jobs[jobs.length - 1];
  const status = jobStatus(job, t);
  const runRuntime = runFrom ? runtimes.find((r) => r.id === runFrom.request.runtime) : undefined;
  const runnable = job.ended && job.code === 0 && !!job.options.runImage;

  return (
    <div className={folded ? "flex shrink-0 flex-col" : "flex h-[44%] min-h-[160px] shrink-0 flex-col"}>
      <div className="flex shrink-0 border-t border-[var(--cf-border)]">
        <div role="tablist" className={`${docStripClass} min-w-0 flex-1`}>
          {jobs.map((item) => {
            const active = !folded && item.key === job.key;
            const running = !item.ended && !item.options.follow;
            return (
              <div
                key={item.key}
                role="tab"
                aria-selected={active}
                onClick={() => show(item.key)}
                title={`${item.title}\n${jobStatus(item, t)}`}
                className={docTabClass(active, "cursor-default text-[12.5px]")}
              >
                <JobGlyph job={item} />
                <span className="min-w-0 truncate">{item.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    close(item.key);
                  }}
                  title={running ? t("containers.m.job.stopClose") : t("common.close")}
                  aria-label={running ? t("containers.m.job.stopClose") : t("common.close")}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-faint)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] pl-2 pr-1.5">
          {!folded && <span className={`max-w-[240px] truncate text-[11.5px] ${job.ended && job.code !== 0 && !job.options.follow ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>{status}</span>}
          {runnable && (
            <Button size="sm" variant="secondary" onClick={() => setRunFrom(job)}>
              <Play size={12} />
              {t("containers.m.run.run")}
            </Button>
          )}
          <RowAction label={folded ? t("containers.m.jobs.unfold") : t("containers.m.jobs.fold")} onClick={() => setFolded(!folded)}>
            {folded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </RowAction>
        </div>
      </div>
      {!folded && (
        <div className="relative flex min-h-0 flex-1 bg-[var(--cf-surface)]">
          {job.sessionId ? (
            <TerminalPane
              key={job.sessionId}
              sessionId={job.sessionId}
              visible
              backlog={() => Promise.resolve(jobBacklog(job.sessionId!))}
              readOnly={job.ended}
              quietExit
            />
          ) : job.error ? (
            <div className="min-w-0 flex-1 whitespace-pre-wrap p-3 text-[12px] text-[var(--cf-danger)]">{job.error}</div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[var(--cf-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
            </div>
          )}
        </div>
      )}
      {runFrom && runRuntime && <RunContainerDialog runtime={runRuntime} context={runFrom.request.context} initialImage={runFrom.options.runImage} onClose={() => setRunFrom(null)} />}
    </div>
  );
}

function JobGlyph({ job }: { job: ContainerJob }) {
  if (!job.ended) return job.options.follow ? <StateDot tone="ok" pulse /> : <Loader2 size={12} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" />;
  if (job.options.follow) return <StateDot tone="idle" />;
  return <StateDot tone={job.code === 0 ? "ok" : "bad"} />;
}

function jobStatus(job: ContainerJob, t: ReturnType<typeof useT>): string {
  if (!job.ended) return job.options.follow ? t("containers.m.live") : t("containers.m.job.running");
  if (job.options.follow) return t("containers.m.job.ended");
  if (job.code === 0) return t("containers.m.job.done");
  return job.code === null ? t("containers.m.job.cut") : t("containers.m.job.failed", { code: job.code });
}
