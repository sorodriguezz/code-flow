import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "./toastStore";
import { notify } from "./notificationStore";
import { confirmAction, confirmFlow } from "./confirmStore";
import { useLanguageStore } from "./languageStore";
import { translations, type TranslationKey } from "../lib/i18n/translations";
import type {
  BranchInfo,
  CommitInfo,
  ConflictFile,
  FileDiffInfo,
  RemoteInfo,
  RepoStatusInfo,
  StashInfo,
} from "../types/domain";

interface RepoState {
  repoPath: string | null;
  status: RepoStatusInfo | null;
  branches: BranchInfo[];
  commits: CommitInfo[];
  unpushedCommits: CommitInfo[];
  stashes: StashInfo[];
  remotes: RemoteInfo[];
  selectedCommitId: string | null;
  workingDiff: FileDiffInfo[];
  stagedDiff: FileDiffInfo[];
  commitDiff: FileDiffInfo[];
  busy: boolean;
  error: string | null;
  checkingOutBranch: string | null;
  /** Which of fetch/pull/push is currently running, if any — the three are mutually
   * exclusive so the status bar can show a single loader and block the other two. */
  remoteOp: "fetch" | "pull" | "push" | null;
  merging: boolean;
  conflicts: ConflictFile[];
  commitsLoading: boolean;
  /** True from the moment a repo is selected until every piece of its sidebar data
   * (branches, stashes, remotes, merge state…) has landed — lets the sidebar show one
   * skeleton and reveal everything together instead of each section popping in as its
   * own fetch happens to resolve. */
  projectLoading: boolean;

  setRepoPath: (path: string | null) => Promise<void>;
  refreshAll: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshBranches: () => Promise<void>;
  refreshCommits: () => Promise<void>;
  refreshUnpushedCommits: () => Promise<void>;
  refreshStashes: () => Promise<void>;
  refreshRemotes: () => Promise<void>;
  refreshMergeState: () => Promise<void>;
  selectCommit: (id: string | null) => Promise<void>;

  mergeBranch: (branchName: string) => Promise<import("../types/domain").MergeOutcome | null>;
  resolveConflict: (relPath: string, side: "ours" | "theirs") => Promise<void>;
  markConflictResolved: (relPath: string) => Promise<void>;
  completeMerge: (message: string) => Promise<void>;
  abortMerge: () => Promise<void>;

