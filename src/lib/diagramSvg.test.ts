import { describe, expect, it } from "vitest";
import { exportFrame } from "./diagramSvg";
import type { DiagramLayout } from "./db/erLayout";

/**
 * The frame an export is drawn on.
 *
 * There is no DOM in this suite, so `standaloneSvg` itself is not exercised here — what is held
 * down is the number it hands to all three of the things that have to agree on the frame: the
 * file's `width`/`height`, its `viewBox`, and the opaque rectangle drawn behind the diagram.
 *
 * The regression this exists for: the ground used to be written as `x=0 y=0 width=100% height=100%`
 * while the viewBox was anchored on the layout's own origin. A percentage resolves against the
 * viewport's *size*, so the two agreed only while that origin was `0 0` — and it stops being `0 0`
 * the moment a box is dragged above or to the left of where the engine put it. Past that point the
 * ground covered a rectangle the size of the diagram in the wrong place, and the PNG came out as a
 * block of colour in one corner with the rest of the picture on transparent nothing.
 */
const layout = (over: Partial<DiagramLayout>): DiagramLayout => ({
  nodes: [],
  links: [],
  minX: 0,
  minY: 0,
  width: 0,
  height: 0,
  ...over,
});

describe("exportFrame", () => {
  it("is the layout's own rectangle for a diagram nobody dragged", () => {
    expect(exportFrame(layout({ width: 800, height: 600 }))).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  /* The whole point: the origin travels with the content, so the ground can be anchored on it. */
  it("keeps the negative origin of a box dragged above and left", () => {
    expect(exportFrame(layout({ minX: -420, minY: -96, width: 1220, height: 700 }))).toEqual({
      x: -420,
      y: -96,
      width: 1220,
      height: 700,
    });
  });

  /* Floor the origin, ceil the size — never the other way round, or the frame loses a pixel of
     content on an edge that a fractional coordinate landed on. */
  it("rounds outwards", () => {
    expect(exportFrame(layout({ minX: -12.4, minY: -0.2, width: 300.1, height: 199.6 }))).toEqual({
      x: -13,
      y: -1,
      width: 301,
      height: 200,
    });
  });
});
