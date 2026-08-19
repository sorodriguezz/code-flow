import { create } from "zustand";
import type { PackageManager } from "../lib/packageScripts";

/**
 * Which manifest the add-dependency picker is about, while it is open.
 *
 * A store rather than props because the two ends are far apart: the request comes from a CodeLens
 * inside Monaco — which reaches React through a command id and a callback, not through a tree of
 * components — and the dialog is mounted once at the top of the app. Threading the target down
 * would mean `EditorPane` owning a modal that has nothing to do with editing text.
 *
 * Everything the install needs is captured **at open time**. The picker stays usable while you
 * switch files behind it, and an install must go to the manifest whose box you clicked, not to
 * whichever one happens to be focused when you finally press the button.
 */
export interface NpmInstallTarget {
  projectId: string;
  repoPath: string;
  /** Repo-relative path of the manifest, for the reuse key. */
  manifestPath: string;
  /** Repo-relative directory the manifest sits in — `""` at the root, `packages/web` in a monorepo. */
  dir: string;
  /** Which block was clicked, which is what decides `--save-dev`. */
  block: string;
  manager: PackageManager;
  /**
   * What to search for the moment the dialog opens.
   *
   * Set when the request already names a package — the quick fix on a missing import knows it is
   * `pg`, and making somebody retype a name the editor just read off their own file is the kind of
   * step that makes a fix not worth taking. Empty for the "add a dependency" lens, which is a
   * question rather than an answer.
   */
  query?: string;
}

interface NpmInstallState {
  target: NpmInstallTarget | null;
  open: (target: NpmInstallTarget) => void;
  close: () => void;
}

export const useNpmInstallStore = create<NpmInstallState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
