import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useJobsStore } from "./jobsStore";
import { useChatStore } from "./chatStore";
import { useLanguageStore } from "./languageStore";
import { translations } from "../lib/i18n/translations";
import * as prTarget from "../lib/prTarget";
import { targetKey, type PrTarget } from "../lib/prTarget";
import type { PrDecision, PullRequestSummary } from "../types/domain";
import type { PrAction, PostFindingItem } from "../lib/tauri/commands";

/** Cache key for a PR's decision — a PR id is only unique within the repo it belongs to. */
const decisionKey = (target: PrTarget, prId: number) => `${targetKey(target)}:${prId}`;

/** Enough parked link reviews to cover an afternoon of "someone sent me this PR" without the
 * list becoming its own navigation problem. */
const MAX_LINK_HISTORY = 8;

/**
 * A pull request opened from a link with nothing checked out for it.
 *
 * It lives beside `selectedPr` rather than inside it because the two are reached differently and
 * can't both be on screen: the panel shows whichever one is set.
 */
export interface LinkPrSession {
  url: string;
  pr: PullRequestSummary;
  /** "owner/repo" — the panel says which repository this PR is in, since no project names it. */
  repoLabel: string;
  /** Offered as "clone it after all" from inside the session. */
  cloneUrl: string;
  /** Whose review standard, contexts and MCP servers the review runs under. */
  workspaceId: string;
}

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

  /** A PR being reviewed straight from its link, with no clone behind it. Mutually exclusive with
   * `selectedPr` — the panel renders whichever is set. */
  linkPr: LinkPrSession | null;
  /**
   * Every link session opened this run, newest first — including the one currently on screen.
   *
   * A link PR has no project, so it appears in no sidebar and no list: the panel showing it was
   * the only handle on it, and closing that (or pressing "New chat") stranded its whole review —
   * findings, comments, the approval — in memory with nothing left to reach it by. Its Activity
   * was never actually deleted; it just became unreachable, which to the user is the same thing.
   */
  linkPrHistory: LinkPrSession[];
  openLinkPr: (session: LinkPrSession) => void;
  closeLinkPr: () => void;
  /** Drops a parked session from the list. Its jobs stay in `jobsStore` — this is about the list
   * not growing forever, not about erasing what happened. */
  forgetLinkPr: (url: string) => void;

  loadPullRequests: (projectId: string) => Promise<void>;
  selectPr: (pr: PullRequestSummary | null) => void;
  setReviewLevel: (level: ReviewLevel) => void;
  /** Fire-and-forget — the run is tracked in `jobsStore`, not here, precisely so it survives
   * switching away from this PR (or this project) before it finishes. Uses `reviewLevel` unless
   * an explicit `level` is passed. */
  reviewPr: (target: PrTarget, prId: number, level?: ReviewLevel) => void;
  /** One comment thread per finding (anchored to its file/line when known) plus an optional
   * summary thread. On a project target these are reconciled against the saved run (`runId`) so a
   * finding keeps one thread across re-reviews; a link target has no saved run, so each finding
   * opens a fresh thread. `items` are the human-selected findings. */
  postReview: (
    target: PrTarget,
    prId: number,
    runId: string,
    items: PostFindingItem[],
    postSummary: boolean,
    summary: string | null,
  ) => Promise<void>;
  /** What the signed-in user has already decided on a PR, keyed by target + PR id. Read from
   * the host, so an approval given on the website locks the buttons here too. */
  decisionByPr: Record<string, PrDecision>;
  /** Fetches (and caches) that decision — called when a PR is opened. Silent on failure: not
   * knowing the decision must never block reviewing the PR. */
  loadPrDecision: (target: PrTarget, prId: number) => Promise<void>;
  /** Approve / request changes / close the PR on its host (GitHub or Azure DevOps).
   *
   * The PR stays on screen afterwards, in the state the host reports back — closing one used to
   * drop it out of the panel, which read as "it vanished" rather than "it's closed". The decision
   * is filed in Activity and remembered here, so the action can't be taken twice. */
  actOnPr: (target: PrTarget, prId: number, action: PrAction) => Promise<void>;
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

  linkPr: null,
  linkPrHistory: [],

  // Opening one clears the other: they're two ways of reaching a PR, not two panes.
  openLinkPr: (session) =>
    set((s) => ({
      linkPr: session,
      selectedPr: null,
      posted: false,
      // Re-opening the same URL moves it back to the top rather than listing it twice; the fresh
      // session object wins, since it carries the PR as the host last described it.
      linkPrHistory: [session, ...s.linkPrHistory.filter((e) => e.url !== session.url)].slice(0, MAX_LINK_HISTORY),
    })),
  // Closing only takes it off screen. It stays in `linkPrHistory` so one click brings the whole
  // review back — that's what makes the session's in-memory Activity worth keeping.
  closeLinkPr: () => set({ linkPr: null, posted: false }),

  forgetLinkPr: (url) =>
    set((s) => ({
      linkPrHistory: s.linkPrHistory.filter((e) => e.url !== url),
      linkPr: s.linkPr?.url === url ? null : s.linkPr,
    })),

  selectPr: (pr) => set({ selectedPr: pr, linkPr: pr ? null : get().linkPr, posted: false }),

  setReviewLevel: (level) => set({ reviewLevel: level }),

  reviewPr: (target, prId, level) => {
    const key = targetKey(target);
    // The current selection is a valid source for the label too: a review launched straight from
    // a pasted link starts before that project's PR list has finished loading.
    const shown = get().linkPr?.pr ?? get().selectedPr;
    const pr =
      (target.kind === "project" ? get().prsByProject[target.projectId]?.find((p) => p.id === prId) : undefined) ??
      (shown?.id === prId ? shown : undefined);
    const activeLevel = level ?? get().reviewLevel;
    // The workspace's active SDD/Harness agent (if any) reviews as that role. A link session has
    // no project to have picked an agent for, so it reviews as itself.
    const agent = target.kind === "project" ? useChatStore.getState().agentByProject[target.projectId] ?? null : null;
    useJobsStore.getState().run({
      projectId: key,
      kind: "pr-review",
      label: pr ? `#${pr.id} ${pr.title}` : `PR #${prId}`,
      meta: { prId, level: activeLevel },
      task: (jobId) => prTarget.review(target, prId, jobId, activeLevel, agent),
    });
  },

  postReview: async (target, prId, runId, items, postSummary, summary) => {
    set({ posting: true });
    try {
      await prTarget.postFindings(target, prId, runId, items, postSummary, summary);
      set({ posted: true });
    } catch (e) {
      pushErrorToast(String(e));
      throw e;
    } finally {
      set({ posting: false });
    }
  },

  decisionByPr: {},

  loadPrDecision: async (target, prId) => {
    try {
      const decision = await prTarget.reviewDecision(target, prId);
      set((s) => ({ decisionByPr: { ...s.decisionByPr, [decisionKey(target, prId)]: decision } }));
    } catch {
      // The host wouldn't say — leave it unknown, which just means the buttons stay offered.
    }
  },

  actOnPr: async (target, prId, action) => {
    const key = targetKey(target);
    set({ prActionBusy: action });
    try {
      const { pr, activity } = await prTarget.actOnPr(target, prId, action);
      // The decision is now on the record: remember it so the button that produced it is retired,
      // and file the action in Activity so "what happened to this PR" has an answer.
      const decision: PrDecision =
        action === "approve" ? "approved" : action === "request_changes" ? "changes_requested" : "none";
      set((s) => ({
        decisionByPr: { ...s.decisionByPr, [decisionKey(target, prId)]: decision },
        // The host's own answer, so a closed PR reads as closed rather than staying "open" until
        // the list refresh lands. The PR deliberately stays on screen — including after closing
        // it, where dropping it used to look like the PR had disappeared.
        selectedPr: s.selectedPr?.id === prId ? pr : s.selectedPr,
        linkPr: s.linkPr && s.linkPr.pr.id === prId ? { ...s.linkPr, pr } : s.linkPr,
        // The parked copy too, or reopening this session from the list would show the PR as it
        // was before the decision — "open" for one it just closed. Matched on the URL rather
        // than the number, which repeats across repositories.
        linkPrHistory:
          target.kind === "link"
            ? s.linkPrHistory.map((e) => (e.url === target.url ? { ...e, pr } : e))
            : s.linkPrHistory,
        prsByProject:
          target.kind === "project"
            ? {
                ...s.prsByProject,
                [target.projectId]: (s.prsByProject[target.projectId] ?? []).map((p) => (p.id === prId ? pr : p)),
              }
            : s.prsByProject,
      }));
      // A project-backed decision comes back with its persisted Activity row; a link session has
      // no project to file one under, so the row is synthesised here and lives with the session.
      useJobsStore.getState().record(
        key,
        activity ?? {
          id: `pr-action-${key}-${prId}-${action}`,
          project_id: key,
          kind: "pr-action",
          label: `#${pr.id} ${pr.title}`,
          custom_label: null,
          status: "done",
          result: pr.url,
          error: null,
          meta: JSON.stringify({ prId: pr.id, prTitle: pr.title, action }),
          created_at: new Date().toISOString(),
        },
      );
      const toastKey =
        action === "approve" ? "pr.approved" : action === "request_changes" ? "pr.changesRequested" : "pr.closed";
      useToastStore.getState().pushToast(translate(toastKey), "success");
      if (target.kind === "project") {
        // Re-read the list so the sidebar's open/draft/merged/closed buckets settle too.
        await get().loadPullRequests(target.projectId);
        set((s) => ({ selectedPr: s.prsByProject[target.projectId]?.find((p) => p.id === prId) ?? s.selectedPr }));
      }
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
