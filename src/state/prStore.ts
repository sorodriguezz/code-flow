import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useJobsStore } from "./jobsStore";
import { useLanguageStore } from "./languageStore";
import { usePrWatchStore } from "./prWatchStore";
import { useWorkspaceStore } from "./workspaceStore";
import { tabsOfProject, useAiPanelStore, type LinkPrSession } from "./aiPanelStore";
import { translations } from "../lib/i18n/translations";
import * as prTarget from "../lib/prTarget";
import { targetKey, targetPrKey, type PrTarget } from "../lib/prTarget";
import { parseMergeRefusal } from "../lib/prOutcomes";
import type { MergeChoice, PrDecision, PrListScope, PublishOutcome, PullRequestSummary } from "../types/domain";
import type { PrAction, PostFindingItem } from "../lib/tauri/commands";

export type { LinkPrSession };

/** Where `postedByPr` files a publish: the pull request ([`targetPrKey`]) and the run published. */
export function postedKey(prKey: string, runId: string): string {
  return `${prKey}#${runId}`;
}

/**
 * Rebuilds a link review from the Activity row it left behind.
 *
 * That row outlives the app run that produced it, so by the time it is clicked there may be nothing
 * in memory to bring back — everything a session needs is in the row's `meta` (see
 * `link_activity_meta` in the backend). `null` for a row written before that was recorded, which is
 * the honest answer rather than a half-built session.
 */
