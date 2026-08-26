import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useJobsStore } from "./jobsStore";
import { useLanguageStore } from "./languageStore";
import { usePrWatchStore } from "./prWatchStore";
import { useWorkspaceStore } from "./workspaceStore";
import { translations } from "../lib/i18n/translations";
import * as prTarget from "../lib/prTarget";
import { targetKey, targetPrKey, type PrTarget } from "../lib/prTarget";
import type { PrDecision, PullRequestSummary } from "../types/domain";
import type { PrAction, PostFindingItem } from "../lib/tauri/commands";

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
  /** Whose review standard, contexts and skills the review runs under. */
  workspaceId: string;
}

/** Review depth, mirroring the WF-PR-REVIEWER levels. `completo` is the default. */
export type ReviewLevel = "basico" | "completo" | "ultra";

/** Translates outside of React (this store isn't a component) using whatever language is
 * currently selected — same lookup `useT()` does, just without the hook. */
function translate(key: keyof typeof translations.en, params?: Record<string, string>): string {
  const language = useLanguageStore.getState().language;
  const raw: string = translations[language][key] ?? translations.en[key] ?? key;
  if (!params) return raw;
  return Object.entries(params).reduce<string>(
    (acc, [name, value]) => acc.split(`{${name}}`).join(value),
    raw,
  );
}

/**
 * The workspace a target's watchlist entry belongs to: a link session carries its own, a project
 * one belongs to the workspace holding that repository — the same scope its Activity is filed
 * under.
 *
 * Resolved from the project rather than from "whichever workspace is open", because the one caller
 * reads it *after* a round trip to the host: approving a pull request and then switching workspace
 * while the host thinks about it used to file the reconciliation under wherever the user had landed,
 * which is how a settled PR stayed on one workspace's "waiting on you" list and appeared on
 * another's. `activeWorkspaceId` remains only as the answer for a repository whose workspace has
 * never been loaded this session, where there is nothing better to say.
 */
function watchWorkspace(target: PrTarget): string {
  if (target.kind === "link") return target.workspaceId;
  const workspaces = useWorkspaceStore.getState();
  return workspaces.workspaceOfProject(target.projectId) ?? workspaces.activeWorkspaceId ?? "";
}

/**
 * Whether the pull request on screen is the one this target names.
 *
 * A PR number is only unique inside its repository, so `selectedPr.id === prId` alone matched
 * another repository's "#42" — which is how a decision taken on one repo's pull request rewrote the
 * panel showing a completely different one. A link session is identified by its URL instead, since
 * it belongs to no project at all and `selectedPr` is never what is showing it.
 */
function isSelected(state: PrState, target: PrTarget, prId: number): boolean {
  if (target.kind !== "project") return false;
  return state.selectedPr?.id === prId && state.selectedPrProjectId === target.projectId;
}

interface PrState {
  prsByProject: Record<string, PullRequestSummary[]>;
  loadingProjectId: string | null;
  loadErrorByProject: Record<string, string>;

  selectedPr: PullRequestSummary | null;
  /**
   * Which repository the pull request in `selectedPr` belongs to.
   *
   * `PullRequestSummary` carries no project of its own, so the pairing used to be *invented at
   * render time*: the AI panel and the title-bar menu each took the selection and married it to
   * whichever repository was active when they drew. Switching repository therefore silently
   * re-bound the open review to the new one — and not only as a click hazard. The panel's mount
   * effect fires `loadPrDecision`, an unprompted host call asking repo Q about repo P's pull
   * request, and `usePrWatchStore.track` writes a persisted "waiting on you" row keyed `Q:42`
   * carrying P's snapshot. It reproduces on a plain project switch inside one workspace, not only
   * on a workspace switch.
   *
   * Recorded here at the moment the PR is chosen, so the panel can *refuse* to draw a selection
   * that isn't this project's rather than re-home it. `linkPr` needs no equivalent: a link session
   * already names its own workspace.
   */
  selectedPrProjectId: string | null;
  /** Depth the next review runs at — shared so both the AI panel selector and the title-bar
   * shortcut launch at the same level. */
  reviewLevel: ReviewLevel;
  posting: boolean;
  posted: boolean;
  /**
   * Which PR action (approve / request_changes / close) is in flight, keyed by
   * [`targetPrKey`] — so its button can show a spinner and the *same* PR's other two disable
   * while it runs. Absent means idle.
   *
   * One store-wide slot made approving PR #42 render every other pull request on screen as busy
   * and disabled — including ones in other repositories and other workspaces, which the action had
   * nothing to do with. Same class as everything else here: a per-item state kept in a scalar.
   */
  prActionBusy: Record<string, PrAction>;

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
  /** Reopens the review behind a workspace Activity row.
   *
   * That row outlives the app run that produced it, so by the time it's clicked there may be no
   * session in memory to bring back — everything needed to rebuild one is in the row's `meta`
   * (see `link_activity_meta` in the backend). Returns `false` when it isn't, which is the honest
   * answer for a row written before that was recorded rather than a half-built session. */
  openLinkPrFromMeta: (meta: Record<string, unknown>, workspaceId: string) => boolean;
  closeLinkPr: () => void;
  /** Drops a parked session from the list. Its jobs stay in `jobsStore` — this is about the list
   * not growing forever, not about erasing what happened. */
  forgetLinkPr: (url: string) => void;

