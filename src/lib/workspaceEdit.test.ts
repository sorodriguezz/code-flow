import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  applyEditPlan,
  applyTextEdits,
  editCount,
  lineText,
  planLspEdit,
  planTsRename,
  positionsAfter,
  type ApplyDeps,
  type TextEdit,
} from "./workspaceEdit";
import type { DiskVersion } from "./tauri/commands";

const ROOT = "/repo";
const relOf = (uri: string) => (uri.startsWith("file:///repo/") ? uri.slice("file:///repo/".length) : null);
const at = (line: number, column: number, endLine: number, endColumn: number, text: string): TextEdit => ({
  range: { startLineNumber: line, startColumn: column, endLineNumber: endLine, endColumn },
  text,
});
const lsp = (line: number, character: number, endLine: number, endCharacter: number, newText: string) => ({
  range: { start: { line, character }, end: { line: endLine, character: endCharacter } },
  newText,
});

describe("planning an edit", () => {
  it("reads the `changes` map, converting LSP's 0-based positions", () => {
    const plan = planLspEdit(
      {
        changes: {
          "file:///repo/src/a.ts": [lsp(0, 6, 0, 9, "bar")],
          "file:///elsewhere/lib.d.ts": [lsp(2, 0, 2, 3, "bar")],
        },
      },
      relOf,
    );
    expect(plan.files).toEqual([{ path: "src/a.ts", edits: [at(1, 7, 1, 10, "bar")] }]);
    expect(plan.outside).toEqual(["file:///elsewhere/lib.d.ts"]);
    expect(plan.unsupported).toBe(0);
  });

  it("reads `documentChanges`, merging a file named twice and refusing file operations", () => {
    const plan = planLspEdit(
      {
        documentChanges: [
          { textDocument: { uri: "file:///repo/a.py", version: 3 }, edits: [lsp(0, 0, 0, 3, "new")] },
          { kind: "rename" },
          { textDocument: { uri: "file:///repo/a.py", version: 3 }, edits: [lsp(4, 2, 4, 5, "new")] },
        ],
      },
      relOf,
    );
    expect(plan.files).toEqual([{ path: "a.py", edits: [at(1, 1, 1, 4, "new"), at(5, 3, 5, 6, "new")] }]);
    expect(plan.unsupported).toBe(1);
    expect(editCount(plan)).toBe(2);
  });

  it("builds tsserver's replacements from the new name and the shorthand prefix and suffix", () => {
    const plan = planTsRename(
      [
        {
          file: "/repo/src/user.ts",
          locs: [
            { start: { line: 1, offset: 14 }, end: { line: 1, offset: 18 } },
            { start: { line: 5, offset: 10 }, end: { line: 5, offset: 14 }, prefixText: "name: " },
          ],
        },
        { file: "/repo/node_modules/x/index.d.ts", locs: [{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 5 } }] },
      ],
      "fullName",
      (file) => (file.startsWith("/repo/node_modules") ? null : file.slice(ROOT.length + 1)),
    );
    expect(plan.files).toEqual([
      { path: "src/user.ts", edits: [at(1, 14, 1, 18, "fullName"), at(5, 10, 5, 14, "name: fullName")] },
    ]);
    expect(plan.outside).toEqual(["/repo/node_modules/x/index.d.ts"]);
  });
});

describe("applying edits to text", () => {
  it("replaces ranges, several to a line, whatever order they arrive in", () => {
    const text = "const foo = foo + 1;\nuse(foo);\n";
    const next = applyTextEdits(text, [at(2, 5, 2, 8, "bar"), at(1, 7, 1, 10, "bar"), at(1, 13, 1, 16, "bar")]);
    expect(next).toBe("const bar = bar + 1;\nuse(bar);\n");
  });

  it("counts lines the way LSP does — CRLF and lone CR included — and keeps the endings", () => {
    expect(applyTextEdits("a\r\nfoo\rbar\n", [at(2, 1, 2, 4, "baz"), at(3, 1, 3, 4, "qux")])).toBe(
      "a\r\nbaz\rqux\n",
    );
  });

  it("inserts at one position in the order given", () => {
    expect(applyTextEdits("x", [at(1, 1, 1, 1, "a"), at(1, 1, 1, 1, "b")])).toBe("abx");
  });

  it("clamps a column past the end of its line, and reads a line past the last as the end", () => {
    expect(applyTextEdits("ab\ncd", [at(1, 2, 1, 99, "Z")])).toBe("aZ\ncd");
    expect(applyTextEdits("ab\n", [at(1, 1, 3, 1, "")])).toBe("");
  });

  it("refuses overlapping edits instead of guessing", () => {
    expect(() => applyTextEdits("abcdef", [at(1, 1, 1, 4, "x"), at(1, 3, 1, 5, "y")])).toThrow(/overlapping/);
  });
});

