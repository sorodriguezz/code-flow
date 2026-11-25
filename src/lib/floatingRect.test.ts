import { describe, expect, it } from "vitest";
import { GAP, MIN_H, MIN_W, SHELF, defaultRect, fitRect, maximizedRect, moveRect, resizeRect } from "./floatingRect";

const area = { w: 1400, h: 900 };

describe("a floating window's geometry", () => {
  it("opens by the right side, clear of the shelf where minimised ones sit", () => {
    const rect = defaultRect(area);
    expect(rect.x + rect.w).toBe(area.w - GAP);
    expect(rect.y + rect.h).toBe(area.h - SHELF);
    expect(rect.w).toBe(580);
  });

  it("opens whole in an area smaller than its usual size", () => {
    const small = { w: 420, h: 380 };
    const rect = defaultRect(small);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(small.w);
    expect(rect.y + rect.h).toBeLessThanOrEqual(small.h);
  });

  it("stops at the sides when it is carried past them", () => {
    const rect = { x: 100, y: 100, w: 500, h: 400 };
    expect(moveRect(rect, -900, -900, area)).toEqual({ x: 0, y: 0, w: 500, h: 400 });
    expect(moveRect(rect, 5000, 5000, area)).toEqual({ x: 900, y: 500, w: 500, h: 400 });
  });

  it("comes back inside when the area shrinks under it", () => {
    const rect = { x: 900, y: 500, w: 500, h: 400 };
    expect(fitRect(rect, { w: 800, h: 600 })).toEqual({ x: 300, y: 200, w: 500, h: 400 });
    // Smaller than the window itself: it takes the whole area.
    expect(fitRect(rect, { w: 300, h: 200 })).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });

  it("grows from the side that is pulled and keeps the other in place", () => {
    const rect = { x: 400, y: 200, w: 500, h: 400 };
    expect(resizeRect(rect, { right: true, bottom: true }, 100, 50, area)).toEqual({ x: 400, y: 200, w: 600, h: 450 });
    expect(resizeRect(rect, { left: true, top: true }, -100, -50, area)).toEqual({ x: 300, y: 150, w: 600, h: 450 });
  });

  it("never gets smaller than it can be read, nor larger than the area", () => {
    const rect = { x: 400, y: 200, w: 500, h: 400 };
    const squeezed = resizeRect(rect, { left: true, top: true }, 900, 900, area);
    expect(squeezed).toEqual({ x: 400 + 500 - MIN_W, y: 200 + 400 - MIN_H, w: MIN_W, h: MIN_H });
    const stretched = resizeRect(rect, { right: true, bottom: true }, 9000, 9000, area);
    expect(stretched).toEqual({ x: 400, y: 200, w: 1000, h: 700 });
  });

  it("fills the area but its margins when maximised", () => {
    expect(maximizedRect(area)).toEqual({ x: GAP, y: GAP, w: area.w - GAP * 2, h: area.h - GAP * 2 });
    // With minimised windows on the shelf, it stops above them: they stay within reach.
    expect(maximizedRect(area, true)).toEqual({ x: GAP, y: GAP, w: area.w - GAP * 2, h: area.h - GAP - SHELF });
  });
});
