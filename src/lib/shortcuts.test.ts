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

  it("never put Shift or Alt on a symbol key, which no keypress produces", () => {
    // On a symbol, Shift (and Option on macOS) is part of the character: ⇧` arrives as `~` and ⌥.
    // as `≥`, so `eventToChord` drops it — "Mod+Shift+`" and "Mod+Alt+." both shipped dead.
    for (const command of SHORTCUT_COMMANDS) {
      const parts = command.defaultChord.split("+");
      const base = parts[parts.length - 1];
      if (base.length !== 1 || /[A-Z0-9]/.test(base)) continue;
      expect(parts.slice(0, -1), `${command.id}: ${command.defaultChord}`).not.toContain("Shift");
      expect(parts.slice(0, -1), `${command.id}: ${command.defaultChord}`).not.toContain("Alt");
    }
  });

  it("leave alone the chords macOS keeps for itself", () => {
    // System-wide (the window never sees them) or the app menu's own key equivalents.
    const system = ["Mod+Alt+D", "Mod+Space", "Mod+Alt+Space", "Mod+Tab", "Mod+H", "Mod+Alt+H", "Mod+M", "Mod+Q", "Mod+`"];
    for (const command of SHORTCUT_COMMANDS) {
      expect(system, `${command.id}: ${command.defaultChord}`).not.toContain(command.defaultChord);
    }
  });

  it("leave alone the chords Windows keeps for itself", () => {
    // `Mod` is Ctrl there. Task switching, the window menu, Start, Task Manager, the secure screen.
    const system = ["Alt+Tab", "Alt+F4", "Alt+Space", "Mod+Escape", "Mod+Shift+Escape", "Mod+Alt+Delete", "Mod+Alt+Space"];
    for (const command of SHORTCUT_COMMANDS) {
      expect(system, `${command.id}: ${command.defaultChord}`).not.toContain(command.defaultChord);
    }
  });

  it("give every default to one command", () => {
    const chords = SHORTCUT_COMMANDS.map((command) => command.defaultChord);
    expect(chords.filter((chord, index) => chords.indexOf(chord) !== index)).toEqual([]);
  });

  it("bind Save All and Find All References where VS Code does", () => {
    expect(SHORTCUT_BY_ID.get("editor.saveAll")?.defaultChord).toBe("Mod+Alt+S");
    expect(SHORTCUT_BY_ID.get("editor.saveAll")?.run).toBeTypeOf("function");
    expect(SHORTCUT_BY_ID.get("editor.findReferences")?.monacoCommand).toBe("cf-find-references");
    expect(SHORTCUT_BY_ID.get("editor.formatDocument")?.defaultChord).toBe("Alt+Shift+F");
  });

  it("open Codi's window from anywhere", () => {
    expect(SHORTCUT_BY_ID.get("codi.open")?.defaultChord).toBe("Mod+Alt+V");
    expect(SHORTCUT_BY_ID.get("codi.open")?.run).toBeTypeOf("function");
  });

  it("give the new chords to nothing else", () => {
    for (const chord of ["Mod+Alt+S", "Alt+Shift+F12", "Alt+Shift+F", "Mod+Alt+V"]) {
      expect(SHORTCUT_COMMANDS.filter((command) => command.defaultChord === chord)).toHaveLength(1);
    }
  });
});
