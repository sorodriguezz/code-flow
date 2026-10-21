import { describe, expect, it } from "vitest";
import { LANGUAGE_SERVERS, NATIVE_TYPESCRIPT, lspLanguageOf, monacoLanguageOf, serversForRepo, withRepoPath } from "./servers";
import { TS_PREFERENCES } from "../tsserver";

describe("lspLanguageOf", () => {
  it("names a component file by its own kind, not by the HTML Monaco colours it as", () => {
    expect(lspLanguageOf("src/App.vue", "html")).toBe("vue");
    expect(lspLanguageOf("src/routes/+page.svelte", "html")).toBe("svelte");
    expect(lspLanguageOf("src/pages/index.astro", "html")).toBe("astro");
    expect(lspLanguageOf("infra/main.tf", "hcl")).toBe("terraform");
    expect(lspLanguageOf("infra/prod.tfvars", "hcl")).toBe("terraform-vars");
  });

  it("tells a server a JSX file is one — TypeScript 7 parses by it", () => {
    expect(lspLanguageOf("src/App.tsx", "typescript")).toBe("typescriptreact");
    expect(lspLanguageOf("src/App.jsx", "javascript")).toBe("javascriptreact");
    expect(lspLanguageOf("src/main.ts", "typescript")).toBe("typescript");
    expect(lspLanguageOf("vite.config.mjs", "javascript")).toBe("javascript");
    expect(monacoLanguageOf("typescriptreact")).toBe("typescript");
    expect(monacoLanguageOf("javascriptreact")).toBe("javascript");
  });

  it("keeps Tailwind on the JSX files it already answered for", () => {
    const tailwind = LANGUAGE_SERVERS.find((server) => server.id === "tailwind")!;
    expect(tailwind.languages).toEqual(expect.arrayContaining(["typescriptreact", "javascriptreact"]));
  });

  it("leaves every other file as Monaco calls it", () => {
    expect(lspLanguageOf("public/index.html", "html")).toBe("html");
    expect(lspLanguageOf("Cargo.toml", "toml")).toBe("toml");
    expect(lspLanguageOf("Makefile", "plaintext")).toBe("plaintext");
  });

  it("maps back to the Monaco id providers are registered for", () => {
    expect(monacoLanguageOf("vue")).toBe("html");
    expect(monacoLanguageOf("terraform-vars")).toBe("hcl");
    expect(monacoLanguageOf("python")).toBe("python");
  });
});

describe("withRepoPath", () => {
  it("points Volar at the project's own TypeScript", () => {
    const vue = LANGUAGE_SERVERS.find((server) => server.id === "vue")!;
    expect(withRepoPath(vue.initializationOptions, "/work/shop")).toEqual({
      typescript: { tsdk: "/work/shop/node_modules/typescript/lib" },
      vue: { hybridMode: false },
    });
  });

  it("does not touch anything without the placeholder", () => {
    const options = { a: [1, "x", { b: true }], c: null };
    expect(withRepoPath(options, "/r")).toEqual(options);
  });
});

describe("serversForRepo", () => {
  it("starts the Svelte server only in a Svelte project", () => {
    expect(serversForRepo(["svelte.config.js"]).some((server) => server.id === "svelte")).toBe(true);
    expect(serversForRepo(["package.json"]).some((server) => server.id === "svelte")).toBe(false);
  });
});

describe("NATIVE_TYPESCRIPT", () => {
  it("is the project's own compiler, never one the catalogue looks for on PATH", () => {
    expect(LANGUAGE_SERVERS.some((server) => server.id === NATIVE_TYPESCRIPT.id)).toBe(false);
    expect(serversForRepo(["package.json", "tsconfig.json"]).includes(NATIVE_TYPESCRIPT)).toBe(false);
    expect(NATIVE_TYPESCRIPT.args).toEqual(["--lsp", "--stdio"]);
  });

  it("answers for every TypeScript and JavaScript file, under the ids it parses by", () => {
    const files: [string, string][] = [
      ["a.ts", "typescript"],
      ["a.tsx", "typescript"],
      ["a.mts", "typescript"],
      ["a.js", "javascript"],
      ["a.jsx", "javascript"],
      ["a.cjs", "javascript"],
    ];
    for (const [path, monaco] of files) {
      expect(NATIVE_TYPESCRIPT.languages, path).toContain(lspLanguageOf(path, monaco));
    }
  });

  it("reads the same preferences tsserver is configured with", () => {
    expect(NATIVE_TYPESCRIPT.settings).toEqual({ typescript: TS_PREFERENCES, javascript: TS_PREFERENCES });
  });
});