  stageFile: (filePath: string) => Promise<void>;
  unstageFile: (filePath: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  discardFile: (filePath: string) => Promise<void>;
  discardAll: () => Promise<void>;
  commitChanges: (message: string) => Promise<void>;

  checkoutBranch: (name: string) => Promise<void>;
  checkoutDetached: (refname: string) => Promise<void>;
  /** `alreadyConfirmed` is for the one caller that asks its own, more contextual question first
   * (the AI finding card, jumping to a PR's branch) — everywhere else confirms here. */
  checkoutRemoteBranch: (remoteBranch: string, alreadyConfirmed?: boolean) => Promise<void>;
  createBranch: (name: string, startPoint?: string) => Promise<void>;
  deleteBranch: (name: string, isRemote: boolean) => Promise<void>;
  setBranchLocked: (name: string, locked: boolean) => Promise<void>;
  setRemoteUrl: (name: string, url: string) => Promise<void>;
  undoCommit: (commitId: string) => Promise<void>;

  stashSave: (message?: string, includeUntracked?: boolean) => Promise<void>;
  stashApply: (index: number) => Promise<void>;
  stashPop: (index: number) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
  renameStash: (index: number, newMessage: string) => Promise<void>;

  fetch: () => Promise<void>;
  /**
   * The same fetch, run because the user moved around rather than because they asked for one.
   *
   * Files no notification, raises no toast and does not touch `error` — see `lib/backgroundFetch`,
   * which owns *when* this runs and is the only thing that should be calling it.
   */
  fetchSilently: () => Promise<void>;
  pull: () => Promise<void>;
  push: (setUpstream?: boolean) => Promise<void>;
}

/** Returns whether `fn` got through. Almost every caller ignores it — the toast and `error` are
 * the report — but the remote operations need to know, because they also file a notification and
 * "Push finished" on a failed push would be a lie. */
async function guarded(
  set: (partial: Partial<RepoState>) => void,
  fn: () => Promise<void>,
): Promise<boolean> {
  set({ busy: true, error: null });
  try {
    await fn();
    return true;
  } catch (e) {
    const message = describeError(e);
    set({ error: message });
    pushErrorToast(message);
    return false;
  } finally {
    set({ busy: false });
  }
}

/**
 * "repo · branch" for a remote operation's notification line.
 *
 * Read *before* the operation runs, not after: an auto-fetch can finish long after the user has
 * switched projects, and a notification that named the repository they happen to be looking at now
 * would be pointing at the wrong one.
 */
function notificationDetail(state: Pick<RepoState, "repoPath" | "status">): string {
  const repo = state.repoPath?.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const branch = state.status?.current_branch ?? "";
  return [repo, branch].filter(Boolean).join(" · ");
}

/** Translates outside of React (this store isn't a component) using whatever language is
 * currently selected — same lookup `useT()` does, just without the hook. */
function translate(key: TranslationKey, params?: Record<string, string>): string {
  const language = useLanguageStore.getState().language;
  const raw: string = translations[language][key] ?? translations.en[key] ?? key;
  if (!params) return raw;
  return Object.entries(params).reduce((acc, [name, value]) => acc.split(`{${name}}`).join(value), raw);
}

/**
 * How long a background fetch may keep the remote buttons disabled — see `fetchSilently`.
 *
 * Far above any fetch that is merely slow (a large repository over a bad connection is seconds,
 * not tens of them), because releasing the lock early on a fetch that is still running is the one
 * thing this is trying not to do. It is a bound on the pathological case, not a deadline.
 */
const SILENT_FETCH_LOCK_MS = 45_000;

/**
 * When the background fetch currently out there started, or `null` when there is none.
 *
 * Keeps two of them from overlapping, which `remoteOp` alone stopped doing the moment the watchdog
 * above was introduced: past the timeout the lock is gone but the `git` process is not.
 *
 * A timestamp and not a boolean, and that is the whole point. The case this exists for is a fetch
 * whose promise never settles — a flag cleared in a `finally` would never be cleared at all, and
 * the failure would not be a stuck button but background fetching quietly never happening again
 * for the rest of the session, with nothing on screen to say so. Held for as long as the lock is,
 * so at worst a hung fetch costs one interval and then the feature carries on around it.
 */
let silentFetchStartedAt: number | null = null;

/** Set by the Rust side on the one checkout failure that has a way out — see
 * `CHECKOUT_CONFLICT_PREFIX` in `src-tauri/src/git/branch.rs`. */
const CHECKOUT_CONFLICT_PREFIX = "CHECKOUT_CONFLICT: ";

/** Set by the Rust side when a locked branch is what refused the operation — see
 * `BRANCH_LOCKED_PREFIX` in `src-tauri/src/git/branch.rs`. */
const BRANCH_LOCKED_PREFIX = "BRANCH_LOCKED: ";

/** Turns the tagged errors the git layer raises into something worth reading. Every store action
 * reports through here, so a lock refusal explains itself no matter which route hit it — the
 * status bar's push button, a keyboard shortcut, or the sidebar's merge action. */
function describeError(e: unknown): string {
  const raw = String(e);
  const locked = raw.indexOf(BRANCH_LOCKED_PREFIX);
  if (locked !== -1) {
    return translate("branch.lockedBlocked", { name: raw.slice(locked + BRANCH_LOCKED_PREFIX.length).trim() });
  }
  return raw.replace(CHECKOUT_CONFLICT_PREFIX, "");
}

/** The branch a merge/stash would land on, named the way the confirmation should say it. */
function currentTargetLabel(get: () => RepoState): string {
  return get().status?.current_branch ?? translate("statusbar.detachedHead");
}

/** Runs a checkout and, when uncommitted work is what blocks it, offers to stash that work
 * and retry rather than just reporting the failure — the same escape hatch you'd reach for
 * by hand. Declining still surfaces the original error. */
async function checkoutGuarded(
  set: (partial: Partial<RepoState>) => void,
  get: () => RepoState,
  target: string,
  run: () => Promise<void>,
) {
  const { repoPath } = get();
  if (!repoPath) return;
  set({ checkingOutBranch: target, busy: true, error: null });
  try {
    try {
      await run();
    } catch (e) {
      if (!String(e).includes(CHECKOUT_CONFLICT_PREFIX)) throw e;
      const stash = await confirmAction(
        translate("checkout.blockedByChanges", { name: target }),
        false,
        translate("checkout.stashAndSwitch"),
      );
      if (!stash) throw e;
      await api.stashSave(repoPath, translate("checkout.autoStashMessage", { name: target }), true);
      await run();
      useToastStore.getState().pushToast(translate("checkout.changesStashed"), "info");
    }
    await get().refreshAll();
  } catch (e) {
    const message = describeError(e);
    set({ error: message });
    pushErrorToast(message);
  } finally {
    set({ busy: false, checkingOutBranch: null });
  }
}

/** Apply/pop/drop differ only in wording, tone and whether the stash survives, so the three
 * confirmations are built from one table rather than three near-copies. */
const STASH_CONFIRMS = {
  apply: { kind: "stash-apply", danger: false },
  pop: { kind: "stash-pop", danger: false },
  drop: { kind: "stash-drop", danger: true },
} as const;

async function confirmStashAction(
  get: () => RepoState,
  op: keyof typeof STASH_CONFIRMS,
  index: number,
): Promise<boolean> {
  const { kind, danger } = STASH_CONFIRMS[op];
  // The list is keyed by git's own stash index, and a stale one would confirm the wrong entry —
  // fall back to naming the slot rather than showing an empty pill.
  const source = get().stashes.find((s) => s.index === index)?.message ?? `stash@{${index}}`;
  const target = op === "drop" ? translate("confirm.stashDropTarget") : currentTargetLabel(get);
  return confirmFlow({
    flow: { kind, source, target, note: translate(`confirm.${op}StashNote`, { target }) },
    message: translate(`confirm.${op}StashTitle`, { source }),
    confirmLabel: translate(`confirm.${op}StashConfirm`),
    danger,
  });
}

export const useRepoStore = create<RepoState>((set, get) => ({
  repoPath: null,
  status: null,
  branches: [],
  commits: [],
  unpushedCommits: [],
  stashes: [],
  remotes: [],
  selectedCommitId: null,
  workingDiff: [],
  stagedDiff: [],
  commitDiff: [],
  busy: false,
  error: null,
  checkingOutBranch: null,
  remoteOp: null,
  merging: false,
  conflicts: [],
  commitsLoading: false,
  projectLoading: false,

  setRepoPath: async (path) => {
    set({
      repoPath: path,
      projectLoading: Boolean(path),
      status: null,
      branches: [],
      commits: [],
      unpushedCommits: [],
      stashes: [],
      remotes: [],
      selectedCommitId: null,
      workingDiff: [],
      stagedDiff: [],
      commitDiff: [],
      merging: false,
      conflicts: [],
    });
    if (path) {
      await get().refreshAll();
      // Guards against a stale resolution: if the user already switched to another repo
      // while this fetch was in flight, don't clear the new repo's loading state.
      if (get().repoPath === path) set({ projectLoading: false });
    }
  },

  refreshAll: async () => {
    await Promise.all([
      get().refreshStatus(),
      get().refreshBranches(),
      get().refreshCommits(),
      get().refreshUnpushedCommits(),
      get().refreshStashes(),
      get().refreshRemotes(),
      get().refreshMergeState(),
    ]);
  },

  refreshStatus: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      const [status, workingDiff, stagedDiff] = await Promise.all([
        api.getStatus(repoPath),
        api.getWorkingDiff(repoPath),
        api.getStagedDiff(repoPath),
      ]);
      set({ status, workingDiff, stagedDiff });
    });
  },

