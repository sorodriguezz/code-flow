import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => "" }));
vi.mock("../state/editorDisplayStore", () => ({
  useEditorDisplayStore: {
    getState: () => ({ jsonSchemas: true }),
    subscribe: () => () => {},
  },
}));

const { catalogMatch, externalRefs, globToRegExp, isJsoncFile, matchesFileMatch, ownSchemaUrl } =
  await import("./jsonSchemas");

const CATALOG = [
  {
    name: "package.json",
    url: "https://json.schemastore.org/package.json",
    fileMatch: ["package.json"],
  },
  {
    name: "tsconfig",
    url: "https://json.schemastore.org/tsconfig.json",
    fileMatch: ["tsconfig.json", "tsconfig.*.json"],
  },
  {
    name: "anything",
    url: "https://example.org/any.json",
    fileMatch: ["*.json"],
  },
  {
    name: "workflow",
    url: "https://json.schemastore.org/github-workflow.json",
    fileMatch: [".github/workflows/*.yml"],
  },
  {
    name: "devcontainer",
    url: "https://example.org/dc.json",
    fileMatch: [".devcontainer/devcontainer.json"],
  },
];

describe("fileMatch globs", () => {
  it("reads `*`, `**` and `{a,b}`", () => {
    expect(globToRegExp("tsconfig.*.json").test("tsconfig.app.json")).toBe(true);
    expect(globToRegExp("**/a/*.json").test("x/y/a/b.json")).toBe(true);
    expect(globToRegExp("**/a/*.json").test("a/b.json")).toBe(true);
    expect(globToRegExp("*.{json,jsonc}").test("x.jsonc")).toBe(true);
    expect(globToRegExp("*.json").test("dir/x.json")).toBe(false);
  });

  it("matches a bare name anywhere and a path by its end", () => {
    expect(matchesFileMatch("package.json", "/proj/packages/web/package.json")).toBe(true);
    expect(matchesFileMatch(".devcontainer/devcontainer.json", "/proj/.devcontainer/devcontainer.json")).toBe(true);
    expect(matchesFileMatch(".devcontainer/devcontainer.json", "/proj/devcontainer.json")).toBe(false);
  });
});

describe("catalogMatch", () => {
  it("prefers the literal name over a wildcard and skips YAML patterns", () => {
    expect(catalogMatch(CATALOG, "/p/package.json")?.name).toBe("package.json");
    expect(catalogMatch(CATALOG, "/p/tsconfig.build.json")?.name).toBe("tsconfig");
    expect(catalogMatch(CATALOG, "/p/.devcontainer/devcontainer.json")?.name).toBe("devcontainer");
    expect(catalogMatch(CATALOG, "/p/.github/workflows/ci.yml")).toBeNull();
  });
});

describe("the rest", () => {
  it("knows which files are JSON with comments", () => {
    expect(isJsoncFile("/p/tsconfig.json")).toBe(true);
    expect(isJsoncFile("/p/.vscode/settings.json")).toBe(true);
    expect(isJsoncFile("/p/package.json")).toBe(false);
  });

  it("reads a file's own $schema", () => {
    expect(ownSchemaUrl('{\n  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json"\n}')).toBe(
      "https://biomejs.dev/schemas/1.9.4/schema.json",
    );
    expect(ownSchemaUrl('{ "$schema": "./local.json" }')).toBeNull();
  });

  it("collects other documents' refs, resolved and without fragments", () => {
    const schema = {
      properties: {
        a: { $ref: "#/definitions/a" },
        b: { $ref: "https://json.schemastore.org/base.json#/definitions/x" },
        c: { allOf: [{ $ref: "partial.json" }] },
      },
    };
    expect(externalRefs(schema, "https://json.schemastore.org/package.json").sort()).toEqual([
      "https://json.schemastore.org/base.json",
      "https://json.schemastore.org/partial.json",
    ]);
  });
});
