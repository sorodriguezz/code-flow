import { describe, expect, it, vi } from "vitest";

vi.mock("./goToDefinition", () => ({ definitionProject: () => null, openDefinitionTarget: () => true }));
const { formatSearchResults, previewReplace, searchResultTarget } = await import("./searchEditor");

const FILE = ["import x", "// before", "export function fetchUser() {", "  return 1;", "}", "", "", "fetchUser();"].join("\n");

describe("formatSearchResults", () => {
  const text = formatSearchResults({
    query: "fetchUser",
    flags: { caseSensitive: true, wholeWord: false, regex: false },
    include: "src",
    exclude: "",
    files: [
      [
        "src/api.ts",
        [
          { line_no: 3, line: "export function fetchUser() {" },
          { line_no: 8, line: "fetchUser();" },
        ],
      ],
    ],
    textOf: () => FILE,
    context: 1,
    truncated: false,
  });

  it("writes VS Code's layout, context and gaps included", () => {
    expect(text).toBe(
      [
        "# Query: fetchUser",
        "# Flags: CaseSensitive",
        "# Including: src",
        "",
        "2 results - 1 file",
        "",
        "src/api.ts:",
        "  2  // before",
        "  3: export function fetchUser() {",
        "  4    return 1;",
        "  ...",
        "  7  ",
        "  8: fetchUser();",
        "",
      ].join("\n"),
    );
  });

  it("points every result and context line at its file", () => {
    const lines = text.split("\n");
    const at = (n: number) => lines[n - 1] ?? "";
    expect(searchResultTarget(at, 9)).toEqual({ path: "src/api.ts", line: 3 });
    expect(searchResultTarget(at, 8)).toEqual({ path: "src/api.ts", line: 2 });
    expect(searchResultTarget(at, 7)).toBeNull();
    expect(searchResultTarget(at, 1)).toBeNull();
    expect(searchResultTarget(at, 11)).toBeNull();
  });
});

describe("previewReplace", () => {
  it("replaces literally unless the search is a regex", () => {
    expect(previewReplace("a.b a.b", "a.b", "$1", { caseSensitive: true, wholeWord: false, regex: false })).toBe("$1 $1");
    expect(previewReplace("id=1 id=22", "id=(\\d+)", "n:$1", { caseSensitive: true, wholeWord: false, regex: true })).toBe("n:1 n:22");
  });

  it("follows case and whole-word", () => {
    expect(previewReplace("User user users", "user", "x", { caseSensitive: false, wholeWord: true, regex: false })).toBe("x x users");
    expect(previewReplace("User user", "user", "x", { caseSensitive: true, wholeWord: false, regex: false })).toBe("User x");
  });

  it("answers null for a pattern JavaScript refuses", () => {
    expect(previewReplace("x", "(", "y", { caseSensitive: true, wholeWord: false, regex: true })).toBeNull();
  });
});
