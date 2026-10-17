import { describe, expect, it } from "vitest";
import { findFileRefs, quotePath, resolveRef } from "./fileLinks";

const refs = (text: string) => findFileRefs(text).map(({ path, line, column }) => ({ path, line, column }));

describe("findFileRefs", () => {
  it("reads the shapes compilers print", () => {
    expect(refs("src/foo.ts:42:7 - error TS2322")).toEqual([{ path: "src/foo.ts", line: 42, column: 7 }]);
    expect(refs("  --> src/main.rs:10:5")).toEqual([{ path: "src/main.rs", line: 10, column: 5 }]);
    expect(refs("src/App.tsx(12,3): error")).toEqual([{ path: "src/App.tsx", line: 12, column: 3 }]);
    expect(refs('  File "/tmp/x.py", line 3, in f')).toEqual([{ path: "/tmp/x.py", line: 3, column: undefined }]);
    expect(refs("at f (/home/u/a.js:3:9)")).toEqual([{ path: "/home/u/a.js", line: 3, column: 9 }]);
    expect(refs(String.raw`C:\repo\src\x.cs(4,1): warning`)).toEqual([{ path: String.raw`C:\repo\src\x.cs`, line: 4, column: 1 }]);
  });

  it("takes a path with no line, and a folder", () => {
    expect(refs("modified:   README.md")).toEqual([{ path: "README.md", line: undefined, column: undefined }]);
    expect(refs("cd ./packages/web")).toEqual([{ path: "./packages/web", line: undefined, column: undefined }]);
  });

  it("leaves out versions, numbers, URLs and sentence dots", () => {
    expect(refs("node v20.11.1 and 1.2.3")).toEqual([]);
    expect(refs("see https://example.com/a/b.html:80 now")).toEqual([]);
    expect(refs("edit src/x.ts.")).toEqual([{ path: "src/x.ts", line: undefined, column: undefined }]);
  });

  it("places the link over the path and its line", () => {
    const [ref] = findFileRefs("error at src/a.ts:3 here");
    expect("error at src/a.ts:3 here".slice(ref.start, ref.end)).toBe("src/a.ts:3");
  });
});

describe("resolveRef", () => {
  it("joins relative paths to the shell's folder", () => {
    expect(resolveRef("src/a.ts", "/repo", "/home/u")).toBe("/repo/src/a.ts");
    expect(resolveRef("../b/c.ts", "/repo/web", "/home/u")).toBe("/repo/b/c.ts");
    expect(resolveRef("~/x.txt", "/repo", "/home/u")).toBe("/home/u/x.txt");
    expect(resolveRef("/abs/y.rs", "/repo", "/home/u")).toBe("/abs/y.rs");
    expect(resolveRef(String.raw`src\a.cs`, String.raw`C:\repo`, "C:/Users/u")).toBe(String.raw`C:\repo\src\a.cs`);
  });
});

describe("quotePath", () => {
  it("quotes only what needs it, per platform", () => {
    expect(quotePath("/repo/src/a.ts", false)).toBe("/repo/src/a.ts");
    expect(quotePath("/my docs/it's.txt", false)).toBe(String.raw`'/my docs/it'\''s.txt'`);
    expect(quotePath(String.raw`C:\My Docs\a.txt`, true)).toBe(String.raw`"C:\My Docs\a.txt"`);
  });
});
