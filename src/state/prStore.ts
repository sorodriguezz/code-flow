import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useJobsStore } from "./jobsStore";
import { useChatStore } from "./chatStore";
import { useLanguageStore } from "./languageStore";
import { translations } from "../lib/i18n/translations";
import type { PrDecision, PullRequestSummary } from "../types/domain";
import type { PrAction, PostFindingItem } from "../lib/tauri/commands";

/** Cache key for a PR's decision — a PR id is only unique within its project. */
const decisionKey = (projectId: string, prId: number) => `${projectId}:${prId}`;

/** Review depth, mirroring the WF-PR-REVIEWER levels. `completo` is the default. */
export type ReviewLevel = "basico" | "completo" | "ultra";

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
  /** Depth the next review runs at — shared so both the AI panel selector and the title-bar
   * shortcut launch at the same level. */
  reviewLevel: ReviewLevel;
  posting: boolean;
  posted: boolean;
  /** Which PR action (approve / request_changes / close) is in flight, so its button can show a
   * spinner and the others disable while it runs. `null` when idle. */
  prActionBusy: PrAction | null;

  loadPullRequests: (projectId: string) => Promise<void>;
  selectPr: (pr: PullRequestSummary | null) => void;
  setReviewLevel: (level: ReviewLevel) => void;
  /** Fire-and-forget — the run is tracked in `jobsStore`, not here, precisely so it survives
   * switching away from this PR (or this project) before it finishes. Uses `reviewLevel` unless
   * an explicit `level` is passed. */
  reviewPr: (projectId: string, prId: number, level?: ReviewLevel) => void;
  /** One comment thread per finding (anchored to its file/line when known) plus an optional
   * summary thread — reconciled against the saved run (`runId`) so a finding keeps one thread
   * across re-reviews. `items` are the human-selected findings. */
  postReview: (
    projectId: string,
    prId: number,
    runId: string,
    items: PostFindingItem[],
    postSummary: boolean,
    summary: string | null,
  ) => Promise<void>;
  /** What the signed-in user has already decided on a PR, keyed `${projectId}:${prId}`. Read from
   * the host, so an approval given on the website locks the buttons here too. */
  decisionByPr: Record<string, PrDecision>;
  /** Fetches (and caches) that decision — called when a PR is opened. Silent on failure: not
   * knowing the decision must never block reviewing the PR. */
  loadPrDecision: (projectId: string, prId: number) => Promise<void>;
  /** Approve / request changes / close the PR on its host (GitHub or Azure DevOps).
   *
   * The PR stays selected afterwards, in the state the host reports back — closing one used to
   * drop it out of the panel, which read as "it vanished" rather than "it's closed". The decision
   * is filed in Activity and remembered here, so the action can't be taken twice. */
  actOnPr: (projectId: string, prId: number, action: PrAction) => Promise<void>;
  /** Opens a PR on the project's linked host, then refreshes the list and selects the new PR.
   * Throws on failure so the caller (the modal) can keep itself open and surface the error. */
  createPr: (
    projectId: string,
    input: { title: string; description: string; sourceBranch: string; targetBranch: string; draft: boolean },
  ) => Promise<PullRequestSummary>;
}

export const usePrStore = create<PrState>((set, get) => ({
  prsByProject: {},
  loadingProjectId: null,
  loadErrorByProject: {},

  selectedPr: null,
  reviewLevel: "completo",
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

  setReviewLevel: (level) => set({ reviewLevel: level }),

  reviewPr: (projectId, prId, level) => {
    // The current selection is a valid source for the label too: a review launched straight from
    // a pasted link starts before that project's PR list has finished loading.
    const selected = get().selectedPr;
    const pr =
      get().prsByProject[projectId]?.find((p) => p.id === prId) ??
      (selected?.id === prId ? selected : undefined);
    const activeLevel = level ?? get().reviewLevel;
    // The workspace's active SDD/Harness agent (if any) reviews as that role.
    const agent = useChatStore.getState().agentByProject[projectId] ?? null;
    useJobsStore.getState().run({
      projectId,
      kind: "pr-review",
      label: pr ? `#${pr.id} ${pr.title}` : `PR #${prId}`,
      meta: { prId, level: activeLevel },
      task: (jobId) => api.reviewPullRequest(projectId, prId, jobId, activeLevel, agent),
    });
  },

  postReview: async (projectId, prId, runId, items, postSummary, summary) => {
    set({ posting: true });
    try {
      await api.postPrReviewComment(projectId, prId, runId, items, postSummary, summary);
      set({ posted: true });
    } catch (e) {
      pushErrorToast(String(e));
      throw e;
    } finally {
      set({ posting: false });
    }
  },

  decisionByPr: {},

  loadPrDecision: async (projectId, prId) => {
    try {
      const decision = await api.prReviewDecision(projectId, prId);
      set((s) => ({ decisionByPr: { ...s.decisionByPr, [decisionKey(projectId, prId)]: decision } }));
    } catch {
      // The host wouldn't say — leave it unknown, which just means the buttons stay offered.
    }
  },

  actOnPr: async (projectId, prId, action) => {
    set({ prActionBusy: action });
    try {
      const { pr, activity } = await api.actOnPullRequest(projectId, prId, action);
      // The decision is now on the record: remember it so the button that produced it is retired,
      // and file the action in Activity so "what happened to this PR" has an answer.
      const decision: PrDecision =
        action === "approve" ? "approved" : action === "request_changes" ? "changes_requested" : "none";
      set((s) => ({
        decisionByPr: { ...s.decisionByPr, [decisionKey(projectId, prId)]: decision },
        // The host's own answer, so a closed PR reads as closed rather than staying "open" until
        // the list refresh lands. The PR deliberately stays selected — including after closing it,
        // where dropping the selection used to look like the PR had disappeared.
        selectedPr: s.selectedPr?.id === prId ? pr : s.selectedPr,
        prsByProject: {
          ...s.prsByProject,
          [projectId]: (s.prsByProject[projectId] ?? []).map((p) => (p.id === prId ? pr : p)),
        },
      }));
      useJobsStore.getState().record(projectId, activity);
      const key = action === "approve" ? "pr.approved" : action === "request_changes" ? "pr.changesRequested" : "pr.closed";
      useToastStore.getState().pushToast(translate(key), "success");
      // Re-read the list so the sidebar's open/draft/merged/closed buckets settle too.
      await get().loadPullRequests(projectId);
      set((s) => ({ selectedPr: s.prsByProject[projectId]?.find((p) => p.id === prId) ?? s.selectedPr }));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      set({ prActionBusy: null });
    }
  },

  createPr: async (projectId, input) => {
    const pr = await api.createPullRequest(
      projectId,
      input.title,
      input.description,
      input.sourceBranch,
      input.targetBranch,
      input.draft,
    );
    await get().loadPullRequests(projectId);
    set({ selectedPr: pr });
    useToastStore.getState().pushToast(translate("createPr.created"), "success");
    return pr;
  },
}));
