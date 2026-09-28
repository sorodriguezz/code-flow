import { describe, expect, it } from "vitest";
import { fileUriFor, relPathFromFileUri, toProblems } from "./protocol";

describe("relPathFromFileUri", () => {
  it("places a server's URI in the repository, decoding what `fileUriFor` encoded", () => {
    const root = "/Users/me/Documents (work)/api";
    expect(relPathFromFileUri(root, fileUriFor(root, "src/main.rs"))).toBe("src/main.rs");
    expect(relPathFromFileUri(root, fileUriFor(root, "src/a b/ñ.rs"))).toBe("src/a b/ñ.rs");
  });

  it("reads a Windows drive path, whose leading slash belongs to the URI", () => {
    expect(relPathFromFileUri("C:\\repo", "file:///C:/repo/src/lib.rs")).toBe("src/lib.rs");
  });

  it("answers null for anything outside the repository, or not a file at all", () => {
    expect(relPathFromFileUri("/repo", "file:///home/me/.cargo/registry/serde/lib.rs")).toBeNull();
    expect(relPathFromFileUri("/repo", "file:///repository/sibling.rs")).toBeNull();
    expect(relPathFromFileUri("/repo", "untitled:Untitled-1")).toBeNull();
    expect(relPathFromFileUri("/repo", "file:///repo/%E0%A4%A")).toBeNull();
  });
});

describe("toProblems", () => {
  const range = (line: number, character: number) => ({
    start: { line, character },
    end: { line, character: character + 3 },
  });

  it("converts positions to 1-based, severities to names, and codes to text", () => {
    expect(
      toProblems(
        [
          { range: range(0, 4), severity: 1, message: "mismatched types", code: "E0308", source: "rustc" },
          { range: range(9, 0), severity: 2, message: "unused variable", code: 12 },
          { range: range(2, 1), severity: 3, message: "note" },
        ],
        "rust-analyzer",
      ),
    ).toEqual([
      {
        line: 1,
        column: 5,
        endLine: 1,
        endColumn: 8,
        severity: "error",
        message: "mismatched types",
        code: "E0308",
        source: "rustc",
      },
      {
        line: 10,
        column: 1,
        endLine: 10,
        endColumn: 4,
        severity: "warning",
        message: "unused variable",
        code: "12",
        source: "rust-analyzer",
      },
      { line: 3, column: 2, endLine: 3, endColumn: 5, severity: "info", message: "note", code: undefined, source: "rust-analyzer" },
    ]);
  });

  it("reads an absent severity as an error and leaves hints out", () => {
    const problems = toProblems(
      [
        { range: range(0, 0), message: "no severity" },
        { range: range(1, 0), severity: 4, message: "a hint" },
      ],
      "pyright",
    );
    expect(problems.map((problem) => [problem.severity, problem.message])).toEqual([["error", "no severity"]]);
  });
});
