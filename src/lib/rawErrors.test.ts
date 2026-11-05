import { describe, expect, it } from "vitest";
import { humanizeRaw } from "./rawErrors";

describe("humanizeRaw", () => {
  it("explains a branch held by another worktree", () => {
    const raw = "cannot set HEAD to reference 'refs/heads/main' as it is the current HEAD of a linked repository.";
    expect(humanizeRaw(raw, true)).toContain("La rama «main» está abierta en otro worktree");
  });
  it("explains a folder that is gone", () => {
    expect(humanizeRaw("failed to resolve path '/tmp/wt': No such file or directory", false)).toContain("/tmp/wt no longer exists");
  });
  it("leaves anything else alone", () => {
    expect(humanizeRaw("something odd", true)).toBe("something odd");
  });
});
