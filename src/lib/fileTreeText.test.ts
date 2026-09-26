import { describe, expect, it } from "vitest";
import { renderFileTree, treeFileName } from "./fileTreeText";
import type { TreeRow } from "./tauri/commands";

const row = (depth: number, name: string, isDir: boolean, last: boolean): TreeRow => ({
  depth,
  name,
  is_dir: isDir,
  last,
});

describe("renderFileTree", () => {
  it("prints the file-tree-generator format, character for character", () => {
    const text = renderFileTree("src", [
      row(0, "components", true, false),
      row(1, "App.tsx", false, false),
      row(1, "index.ts", false, true),
      row(0, "main.tsx", false, true),
    ]);
    expect(text).toBe(
      ["📦src", " ┣ 📂components", " ┃ ┣ 📜App.tsx", " ┃ ┗ 📜index.ts", " ┗ 📜main.tsx", ""].join("\n"),
    );
  });

  it("keeps the extension's rail under a last folder instead of correcting it", () => {
    // The extension indents with `┃ ` per level and never looks at whether the ancestor was last,
    // so `lib`'s contents still carry a rail below its `┗`. A README tree made with it looks like
    // this, and the output has to match it.
    const text = renderFileTree("app", [
      row(0, "a.ts", false, false),
      row(0, "lib", true, true),
      row(1, "deep", true, true),
      row(2, "b.ts", false, true),
    ]);
    expect(text.split("\n")).toEqual(["📦app", " ┣ 📜a.ts", " ┗ 📂lib", " ┃ ┗ 📂deep", " ┃ ┃ ┗ 📜b.ts", ""]);
  });

  it("is just the root for an empty folder", () => {
    expect(renderFileTree("empty", [])).toBe("📦empty\n");
  });

  it("puts a note below a blank line, so the tree above it can be copied as it is", () => {
    const text = renderFileTree("src", [row(0, "a.ts", false, false)], "… truncated at 1 entries");
    expect(text).toBe("📦src\n ┣ 📜a.ts\n\n… truncated at 1 entries\n");
  });

  it("adds no note when there is none", () => {
    expect(renderFileTree("src", [row(0, "a.ts", false, true)], null)).toBe("📦src\n ┗ 📜a.ts\n");
  });
});

describe("treeFileName", () => {
  it("names the tab after the folder, as plain text", () => {
    expect(treeFileName("src")).toBe("tree-src.txt");
    expect(treeFileName("code-flow")).toBe("tree-code-flow.txt");
  });
});
