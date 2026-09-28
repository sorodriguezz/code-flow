import type { TranslationKey } from "./i18n/translations";
import type { OperationKind } from "../types/domain";

/**
 * The tagged errors the git layer raises, and the sentence each one becomes.
 *
 * The Rust side prefixes the failures the UI can say something useful about — a locked branch, a
 * merge that would overwrite local work, a remote that refused the credentials — rather than handing
 * back libgit2's or git's English, which names the mechanism ("1 conflict prevents checkout",
 * "terminal prompts disabled") instead of the fix. Each prefix is defined once, beside the code that
 * raises it (`git/branch.rs`, `git/merge.rs`, `git/identity.rs`, `git/remotes.rs`, `remote.rs`,
 * `git/hunk.rs`); this module is the other end of that contract.
 *
 * Out of the store so the mapping can be tested on its own, and so a caller outside `repoStore` —
 * the graph's revert and cherry-pick — says the same thing for the same failure.
 */
export const GIT_ERROR = {
  branchLocked: "BRANCH_LOCKED: ",
  noUpstream: "NO_UPSTREAM: ",
  checkoutConflict: "CHECKOUT_CONFLICT: ",
  /*
   * Two of the three refusals a per-hunk action can come back with — see `src-tauri/src/git/hunk.rs`.
   *
   * All three mean *nothing was written*, which is why they are worth naming separately from a plain
   * error string: the sentence the user needs is "and your file is untouched", and each of the three
   * gets there differently. `HUNK_STALE` is a race the user retries out of (the panel was drawn, the
   * file moved, the fingerprint no longer matches). `HUNK_APPLY_FAILED` is libgit2 declining, which is
   * not retryable and routes them to the whole-file buttons instead. `HUNK_UNSUPPORTED` carries a
   * shape the peek is not supposed to offer a button for at all — an untracked or deleted file, a
   * binary one — so it is deliberately *not* translated: reaching it is a bug in the gating, and the
   * raw tail (`untracked`, `binary`, `3 deltas for one path`) is what makes that bug findable.
   */
  hunkStale: "HUNK_STALE: ",
  hunkApplyFailed: "HUNK_APPLY_FAILED: ",
  mergeBlocked: "MERGE_BLOCKED: ",
  mergeStaged: "MERGE_STAGED: ",
  inProgress: "OPERATION_IN_PROGRESS: ",
  operationConflicts: "OPERATION_CONFLICTS: ",
  unresolved: "UNRESOLVED_CONFLICTS: ",
  identityMissing: "IDENTITY_MISSING: ",
  noRemote: "NO_REMOTE: ",
  remoteFailure: "GIT_REMOTE: ",
  pullDiverged: "PULL_DIVERGED: ",
  pushRejected: "PUSH_REJECTED: ",
  /*
   * Line staging (`git/lines.rs`): the selection names a line the file no longer has, or the file is
   * one lines cannot be picked out of (binary, LFS, a submodule). Both mean nothing was written.
   */
  linesStale: "LINES_STALE: ",
  linesUnsupported: "LINES_UNSUPPORTED: ",
  /*
   * A commit that went through `git commit` (hooks or signing — `git/features.rs`) and did not land.
   * The tail is everything git and the hook printed, which the output dialog shows whole.
   */
  hookFailed: "HOOK_FAILED: ",
  commitFailed: "COMMIT_FAILED: ",
  undoStale: "UNDO_STALE: ",
  worktreeDirty: "WORKTREE_DIRTY: ",
  bisectActive: "BISECT_ACTIVE: ",
  conflictGone: "CONFLICT_GONE: ",
} as const;

export type Translate = (key: TranslationKey, params?: Record<string, string>) => string;

export function hasTag(error: unknown, prefix: string): boolean {
  return String(error).includes(prefix);
}

/** Everything after the prefix, every line of it — a hook's whole output. `null` when absent. */
export function tagBody(error: unknown, prefix: string): string | null {
  const raw = String(error);
  const at = raw.indexOf(prefix);
  return at === -1 ? null : raw.slice(at + prefix.length).trim();
}

/** Whatever follows the prefix, up to the end of its line — a branch name, a list of paths, a code.
 * `null` when the tag is not there. */
export function tagTail(error: unknown, prefix: string): string | null {
  const raw = String(error);
  const at = raw.indexOf(prefix);
  if (at === -1) return null;
  return raw.slice(at + prefix.length).split("\n")[0].trim();
}

const OPERATIONS: readonly OperationKind[] = ["merge", "revert", "cherry_pick", "rebase"];

function asOperation(value: string | null): OperationKind | null {
  return OPERATIONS.find((kind) => kind === value) ?? null;
}

/** The operation an `OPERATION_CONFLICTS` error says stopped for the user, or `null` for any other
 * error. Not a failure: the repository is now mid-operation and the conflicts banner takes over. */
export function stoppedOperation(error: unknown): OperationKind | null {
  return asOperation(tagTail(error, GIT_ERROR.operationConflicts));
}

