import { describe, expect, it } from "vitest";
import { commitTargetLabel } from "./commitTargetLabel";

describe("commitTargetLabel", () => {
  it("names branch and repo", () => {
    expect(commitTargetLabel({ repoPath: "/a/app", branch: "main", detached: false }, "app", "detached HEAD")).toBe("main · app");
  });
  it("says detached HEAD instead of a branch", () => {
    expect(commitTargetLabel({ repoPath: "/a/app", branch: null, detached: true }, "app", "detached HEAD")).toBe("detached HEAD · app");
  });
});
