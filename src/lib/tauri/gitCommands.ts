import { invoke } from "@tauri-apps/api/core";
import type { DiffLine } from "../../types/domain";

/**
 * The git features that match what Fork, Tower and GitKraken offer: line staging, the three-way
 * conflict editor, the reflog and undo, submodules, worktrees, tags and branches on the remote,
 * hooks/signing/LFS, and bisect. The Rust side of each is a module of its own under
 * `src-tauri/src/git/` (`lines`, `conflict`, `reflog`, `submodule`, `worktree`, `remote_refs`,
 * `features`, `bisect`), and the wire shapes below mirror those structs field for field — snake_case,
 * because serde reads the names literally and there is no codegen between the two languages.
 */

// ---------- lines ----------

/** The gutter selection: the changed lines as the diff drew them, verbatim. The backend recomputes
 *  the diff and refuses (`LINES_STALE`) unless every one is still there — see `git/lines.rs`. */
export interface LineSelection {
  file_path: string;
  lines: DiffLine[];
}

export const stageLines = (repoPath: string, selection: LineSelection) =>
  invoke<void>("stage_lines", { repoPath, selection });

export const unstageLines = (repoPath: string, selection: LineSelection) =>
  invoke<void>("unstage_lines", { repoPath, selection });

export const discardLines = (repoPath: string, selection: LineSelection) =>
  invoke<void>("discard_lines", { repoPath, selection });

// ---------- hooks, signing, LFS ----------

export interface RepoFeatures {
  /** Commit hooks that would run: `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`. */
  hooks: string[];
  /** `core.hooksPath` as configured, or `null` for `.git/hooks`. */
  hooks_path: string | null;
  /** `openpgp`, `ssh` or `x509` when `commit.gpgsign` is on. */
  signing: string | null;
  lfs: boolean;
  lfs_available: boolean;
}

export const getRepoFeatures = (repoPath: string) => invoke<RepoFeatures>("get_repo_features", { repoPath });

// ---------- the three-way conflict editor ----------

export type ConflictKind = "text" | "binary" | "deleted_by_us" | "deleted_by_them";

export interface ConflictDetail {
  path: string;
  kind: ConflictKind;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  base_present: boolean;
  ours_present: boolean;
  theirs_present: boolean;
  /** The working copy right now — git's markers plus anything already edited. `null` when not text. */
  working: string | null;
}

export const getConflictDetail = (repoPath: string, relPath: string) =>
  invoke<ConflictDetail>("get_conflict_detail", { repoPath, relPath });

/** The file re-merged from its stages, with base sections (`git merge-file --diff3`). */
export const getConflictMergeText = (repoPath: string, relPath: string) =>
  invoke<string>("get_conflict_merge_text", { repoPath, relPath });

export const resolveConflictWithText = (repoPath: string, relPath: string, text: string) =>
  invoke<void>("resolve_conflict_with_text", { repoPath, relPath, text });

export const resolveConflictDeleted = (repoPath: string, relPath: string) =>
  invoke<void>("resolve_conflict_deleted", { repoPath, relPath });

// ---------- reflog and undo ----------

/** What a reflog entry was — `git/reflog.rs`'s `classify`. */
export type ReflogOp =
  | "commit"
  | "amend"
  | "initial"
  | "merge"
  | "pull"
  | "rebase"
  | "reset"
  | "checkout"
  | "cherry_pick"
  | "revert"
  | "clone"
  | "branch"
  | "other";

export interface ReflogEntry {
  index: number;
  old_oid: string;
  new_oid: string;
  message: string;
  op: ReflogOp;
  time: number;
  summary: string | null;
}

export type UndoStrategy = "soft" | "mixed" | "keep" | "checkout";

export interface UndoPlan {
  op: ReflogOp;
  strategy: UndoStrategy;
  target_oid: string;
  target_summary: string | null;
  checkout_to: string | null;
  branch: string | null;
  message: string;
  head_oid: string;
}

