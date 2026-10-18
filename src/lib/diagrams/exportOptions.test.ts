import { describe, expect, it } from "vitest";
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, fitExportCanvas } from "./exportOptions";

describe("fitExportCanvas", () => {
  it("keeps the chosen zoom when the canvas fits", () => {
    expect(fitExportCanvas(800, 600, 2)).toEqual({ width: 1600, height: 1200, scale: 2 });
  });

  it("shrinks a wide drawing to the longest side the webview draws", () => {
    const fit = fitExportCanvas(10_000, 500, 10);
    expect(fit.width).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(fit.scale).toBeCloseTo(MAX_CANVAS_SIDE / 10_000);
  });

  it("shrinks a large square drawing to the pixel budget", () => {
    const fit = fitExportCanvas(8000, 8000, 4);
    expect(fit.width * fit.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(fit.scale).toBeLessThan(4);
  });
});
