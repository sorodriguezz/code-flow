import { create } from "zustand";

/**
 * «Comparar con HEAD» / «Comparar con rama…»: a repository file as it is on disk against the same
 * file at a revision — VS Code's "Open Changes with…" from Source Control. One dialog for the whole
 * window (`RevisionCompareHost`, mounted once in `App`), whichever view asked.
 */
interface RevisionCompareState {
  /** `revision` is `null` while the user still has to pick one. */
  request: { repoPath: string; path: string; revision: string | null } | null;
  open: (repoPath: string, path: string, revision: string | null) => void;
  setRevision: (revision: string) => void;
  close: () => void;
}

export const useRevisionCompareStore = create<RevisionCompareState>((set) => ({
  request: null,
  open: (repoPath, path, revision) => set({ request: { repoPath, path, revision } }),
  setRevision: (revision) => set((s) => (s.request ? { request: { ...s.request, revision } } : s)),
  close: () => set({ request: null }),
}));
