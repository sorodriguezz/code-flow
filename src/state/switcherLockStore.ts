import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

/** The two drums of the switcher (`SwitcherLock`): workspaces on ←/→, repositories on ↑/↓. */
export type LockAxis = "workspace" | "repo";

/** Each drum's own row — split 2026-10-09, so rebinding one never leaves you guessing which. */
const KEYS: Record<LockAxis, string> = {
  workspace: "switcher_lock_chord_workspaces",
  repo: "switcher_lock_chord_repos",
};

/** The one chord both drums shared up to 2.3.17. Read, never written: an axis whose own row is
 *  unset still follows it, so a chord recorded before the split survives the update on both. */
const LEGACY_KEY = "switcher_lock_chord";

/** The arrows that roll each drum, as [back, forward]. Fixed: only the modifiers are recorded. */
export const LOCK_ARROWS: Record<LockAxis, [string, string]> = {
  workspace: ["ArrowLeft", "ArrowRight"],
  repo: ["ArrowUp", "ArrowDown"],
};

/**
 * The modifiers held with an axis's arrows to roll its drum, the switch on release. Literal keys,
 * the same names on every platform — `ctrl` is Control on macOS too (⌃), `alt` is Option there
 * (⌥), `meta` is ⌘ or the Windows key.
 */
export interface LockChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

type Modifiers = Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/** Ctrl+Shift+Alt — ⌃⇧⌥ on macOS (the user's pick, 2026-10-05), for both drums. Three modifiers, so
 *  no text field loses an arrow chord of its own: Ctrl+Shift+← alone is select-by-word on Windows. */
export const DEFAULT_LOCK_CHORD: LockChord = { ctrl: true, shift: true, alt: true, meta: false };

const count = (chord: LockChord) => [chord.ctrl, chord.shift, chord.alt, chord.meta].filter(Boolean).length;

/** Whether a chord may be the switcher's: two modifiers at least. One alone is taken by the text
 *  under the cursor everywhere — Shift selects, Alt jumps words, Ctrl switches Spaces on macOS. */
export function usableLockChord(chord: LockChord): boolean {
  return count(chord) >= 2;
}

export function sameLockChord(a: LockChord | null, b: LockChord | null): boolean {
  if (!a || !b) return a === b;
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;
}

/** A stored row: `off`, a chord, or — empty or unreadable — the default. */
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

/**
 * An axis's chord from its own row and the pre-split one. Unset (`null`/`undefined` — never
 * written) follows the legacy row; anything written, `""` included, is the axis's own. That is why
 * Reset writes `""` rather than deleting: it means the default, not "whatever the old chord was".
 */
export function resolveLockChord(own: string | null | undefined, legacy: string | null | undefined): LockChord | null {
  return parseLockChord(own ?? legacy);
}

/** Exactly the chord's modifiers: another one on top makes the keystroke somebody else's. */
export function chordMatches(chord: LockChord, e: Modifiers): boolean {
  return e.ctrlKey === chord.ctrl && e.shiftKey === chord.shift && e.altKey === chord.alt && e.metaKey === chord.meta;
}

/** Every modifier of the chord still down — letting go of any one of them is the switch. */
export function chordHeld(chord: LockChord, e: Modifiers): boolean {
  return (!chord.ctrl || e.ctrlKey) && (!chord.shift || e.shiftKey) && (!chord.alt || e.altKey) && (!chord.meta || e.metaKey);
}

/**
 * Which drum a keystroke opens: the axis its arrow rolls, and only if exactly *that* axis's chord is
 * held. A chord that is only the other axis's opens nothing, and the key goes on untouched. With
 * both chords equal (the default) this is the single shared chord it always was. `repos` false — an
 * app island — leaves ↑/↓ alone.
 */
export function lockAxisFor(
  chords: Record<LockAxis, LockChord | null>,
  e: Modifiers & Pick<KeyboardEvent, "key">,
  repos = true,
): LockAxis | null {
  const axis = LOCK_ARROWS.workspace.includes(e.key) ? "workspace" : LOCK_ARROWS.repo.includes(e.key) ? "repo" : null;
  if (!axis || (axis === "repo" && !repos)) return null;
  const chord = chords[axis];
  return chord && chordMatches(chord, e) ? axis : null;
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
  /** Each axis's chord; `null` when that axis is switched off. */
  chords: Record<LockAxis, LockChord | null>;
  /** The axis Settings is recording a new chord for: the switcher stands down meanwhile, so the
   *  press reaches the recorder instead of opening the lock it is about to be bound to. */
  recording: LockAxis | null;
  /** Reads the rows — at boot, and again when another window writes one. */
  init: () => Promise<void>;
  setChord: (axis: LockAxis, chord: LockChord | null) => Promise<void>;
  reset: (axis: LockAxis) => Promise<void>;
  setRecording: (axis: LockAxis | null) => void;
}

export const useSwitcherLockStore = create<SwitcherLockState>((set) => ({
  chords: { workspace: DEFAULT_LOCK_CHORD, repo: DEFAULT_LOCK_CHORD },
  recording: null,

  init: async () => {
    let stored: Record<string, string>;
    try {
      stored = await getSettings([KEYS.workspace, KEYS.repo, LEGACY_KEY]);
    } catch {
      return;
    }
    set({
      chords: {
        workspace: resolveLockChord(stored[KEYS.workspace], stored[LEGACY_KEY]),
        repo: resolveLockChord(stored[KEYS.repo], stored[LEGACY_KEY]),
      },
    });
  },

  setChord: async (axis, chord) => {
    if (chord && !usableLockChord(chord)) return;
    set((s) => ({ chords: { ...s.chords, [axis]: chord } }));
    await setSetting(KEYS[axis], chord ? JSON.stringify(chord) : "off");
  },

  reset: async (axis) => {
    set((s) => ({ chords: { ...s.chords, [axis]: DEFAULT_LOCK_CHORD } }));
    await setSetting(KEYS[axis], "");
  },

  setRecording: (recording) => set({ recording }),
}));

// Recorded in Settings, which only the main window has — and every app island has a switcher too.
watchSettings([KEYS.workspace, KEYS.repo, LEGACY_KEY], () => useSwitcherLockStore.getState().init());
