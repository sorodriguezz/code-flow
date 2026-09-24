import { analyzeWorkingChanges, NOTHING_TO_ANALYZE_MARKER } from "./tauri/commands";
import { workspaceIdFromBucket } from "./prTarget";
import { whenRepoFree } from "./repoQueue";
import { jobPrUrl, type ActivityEntry } from "./activityEntries";
import { useJobsStore, type Job } from "../state/jobsStore";
import { linkSessionFromMeta, usePrStore } from "../state/prStore";
import { useChatStore } from "../state/chatStore";
import { translate } from "../state/languageStore";
import { useRepoStore } from "../state/repoStore";
import { useToastStore } from "../state/toastStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { CANCELLED_MARKER } from "../state/aiRunStore";
import {
  analysisTabKey,
  chatTabKey,
  prLinkTabKey,
  prTabKey,
  useAiPanelStore,
  type PanelTarget,
} from "../state/aiPanelStore";
import type { TrackedPr } from "../state/prWatchStore";

/**
 * The ways into the assistant panel, written once.
 *
 * Opening "a row" used to be implemented three times — the panel's Activity section, its "view
 * all" modal and the notification centre — and the three disagreed about what to clear first. Every
 * caller now resolves what it holds (a job, an Activity row, a tracked PR) into a `PanelTarget` here
 * and hands it to `aiPanelStore.open`, which is the only thing that decides what is on screen.
 */

/** The tab a job's result is shown in — `null` for work that does not live in the panel. */
export function tabKeyForJob(job: Job): string | null {
  const url = jobPrUrl(job);
  if (url) return prLinkTabKey(url);
  if ((job.kind === "pr-review" || job.kind === "pr-action") && typeof job.meta.prId === "number") {
    return prTabKey(job.projectId, job.meta.prId);
  }
  if (job.kind === "analyze-changes") return analysisTabKey(job.projectId);
  return null;
}

/** Every job this session knows of, across buckets. A job id is unique whichever bucket it is in. */
export function findJob(jobId: string): Job | null {
  for (const jobs of Object.values(useJobsStore.getState().byProject)) {
    const job = jobs.find((j) => j.id === jobId);
    if (job) return job;
  }
  return null;
}

/**
 * Puts a job's result on screen: the pull request it reviewed (from its link, when it had no clone
 * behind it), or the analysis it produced — pinned to that very run. `finding` opens that finding.
 *
 * Resolves to `false` when there is nothing to open (a row predating the metadata a link review
 * needs, a PR the host no longer answers for): the screen is left as it was rather than moved
 * somewhere empty.
 */
export async function openJob(job: Job, finding?: string | null): Promise<boolean> {
  const linkWorkspace = workspaceIdFromBucket(job.projectId);
  if (linkWorkspace) {
    const session = linkSessionFromMeta(job.meta, linkWorkspace);
    if (!session) return false;
    useAiPanelStore.getState().open({ kind: "prLink", session, finding });
    return true;
  }
  if (job.kind === "pr-review" || job.kind === "pr-action") {
    const prId = job.meta.prId;
    if (typeof prId !== "number") return false;
    // Fetched rather than read off whatever the sidebar last loaded: the list waits to be unfolded,
    // and a row has to open whether or not it ever was.
    const pr = await usePrStore.getState().ensureProjectPr(job.projectId, prId);
    if (!pr) return false;
    useAiPanelStore.getState().open({ kind: "pr", projectId: job.projectId, pr, finding });
    return true;
  }
  if (job.kind === "analyze-changes") {
    useAiPanelStore.getState().open({ kind: "analysis", projectId: job.projectId, jobId: job.id, finding });
    return true;
  }
  if (job.kind === "pipeline-analyze") {
    // Not the panel: a pipeline analysis belongs under the log it is about.
    const { openPipelineAnalysis } = await import("../state/ciStore");
    await openPipelineAnalysis(job);
    return true;
  }
  return false;
}

/** [`openJob`] by id — what a notification or a status-bar row carries. */
export async function openJobById(jobId: string, finding?: string | null): Promise<boolean> {
  const job = findJob(jobId);
  return job ? openJob(job, finding) : false;
}

/** A conversation, in its tab. Reads it back from disk when this session has not got it. */
export async function openChat(projectId: string, conversationId: string): Promise<void> {
  useAiPanelStore.getState().open({ kind: "chat", projectId, conversationId });
  await useChatStore.getState().ensureLoaded(projectId, conversationId);
}

/** A blank conversation in `projectId` — the one it already has, if there is one. */
export function openNewChat(projectId: string): string {
  return useAiPanelStore.getState().open({ kind: "chat", projectId });
}

/** One row of the Inbox's history. */
export async function openActivityEntry(entry: ActivityEntry): Promise<boolean> {
  if (entry.type === "chat") {
    await openChat(entry.conv.project_id, entry.conv.session_id);
    return true;
  }
  return openJob(entry.job);
}

