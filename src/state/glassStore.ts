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
import { getWindowStatus, subscribeWindowStatus } from "../lib/windowControls";
import { isMac } from "../lib/platform";

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

/**
 * Whether the window is in macOS fullscreen, where it is painted opaque whatever the switch says.
 *
 * Fullscreen puts the window in a Space of its own: there is no desktop behind it, only the window
 * server's black, and the blur and the thin coat of the scheme over that came out a murky, wrong
 * colour (the user, 2026-10-18: "cuando ocupa toda la pantalla se vuelve raro el color"). Nothing
 * to see through, so nothing is see-through; leaving fullscreen puts the glass back.
 */
let fullscreen = false;
let watchingFullscreen = false;

/** The switch, as this window shows it right now. */
function shown(enabled: boolean): boolean {
  return enabled && !fullscreen;
}

/** Starts following fullscreen the first time the glass is on — a window that never turns it on
 *  never asks. Only macOS reports fullscreen (`windowControls`), and only macOS needs it. */
function watchFullscreen(): void {
  if (watchingFullscreen) return;
  watchingFullscreen = true;
  fullscreen = getWindowStatus().fullscreen;
  subscribeWindowStatus(() => {
    const next = getWindowStatus().fullscreen;
    if (next === fullscreen) return;
    fullscreen = next;
    const { enabled, level } = useGlassStore.getState();
    if (!enabled) return;
    paint(shown(enabled), level);
    syncNative(shown(enabled));
  });
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
    // And off outside macOS whatever the row says — a Windows install that switched it on before
    // 2.3.41 opens opaque (see `glass.rs`, "Why not Windows").
    const enabled = isMac() && stored[GLASS_KEY] === "true";
    const level = clampGlassLevel(stored[GLASS_LEVEL_KEY]);
    set({ enabled, level });
    if (enabled) watchFullscreen();
    paint(shown(enabled), level);
    syncNative(shown(enabled));
  },

  setEnabled: async (enabled) => {
    set({ enabled });
    if (enabled) watchFullscreen();
    paint(shown(enabled), get().level);
    syncNative(shown(enabled));
    await setSetting(GLASS_KEY, String(enabled));
  },

  setLevel: async (level) => {
    const value = clampGlassLevel(level);
    set({ level: value });
    if (shown(get().enabled)) paint(true, value);
    await setSetting(GLASS_LEVEL_KEY, String(value));
  },

  preview: (level) => {
    if (shown(get().enabled)) paintGlass(true, level);
  },
}));

// Switched and dragged in Settings, which only the main window has. See `lib/settingsSync`.
watchSettings([GLASS_KEY, GLASS_LEVEL_KEY], () => useGlassStore.getState().init());

// The backdrop is tinted by the window's appearance, which follows the light/dark preference while
// the glass is on — so a new preference has to reach the window too. See `apply_native`.
useThemeStore.subscribe((state, previous) => {
  if (state.preference !== previous.preference && shown(useGlassStore.getState().enabled)) syncNative(true, true);
});
