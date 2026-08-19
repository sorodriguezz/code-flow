import { create } from "zustand";
import { useJobsStore } from "./jobsStore";
import { useWorkspaceStore } from "./workspaceStore";

interface AnalyzeUiState {
  /**
   * Which repositories have the change analysis open, keyed by project id.
   *
   * This used to be one app-wide boolean meaning "the AI panel is showing an analysis", and the
   * panel then drew that analysis for whichever project happened to be active. So opening one in
   * `api-gateway` put *every other* repository's panel into the analysis view as well, where it
   * looked up a pinned job id in a bucket that never contained it, found nothing, and rendered a
   * ThinkingOrb that could never finish — with Refresh disabled by the same flag and the auto-start
   * suppressed by the pin. That is the reported "the loading state takes over the other windows",
   * in its second incarnation. Keyed per project, a repository's panel only ever answers for its
   * own analysis, and one left open in another repo is invisible here rather than contagious.
   */
  open: Record<string, boolean>;
  /**
   * The specific analysis run shown for each project, pinned by job id when opened from the
   * Activity list. Absent (or `null`) means "that project's most recent analysis" — a fresh open or
   * a brand-new run.
   *
   * Two separate aliasing bugs are what this shape prevents: without the pin every analyze row
   * resolved to the newest run, and without the per-project key one project's pin was looked up in
   * another project's history, which is a miss rather than a mismatch and so read as "still
   * loading" forever.
   */
  selectedJobId: Record<string, string | null>;
  /**
   * Opens a specific past analysis by its job id (from an Activity row).
   *
   * `projectId` is which repository's panel this belongs to, and it stays optional because the
   * callers that arrive here from a row hold the job, not the bucket it is filed under. Omitted, it
   * is the job's **own** bucket that answers — deliberately consulted before the project on screen,
   * because a notification followed from another workspace lands here right after `focusProject`
   * and inferring the owner from the screen is precisely how a pin ends up filed against the wrong
   * repository. The active project is only the last resort, for a job no longer held in memory.
   */
  showJob: (jobId: string, projectId?: string) => void;
  /**
   * Opens the section on that project's *latest* analysis, with no particular past run pinned — a
   * fresh open from the Changes panel, which then starts a new run if the repository has never been
   * analysed (see `AnalyzeSection`'s auto-start).
   *
   * `projectId` defaults to the repository on screen, which is the only thing this can mean: the
   * button that calls it sits above that repository's own working changes.
   */
  show: (projectId?: string | null) => void;
  /**
   * Closes the section for one project — by default the one on screen, which is what every caller
   * saying "put away whatever the panel is showing" means.
   *
   * Another repository's open analysis is deliberately left alone: it is not on screen to be hidden,
   * and closing it would drop the run it is pinned to on a user who never asked.
   */
  hide: (projectId?: string | null) => void;
}

/** Purely a UI toggle for which "not chat" view the AI panel currently shows (change
 * analysis vs a selected PR vs the free-form chat) plus which analysis run is pinned — the
 * analysis jobs themselves live in `jobsStore` and keep running regardless of this. */
export const useAnalyzeUiStore = create<AnalyzeUiState>((set) => ({
  open: {},
  selectedJobId: {},
  showJob: (jobId, projectId) => {
    // `Object.entries` over the buckets rather than a lookup by name: a job knows its bucket, the
    // caller usually doesn't, and asking the store that actually owns the row is the only answer
    // that stays right when this is reached from a notification fired in another workspace.
    const owner =
      projectId ??
      Object.entries(useJobsStore.getState().byProject).find(([, jobs]) =>
        jobs.some((job) => job.id === jobId),
      )?.[0] ??
      useWorkspaceStore.getState().activeProjectId;
    if (!owner) return;
    set((s) => ({
      open: { ...s.open, [owner]: true },
      selectedJobId: { ...s.selectedJobId, [owner]: jobId },
    }));
  },
  show: (projectId) => {
    const owner = projectId ?? useWorkspaceStore.getState().activeProjectId;
    if (!owner) return;
    set((s) => ({
      open: { ...s.open, [owner]: true },
      selectedJobId: { ...s.selectedJobId, [owner]: null },
    }));
  },
  hide: (projectId) => {
    const owner = projectId ?? useWorkspaceStore.getState().activeProjectId;
    if (!owner) return;
    set((s) => ({
      open: { ...s.open, [owner]: false },
      selectedJobId: { ...s.selectedJobId, [owner]: null },
    }));
  },
}));