export const listReflog = (repoPath: string, limit: number) =>
  invoke<ReflogEntry[]>("list_reflog", { repoPath, limit });

export const getUndoPlan = (repoPath: string) => invoke<UndoPlan | null>("get_undo_plan", { repoPath });

/** Resolves to the backup ref written first (`refs/codeflow/backups/…`), when one was. */
export const undoLastOperation = (repoPath: string, expectedHead: string) =>
  invoke<string | null>("undo_last_operation", { repoPath, expectedHead });

export const restoreReflogEntry = (repoPath: string, oid: string) =>
  invoke<string | null>("restore_reflog_entry", { repoPath, oid });

// ---------- submodules ----------

export interface SubmoduleInfo {
  name: string;
  path: string;
  abs_path: string;
  url: string | null;
  recorded_oid: string | null;
  checked_out_oid: string | null;
  initialized: boolean;
  out_of_sync: boolean;
  dirty: boolean;
}

export const listSubmodules = (repoPath: string) => invoke<SubmoduleInfo[]>("list_submodules", { repoPath });

/** `git submodule update --init [--recursive]`, for one submodule (`path`) or all of them (`null`). */
export const gitSubmoduleUpdate = (repoPath: string, path: string | null, recursive: boolean) =>
  invoke<void>("git_submodule_update", { repoPath, path, recursive });

// ---------- worktrees ----------

export interface WorktreeInfo {
  name: string | null;
  path: string;
  branch: string | null;
  head_oid: string | null;
  is_main: boolean;
  is_current: boolean;
  locked: boolean;
  prunable: boolean;
}

export const listWorktrees = (repoPath: string) => invoke<WorktreeInfo[]>("list_worktrees", { repoPath });

export const addWorktree = (
  repoPath: string,
  target: string,
  branch: string,
  newBranch: boolean,
  startPoint: string | null,
) => invoke<void>("add_worktree", { repoPath, target, branch, newBranch, startPoint });

/** Refuses a tree with local changes with `WORKTREE_DIRTY` unless `force`. */
export const removeWorktree = (repoPath: string, target: string, force: boolean) =>
  invoke<void>("remove_worktree", { repoPath, target, force });

export const pruneWorktrees = (repoPath: string) => invoke<void>("prune_worktrees", { repoPath });

// ---------- tags and branches on the remote ----------

/** `remoteName: null` is the repository's default remote. */
export const gitPushTag = (repoPath: string, tag: string, remoteName: string | null) =>
  invoke<void>("git_push_tag", { repoPath, tag, remoteName });

export const gitPushAllTags = (repoPath: string, remoteName: string | null) =>
  invoke<void>("git_push_all_tags", { repoPath, remoteName });

export const gitDeleteRemoteTag = (repoPath: string, remoteName: string, tag: string) =>
  invoke<void>("git_delete_remote_tag", { repoPath, remoteName, tag });

/** `remoteBranch` is the remote-tracking name, `origin/feature/x`. */
export const gitDeleteRemoteBranch = (repoPath: string, remoteBranch: string) =>
  invoke<void>("git_delete_remote_branch", { repoPath, remoteBranch });

// ---------- bisect ----------

export type BisectVerdict = "good" | "bad" | "skip";

export interface BisectState {
  active: boolean;
  bad: string | null;
  good: string[];
  skipped: string[];
  /** The commit under test — HEAD while both ends are known and the search is not over. */
  candidate: string | null;
  remaining: number;
  steps: number;
  first_bad: string | null;
}

export const getBisectState = (repoPath: string) => invoke<BisectState>("get_bisect_state", { repoPath });

export const bisectStart = (repoPath: string, verdict: "good" | "bad", rev: string) =>
  invoke<BisectState>("bisect_start", { repoPath, verdict, rev });

export const bisectMark = (repoPath: string, verdict: BisectVerdict, rev: string | null) =>
  invoke<BisectState>("bisect_mark", { repoPath, verdict, rev });

export const bisectReset = (repoPath: string) => invoke<void>("bisect_reset", { repoPath });
