import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

/**
 * How every terminal pane looks and how much it keeps: font, size, line height, cursor, scrollback,
 * and whether a long command finishing out of sight sends a notification.
 *
 * One settings row, JSON, read once at start and again whenever any window writes it — a pane reads
 * the store, so a change in Settings reaches every open terminal. The pane applies it only while it
 * is on screen (an option change rebuilds xterm's renderer), and catches up when shown.
 */
export type CursorStyle = "block" | "bar" | "underline";

export interface TerminalPrefs {
  /** Empty means the app's own stack — see `DEFAULT_FONT_FAMILY`. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  /** A command that ran longer than `notifyAfterSec` and finished while the pane was not watched. */
  notifyLong: boolean;
  notifyAfterSec: number;
}

/**
 * Cascadia first among the Windows faces: it ships with Windows Terminal and modern Windows and has
 * the powerline and box-drawing glyphs a prompt uses, where Consolas does not and `monospace` falls
 * through to Courier New. Menlo stays for macOS, where it is what `ui-monospace` resolves to.
 */
export const DEFAULT_FONT_FAMILY =
  "ui-monospace, Menlo, 'Cascadia Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace";

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const SCROLLBACK_MAX = 100_000;

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontFamily: "",
  fontSize: 13,
  lineHeight: 1,
  cursorStyle: "block",
  cursorBlink: true,
  // Ten thousand, not xterm's thousand: one `npm install` or build used to push the command that
  // started it out of reach. A line costs a few hundred bytes, and a hidden pane holds no renderer.
  scrollback: 10_000,
  notifyLong: true,
  notifyAfterSec: 10,
};

const KEY = "terminal_prefs";

/** A stored blob read leniently: anything missing or out of range takes its default. */
export function parseTerminalPrefs(raw: string | null): TerminalPrefs {
  let value: Partial<TerminalPrefs> = {};
  try {
    value = raw ? (JSON.parse(raw) as Partial<TerminalPrefs>) : {};
  } catch {
    value = {};
  }
  const d = DEFAULT_TERMINAL_PREFS;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    fontFamily: typeof value.fontFamily === "string" ? value.fontFamily : d.fontFamily,
    fontSize: Math.round(num(value.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, d.fontSize)),
    lineHeight: num(value.lineHeight, 1, 2, d.lineHeight),
    cursorStyle: value.cursorStyle === "bar" || value.cursorStyle === "underline" ? value.cursorStyle : "block",
    cursorBlink: typeof value.cursorBlink === "boolean" ? value.cursorBlink : d.cursorBlink,
    scrollback: Math.round(num(value.scrollback, 100, SCROLLBACK_MAX, d.scrollback)),
    notifyLong: typeof value.notifyLong === "boolean" ? value.notifyLong : d.notifyLong,
    notifyAfterSec: Math.round(num(value.notifyAfterSec, 1, 3600, d.notifyAfterSec)),
  };
}

interface TerminalPrefsState {
  prefs: TerminalPrefs;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<TerminalPrefs>) => void;
  /** ⌘+ / ⌘- in a terminal: one point, kept within the bounds. `0` puts the default back. */
  zoom: (step: 1 | -1 | 0) => void;
}

export const useTerminalPrefsStore = create<TerminalPrefsState>((set, get) => ({
  prefs: DEFAULT_TERMINAL_PREFS,
  loaded: false,

  load: async () => {
    const raw = await getSetting(KEY).catch(() => null);
    set({ prefs: parseTerminalPrefs(raw), loaded: true });
  },

  update: (patch) => {
    const prefs = parseTerminalPrefs(JSON.stringify({ ...get().prefs, ...patch }));
    set({ prefs });
    void setSetting(KEY, JSON.stringify(prefs)).catch(() => {});
  },

  zoom: (step) => {
    const size = get().prefs.fontSize;
    get().update({ fontSize: step === 0 ? DEFAULT_TERMINAL_PREFS.fontSize : size + step });
  },
}));

/** At first use: every pane calls it, the first one pays. */
export function ensureTerminalPrefsLoaded(): void {
  if (!useTerminalPrefsStore.getState().loaded) void useTerminalPrefsStore.getState().load();
}

watchSettings([KEY], () => useTerminalPrefsStore.getState().load());
