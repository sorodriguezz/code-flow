import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { withThemeTransition } from "../lib/themeTransition";
import { watchSettings } from "../lib/settingsSync";

export interface AccentOption {
  id: string;
  label: string;
  light: string;
  dark: string;
}

// Curated, not freeform, and each option is a *pair* chosen for contrast rather than one hue at two
// brightnesses. The light shade carries white text at ≥ 4.5:1 on Papel (six of the old 500s did
// not — cyan was 2.4:1); the dark shade is the lifted 400 and carries the dark ink `--cf-on-accent`
// switches to on Nocturno, since white on every one of these measured under 3:1. Names are shown
// through `t("accent.<id>")`; `label` stays as the fallback.
export const ACCENT_OPTIONS: AccentOption[] = [
  { id: "indigo", label: "Indigo", light: "#5457e0", dark: "#818cf8" },
  { id: "blue", label: "Blue", light: "#2563d9", dark: "#60a5fa" },
  { id: "cyan", label: "Cyan", light: "#0e7490", dark: "#22d3ee" },
  { id: "teal", label: "Teal", light: "#0f766e", dark: "#2dd4bf" },
  { id: "green", label: "Green", light: "#15803d", dark: "#4ade80" },
  { id: "amber", label: "Amber", light: "#b45309", dark: "#fbbf24" },
  { id: "rose", label: "Rose", light: "#e11d48", dark: "#fb7185" },
  { id: "purple", label: "Purple", light: "#9333ea", dark: "#c084fc" },
  // The hue the first eight left out: everything between purple and rose. Fuchsia is the one warm
  // pink that survives being a button fill — pink-500 and rose-400 both fall under 4.5:1 against
  // the white text that sits on `--cf-accent`.
  { id: "magenta", label: "Magenta", light: "#c026d3", dark: "#e879f9" },
  // The one that isn't a hue at all. Every other option tints the whole window with an opinion, and
  // some people want the chrome to stay out of the way of the code — which is also what makes this
  // the only accent that cannot clash with an editor theme, since it agrees with all of them.
  { id: "graphite", label: "Graphite", light: "#475569", dark: "#94a3b8" },
];

const KEY = "accent_color";
const DEFAULT_ID = "indigo";

function findOption(id: string): AccentOption {
  return ACCENT_OPTIONS.find((o) => o.id === id) ?? ACCENT_OPTIONS[0];
}

interface AccentState {
  accentId: string;
  init: () => Promise<void>;
  /** Re-reads the row after another window wrote it — see `lib/settingsSync`. */
  sync: () => Promise<void>;
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

  sync: async () => {
    const stored = await getSetting(KEY).catch(() => undefined);
    if (stored === undefined) return;
    const id = stored && ACCENT_OPTIONS.some((o) => o.id === stored) ? stored : DEFAULT_ID;
    if (id === get().accentId) return;
    // The mode this window is painted in, read off the document rather than the theme store: that
    // store imports this one, and `data-theme` is what `applyToDocument` writes it to anyway.
    const resolved = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    // The same curtain the main window drew for the same change — see `setAccent`.
    withThemeTransition(() => {
      set({ accentId: id });
      get().apply(resolved);
    });
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

// Picked in Settings, which only the main window has. See `lib/settingsSync`.
watchSettings([KEY], () => useAccentStore.getState().sync());
