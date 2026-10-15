import { beforeEach, describe, expect, it } from "vitest";
import { explorerClipboardSnapshot, useExplorerClipboardStore } from "./explorerClipboardStore";

const REPO = "/work/app";
const state = () => useExplorerClipboardStore.getState();

describe("explorerClipboardStore", () => {
  beforeEach(() => state().clear());

  it("follows a rename or a move of what it holds", () => {
    state().set(REPO, "cut", ["src/a.ts", "lib"]);
    state().moved(REPO, "src/a.ts", "src/b.ts");
    state().moved(REPO, "lib", "packages/lib");
    expect(state().paths).toEqual(["src/b.ts", "packages/lib"]);
    expect(state().mode).toBe("cut");
  });

  it("follows a folder above what it holds, too", () => {
    state().set(REPO, "copy", ["src/deep/a.ts"]);
    state().moved(REPO, "src", "app");
    expect(state().paths).toEqual(["app/deep/a.ts"]);
  });

  it("drops what was deleted, and empties itself once nothing is left", () => {
    state().set(REPO, "copy", ["src/a.ts", "lib/b.ts"]);
    state().removed(REPO, "src");
    expect(state().paths).toEqual(["lib/b.ts"]);
    state().removed(REPO, "lib/b.ts");
    expect(state().paths).toEqual([]);
    expect(state().repoPath).toBeNull();
  });

  it("ignores what happens in another repository", () => {
    state().set(REPO, "copy", ["src/a.ts"]);
    state().moved("/work/other", "src/a.ts", "src/b.ts");
    state().removed("/work/other", "src/a.ts");
    expect(state().paths).toEqual(["src/a.ts"]);
    expect(state().repoPath).toBe(REPO);
  });

  it("orders its changes, so another window's older version never wins", () => {
    state().set(REPO, "copy", ["src/a.ts"]);
    const first = explorerClipboardSnapshot();
    state().set(REPO, "cut", ["lib"]);
    const second = explorerClipboardSnapshot();
    expect(second.at).toBeGreaterThan(first.at);

    state().adopt(first);
    expect(state().paths).toEqual(["lib"]);
    state().adopt({ ...second, repoPath: "/work/other", paths: ["x"], at: second.at + 5 });
    expect(state().repoPath).toBe("/work/other");
    expect(state().paths).toEqual(["x"]);
    // A change made here after adopting one is newer than it.
    state().moved("/work/other", "x", "y");
    expect(state().at).toBeGreaterThan(second.at + 5);
  });

  it("records the system counter only for the copy it was read for", () => {
    state().set(REPO, "copy", ["src/a.ts"]);
    const at = state().at;
    state().stampSystem(at, 41);
    expect(state().systemStamp).toBe(41);
    state().set(REPO, "copy", ["src/b.ts"]);
    state().stampSystem(at, 42);
    expect(state().systemStamp).toBeNull();
  });
});
