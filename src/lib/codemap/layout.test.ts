import { describe, expect, it } from "vitest";
import { COLUMN, layoutMap, MAX_COLUMNS, MAX_ROWS, ROW } from "./layout";

const node = (id: string, importedBy = 0, folder = true) => ({ id, label: id, folder, importedBy });

describe("layoutMap", () => {
  it("puts importers left of what they import", () => {
    const at = layoutMap([node("app"), node("lib"), node("ui")], [
      { from: "app", to: "ui" },
      { from: "ui", to: "lib" },
      { from: "app", to: "lib" },
    ]);
    expect(at.get("app")!.x).toBe(0);
    expect(at.get("ui")!.x).toBe(COLUMN);
    expect(at.get("lib")!.x).toBe(2 * COLUMN);
  });

  it("survives a cycle and still places every node", () => {
    const at = layoutMap([node("a"), node("b"), node("c")], [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ]);
    expect(at.size).toBe(3);
    const xs = new Set([...at.values()].map((p) => p.x));
    expect(xs.size).toBe(3);
  });

  it("orders a column folders first, most imported first, and centres it", () => {
    const at = layoutMap([node("x.ts", 1, false), node("lib", 5), node("core", 9)], []);
    expect(at.get("core")!.y).toBeLessThan(at.get("lib")!.y);
    expect(at.get("lib")!.y).toBeLessThan(at.get("x.ts")!.y);
    expect(at.get("core")!.y).toBe(-ROW);
  });

  it("wraps a long column", () => {
    const many = Array.from({ length: MAX_ROWS + 3 }, (_, i) => node(`f${i}`, 0, false));
    const at = layoutMap(many, []);
    const xs = new Set([...at.values()].map((p) => p.x));
    expect(xs).toEqual(new Set([0, COLUMN]));
  });

  it("with rootFirst, lists the root like the explorer and ranks only what is below it", () => {
    const at = layoutMap(
      [
        node("test", 0),
        node("src", 1),
        node("bench", 0),
        node("vitest.config.ts", 0, false),
        node("README.md", 0, false),
        node("src/core", 2),
        node("src/common", 3),
      ],
      [
        { from: "test", to: "src" },
        { from: "src", to: "src/core" },
        { from: "src/core", to: "src/common" },
      ],
      { rootFirst: true },
    );
    const root = ["bench", "src", "test", "README.md", "vitest.config.ts"];
    for (const id of root) expect(at.get(id)!.x).toBe(0);
    const ys = root.map((id) => at.get(id)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(at.get("src/core")!.x).toBe(COLUMN);
    expect(at.get("src/common")!.x).toBe(2 * COLUMN);
  });

  it("with rootFirst, still ranks a project that is all root", () => {
    const at = layoutMap([node("app.py"), node("lib.py")], [{ from: "app.py", to: "lib.py" }], { rootFirst: true });
    expect(at.get("app.py")!.x).toBe(0);
    expect(at.get("lib.py")!.x).toBe(COLUMN);
  });

  it("folds a deep chain into a few columns, keeping its direction", () => {
    const chain = Array.from({ length: 12 }, (_, i) => node(`s${i}`));
    const edges = chain.slice(1).map((n, i) => ({ from: chain[i].id, to: n.id }));
    const at = layoutMap(chain, edges);
    const xs = [...new Set([...at.values()].map((p) => p.x))];
    expect(xs.length).toBeLessThanOrEqual(MAX_COLUMNS);
    expect(at.get("s0")!.x).toBeLessThanOrEqual(at.get("s11")!.x);
    for (let i = 1; i < chain.length; i++) expect(at.get(`s${i - 1}`)!.x).toBeLessThanOrEqual(at.get(`s${i}`)!.x);
  });
});
