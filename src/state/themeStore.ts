import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import {
  applyThemeVars,
  findTheme,
  monacoThemeName,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
} from "../lib/codeThemes";
import { withThemeTransition } from "../lib/themeTransition";
import { useAccentStore } from "./accentStore";
import type { ThemePreference } from "../types/domain";

interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
  /** Chosen scheme per mode. Kept separately because a palette built for a dark background is
   * unreadable on a light one — switching modes swaps schemes rather than recoloring one. */
  darkThemeId: string;
  lightThemeId: string;
  /** The scheme in force right now, as Monaco knows it — what every editor passes as `theme`. */
  monacoTheme: string;
  init: () => Promise<void>;
  setPreference: (pref: ThemePreference) => Promise<void>;
  setThemeId: (mode: "light" | "dark", id: string) => Promise<void>;
}

const SETTING_KEY = "theme_preference";
const DARK_KEY = "code_theme_dark";
const LIGHT_KEY = "code_theme_light";

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function resolve(pref: ThemePreference): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

/** Applies a mode + its chosen scheme in one go: the `data-theme` attribute (which the CSS
 * defaults and every `dark:` variant key off), the scheme's own variables on top, and finally the
 * accent — whose hex differs per mode, and which `applyThemeVars` deliberately leaves alone because
 * the accent picker owns it.
 *
 * The accent belongs in here rather than in the effect that used to be its only caller: an effect
 * runs a frame after the swap, which was a brief flash of the wrong accent, and — now that the swap
 * is photographed for the wipe — would be a whole frozen half-second of it. */
function applyToDocument(resolved: "light" | "dark", themeId: string): string {
  document.documentElement.dataset.theme = resolved;
  const theme = findTheme(themeId, resolved);
  applyThemeVars(theme);
  useAccentStore.getState().apply(resolved);
  return monacoThemeName(theme.id);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: "system",
  resolved: resolve("system"),
  darkThemeId: DEFAULT_DARK_THEME,
  lightThemeId: DEFAULT_LIGHT_THEME,
  monacoTheme: monacoThemeName(resolve("system") === "dark" ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME),

  init: async () => {
    const [storedPref, storedDark, storedLight] = await Promise.all([
      getSetting(SETTING_KEY).catch(() => null),
      getSetting(DARK_KEY).catch(() => null),
      getSetting(LIGHT_KEY).catch(() => null),
    ]);
    const preference = (storedPref as ThemePreference | null) ?? "system";
    const darkThemeId = findTheme(storedDark ?? DEFAULT_DARK_THEME, "dark").id;
    const lightThemeId = findTheme(storedLight ?? DEFAULT_LIGHT_THEME, "light").id;
    const resolved = resolve(preference);
    const monacoTheme = applyToDocument(resolved, resolved === "dark" ? darkThemeId : lightThemeId);
    set({ preference, resolved, darkThemeId, lightThemeId, monacoTheme });

    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (get().preference !== "system") return;
      const next = resolve("system");
      const { darkThemeId: dark, lightThemeId: light } = get();
      // Wiped, exactly as a deliberate switch is. The OS flipping at sunset is the one theme change
      // nobody asked for, and having it announce itself is the difference between "the app changed"
      // and "something went wrong with the app".
      withThemeTransition(() => {
        set({ resolved: next, monacoTheme: applyToDocument(next, next === "dark" ? dark : light) });
      });
    });
  },

  setPreference: async (preference) => {
    const resolved = resolve(preference);
    const { darkThemeId, lightThemeId } = get();

    const paint = () => {
      const monacoTheme = applyToDocument(resolved, resolved === "dark" ? darkThemeId : lightThemeId);
      set({ preference, resolved, monacoTheme });
    };

    // Only a change of *mode* is wiped. Picking "System" while already dark, or moving between the
    // three buttons without the resolved mode changing, repaints nothing — half a second of curtain
    // over an identical window would read as a stutter, not as an effect.
    if (resolved === get().resolved) {
      paint();
    } else {
      withThemeTransition(paint);
    }

    await setSetting(SETTING_KEY, preference);
  },

  setThemeId: async (mode, id) => {
    const theme = findTheme(id, mode);
    const remember = () =>
      set(mode === "dark" ? { darkThemeId: theme.id } : { lightThemeId: theme.id });

    // Only repaints when the edited mode is the one on screen — picking a dark scheme while in
    // light mode stores the choice for later instead of flashing it. When it does repaint, every
    // surface in the window takes a new colour, which is the same event as flipping the mode and
    // gets the same curtain; the choice itself is remembered inside the wipe so the card's ring
    // moves in the photograph the new colours arrive with, rather than a frame ahead of them.
    if (get().resolved === mode) {
      withThemeTransition(() => {
        remember();
        set({ monacoTheme: applyToDocument(mode, theme.id) });
      });
    } else {
      remember();
    }

    await setSetting(mode === "dark" ? DARK_KEY : LIGHT_KEY, theme.id);
  },
}));
