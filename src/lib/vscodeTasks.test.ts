import { describe, expect, it } from "vitest";
import { parseTasks, stripJsonc } from "./vscodeTasks";

const ctx = { repoPath: "/repo", file: "src/a.ts", platform: "macos" as const, packageManager: "pnpm" };

describe("vscode tasks", () => {
  it("reads JSON with comments and trailing commas", () => {
    expect(JSON.parse(stripJsonc('{ // hi\n "a": "x//y", /* b */ "c": [1,], }'))).toEqual({ a: "x//y", c: [1] });
  });

  it("builds shell, npm and per-OS commands with variables filled in", () => {
    const text = `{
      "version": "2.0.0",
      "tasks": [
        { "label": "lint", "type": "shell", "command": "eslint", "args": ["\${file}", "--fix"], "group": { "kind": "test" } },
        { "type": "npm", "script": "build" },
        { "label": "open", "command": "xdg-open .", "osx": { "command": "open ." }, "options": { "cwd": "\${workspaceFolder}/web" } },
        { "label": "all", "dependsOn": ["lint"] },
      ],
    }`;
    expect(parseTasks(text, ctx)).toEqual([
      { label: "lint", command: "eslint /repo/src/a.ts --fix", cwd: "/repo", group: "test" },
      { label: "npm: build", command: "pnpm run build", cwd: "/repo", group: null },
      { label: "open", command: "open .", cwd: "/repo/web", group: null },
      { label: "all", command: null, cwd: "/repo", group: null },
    ]);
  });
});