export function linkSessionFromMeta(meta: Record<string, unknown>, workspaceId: string): LinkPrSession | null {
  const url = typeof meta.prUrl === "string" ? meta.prUrl : null;
  const pr = (meta.pr ?? null) as PullRequestSummary | null;
  if (!url || !pr || typeof pr.id !== "number") return null;
  return {
    url,
    pr,
    repoLabel: typeof meta.repoLabel === "string" ? meta.repoLabel : "",
    cloneUrl: typeof meta.cloneUrl === "string" ? meta.cloneUrl : "",
    workspaceId,
  };
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
 * The project's list with the host's latest copy of one pull request in it. Callers also hand the
 * copy to the assistant's tabs (`aiPanelStore.updatePr`), which is the other place it is held.
 *
 * Matched by target, never by number alone. "#42" repeats across repositories, and matching on the
 * number is how refreshing one repository's PR used to overwrite a link review of another
 * repository's "#42" that happened to be open.
 */
function writePr(state: PrState, target: PrTarget, pr: PullRequestSummary): Partial<PrState> {
  if (target.kind !== "project") return {};
  return {
    prsByProject: {
      ...state.prsByProject,
      [target.projectId]: (state.prsByProject[target.projectId] ?? []).map((p) => (p.id === pr.id ? pr : p)),
    },
  };
}

/** Where a paged list stands: the last page read, whether the host has another, and whether one is
 * on its way. One per scope, because open and finished pull requests page independently. */
export interface PrListPage {
  page: number;
  hasMore: boolean;
  loading: boolean;
  error?: string;
}

/** `list` with `incoming` in it: a pull request already there is replaced by the host's newer copy,
 * a new one is added. Never duplicated — a PR merged between two page reads moves from the open
 * scope's pages to the closed scope's, and would otherwise be listed twice. */
function mergePrs(list: PullRequestSummary[], incoming: PullRequestSummary[]): PullRequestSummary[] {
  const byId = new Map(incoming.map((pr) => [pr.id, pr]));
  const kept = list.map((pr) => byId.get(pr.id) ?? pr);
  const known = new Set(list.map((pr) => pr.id));
  return [...kept, ...incoming.filter((pr) => !known.has(pr.id))];
}

/** A merge refusal as one sentence: what to do about it, then the host's own words. */
function mergeErrorText(error: unknown): string {
  const refusal = parseMergeRefusal(error);
  if (!refusal) return String(error);
  const reason = translate(`pr.mergeRefused.${refusal.kind}` as keyof typeof translations.en);
  return refusal.message ? `${reason} — ${refusal.message}` : reason;
}

interface PrState {
  prsByProject: Record<string, PullRequestSummary[]>;
  /**
   * How far each scope of a project's list has been read. The list used to be one request for the
   * newest hundred of *every* state — a busy repository fills that with merged history in a week,
   * and an open pull request only a little older could be neither seen nor reviewed. Open pull
   * requests are now what loads by default; merged and closed ones load when asked for, and both
   * page on ("load more").
   */
  prPagesByProject: Record<string, Partial<Record<Exclude<PrListScope, "all">, PrListPage>>>;
  loadingProjectId: string | null;
  loadErrorByProject: Record<string, string>;

  /** Depth the next review runs at — shared so both the AI panel selector and the title-bar
   * shortcut launch at the same level. */
  reviewLevel: ReviewLevel;
  /**
   * Publishing in flight, and publishing done, per pull request ([`targetPrKey`]).
   *
   * These were two store-wide booleans, so publishing on one PR and moving to another showed
   * "Posting…" on the wrong one — the same per-item-in-a-scalar defect `prActionBusy` had.
   * Which PR is *on screen* is no longer this store's business at all: that is the assistant's
   * tabs (`aiPanelStore`), each of which names its own pull request.
   */
  postingByPr: Record<string, boolean>;
  /** Keyed by [`postedKey`]: what was published belongs to the run it came from. */
  postedByPr: Record<string, boolean>;
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

  /** Re-reads the first page of the project's **open** pull requests, and forgets how far the
   * finished ones had been read (a group showing them reloads them itself). */
  loadPullRequests: (projectId: string) => Promise<void>;
  /** Reads the next page of `scope` and adds it to the list. */
  loadMorePullRequests: (projectId: string, scope: Exclude<PrListScope, "all">) => Promise<void>;
  /** Reads the first page of `scope` if it hasn't been read yet — what unfolding the merged or
   * closed group does. */
  ensurePrScope: (projectId: string, scope: Exclude<PrListScope, "all">) => Promise<void>;
  /**
   * One PR of a project: the loaded list's copy when it has one, otherwise read directly from the
   * host by number.
   *
   * For the callers that reach a pull request *without* going through the sidebar list — an
   * Activity row reopening a review taken days ago is the one that matters. That PR is routinely
   * not on the list at all: the list is a page of *open* pull requests, and the review may be of one
   * merged since, or older than the page. So it is never looked up in the list alone.
   *
   * Returns `null` for both "the host says there is no such pull request" and "the host wouldn't
   * answer" — this deliberately doesn't distinguish them, because no caller acts differently: the
   * right response to either is to leave the screen as it is rather than navigate somewhere empty.
   * Don't build a "this pull request was deleted" message on it; the answer may just be that the
   * network was down.
   */
  ensureProjectPr: (projectId: string, prId: number) => Promise<PullRequestSummary | null>;
  setReviewLevel: (level: ReviewLevel) => void;
  /** Fire-and-forget — the run is tracked in `jobsStore`, not here, precisely so it survives
   * switching away from this PR (or this project) before it finishes. Uses `reviewLevel` unless
   * an explicit `level` is passed. A link review passes its `session`: the row it files has to say
   * which repository it was, and carry enough to reopen the review after a restart. */
  reviewPr: (
    target: PrTarget,
    pr: PullRequestSummary,
    opts?: { level?: ReviewLevel; force?: boolean; session?: LinkPrSession | null },
  ) => void;
  /** One comment thread per finding (anchored to its file/line when known) plus an optional
   * summary thread. On a project target these are reconciled against the saved run (`runId`) so a
   * finding keeps one thread across re-reviews; a link target has no saved run, so each finding
   * opens a fresh thread. `items` are the human-selected findings.
   *
   * Resolves with what happened item by item, including when some failed — what landed is on the
   * pull request either way, and the caller says exactly that. Rejects only when nothing could be
   * attempted (no token, no host). */
  postReview: (
    target: PrTarget,
    prId: number,
    runId: string,
    items: PostFindingItem[],
    postSummary: boolean,
    summary: string | null,
  ) => Promise<PublishOutcome>;
  /** For a review reached by link, which findings of a run are already on the pull request — it has
   * no memory to hold their threads, so this is what keeps a retry from posting them twice. Keyed by
   * [`postedKey`]. Lost on restart, like the session itself. */
  postedFindingsByRun: Record<string, string[]>;
  /** A merge in flight, keyed by [`targetPrKey`]. */
  mergingByPr: Record<string, boolean>;
  /** Merges (on Azure DevOps: completes) the PR, files it in Activity and settles every copy of the
   * PR onto the host's answer. Resolves `true` when the host accepted it; a refusal is said in a
   * toast in words the user can act on ("it has conflicts", "a required check hasn't passed"). */
  mergePr: (target: PrTarget, prId: number, choice: MergeChoice) => Promise<boolean>;
  /** What the signed-in user has already decided on a PR, keyed by target + PR id. Read from
   * the host, so an approval given on the website locks the buttons here too. */
  decisionByPr: Record<string, PrDecision>;
  /** Fetches (and caches) that decision — called when a PR is opened. Silent on failure: not
   * knowing the decision must never block reviewing the PR. */
  loadPrDecision: (target: PrTarget, prId: number) => Promise<void>;
  /** Re-reads the pull request itself from its host and writes it everywhere it is held (the
   * project's list and every assistant tab showing it), so what the panel shows is what the host
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
  /** Opens a PR on the project's linked host and refreshes the list, resolving to the new PR (the
   * caller puts it on screen). Throws on failure so the modal can keep itself open and say why. */
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
  prPagesByProject: {},
  loadingProjectId: null,
  loadErrorByProject: {},

  reviewLevel: "completo",
  postingByPr: {},
  postedByPr: {},
  postedFindingsByRun: {},
  mergingByPr: {},
  prActionBusy: {},

  loadPullRequests: async (projectId) => {
    set((s) => ({ loadingProjectId: projectId, loadErrorByProject: { ...s.loadErrorByProject, [projectId]: "" } }));
    try {
      const first = await api.listPullRequestsPage(projectId, "open", 1);
      const prs = first.items;
      set((s) => ({
        prsByProject: { ...s.prsByProject, [projectId]: prs },
        prPagesByProject: {
          ...s.prPagesByProject,
          [projectId]: { open: { page: first.page, hasMore: first.has_more, loading: false } },
        },
      }));
      // The tabs showing this repository's pull requests get the host's fresh copy too — a title
      // edited on the website, a PR merged meanwhile.
      for (const tab of tabsOfProject(projectId)) {
        if (tab.kind !== "pr") continue;
        const fresh = prs.find((pr) => pr.id === tab.prId);
        if (fresh && fresh !== tab.pr) useAiPanelStore.getState().updatePr({ kind: "project", projectId }, fresh);
      }
    } catch (e) {
      set((s) => ({ loadErrorByProject: { ...s.loadErrorByProject, [projectId]: String(e) } }));
    } finally {
      set((s) => (s.loadingProjectId === projectId ? { loadingProjectId: null } : {}));
    }
  },

  ensureProjectPr: async (projectId, prId) => {
    const cached = get().prsByProject[projectId]?.find((p) => p.id === prId);
    if (cached) return cached;
    try {
      return await api.getPullRequest(projectId, prId);
    } catch {
      return null;
    }
  },

  loadMorePullRequests: async (projectId, scope) => {
    const current = get().prPagesByProject[projectId]?.[scope];
    if (current?.loading || (current && !current.hasMore)) return;
    const page = (current?.page ?? 0) + 1;
    const mark = (patch: Partial<PrListPage>) =>
      set((s) => {
        const pages = s.prPagesByProject[projectId] ?? {};
        const was = pages[scope] ?? { page: 0, hasMore: true, loading: false };
        return { prPagesByProject: { ...s.prPagesByProject, [projectId]: { ...pages, [scope]: { ...was, ...patch } } } };
      });
    mark({ loading: true, error: undefined });
    try {
      const next = await api.listPullRequestsPage(projectId, scope, page);
      set((s) => ({ prsByProject: { ...s.prsByProject, [projectId]: mergePrs(s.prsByProject[projectId] ?? [], next.items) } }));
      mark({ page: next.page, hasMore: next.has_more, loading: false });
    } catch (e) {
      // The page stays where it was, so asking again retries the same one.
      mark({ loading: false, error: String(e) });
    }
  },

  ensurePrScope: async (projectId, scope) => {
    if (get().prPagesByProject[projectId]?.[scope]) return;
    await get().loadMorePullRequests(projectId, scope);
  },

  setReviewLevel: (level) => set({ reviewLevel: level }),

  reviewPr: (target, pr, opts = {}) => {
    const key = targetKey(target);
    const activeLevel = opts.level ?? get().reviewLevel;
    const force = opts.force ?? false;
    // A link review shares its bucket with every other repository reviewed from a link in this
    // workspace, so the row has to say which repo it is — and carry enough to reopen the session
    // later. The same shape the backend persists (see `link_activity_meta`), so the row reads
    // identically before and after a restart.
    const session = target.kind === "link" && opts.session?.url === target.url ? opts.session : null;
    const linkMeta = session
      ? { prUrl: session.url, repoLabel: session.repoLabel, cloneUrl: session.cloneUrl, prTitle: pr.title, pr }
      : {};
    const label = session ? `#${pr.id} ${session.repoLabel} · ${pr.title}` : `#${pr.id} ${pr.title}`;
    useJobsStore.getState().run({
      projectId: key,
      kind: "pr-review",
      label,
      meta: { prId: pr.id, level: activeLevel, ...linkMeta },
      task: (jobId) => prTarget.review(target, pr.id, jobId, activeLevel, force),
    });
  },

  postReview: async (target, prId, runId, items, postSummary, summary) => {
    const key = targetPrKey(target, prId);
    set((s) => ({ postingByPr: { ...s.postingByPr, [key]: true } }));
    try {
      const outcome = await prTarget.postFindings(target, prId, runId, items, postSummary, summary);
      const failed = outcome.items.some((item) => item.status === "failed") || Boolean(outcome.summary_error);
      const landed = outcome.items
        .filter((item) => item.status !== "failed" && item.status !== "skipped" && item.id)
        .map((item) => item.id as string);
      const runKey = postedKey(key, runId);
      set((s) => ({
        // Per run, not per PR: a re-review is new findings, and they have not been published yet.
        // Only a publish where everything landed settles the run; a partial one leaves the rest to do.
        postedByPr: failed ? s.postedByPr : { ...s.postedByPr, [runKey]: true },
        postedFindingsByRun: {
          ...s.postedFindingsByRun,
          [runKey]: [...new Set([...(s.postedFindingsByRun[runKey] ?? []), ...landed])],
        },
      }));
      return outcome;
    } catch (e) {
      pushErrorToast(String(e));
      throw e;
    } finally {
      set((s) => {
        const { [key]: _done, ...rest } = s.postingByPr;
        return { postingByPr: rest };
      });
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
      // Written to every copy of this PR, for the same reason `actOnPr` does it: the list and the
      // tabs are views of one pull request, and one of them being stale is how a refreshed review
      // goes back to looking old the moment the user leaves and returns.
      set((s) => writePr(s, target, pr));
      useAiPanelStore.getState().updatePr(target, pr);
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
        ...writePr(s, target, pr),
      }));
      useAiPanelStore.getState().updatePr(target, pr);
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
          const posted = await prTarget.postFindings(target, prId, note.runId, [], true, note.body);
          if (posted.summary_error) throw new Error(posted.summary_error);
          useToastStore.getState().pushToast(translate("pr.decisionCommentPosted"), "success");
        } catch (e) {
          pushErrorToast(translate("pr.decisionCommentFailed", { error: String(e) }));
        }
      }
      if (target.kind === "project") {
        // Re-read the list so the sidebar's open/draft/merged/closed buckets settle too, and hand
        // its copy to the tab — it names this PR, so it cannot be swapped for another one.
        await get().loadPullRequests(target.projectId);
        const fresh = get().prsByProject[target.projectId]?.find((p) => p.id === prId);
        if (fresh) useAiPanelStore.getState().updatePr(target, fresh);
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

  mergePr: async (target, prId, choice) => {
    const key = targetKey(target);
    const busyKey = targetPrKey(target, prId);
    // Captured before the host call, for the reason `actOnPr` gives: the watchlist row this settles
    // belongs to the workspace the merge was started in.
    const watchWorkspaceId = watchWorkspace(target);
    set((s) => ({ mergingByPr: { ...s.mergingByPr, [busyKey]: true } }));
    try {
      const { pr, merged, warning, activity } = await prTarget.merge(target, prId, choice);
      set((s) => writePr(s, target, pr));
      useAiPanelStore.getState().updatePr(target, pr);
      useJobsStore.getState().record(key, activity);
      useToastStore.getState().pushToast(translate(merged ? "pr.mergedToast" : "pr.mergeQueued"), "success");
      if (warning) pushErrorToast(translate("pr.mergeWarning", { error: warning }));
      usePrWatchStore.getState().reconcile(watchWorkspaceId, busyKey, pr, get().decisionByPr[busyKey] ?? "none");
      if (target.kind === "project") void get().loadPullRequests(target.projectId);
      return true;
    } catch (e) {
      pushErrorToast(mergeErrorText(e));
      return false;
    } finally {
      set((s) => {
        const { [busyKey]: _done, ...rest } = s.mergingByPr;
        return { mergingByPr: rest };
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
    useToastStore.getState().pushToast(translate("createPr.created"), "success");
    return pr;
  },
}));
