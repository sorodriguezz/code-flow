import { useEffect } from "react";
import { create } from "zustand";
import { listPullRequestsPage, repoSummaries, type RepoSummary } from "../lib/tauri/commands";
import { onRepoFsChanged } from "../lib/tauri/events";
import type { Project } from "../types/domain";
import { saving } from "./powerSaveStore";
import { useRepoStore } from "./repoStore";

/**
 * What the projects panel says about the repositories that are *not* open: the branch, how many
 * files have changes, how far from upstream (`git::summary`), and how many pull requests are open.
 *
 * The open repository has all of this live from `repoStore` and its watcher; these rows had their
 * name and nothing else. Read when the window comes forward and every minute while it is on
 * screen — local git only. Pull requests are someone else's API with a quota, so they are read at
 * most every five minutes, and only for projects linked to a host.
 *
 * The minute is only the floor. A row must not go on saying "41 changed" for a minute after the
 * commit that cleared them, so a repository is also re-read as soon as something says it moved:
 * its watcher (`repo:fs-changed`, for any repository a window watches), a command finishing in a
 * terminal standing in it, and a git action the app ran on it (`REPO_TOUCHED_EVENT`). And the open
 * repository's live state is copied in as it changes, so the row it leaves behind on a switch shows
 * what it was a moment ago, not what the last tick saw.
 */

/** Raised (on `window`) with `{ path }` by whatever changed a repository it is not showing — a
 *  commit or push from a picker on another repository. An event, not a call: `repoStore` must not
 *  import this store. */
export const REPO_TOUCHED_EVENT = "cf:repo-touched";

/** How long a burst of "it moved" signals is let settle before the one read it costs. */
const SOON_MS = 350;

/** How many ticks battery saving folds into one (`powerSaveStore`). */
const SAVING_STRIDE = 3;
const SUMMARY_EVERY_MS = 60_000;
const PRS_EVERY_MS = 5 * 60_000;
/** A window brought forward twice within this is not asked twice. */
const FOCUS_SETTLE_MS = 15_000;

export interface OpenPrs {
  count: number;
  /** The host has more than the first page. */
  more: boolean;
  /** Open PR ids not yet seen in the panel's pull-request section — what "new" means. */
  fresh: number;
}

interface RepoSummaryState {
  byPath: Record<string, RepoSummary>;
  prsByProject: Record<string, OpenPrs>;
  refresh: (paths: string[]) => Promise<void>;
  /** Re-reads one repository shortly, folding a burst of calls into one read. */
  refreshSoon: (path: string) => void;
  /** The repository a folder is in, among those already summarised, re-read shortly. */
  refreshForCwd: (cwd: string) => void;
  refreshPrs: (projects: Project[]) => Promise<void>;
  /** The pull-request section of this project was looked at: what is open now is no longer new. */
  markPrsSeen: (projectId: string) => void;
}

/** Ids seen per project. Per session: "new since you last looked", not a read receipt. */
const seen = new Map<string, Set<number>>();
const latest = new Map<string, number[]>();
/** Pending `refreshSoon` timers by path. */
const soon = new Map<string, number>();

/** Separators made one kind and the trailing one dropped, so `C:\\a\\b\\` and `C:/a/b` compare. */
const normal = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** The deepest of `repos` that `cwd` is inside (or is), or `null`. Pure. */
export function repoForCwd(repos: string[], cwd: string): string | null {
  const here = normal(cwd);
  let best: string | null = null;
  for (const repo of repos) {
    const root = normal(repo);
    if (here !== root && !here.startsWith(`${root}/`)) continue;
    if (!best || root.length > normal(best).length) best = repo;
  }
  return best;
}

/** The open repository's live state, in the summary's shape. Pure. */
export function summaryFromLive(
  path: string,
  status: NonNullable<ReturnType<typeof useRepoStore.getState>["status"]>,
  branches: ReturnType<typeof useRepoStore.getState>["branches"],
): RepoSummary {
  const head = branches.find((b) => b.is_head && !b.is_remote) ?? null;
  return {
    path,
    branch: status.current_branch,
    detached: status.is_detached,
    changed: new Set([...status.staged, ...status.unstaged, ...status.untracked].map((f) => f.path)).size,
    conflicted: status.conflicted.length,
    ahead: head ? head.ahead : null,
    behind: head ? head.behind : null,
    error: null,
  };
}

export function isLinked(project: Project): boolean {
  return Boolean(project.github_repo || project.gitlab_project || project.ado_repo_id || project.bitbucket_repo);
}