  refreshBranches: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    const branches = await api.listBranches(repoPath);
    set({ branches });
  },

  refreshCommits: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    set({ commitsLoading: true });
    try {
      const commits = await api.listCommits(repoPath, true, 500);
      set({ commits });
    } finally {
      set({ commitsLoading: false });
    }
  },

  refreshUnpushedCommits: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    const unpushedCommits = await api.listUnpushedCommits(repoPath);
    set({ unpushedCommits });
  },

  refreshStashes: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    const stashes = await api.listStashes(repoPath);
    set({ stashes });
  },

  refreshRemotes: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    const remotes = await api.listRemotes(repoPath);
    set({ remotes });
  },

  refreshMergeState: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    const merging = await api.isMerging(repoPath);
    const conflicts = merging ? await api.listConflicts(repoPath) : [];
    set({ merging, conflicts });
  },

  mergeBranch: async (branchName) => {
    const { repoPath } = get();
    if (!repoPath) return null;
    // Which branch moves is the whole question here, and the answer isn't the one you clicked —
    // so it's confirmed with the direction drawn out, from every caller.
    const target = currentTargetLabel(get);
    const confirmed = await confirmFlow({
      flow: {
        kind: "merge",
        source: branchName,
        target,
        note: translate("confirm.mergeNote", { source: branchName, target }),
      },
      message: translate("confirm.mergeTitle", { source: branchName, target }),
      confirmLabel: translate("confirm.mergeConfirm"),
    });
    if (!confirmed) return null;

    let outcome: import("../types/domain").MergeOutcome | null = null;
    await guarded(set, async () => {
      outcome = await api.mergeBranch(repoPath, branchName);
      await get().refreshAll();
    });
    return outcome;
  },

  resolveConflict: async (relPath, side) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.resolveConflictSide(repoPath, relPath, side);
      await Promise.all([get().refreshMergeState(), get().refreshStatus()]);
    });
  },

  markConflictResolved: async (relPath) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.markConflictResolved(repoPath, relPath);
      await Promise.all([get().refreshMergeState(), get().refreshStatus()]);
    });
  },

  completeMerge: async (message) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.completeMerge(repoPath, message);
      await get().refreshAll();
    });
  },

  abortMerge: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.abortMerge(repoPath);
      await get().refreshAll();
    });
  },

  selectCommit: async (id) => {
    const { repoPath } = get();
    set({ selectedCommitId: id, commitDiff: [] });
    if (repoPath && id) {
      const commitDiff = await api.getCommitDiff(repoPath, id);
      set({ commitDiff });
    }
  },

  stageFile: async (filePath) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.stageFile(repoPath, filePath);
      await get().refreshStatus();
    });
  },

  unstageFile: async (filePath) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.unstageFile(repoPath, filePath);
      await get().refreshStatus();
    });
  },

  stageAll: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.stageAll(repoPath);
      await get().refreshStatus();
    });
  },

  unstageAll: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.unstageAll(repoPath);
      await get().refreshStatus();
    });
  },

  discardFile: async (filePath) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.discardFileChanges(repoPath, filePath);
      await get().refreshStatus();
    });
  },

  discardAll: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.discardAllChanges(repoPath);
      await get().refreshStatus();
    });
  },

  commitChanges: async (message) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.commitChanges(repoPath, message);
      await get().refreshAll();
    });
  },

  checkoutBranch: async (name) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await checkoutGuarded(set, get, name, () => api.checkoutLocalBranch(repoPath, name));
  },

  checkoutDetached: async (refname) => {
    const { repoPath } = get();
    if (!repoPath) return;
    const confirmed = await confirmFlow({
      flow: {
        kind: "detach",
        source: refname,
        target: translate("statusbar.detachedHead"),
        note: translate("confirm.detachNote"),
      },
      message: translate("confirm.detachTitle", { name: refname }),
      confirmLabel: translate("confirm.detachConfirm"),
    });
    if (!confirmed) return;

    await checkoutGuarded(set, get, refname, () => api.checkoutDetached(repoPath, refname));

    // Detaching leaves no branch marked as head, so the branch list — the place you were just
    // looking — goes quiet and the switch reads as a no-op. Name the commit HEAD landed on.
    const status = get().status;
    if (status?.is_detached && status.head_oid) {
      useToastStore
        .getState()
        .pushToast(translate("checkout.detachedAt", { sha: status.head_oid.slice(0, 7) }), "info");
    }
  },

  checkoutRemoteBranch: async (remoteBranch, alreadyConfirmed = false) => {
    const { repoPath } = get();
    if (!repoPath) return;
    // Everything after the remote name: `origin/feature/x` tracks a local `feature/x`.
    const local = remoteBranch.split("/").slice(1).join("/") || remoteBranch;
    if (!alreadyConfirmed) {
      const confirmed = await confirmFlow({
        flow: {
          kind: "checkout",
          source: remoteBranch,
          target: local,
          note: translate("confirm.checkoutRemoteNote", { local }),
        },
        message: translate("confirm.checkoutRemoteTitle", { name: remoteBranch }),
        confirmLabel: translate("confirm.checkoutRemoteConfirm"),
      });
      if (!confirmed) return;
    }
    await checkoutGuarded(set, get, remoteBranch, async () => {
      await api.checkoutRemoteTracking(repoPath, remoteBranch);
    });
  },

  createBranch: async (name, startPoint) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.createBranch(repoPath, name, startPoint);
      await get().refreshBranches();
    });
  },

  deleteBranch: async (name, isRemote) => {
    const { repoPath } = get();
    if (!repoPath) return;
    const confirmed = await confirmFlow({
      flow: {
        kind: "branch-delete",
        source: name,
        target: translate("confirm.deleteBranchTarget"),
        note: translate("confirm.deleteBranchNote"),
      },
      message: translate("confirm.deleteBranchTitle", { name }),
      confirmLabel: translate("confirm.deleteBranchConfirm"),
      danger: true,
    });
    if (!confirmed) return;
    await guarded(set, async () => {
      await api.deleteBranch(repoPath, name, isRemote);
      await get().refreshBranches();
    });
  },

  setBranchLocked: async (name, locked) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.setBranchLocked(repoPath, name, locked);
      await get().refreshBranches();
    });
  },

  setRemoteUrl: async (name, url) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.setRemoteUrl(repoPath, name, url);
      await get().refreshRemotes();
    });
  },

  undoCommit: async (commitId) => {
    const { repoPath, commits } = get();
    if (!repoPath) return;
    const commit = commits.find((c) => c.id === commitId);
    if (!commit || commit.parent_ids.length === 0) return;
    await guarded(set, async () => {
      await api.resetToCommit(repoPath, commit.parent_ids[0], "mixed");
      await get().refreshAll();
    });
  },

  stashSave: async (message, includeUntracked = false) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.stashSave(repoPath, message, includeUntracked);
      await get().refreshAll();
    });
  },

  // Apply, pop and drop all write to the working tree or throw stashed work away, so each is
  // confirmed here rather than at the button — viewing and renaming a stash change nothing and
  // stay immediate.
  stashApply: async (index) => {
    const { repoPath } = get();
    if (!repoPath) return;
    if (!(await confirmStashAction(get, "apply", index))) return;
    await guarded(set, async () => {
      await api.stashApply(repoPath, index);
      await get().refreshStatus();
    });
  },

  stashPop: async (index) => {
    const { repoPath } = get();
    if (!repoPath) return;
    if (!(await confirmStashAction(get, "pop", index))) return;
    await guarded(set, async () => {
      await api.stashPop(repoPath, index);
      await get().refreshAll();
    });
  },

  stashDrop: async (index) => {
    const { repoPath } = get();
    if (!repoPath) return;
    if (!(await confirmStashAction(get, "drop", index))) return;
    await guarded(set, async () => {
      await api.stashDrop(repoPath, index);
      await get().refreshStashes();
    });
  },

  renameStash: async (index, newMessage) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.renameStash(repoPath, index, newMessage);
      await get().refreshStashes();
    });
  },

  fetch: async () => {
    const { repoPath, remoteOp } = get();
    if (!repoPath || remoteOp) return;
    set({ remoteOp: "fetch" });
    // Captured before the work: a fetch is the one remote op that also runs on a timer, so by the
    // time it lands the user may well be looking at a different repository than the one it was for.
    const where = notificationDetail(get());
    try {
      await api.gitFetch(repoPath);
      await get().refreshBranches();
      notify({ source: "git", titleKey: "notifications.gitFetched", status: "success", detail: where });
    } catch (e) {
      const message = String(e);
      set({ error: message });
      pushErrorToast(message);
      notify({ source: "git", titleKey: "notifications.gitFetchFailed", status: "error", detail: where });
    } finally {
      set({ remoteOp: null });
    }
  },

  fetchSilently: async () => {
    // A previous background fetch that has already handed the status bar back but has not come
    // home — see `silentFetchStartedAt`.
    if (silentFetchStartedAt !== null && Date.now() - silentFetchStartedAt < SILENT_FETCH_LOCK_MS) {
      return;
    }
    const { repoPath, remoteOp } = get();
    if (!repoPath || remoteOp) return;
    silentFetchStartedAt = Date.now();
    // Through the same `remoteOp` mutex as the other three rather than around it. Two `git`
    // processes on one working copy contend for the same ref lockfiles, and the one that would
    // lose that race here is a pull the user is watching — so a background fetch waits its turn
    // exactly like the timed one already does, and what makes it *silent* is everything below.
    set({ remoteOp: "fetch" });

    // …but it does not get to hold that turn forever. `git fetch` against a host that is neither
    // reachable nor refusing — a VPN that dropped, a server behind a black hole — sits in a TCP
    // connect with no deadline of its own, and until this change nothing reached the remote
    // unless the user asked it to. Now that arriving anywhere fetches, a single hung process
    // would leave Pull and Push greyed out for the rest of the session, with nothing on screen
    // saying why. So the lock is given up on a timer whether or not `git` has come back.
    //
    // Only the *lock* is released — the fetch itself is left to finish or die on its own, and
    // `backgroundFetch` will not start another while it is still out there. Releasing early costs
    // at worst the ref-lock contention described above, in the one case where the alternative is
    // a window whose remote buttons never come back.
    let released = false;
    const release = () => {
      // Whoever gets here first wins, and only while the lock is still the one this took: past
      // the timeout it may already belong to a pull the user started in the meantime, and
      // clearing that would re-enable the buttons underneath their own running operation.
      if (released) return;
      released = true;
      if (get().remoteOp === "fetch") set({ remoteOp: null });
    };
    const watchdog = setTimeout(release, SILENT_FETCH_LOCK_MS);

    try {
      // A repository with no remote has nothing to fetch from, and this runs often enough that
      // spawning `git fetch origin` to be told so on every click is worth one local read to
      // avoid. Read lazily rather than from the state captured above: this fires alongside the
      // `refreshAll` that a repository switch starts, so the list has usually not landed yet.
      if (get().remotes.length === 0) await get().refreshRemotes();
      if (get().remotes.length === 0 || get().repoPath !== repoPath) return;
      await api.gitFetch(repoPath);
      // Switching repository is one of the things that *starts* a background fetch, so landing
      // back here for a repo the user has already left is ordinary rather than exceptional —
      // and `refreshBranches` reads whatever `repoPath` is now, which would file the new
      // repository's branches as this fetch's answer.
      if (get().repoPath !== repoPath) return;
      await get().refreshBranches();
    } catch {
      // Swallowed on purpose, and the whole difference from `fetch` above. Nobody aimed this at
      // the remote — it came from opening a menu — so a laptop on a train would otherwise answer
      // every click with a toast about a host it cannot reach, and fill the bell with the same
      // failure a hundred times over. The ahead/behind counts simply stay as they were.
    } finally {
      clearTimeout(watchdog);
      release();
      silentFetchStartedAt = null;
    }
  },

  pull: async () => {
    const { repoPath, remoteOp } = get();
    if (!repoPath || remoteOp) return;
    set({ remoteOp: "pull" });
    const where = notificationDetail(get());
    try {
      const ok = await guarded(set, async () => {
        await api.gitPull(repoPath);
        await get().refreshAll();
      });
      notify({
        source: "git",
        titleKey: ok ? "notifications.gitPulled" : "notifications.gitPullFailed",
        status: ok ? "success" : "error",
        detail: where,
      });
    } finally {
      set({ remoteOp: null });
    }
  },

  push: async (setUpstream = false) => {
    const { repoPath, remoteOp } = get();
    if (!repoPath || remoteOp) return;
    set({ remoteOp: "push" });
    const where = notificationDetail(get());
    try {
      const ok = await guarded(set, async () => {
        await api.gitPush(repoPath, setUpstream);
        await Promise.all([get().refreshBranches(), get().refreshUnpushedCommits()]);
      });
      // Publishing a branch and pushing to one it already tracks are different enough events that
      // the notification names them differently — the first created something upstream.
      notify({
        source: "git",
        titleKey: setUpstream
          ? ok
            ? "notifications.gitPublished"
            : "notifications.gitPublishFailed"
          : ok
            ? "notifications.gitPushed"
            : "notifications.gitPushFailed",
        status: ok ? "success" : "error",
        detail: where,
      });
    } finally {
      set({ remoteOp: null });
    }
  },
}));
