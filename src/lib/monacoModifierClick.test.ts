import { describe, expect, it } from "vitest";
import { isExtraDefinitionModifier, type HeldKeys } from "./monacoModifierClick";

const keys = (held: Partial<HeldKeys>): HeldKeys => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...held,
});

describe("isExtraDefinitionModifier", () => {
  it("answers Ctrl on a Mac, where Monaco only answers Cmd", () => {
    expect(isExtraDefinitionModifier(keys({ ctrlKey: true }), true)).toBe(true);
    expect(isExtraDefinitionModifier(keys({ metaKey: true }), true)).toBe(false);
  });

  it("answers Cmd/Meta elsewhere, where Monaco only answers Ctrl", () => {
    expect(isExtraDefinitionModifier(keys({ metaKey: true }), false)).toBe(true);
    expect(isExtraDefinitionModifier(keys({ ctrlKey: true }), false)).toBe(false);
  });

  it("leaves chords that mean something else alone", () => {
    for (const mac of [true, false]) {
      expect(isExtraDefinitionModifier(keys({ ctrlKey: true, metaKey: true }), mac)).toBe(false);
      expect(isExtraDefinitionModifier(keys({ ctrlKey: true, altKey: true }), mac)).toBe(false);
      expect(isExtraDefinitionModifier(keys({ metaKey: true, shiftKey: true }), mac)).toBe(false);
      expect(isExtraDefinitionModifier(keys({}), mac)).toBe(false);
    }
  });
});