/** The operation's name the way a sentence says it — "merge", "cherry-pick". */
export function operationLabel(kind: OperationKind, t: Translate): string {
  return t(`operation.${kind}` as TranslationKey);
}

const REMOTE_FAILURES = [
  "auth_required",
  "auth_failed",
  "ssh_key",
  "host_key",
  "network",
  "repo_not_found",
  "timeout",
  "stale_lease",
  "git_too_old",
] as const;

export type RemoteFailure = (typeof REMOTE_FAILURES)[number];

/** Which of the classified remote failures this is — see `classify_failure` in `remote.rs`. */
export function remoteFailure(error: unknown): RemoteFailure | null {
  const code = tagTail(error, GIT_ERROR.remoteFailure);
  return REMOTE_FAILURES.find((known) => known === code) ?? null;
}

/** At most three names, then an ellipsis — a merge blocked by forty files is one sentence, not a
 * wall of paths. */
function shortList(paths: string): string {
  const names = paths
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ");
}

/** Git's own text after a tag, when the tag itself is not something to show. */
function untagged(raw: string): string {
  let text = raw;
  for (const prefix of Object.values(GIT_ERROR)) text = text.split(prefix).join("");
  return text;
}

/**
 * The sentence a git failure is shown as.
 *
 * Every tagged case has one; anything else is git's own text, which is still the most specific
 * thing available when nothing here recognised it.
 */
export function describeGitError(error: unknown, t: Translate): string {
  const raw = String(error);

  const locked = tagTail(raw, GIT_ERROR.branchLocked);
  if (locked !== null) return t("branch.lockedBlocked", { name: locked });
  const noUpstream = tagTail(raw, GIT_ERROR.noUpstream);
  if (noUpstream !== null) return t("branch.noUpstream", { name: noUpstream });
  // The tail of these two is a path or a libgit2 message, and neither adds anything to the sentence:
  // the peek is already sitting on the file in question, and "corrupt patch at line 4" is a fact
  // about a patch the user never saw. The replacement says what happened to their work instead.
  if (hasTag(raw, GIT_ERROR.hunkStale)) return t("peek.stale");
  if (hasTag(raw, GIT_ERROR.hunkApplyFailed)) return t("peek.applyFailed");
  if (hasTag(raw, GIT_ERROR.linesStale)) return t("lines.stale");
  if (hasTag(raw, GIT_ERROR.linesUnsupported)) return t("lines.unsupported");
  // The output itself is in the dialog `gitOutputStore` opens; this is the one line beside it.
  if (hasTag(raw, GIT_ERROR.hookFailed)) return t("commitOutput.hookTitle");
  if (hasTag(raw, GIT_ERROR.commitFailed)) return t("commitOutput.commitTitle");
  if (hasTag(raw, GIT_ERROR.undoStale)) return t("undo.stale");
  if (hasTag(raw, GIT_ERROR.worktreeDirty)) return t("worktrees.dirty");
  if (hasTag(raw, GIT_ERROR.bisectActive)) return t("bisect.activeBlocks");
  if (hasTag(raw, GIT_ERROR.conflictGone)) return t("conflictEditor.gone");

  // The tail is the list of files in the way when libgit2 named them, and empty when it did not.
  const blocked = tagTail(raw, GIT_ERROR.mergeBlocked);
  if (blocked !== null) {
    return blocked ? t("gitError.mergeBlockedFiles", { files: shortList(blocked) }) : t("gitError.mergeBlocked");
  }
  if (hasTag(raw, GIT_ERROR.mergeStaged)) return t("gitError.mergeStaged");
  const running = asOperation(tagTail(raw, GIT_ERROR.inProgress));
  if (running) return t("gitError.inProgress", { operation: operationLabel(running, t) });
  const stopped = stoppedOperation(raw);
  if (stopped) return t("conflicts.stoppedToast", { operation: operationLabel(stopped, t) });
  if (hasTag(raw, GIT_ERROR.unresolved)) return t("gitError.unresolved");
  if (hasTag(raw, GIT_ERROR.identityMissing)) return t("gitError.identityMissing");
  if (hasTag(raw, GIT_ERROR.noRemote)) return t("gitError.noRemote");

  const failure = remoteFailure(raw);
  if (failure) return t(`gitError.remote.${failure}` as TranslationKey);

  return untagged(raw);
}

/**
 * Whether a string can be handed to `git remote add` as a URL: `scheme://…`, the scp-like
 * `user@host:path`, or a local path. Loose on purpose — git is the judge of what it can reach; this
 * only catches the paste that was obviously something else (a web page's address bar with spaces in
 * it, an empty line).
 */
export function looksLikeGitUrl(value: string): boolean {
  const url = value.trim();
  if (!url || /\s/.test(url)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.test(url)) return true;
  if (/^[^@/:]+@[^:/]+:.+/.test(url)) return true;
  return url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || /^[a-z]:[\\/]/i.test(url);
}

/** git's rule for a remote name, near enough to refuse what `git remote add` would. */
export function isValidRemoteName(value: string): boolean {
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith(".lock") && !name.includes("..");
}
