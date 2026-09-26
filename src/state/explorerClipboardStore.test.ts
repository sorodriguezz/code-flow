import { beforeEach, describe, expect, it } from "vitest";
import { useExplorerClipboardStore } from "./explorerClipboardStore";

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
});
