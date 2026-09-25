import { describe, expect, it } from "vitest";
import { clampGlassLevel, DEFAULT_GLASS_LEVEL, glassFills, isGlassPainted, paintGlass } from "./windowGlass";

/** Just enough of an element for `paintGlass`: an attribute set and a style map. */
function fakeRoot() {
  const attributes = new Set<string>();
  const properties = new Map<string, string>();
  const root = {
    setAttribute: (name: string) => void attributes.add(name),
    removeAttribute: (name: string) => void attributes.delete(name),
    hasAttribute: (name: string) => attributes.has(name),
    style: {
      setProperty: (name: string, value: string) => void properties.set(name, value),
      removeProperty: (name: string) => void properties.delete(name),
    },
  };
  return { root: root as unknown as HTMLElement, properties };
}

describe("glassFills", () => {
  // The same three points `fills_match_the_frontend` pins in `glass.rs`: a window opens at the
  // tint the Rust side stamps and must not jump when this side takes over.
  it("matches glass.rs at the ends and the middle", () => {
    expect(glassFills(0)).toEqual({ frame: 80, sheet: 80, solo: 96 });
    expect(glassFills(50)).toEqual({ frame: 47.5, sheet: 55, solo: 76.375 });
    expect(glassFills(100)).toEqual({ frame: 15, sheet: 30, solo: 40.5 });
  });

  it("lets more through as the level rises, and the frame faster than the sheet", () => {
    const low = glassFills(20);
    const high = glassFills(80);
    expect(high.frame).toBeLessThan(low.frame);
    expect(high.sheet).toBeLessThan(low.sheet);
    expect(low.frame - high.frame).toBeGreaterThan(low.sheet - high.sheet);
  });
});

describe("clampGlassLevel", () => {
  it("reads a stored row, and falls back to the default for anything else", () => {
    expect(clampGlassLevel("35")).toBe(35);
    expect(clampGlassLevel(" 62.6 ")).toBe(63);
    expect(clampGlassLevel("250")).toBe(100);
    expect(clampGlassLevel("-4")).toBe(0);
    expect(clampGlassLevel(undefined)).toBe(DEFAULT_GLASS_LEVEL);
    expect(clampGlassLevel("")).toBe(DEFAULT_GLASS_LEVEL);
    expect(clampGlassLevel("mucho")).toBe(DEFAULT_GLASS_LEVEL);
  });
});

describe("paintGlass", () => {
  it("stamps the attribute and the three percentages, as glass.rs's script does", () => {
    const { root, properties } = fakeRoot();
    paintGlass(true, 100, root);
    expect(isGlassPainted(root)).toBe(true);
    expect(Object.fromEntries(properties)).toEqual({
      "--cf-glass-frame": "15.0%",
      "--cf-glass-sheet": "30.0%",
      "--cf-glass-solo": "40.5%",
    });
  });

  it("takes everything off again", () => {
    const { root, properties } = fakeRoot();
    paintGlass(true, 50, root);
    paintGlass(false, 50, root);
    expect(isGlassPainted(root)).toBe(false);
    expect(properties.size).toBe(0);
  });

  it("answers without a document", () => {
    expect(isGlassPainted()).toBe(false);
  });
});