describe("where the edits end up", () => {
  it("shifts later edits on a line by the ones before them", () => {
    // `a = a` → `alpha = alpha`: the second starts 4 columns further right.
    expect(positionsAfter([at(1, 1, 1, 2, "alpha"), at(1, 5, 1, 6, "alpha")])).toEqual([
      { lineNumber: 1, column: 1 },
      { lineNumber: 1, column: 9 },
    ]);
  });

  it("shifts later lines by the lines an edit inserts, and answers in the order given", () => {
    const edits = [at(4, 3, 4, 6, "x"), at(1, 1, 1, 1, "// one\n// two\n")];
    expect(positionsAfter(edits)).toEqual([
      { lineNumber: 6, column: 3 },
      { lineNumber: 1, column: 1 },
    ]);
  });

  it("reads a line's text trimmed", () => {
    expect(lineText("a\n  const x = 1;\r\nb", 2)).toBe("const x = 1;");
    expect(lineText("a", 5)).toBe("");
  });
});

describe("applying a plan", () => {
  const version: DiskVersion = { mtime_ms: 1, size: 3, hash: "h" };

  function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps & { writes: [string, string, DiskVersion][] } {
    const writes: [string, string, DiskVersion][] = [];
    return {
      writes,
      host: {
        isOpen: (path) => path === "open.ts",
        applyToOpen: (_path, edits) => applyTextEdits("let foo;", edits),
      },
      read: async (path) => (path === "latin1.txt" ? null : { text: "foo()\n", version }),
      write: async (path, text, v) => {
        writes.push([path, text, v]);
      },
      checkpoint: vi.fn(async () => "cp-1"),
      ...overrides,
    };
  }

  it("edits open tabs in their buffer and the rest on disk, checked against what was read", async () => {
    const d = deps();
    const outcome = await applyEditPlan(
      {
        files: [
          { path: "open.ts", edits: [at(1, 5, 1, 8, "bar")] },
          { path: "closed.ts", edits: [at(1, 1, 1, 4, "bar")] },
        ],
        outside: [],
        unsupported: 0,
      },
      d,
    );
    expect(d.writes).toEqual([["closed.ts", "bar()\n", version]]);
    expect(outcome.changes).toBe(2);
    expect(outcome.checkpointId).toBe("cp-1");
    expect(outcome.applied).toEqual([
      { path: "open.ts", inBuffer: true, at: [{ lineNumber: 1, column: 5, text: "let bar;" }] },
      { path: "closed.ts", inBuffer: false, at: [{ lineNumber: 1, column: 1, text: "bar()" }] },
    ]);
  });

  it("takes no checkpoint when nothing is written to disk", async () => {
    const d = deps();
    await applyEditPlan({ files: [{ path: "open.ts", edits: [at(1, 5, 1, 8, "bar")] }], outside: [], unsupported: 0 }, d);
    expect(d.checkpoint).not.toHaveBeenCalled();
  });

  it("reports a file changed underneath as a conflict and keeps going", async () => {
    const d = deps({
      write: async (path) => {
        if (path === "raced.ts") throw new Error("changed-on-disk: raced.ts");
      },
    });
    const outcome = await applyEditPlan(
      {
        files: [
          { path: "raced.ts", edits: [at(1, 1, 1, 4, "bar")] },
          { path: "latin1.txt", edits: [at(1, 1, 1, 4, "bar")] },
          { path: "fine.ts", edits: [at(1, 1, 1, 4, "bar")] },
        ],
        outside: [],
        unsupported: 0,
      },
      d,
    );
    expect(outcome.conflicts).toEqual(["raced.ts"]);
    expect(outcome.failed.map((f) => f.path)).toEqual(["latin1.txt"]);
    expect(outcome.applied.map((f) => f.path)).toEqual(["fine.ts"]);
    expect(outcome.changes).toBe(1);
  });

  it("reports an open tab that refused the edit without writing it to disk instead", async () => {
    const d = deps({
      host: {
        isOpen: () => true,
        applyToOpen: () => {
          throw new Error("read-only");
        },
      },
    });
    const outcome = await applyEditPlan({ files: [{ path: "open.ts", edits: [at(1, 1, 1, 2, "x")] }], outside: [], unsupported: 0 }, d);
    expect(outcome.failed).toEqual([{ path: "open.ts", error: "read-only" }]);
    expect(d.writes).toEqual([]);
  });
});
