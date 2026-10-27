import { create } from "zustand";

import type { ClaudeErrorInfo } from "../lib/claudeError";

/**
 * The commit box's state, one per repository.
 *
 * It used to be `useState` in `ChangesPanel`, which stays mounted across a repository switch — so the
 * message, the «generating» lock and the AI error were the same for every repository, and a message
 * generated for one landed in whichever was open when the model answered. Keyed by `repoPath`, a
 * generation writes back to the repository it was started for and only that one shows it running.
 */
export interface CommitDraft {
  message: string;
  aiBusy: boolean;
  aiError: ClaudeErrorInfo | null;
}

const EMPTY: CommitDraft = { message: "", aiBusy: false, aiError: null };

interface CommitDraftState {
  drafts: Record<string, CommitDraft>;
  patch: (repoPath: string, next: Partial<CommitDraft> | ((draft: CommitDraft) => Partial<CommitDraft>)) => void;
}

export const useCommitDraftStore = create<CommitDraftState>((set) => ({
  drafts: {},
  patch: (repoPath, next) =>
    set((state) => {
      const current = state.drafts[repoPath] ?? EMPTY;
      const change = typeof next === "function" ? next(current) : next;
      return { drafts: { ...state.drafts, [repoPath]: { ...current, ...change } } };
    }),
}));

/** The draft of `repoPath`, or an empty one — the same object while nothing changes. */
export const useCommitDraft = (repoPath: string | null): CommitDraft =>
  useCommitDraftStore((s) => (repoPath ? s.drafts[repoPath] : undefined) ?? EMPTY);
