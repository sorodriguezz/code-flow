import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { SHORTCUT_BY_ID, SHORTCUT_COMMANDS } = await import("./shortcuts");

/** The order `eventToChord` writes modifiers in — the only spelling a keypress can ever match. */
const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

describe("the shortcut registry's defaults", () => {
  it("spell every chord the way a keypress produces it", () => {
    for (const command of SHORTCUT_COMMANDS) {
      const modifiers = command.defaultChord.split("+").slice(0, -1);
      const ranks = modifiers.map((modifier) => MODIFIER_ORDER.indexOf(modifier));
      expect(ranks.every((rank) => rank >= 0), `${command.id}: ${command.defaultChord}`).toBe(true);
      expect(
        ranks.every((rank, index) => index === 0 || ranks[index - 1] < rank),
        `${command.id}: "${command.defaultChord}" is in an order eventToChord never writes`,
      ).toBe(true);
    }
  });

  it("bind Save All and Find All References where VS Code does", () => {
    expect(SHORTCUT_BY_ID.get("editor.saveAll")?.defaultChord).toBe("Mod+Alt+S");
    expect(SHORTCUT_BY_ID.get("editor.saveAll")?.run).toBeTypeOf("function");
    expect(SHORTCUT_BY_ID.get("editor.findReferences")?.monacoCommand).toBe("cf-find-references");
    expect(SHORTCUT_BY_ID.get("editor.formatDocument")?.defaultChord).toBe("Alt+Shift+F");
  });

  it("give the new chords to nothing else", () => {
    for (const chord of ["Mod+Alt+S", "Alt+Shift+F12", "Alt+Shift+F"]) {
      expect(SHORTCUT_COMMANDS.filter((command) => command.defaultChord === chord)).toHaveLength(1);
    }
  });
});
