import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useJobsStore } from "./jobsStore";
import { useLanguageStore } from "./languageStore";
import { translations } from "../lib/i18n/translations";
import type { PullRequestSummary } from "../types/domain";
import type { PrAction } from "../lib/tauri/commands";
import type { ReviewCommentInput } from "../lib/parseAnalysis";

/** Translates outside of React (this store isn't a component) using whatever language is
 * currently selected — same lookup `useT()` does, just without the hook. */
function translate(key: keyof typeof translations.en): string {
  const language = useLanguageStore.getState().language;
  return translations[language][key] ?? translations.en[key] ?? key;
}

interface PrState {
  prsByProject: Record<string, PullRequestSummary[]>;
  loadingProjectId: string | null;
  loadErrorByProject: Record<string, string>;

  selectedPr: PullRequestSummary | null;
  posting: boolean;
  posted: boolean;
  /** Which PR action (approve / request_changes / close) is in flight, so its button can show a
   * spinner and the others disable while it runs. `null` when idle. */
  prActionBusy: PrAction | null;

  loadPullRequests: (projectId: string) => Promise<void>;
  selectPr: (pr: PullRequestSummary | null) => void;
  /** Fire-and-forget — the run is tracked in `jobsStore`, not here, precisely so it survives
   * switching away from this PR (or this project) before it finishes. */
  reviewPr: (projectId: string, prId: number) => void;
  /** One Azure DevOps comment thread per finding (anchored to its file/line when known) plus
   * a summary thread — not one comment with the whole review. */
  postReview: (projectId: string, prId: number, comments: ReviewCommentInput[]) => Promise<void>;
  /** Approve / request changes / close the PR on its host (GitHub or Azure DevOps). Refreshes
   * the PR list afterward so the new status shows, and drops the selection when it was closed. */
  actOnPr: (projectId: string, prId: number, action: PrAction) => Promise<void>;
}

export const usePrStore = create<PrState>((set, get) => ({
  prsByProject: {},
  loadingProjectId: null,
  loadErrorByProject: {},

  selectedPr: null,
  posting: false,
  posted: false,
  prActionBusy: null,

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
      task: (jobId) => api.reviewPullRequest(projectId, prId, jobId),
    });
  },

  postReview: async (projectId, prId, comments) => {
    set({ posting: true });
    try {
      await api.postPrReviewComment(projectId, prId, comments);
      set({ posted: true });
    } catch (e) {
      pushErrorToast(String(e));
      throw e;
    } finally {
      set({ posting: false });
    }
  },

  actOnPr: async (projectId, prId, action) => {
    set({ prActionBusy: action });
    try {
      await api.actOnPullRequest(projectId, prId, action);
      // Reflect the new state (e.g. a closed PR leaves the "open" bucket); when it was closed
      // there's nothing left to act on, so return to chat.
      await get().loadPullRequests(projectId);
      if (action === "close") {
        set((s) => (s.selectedPr?.id === prId ? { selectedPr: null } : {}));
      } else {
        // Keep the selection pointing at the refreshed PR object so its status/buttons update.
        set((s) => ({ selectedPr: s.prsByProject[projectId]?.find((p) => p.id === prId) ?? s.selectedPr }));
      }
      const key = action === "approve" ? "pr.approved" : action === "request_changes" ? "pr.changesRequested" : "pr.closed";
      useToastStore.getState().pushToast(translate(key), "success");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      set({ prActionBusy: null });
    }
  },
}));
