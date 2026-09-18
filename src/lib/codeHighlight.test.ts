import { describe, expect, it } from "vitest";
import { languageOf } from "./codeHighlight";

/** The class string `marked` puts on a fenced block's `<code>`. */
const fenced = (className: string) => className;

describe("the language a fence declares", () => {
  it("reads what marked put on the element", () => {
    expect(languageOf(fenced("language-typescript"))).toBe("typescript");
    expect(languageOf(fenced("language-python"))).toBe("python");
  });

  it("maps the labels people type onto the ids Monaco registers", () => {
    // The whole point of the alias table: someone writing ```ts is not writing a language Monaco
    // knows by that name, and colouring nothing would be the visible result.
    expect(languageOf(fenced("language-ts"))).toBe("typescript");
    expect(languageOf(fenced("language-tsx"))).toBe("typescript");
    expect(languageOf(fenced("language-py"))).toBe("python");
    expect(languageOf(fenced("language-sh"))).toBe("shell");
    expect(languageOf(fenced("language-yml"))).toBe("yaml");
    expect(languageOf(fenced("language-md"))).toBe("markdown");
  });

  it("passes through the labels that already match, which is most of them", () => {
    for (const id of ["json", "css", "html", "rust", "go", "java", "sql", "xml"]) {
      expect(languageOf(fenced(`language-${id}`))).toBe(id);
    }
  });

  it("ignores case, because fences are typed by hand", () => {
    expect(languageOf(fenced("language-TS"))).toBe("typescript");
    expect(languageOf(fenced("language-JSON"))).toBe("json");
  });

  it("survives the punctuation in a language name", () => {
    expect(languageOf(fenced("language-c++"))).toBe("cpp");
    expect(languageOf(fenced("language-c#"))).toBe("csharp");
  });

  it("finds the class among others marked may have added", () => {
    expect(languageOf(fenced("hljs language-rust extra"))).toBe("rust");
  });

  it("answers null for a bare fence, which colours nothing rather than guessing", () => {
    // A block with no language is readable and uncoloured, which beats one coloured as the wrong
    // language — highlighting shell as JavaScript is worse than not highlighting it.
    expect(languageOf(fenced(""))).toBeNull();
    expect(languageOf(fenced("some-other-class"))).toBeNull();
  });

  it("passes an unknown label through rather than dropping it", () => {
    // Monaco will refuse it and the block degrades to plain text — the same outcome as `null`, but
    // reached without this module having to know every language Monaco ships.
    expect(languageOf(fenced("language-nim"))).toBe("nim");
  });
});
