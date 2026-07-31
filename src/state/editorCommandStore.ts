import { create } from "zustand";
import { useUiStore } from "./uiStore";

/**
 * The editor's own actions, as requests a keybinding can post.
 *
 * The shortcut registry runs plain functions with no view of React state, and the things these
 * shortcuts drive — which side panel is showing, the file palette, splitting a group — are local
 * state inside `EditorView`. Rather than hoist all of that into a store so a keybinding can reach
 * it, the binding posts a request here and the view acts on it. Same shape as `pendingEditorPath`
 * in `uiStore`, for the same reason: one narrow channel beats making a component's internals
 * public.
 */

export type EditorCommand =
  | "goToFile"
  | "explorer"
  | "findInProject"
  | "anchors"
  | "bookmarks"
  | "debug"
  | "bookmarkToggle"
  | "splitRight"
  | "codeSnap"
  // The explorer's own four. They act on whichever row the tree has focused, so `EditorView` does
  // nothing with them but show the explorer and hand them down to `FileTree`.
  | "newFile"
  | "newFolder"
  | "renamePath"
  | "deletePath";

/**
 * Commands worth switching to the Editor for.
 *
 * Opening a panel or the file palette is a way of *going* to the editor — pressing "find in
 * project" from the graph should land you there with the panel open, the way it does in VS Code.
 * The rest act on the file currently on screen, so firing them from another view would either do
 * nothing or act on a file nobody is looking at; those stay no-ops until the Editor is up.
 */
const REVEALS_EDITOR = new Set<EditorCommand>([
  "goToFile",
  "explorer",
  "findInProject",
  "anchors",
  "bookmarks",
  "debug",
  // Creating a file is a way of going to the editor in exactly the way opening a panel is. Rename
  // and delete are not: they act on the explorer's focused row, and firing them from the graph
  // would be a destructive action aimed at a row nobody is looking at.
  "newFile",
  "newFolder",
]);

interface EditorCommandState {
  /**
   * The pending request. The nonce is what lets the same command fire twice in a row: the view
   * consumes each one, and two identical requests would otherwise be one unchanged object.
   */
  request: { command: EditorCommand; nonce: number } | null;
  send: (command: EditorCommand) => void;
  consume: () => void;
}

let nonce = 0;

export const useEditorCommandStore = create<EditorCommandState>((set) => ({
  request: null,

  send: (command) => {
    const ui = useUiStore.getState();
    if (REVEALS_EDITOR.has(command)) ui.setActiveView("editor");
    else if (ui.activeView !== "editor") return;
    nonce += 1;
    set({ request: { command, nonce } });
  },

  consume: () => set({ request: null }),
}));
