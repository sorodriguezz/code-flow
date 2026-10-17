import { describe, expect, it } from "vitest";
import { addToGroup, detach, joinGroup, moveInList, newGroup, normalizeSizes, removeFromGroups, replaceId, resizeAt } from "./terminalLayout";

describe("terminal layout", () => {
  it("adds to a split and shares the room evenly", () => {
    const group = addToGroup(newGroup(["a"]), "b", "column");
    expect(group.ids).toEqual(["a", "b"]);
    expect(group.dir).toBe("column");
    expect(group.sizes).toEqual([0.5, 0.5]);
  });

  it("removes a pane and keeps the others' proportions", () => {
    const group = { ...newGroup(["a", "b", "c"]), sizes: [0.5, 0.25, 0.25], broadcast: true };
    const [left] = removeFromGroups([group], "a");
    expect(left.ids).toEqual(["b", "c"]);
    expect(left.sizes).toEqual([0.5, 0.5]);
    expect(left.broadcast).toBe(true);
    expect(removeFromGroups([newGroup(["x"])], "x")).toEqual([]);
  });

  it("restarts in place, detaches and joins", () => {
    const g1 = newGroup(["a", "b"]);
    const g2 = newGroup(["c"]);
    expect(replaceId([g1], "b", "z")[0].ids).toEqual(["a", "z"]);
    const detached = detach([g1, g2], "b");
    expect(detached.map((g) => g.ids)).toEqual([["a"], ["c"], ["b"]]);
    const joined = joinGroup([g1, g2], "c", g1.id);
    expect(joined.map((g) => g.ids)).toEqual([["a", "b", "c"]]);
  });

  it("moves a row in the list", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(moveInList(items, "c", 0).map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(moveInList(items, "a", 9).map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("resizes two neighbours and keeps a floor", () => {
    expect(resizeAt([0.5, 0.5], 0, 0.2).map((n) => +n.toFixed(2))).toEqual([0.7, 0.3]);
    expect(resizeAt([0.5, 0.5], 0, 0.9).map((n) => +n.toFixed(2))).toEqual([0.92, 0.08]);
    expect(normalizeSizes([1, 1], 3)).toHaveLength(3);
  });
});
