import { describe, expect, it } from "vitest";
import { layoutGraph, layoutGroups } from "./graphLayout";
import { createSimulation, isSettled, step } from "./graphSim";

describe("layoutGraph", () => {
  it("puts linked notes closer than unlinked ones, and draws the same picture twice", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const edges: [string, string][] = [["a", "b"], ["b", "c"], ["a", "c"]];
    const first = layoutGraph(ids, edges);
    const second = layoutGraph(ids, edges);
    expect([...first.entries()]).toEqual([...second.entries()]);
    const distance = (p: string, q: string) => Math.hypot(first.get(p)!.x - first.get(q)!.x, first.get(p)!.y - first.get(q)!.y);
    expect(distance("a", "b")).toBeLessThan(distance("d", "e"));
  });

  it("handles nothing and one note", () => {
    expect(layoutGraph([], []).size).toBe(0);
    expect(layoutGraph(["x"], [["x", "x"]]).get("x")).toBeDefined();
  });
});

/** Two books — 300 notes and 120 — each linked inside like a real vault (a chain plus a few hubs),
 *  and a handful of links across. */
function vault() {
  const ids: string[] = [];
  const book = new Map<string, string>();
  const edges: [string, string][] = [];
  for (const [name, size] of [["a", 300], ["b", 120]] as const) {
    for (let i = 0; i < size; i++) {
      const id = `${name}${i}`;
      ids.push(id);
      book.set(id, name);
      if (i > 0) edges.push([id, `${name}${Math.floor(i / 3)}`]);
    }
  }
  for (let i = 0; i < 8; i++) edges.push([`a${i * 7}`, `b${i * 5}`]);
  return { ids, edges, groupOf: (id: string) => book.get(id)! };
}

/** The smallest distance between a note of one book and a note of the other. */
function closestAcross(points: Map<string, { x: number; y: number }>, groupOf: (id: string) => string) {
  const a = [...points].filter(([id]) => groupOf(id) === "a").map(([, p]) => p);
  const b = [...points].filter(([id]) => groupOf(id) === "b").map(([, p]) => p);
  let closest = Infinity;
  for (const p of a) for (const q of b) closest = Math.min(closest, Math.hypot(p.x - q.x, p.y - q.y));
  return closest;
}

/** How far out from the middle 95% of the notes sit — a picture that has to fit a screen. */
function spread(points: { x: number; y: number }[]) {
  const distances = points.map((p) => Math.hypot(p.x, p.y)).sort((a, b) => a - b);
  return distances[Math.floor(distances.length * 0.95)];
}

/** The median distance from a note to its nearest neighbour — how crowded the picture reads. */
function medianNearest(points: { x: number; y: number }[]) {
  const nearest = points.map((p, i) =>
    Math.min(...points.filter((_, j) => j !== i).map((q) => Math.hypot(p.x - q.x, p.y - q.y))),
  );
  nearest.sort((x, y) => x - y);
  return nearest[Math.floor(nearest.length / 2)];
}

describe("layoutGroups", () => {
  it("lays each book out as its own island, apart from the others", () => {
    const { ids, edges, groupOf } = vault();
    const { points, anchors } = layoutGroups(ids, edges, groupOf);
    expect(points.size).toBe(ids.length);
    expect(anchors.size).toBe(2);
    expect(closestAcross(points, groupOf)).toBeGreaterThan(300);
    expect(spread([...points.values()])).toBeLessThan(3000);
    expect([...layoutGroups(ids, edges, groupOf).points]).toEqual([...points]);
  });

  it("keeps the books apart and the notes spaced once the live graph has run", () => {
    const { ids, edges, groupOf } = vault();
    const { points, anchors } = layoutGroups(ids, edges, groupOf);
    const index = new Map(ids.map((id, i) => [id, i]));
    const sim = createSimulation(
      ids.map((id) => ({ id, ...points.get(id)!, degree: 1, ax: anchors.get(groupOf(id))!.x, ay: anchors.get(groupOf(id))!.y })),
      edges.map(([from, to]) => ({ source: index.get(from)!, target: index.get(to)! })),
    );
    for (let frame = 0; frame < 2000 && !isSettled(sim); frame++) step(sim);
    const after = new Map(sim.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    expect(closestAcross(after, groupOf)).toBeGreaterThan(300);
    // About twice what the graph settled at before (43), and still a picture that fits a screen.
    expect(medianNearest([...after.values()])).toBeGreaterThan(65);
    expect(spread([...after.values()])).toBeLessThan(3000);
    // And no note flung off on its own: the farthest is with the rest, not across the screen.
    expect(Math.max(...[...after.values()].map((p) => Math.hypot(p.x, p.y)))).toBeLessThan(3200);
  });

  it("centres a single book on the origin", () => {
    const { anchors } = layoutGroups(["x", "y"], [["x", "y"]], () => "only");
    expect(anchors.get("only")).toEqual({ x: 0, y: 0 });
  });
});

