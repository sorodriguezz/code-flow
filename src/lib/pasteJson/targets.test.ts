import { describe, expect, it } from "vitest";
import { FALLBACK_LANGUAGE, PASTE_JSON_LANGUAGES, isTypeName, targetFor } from "./targets";

describe("targetFor", () => {
  it("writes every language the feature promises, by Monaco's id for it", () => {
    for (const language of ["typescript", "javascript", "python", "go", "rust", "csharp", "java", "kotlin", "swift", "dart"]) {
      expect(targetFor(language), language).not.toBeNull();
    }
    expect([...PASTE_JSON_LANGUAGES].sort()).toEqual(
      ["csharp", "dart", "go", "java", "javascript", "kotlin", "python", "rust", "swift", "typescript"],
    );
  });

  it("keeps the file's language on the target and says which renderer writes it", () => {
    expect(targetFor("csharp")).toMatchObject({ language: "csharp", dialect: "csharp" });
    expect(targetFor("typescript")).toMatchObject({ language: "typescript", dialect: "typescript" });
  });

  it("writes JavaScript with the TypeScript renderer, turned into JSDoc", () => {
    const js = targetFor("javascript");
    expect(js).toMatchObject({ dialect: "typescript", jsdoc: true });
    // Plain `type` aliases rather than interfaces — they are what translates into typedefs.
    expect(js?.rendererOptions["prefer-types"]).toBe("true");
    expect(targetFor("typescript")?.jsdoc).toBeFalsy();
  });

  it("answers null for a language it does not write", () => {
    for (const language of ["plaintext", "markdown", "json", "php", "sql", "yaml", "cpp"]) {
      expect(targetFor(language), language).toBeNull();
    }
  });

  it("falls back on a language it does write", () => {
    expect(targetFor(FALLBACK_LANGUAGE)).not.toBeNull();
  });

  it("indents Go with a tab, whatever the editor is set to — gofmt would anyway", () => {
    expect(targetFor("go")?.indentation).toBe("\t");
    expect(targetFor("python")?.indentation).toBeUndefined();
  });

  it("asks for types only, bar the languages whose decoding needs more", () => {
    expect(targetFor("typescript")?.rendererOptions["just-types"]).toBe("true");
    expect(targetFor("go")?.rendererOptions["just-types"]).toBe("true");
    expect(targetFor("csharp")?.rendererOptions.features).toBe("attributes-only");
    expect(targetFor("swift")?.rendererOptions.initializers).toBe("false");
    expect(targetFor("dart")?.rendererOptions["just-types"]).toBeUndefined();
  });

  it("types dates only where decoding makes the date type true without help", () => {
    // `JSON.parse` hands TypeScript a string; `Date` would be a lie the compiler repeats.
    expect(targetFor("typescript")?.dates).toBe(false);
    expect(targetFor("python")?.dates).toBe(false);
    expect(targetFor("swift")?.dates).toBe(false);
    // `time.Time` and `DateTimeOffset` decode from ISO-8601 on their own; Dart's `fromJson` parses.
    expect(targetFor("go")?.dates).toBe(true);
    expect(targetFor("csharp")?.dates).toBe(true);
    expect(targetFor("dart")?.dates).toBe(true);
  });

  it("leaves enums out of C#, where each would bring a converter class along", () => {
    expect(targetFor("csharp")?.enums).toBe(false);
    expect(targetFor("typescript")?.enums).toBe(true);
  });
});

describe("isTypeName", () => {
  it("takes identifiers", () => {
    for (const name of ["Root", "Order", "order_list", "_Private", "V2"]) expect(isTypeName(name), name).toBe(true);
  });

  it("refuses what would come out as a different name", () => {
    for (const name of ["", "2fa", "order-list", "my type", "Ü", "a.b"]) expect(isTypeName(name), name).toBe(false);
  });
});
