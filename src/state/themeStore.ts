import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import {
  applyThemeVars,
  findTheme,
  monacoThemeName,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
} from "../lib/codeThemes";
import { withThemeTransition } from "../lib/themeTransition";
import { watchSettings } from "../lib/settingsSync";
import { isGlassPainted } from "../lib/windowGlass";
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
  /** Re-reads the three rows after another window wrote one — see `lib/settingsSync`. */
  sync: () => Promise<void>;
  setPreference: (pref: ThemePreference) => Promise<void>;
  setThemeId: (mode: "light" | "dark", id: string) => Promise<void>;
  /** Re-picks the Monaco theme after the window turned see-through or opaque — the scheme is the
   *  same, but a see-through window gets its variant with the backgrounds cleared. */
  syncMonacoTheme: () => void;
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

/** The three rows, read in one round trip, with the defaults `init` and `sync` both fall back to. */
async function readStored(): Promise<{
  preference: ThemePreference;
  darkThemeId: string;
  lightThemeId: string;
} | null> {
  // One round-trip for the three keys, not a `Promise.all` of three. The parallelism was
  // imaginary: `get_setting` takes the database mutex per key, so the Rust end served them one
  // after another — and this read is on the critical path of the very first paint, since the
  // window shows a default palette until it lands. `getSettings` omits absent keys, so unset falls
  // through to the defaults below exactly as a `null` from `getSetting` did.
  const stored = await getSettings([SETTING_KEY, DARK_KEY, LIGHT_KEY]).catch(() => null);
  if (!stored) return null;
  const raw = stored[SETTING_KEY];
  return {
    preference: raw === "light" || raw === "dark" || raw === "system" ? raw : "system",
    darkThemeId: findTheme(stored[DARK_KEY] ?? DEFAULT_DARK_THEME, "dark").id,
    lightThemeId: findTheme(stored[LIGHT_KEY] ?? DEFAULT_LIGHT_THEME, "light").id,
  };
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
  return monacoThemeName(theme.id, isGlassPainted());
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: "system",
  resolved: resolve("system"),
  darkThemeId: DEFAULT_DARK_THEME,
  lightThemeId: DEFAULT_LIGHT_THEME,
  // `isGlassPainted` already, not only after `glassStore` boots: a window built see-through has its
  // `data-glass` from `glass.rs`'s first-paint script before any module runs.
  monacoTheme: monacoThemeName(
    resolve("system") === "dark" ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME,
    isGlassPainted(),
  ),

  init: async () => {
    const { preference, darkThemeId, lightThemeId } = (await readStored()) ?? {
      preference: "system" as const,
      darkThemeId: DEFAULT_DARK_THEME,
      lightThemeId: DEFAULT_LIGHT_THEME,
    };
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

  sync: async () => {
    const stored = await readStored();
    if (!stored) return;
    const { preference, darkThemeId, lightThemeId } = stored;
    const resolved = resolve(preference);
    const current = get();
    const showing = current.resolved === "dark" ? current.darkThemeId : current.lightThemeId;
    const next = resolved === "dark" ? darkThemeId : lightThemeId;

    // Nothing on screen moves — "System" picked while the OS already agrees, or a scheme chosen for
    // the mode this window is not in. Remembered without a curtain, for the reason `setPreference`
    // gives: a wipe over an identical window reads as a stutter.
    if (resolved === current.resolved && next === showing) {
      set({ preference, darkThemeId, lightThemeId });
      return;
    }

    // Wiped, like the main window's own switch — this window is changing colour for the same reason
    // and at the same moment, and should look like it.
    withThemeTransition(() => {
      set({
        preference,
        resolved,
        darkThemeId,
        lightThemeId,
        monacoTheme: applyToDocument(resolved, next),
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

  syncMonacoTheme: () => {
    const { resolved, darkThemeId, lightThemeId, monacoTheme } = get();
    const next = monacoThemeName(findTheme(resolved === "dark" ? darkThemeId : lightThemeId, resolved).id, isGlassPainted());
    if (next !== monacoTheme) set({ monacoTheme: next });
  },
}));

// Light/dark and the two schemes are picked in Settings, which only the main window has — so a
// detached window learns about them here or not at all. See `lib/settingsSync`.
watchSettings([SETTING_KEY, DARK_KEY, LIGHT_KEY], () => useThemeStore.getState().sync());
