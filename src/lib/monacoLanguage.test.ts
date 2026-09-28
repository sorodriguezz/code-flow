import { describe, expect, it } from "vitest";
import { ASSIGNABLE_LANGUAGES, isAssignableLanguage, languageForPath } from "./monacoLanguage";

describe("languageForPath", () => {
  it("opens single-file components as HTML, whatever the case of the extension", () => {
    expect(languageForPath("src/App.vue")).toBe("html");
    expect(languageForPath("src/routes/+page.svelte")).toBe("html");
    expect(languageForPath("src/pages/index.astro")).toBe("html");
    expect(languageForPath("LEGACY/Widget.VUE")).toBe("html");
  });

  it("opens TOML as the language `monacoToml` registers", () => {
    expect(languageForPath("Cargo.toml")).toBe("toml");
    expect(languageForPath("services/api/pyproject.toml")).toBe("toml");
  });

  it("keeps the mappings it already had", () => {
    expect(languageForPath("a.tsx")).toBe("typescript");
    expect(languageForPath("docker/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("README")).toBe("plaintext");
    expect(languageForPath("notes.unknownext")).toBe("plaintext");
  });

  it("offers the new ids to snippet scoping", () => {
    expect(isAssignableLanguage("toml")).toBe(true);
    expect(ASSIGNABLE_LANGUAGES).toContain("html");
    // Not an id any file becomes — the components are HTML.
    expect(isAssignableLanguage("vue")).toBe(false);
  });
});
