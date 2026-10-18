import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graphLayout";

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