  loadPullRequests: (projectId: string) => Promise<void>;
  /**
   * One PR of a project, fetching the project's list first if it isn't loaded yet.
   *
   * For the callers that reach a pull request *without* going through the sidebar list — an
   * Activity row reopening a review taken days ago is the one that matters. Those used to be able
   * to assume the list was already in memory, because the sidebar loaded it on sight; it now waits
   * to be asked (see `PullRequestsSection`), so a row clicked before the section was ever unfolded
   * would find nothing and silently do nothing.
   *
   * Returns `null` for both "the host says there is no such pull request" and "the host wouldn't
   * answer" — this deliberately doesn't distinguish them, because no caller acts differently: the
   * right response to either is to leave the screen as it is rather than navigate somewhere empty.
   * Don't build a "this pull request was deleted" message on it; the answer may just be that the
   * network was down. The reason, when there is one, is in `loadErrorByProject`.
   */
  ensureProjectPr: (projectId: string, prId: number) => Promise<PullRequestSummary | null>;
  /**
   * Puts a project's pull request on screen, recording *which* project it is.
   *
   * `projectId` is optional because every caller that omits it has already brought the owning
   * repository to the front — the sidebar list is the active project's, the Activity row is looked
   * up in it, the link modal and the notification path both `focusProject` first — so the project
   * active at the instant of the click *is* the answer. That resolution happens here, once, at the
   * start; what this replaces is the panel re-deriving it on every render, long after the user has
   * moved on. Pass it explicitly wherever the two can differ.
   */
  selectPr: (pr: PullRequestSummary | null, projectId?: string | null) => void;
  setReviewLevel: (level: ReviewLevel) => void;
  /** Fire-and-forget — the run is tracked in `jobsStore`, not here, precisely so it survives
   * switching away from this PR (or this project) before it finishes. Uses `reviewLevel` unless
   * an explicit `level` is passed. */
  reviewPr: (target: PrTarget, prId: number, level?: ReviewLevel, force?: boolean) => void;
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
  /** Re-reads the pull request itself from its host and writes it everywhere it is held (the open
   * panel, the parked link sessions, the project's list), so what the panel shows is what the host
   * currently says — a reset vote, a new head commit, a title edited on the website.
   *
   * Silent on failure, like `loadPrDecision`: an unreachable host leaves the panel showing what it
   * already had, which is the last thing known to be true. */
  refreshPr: (target: PrTarget, prId: number) => Promise<void>;
  /** Approve / request changes / close the PR on its host (GitHub or Azure DevOps).
   *
   * The PR stays on screen afterwards, in the state the host reports back — closing one used to
   * drop it out of the panel, which read as "it vanished" rather than "it's closed". The decision
   * is filed in Activity and remembered here, so the action can't be taken twice.
   *
   * `note` publishes a comment on the PR *after* the decision lands — the summary of what the
   * review found, what was fixed and what was accepted anyway (see `formatDecisionComment`). It is
   * posted second on purpose: a note explaining an approval that never happened would be worse
   * than no note, and a note that fails to post must not undo an approval that did. */
  actOnPr: (
    target: PrTarget,
    prId: number,
    action: PrAction,
    note?: { runId: string; body: string } | null,
  ) => Promise<void>;
  /** Opens a PR on the project's linked host, then refreshes the list and selects the new PR.
   * Throws on failure so the caller (the modal) can keep itself open and surface the error. */
  createPr: (
    projectId: string,
    input: {
      title: string;
      description: string;
      sourceBranch: string;
      targetBranch: string;
      draft: boolean;
      /** Azure DevOps only — see `createPullRequest`. */
      workItemIds?: number[];
    },
  ) => Promise<PullRequestSummary>;
}

