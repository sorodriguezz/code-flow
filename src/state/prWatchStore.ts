import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import type { PullRequestSummary } from "../types/domain";

/**
 * The pull requests still waiting on a decision — kept until one is taken.
 *
 * Everything else that lists a PR is a *view of somewhere else*: the sidebar mirrors the host's
 * open list for the repository you have open, and the link sessions live in memory for as long as
 * the app runs. Neither survives what actually happens in a day — you review a PR someone sent
 * you, switch repository, restart, and the only handle on it is gone. The PR is still open, still
 * unreviewed by you, and now invisible.
 *
 * So this is a small, deliberate list: **PRs you have opened here that are neither approved nor
 * closed.** It is written to disk per workspace and pruned by the two facts that end a PR's stay —
 * a decision of yours, or the host reporting it merged/closed. "Changes requested" keeps its
 * place, because a PR you sent back is precisely one you are still waiting on.
 *
 * It stores a snapshot (title, repo, status), not a live copy: the entry has to be readable — and
 * clickable — before anything has been fetched, including on a machine that has never cloned the
 * repository the PR is in.
 */

export interface TrackedPr {
  /** `targetPrKey(target, prId)` — stable across restarts, unique per PR per target. */
  key: string;
  kind: "project" | "link";
  /** Set for project targets. */
  projectId?: string;
  /** Set for link targets — and the only way back into one. */
  url?: string;
  cloneUrl?: string;
  workspaceId: string;
  prId: number;
  title: string;
  /** "owner/repo", for the link entries no project names. */
  repoLabel: string;
  /** The PR as last seen, so the row can be rendered (and reopened) without a fetch. */
  pr: PullRequestSummary;
  /** Your own decision so far: `none` or `changes_requested` — an approval removes the entry. */
  decision: "none" | "changes_requested";
  /** Whether a review has run on it here. The one thing the list is really asked: "did I look?" */
  reviewed: boolean;
  /** Epoch ms of the last time it was on screen; the list is newest-first. */
  at: number;
}

interface PrWatchState {
  /** `byWorkspace[workspaceId]`, newest first. */
  byWorkspace: Record<string, TrackedPr[]>;
  loaded: Record<string, boolean>;
  load: (workspaceId: string) => Promise<void>;
  /** Records or refreshes an entry. Merges into the existing one, so opening a PR again doesn't
   * lose that a review has run on it. */
  track: (entry: TrackedPr) => void;
  /** Drops one — used by the row's dismiss, and by every path that learns the PR is settled. */
  untrack: (workspaceId: string, key: string) => void;
  /** Applies what the host now says about a PR: settled ones leave the list, the rest are updated
   * in place. The single funnel for "is this still pending?", so no caller has to know the rule. */
  reconcile: (workspaceId: string, key: string, pr: PullRequestSummary, decision: string) => void;
}

export const EMPTY_TRACKED: TrackedPr[] = [];

/** Enough to cover a real backlog without the list becoming its own navigation problem. Oldest
 * entries fall off the end; a PR that matters is one you opened recently. */
const MAX_TRACKED = 40;

const settingKey = (workspaceId: string) => `pr_watchlist_${workspaceId}`;

/** Best-effort, like every other KV-backed store here: a failed write costs the list its memory
 * across restarts, which is no worse than not having had one. */
function persist(workspaceId: string, entries: TrackedPr[]) {
  void setSetting(settingKey(workspaceId), JSON.stringify(entries)).catch(() => {});
}

export const usePrWatchStore = create<PrWatchState>((set, get) => ({
  byWorkspace: {},
  loaded: {},

  load: async (workspaceId) => {
    if (get().loaded[workspaceId]) return;
    // Set before the await so a double-invoked effect (dev StrictMode) can't both pass the guard.
    set((s) => ({ loaded: { ...s.loaded, [workspaceId]: true } }));
    const raw = await getSetting(settingKey(workspaceId)).catch(() => null);
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt blob — an empty list beats a crash
    }
    if (!Array.isArray(parsed)) return;
    const entries = (parsed as TrackedPr[]).filter(
      (entry) => entry && typeof entry.key === "string" && entry.pr && typeof entry.prId === "number",
    );
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        // Anything tracked this session already is newer than the disk copy.
        [workspaceId]: mergeNewest(s.byWorkspace[workspaceId] ?? [], entries),
      },
    }));
  },

  track: (entry) => {
    set((s) => {
      const current = s.byWorkspace[entry.workspaceId] ?? [];
      const previous = current.find((e) => e.key === entry.key);
      const merged: TrackedPr = {
        ...previous,
        ...entry,
        // Sticky: a review that ran an hour ago still ran, even if the entry is refreshed by
        // simply opening the PR again.
        reviewed: entry.reviewed || (previous?.reviewed ?? false),
      };
      const next = [merged, ...current.filter((e) => e.key !== entry.key)].slice(0, MAX_TRACKED);
      persist(entry.workspaceId, next);
      return { byWorkspace: { ...s.byWorkspace, [entry.workspaceId]: next } };
    });
  },

  untrack: (workspaceId, key) => {
    set((s) => {
      const next = (s.byWorkspace[workspaceId] ?? []).filter((e) => e.key !== key);
      persist(workspaceId, next);
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: next } };
    });
  },

  reconcile: (workspaceId, key, pr, decision) => {
    const settled = decision === "approved" || pr.status === "merged" || pr.status === "closed";
    if (settled) {
      get().untrack(workspaceId, key);
      return;
    }
    set((s) => {
      const current = s.byWorkspace[workspaceId] ?? [];
      if (!current.some((e) => e.key === key)) return s;
      const next = current.map((e) =>
        e.key === key
          ? { ...e, pr, title: pr.title, decision: decision === "changes_requested" ? ("changes_requested" as const) : ("none" as const) }
          : e,
      );
      persist(workspaceId, next);
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: next } };
    });
  },
}));

/** In-memory entries win over their stored twins; everything else keeps disk order after them. */
function mergeNewest(live: TrackedPr[], stored: TrackedPr[]): TrackedPr[] {
  const seen = new Set(live.map((e) => e.key));
  return [...live, ...stored.filter((e) => !seen.has(e.key))]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_TRACKED);
}
