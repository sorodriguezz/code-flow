import { create } from "zustand";
import { designClose, designIsOpen, designOpen, getSetting, setSetting } from "../lib/tauri/commands";
import { onDesignPick, type DesignPick } from "../lib/tauri/events";
import { isMainWindow } from "../lib/windowIdentity";
import { pushErrorToast } from "./toastStore";

/**
 * Design mode: the app under development in a preview window, and the element last picked in it.
 *
 * # What is kept here
 *
 * One pick — the last one. Picks are not a history: each one is on its way to a prompt, and the only
 * question anyone asks of it is "send this, or pick another". Keeping a list would mean deciding
 * what a pick from a page that has since reloaded means, and the honest answer is "pick it again".
 *
 * # One listener, in the main window only
 *
 * The event is emitted to every window, because `design.rs`'s navigation hook has no business
 * knowing which one asked. A satellite subscribing as well would hold a second copy of every pick
 * for a card it does not draw, so the subscription is taken once, here, and only where the console
 * is. `init` is idempotent, so an effect may call it on every mount.
 */

/** Where the preview was last pointed, so the next «Design mode» opens there rather than at a
 *  default nobody runs. Per install, not per project: it is a dev server's address. */
const URL_KEY = "design.lastUrl";

interface DesignState {
  /** Whether the preview window is open, as far as this process knows. */
  open: boolean;
  /** The last element picked, or `null`. */
  pick: DesignPick | null;
  /** What `open(…)` was last given, and what the dialog offers next time. */
  lastUrl: string;
  init: () => void;
  /** Opens (or re-points) the preview. Remembers the address. */
  show: (url: string) => Promise<void>;
  hide: () => Promise<void>;
  /** Forgets the current pick — «descartar», and what sending one does afterwards. */
  clear: () => void;
}

let started = false;

export const useDesignStore = create<DesignState>((set) => ({
  open: false,
  pick: null,
  lastUrl: "",

  init: () => {
    if (started || !isMainWindow()) return;
    started = true;
    void getSetting(URL_KEY).then((saved) => {
      if (saved) set({ lastUrl: saved });
    });
    // Asked once rather than tracked: the window can be closed by the user with no event of its
    // own, and the button corrects itself the next time this runs.
    void designIsOpen()
      .then((open) => set({ open }))
      .catch(() => undefined);
    void onDesignPick((pick) => set({ pick, open: true }));
  },

  show: async (url) => {
    const target = url.trim();
    if (target === "") return;
    try {
      await designOpen(target);
      set({ open: true, lastUrl: target });
      await setSetting(URL_KEY, target).catch(() => undefined);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  hide: async () => {
    try {
      await designClose();
    } catch (error) {
      pushErrorToast(String(error));
    }
    // Whatever the close reported: a window that is not there is closed, which is the state asked
    // for. The pick stays — it is on its way to a prompt and the preview is not needed to send it.
    set({ open: false });
  },

  clear: () => set({ pick: null }),
}));

/** Starts the subscription from the app shell. Safe to call more than once — see `init`. */
export function startDesignMode(): void {
  useDesignStore.getState().init();
}
