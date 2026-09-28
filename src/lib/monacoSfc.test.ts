import { describe, expect, it } from "vitest";
import type { languages } from "monaco-editor";
import { teachLangAttribute } from "./monacoSfc";

/** The states of Monaco's HTML grammar this touches, in the shape it ships them. */
function htmlGrammar(): languages.IMonarchLanguage {
  return {
    tokenizer: {
      root: [],
      script: [[/type/, "attribute.name", "@scriptAfterType"], [/[\w-]+/, "attribute.name"]],
      scriptWithCustomType: [[/>/, { token: "delimiter", next: "@scriptEmbedded.$S2", nextEmbedded: "$S2" }]],
      style: [[/type/, "attribute.name", "@styleAfterType"], [/[\w-]+/, "attribute.name"]],
      styleWithCustomType: [[/>/, { token: "delimiter", next: "@styleEmbedded.$S2", nextEmbedded: "$S2" }]],
    },
  };
}

type Rule = [RegExp, unknown, string?];

/** The action of the first rule in a state whose pattern matches `text` at its start. */
function actionFor(language: languages.IMonarchLanguage, state: string, text: string) {
  const rules = (language.tokenizer as Record<string, Rule[]>)[state];
  const rule = rules.find(([pattern]) => new RegExp(`^(?:${pattern.source})`).test(text));
  return rule ? rule.slice(1) : null;
}

describe("teaching the HTML grammar `lang`", () => {
  it("reads `lang` before any other attribute name, and `language` as an ordinary one", () => {
    const html = htmlGrammar();
    expect(teachLangAttribute(html)).toBe(true);
    expect(actionFor(html, "script", 'lang="ts"')).toEqual(["attribute.name", "@scriptAfterLang"]);
    expect(actionFor(html, "script", 'language="x"')).toEqual(["attribute.name"]);
    expect(actionFor(html, "style", 'lang="scss"')).toEqual(["attribute.name", "@styleAfterLang"]);
  });

  it("embeds TypeScript, SCSS and Less by the mime types Monaco registered them under", () => {
    const html = htmlGrammar();
    teachLangAttribute(html);
    const switchOf = (state: string, text: string) =>
      (actionFor(html, state, text)?.[0] as { switchTo?: string } | undefined)?.switchTo;
    expect(switchOf("scriptAfterLangEquals", '"ts"')).toBe("@scriptWithCustomType.text/typescript");
    expect(switchOf("scriptAfterLangEquals", "'typescript'")).toBe("@scriptWithCustomType.text/typescript");
    expect(switchOf("scriptAfterLangEquals", '"js"')).toBe("@scriptWithCustomType.text/javascript");
    expect(switchOf("styleAfterLangEquals", '"scss"')).toBe("@styleWithCustomType.text/x-scss");
    expect(switchOf("styleAfterLangEquals", '"less"')).toBe("@styleWithCustomType.text/x-less");
    expect(switchOf("styleAfterLangEquals", '"postcss"')).toBe("@styleWithCustomType.text/css");
  });

  it("unwinds at the closing tag the way `type` does", () => {
    const html = htmlGrammar();
    teachLangAttribute(html);
    expect(actionFor(html, "scriptAfterLang", "</script>")).toEqual([{ token: "@rematch", next: "@pop" }]);
    expect(actionFor(html, "styleAfterLangEquals", "</style >")).toEqual([{ token: "@rematch", next: "@pop" }]);
  });

  it("teaches once, and leaves a grammar it does not recognise as it shipped", () => {
    const html = htmlGrammar();
    expect(teachLangAttribute(html)).toBe(true);
    expect(teachLangAttribute(html)).toBe(false);
    expect((html.tokenizer as Record<string, Rule[]>).script.length).toBe(3);

    const reshaped: languages.IMonarchLanguage = { tokenizer: { root: [], script: [] } };
    expect(teachLangAttribute(reshaped)).toBe(false);
    expect(reshaped.tokenizer.script).toEqual([]);
  });
});
