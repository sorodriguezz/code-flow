import { create } from "zustand";

/**
 * Which changeset «Ver todos los cambios» is showing — VS Code's multi-file diff: every file of the
 * working tree's changes, or of one commit, one under another in a single scroll
 * (`components/git/MultiDiffModal`).
 */
export type MultiDiffRequest =
  | { kind: "working"; repoPath: string }
  | { kind: "commit"; repoPath: string; oid: string; summary: string };

interface MultiDiffState {
  request: MultiDiffRequest | null;
  open: (request: MultiDiffRequest) => void;
  close: () => void;
}

export const useMultiDiffStore = create<MultiDiffState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
