import { create } from "zustand";
import type { PullMode } from "../types/domain";

/**
 * The two questions a git action can have to stop and ask in the middle of running.
 *
 * Asked the way `confirmStore` and `promptStore` ask theirs — the store action awaits a promise, a
 * host component draws the dialog and settles it — because both are reached from inside
 * `repoStore`, which is not a component: a pull that git refused because the branches diverged, a
 * commit that failed because git has no name to sign it with. Neither is a yes/no or a single field,
 * which is why they are not those two stores.
 *
 * The host is `GitDialogs`, mounted by `RemoteActions` — the one git control every window with a
 * repository open renders exactly once, which is what keeps a question from being drawn twice.
 */

export interface PullChoice {
  mode: PullMode;
  /** Write it to the repository's git config, so the next pull does not ask. */
  remember: boolean;
}

interface PullChoiceRequest {
  branch: string;
  upstream: string;
  resolve: (answer: PullChoice | null) => void;
}

interface IdentityRequest {
  /** Resolves `true` once a name and email were saved, `false` when the form was dismissed. */
  resolve: (saved: boolean) => void;
}

interface GitDialogState {
  pullChoice: PullChoiceRequest | null;
  identity: IdentityRequest | null;
  askPullChoice: (branch: string, upstream: string) => Promise<PullChoice | null>;
  answerPullChoice: (answer: PullChoice | null) => void;
  askIdentity: () => Promise<boolean>;
  answerIdentity: (saved: boolean) => void;
}

export const useGitDialogStore = create<GitDialogState>((set, get) => ({
  pullChoice: null,
  identity: null,

  // Asking again while one is open answers the first with "no" before replacing it — a promise
  // dropped on the floor would hang whatever was awaiting it.
  askPullChoice: (branch, upstream) =>
    new Promise<PullChoice | null>((resolve) => {
      get().pullChoice?.resolve(null);
      set({ pullChoice: { branch, upstream, resolve } });
    }),

  answerPullChoice: (answer) => {
    get().pullChoice?.resolve(answer);
    set({ pullChoice: null });
  },

  askIdentity: () =>
    new Promise<boolean>((resolve) => {
      get().identity?.resolve(false);
      set({ identity: { resolve } });
    }),

  answerIdentity: (saved) => {
    get().identity?.resolve(saved);
    set({ identity: null });
  },
}));
