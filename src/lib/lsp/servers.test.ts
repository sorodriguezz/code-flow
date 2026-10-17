import { describe, expect, it } from "vitest";
import { LANGUAGE_SERVERS, lspLanguageOf, monacoLanguageOf, serversForRepo, withRepoPath } from "./servers";

describe("lspLanguageOf", () => {
  it("names a component file by its own kind, not by the HTML Monaco colours it as", () => {
    expect(lspLanguageOf("src/App.vue", "html")).toBe("vue");
    expect(lspLanguageOf("src/routes/+page.svelte", "html")).toBe("svelte");
    expect(lspLanguageOf("src/pages/index.astro", "html")).toBe("astro");
    expect(lspLanguageOf("infra/main.tf", "hcl")).toBe("terraform");
    expect(lspLanguageOf("infra/prod.tfvars", "hcl")).toBe("terraform-vars");
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
