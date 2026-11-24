import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", async (original) => ({ ...(await original<typeof import("./platform")>()), isMac: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: async () => {} }) }));

import { eventToChord } from "./keys";
import { isMenuChord, replayedKeystroke, type MenuChord } from "./menuChords";

describe("replayedKeystroke", () => {
  // The replay only works if every listener reads it as the keystroke it stands for — the chords the
  // shortcut table, `useTextHistory` and the editor bind.
  it("reads as the chord the app binds", () => {
    const expected: Record<MenuChord, string> = { undo: "Mod+Z", redo: "Mod+Shift+Z", selectAll: "Mod+A", closeWindow: "Mod+W" };
    for (const [chord, binding] of Object.entries(expected) as [MenuChord, string][]) {
      const init = replayedKeystroke(chord);
      const event = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, getModifierState: () => false, ...init } as unknown as KeyboardEvent;
      expect(eventToChord(event)).toBe(binding);
      expect(init.bubbles && init.cancelable).toBe(true);
    }
  });
});

describe("isMenuChord", () => {
  it("accepts the four names the menu sends and nothing else", () => {
    for (const chord of ["undo", "redo", "selectAll", "closeWindow"]) expect(isMenuChord(chord)).toBe(true);
    for (const other of ["toString", "constructor", "copy", "", 1, null]) expect(isMenuChord(other)).toBe(false);
  });
});
