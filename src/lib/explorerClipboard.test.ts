import { describe, expect, it } from "vitest";
import {
  absoluteIn,
  distinctParents,
  isAtOrUnder,
  pickPasteSource,
  planPaste,
  remapPath,
} from "./explorerClipboard";

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

describe("planPaste from another repository", () => {
  it("lands everything in the target folder, never as a duplicate beside itself", () => {
    // The same relative path in another repository is a different file: no "paste onto itself".
    expect(planPaste(["src", "src/a.ts"], { path: "src", isDir: true }, false)).toEqual({
      steps: [
        { source: "src", destDir: "src" },
        { source: "src/a.ts", destDir: "src" },
      ],
      refused: [],
    });
    expect(planPaste(["lib"], { path: "lib/x.ts", isDir: false }, false).steps).toEqual([
      { source: "lib", destDir: "lib" },
    ]);
  });
});

describe("absoluteIn", () => {
  it("joins a repo-relative path onto the repository", () => {
    expect(absoluteIn("/work/app", "src/a.ts")).toBe("/work/app/src/a.ts");
    expect(absoluteIn("/work/app/", "src")).toBe("/work/app/src");
    expect(absoluteIn("C:\\work\\app\\", "src")).toBe("C:\\work\\app/src");
    expect(absoluteIn("/work/app", "")).toBe("/work/app");
  });
});

describe("pickPasteSource", () => {
  const app = (paths: string[], systemStamp: number | null) => ({ paths, systemStamp });
  const sys = (stamp: number | null, paths: string[]) => ({ stamp, paths });

  it("takes the explorer's copy while the system clipboard has not moved on", () => {
    expect(pickPasteSource(app(["a.ts"], 7), sys(7, ["/x/b.ts"]))).toBe("app");
  });

  it("takes files copied in the file manager after the explorer's copy", () => {
    expect(pickPasteSource(app(["a.ts"], 7), sys(8, ["/x/b.ts"]))).toBe("system");
  });

  it("keeps the explorer's copy when what was copied since is not files", () => {
    expect(pickPasteSource(app(["a.ts"], 7), sys(9, []))).toBe("app");
  });

  it("keeps the explorer's copy when either counter is unknown", () => {
    expect(pickPasteSource(app(["a.ts"], null), sys(9, ["/x/b.ts"]))).toBe("app");
    expect(pickPasteSource(app(["a.ts"], 7), sys(null, ["/x/b.ts"]))).toBe("app");
    expect(pickPasteSource(app(["a.ts"], 7), null)).toBe("app");
  });

  it("falls back to the system clipboard, or to nothing", () => {
    expect(pickPasteSource(app([], null), sys(3, ["/x/b.ts"]))).toBe("system");
    expect(pickPasteSource(app([], null), sys(3, []))).toBeNull();
    expect(pickPasteSource(app([], null), null)).toBeNull();
  });
});
