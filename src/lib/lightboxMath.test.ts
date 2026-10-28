import { describe, expect, it } from "vitest";
import { clampZoom, FIT, MAX_ZOOM, MIN_ZOOM, settle, wheelFactor, zoomAt } from "./lightboxMath";

describe("lightboxMath", () => {
  it("keeps the zoom inside its bounds", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  it("zooms about the pointer, so the point under it does not move", () => {
    const view = zoomAt(FIT, 2, 100, 50);
    expect(view.scale).toBe(2);
    // The point that was at (100, 50) from the centre is still there: x = p - (p - x0) * ratio.
    expect(view.x).toBe(-100);
    expect(view.y).toBe(-50);
    // At the centre nothing shifts.
    expect(zoomAt(FIT, 2, 0, 0)).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it("zooming past a bound stops there and does not drift", () => {
    const max = zoomAt({ scale: MAX_ZOOM, x: 5, y: 5 }, 2, 40, 40);
    expect(max.scale).toBe(MAX_ZOOM);
    expect(max.x).toBe(5);
  });

  it("a wheel notch is a bounded, symmetric factor", () => {
    expect(wheelFactor(0)).toBe(1);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(100) * wheelFactor(-100)).toBeCloseTo(1);
    expect(wheelFactor(99999)).toBe(wheelFactor(120));
  });

  it("zoomed out to fit or less, the picture re-centres", () => {
    expect(settle({ scale: 0.5, x: 30, y: -20 })).toEqual({ scale: 0.5, x: 0, y: 0 });
    expect(settle({ scale: 3, x: 30, y: -20 })).toEqual({ scale: 3, x: 30, y: -20 });
  });
});
