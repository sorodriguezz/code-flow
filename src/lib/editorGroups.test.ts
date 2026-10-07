import { describe, expect, it } from "vitest";
import { newGroup, retargetInGroups } from "./editorGroups";

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