/** A pull request still waiting on a decision (the Inbox's "needs you"). */
export async function openTrackedPr(entry: TrackedPr): Promise<boolean> {
  if (entry.kind === "link" && entry.url) {
    useAiPanelStore.getState().open({
      kind: "prLink",
      session: {
        url: entry.url,
        pr: entry.pr,
        repoLabel: entry.repoLabel,
        cloneUrl: entry.cloneUrl ?? "",
        workspaceId: entry.workspaceId,
      },
    });
    return true;
  }
  if (!entry.projectId) return false;
  // The snapshot opens it at once; the review refreshes it from the host on its own.
  useAiPanelStore.getState().open({ kind: "pr", projectId: entry.projectId, pr: entry.pr });
  return true;
}

/** The two spellings of one folder: a trailing separator is not a different repository. */
function samePath(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.replace(/[/\\]+$/, "") === b.replace(/[/\\]+$/, "");
}

function projectPath(projectId: string): string | null {
  const projects = Object.values(useWorkspaceStore.getState().projectsByWorkspace).flat();
  return projects.find((p) => p.id === projectId)?.local_path ?? null;
}

/**
 * How many files an analysis of `projectId` would read: its unstaged and untracked changes, which is
 * the diff `analyze_working_changes` takes (index → working tree — staged changes are not in it).
 *
 * `null` when this window holds no status for that repository — it keeps the open repository's
 * only — and `null` is not a no: the backend refuses an empty tree on its own.
 */
export function changesToAnalyze(projectId: string): number | null {
  const { repoPath, status } = useRepoStore.getState();
  if (!status || !samePath(repoPath, projectPath(projectId))) return null;
  return status.unstaged.length + status.untracked.length;
}

/** `changesToAnalyze`, kept current — what turns every "Analyze changes" button off. */
export function useChangesToAnalyze(projectId: string | null): number | null {
  const localPath = useWorkspaceStore((s) =>
    projectId ? (Object.values(s.projectsByWorkspace).flat().find((p) => p.id === projectId)?.local_path ?? null) : null,
  );
  const repoPath = useRepoStore((s) => s.repoPath);
  const status = useRepoStore((s) => s.status);
  if (!status || !samePath(repoPath, localPath)) return null;
  return status.unstaged.length + status.untracked.length;
}

/**
 * Starts a change analysis of `projectId`'s working tree and points its tab at the new run.
 *
 * Refuses to start a second one while one is running or queued there — the button that calls this
 * would otherwise be a way to pile up identical runs. Waits for the repository instead of failing
 * when a chat or a fix holds it (see `repoQueue`).
 *
 * Refuses, too, when there is nothing to analyze. The buttons are off by then; this is for whatever
 * calls it without one. An empty diff used to reach the engine and come back as a failed run.
 */
export function startAnalysis(projectId: string): string | null {
  const running = (useJobsStore.getState().byProject[projectId] ?? []).find(
    (job) => job.kind === "analyze-changes" && job.status === "running",
  );
  if (running) {
    useAiPanelStore.getState().setAnalysisJob(projectId, running.id);
    return running.id;
  }
  if (changesToAnalyze(projectId) === 0) {
    useToastStore.getState().pushToast(translate("analyze.nothingToAnalyze"), "info");
    return null;
  }
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const id = useJobsStore.getState().run({
    projectId,
    kind: "analyze-changes",
    // A per-run time stamp in the label so each analysis is identifiable in the history instead of
    // every entry reading the same "Change analysis".
    label: `${translate("analyze.title")} · ${time}`,
    task: (jobId) =>
      whenRepoFree(projectId, jobId, () => analyzeWorkingChanges(projectId, jobId)).catch((e: unknown) => {
        if (!String(e).includes(NOTHING_TO_ANALYZE_MARKER)) throw e;
        // The tree emptied between the click and the run. Not a failed analysis — there was nothing
        // to analyze — so the row goes rather than turning red, and the reason is said once. Thrown
        // on as a cancellation, which is what keeps the job runner from notifying a failure.
        void useJobsStore.getState().remove(projectId, jobId);
        useAiPanelStore.getState().setAnalysisJob(projectId, null);
        useToastStore.getState().pushToast(translate("analyze.nothingToAnalyze"), "info");
        throw new Error(`${CANCELLED_MARKER}nothing-to-analyze`);
      }),
  });
  useAiPanelStore.getState().setAnalysisJob(projectId, id);
  return id;
}

/** Opens the analysis tab of `projectId`; `run` starts a fresh analysis there (the Changes button). */
export function openAnalysis(projectId: string, opts: { run?: boolean; jobId?: string | null } = {}): void {
  useAiPanelStore.getState().open({ kind: "analysis", projectId, jobId: opts.jobId });
  if (opts.run) startAnalysis(projectId);
}

/** The target a notification or status-bar row selects, as a tab key — for unread marks. */
export function tabKeyForSelect(select: { kind: string; id: string }): string | null {
  switch (select.kind) {
    case "chatConversation":
      return chatTabKey(select.id);
    case "job": {
      const job = findJob(select.id);
      return job ? tabKeyForJob(job) : null;
    }
    case "finding": {
      const job = findJob(select.id.split("::")[0]);
      return job ? tabKeyForJob(job) : null;
    }
    case "pullRequest": {
      const [project, prId] = select.id.split("::");
      const id = Number(prId);
      return project && Number.isFinite(id) ? prTabKey(project, id) : null;
    }
    default:
      return null;
  }
}

export type { PanelTarget };
