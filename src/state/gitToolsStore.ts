import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import * as gitApi from "../lib/tauri/gitCommands";
import type {
  BisectState,
  BisectVerdict,
  ReflogEntry,
  RepoFeatures,
  SubmoduleInfo,
  UndoPlan,
  WorktreeInfo,
} from "../lib/tauri/gitCommands";
import type { TagInfo } from "../types/domain";
import { translations, type TranslationKey } from "../lib/i18n/translations";
import { describeGitError, GIT_ERROR, hasTag } from "../lib/gitErrors";
import { describeUndo, reflogSubject } from "../lib/undoPlan";
import { openPathAsProject } from "../lib/openAsProject";
import { useLanguageStore } from "./languageStore";
import { useRepoStore } from "./repoStore";
import { chooseAction, confirmAction } from "./confirmStore";
import { pushErrorToast, pushSuccessToast, useToastStore } from "./toastStore";

/**
 * The repository facts and verbs the newer git features need, beside `repoStore` rather than in it:
 * hooks/signing/LFS, submodules, worktrees, tags, bisect, and the reflog's undo.
 *
 * `repoStore` is already the one place every refresh of status, branches and history goes through,
 * and it follows the open repository; this store follows *it* — see the subscription at the bottom —
 * instead of adding seven more fetches to a `refreshAll` that runs on every watcher tick. What is
 * cheap and changes with the working tree (features, submodules, bisect, the undo plan) is re-read a
 * moment after the status settles; tags and worktrees only when history or the repository change.
 */

function translate(key: TranslationKey, params?: Record<string, string>): string {
  const language = useLanguageStore.getState().language;
  const raw: string = translations[language]?.[key] ?? translations.en[key] ?? key;
  if (!params) return raw;
  return Object.entries(params).reduce((acc, [name, value]) => acc.split(`{${name}}`).join(value), raw);
}

const describe = (e: unknown) => describeGitError(e, translate);

interface GitToolsState {
  /** The repository everything below describes — answers for another one are dropped on arrival. */
  repoPath: string | null;
  features: RepoFeatures | null;
  submodules: SubmoduleInfo[];
  worktrees: WorktreeInfo[];
  tags: TagInfo[];
  bisect: BisectState | null;
  undoPlan: UndoPlan | null;
  /** The long action in flight, for its button's spinner: `tags`, `tag:<name>`, `submodules`,
   *  `submodule:<path>`, `worktree`, `bisect`, `undo`, `restore`. */
  pending: string | null;

  refresh: () => Promise<void>;
  refreshLight: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshWorktrees: () => Promise<void>;

  pushTag: (name: string) => Promise<void>;
  pushAllTags: () => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
  deleteRemoteTag: (name: string) => Promise<void>;
  deleteRemoteBranch: (remoteBranch: string) => Promise<void>;

  updateSubmodules: (path: string | null, recursive: boolean) => Promise<void>;
  openSubmodule: (submodule: SubmoduleInfo) => Promise<void>;

  addWorktree: (target: string, branch: string, newBranch: boolean, start: string | null) => Promise<boolean>;
  removeWorktree: (worktree: WorktreeInfo) => Promise<void>;
  pruneWorktrees: () => Promise<void>;
  openWorktree: (worktree: WorktreeInfo) => Promise<void>;

  bisectStart: (verdict: "good" | "bad", commitId: string) => Promise<void>;
  bisectMark: (verdict: BisectVerdict, rev?: string) => Promise<void>;
  bisectReset: () => Promise<void>;

  undoLast: () => Promise<void>;
  restoreEntry: (entry: ReflogEntry) => Promise<boolean>;
}

/** Runs a network git command under `repoStore`'s remote mutex — two git processes on one working
 *  copy contend for the same ref lockfiles, whichever button started them. */
async function withRemote(kind: "fetch" | "push", work: () => Promise<void>): Promise<boolean> {
  const repo = useRepoStore.getState();
  if (!repo.repoPath || repo.remoteOp) return false;
  useRepoStore.setState({ remoteOp: kind });
  try {
    await work();
    return true;
  } catch (e) {
    pushErrorToast(describe(e));
    return false;
  } finally {
    useRepoStore.setState({ remoteOp: null });
  }
}

