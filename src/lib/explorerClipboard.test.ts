import { describe, expect, it } from "vitest";
import { distinctParents, isAtOrUnder, planPaste, remapPath } from "./explorerClipboard";

describe("distinctParents", () => {
  it("drops anything whose folder is picked too", () => {
    expect(distinctParents(["src/a.ts", "src", "lib/b.ts", "src/deep/c.ts"])).toEqual(["src", "lib/b.ts"]);
  });

  it("keeps siblings and look-alike names, which are not inside each other", () => {
    // `src-old` starts with `src` but is not under it.
    expect(distinctParents(["src", "src-old/a.ts", "srcs"])).toEqual(["src", "src-old/a.ts", "srcs"]);
  });

  it("drops duplicates and keeps the order it was given", () => {
    expect(distinctParents(["b.ts", "a.ts", "b.ts"])).toEqual(["b.ts", "a.ts"]);
  });
});

describe("planPaste", () => {
  it("pastes into a folder, and beside a file", () => {
    expect(planPaste(["src/a.ts"], { path: "lib", isDir: true }).steps).toEqual([
      { source: "src/a.ts", destDir: "lib" },
    ]);
    expect(planPaste(["src/a.ts"], { path: "lib/b.ts", isDir: false }).steps).toEqual([
      { source: "src/a.ts", destDir: "lib" },
    ]);
  });

  it("pastes into the root from the empty space", () => {
    expect(planPaste(["src/a.ts", "lib"], { path: "", isDir: true }).steps).toEqual([
      { source: "src/a.ts", destDir: "" },
      { source: "lib", destDir: "" },
    ]);
  });

  it("duplicates a row pasted onto itself, folder or file, instead of pasting it inside itself", () => {
    // VS Code's rule, and what makes ⌘C ⌘V on one row mean "duplicate".
    expect(planPaste(["src"], { path: "src", isDir: true })).toEqual({
      steps: [{ source: "src", destDir: "" }],
      refused: [],
    });
    expect(planPaste(["src/a.ts"], { path: "src/a.ts", isDir: false }).steps).toEqual([
      { source: "src/a.ts", destDir: "src" },
    ]);
  });

  it("refuses a folder into its own subtree, and still pastes the rest", () => {
    expect(planPaste(["src", "lib/b.ts"], { path: "src/components", isDir: true })).toEqual({
      steps: [{ source: "lib/b.ts", destDir: "src/components" }],
      refused: ["src"],
    });
    // A file inside the folder is aimed at the folder itself.
    expect(planPaste(["src"], { path: "src/a.ts", isDir: false }).refused).toEqual(["src"]);
  });

  it("does not mistake a look-alike name for a subtree", () => {
    expect(planPaste(["src"], { path: "src-old", isDir: true }).steps).toEqual([
      { source: "src", destDir: "src-old" },
    ]);
  });
});

describe("remapPath", () => {
  it("follows a rename of the path itself or of a folder above it", () => {
    expect(remapPath("src/a.ts", "src/a.ts", "src/b.ts")).toBe("src/b.ts");
    expect(remapPath("src/deep/a.ts", "src", "lib")).toBe("lib/deep/a.ts");
  });

  it("leaves everything else alone, look-alike names included", () => {
    expect(remapPath("src-old/a.ts", "src", "lib")).toBe("src-old/a.ts");
    expect(remapPath("other.ts", "src", "lib")).toBe("other.ts");
  });
});

describe("isAtOrUnder", () => {
  it("is the path itself or anything inside it", () => {
    expect(isAtOrUnder("src", "src")).toBe(true);
    expect(isAtOrUnder("src/a.ts", "src")).toBe(true);
    expect(isAtOrUnder("src-old", "src")).toBe(false);
  });
});
