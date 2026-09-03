import { describe, expect, it } from "vitest";
import { layoutDbml } from "./layout";
import { routeEdges } from "./route";
import type { DbmlSchema } from "./types";

/**
 * The router, measured the only way that means anything: how many lines still pass through a box.
 *
 * A string assertion on a `d` attribute pins the implementation and says nothing about whether the
 * drawing is any good. This samples every segment of every path and asks the question the feature
 * exists to answer — "does this line go around the tables" — which is also what makes it a real
 * regression test rather than a change detector.
 */
function synth(tables: number, fanout: number): DbmlSchema {
  const rows = [];
  const refs = [];
  for (let at = 0; at < tables; at += 1) {
    rows.push({
      id: `t${at}`,
      schema: "public",
      name: `t${at}`,
      alias: null,
      note: null,
      fields: Array.from({ length: 8 }, (_, column) => ({
        name: `col_${column}`,
        type: "integer",
        pk: column === 0,
        notNull: false,
        unique: false,
        increment: false,
        defaultValue: null,
        note: null,
      })),
      indexes: [],
    });
  }
  for (let at = 1; at < tables; at += 1) {
    refs.push({
      id: `r${at}`,
      name: null,
      from: { table: `t${at}`, fields: ["col_1"], relation: "*" as const },
      to: { table: `t${Math.floor((at - 1) / fanout)}`, fields: ["col_0"], relation: "1" as const },
    });
  }
  return { tables: rows, enums: [], refs, groups: [], error: null } as unknown as DbmlSchema;
}

/** How many links have a path that passes through a box that is not one of its own two ends. */
function through(
  layout: ReturnType<typeof layoutDbml>,
  routes: ReturnType<typeof routeEdges>,
): number {
  const boxes = layout.nodes.map((node) => ({
    id: node.id,
    x0: node.x,
    y0: node.y,
    x1: node.x + node.width,
    y1: node.y + node.height,
  }));
  let count = 0;
  for (const link of layout.links) {
    const route = routes.get(link.id);
    if (!route) continue;
    const points = [...route.d.matchAll(/[-\d.]+\s+[-\d.]+/g)].map((match) =>
      match[0].split(/\s+/).map(Number),
    );
    const hit = points.slice(1).some(([bx, by], index) => {
      const [ax, ay] = points[index];
      // 20 samples a segment: the boxes are ~90px wide at their narrowest and the longest segment
      // in these fixtures is a few thousand, so nothing box-sized slips between two samples.
      return Array.from({ length: 21 }, (_, step) => step / 20).some((fraction) => {
        const x = ax + (bx - ax) * fraction;
        const y = ay + (by - ay) * fraction;
        return boxes.some(
          (box) =>
            box.id !== link.from &&
            box.id !== link.to &&
            x > box.x0 + 2 &&
            x < box.x1 - 2 &&
            y > box.y0 + 2 &&
            y < box.y1 - 2,
        );
      });
    });
    if (hit) count += 1;
  }
  return count;
}

describe("orthogonal routing goes around the boxes", () => {
  for (const density of ["roomy", "compact"] as const) {
    it(`clears every line on a schema you would actually read (${density})`, () => {
      const layout = layoutDbml(synth(30, 3), { mode: "all", density, pinned: {} });
      expect(through(layout, routeEdges(layout, "orthogonal", density))).toBe(0);
      // And the curve it replaces does not, or there would be no feature here. A count rather than
      // a threshold: the layout engine's own quality moves this number, and pinning it would make
      // this test fail every time the layout gets *better*.
      expect(through(layout, routeEdges(layout, "curved", density))).toBeGreaterThan(0);
    });

    it(`is a large improvement even where it cannot be perfect (${density})`, () => {
      const layout = layoutDbml(synth(200, 3), { mode: "all", density, pinned: {} });
      const curved = through(layout, routeEdges(layout, "curved", density));
      const orthogonal = through(layout, routeEdges(layout, "orthogonal", density));
      expect(orthogonal).toBeLessThan(curved / 2);
    });
  }

  it("leaves every line curved when asked for curves", () => {
    const layout = layoutDbml(synth(12, 3), { mode: "all", density: "roomy", pinned: {} });
    for (const route of routeEdges(layout, "curved", "roomy").values()) {
      expect(route.d).toContain(" C ");
    }
  });

  it("draws a self-reference as a loop rather than a staircase", () => {
    const schema = synth(1, 3) as DbmlSchema;
    (schema.refs as unknown[]).push({
      id: "self",
      name: null,
      from: { table: "t0", fields: ["col_1"], relation: "*" as const },
      to: { table: "t0", fields: ["col_0"], relation: "1" as const },
    });
    const layout = layoutDbml(schema, { mode: "all", density: "roomy", pinned: {} });
    for (const route of routeEdges(layout, "orthogonal", "roomy").values()) {
      expect(route.d).toContain(" C ");
    }
  });

  // Two boxes that overlap horizontally have no gap between them to run a vertical through — the
  // "gap" opens backwards. Measuring its magnitude rather than its sign let the Z route run anyway
  // and put its vertical down the middle of both tables, so the whole line was drawn inside the two
  // boxes it joins; since the boxes are painted after the lines, nothing reached the screen at all.
  it("does not route a line through the two boxes it joins", () => {
    const layout = layoutDbml(synth(2, 1), {
      mode: "all",
      density: "roomy",
      pinned: { t0: { x: 100, y: 0 }, t1: { x: 100, y: 260 } },
    });
    expect(through(layout, routeEdges(layout, "orthogonal", "roomy"))).toBe(0);
  });

  it("routes around a box parked between two tables by hand", () => {
    // The case the layout engine's own corridors could never answer: the obstacle is where the
    // *user* dragged it, not where the engine left it.
    const layout = layoutDbml(synth(3, 1), {
      mode: "all",
      density: "roomy",
      pinned: { t0: { x: 0, y: 0 }, t2: { x: 700, y: 0 }, t1: { x: 340, y: 0 } },
    });
    expect(through(layout, routeEdges(layout, "orthogonal", "roomy"))).toBe(0);
  });
});
