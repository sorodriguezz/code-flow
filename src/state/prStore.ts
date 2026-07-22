import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast } from "./toastStore";
import { parseClaudeError, type ClaudeErrorInfo } from "../lib/claudeError";
import type { PullRequestSummary } from "../types/domain";

interface PrState {
  prsByProject: Record<string, PullRequestSummary[]>;
  loadingProjectId: string | null;
  loadErrorByProject: Record<string, string>;

  selectedPr: PullRequestSummary | null;
  reviewText: string | null;
  reviewLoading: boolean;
  reviewError: ClaudeErrorInfo | null;
  posting: boolean;
  posted: boolean;

  loadPullRequests: (projectId: string) => Promise<void>;
  selectPr: (pr: PullRequestSummary | null) => void;
  reviewPr: (projectId: string, prId: number) => Promise<void>;
  postReview: (projectId: string, prId: number, content: string) => Promise<void>;
}

export const usePrStore = create<PrState>((set) => ({
  prsByProject: {},
  loadingProjectId: null,
  loadErrorByProject: {},

  selectedPr: null,
  reviewText: null,
  reviewLoading: false,
  reviewError: null,
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

  selectPr: (pr) => set({ selectedPr: pr, reviewText: null, reviewError: null, posted: false }),

  reviewPr: async (projectId, prId) => {
    set({ reviewLoading: true, reviewError: null, reviewText: null, posted: false });
    try {
      const text = await api.reviewPullRequest(projectId, prId);
      set({ reviewText: text });
    } catch (e) {
      set({ reviewError: parseClaudeError(String(e)) });
    } finally {
      set({ reviewLoading: false });
    }
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
