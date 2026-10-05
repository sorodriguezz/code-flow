import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const KEY = "switcher_lock_chord";

/**
 * The modifiers held with the arrows to roll the workspace and repository switcher (`SwitcherLock`):
 * ←/→ for workspaces, ↑/↓ for repositories, the switch on release. Literal keys, the same names
 * on every platform — `ctrl` is Control on macOS too (⌃), `alt` is Option there (⌥), `meta` is ⌘ or
 * the Windows key.
 */
export interface LockChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** Ctrl+Shift+Alt — ⌃⇧⌥ on macOS (the user's pick, 2026-10-05). Three modifiers, so no text field
 *  loses an arrow chord of its own: Ctrl+Shift+← alone is select-by-word on Windows. */
export const DEFAULT_LOCK_CHORD: LockChord = { ctrl: true, shift: true, alt: true, meta: false };

const count = (chord: LockChord) => [chord.ctrl, chord.shift, chord.alt, chord.meta].filter(Boolean).length;

/** Whether a chord may be the switcher's: two modifiers at least. One alone is taken by the text
 *  under the cursor everywhere — Shift selects, Alt jumps words, Ctrl switches Spaces on macOS. */
export function usableLockChord(chord: LockChord): boolean {
  return count(chord) >= 2;
}

/** The stored row: `off`, a chord, or — unset or unreadable — the default. */
export function parseLockChord(raw: string | null | undefined): LockChord | null {
  if (raw === "off") return null;
  try {
    const value = JSON.parse(raw ?? "") as Partial<LockChord>;
    const chord = { ctrl: value.ctrl === true, shift: value.shift === true, alt: value.alt === true, meta: value.meta === true };
    return usableLockChord(chord) ? chord : DEFAULT_LOCK_CHORD;
  } catch {
    return DEFAULT_LOCK_CHORD;
  }
}

/** Exactly the chord's modifiers: another one on top makes the keystroke somebody else's. */
export function chordMatches(chord: LockChord, e: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): boolean {
  return e.ctrlKey === chord.ctrl && e.shiftKey === chord.shift && e.altKey === chord.alt && e.metaKey === chord.meta;
}

/** Every modifier of the chord still down — letting go of any one of them is the switch. */
export function chordHeld(chord: LockChord, e: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): boolean {
  return (!chord.ctrl || e.ctrlKey) && (!chord.shift || e.shiftKey) && (!chord.alt || e.altKey) && (!chord.meta || e.metaKey);
}

/** The chord as key caps, in the platform's order and spelling. */
export function lockChordKeycaps(chord: LockChord, mac: boolean): string[] {
  const caps: string[] = [];
  if (chord.ctrl) caps.push(mac ? "⌃" : "Ctrl");
  if (chord.shift) caps.push(mac ? "⇧" : "Shift");
  if (chord.alt) caps.push(mac ? "⌥" : "Alt");
  if (chord.meta) caps.push(mac ? "⌘" : "Win");
  return caps;
}

interface SwitcherLockState {
  /** `null` when it is switched off. */
  chord: LockChord | null;
  /** Settings is recording a new chord: the switcher stands down, so the press reaches the recorder
   *  instead of opening the lock it is about to be bound to. */
  recording: boolean;
  /** Reads the row — at boot, and again when another window writes it. */
  init: () => Promise<void>;
  setChord: (chord: LockChord | null) => Promise<void>;
  reset: () => Promise<void>;
  setRecording: (on: boolean) => void;
}

export const useSwitcherLockStore = create<SwitcherLockState>((set) => ({
  chord: DEFAULT_LOCK_CHORD,
  recording: false,

  init: async () => {
    const stored = await getSetting(KEY).catch(() => undefined);
    if (stored === undefined) return;
    set({ chord: parseLockChord(stored) });
  },

  setChord: async (chord) => {
    if (chord && !usableLockChord(chord)) return;
    set({ chord });
    await setSetting(KEY, chord ? JSON.stringify(chord) : "off");
  },

  reset: async () => {
    set({ chord: DEFAULT_LOCK_CHORD });
    await setSetting(KEY, "");
  },

  setRecording: (recording) => set({ recording }),
}));

// Recorded in Settings, which only the main window has — and every app island has a switcher too.
watchSettings([KEY], () => useSwitcherLockStore.getState().init());
