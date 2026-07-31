import { create } from "zustand";
import { useUiStore } from "./uiStore";

/**
 * The database workspace's own actions, as requests a keybinding can post.
 *
 * Same channel as `editorCommandStore`, for the same reason: the shortcut registry runs plain
 * functions with no view of React state, and what these drive — the staged-edit preview, the focus
 * of the filter box, a reload that first asks about unsaved edits — is local to the panel showing
 * the tab. The binding posts a request; whichever panel is mounted acts on it.
 *
 * Unlike the editor's, none of these is a reason to *switch* to the database. Opening a panel is a
 * way of going somewhere; refreshing a result set is not, and firing it from the commit graph would
 * act on a tab nobody is looking at. So they stay no-ops until the workspace is on screen — which
 * is what `view.database` is for.
 */

export type DbCommand = "refresh" | "filter" | "apply";

interface DbCommandState {
  /** The nonce is what lets the same command fire twice in a row; see `editorCommandStore`. */
  request: { command: DbCommand; nonce: number } | null;
  send: (command: DbCommand) => void;
  consume: () => void;
}

let nonce = 0;

export const useDbCommandStore = create<DbCommandState>((set) => ({
  request: null,

  send: (command) => {
    const ui = useUiStore.getState();
    if (ui.activeView !== "api" || ui.apiWorkspace !== "database") return;
    nonce += 1;
    set({ request: { command, nonce } });
  },

  consume: () => set({ request: null }),
}));
