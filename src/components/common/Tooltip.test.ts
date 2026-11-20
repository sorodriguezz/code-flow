import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { place } from "./Tooltip";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe("where a tooltip goes", () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { innerWidth: 1200, innerHeight: 800 };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = saved;
  });

  it("goes above a button, below one at the window's top", () => {
    expect(place(rect(500, 300, 24, 24), 100, 24, "top").side).toBe("top");
    expect(place(rect(500, 4, 24, 24), 100, 24, "top").side).toBe("bottom");
  });

  it("goes beside a trigger as tall as the window, by its top end", () => {
    // A folded panel's bar: 28px wide, the window high, against the rail on the left.
    const placed = place(rect(56, 40, 28, 760), 110, 26, "top");
    expect(placed.side).toBe("right");
    expect(placed.left).toBeGreaterThan(84);
    expect(placed.top).toBe(48);
  });
});
