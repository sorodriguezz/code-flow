import { create } from "zustand";
import { GIT_ERROR, hasTag, tagBody } from "../lib/gitErrors";

/**
 * What a commit that did not land printed — the hook's refusal, or `git commit`'s own failure.
 *
 * A repository with hooks or signing commits through `git commit` (see `git/features.rs`), and a
 * `pre-commit` that refuses is an ordinary outcome with a lot to say: which lint rule, which test,
 * which file. A toast holds one line and disappears; this holds the whole output until it is read.
 * The commit box keeps its message either way — `commitChanges` only clears it when the commit lands.
 *
 * A store of its own, with no imports of other stores, because `repoStore` writes to it and the
 * dialog that reads it (`GitDialogs`) is mounted where every git action can reach it.
 */

export interface CommitFailure {
  /** A hook said no, or git itself failed (signing, identity, nothing to commit). */
  kind: "hook" | "commit";
  output: string;
}

interface GitOutputState {
  failure: CommitFailure | null;
  show: (failure: CommitFailure) => void;
  dismiss: () => void;
}

export const useGitOutputStore = create<GitOutputState>((set) => ({
  failure: null,
  show: (failure) => set({ failure }),
  dismiss: () => set({ failure: null }),
}));

/**
 * Opens the output dialog when `error` is a commit that failed through `git commit`, and says whether
 * it did — the caller then skips its own toast, which would only repeat the dialog's title.
 */
export function reportCommitFailure(error: unknown): boolean {
  const kind = hasTag(error, GIT_ERROR.hookFailed) ? "hook" : hasTag(error, GIT_ERROR.commitFailed) ? "commit" : null;
  if (!kind) return false;
  const output = tagBody(error, kind === "hook" ? GIT_ERROR.hookFailed : GIT_ERROR.commitFailed) ?? "";
  useGitOutputStore.getState().show({ kind, output });
  return true;
}
