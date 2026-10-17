import { describe, expect, it } from "vitest";
import { applySaveRules, globToRegExp, parseEditorConfig, resolveFromConfigs, saveRulesFor } from "./editorConfig";

describe("globToRegExp", () => {
  it("matches a bare glob anywhere below its folder", () => {
    expect(globToRegExp("*.ts").test("src/app.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("app.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("app.tsx")).toBe(false);
  });

  it("anchors a glob with a slash to its folder", () => {
    expect(globToRegExp("lib/*.js").test("lib/a.js")).toBe(true);
    expect(globToRegExp("lib/*.js").test("src/lib/a.js")).toBe(false);
    expect(globToRegExp("/lib/**.js").test("lib/x/y.js")).toBe(true);
  });

  it("knows braces, ranges, classes and the star that matches everything", () => {
    expect(globToRegExp("*.{js,ts}").test("a/b.ts")).toBe(true);
    expect(globToRegExp("*.{js,ts}").test("a/b.go")).toBe(false);
    expect(globToRegExp("file{1..3}.txt").test("file2.txt")).toBe(true);
    expect(globToRegExp("file{1..3}.txt").test("file4.txt")).toBe(false);
    expect(globToRegExp("[!a]*.md").test("b.md")).toBe(true);
    expect(globToRegExp("[!a]*.md").test("a.md")).toBe(false);
    expect(globToRegExp("*").test("deep/any.thing")).toBe(true);
    expect(globToRegExp("Makefile").test("sub/Makefile")).toBe(true);
  });
});

describe("resolveFromConfigs", () => {
  const rootConfig = parseEditorConfig(`
root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true # a comment
[*.md]
trim_trailing_whitespace = false
[Makefile]
indent_style = tab
`);
  const nested = parseEditorConfig(`
[*.py]
indent_size = 4
`);

  it("layers sections and nearer files over farther ones", () => {
    expect(resolveFromConfigs("src/a.ts", [{ dir: "", config: rootConfig }])).toEqual({
      indent_style: "space",
      indent_size: 2,
      end_of_line: "lf",
      insert_final_newline: true,
    });
    expect(resolveFromConfigs("Makefile", [{ dir: "", config: rootConfig }]).indent_style).toBe("tab");
    expect(resolveFromConfigs("tools/x.py", [{ dir: "tools", config: nested }, { dir: "", config: rootConfig }]).indent_size).toBe(4);
  });

  it("stops at root = true", () => {
    const outer = parseEditorConfig("[*]\nindent_size = 8");
    expect(resolveFromConfigs("a.ts", [{ dir: "", config: rootConfig }, { dir: "..", config: outer }]).indent_size).toBe(2);
  });
});

describe("save rules", () => {
  it("lets .editorconfig win and spares Markdown from the setting alone", () => {
    const settings = { trimTrailingWhitespace: true, insertFinalNewline: false };
    expect(saveRulesFor("a.ts", settings, {})).toEqual({ trimTrailingWhitespace: true, insertFinalNewline: false, eol: null });
    expect(saveRulesFor("README.md", settings, {}).trimTrailingWhitespace).toBe(false);
    expect(saveRulesFor("README.md", settings, { trim_trailing_whitespace: true }).trimTrailingWhitespace).toBe(true);
    expect(saveRulesFor("a.ts", settings, { end_of_line: "crlf" }).eol).toBe("\r\n");
  });

  it("trims, ends with a newline and converts line endings", () => {
    expect(applySaveRules("a  \nb\t", { trimTrailingWhitespace: true, insertFinalNewline: true, eol: null })).toBe("a\nb\n");
    expect(applySaveRules("a\r\nb", { trimTrailingWhitespace: false, insertFinalNewline: true, eol: null })).toBe("a\r\nb\r\n");
    expect(applySaveRules("a\nb\n", { trimTrailingWhitespace: false, insertFinalNewline: false, eol: "\r\n" })).toBe("a\r\nb\r\n");
    expect(applySaveRules("", { trimTrailingWhitespace: true, insertFinalNewline: true, eol: null })).toBe("");
  });
});
