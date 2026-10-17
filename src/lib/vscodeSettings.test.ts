import { describe, expect, it, vi } from "vitest";

vi.mock("./tauri/commands", () => ({ readFileText: async () => "" }));
vi.mock("../state/editorDisplayStore", () => ({
  useEditorDisplayStore: Object.assign(() => true, { getState: () => ({ vscodeSettings: true }) }),
}));

const { excludeMatcher, parseVscodeSettings, searchExcludeGlobs, settingsForFile, vscodeLanguageIds } = await import(
  "./vscodeSettings"
);

const TEXT = `{
  // a comment, as VS Code writes them
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
  "editor.rulers": [80, { "column": 120, "color": "#f00" }],
  "editor.wordWrap": "on",
  "editor.formatOnSave": true,
  "files.eol": "\\n",
  "files.exclude": { "**/node_modules": true, "dist": true, "**/*.{log,tmp}": true, "coverage": false },
  "search.exclude": { "**/*.snap": true },
  "[python]": { "editor.tabSize": 4, "editor.formatOnSave": false },
  "[typescript][typescriptreact]": { "editor.rulers": [100] },
}`;

describe("parseVscodeSettings", () => {
  const parsed = parseVscodeSettings(TEXT)!;

  it("reads the workspace keys", () => {
    expect(settingsForFile(parsed, "src/app.js", "javascript")).toEqual({
      tabSize: 2,
      insertSpaces: true,
      rulers: [80, 120],
      wordWrap: true,
      formatOnSave: true,
      eol: "\n",
    });
  });

  it("lays a language's block over them, a joined block for each of its languages", () => {
    expect(settingsForFile(parsed, "tools/build.py", "python")).toMatchObject({ tabSize: 4, formatOnSave: false });
    expect(settingsForFile(parsed, "src/App.tsx", "typescript").rulers).toEqual([100]);
    expect(settingsForFile(parsed, "src/api.ts", "typescript").rulers).toEqual([100]);
  });

  it("keeps the excludes that are on", () => {
    expect(parsed.filesExclude).toEqual(["**/node_modules", "dist", "**/*.{log,tmp}"]);
    expect(parsed.searchExclude).toEqual(["**/*.snap"]);
  });

  it("answers null for a file that does not parse", () => {
    expect(parseVscodeSettings("{ nope")).toBeNull();
  });
});

describe("excludes", () => {
  it("hides a folder with everything in it, at the root or anywhere for `**`", () => {
    const excluded = excludeMatcher(["**/node_modules", "dist", "**/*.{log,tmp}"])!;
    expect(excluded("node_modules")).toBe(true);
    expect(excluded("packages/web/node_modules/react/index.js")).toBe(true);
    expect(excluded("dist")).toBe(true);
    expect(excluded("dist/main.js")).toBe(true);
    expect(excluded("src/dist")).toBe(false);
    expect(excluded("logs/today.log")).toBe(true);
    expect(excluded("src/index.ts")).toBe(false);
    expect(excludeMatcher([])).toBeNull();
  });

  it("spells braces out for the search backend, folder contents included", () => {
    expect(searchExcludeGlobs(["**/*.{log,tmp}", "dist/"])).toEqual([
      "**/*.log",
      "**/*.log/**",
      "**/*.tmp",
      "**/*.tmp/**",
      "dist",
      "dist/**",
    ]);
  });
});

describe("vscodeLanguageIds", () => {
  it("uses VS Code's names", () => {
    expect(vscodeLanguageIds("a.tsx", "typescript")).toEqual(["typescriptreact"]);
    expect(vscodeLanguageIds("tsconfig.json", "json")).toEqual(["jsonc"]);
    expect(vscodeLanguageIds("App.vue", "html")).toEqual(["vue"]);
    expect(vscodeLanguageIds("run.sh", "shell")).toEqual(["shellscript"]);
  });
});
