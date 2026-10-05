import { describe, expect, it } from "vitest";
import { isViewFind } from "./useFindShortcut";

const press = (init: Partial<KeyboardEvent>) =>
  ({ key: "f", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target: null, ...init }) as KeyboardEvent;

describe("isViewFind", () => {
  it("is Ctrl+F on Windows and Linux, ⌘F on macOS — and nothing with more held", () => {
    expect(isViewFind(press({ ctrlKey: true }), false)).toBe(true);
    expect(isViewFind(press({ ctrlKey: true, key: "F" }), false)).toBe(true);
    expect(isViewFind(press({ metaKey: true }), true)).toBe(true);
    expect(isViewFind(press({ metaKey: true }), false)).toBe(false);
    expect(isViewFind(press({ ctrlKey: true }), true)).toBe(false);
    expect(isViewFind(press({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isViewFind(press({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it("leaves a chord something else already answered", () => {
    expect(isViewFind(press({ ctrlKey: true, defaultPrevented: true }), false)).toBe(false);
  });
});
