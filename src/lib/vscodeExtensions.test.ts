import { describe, expect, it, vi } from "vitest";

vi.mock("./tauri/commands", () => ({ readFileText: async () => "" }));
const { recommendedServers } = await import("./vscodeExtensions");

describe("recommendedServers", () => {
  it("names the servers behind the recommended extensions, once each", () => {
    const text = `{
      // comments are allowed
      "recommendations": ["Vue.volar", "dbaeumer.vscode-eslint", "ms-python.python", "ms-python.vscode-pylance", "rust-lang.rust-analyzer",],
    }`;
    expect(recommendedServers(text)).toEqual(["vue", "pyright", "rust-analyzer"]);
  });

  it("answers [] for a file without recommendations", () => {
    expect(recommendedServers("{}")).toEqual([]);
    expect(recommendedServers("nope")).toEqual([]);
  });
});
