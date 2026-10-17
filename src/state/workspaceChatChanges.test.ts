import { describe, expect, it } from "vitest";
import { parseWsTurnChanges } from "./workspaceChatStore";

describe("parseWsTurnChanges", () => {
  it("reads one entry per repository that changed", () => {
    const json = JSON.stringify([
      { repo: "api", path: "/w/api", id: "c1", paths: ["a.ts"] },
      { repo: "web", path: "/w/web", id: "c2", paths: [] },
    ]);
    expect(parseWsTurnChanges(json)).toEqual([{ repo: "api", repoPath: "/w/api", checkpointId: "c1", paths: ["a.ts"] }]);
  });

  it("is undefined for nothing, junk, or no changed file", () => {
    expect(parseWsTurnChanges(null)).toBeUndefined();
    expect(parseWsTurnChanges("{")).toBeUndefined();
    expect(parseWsTurnChanges(JSON.stringify({ id: "x" }))).toBeUndefined();
    expect(parseWsTurnChanges(JSON.stringify([{ path: "/w", id: "c", paths: [] }]))).toBeUndefined();
  });
});