/** The remote a tag action aims at: the only one, or the one picked when there are several. */
async function pickRemote(message: string): Promise<string | null> {
  const remotes = useRepoStore.getState().remotes;
  if (remotes.length === 0) {
    pushErrorToast(translate("gitError.noRemote"));
    return null;
  }
  if (remotes.length === 1) return remotes[0].name;
  return chooseAction({ message, choices: remotes.map((r, i) => ({ id: r.name, label: r.name, variant: i === 0 ? "primary" : "secondary" })) });
}

let lightTimer: ReturnType<typeof setTimeout> | null = null;

export const useGitToolsStore = create<GitToolsState>((set, get) => {
  /** The open repository, or `null` — and a check that an answer is still for it. */
  const current = () => useRepoStore.getState().repoPath;
  const still = (repoPath: string) => current() === repoPath && get().repoPath === repoPath;

  const guard = async (pending: string, work: () => Promise<void>) => {
    set({ pending });
    try {
      await work();
    } catch (e) {
      pushErrorToast(describe(e));
    } finally {
      set({ pending: null });
    }
  };

  return {
    repoPath: null,
    features: null,
    submodules: [],
    worktrees: [],
    tags: [],
    bisect: null,
    undoPlan: null,
    pending: null,

    refresh: async () => {
      await Promise.all([get().refreshLight(), get().refreshTags(), get().refreshWorktrees()]);
    },

    refreshLight: async () => {
      const repoPath = current();
      if (!repoPath) return;
      // Each read on its own: a repository whose submodule is broken still has features and a bisect
      // to report, and one failure must not blank the rest.
      const [features, submodules, bisect, undoPlan] = await Promise.all([
        gitApi.getRepoFeatures(repoPath).catch(() => null),
        gitApi.listSubmodules(repoPath).catch(() => [] as SubmoduleInfo[]),
        gitApi.getBisectState(repoPath).catch(() => null),
        gitApi.getUndoPlan(repoPath).catch(() => null),
      ]);
      if (!still(repoPath)) return;
      set({ features, submodules, bisect, undoPlan });
    },

    refreshTags: async () => {
      const repoPath = current();
      if (!repoPath) return;
      const tags = await api.listTags(repoPath).catch(() => [] as TagInfo[]);
      if (still(repoPath)) set({ tags });
    },

    refreshWorktrees: async () => {
      const repoPath = current();
      if (!repoPath) return;
      const worktrees = await gitApi.listWorktrees(repoPath).catch(() => [] as WorktreeInfo[]);
      if (still(repoPath)) set({ worktrees });
    },

    // ---------- tags ----------

    pushTag: async (name) => {
      const repoPath = current();
      if (!repoPath) return;
      const remote = await pickRemote(translate("tags.pickRemote", { name }));
      if (!remote) return;
      set({ pending: `tag:${name}` });
      const ok = await withRemote("push", () => gitApi.gitPushTag(repoPath, name, remote));
      set({ pending: null });
      if (ok) pushSuccessToast(translate("tags.pushed", { name, remote }));
    },

    pushAllTags: async () => {
      const repoPath = current();
      if (!repoPath) return;
      const remote = await pickRemote(translate("tags.pickRemoteAll"));
      if (!remote) return;
      set({ pending: "tags" });
      const ok = await withRemote("push", () => gitApi.gitPushAllTags(repoPath, remote));
      set({ pending: null });
      if (ok) pushSuccessToast(translate("tags.pushedAll", { remote }));
    },

    deleteTag: async (name) => {
      const repoPath = current();
      if (!repoPath) return;
      if (!(await confirmAction(translate("tags.deleteConfirm", { name }), true, translate("tags.delete")))) return;
      await guard(`tag:${name}`, async () => {
        await api.deleteTag(repoPath, name);
        await Promise.all([get().refreshTags(), useRepoStore.getState().refreshCommits()]);
      });
    },

    deleteRemoteTag: async (name) => {
      const repoPath = current();
      if (!repoPath) return;
      const remote = await pickRemote(translate("tags.pickRemote", { name }));
      if (!remote) return;
      const confirmed = await confirmAction(
        translate("tags.deleteRemoteConfirm", { name, remote }),
        true,
        translate("tags.deleteRemote"),
      );
      if (!confirmed) return;
      set({ pending: `tag:${name}` });
      const ok = await withRemote("push", () => gitApi.gitDeleteRemoteTag(repoPath, remote, name));
      set({ pending: null });
      if (ok) pushSuccessToast(translate("tags.deletedRemote", { name, remote }));
    },

    deleteRemoteBranch: async (remoteBranch) => {
      const repoPath = current();
      if (!repoPath) return;
      // The remote is the longest remote name the ref starts with — the same split the backend makes,
      // so the confirmation names the remote that will actually be written to.
      const remote =
        useRepoStore
          .getState()
          .remotes.map((r) => r.name)
          .filter((r) => remoteBranch.startsWith(`${r}/`))
          .sort((a, b) => b.length - a.length)[0] ?? remoteBranch.split("/")[0];
      const branch = remoteBranch.slice(remote.length + 1);
      const confirmed = await confirmAction(
        translate("remoteBranch.deleteConfirm", { branch, remote }),
        true,
        translate("remoteBranch.delete"),
      );
      if (!confirmed) return;
      const ok = await withRemote("push", () => gitApi.gitDeleteRemoteBranch(repoPath, remoteBranch));
      if (ok) {
        await useRepoStore.getState().refreshBranches().catch(() => {});
        pushSuccessToast(translate("remoteBranch.deleted", { branch, remote }));
      }
    },

    // ---------- submodules ----------

    updateSubmodules: async (path, recursive) => {
      const repoPath = current();
      if (!repoPath) return;
      set({ pending: path ? `submodule:${path}` : "submodules" });
      const ok = await withRemote("fetch", () => gitApi.gitSubmoduleUpdate(repoPath, path, recursive));
      set({ pending: null });
      if (ok) {
        await Promise.all([get().refreshLight(), useRepoStore.getState().refreshStatus()]);
        pushSuccessToast(translate("submodules.updated"));
      }
    },

    openSubmodule: async (submodule) => {
      try {
        await openPathAsProject(submodule.abs_path, submodule.url);
      } catch (e) {
        pushErrorToast(String(e));
      }
    },

    // ---------- worktrees ----------

    addWorktree: async (target, branch, newBranch, start) => {
      const repoPath = current();
      if (!repoPath) return false;
      let ok = false;
      await guard("worktree", async () => {
        await gitApi.addWorktree(repoPath, target, branch, newBranch, start);
        ok = true;
        await Promise.all([get().refreshWorktrees(), useRepoStore.getState().refreshBranches()]);
        pushSuccessToast(translate("worktrees.added", { branch }));
      });
      return ok;
    },

    removeWorktree: async (worktree) => {
      const repoPath = current();
      if (!repoPath) return;
      const first = await confirmAction(
        translate("worktrees.removeConfirm", { path: worktree.path }),
        true,
        translate("worktrees.remove"),
      );
      if (!first) return;
      set({ pending: "worktree" });
      try {
        try {
          await gitApi.removeWorktree(repoPath, worktree.path, false);
        } catch (e) {
          if (!hasTag(e, GIT_ERROR.worktreeDirty)) throw e;
          // The one refusal worth a second question: the tree has work in it, and forcing deletes it.
          const force = await confirmAction(
            translate("worktrees.removeDirtyConfirm", { path: worktree.path }),
            true,
            translate("worktrees.removeForce"),
          );
          if (!force) return;
          await gitApi.removeWorktree(repoPath, worktree.path, true);
        }
        await get().refreshWorktrees();
        pushSuccessToast(translate("worktrees.removed"));
      } catch (e) {
        pushErrorToast(describe(e));
      } finally {
        set({ pending: null });
      }
    },

    pruneWorktrees: async () => {
      const repoPath = current();
      if (!repoPath) return;
      await guard("worktree", async () => {
        await gitApi.pruneWorktrees(repoPath);
        await get().refreshWorktrees();
      });
    },

    openWorktree: async (worktree) => {
      const remote = useRepoStore.getState().remotes[0]?.url ?? null;
      try {
        await openPathAsProject(worktree.path, remote);
      } catch (e) {
        pushErrorToast(String(e));
      }
    },

    // ---------- bisect ----------

    bisectStart: async (verdict, commitId) => {
      const repoPath = current();
      if (!repoPath) return;
      await guard("bisect", async () => {
        const bisect = await gitApi.bisectStart(repoPath, verdict, commitId);
        if (still(repoPath)) set({ bisect });
        await useRepoStore.getState().refreshAll();
      });
    },

    bisectMark: async (verdict, rev) => {
      const repoPath = current();
      if (!repoPath) return;
      await guard("bisect", async () => {
        const bisect = await gitApi.bisectMark(repoPath, verdict, rev ?? null);
        if (still(repoPath)) set({ bisect });
        await useRepoStore.getState().refreshAll();
      });
    },

    bisectReset: async () => {
      const repoPath = current();
      if (!repoPath) return;
      await guard("bisect", async () => {
        await gitApi.bisectReset(repoPath);
        await Promise.all([get().refreshLight(), useRepoStore.getState().refreshAll()]);
      });
    },

    // ---------- undo and the reflog ----------

    undoLast: async () => {
      const repoPath = current();
      if (!repoPath) return;
      const plan = await gitApi.getUndoPlan(repoPath).catch(() => null);
      if (!plan) {
        useToastStore.getState().pushToast(translate("undo.nothing"), "info");
        return;
      }
      const { message, confirmLabel, danger } = describeUndo(plan, translate, translate("statusbar.detachedHead"));
      if (!(await confirmAction(message, danger, confirmLabel))) return;
      await guard("undo", async () => {
        await gitApi.undoLastOperation(repoPath, plan.head_oid);
        await Promise.all([useRepoStore.getState().refreshAll(), get().refreshLight()]);
        pushSuccessToast(translate("undo.done", { subject: reflogSubject(plan.message) }));
      });
    },

    restoreEntry: async (entry) => {
      const repoPath = current();
      if (!repoPath) return false;
      const status = useRepoStore.getState().status;
      const branch = status?.is_detached ? translate("statusbar.detachedHead") : (status?.current_branch ?? "HEAD");
      const confirmed = await confirmAction(
        translate("reflog.restoreConfirm", {
          branch,
          sha: entry.new_oid.slice(0, 7),
          subject: entry.summary ?? reflogSubject(entry.message),
        }),
        true,
        translate("reflog.restore"),
      );
      if (!confirmed) return false;
      let ok = false;
      await guard("restore", async () => {
        await gitApi.restoreReflogEntry(repoPath, entry.new_oid);
        ok = true;
        await Promise.all([useRepoStore.getState().refreshAll(), get().refreshLight()]);
        pushSuccessToast(translate("reflog.restored", { sha: entry.new_oid.slice(0, 7) }));
      });
      return ok;
    },
  };
});

// ---------- following the open repository ----------
//
// A new repository resets everything and loads it all; a status refresh (the watcher's, or any
// action's) re-reads the cheap facts a moment later, coalesced so a burst of ticks costs one read; a
// history refresh re-reads the tags, which live on it. Set up once, at import — the first component
// that reads this store is what starts it following.

useRepoStore.subscribe((state, prev) => {
  if (state.repoPath !== prev.repoPath) {
    useGitToolsStore.setState({
      repoPath: state.repoPath,
      features: null,
      submodules: [],
      worktrees: [],
      tags: [],
      bisect: null,
      undoPlan: null,
      pending: null,
    });
    if (state.repoPath) void useGitToolsStore.getState().refresh();
    return;
  }
  if (state.status !== prev.status) {
    if (lightTimer) clearTimeout(lightTimer);
    lightTimer = setTimeout(() => {
      lightTimer = null;
      void useGitToolsStore.getState().refreshLight();
    }, 400);
  }
  if (state.commits !== prev.commits) void useGitToolsStore.getState().refreshTags();
});

{
  const repoPath = useRepoStore.getState().repoPath;
  if (repoPath) {
    useGitToolsStore.setState({ repoPath });
    void useGitToolsStore.getState().refresh();
  }
}
