import { describe, expect, it } from "vitest";
import { launchTemplate, parseLaunch } from "./vscodeLaunch";

const ctx = { repoPath: "/work/api", file: "src/server.js", platform: "macos" as const };

describe("parseLaunch", () => {
  it("reads a Node configuration with comments, variables and a relative program", () => {
    const text = `{
      // VS Code's own comments
      "version": "0.2.0",
      "configurations": [
        { "type": "node", "request": "launch", "name": "API", "program": "\${workspaceFolder}/src/index.js", "args": ["--port", "3000"], },
        { "type": "pwa-node", "request": "launch", "name": "Current", "program": "\${file}" },
        { "type": "node", "request": "launch", "name": "Relative", "program": "./bin/cli.js", "cwd": "packages/cli" },
      ],
    }`;
    const [api, current, relative] = parseLaunch(text, ctx);
    expect(api).toMatchObject({
      name: "API",
      adapterId: "node",
      program: "/work/api/src/index.js",
      args: ["--port", "3000"],
      cwd: "/work/api",
      unsupported: null,
    });
    expect(current.program).toBe("/work/api/src/server.js");
    expect(relative).toMatchObject({ program: "/work/api/bin/cli.js", cwd: "/work/api/packages/cli" });
  });

  it("hands an adapter the configuration as VS Code would, minus the editor's keys", () => {
    const text = JSON.stringify({
      configurations: [
        {
          name: "Tests",
          type: "debugpy",
          request: "launch",
          module: "pytest",
          env: { DEBUG: "1" },
          preLaunchTask: "build",
          presentation: { hidden: false },
        },
      ],
    });
    const [tests] = parseLaunch(text, ctx);
    expect(tests.adapterId).toBe("python");
    expect(tests.unsupported).toBeNull();
    expect(tests.preLaunchTask).toBe("build");
    expect(tests.launch).toEqual({
      type: "debugpy",
      request: "launch",
      module: "pytest",
      env: { DEBUG: "1" },
      cwd: "/work/api",
    });
  });

  it("merges the block for this platform", () => {
    const text = JSON.stringify({
      configurations: [
        {
          name: "App",
          type: "node",
          request: "launch",
          program: "a.js",
          windows: { program: "w.js" },
          osx: { program: "m.js" },
        },
      ],
    });
    expect(parseLaunch(text, ctx)[0].program).toBe("/work/api/m.js");
    expect(parseLaunch(text, { ...ctx, platform: "windows" })[0].program).toBe("/work/api/w.js");
  });

  it("says why a configuration cannot start here", () => {
    const text = JSON.stringify({
      configurations: [
        { name: "Attach", type: "node", request: "attach", port: 9229 },
        { name: "Go", type: "go", request: "launch", program: "." },
        { name: "npm", type: "node", request: "launch", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"] },
      ],
    });
    expect(parseLaunch(text, ctx).map((entry) => entry.unsupported)).toEqual([
      "attach",
      'type "go"',
      "runtimeExecutable",
    ]);
  });

  it("answers [] for a file that does not parse", () => {
    expect(parseLaunch("{ nope", ctx)).toEqual([]);
  });

  it("writes a template that parses back", () => {
    const [entry] = parseLaunch(launchTemplate("python"), ctx);
    expect(entry.adapterId).toBe("python");
    expect(entry.program).toBe("/work/api/src/server.js");
  });
});
