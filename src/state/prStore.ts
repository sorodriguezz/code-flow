import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast } from "./toastStore";
import { useJobsStore } from "./jobsStore";
import type { PullRequestSummary } from "../types/domain";

interface PrState {
  prsByProject: Record<string, PullRequestSummary[]>;
  loadingProjectId: string | null;
  loadErrorByProject: Record<string, string>;

  selectedPr: PullRequestSummary | null;
  posting: boolean;
  posted: boolean;

  loadPullRequests: (projectId: string) => Promise<void>;
  selectPr: (pr: PullRequestSummary | null) => void;
  /** Fire-and-forget — the run is tracked in `jobsStore`, not here, precisely so it survives
   * switching away from this PR (or this project) before it finishes. */
  reviewPr: (projectId: string, prId: number) => void;
  postReview: (projectId: string, prId: number, content: string) => Promise<void>;
}

export const usePrStore = create<PrState>((set, get) => ({
  prsByProject: {},
  loadingProjectId: null,
  loadErrorByProject: {},

  selectedPr: null,
  posting: false,
  posted: false,

  loadPullRequests: async (projectId) => {
    set((s) => ({ loadingProjectId: projectId, loadErrorByProject: { ...s.loadErrorByProject, [projectId]: "" } }));
    try {
      const prs = await api.listPullRequests(projectId);
      set((s) => ({ prsByProject: { ...s.prsByProject, [projectId]: prs } }));
    } catch (e) {
      set((s) => ({ loadErrorByProject: { ...s.loadErrorByProject, [projectId]: String(e) } }));
    } finally {
      set((s) => (s.loadingProjectId === projectId ? { loadingProjectId: null } : {}));
    }
  },

  selectPr: (pr) => set({ selectedPr: pr, posted: false }),

  reviewPr: (projectId, prId) => {
    const pr = get().prsByProject[projectId]?.find((p) => p.id === prId);
    useJobsStore.getState().run({
      projectId,
      kind: "pr-review",
      label: pr ? `#${pr.id} ${pr.title}` : `PR #${prId}`,
      meta: { prId },
      task: () => api.reviewPullRequest(projectId, prId),
    });
  },

  postReview: async (projectId, prId, content) => {
    set({ posting: true });
    try {
      await api.postPrReviewComment(projectId, prId, content);
      set({ posted: true });
    } catch (e) {
      pushErrorToast(String(e));
      throw e;
    } finally {
      set({ posting: false });
    }
  },
}));
