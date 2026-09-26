import { describe, expect, it } from "vitest";
import { freeScratchPath, isScratchPath, scratchName, scratchPath } from "./scratchTabs";

describe("scratch tab paths", () => {
  it("can never be a path listed from a repository", () => {
    expect(isScratchPath(scratchPath("tree-src.txt"))).toBe(true);
    expect(isScratchPath("src/tree-src.txt")).toBe(false);
    expect(isScratchPath("tree-src.txt")).toBe(false);
    expect(isScratchPath(null)).toBe(false);
    expect(isScratchPath(undefined)).toBe(false);
  });

  it("round-trips the name it is shown and saved under", () => {
    expect(scratchName(scratchPath("tree-src.txt"))).toBe("tree-src.txt");
  });
});

describe("freeScratchPath", () => {
  it("takes the name as it is while no tab holds it", () => {
    expect(freeScratchPath("tree-src.txt", () => false)).toBe("/tree-src.txt");
  });

  it("numbers it before the extension when it is taken", () => {
    const open = new Set(["/tree-src.txt", "/tree-src 2.txt"]);
    expect(freeScratchPath("tree-src.txt", (path) => open.has(path))).toBe("/tree-src 3.txt");
  });

  it("numbers a name with no extension at its end", () => {
    const open = new Set(["/notes"]);
    expect(freeScratchPath("notes", (path) => open.has(path))).toBe("/notes 2");
  });
});
