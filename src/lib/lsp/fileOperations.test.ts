import { describe, expect, it } from "vitest";
import { globToRegExp, renameWanted } from "./fileOperations";

describe("globToRegExp", () => {
  it("matches across folders with **, the root included", () => {
    const rust = globToRegExp("**/*.rs");
    expect(rust.test("/home/dev/repo/src/main.rs")).toBe(true);
    expect(rust.test("C:/repo/src/net/mod.rs")).toBe(true);
    expect(rust.test("main.rs")).toBe(true);
    expect(rust.test("/home/dev/repo/src/main.rsx")).toBe(false);
    expect(globToRegExp("**").test("/any/thing/at/all")).toBe(true);
  });

  it("keeps * and ? inside one segment", () => {
    expect(globToRegExp("/repo/*.ts").test("/repo/a.ts")).toBe(true);
    expect(globToRegExp("/repo/*.ts").test("/repo/src/a.ts")).toBe(false);
    expect(globToRegExp("/repo/?.ts").test("/repo/a.ts")).toBe(true);
    expect(globToRegExp("/repo/?.ts").test("/repo/ab.ts")).toBe(false);
  });

  it("reads alternatives and ranges", () => {
    const either = globToRegExp("**/*.{ts,tsx}");
    expect(either.test("/repo/a.ts")).toBe(true);
    expect(either.test("/repo/a.tsx")).toBe(true);
    expect(either.test("/repo/a.js")).toBe(false);
    expect(globToRegExp("**/v[0-9].txt").test("/repo/v3.txt")).toBe(true);
    expect(globToRegExp("**/v[!0-9].txt").test("/repo/v3.txt")).toBe(false);
    expect(globToRegExp("**/v[!0-9].txt").test("/repo/vx.txt")).toBe(true);
  });

  it("takes everything else literally", () => {
    expect(globToRegExp("**/a.b+(c)").test("/repo/a.b+(c)")).toBe(true);
    expect(globToRegExp("**/a.b").test("/repo/axb")).toBe(false);
  });

  it("ignores case only when asked to", () => {
    expect(globToRegExp("**/*.RS").test("/repo/main.rs")).toBe(false);
    expect(globToRegExp("**/*.RS", true).test("/repo/main.rs")).toBe(true);
  });
});

describe("renameWanted", () => {
  // rust-analyzer's own registration.
  const rustAnalyzer = [
    { scheme: "file", pattern: { glob: "**/*.rs", matches: "file" as const } },
    { scheme: "file", pattern: { glob: "**", matches: "folder" as const } },
  ];

  it("asks about the files and folders a server named, and nothing else", () => {
    expect(renameWanted(rustAnalyzer, "C:\\repo\\src\\lib.rs", false)).toBe(true);
    expect(renameWanted(rustAnalyzer, "/repo/src/net", true)).toBe(true);
    expect(renameWanted(rustAnalyzer, "/repo/styles.css", false)).toBe(false);
  });

  it("holds a filter to the kind it names", () => {
    // A folder called `x.rs` is not a Rust file.
    expect(renameWanted([rustAnalyzer[0]], "/repo/x.rs", true)).toBe(false);
  });

  it("only ever answers for files on disk", () => {
    expect(renameWanted([{ scheme: "untitled", pattern: { glob: "**" } }], "/repo/a.rs", false)).toBe(false);
  });
});
