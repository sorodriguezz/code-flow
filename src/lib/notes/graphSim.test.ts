import { describe, expect, it } from "vitest";
import { bounds, createSimulation, isSettled, nodeAt, reheat, step, type SimNode } from "./graphSim";

const seed = (id: string, x: number, y: number, degree = 0) => ({ id, x, y, degree });
const distance = (a: SimNode, b: SimNode) => Math.hypot(a.x - b.x, a.y - b.y);

describe("graphSim", () => {
  it("pulls linked notes together and pushes unlinked ones apart", () => {
    const sim = createSimulation([seed("a", -300, 0, 1), seed("b", 300, 0, 1)], [{ source: 0, target: 1 }]);
    const apart = createSimulation([seed("a", -20, 0), seed("b", 20, 0)], []);
    const before = { linked: distance(sim.nodes[0], sim.nodes[1]), loose: distance(apart.nodes[0], apart.nodes[1]) };
    for (let frame = 0; frame < 120; frame++) {
      step(sim);
      step(apart);
    }
    expect(distance(sim.nodes[0], sim.nodes[1])).toBeLessThan(before.linked);
    expect(distance(apart.nodes[0], apart.nodes[1])).toBeGreaterThan(before.loose);
  });

  it("settles, and a drag wakes it up again", () => {
    const sim = createSimulation([seed("a", -40, 0, 1), seed("b", 40, 0, 1)], [{ source: 0, target: 1 }]);
    for (let frame = 0; frame < 600; frame++) step(sim);
    expect(isSettled(sim)).toBe(true);
    reheat(sim);
    expect(isSettled(sim)).toBe(false);
  });

  // A pinned node is the one under the pointer: the frame must not move it out from under it.
  it("leaves a pinned note exactly where it was put", () => {
    const sim = createSimulation([seed("a", 10, 10, 1), seed("b", 12, 11, 1)], [{ source: 0, target: 1 }]);
    sim.nodes[0].pinned = true;
    for (let frame = 0; frame < 30; frame++) step(sim);
    expect(sim.nodes[0]).toMatchObject({ x: 10, y: 10 });
    expect(isSettled(sim)).toBe(false);
  });

  it("finds the note under a point, and nothing when the point is bare", () => {
    const sim = createSimulation([seed("a", 0, 0, 4), seed("b", 500, 500)], []);
    expect(nodeAt(sim.nodes, 3, 3, () => 8)?.id).toBe("a");
    expect(nodeAt(sim.nodes, 200, 200, () => 8)).toBeNull();
  });

  it("frames every note, with room around them", () => {
    const sim = createSimulation([seed("a", -100, -50), seed("b", 100, 50)], []);
    const box = bounds(sim.nodes, 20);
    expect(box).toEqual({ minX: -120, minY: -70, maxX: 120, maxY: 70 });
  });

  it("does nothing with an empty graph", () => {
    const sim = createSimulation([], []);
    expect(() => step(sim)).not.toThrow();
    expect(bounds(sim.nodes)).toBeDefined();
  });
});
