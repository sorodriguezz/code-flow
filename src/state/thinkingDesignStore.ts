import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import { DEFAULT_THINKING_DESIGN, isThinkingDesign, type ThinkingDesign } from "../lib/thinkingDesigns";

const KEY = "ai_thinking_design";

interface ThinkingDesignState {
  /** How every `ThinkingOrb` in this window is drawn. */
  design: ThinkingDesign;
  /** Reads the row — at boot, and again when another window writes it. */
  init: () => Promise<void>;
  setDesign: (design: ThinkingDesign) => Promise<void>;
}

/**
 * The one setting behind the thinking mark's look.
 *
 * A store of its own rather than a field in `preferencesStore`, because of who reads it: every
 * `ThinkingOrb` subscribes, and the orb sits in two dozen components that should not pull the
 * preferences store's imports (the repository store among them) in behind a glyph.
 */
export const useThinkingDesignStore = create<ThinkingDesignState>((set, get) => ({
  design: DEFAULT_THINKING_DESIGN,

  init: async () => {
    const stored = await getSetting(KEY).catch(() => undefined);
    if (stored === undefined) return;
    // Unset, or an id this release does not know (written by a newer one): the reactor.
    const design = isThinkingDesign(stored) ? stored : DEFAULT_THINKING_DESIGN;
    if (design !== get().design) set({ design });
  },

  setDesign: async (design) => {
    set({ design });
    await setSetting(KEY, design);
  },
}));

// Picked in Settings, which only the main window has — and every detached window draws orbs too.
// See `lib/settingsSync`.
watchSettings([KEY], () => useThinkingDesignStore.getState().init());
