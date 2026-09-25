import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { setWindowGlass } from "../lib/tauri/windows";
import { watchSettings } from "../lib/settingsSync";
import {
  clampGlassLevel,
  DEFAULT_GLASS_LEVEL,
  GLASS_KEY,
  GLASS_LEVEL_KEY,
  isGlassPainted,
  paintGlass,
} from "../lib/windowGlass";
import { useThemeStore } from "./themeStore";

interface GlassState {
  /** Whether this window lets the desktop through. Off unless asked for. */
  enabled: boolean;
  /** 0–100, how see-through. Kept while off, so switching back on returns to the same level. */
  level: number;
  /** Reads the two rows — at boot, and again when another window writes one. */
  init: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setLevel: (level: number) => Promise<void>;
  /** Paints a level without saving it: the slider while it is being dragged. Saved on release,
   *  since a write per pixel would be announced to every window. */
  preview: (level: number) => void;
}

/**
 * Whether this window's native backdrop is on, as far as the page knows.
 *
 * Starts as whatever `glass.rs` built the window with: its first-paint script leaves `data-glass`
 * behind exactly when it also put the backdrop on. Tracked so that a window which was never
 * see-through — the ordinary case — costs no round trip at boot.
 */
let nativeOn = isGlassPainted();

/** The backdrop, and the light/dark it is tinted by. `force` re-sends while on: a new preference
 *  has to reach the window even though "on" has not changed. */
function syncNative(enabled: boolean, force = false): void {
  if (enabled === nativeOn && !force) return;
  nativeOn = enabled;
  void setWindowGlass(enabled, useThemeStore.getState().preference).catch(() => {});
}

function paint(enabled: boolean, level: number): void {
  const was = isGlassPainted();
  paintGlass(enabled, level);
  // Monaco draws from its own theme object, not from the page's CSS: a see-through editor needs the
  // variant with its backgrounds cleared. Only when the switch moved — not on every slider step.
  if (was !== enabled) useThemeStore.getState().syncMonacoTheme();
}

/**
 * The see-through window — Apariencia › Modo y color › Transparencia.
 *
 * A store of its own, and per window like every store: each window paints its own page and asks
 * `glass.rs` for its own backdrop. The switch and the level are written in Settings, which only the
 * main window has, and reach the others through `watchSettings`.
 */
export const useGlassStore = create<GlassState>((set, get) => ({
  enabled: isGlassPainted(),
  level: DEFAULT_GLASS_LEVEL,

  init: async () => {
    const stored = await getSettings([GLASS_KEY, GLASS_LEVEL_KEY]).catch(() => null);
    if (!stored) return;
    // Unset and explicit-false are both "off": a window you can see through is a look to ask for.
    const enabled = stored[GLASS_KEY] === "true";
    const level = clampGlassLevel(stored[GLASS_LEVEL_KEY]);
    set({ enabled, level });
    paint(enabled, level);
    syncNative(enabled);
  },

  setEnabled: async (enabled) => {
    set({ enabled });
    paint(enabled, get().level);
    syncNative(enabled);
    await setSetting(GLASS_KEY, String(enabled));
  },

  setLevel: async (level) => {
    const value = clampGlassLevel(level);
    set({ level: value });
    if (get().enabled) paint(true, value);
    await setSetting(GLASS_LEVEL_KEY, String(value));
  },

  preview: (level) => {
    if (get().enabled) paintGlass(true, level);
  },
}));

// Switched and dragged in Settings, which only the main window has. See `lib/settingsSync`.
watchSettings([GLASS_KEY, GLASS_LEVEL_KEY], () => useGlassStore.getState().init());

// The backdrop is tinted by the window's appearance, which follows the light/dark preference while
// the glass is on — so a new preference has to reach the window too. See `apply_native`.
useThemeStore.subscribe((state, previous) => {
  if (state.preference !== previous.preference && useGlassStore.getState().enabled) syncNative(true, true);
});
