import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast } from "./toastStore";
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
  commitChanges: (message: string) => Promise<void>;

  checkoutBranch: (name: string) => Promise<void>;
  checkoutDetached: (refname: string) => Promise<void>;
  checkoutRemoteBranch: (remoteBranch: string) => Promise<void>;
  createBranch: (name: string, startPoint?: string) => Promise<void>;
  deleteBranch: (name: string, isRemote: boolean) => Promise<void>;
  setRemoteUrl: (name: string, url: string) => Promise<void>;
  undoCommit: (commitId: string) => Promise<void>;

  stashSave: (message?: string, includeUntracked?: boolean) => Promise<void>;
  stashApply: (index: number) => Promise<void>;
  stashPop: (index: number) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;

  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  push: (setUpstream?: boolean) => Promise<void>;
}

async function guarded(set: (partial: Partial<RepoState>) => void, fn: () => Promise<void>) {
  set({ busy: true, error: null });
  try {
    await fn();
  } catch (e) {
    const message = String(e);
    set({ error: message });
    pushErrorToast(message);
  } finally {
    set({ busy: false });
  }
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
    set({ checkingOutBranch: name });
    try {
      await guarded(set, async () => {
        await api.checkoutLocalBranch(repoPath, name);
        await get().refreshAll();
      });
    } finally {
      set({ checkingOutBranch: null });
    }
  },

  checkoutDetached: async (refname) => {
    const { repoPath } = get();
    if (!repoPath) return;
    set({ checkingOutBranch: refname });
    try {
      await guarded(set, async () => {
        await api.checkoutDetached(repoPath, refname);
        await get().refreshAll();
      });
    } finally {
      set({ checkingOutBranch: null });
    }
  },

  checkoutRemoteBranch: async (remoteBranch) => {
    const { repoPath } = get();
    if (!repoPath) return;
    set({ checkingOutBranch: remoteBranch });
    try {
      await guarded(set, async () => {
        await api.checkoutRemoteTracking(repoPath, remoteBranch);
        await get().refreshAll();
      });
    } finally {
      set({ checkingOutBranch: null });
    }
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
    await guarded(set, async () => {
      await api.deleteBranch(repoPath, name, isRemote);
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

  stashApply: async (index) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.stashApply(repoPath, index);
      await get().refreshStatus();
    });
  },

  stashPop: async (index) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.stashPop(repoPath, index);
      await get().refreshAll();
    });
  },

  stashDrop: async (index) => {
    const { repoPath } = get();
    if (!repoPath) return;
    await guarded(set, async () => {
      await api.stashDrop(repoPath, index);
      await get().refreshStashes();
    });
  },

  fetch: async () => {
    const { repoPath, remoteOp } = get();
    if (!repoPath || remoteOp) return;
    set({ remoteOp: "fetch" });
    try {
      await api.gitFetch(repoPath);
      await get().refreshBranches();
    } catch (e) {
      const message = String(e);
      set({ error: message });
      pushErrorToast(message);
    } finally {
      set({ remoteOp: null });
    }
  },

  pull: async () => {
    const { repoPath, remoteOp } = get();
    if (!repoPath || remoteOp) return;
    set({ remoteOp: "pull" });
    try {
      await guarded(set, async () => {
        await api.gitPull(repoPath);
        await get().refreshAll();
      });
    } finally {
      set({ remoteOp: null });
    }
  },

  push: async (setUpstream = false) => {
    const { repoPath, remoteOp } = get();
    if (!repoPath || remoteOp) return;
    set({ remoteOp: "push" });
    try {
      await guarded(set, async () => {
        await api.gitPush(repoPath, setUpstream);
        await get().refreshBranches();
      });
    } finally {
      set({ remoteOp: null });
    }
  },
}));
