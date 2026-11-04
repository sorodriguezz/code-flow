import { describe, expect, it } from "vitest";
import { repoForCwd, summaryFromLive } from "./repoSummaryStore";

describe("repoForCwd", () => {
  const repos = ["/work/app", "/work/app/packages/ui", "/work/api"];

  it("finds the repository a folder is in, the deepest one first", () => {
    expect(repoForCwd(repos, "/work/app")).toBe("/work/app");
    expect(repoForCwd(repos, "/work/app/src/lib")).toBe("/work/app");
    expect(repoForCwd(repos, "/work/app/packages/ui/src")).toBe("/work/app/packages/ui");
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(repoForCwd(repos, "/work/apple")).toBeNull();
    expect(repoForCwd(repos, "/elsewhere")).toBeNull();
  });

  it("compares Windows and trailing separators alike", () => {
    expect(repoForCwd(["C:\\work\\app"], "C:/work/app/src/")).toBe("C:\\work\\app");
  });
});

describe("summaryFromLive", () => {
  it("counts each changed path once and takes ahead/behind from the local head", () => {
    const file = (path: string) => ({ path }) as never;
    const summary = summaryFromLive(
      "/work/app",
      {
        current_branch: "main",
        is_detached: false,
        staged: [file("a.ts")],
        unstaged: [file("a.ts"), file("b.ts")],
        untracked: [file("c.ts")],
        conflicted: [],
      } as never,
      [
        { name: "main", is_head: true, is_remote: false, ahead: 2, behind: 0 },
        { name: "origin/main", is_head: false, is_remote: true, ahead: 0, behind: 0 },
      ] as never,
    );
    expect(summary).toMatchObject({ path: "/work/app", branch: "main", changed: 3, conflicted: 0, ahead: 2, behind: 0 });
  });
});
