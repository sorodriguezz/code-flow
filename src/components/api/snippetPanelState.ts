import { create } from "zustand";
import { getSetting, setSetting } from "../../lib/tauri/commands";

/**
 * Whether the code-snippet panel is open — the one piece of its state that two components need.
 *
 * It used to live in `CodeSnippetPanel` alone, because the only way to open the panel was the rail
 * the panel drew for itself when collapsed: a 36px strip down the right edge with the title written
 * sideways. That rail is now a "Code" button in the request's name row, next to Save, so the switch
 * and the panel are two components and the flag has to sit where both can read it.
 *
 * The persisted setting is the same key with the same meaning as before — `"0"` means open, and
 * anything else, including a key that was never written, means closed — so an install that had the
 * panel open still has it open, and a fresh one still starts closed.
 */

const COLLAPSED_KEY = "api_snippet_collapsed";

interface SnippetPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Set once the user has flipped the panel, so a stored value that arrives late can't undo it. */
let chosen = false;
let loading: Promise<void> | null = null;

export const useSnippetPanelStore = create<SnippetPanelState>((set) => ({
  open: false,
  setOpen: (open) => {
    chosen = true;
    set({ open });
    void setSetting(COLLAPSED_KEY, open ? "0" : "1").catch(() => {});
  },
}));

/** Reads the stored choice once per window; every later mount reuses what is already in memory. */
export function ensureSnippetPanelLoaded(): void {
  if (loading) return;
  loading = getSetting(COLLAPSED_KEY)
    .then((stored) => {
      if (!chosen && stored === "0") useSnippetPanelStore.setState({ open: true });
    })
    .catch(() => {});
}