export const useRepoSummaryStore = create<RepoSummaryState>((set, get) => ({
  byPath: {},
  prsByProject: {},

  refresh: async (paths) => {
    if (paths.length === 0) return;
    const summaries = await repoSummaries(paths).catch(() => [] as RepoSummary[]);
    if (summaries.length === 0) return;
    set((s) => {
      const byPath = { ...s.byPath };
      for (const summary of summaries) byPath[summary.path] = summary;
      return { byPath };
    });
  },

  refreshSoon: (path) => {
    if (!path) return;
    const pending = soon.get(path);
    if (pending !== undefined) window.clearTimeout(pending);
    soon.set(
      path,
      window.setTimeout(() => {
        soon.delete(path);
        void get().refresh([path]);
      }, SOON_MS),
    );
  },

  refreshForCwd: (cwd) => {
    const repo = repoForCwd(Object.keys(get().byPath), cwd);
    if (repo) get().refreshSoon(repo);
  },

  refreshPrs: async (projects) => {
    // One at a time: a dozen linked repositories is a dozen requests to one host, and there is no
    // hurry — the numbers are a glance, not a live view.
    for (const project of projects.filter(isLinked)) {
      try {
        const page = await listPullRequestsPage(project.id, "open", 1);
        const ids = page.items.map((pr) => pr.id);
        latest.set(project.id, ids);
        let known = seen.get(project.id);
        // The first read of a session is the baseline: everything already open is not news.
        if (!known) {
          known = new Set(ids);
          seen.set(project.id, known);
        }
        const fresh = ids.filter((id) => !known.has(id)).length;
        set((s) => ({ prsByProject: { ...s.prsByProject, [project.id]: { count: ids.length, more: page.has_more, fresh } } }));
      } catch {
        // No token, no network, a host that refused: nothing to say rather than a wrong number.
        set((s) => {
          const { [project.id]: _gone, ...rest } = s.prsByProject;
          return { prsByProject: rest };
        });
      }
    }
  },

  markPrsSeen: (projectId) => {
    const ids = latest.get(projectId);
    if (ids) seen.set(projectId, new Set([...(seen.get(projectId) ?? []), ...ids]));
    const current = get().prsByProject[projectId];
    if (current && current.fresh > 0) set((s) => ({ prsByProject: { ...s.prsByProject, [projectId]: { ...current, fresh: 0 } } }));
  },
}));

/**
 * Keeps the summaries of `projects` current while this panel is mounted: now, whenever the window
 * comes forward, and every minute while it is visible. Pull requests on their own, slower clock.
 */
export function useRepoSummaryPolling(projects: Project[], skip: (project: Project) => boolean): void {
  const key = projects.map((p) => `${p.id}:${p.local_path}`).join("|");
  useEffect(() => {
    const live = projects.filter((p) => !skip(p));
    if (live.length === 0) return;
    const paths = live.map((p) => p.local_path);
    const store = useRepoSummaryStore.getState();
    let lastFocus = 0;
    let lastPrs = 0;
    const summaries = () => void store.refresh(paths);
    const prs = () => {
      lastPrs = Date.now();
      void store.refreshPrs(live);
    };
    summaries();
    prs();
    // Battery saving reads a third as often — every 3 min and every 15 min — by letting two ticks
    // in three go by, so a change of level applies from the next tick with no timer to rebuild.
    let summaryTicks = 0;
    let prTicks = 0;
    const summaryTimer = window.setInterval(() => {
      if (saving(1) && ++summaryTicks % SAVING_STRIDE !== 0) return;
      if (document.visibilityState === "visible") summaries();
    }, SUMMARY_EVERY_MS);
    const prTimer = window.setInterval(() => {
      if (saving(1) && ++prTicks % SAVING_STRIDE !== 0) return;
      if (document.visibilityState === "visible") prs();
    }, PRS_EVERY_MS);
    const onFocus = () => {
      const now = Date.now();
      if (saving(1) && now - lastFocus < SUMMARY_EVERY_MS * SAVING_STRIDE) return;
      if (now - lastFocus < FOCUS_SETTLE_MS) return;
      lastFocus = now;
      summaries();
      if (now - lastPrs > PRS_EVERY_MS / 2) prs();
    };
    window.addEventListener("focus", onFocus);

    // The signals that a repository moved, between ticks (see the store's note).
    const onTouched = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path) store.refreshSoon(path);
    };
    window.addEventListener(REPO_TOUCHED_EVENT, onTouched);
    let unlistenFs: (() => void) | null = null;
    let gone = false;
    void onRepoFsChanged((e) => store.refreshSoon(e.repo_path))
      .then((off) => (gone ? off() : (unlistenFs = off)))
      .catch(() => {});
    // The open repository, copied in as it changes. Skipped on the switch itself: what lands then is
    // a snapshot from when that repository was left, and the summary may well be newer.
    const stopMirror = useRepoStore.subscribe((now, before) => {
      if (!now.repoPath || !now.status || now.repoPath !== before.repoPath) return;
      if (now.status === before.status && now.branches === before.branches) return;
      const mirrored = summaryFromLive(now.repoPath, now.status, now.branches);
      useRepoSummaryStore.setState((s) => ({ byPath: { ...s.byPath, [mirrored.path]: mirrored } }));
    });
    return () => {
      gone = true;
      window.clearInterval(summaryTimer);
      window.clearInterval(prTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(REPO_TOUCHED_EVENT, onTouched);
      unlistenFs?.();
      stopMirror();
    };
    // `key` stands for the list; `skip` reads stores that change on their own clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
