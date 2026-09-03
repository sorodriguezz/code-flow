import { create } from "zustand";
import { useUiStore } from "./uiStore";

/**
 * The API client's own actions, as requests a keybinding can post.
 *
 * The same narrow channel `editorCommandStore` is, and it exists because ⌘S has exactly one owner:
 * `activeChords` keeps a single command per chord, so the registry cannot hold a second "save" for
 * this workspace, and the save itself is several hundred lines of `RequestBuilder` state deep —
 * resolving the draft, filing a scratch request into a collection — which is not state to hoist into
 * a store so that a binding can reach it.
 *
 * Before this, the API view bound ⌘S on `window` itself. That branch never ran: the registry's
 * handler is bound in `App`, ahead of a view mounted lazily on first visit, and its `preventDefault`
 * meant the view's own listener bailed on `defaultPrevented` — so the chord reached the editor's bus,
 * which drops "save" when the editor isn't the active view, and nothing at all was saved.
 */

/**
 * `send` and `closeTab` joined `save` when the registry took over the API client's keyboard.
 *
 * They were a `keydown` listener on `window` inside `ApiView` matching ⌘Enter and ⌘W by hand —
 * which worked, and was invisible: not in the keybindings screen, not in the cheat sheet, and not
 * rebindable. Routing them through the same bus as `save` costs one branch in the consumer and
 * makes them ordinary commands like every other chord in the app.
 */
export type ApiCommand = "save" | "send" | "closeTab";

interface ApiCommandState {
  /**
   * The pending request. The nonce is what lets the same command fire twice in a row: the view
   * consumes each one, and two identical requests would otherwise be one unchanged object.
   */
  request: { command: ApiCommand; nonce: number } | null;
  /**
   * Posts a command, and reports whether this workspace took it — which is what lets one chord
   * serve two views: the shortcut offers it here first and falls back to the editor.
   *
   * Gated on the workspace as well as the view: the database side is also `activeView: "api"`, and
   * it has its own tab strip with nothing here to save.
   */
  send: (command: ApiCommand) => boolean;
  consume: () => void;
}

let nonce = 0;

export const useApiCommandStore = create<ApiCommandState>((set) => ({
  request: null,

  send: (command) => {
    const ui = useUiStore.getState();
    if (ui.activeView !== "api" || ui.apiWorkspace !== "requests") return false;
    nonce += 1;
    set({ request: { command, nonce } });
    return true;
  },

  consume: () => set({ request: null }),
}));
