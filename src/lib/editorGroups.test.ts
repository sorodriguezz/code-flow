import { describe, expect, it } from "vitest";
import { closePathsInGroup, newGroup, retargetInGroups } from "./editorGroups";

describe("retargetInGroups", () => {
  it("swaps a tab for another path in its own slot, pinned and active as it was", () => {
    const left = { ...newGroup(["a.ts", "/Sin título", "b.ts"], "/Sin título"), pinned: ["a.ts", "/Sin título"] };
    const right = newGroup(["c.ts"], "c.ts");
    const [first, second] = retargetInGroups([left, right], "/Sin título", "notas/idea.md");
    expect(first.paths).toEqual(["a.ts", "notas/idea.md", "b.ts"]);
    expect(first.pinned).toEqual(["a.ts", "notas/idea.md"]);
    expect(first.activePath).toBe("notas/idea.md");
    expect(second).toBe(right);
  });
});

describe("closePathsInGroup", () => {
  const group = () => ({ ...newGroup(), id: "g", paths: ["pin.ts", "a.ts", "b.ts", "c.ts"], pinned: ["pin.ts"], activePath: "b.ts" });

  it("keeps the active tab when it survives", () => {
    const [next] = closePathsInGroup([group()], "g", ["a.ts", "c.ts"]);
    expect(next.paths).toEqual(["pin.ts", "b.ts"]);
    expect(next.activePath).toBe("b.ts");
  });

  it("moves to the nearest survivor when the active tab goes", () => {
    const [next] = closePathsInGroup([group()], "g", ["b.ts", "c.ts"]);
    expect(next.activePath).toBe("a.ts");
  });

  it("drops a group it empties when there is another", () => {
    const other = { ...newGroup(), id: "h", paths: ["x.ts"], pinned: [], activePath: "x.ts" };
    const next = closePathsInGroup([group(), other], "g", ["pin.ts", "a.ts", "b.ts", "c.ts"]);
    expect(next.map((g) => g.id)).toEqual(["h"]);
  });
});
