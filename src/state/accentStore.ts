import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { withThemeTransition } from "../lib/themeTransition";

export interface AccentOption {
  id: string;
  label: string;
  light: string;
  dark: string;
}

// Curated, not freeform: each pairs a light-theme shade with a lighter dark-theme shade
// of the same hue, following the same 500/400 pattern already used for the default indigo,
// so every option keeps solid contrast against both --cf-bg values.
export const ACCENT_OPTIONS: AccentOption[] = [
  { id: "indigo", label: "Indigo", light: "#6366f1", dark: "#818cf8" },
  { id: "blue", label: "Blue", light: "#3b82f6", dark: "#60a5fa" },
  { id: "cyan", label: "Cyan", light: "#06b6d4", dark: "#22d3ee" },
  { id: "teal", label: "Teal", light: "#0d9488", dark: "#2dd4bf" },
  { id: "green", label: "Green", light: "#16a34a", dark: "#4ade80" },
  { id: "amber", label: "Amber", light: "#d97706", dark: "#fbbf24" },
  { id: "rose", label: "Rose", light: "#e11d48", dark: "#fb7185" },
  { id: "purple", label: "Purple", light: "#9333ea", dark: "#c084fc" },
];

const KEY = "accent_color";
const DEFAULT_ID = "indigo";

function findOption(id: string): AccentOption {
  return ACCENT_OPTIONS.find((o) => o.id === id) ?? ACCENT_OPTIONS[0];
}

interface AccentState {
  accentId: string;
  init: () => Promise<void>;
  setAccent: (id: string, resolvedTheme: "light" | "dark") => Promise<void>;
  apply: (resolvedTheme: "light" | "dark") => void;
}

export const useAccentStore = create<AccentState>((set, get) => ({
  accentId: DEFAULT_ID,

  init: async () => {
    const stored = await getSetting(KEY).catch(() => null);
    if (stored && ACCENT_OPTIONS.some((o) => o.id === stored)) {
      set({ accentId: stored });
    }
  },

  setAccent: async (id, resolvedTheme) => {
    // Wiped across the window, exactly as the light/dark switch is: the accent is on something in
    // every band of the app — the active tab, the selection pills, the send button, half the icons
    // — so changing it is a repaint of the whole window and deserves the same curtain rather than
    // a frame where all of it changes at once.
    //
    // Re-picking the colour already in force is not, though: a half-second of curtain over an
    // identical window reads as a stutter. Still persisted, since the click is harmless.
    if (get().accentId === id) {
      await setSetting(KEY, id);
      return;
    }

    withThemeTransition(() => {
      set({ accentId: id });
      get().apply(resolvedTheme);
    });
    await setSetting(KEY, id);
  },

  apply: (resolvedTheme) => {
    const option = findOption(get().accentId);
    const hex = resolvedTheme === "dark" ? option.dark : option.light;
    document.documentElement.style.setProperty("--cf-accent", hex);
  },
}));