export const usePrStore = create<PrState>((set, get) => ({
  prsByProject: {},
  loadingProjectId: null,
  loadErrorByProject: {},

  selectedPr: null,
  selectedPrProjectId: null,
  reviewLevel: "completo",
  posting: false,
  posted: false,
  prActionBusy: {},

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

  ensureProjectPr: async (projectId, prId) => {
    const cached = get().prsByProject[projectId]?.find((p) => p.id === prId);
    if (cached) return cached;
    // Only ever one round trip: `loadPullRequests` swallows its own failures into
    // `loadErrorByProject`, so a host that won't answer leaves the list absent rather than
    // throwing, and the lookup below simply comes up empty.
    await get().loadPullRequests(projectId);
    return get().prsByProject[projectId]?.find((p) => p.id === prId) ?? null;
  },

  linkPr: null,
  linkPrHistory: [],

  // Opening one clears the other: they're two ways of reaching a PR, not two panes.
  openLinkPr: (session) =>
    set((s) => ({
      linkPr: session,
      selectedPr: null,
      selectedPrProjectId: null,
      posted: false,
      // Re-opening the same URL moves it back to the top rather than listing it twice; the fresh
      // session object wins, since it carries the PR as the host last described it.
      linkPrHistory: [session, ...s.linkPrHistory.filter((e) => e.url !== session.url)].slice(0, MAX_LINK_HISTORY),
    })),
  openLinkPrFromMeta: (meta, workspaceId) => {
    const url = typeof meta.prUrl === "string" ? meta.prUrl : null;
    const pr = (meta.pr ?? null) as PullRequestSummary | null;
    if (!url || !pr || typeof pr.id !== "number") return false;
    get().openLinkPr({
      url,
      pr,
      repoLabel: typeof meta.repoLabel === "string" ? meta.repoLabel : "",
      cloneUrl: typeof meta.cloneUrl === "string" ? meta.cloneUrl : "",
      workspaceId,
    });
    return true;
  },

  // Closing only takes it off screen. It stays in `linkPrHistory` so one click brings the whole
  // review back — that's what makes the session's in-memory Activity worth keeping.
  closeLinkPr: () => set({ linkPr: null, posted: false }),

  forgetLinkPr: (url) =>
    set((s) => ({
      linkPrHistory: s.linkPrHistory.filter((e) => e.url !== url),
      linkPr: s.linkPr?.url === url ? null : s.linkPr,
    })),

  selectPr: (pr, projectId) =>
    set({
      selectedPr: pr,
      // Stamped now, from the caller when it named one and otherwise from the repository the user
      // is standing in as they click. Never re-read later: by the time the panel renders — or the
      // title-bar menu is opened, or a decision comes back from the host — "the active project" is
      // whatever they have since walked into, which is the one answer that is wrong exactly when it
      // matters. Cleared with the selection, so nothing is left pointing at a PR that isn't shown.
      selectedPrProjectId: pr ? projectId ?? useWorkspaceStore.getState().activeProjectId : null,
      linkPr: pr ? null : get().linkPr,
      posted: false,
    }),

  setReviewLevel: (level) => set({ reviewLevel: level }),

  reviewPr: (target, prId, level, force = false) => {
    const key = targetKey(target);
    // The current selection is a valid source for the label too: a review launched straight from
    // a pasted link starts before that project's PR list has finished loading.
    const shown = get().linkPr?.pr ?? get().selectedPr;
    const pr =
      (target.kind === "project" ? get().prsByProject[target.projectId]?.find((p) => p.id === prId) : undefined) ??
      (shown?.id === prId ? shown : undefined);
    const activeLevel = level ?? get().reviewLevel;
    // A link review shares its bucket with every other repository reviewed from a link in this
    // workspace, so the row has to say which repo it is — and carry enough to reopen the session
    // later. The same shape the backend persists (see `link_activity_meta`), so the row reads
    // identically before and after a restart.
    const session = target.kind === "link" && get().linkPr?.url === target.url ? get().linkPr : null;
    const linkMeta =
      session
        ? {
            prUrl: session.url,
            repoLabel: session.repoLabel,
            cloneUrl: session.cloneUrl,
            prTitle: session.pr.title,
            pr: session.pr,
          }
        : {};
    const label = pr
      ? session
        ? `#${pr.id} ${session.repoLabel} · ${pr.title}`
        : `#${pr.id} ${pr.title}`
      : `PR #${prId}`;
    useJobsStore.getState().run({
      projectId: key,
      kind: "pr-review",
      label,
      meta: { prId, level: activeLevel, ...linkMeta },
      task: (jobId) => prTarget.review(target, prId, jobId, activeLevel, force),
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
      set((s) => ({ decisionByPr: { ...s.decisionByPr, [targetPrKey(target, prId)]: decision } }));
    } catch {
      // The host wouldn't say — leave it unknown, which just means the buttons stay offered.
    }
  },

  refreshPr: async (target, prId) => {
    try {
      const pr = await prTarget.refreshPr(target, prId);
      if (!pr) return;
      // Written to every copy of this PR the store holds, for the same reason `actOnPr` does it:
      // the panel, the parked link session and the project's list are three views of one pull
      // request, and one of them being stale is how a refreshed panel goes back to looking old the
      // moment the user leaves and returns.
      set((s) => ({
        // Matched on the project as well as the number: "#42" repeats across repositories, so a
        // refresh of one repo's pull request used to overwrite the panel whenever another repo's
        // PR of the same number happened to be the selected one.
        selectedPr: isSelected(s, target, prId) ? pr : s.selectedPr,
        linkPr: s.linkPr && s.linkPr.pr.id === prId ? { ...s.linkPr, pr } : s.linkPr,
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
    } catch {
      // Offline or a host hiccup: keep showing the last state known to be true.
    }
  },

  actOnPr: async (target, prId, action, note) => {
    const key = targetKey(target);
    // The pull request this is busy on, not "the app is busy". Everything below reads it back the
    // same way, including the `finally` — so an action on one PR leaves every other PR's buttons
    // exactly as it found them.
    const busyKey = targetPrKey(target, prId);
    // Captured here, before the host call, for the same reason: the watchlist row this settles
    // belongs to the workspace the decision was taken in, not to whichever one the answer arrives
    // in.
    const watchWorkspaceId = watchWorkspace(target);
    set((s) => ({ prActionBusy: { ...s.prActionBusy, [busyKey]: action } }));
    try {
      const { pr, activity } = await prTarget.actOnPr(target, prId, action);
      // The decision is now on the record: remember it so the button that produced it is retired,
      // and file the action in Activity so "what happened to this PR" has an answer.
      const decision: PrDecision =
        action === "approve" ? "approved" : action === "request_changes" ? "changes_requested" : "none";
      set((s) => ({
        decisionByPr: { ...s.decisionByPr, [targetPrKey(target, prId)]: decision },
        // The host's own answer, so a closed PR reads as closed rather than staying "open" until
        // the list refresh lands. The PR deliberately stays on screen — including after closing
        // it, where dropping it used to look like the PR had disappeared.
        selectedPr: isSelected(s, target, prId) ? pr : s.selectedPr,
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
      // Both targets come back with a persisted Activity row — `job_history` for a project,
      // `workspace_activity` for a link — so the decision reads the same after a restart as it
      // does the moment it's taken.
      useJobsStore.getState().record(key, activity);
      const toastKey =
        action === "approve" ? "pr.approved" : action === "request_changes" ? "pr.changesRequested" : "pr.closed";
      useToastStore.getState().pushToast(translate(toastKey), "success");
      // A decision is exactly what takes a PR off the "still waiting on me" list — approving or
      // closing settles it; asking for changes does not, so that one is only updated in place.
      usePrWatchStore.getState().reconcile(watchWorkspaceId, busyKey, pr, decision);
      // The record of *why*, on the PR itself. Its own try/catch: the decision is already on the
      // host and cannot be taken back, so a comment that fails is a warning, not a failed action.
      if (note) {
        try {
          await prTarget.postFindings(target, prId, note.runId, [], true, note.body);
          useToastStore.getState().pushToast(translate("pr.decisionCommentPosted"), "success");
        } catch (e) {
          pushErrorToast(translate("pr.decisionCommentFailed", { error: String(e) }));
        }
      }
      if (target.kind === "project") {
        // Re-read the list so the sidebar's open/draft/merged/closed buckets settle too.
        await get().loadPullRequests(target.projectId);
        // Guarded on the selection still being this project's: the list load is two awaits long,
        // and a user who picked another repository's PR in the meantime must not have it swapped
        // out from under them for the one this decision was taken on.
        set((s) =>
          isSelected(s, target, prId)
            ? { selectedPr: s.prsByProject[target.projectId]?.find((p) => p.id === prId) ?? s.selectedPr }
            : {},
        );
      }
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      set((s) => {
        // Only this PR's entry — clearing the whole record would un-busy a decision taken on a
        // different pull request while this one was in flight — and only while the entry is still
        // the one this call wrote, so a second action started on the *same* PR keeps its spinner.
        if (s.prActionBusy[busyKey] !== action) return {};
        const { [busyKey]: _settled, ...rest } = s.prActionBusy;
        return { prActionBusy: rest };
      });
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
      input.workItemIds,
    );
    await get().loadPullRequests(projectId);
    set({ selectedPr: pr, selectedPrProjectId: projectId });
    useToastStore.getState().pushToast(translate("createPr.created"), "success");
    return pr;
  },
}));
