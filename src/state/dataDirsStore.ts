import { create } from "zustand";
import { appPaths, type LayoutStatus } from "../lib/tauri/commands";

/**
 * Where this install keeps its files, and whether the v1.19 directory split went cleanly.
 *
 * Named `dataDirs` and not `layout` — `layoutStore` is taken, by the pane sizes, and it has been
 * taken since long before this existed. The collision is not hypothetical: it is the same one
 * `paths::layout_manifest_path` avoids by refusing to call its file `layout.json`. In this app,
 * "layout" means where the panes are.
 *
 * **Asked once and cached.** The verdict is decided in Rust during `run()`, before any window
 * exists, and cannot change while the process lives — so re-asking would answer about the same
 * launch with more round trips. The one part that does move is the list of pre-migration database
 * copies, because Settings has a button that deletes them; `refresh` re-reads exactly that.
 *
 * **Deliberately not persisted.** `requirementsStore` keeps a `requirements_checked` row so its
 * modal appears at most once per installation, which is right for a first-run report. It would be
 * wrong here: `notPersistent` means the state root is being discarded at every sign-out, so the row
 * recording "already told them" is discarded with it — and a `failed` verdict has to be shown on
 * every launch until somebody acts on it, not once and never again.
 */
type DataDirsState = {
  status: LayoutStatus | null;
  /** Set when the user dismisses the post-migration notice. Session-scoped on purpose: the notice
   *  only appears on the single launch that actually migrated, so "once" is already guaranteed by
   *  the verdict rather than by a stored flag. */
  noticeDismissed: boolean;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  dismissNotice: () => void;
};

export const useDataDirsStore = create<DataDirsState>((set, get) => ({
  status: null,
  noticeDismissed: false,

  load: async () => {
    if (get().status) return;
    try {
      set({ status: await appPaths() });
    } catch {
      // A failure here means the command itself did not answer, which is a broken build rather
      // than a broken layout. Rendering nothing is the honest response: an error banner about the
      // directory checker would be noise on top of whatever is actually wrong.
    }
  },

  refresh: async () => {
    try {
      set({ status: await appPaths() });
    } catch {
      /* see above */
    }
  },

  dismissNotice: () => set({ noticeDismissed: true }),
}));
