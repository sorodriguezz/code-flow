import { describe, expect, it } from "vitest";
import { acceleratorFromKey, acceleratorKeycaps } from "./globalHotkey";

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("acceleratorFromKey", () => {
  it("records by physical key and names the modifiers that were held", () => {
    expect(acceleratorFromKey(press("Space", { altKey: true }), true)).toBe("Alt+Space");
    expect(acceleratorFromKey(press("Space", { ctrlKey: true, altKey: true }), false)).toBe("Ctrl+Alt+Space");
    expect(acceleratorFromKey(press("KeyK", { metaKey: true, shiftKey: true }), true)).toBe("Shift+Cmd+K");
    expect(acceleratorFromKey(press("KeyK", { metaKey: true }), false)).toBe("Super+K");
    expect(acceleratorFromKey(press("F9"), false)).toBe("F9");
  });

  it("refuses what would take a key away from every other application", () => {
    expect(acceleratorFromKey(press("KeyA"), false)).toBeNull();
    expect(acceleratorFromKey(press("KeyA", { shiftKey: true }), false)).toBeNull();
    expect(acceleratorFromKey(press("Space"), true)).toBeNull();
  });

  it("ignores the modifier keys themselves", () => {
    expect(acceleratorFromKey(press("AltLeft", { altKey: true }), true)).toBeNull();
  });
});

describe("acceleratorKeycaps", () => {
  it("draws the platform's own symbols", () => {
    expect(acceleratorKeycaps("Alt+Space", true)).toEqual(["⌥", "Space"]);
    expect(acceleratorKeycaps("Ctrl+Alt+Space", false)).toEqual(["Ctrl", "Alt", "Space"]);
    expect(acceleratorKeycaps("CmdOrCtrl+Shift+k", true)).toEqual(["⌘", "⇧", "K"]);
  });
});
