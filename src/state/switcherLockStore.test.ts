import { describe, expect, it } from "vitest";
import {
  chordHeld,
  chordMatches,
  DEFAULT_LOCK_CHORD,
  lockAxisFor,
  lockChordKeycaps,
  parseLockChord,
  resolveLockChord,
  sameLockChord,
  type LockChord,
} from "./switcherLockStore";

const keys = (ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey = false) => ({ ctrlKey, shiftKey, altKey, metaKey });
const press = (key: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey = false) => ({
  key,
  ...keys(ctrlKey, shiftKey, altKey, metaKey),
});

const CTRL_ALT: LockChord = { ctrl: true, shift: false, alt: true, meta: false };
const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

describe("the switcher's chord", () => {
  it("defaults to Ctrl+Shift+Alt — ⌃⇧⌥ on macOS", () => {
    expect(parseLockChord(null)).toEqual(DEFAULT_LOCK_CHORD);
    expect(parseLockChord("")).toEqual(DEFAULT_LOCK_CHORD);
    expect(lockChordKeycaps(DEFAULT_LOCK_CHORD, true)).toEqual(["⌃", "⇧", "⌥"]);
    expect(lockChordKeycaps(DEFAULT_LOCK_CHORD, false)).toEqual(["Ctrl", "Shift", "Alt"]);
  });

  it("reads off, a chord of its own, and refuses one modifier alone", () => {
    expect(parseLockChord("off")).toBeNull();
    expect(parseLockChord(JSON.stringify({ ctrl: true, alt: true }))).toEqual(CTRL_ALT);
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

  it("compares chords, off included", () => {
    expect(sameLockChord(DEFAULT_LOCK_CHORD, { ...DEFAULT_LOCK_CHORD })).toBe(true);
    expect(sameLockChord(DEFAULT_LOCK_CHORD, CTRL_ALT)).toBe(false);
    expect(sameLockChord(null, null)).toBe(true);
    expect(sameLockChord(null, DEFAULT_LOCK_CHORD)).toBe(false);
  });
});

describe("each axis's row, and the one before the split", () => {
  const legacy = JSON.stringify(CTRL_ALT);

  it("follows the pre-split chord while its own row was never written", () => {
    expect(resolveLockChord(undefined, legacy)).toEqual(CTRL_ALT);
    expect(resolveLockChord(null, legacy)).toEqual(CTRL_ALT);
    expect(resolveLockChord(undefined, "off")).toBeNull();
    expect(resolveLockChord(undefined, undefined)).toEqual(DEFAULT_LOCK_CHORD);
  });

  it("uses its own row once written — a reset (`\"\"`) is the default, not the old chord", () => {
    expect(resolveLockChord(JSON.stringify(DEFAULT_LOCK_CHORD), legacy)).toEqual(DEFAULT_LOCK_CHORD);
    expect(resolveLockChord("", legacy)).toEqual(DEFAULT_LOCK_CHORD);
    expect(resolveLockChord("off", legacy)).toBeNull();
    expect(resolveLockChord(legacy, "off")).toEqual(CTRL_ALT);
  });
});

describe("which drum an arrow opens", () => {
  it("with both chords equal — the default — is the single shared chord it always was", () => {
    const chords = { workspace: DEFAULT_LOCK_CHORD, repo: DEFAULT_LOCK_CHORD };
    expect(lockAxisFor(chords, press("ArrowLeft", true, true, true))).toBe("workspace");
    expect(lockAxisFor(chords, press("ArrowRight", true, true, true))).toBe("workspace");
    expect(lockAxisFor(chords, press("ArrowUp", true, true, true))).toBe("repo");
    expect(lockAxisFor(chords, press("ArrowDown", true, true, true))).toBe("repo");
    // Another modifier on top, a chord short, or no arrow: somebody else's.
    expect(lockAxisFor(chords, press("ArrowLeft", true, true, true, true))).toBeNull();
    expect(lockAxisFor(chords, press("ArrowUp", true, true, false))).toBeNull();
    expect(lockAxisFor(chords, press("k", true, true, true))).toBeNull();
  });

  it("opens an axis only on that axis's own chord — the other's passes through", () => {
    const chords = { workspace: DEFAULT_LOCK_CHORD, repo: CTRL_ALT };
    expect(lockAxisFor(chords, press("ArrowLeft", true, true, true))).toBe("workspace");
    expect(lockAxisFor(chords, press("ArrowDown", true, false, true))).toBe("repo");
    // The repositories' chord with ←/→, and the workspaces' with ↑/↓, open nothing.
    expect(lockAxisFor(chords, press("ArrowRight", true, false, true))).toBeNull();
    expect(lockAxisFor(chords, press("ArrowUp", true, true, true))).toBeNull();
  });

  it("leaves an axis that is off alone, and the other one working", () => {
    const noRepos = { workspace: DEFAULT_LOCK_CHORD, repo: null };
    expect(lockAxisFor(noRepos, press("ArrowLeft", true, true, true))).toBe("workspace");
    expect(lockAxisFor(noRepos, press("ArrowUp", true, true, true))).toBeNull();
    const noWorkspaces = { workspace: null, repo: DEFAULT_LOCK_CHORD };
    expect(lockAxisFor(noWorkspaces, press("ArrowRight", true, true, true))).toBeNull();
    expect(lockAxisFor(noWorkspaces, press("ArrowDown", true, true, true))).toBe("repo");
    const neither = { workspace: null, repo: null };
    for (const key of ARROWS) expect(lockAxisFor(neither, press(key, true, true, true))).toBeNull();
  });

  it("in an app island (`repos` false) never opens repositories", () => {
    const chords = { workspace: DEFAULT_LOCK_CHORD, repo: DEFAULT_LOCK_CHORD };
    expect(lockAxisFor(chords, press("ArrowLeft", true, true, true), false)).toBe("workspace");
    expect(lockAxisFor(chords, press("ArrowUp", true, true, true), false)).toBeNull();
    expect(lockAxisFor(chords, press("ArrowDown", true, true, true), false)).toBeNull();
  });
});
