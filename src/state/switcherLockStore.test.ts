import { describe, expect, it } from "vitest";
import { chordHeld, chordMatches, DEFAULT_LOCK_CHORD, lockChordKeycaps, parseLockChord } from "./switcherLockStore";

const keys = (ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey = false) => ({ ctrlKey, shiftKey, altKey, metaKey });

describe("the switcher's chord", () => {
  it("defaults to Ctrl+Shift+Alt — ⌃⇧⌥ on macOS", () => {
    expect(parseLockChord(null)).toEqual(DEFAULT_LOCK_CHORD);
    expect(parseLockChord("")).toEqual(DEFAULT_LOCK_CHORD);
    expect(lockChordKeycaps(DEFAULT_LOCK_CHORD, true)).toEqual(["⌃", "⇧", "⌥"]);
    expect(lockChordKeycaps(DEFAULT_LOCK_CHORD, false)).toEqual(["Ctrl", "Shift", "Alt"]);
  });

  it("reads off, a chord of its own, and refuses one modifier alone", () => {
    expect(parseLockChord("off")).toBeNull();
    expect(parseLockChord(JSON.stringify({ ctrl: true, alt: true }))).toEqual({ ctrl: true, shift: false, alt: true, meta: false });
    expect(parseLockChord(JSON.stringify({ shift: true }))).toEqual(DEFAULT_LOCK_CHORD);
    expect(parseLockChord("{nope")).toEqual(DEFAULT_LOCK_CHORD);
  });

  it("opens on exactly its modifiers and switches when any of them is let go", () => {
    expect(chordMatches(DEFAULT_LOCK_CHORD, keys(true, true, true))).toBe(true);
    // The old chord, and one with ⌘ on top, are somebody else's.
    expect(chordMatches(DEFAULT_LOCK_CHORD, keys(true, true, false))).toBe(false);
    expect(chordMatches(DEFAULT_LOCK_CHORD, keys(true, true, true, true))).toBe(false);
    expect(chordHeld(DEFAULT_LOCK_CHORD, keys(true, true, true))).toBe(true);
    expect(chordHeld(DEFAULT_LOCK_CHORD, keys(true, false, true))).toBe(false);
  });
});
